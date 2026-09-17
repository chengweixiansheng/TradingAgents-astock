"""共享辩论原语 —— 主线 A（复盘）与主线 B（个股深挖）共用，避免逻辑漂移。

只抽取无业务含义的编排原语（回合累积 / 交替路由 / 报告收集），业务 prompt 与 schema 各自保留。
"""

from __future__ import annotations

from .util import strip_model_noise


def append_turn(debate: dict, speaker: str, content: str, self_key: str) -> dict:
    """把一轮发言 append 回辩论状态：全场 history / 单方 history / current_response / count+1。

    发言先经 strip_model_noise 清洗（去模型自述噪声）。返回新 dict，不改原状态。
    """
    arg = f"{speaker}: {strip_model_noise(content)}"
    new = dict(debate)
    new["history"] = debate.get("history", "") + "\n" + arg
    new[self_key] = debate.get(self_key, "") + "\n" + arg
    new["current_response"] = arg
    new["count"] = debate.get("count", 0) + 1
    return new


def make_debate_router(first: str, second: str, judge: str, max_rounds: int):
    """两方交替辩论路由器：count 达 2*max_rounds 进 judge，否则 first↔second 交替。

    first 先发言（图里首条边指向 first）。max_rounds 必须是 >=1 的正整数。
    """
    if not isinstance(max_rounds, int) or max_rounds < 1:
        raise ValueError(f"max_rounds 必须是 >=1 的整数，得到 {max_rounds!r}")

    def router(state) -> str:
        d = state["debate_state"]
        if d["count"] >= 2 * max_rounds:
            return judge
        if d["current_response"].startswith(first):
            return second
        return first

    return router


def collect_reports(state: dict, pairs) -> str:
    """把已产出的分析师报告拼成一段。pairs = [(state字段名, 展示标题), ...]，空的跳过。"""
    parts = []
    for field, label in pairs:
        v = (state.get(field) or "").strip()
        if v:
            parts.append(f"【{label}】\n{v}")
    return "\n\n".join(parts) if parts else "（暂无分析师报告）"
