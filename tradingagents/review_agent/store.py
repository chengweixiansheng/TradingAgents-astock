"""SQLite owns conversation identity, turn state and request idempotency."""
from __future__ import annotations

import json
import os
import re
import sqlite3
import time
import uuid
from contextlib import contextmanager
from pathlib import Path

from .evidence import EvidenceError, canonical, digest, valid_date


def identifier(value: str) -> str:
    if not isinstance(value, str) or not re.fullmatch(r"[0-9a-f]{32}", value):
        raise EvidenceError("会话或任务编号无效")
    return value


class Store:
    def __init__(self, root: Path):
        self.root = root
        root.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.path = root / "conversations.sqlite3"
        if self.path.is_symlink():
            raise EvidenceError("会话数据库不能是符号链接")
        with self.connect() as db:
            db.execute("PRAGMA journal_mode=WAL")
            db.executescript("""
                CREATE TABLE IF NOT EXISTS conversations (
                    id TEXT PRIMARY KEY, anchor TEXT NOT NULL, title TEXT NOT NULL,
                    source TEXT NOT NULL, bundle TEXT NOT NULL, created REAL NOT NULL);
                CREATE TABLE IF NOT EXISTS turns (
                    id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, request_id TEXT UNIQUE NOT NULL,
                    fingerprint TEXT NOT NULL, question TEXT NOT NULL, status TEXT NOT NULL,
                    result TEXT, error TEXT, events TEXT NOT NULL DEFAULT '[]',
                    created REAL NOT NULL, updated REAL NOT NULL);
                CREATE INDEX IF NOT EXISTS turns_conversation ON turns(conversation_id, created);
            """)
        os.chmod(self.path, 0o600)

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.path, timeout=10)
        db.row_factory = sqlite3.Row
        try:
            with db:
                yield db
        finally:
            db.close()

    @staticmethod
    def _recover(db) -> None:
        # A worker has a shorter hard timeout. On process restart no new worker
        # resumes or re-bills the old turn; its terminal state is made explicit.
        now = time.time()
        if not db.execute("SELECT 1 FROM turns WHERE status='running' AND updated<? LIMIT 1", (now - 720,)).fetchone():
            return
        db.execute("UPDATE turns SET status='failed', error=?, updated=? WHERE status='running' AND updated<?",
                   ("上次任务已中断或超时，可重新提问；此前成功结果已保留。", now, now - 720))

    def start(self, anchor: str, question: str, request_id: str, source: dict,
              bundle_factory, conversation_id: str | None = None, context: dict | None = None) -> tuple[dict, bool]:
        valid_date(anchor)
        identifier(request_id)
        if conversation_id is not None:
            identifier(conversation_id)
        if not isinstance(question, str) or not 1 <= len(question.strip()) <= 2000:
            raise EvidenceError("问题不能为空，且最多两千字")
        source_json = canonical(source)
        fingerprint = digest([anchor, question, conversation_id, source, context])
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            self._recover(db)
            old = db.execute("SELECT * FROM turns WHERE request_id=?", (request_id,)).fetchone()
            if old:
                if old["fingerprint"] != fingerprint:
                    raise EvidenceError("同一请求编号不能用于不同问题或配置")
                return self._decode_turn(old), False
            if db.execute("SELECT 1 FROM turns WHERE status='running'").fetchone():
                raise EvidenceError("已有 Agent 任务在运行，请等待完成或取消")
            if conversation_id:
                conv = db.execute("SELECT * FROM conversations WHERE id=?", (conversation_id,)).fetchone()
                if not conv or conv["anchor"] != anchor:
                    raise EvidenceError("会话不属于所选复盘日期")
                if conv["source"] != source_json:
                    raise EvidenceError("AI 来源已变化，请新建会话")
                saved_context = json.loads(conv["bundle"]).get("context", {"allow_network": False, "symbol": ""})
                if context is not None and saved_context != context:
                    raise EvidenceError("取数范围已变化，请新建会话")
                if db.execute("SELECT count(*) FROM turns WHERE conversation_id=?", (conversation_id,)).fetchone()[0] >= 20:
                    raise EvidenceError("本会话已到二十轮，请新建会话")
            else:
                bundle = bundle_factory()
                conversation_id = uuid.uuid4().hex
                db.execute("INSERT INTO conversations VALUES (?,?,?,?,?,?)",
                           (conversation_id, anchor, question[:60], source_json, canonical(bundle), time.time()))
            turn_id = uuid.uuid4().hex
            db.execute("INSERT INTO turns (id,conversation_id,request_id,fingerprint,question,status,created,updated) VALUES (?,?,?,?,?,'running',?,?)",
                       (turn_id, conversation_id, request_id, fingerprint, question, time.time(), time.time()))
        return self.turn(turn_id), True

    def turn(self, turn_id: str) -> dict:
        identifier(turn_id)
        with self.connect() as db:
            self._recover(db)
            row = db.execute("SELECT * FROM turns WHERE id=?", (turn_id,)).fetchone()
        if row is None:
            raise EvidenceError("任务不存在")
        return self._decode_turn(row)

    @staticmethod
    def _decode_turn(row) -> dict:
        out = dict(row)
        out["result"] = json.loads(out["result"]) if out["result"] else None
        out["events"] = json.loads(out["events"])
        out.pop("fingerprint", None)
        return out

    def conversation(self, conversation_id: str, *, internal: bool = False) -> dict:
        identifier(conversation_id)
        with self.connect() as db:
            self._recover(db)
            row = db.execute("SELECT * FROM conversations WHERE id=?", (conversation_id,)).fetchone()
            turns = db.execute("SELECT id FROM turns WHERE conversation_id=? ORDER BY created", (conversation_id,)).fetchall()
        if not row:
            raise EvidenceError("会话不存在")
        out = dict(row)
        bundle = json.loads(out.pop("bundle"))
        out["source"] = json.loads(out["source"])
        out["revision"] = bundle["revision"]
        out["dates"] = bundle["dates"]
        out["context"] = bundle.get("context", {"allow_network": False, "symbol": ""})
        out["targets"] = bundle.get("targets", [])
        out["turns"] = [self.turn(t["id"]) for t in turns]
        if internal:
            out["bundle"] = bundle
        return out

    def list_conversations(self, anchor: str = "", mode: str = "agent", page: str = "") -> list[dict]:
        if anchor:
            valid_date(anchor)
        if mode not in ("agent", "direct") or len(page) > 80:
            raise EvidenceError("会话范围无效")
        with self.connect() as db:
            return [dict(r) for r in db.execute("""
                SELECT id,title,anchor,created FROM conversations
                WHERE (?='' OR anchor=?)
                AND coalesce(json_extract(bundle,'$.context.mode'),'agent')=?
                AND coalesce(json_extract(bundle,'$.context.page'),'')=?
                ORDER BY created DESC LIMIT 20
            """, (anchor, anchor, mode, page))]

    def delete_conversation(self, conversation_id: str) -> dict:
        identifier(conversation_id)
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            self._recover(db)
            if db.execute("SELECT 1 FROM turns WHERE conversation_id=? AND status='running'", (conversation_id,)).fetchone():
                raise EvidenceError("会话仍有运行中的任务，请先取消并等待结束")
            if not db.execute("SELECT 1 FROM conversations WHERE id=?", (conversation_id,)).fetchone():
                raise EvidenceError("会话不存在")
            tables = {r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            if 'observations' in tables:
                if 'observation_checks' in tables:
                    db.execute("DELETE FROM observation_checks WHERE observation_id IN (SELECT id FROM observations WHERE turn_id IN (SELECT id FROM turns WHERE conversation_id=?))", (conversation_id,))
                db.execute("DELETE FROM observations WHERE turn_id IN (SELECT id FROM turns WHERE conversation_id=?)", (conversation_id,))
            db.execute("DELETE FROM turns WHERE conversation_id=?", (conversation_id,))
            db.execute("DELETE FROM conversations WHERE id=?", (conversation_id,))
        return {"ok": True}

    def event(self, turn_id: str, message: str) -> None:
        with self.connect() as db:
            row = db.execute("SELECT events FROM turns WHERE id=? AND status='running'", (turn_id,)).fetchone()
            if row:
                events = json.loads(row[0])
                if not events or events[-1]["message"] != message:
                    events.append({"at": time.time(), "message": message})
                db.execute("UPDATE turns SET events=?,updated=? WHERE id=?", (canonical(events[-80:]), time.time(), turn_id))

    def finish(self, turn_id: str, *, result: dict | None = None, error: str | None = None) -> None:
        status = result["status"] if result else "failed"
        with self.connect() as db:
            db.execute("UPDATE turns SET status=?,result=?,error=?,updated=? WHERE id=? AND status='running'",
                       (status, canonical(result) if result else None, error, time.time(), turn_id))

    def cancel(self, turn_id: str) -> dict:
        identifier(turn_id)
        with self.connect() as db:
            db.execute("UPDATE turns SET status='cancelled',error='任务已取消',updated=? WHERE id=? AND status='running'", (time.time(), turn_id))
        return self.turn(turn_id)
