"""短线每日复盘的共享状态对象：一角色一 report 字段 + 最终结论字段。"""

from __future__ import annotations

from typing import Annotated, Optional

from typing_extensions import TypedDict


class DuanxianReviewState(TypedDict):
    """每日复盘全局状态。输入是交易日（不是单只股票）。"""

    trade_date: Annotated[str, "复盘的交易日 YYYY-MM-DD"]

    # ===== 五个短线分析师各产一份报告（**五个都已接实**，不是占位）=====
    sentiment_report: Annotated[str, "① 情绪面：涨跌停家数 / 炸板率 / 连板高度 / 赚钱效应"]
    capital_report: Annotated[str, "② 资金面：主力净流入 / 板块轮动 / 成交额榜"]
    theme_report: Annotated[str, "③ 题材热点：涨停原因题材串 + 概念热度 + Agent-Reach 资讯印证"]
    dragon_tiger_report: Annotated[str, "④ 龙虎榜游资：哪路游资 / 机构进出 / 席位"]
    leader_report: Annotated[str, "⑤ 龙头跟踪：近 5 天龙头谱系（前几天龙头→今天龙头→最新进展）"]
    macro_sector_report: Annotated[str, "大板块本周：算力 / 人形 / 商业火箭 强弱"]
    emotion_metrics: Annotated[dict, "派生情绪指标结构化（赚钱效应/晋级率/连板溢价）——供 UI 与命中回看"]
    market_facts: Annotated[dict, "客观事实表（封板质量/亏钱效应/反馈矩阵/题材结构/事件账本/分板块）——供 UI 直接渲染"]

    # ===== 最终结论 =====
    tomorrow_focus: Annotated[str, "复盘裁判综合出的『明天关注点』（渲染成 markdown）"]
    focus_struct: Annotated[Optional[dict], "明天关注点的结构化对象（供 UI 渲染卡片；解析失败则 None）"]

    # ===== 反思闭环 =====
    past_context: Annotated[str, "历史复盘记忆注入（近几日『明天关注点』命中回看）"]
