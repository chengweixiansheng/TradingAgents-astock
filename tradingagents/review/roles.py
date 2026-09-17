"""短线分析师角色 registry（ #19）"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Callable

from . import analysts


@dataclass(frozen=True)
class Role:
    key: str            # UI/序列化用的稳定 key
    report_field: str   # 写入 state 的字段名
    title: str          # 卡片标题
    tag: str            # UI 短标签
    factory: Callable   # 节点工厂 create_*_analyst


ROLES: tuple[Role, ...] = (
    Role("sentiment", "sentiment_report", "情绪面", "情绪面", analysts.create_sentiment_analyst),
    Role("capital", "capital_report", "资金面", "资金面", analysts.create_capital_analyst),
    Role("theme", "theme_report", "题材热点", "题材热点", analysts.create_theme_analyst),
    Role("dragon_tiger", "dragon_tiger_report", "龙虎榜游资", "龙虎榜", analysts.create_dragon_tiger_analyst),
    Role("leader", "leader_report", "龙头跟踪", "龙头", analysts.create_leader_analyst),
)

# 额外的事实字段（非独立 LLM 角色，但要进裁判视野与 UI）
MACRO_FIELD = "macro_sector_report"
MACRO_TITLE = "大板块本周"
