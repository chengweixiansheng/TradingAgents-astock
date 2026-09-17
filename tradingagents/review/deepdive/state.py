"""个股深挖状态对象（与主线 A 同构：一角色一 report + 辩论子状态 + 结论）。"""

from __future__ import annotations

from typing import Annotated, Optional

from typing_extensions import TypedDict


class StockDebateState(TypedDict):
    history: Annotated[str, "全场辩论历史"]
    join_history: Annotated[str, "正方单方历史"]
    avoid_history: Annotated[str, "反方单方历史"]
    current_response: Annotated[str, "上一轮发言（带前缀）"]
    judge_decision: Annotated[str, "裁判裁决"]
    count: Annotated[int, "辩论轮次计数"]


class StockDeepDiveState(TypedDict):
    code: Annotated[str, "6 位股票代码"]
    name: Annotated[str, "股票名称"]
    trade_date: Annotated[str, "深挖基准交易日"]
    profile: Annotated[str, "实时行情快照（run 开始时取一次，各分析师共享）"]

    theme_report: Annotated[str, "① 题材归属"]
    capital_report: Annotated[str, "② 资金流向"]
    technical_report: Annotated[str, "③ 技术形态"]
    risk_report: Annotated[str, "④ 风险排查"]

    debate_state: Annotated[StockDebateState, "正方 vs 反方 辩论"]
    verdict: Annotated[str, "个股深挖结论（markdown）"]
    verdict_struct: Annotated[Optional[dict], "结论结构化对象（供 UI；解析失败则 None）"]


def new_stock_debate_state() -> StockDebateState:
    return StockDebateState(
        history="", join_history="", avoid_history="",
        current_response="", judge_decision="", count=0,
    )
