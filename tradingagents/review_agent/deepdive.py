"""Existing four-analyst workflow bound to the selected isolated AI source."""
from __future__ import annotations

import json
import threading
import time
from pathlib import Path

from .daily import Daily, DailyLLM, atomic_write
from .evidence import EvidenceError, digest


class FrozenStockInputs:
    def __init__(self, directory, check):
        self.directory, self.check, self.values = directory, check, {}

    def __getattr__(self, name):
        if name not in {"resolve", "get_profile", "get_theme", "get_lhb", "get_kline"}:
            raise AttributeError(name)
        def read(*args):
            self.check()
            key = name + ":" + digest(args)
            if key not in self.values:
                from .public_worker import fetch_public
                value = fetch_public(name, list(args), self.directory, self.check)
                self.check()
                record = {"input": name, "args": args, "value": value, "fetched_at": time.time()}
                record["sha256"] = digest(record)
                atomic_write(self.directory / (digest(key) + ".json"), record)
                self.values[key] = record
            return self.values[key]["value"]
        return read


class DeepDive(Daily):
    def __init__(self, manager):
        self.reports = manager.reviews.parent / "deepdive"
        self.reports.mkdir(parents=True, exist_ok=True)
        self.history = self.reports / "versions"
        self.history.mkdir(exist_ok=True)
        super().__init__(manager, "deepdive-jobs")

    def _published(self, row):
        import re
        job_id = row.get("job_id", "")
        if not isinstance(job_id, str) or not re.fullmatch(r"[0-9a-f]{32}", job_id):
            return False
        try:
            payload = json.loads((self.history / (job_id + ".json")).read_text())
            return (payload.get("job_id") == job_id and payload.get("ai_source") == row.get("source")
                    and payload.get("generation_mode") == "isolated_deepdive" and bool(payload.get("verdict")))
        except (OSError, ValueError, AttributeError):
            return False

    def submit(self, body, source, key):
        fingerprint = digest({"stock": body.stock.strip(), "source": source})
        path = self.directory / (body.request_id + ".json")
        if path.exists():
            old = self._read(path)
            if not old or old.get("fingerprint") != fingerprint:
                raise EvidenceError("请求标识已使用或记录损坏；请重新发起")
            return {k: v for k, v in old.items() if k != "fingerprint"}
        if self.busy() or self.manager.active or self.manager.access.busy() or self.manager.page_chats.busy() or self.manager.daily.busy():
            raise EvidenceError("正在分析或接入 AI，请完成或取消后再试")
        if not body.stock.strip():
            raise EvidenceError("请输入代码或准确简称")
        self.cancel_event = threading.Event()
        self.current = {"job_id": body.request_id, "fingerprint": fingerprint, "stock": body.stock.strip(),
                        "source": source, "running": True, "status": "running", "stage": "核对标的与行情",
                        "started": time.time(), "elapsed": 0, "error": None}
        self._update()
        self.worker = threading.Thread(target=self._work, args=(body.stock.strip(), source, key), daemon=True)
        self.worker.start()
        return self.snapshot()

    def _work(self, stock, source, key):
        from tradingagents.review.deepdive.graph import run
        from tradingagents.review.prompts import RESEARCH_PACK
        from tradingagents.review.deepdive.store import serialize
        from tradingagents.review.llm_errors import LlmConfigError
        from tradingagents.review.util import china_today, is_degraded_report
        deadline = time.monotonic() + 1200
        def check():
            if self.cancel_event.is_set():
                raise LlmConfigError("深挖已取消；原报告已保留")
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise LlmConfigError("深挖超过时限，已停止；原报告已保留")
            return remaining
        try:
            directory = self.directory / self.current["job_id"]
            directory.mkdir(mode=0o700)
            inputs = FrozenStockInputs(directory, check)
            date = china_today()
            llm = DailyLLM(self.manager.runtime, source, key, directory, date, self.cancel_event, check, purpose="stock")
            final = run(stock, date, llm=llm, data_source=inputs, check=check, pack=RESEARCH_PACK,
                        progress=lambda stage: self._update(stage=stage))
            check()
            if final.get("error"):
                raise EvidenceError(final["error"])
            if not final.get("verdict_struct") or any(is_degraded_report(final.get(field, "")) for field in
                    ("theme_report", "capital_report", "technical_report", "risk_report")):
                raise EvidenceError("深挖分项或结论不完整，未替换原报告；请检查资料和 AI 接入后重试")
            payload = serialize(final)
            payload.update(ai_source=source, generation_mode="isolated_deepdive", job_id=self.current["job_id"],
                           input_revision=digest(inputs.values), input_sources=list(inputs.values.values()))
            with self.state_lock:
                check()
                # A new immutable version is authoritative; legacy latest/code files remain readable.
                atomic_write(self.history / (self.current["job_id"] + ".json"), payload)
                atomic_write(self.reports / (payload["code"] + ".json"), payload)
                atomic_write(self.reports / "latest.json", payload)
                self._finish(running=False, status="complete", stage="深挖报告已保存", error=None)
        except (EvidenceError, LlmConfigError) as exc:
            self._finish(running=False, status="cancelled" if self.cancel_event.is_set() else "failed", error=str(exc))
        except Exception:
            if self._published(self.current):
                self._finish(running=False, status="complete", stage="深挖版本已保存", error=None,
                             state_warning="报告版本已保存，但最新报告索引未更新；请按本次任务查看")
            else:
                self._finish(running=False, status="failed", error="深挖运行异常；请检查数据、AI 接入或存储空间；原报告已保留")
        finally:
            key = ""
            self._finish(elapsed=int(time.time() - self.current["started"]))

    def status(self, job_id=""):
        import re
        if not job_id:
            return self.snapshot()
        if not re.fullmatch(r"[0-9a-f]{32}", job_id):
            raise EvidenceError("任务标识无效")
        with self.state_lock:
            if self.current and self.current["job_id"] == job_id:
                return self.snapshot()
            row = self._read(self.directory / (job_id + ".json"))
            if not row:
                raise EvidenceError("未找到本次任务，请恢复原请求")
            row.pop("fingerprint", None)
            return row

    def report(self, job_id):
        import re
        if not re.fullmatch(r"[0-9a-f]{32}", job_id):
            raise EvidenceError("任务标识无效")
        try:
            return json.loads((self.history / (job_id + ".json")).read_text())
        except (OSError, ValueError):
            raise EvidenceError("本次深挖没有已保存报告") from None
