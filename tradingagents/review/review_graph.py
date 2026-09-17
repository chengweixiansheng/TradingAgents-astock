"""主线 A：每日复盘图装配"""

from __future__ import annotations

from langgraph.graph import END, START, StateGraph

from .config import make_llm
from .roles import ROLES
from .state import DuanxianReviewState
from .synthesizer import create_review_judge

_JUDGE = "复盘裁判"


def build_review_graph():
    quick = make_llm(deep=False)   # 五个分析师
    deep = make_llm(deep=True)     # 复盘裁判

    g = StateGraph(DuanxianReviewState)

    # 五个分析师：从 registry 动态建节点并串起来（#19）
    prev = START
    for role in ROLES:
        g.add_node(role.title, role.factory(quick))
        g.add_edge(prev, role.title)
        prev = role.title

    g.add_node(_JUDGE, create_review_judge(deep))

    g.add_edge(prev, _JUDGE)

    g.add_edge(_JUDGE, END)

    return g.compile()
