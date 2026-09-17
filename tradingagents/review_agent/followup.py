"""User-confirmed conditions, linked to immutable Agent evidence and later snapshots."""
from __future__ import annotations

import json
import math
import time
import uuid

from tradingagents.review.verification import METRICS, DIRECTIONS, _actual_direction
from .evidence import EvidenceError, build_bundle, canonical, valid_date
from .store import identifier


class Followup:
    def __init__(self, store, reviews):
        self.store, self.reviews = store, reviews
        with store.connect() as db:
            db.executescript("""
                CREATE TABLE IF NOT EXISTS observations (
                    id TEXT PRIMARY KEY, turn_id TEXT NOT NULL, metric TEXT NOT NULL,
                    direction TEXT NOT NULL, baseline TEXT NOT NULL, created REAL NOT NULL, rule TEXT,
                    UNIQUE(turn_id, metric, direction));
                CREATE TABLE IF NOT EXISTS observation_checks (
                    id TEXT PRIMARY KEY, observation_id TEXT NOT NULL, result TEXT NOT NULL, created REAL NOT NULL);
            """)
            if "rule" not in {r[1] for r in db.execute("PRAGMA table_info(observations)")}:
                db.execute("ALTER TABLE observations ADD COLUMN rule TEXT")

    @staticmethod
    def menu() -> list[dict]:
        return [{"metric": m.key, "threshold": m.eps * (100 if not m.unit else 1),
                 "threshold_unit": "个百分点" if m.unit in ("", "%") else m.unit} for m in METRICS]

    def add(self, turn_id: str, metric: str, direction: str) -> dict:
        turn = self.store.turn(turn_id)
        if turn["status"] not in ("complete", "incomplete") or direction not in DIRECTIONS or metric not in {m.key for m in METRICS}:
            raise EvidenceError("请选择有效回答中的市场指标与预期方向")
        conv = self.store.conversation(turn["conversation_id"])
        baseline = next((e for e in turn["result"]["evidence"] if e.get("kind") == "metric"
                         and e.get("metric") == metric and e["date"] == conv["anchor"] and e["available"]), None)
        if baseline is None:
            raise EvidenceError("本轮未引用所选日的该项有效指标，请先让 Agent 读取")
        item = {"id": uuid.uuid4().hex, "turn_id": turn_id, "metric": metric,
                "direction": direction, "baseline": baseline, "created": time.time(),
                "rule": next(r for r in self.menu() if r["metric"] == metric)}
        with self.store.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            old = db.execute("SELECT id,rule FROM observations WHERE turn_id=? AND metric=? AND direction=?", (turn_id, metric, direction)).fetchone()
            if old:
                item["id"] = old["id"]
                if not old["rule"]:
                    db.execute("UPDATE observations SET rule=? WHERE id=?", (canonical(item["rule"]), old["id"]))
            else:
                db.execute("INSERT INTO observations (id,turn_id,metric,direction,baseline,created,rule) VALUES (?,?,?,?,?,?,?)",
                           (item["id"], turn_id, metric, direction, canonical(baseline), item["created"], canonical(item["rule"])))
        return self.get(item["id"])

    def get(self, observation_id: str) -> dict:
        identifier(observation_id)
        with self.store.connect() as db:
            row = db.execute("SELECT * FROM observations WHERE id=?", (observation_id,)).fetchone()
        if row is None:
            raise EvidenceError("核验条件不存在")
        return {**dict(row), "baseline": json.loads(row["baseline"]), "rule": json.loads(row["rule"]) if row["rule"] else None}

    def list(self, conversation_id: str) -> list[dict]:
        self.store.conversation(conversation_id)
        with self.store.connect() as db:
            rows = db.execute("SELECT o.id FROM observations o JOIN turns t ON o.turn_id=t.id WHERE t.conversation_id=? ORDER BY o.created DESC LIMIT 100", (conversation_id,)).fetchall()
            items = [self.get(r["id"]) for r in rows]
            for item in items:
                checks = db.execute("SELECT result FROM observation_checks WHERE observation_id=? ORDER BY created DESC LIMIT 10", (item["id"],)).fetchall()
                item["checks"] = [json.loads(r[0]) for r in checks]
        return items

    def check(self, observation_id: str, day: str) -> dict:
        item = self.get(observation_id)
        valid_date(day)
        if day <= item["baseline"]["date"]:
            raise EvidenceError("核验日期必须晚于原观察日")
        try:
            bundle = build_bundle(self.reviews, day)
            current = next((e for e in bundle["evidence"] if e["date"] == day and e.get("metric") == item["metric"] and e.get("kind") == "metric"), None)
        except EvidenceError:
            current = None
        rule = item["rule"]
        if not rule or not isinstance(rule.get("threshold"), (int, float)) or not math.isfinite(rule["threshold"]) or rule["threshold"] < 0:
            raise EvidenceError("此条件未保存有效的固定阈值，请重新确认核验条件")
        threshold = rule["threshold"]
        actual = _actual_direction(current["value"] if current and current["available"] else None,
                                   item["baseline"]["value"], threshold)
        result = {"date": day, "baseline": item["baseline"], "current": current,
                  "expected": item["direction"], "actual": actual, "threshold": threshold,
                  "threshold_unit": rule["threshold_unit"], "verified": None if actual is None else actual == item["direction"],
                  "status": "数据不足" if actual is None else "符合条件" if actual == item["direction"] else "不符合条件",
                  "note": "按既有复盘指标阈值比较；结果只核验市场观察，不代表策略收益。"}
        with self.store.connect() as db:
            db.execute("INSERT INTO observation_checks VALUES (?,?,?,?)", (uuid.uuid4().hex, observation_id, canonical(result), time.time()))
        return result
