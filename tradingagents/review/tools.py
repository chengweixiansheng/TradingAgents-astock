"""资讯工具层 —— Agent-Reach 全网检索（题材热点分析师用）"""

from __future__ import annotations

import json
import subprocess

_MAX_RESULTS = 10
_MAX_QUERY = 200


def _escape_dsl(q: str) -> str:
    """转义会破坏 exa.web_search_exa(query:"...") 表达式的字符（反斜杠、双引号、换行）。"""
    return q.replace("\\", "\\\\").replace('"', '\\"').replace("\n", " ").replace("\r", " ")


def agent_reach_search(query: str, num_results: int = 5, timeout: int = 90) -> str:
    """走 Agent-Reach 的 Exa 全网搜索（零配置命令）。失败优雅降级。"""
    try:
        num_results = max(1, min(int(num_results), _MAX_RESULTS))
    except (TypeError, ValueError):
        num_results = 5
    q = _escape_dsl((query or "")[:_MAX_QUERY])
    cmd = f'exa.web_search_exa(query:"{q}", numResults:{num_results})'
    try:
        out = subprocess.run(
            ["mcporter", "call", cmd],
            capture_output=True, text=True, timeout=timeout,
        )
        if out.returncode != 0:
            return f"[Agent-Reach 调用失败 rc={out.returncode}] {(out.stderr or '')[:150]}"
        text = (out.stdout or "").strip()
        if not text:
            return f"[Agent-Reach 无返回] stderr={(out.stderr or '')[:200]}"
        try:
            data = json.loads(text)
            items = data.get("results") or data.get("data") or []
            lines = []
            for it in items[:num_results]:
                title = str(it.get("title", ""))[:120]
                snippet = str(it.get("text") or it.get("snippet") or "")[:200]
                lines.append(f"- {title}：{snippet}")
            return "\n".join(lines) if lines else text[:2000]
        except Exception:
            return text[:2000]
    except FileNotFoundError:
        return "[Agent-Reach 未打通：mcporter 不在 PATH]"
    except subprocess.TimeoutExpired:
        return "[Agent-Reach 超时]"
    except Exception as e:  # noqa: BLE001
        return f"[Agent-Reach 异常 {type(e).__name__}]"
