"""个股深挖图装配 + run 入口。

四分析师串行 → 正方⚔反方辩论环 → 裁判。辩论循环沿用 count 计数模式。
"""

from __future__ import annotations


from langgraph.graph import END, START, StateGraph

from . import data
from .agents import (
    AVOID, JOIN,
    create_avoid_debator, create_capital_analyst, create_join_debator,
    create_judge, create_risk_analyst, create_technical_analyst, create_theme_analyst,
)
from .state import StockDeepDiveState, new_stock_debate_state
from ..config import make_llm
from ..debate import make_debate_router
from ..util import china_today, is_degraded_report

_JUDGE = "裁判"
_ROUTES = {JOIN: JOIN, AVOID: AVOID, _JUDGE: _JUDGE}


def build_deepdive_graph(max_rounds: int = 1, *, llm=None, data_source=None, progress=None, check=None, pack=None):
    router = make_debate_router(JOIN, AVOID, _JUDGE, max_rounds)  # 共享路由，含轮数校验
    quick = llm if llm is not None else make_llm(deep=False)
    deep = llm if llm is not None else make_llm(deep=True)
    def stage(name, node):
        def invoke(state):
            if check: check()
            if progress: progress(name)
            result = node(state)
            if check: check()
            return result
        return invoke
    g = StateGraph(StockDeepDiveState)
    g.add_node("题材归属", stage("题材归属", create_theme_analyst(quick, data_source, pack)))
    g.add_node("资金流向", stage("资金流向", create_capital_analyst(quick, data_source, pack)))
    g.add_node("技术形态", stage("技术形态", create_technical_analyst(quick, data_source, pack)))
    g.add_node("风险排查", stage("风险排查", create_risk_analyst(quick, data_source, pack)))
    g.add_node(JOIN, stage(JOIN, create_join_debator(quick)))
    g.add_node(AVOID, stage(AVOID, create_avoid_debator(quick)))
    g.add_node(_JUDGE, stage(_JUDGE, create_judge(deep, pack)))

    g.add_edge(START, "题材归属")
    g.add_edge("题材归属", "资金流向")
    g.add_edge("资金流向", "技术形态")
    g.add_edge("技术形态", "风险排查")
    g.add_edge("风险排查", JOIN)
    g.add_conditional_edges(JOIN, router, _ROUTES)
    g.add_conditional_edges(AVOID, router, _ROUTES)
    g.add_edge(_JUDGE, END)
    return g.compile()


def run(code_or_name: str, trade_date: str | None = None, *, llm=None, data_source=None, progress=None, check=None, pack=None) -> dict:
    """深挖一只票。返回 final state，含 verdict / verdict_struct / 四报告 / 辩论。"""
    source = data_source if data_source is not None else data
    if check: check()
    code, name = source.resolve(code_or_name)
    if not code:
        return {"error": f"无法识别标的：{code_or_name!r}（请给 6 位代码或准确简称）"}
    profile = source.get_profile(code)  # 一次性行情快照，各分析师共享
    if is_degraded_report(profile):   # 连行情都取不到 → 停牌/无效标的，别白跑 7 次 LLM
        return {"error": f"{name or code} 行情不可用（可能停牌或非有效标的），已中止深挖"}
    trade_date = trade_date or china_today()   # 始终以交易所时区记录资料日期
    init = {
        "code": code, "name": name or code, "trade_date": trade_date, "profile": profile,
        "theme_report": "", "capital_report": "", "technical_report": "", "risk_report": "",
        "debate_state": new_stock_debate_state(),
        "verdict": "", "verdict_struct": None,
    }
    graph = build_deepdive_graph(llm=llm, data_source=data_source, progress=progress, check=check, pack=pack)
    return graph.invoke(init, {"recursion_limit": 50})
