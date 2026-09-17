"""用**本机已登录的 AI CLI 订阅**当复盘的 LLM（Claude Code / ），免 API key"""

from __future__ import annotations

import logging
import os
import sys
from dataclasses import dataclass
from pathlib import Path

from .llm_errors import LlmConfigError

logger = logging.getLogger(__name__)

# 复盘各节点的系统提示词由 prompt 包给（`prompts.py`），这里只给一句最小的角色约束。
# CLI 是「一次性作答」模式，没有多轮消息结构，system 与 user 都拼进去。
_SYSTEM = "你是 A 股短线复盘助手。严格按用户给的格式与要求作答，不要寒暄、不要解释你在做什么。"

# 环境变量名。故意不复用 server.py 的 `VIBE_ALLOW_UNSAFE_CLI` ——
# 那个管的是「前端问 AI 能选哪个 CLI」，这个管的是「复盘用哪个 CLI 当 LLM」，
# 两件事、两个开关，混用会让人以为放开一个就等于放开另一个。
ENV_KIND = "VIBE_LLM_CLI"

_BINS_ATTR_NAME = "_vibe_all_cli_bins"


@dataclass(frozen=True)
class CliResponse:
    """只需要 `.content` —— 流水线拿的就是这个。"""

    content: str


class CliLlm:
    """把 `llm.invoke(prompt)` 转成一次本机 CLI 调用。"""

    def __init__(self, kind: str, label: str = "") -> None:
        self.kind = kind
        self.label = label or kind

    def invoke(self, prompt: str) -> CliResponse:
        _check_available(self.kind)
        run_cli = _load_run_cli()
        text = run_cli(self.kind, _SYSTEM, prompt)
        if not (text or "").strip():
            # 空回复要当失败抛出去，别让它变成一段空的复盘正文
            # （`structured.py` 会重试，重试完退回自由文本）
            raise RuntimeError(f"{self.kind} 返回空内容")
        return CliResponse(content=text)


def _load_runtime():
    """拿 `vr/cli_runtime.py` 模块本身"""
    mod = sys.modules.get("cli_runtime")
    if mod is None:
        vr_dir = str(Path(__file__).resolve().parent.parent / "vr")
        if vr_dir not in sys.path:
            sys.path.insert(0, vr_dir)
        import cli_runtime as mod  # noqa: PLC0415
    return mod


def _check_available(kind: str) -> None:
    """跑之前先问清楚这个 kind 在**当前进程**里到底能不能用"""
    mod = _load_runtime()
    defs = getattr(mod, "_CLI_DEFS", {})
    if kind in defs:
        return
    known = getattr(mod, _BINS_ATTR_NAME, None) or {}
    find_bin = getattr(mod, "_find_bin", None)
    installed = bool(find_bin) and any(find_bin(b) for b in (known.get(kind) or []))
    if installed:   # 装着、只是被闸摘掉了 —— 这时候报"未检测到"是骗人
        raise LlmConfigError(
            f"复盘要用「{kind}」，但它被服务端的 CLI 白名单摘掉了。"
            f"在 server 上跑请同时设 VIBE_ALLOW_UNSAFE_CLI={kind}"
            f"（这会让前端「问 AI」也能选它 —— 那条路会把抓来的外部新闻原文送进 prompt，"
            f"确认你接受再开）；或者用 `python main.py` 独立跑。"
        )
    raise LlmConfigError(
        f"复盘要用「{kind}」，但本机 PATH 里找不到它的可执行文件"
        + (f"（要找的是 {known[kind]}）" if known.get(kind) else "（这个名字也不在支持列表里）")
        + f"。当前可用：{sorted(defs) or '（无）'}。请先安装并登录该 CLI，或改用 API key。"
    )


def _load_run_cli():
    return _load_runtime().run_cli


def wanted_kind() -> str | None:
    """使用者要用 CLI 跑复盘；要的话用哪个。没设 → None（走 API key 那条）"""
    v = os.environ.get(ENV_KIND, "").strip()
    return v or None


def make_cli_llm(deep: bool = False) -> CliLlm:
    """构造 CLI 版 LLM。

    CLI 没有 quick / deep 两档模型可选（订阅就是那一个模型），`deep` 只用于日志标注。
    """
    kind = wanted_kind()
    if not kind:
        raise RuntimeError(f"{ENV_KIND} 没设置，不该走到这里")
    return CliLlm(kind, label=f"{kind}/{'deep' if deep else 'quick'}")
