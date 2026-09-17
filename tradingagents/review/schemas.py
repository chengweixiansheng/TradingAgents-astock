"""复盘结论的结构化 schema（市场与板块层面）"""

from __future__ import annotations

from typing import List

from pydantic import BaseModel, Field, field_validator


# 情绪档位五档（模型可能产出「亢奋末期」「修复偏强」等，归一化到含有的那一档）
PHASES = ["冰点", "修复", "发酵", "亢奋", "退潮"]


class FocusDirection(BaseModel):
    direction: str = Field(min_length=2, description="题材/板块/方向名")
    logic: str = Field(min_length=4, description="该方向今日活跃的支撑依据（情绪/资金/题材/龙头 哪几条）")
    risk: str = Field(min_length=2, description="该方向的风险 / 证伪信号")


class VerificationItem(BaseModel):
    """明日验证条件：从固定指标集里选一个读数 + 预期方向"""

    metric: str = Field(description="可核验指标 key（只能从给定清单里选）")
    direction: str = Field(description="预期明日方向：上升/下降/持平")
    reason: str = Field(min_length=2, description="为什么这条能验证今晚的判断")

    @field_validator("direction")
    @classmethod
    def _normalize_direction(cls, v: str) -> str:
        from .verification import DIRECTIONS

        for d in DIRECTIONS:
            if d in v:
                return d
        raise ValueError(f"方向需含 {DIRECTIONS} 之一，得到 {v!r}")

    @field_validator("metric")
    @classmethod
    def _known_metric(cls, v: str) -> str:
        from .verification import METRICS

        keys = {m.key for m in METRICS}
        v = v.strip()
        if v not in keys:
            raise ValueError(f"未知指标 {v!r}，只能从 {sorted(keys)} 里选")
        return v


class TomorrowFocus(BaseModel):
    emotion_phase: str = Field(description="市场情绪档位：冰点/修复/发酵/亢奋/退潮")
    market_oneliner: str = Field(min_length=4, description="今日盘面一句话总结")
    focus_directions: List[FocusDirection] = Field(
        min_length=2, max_length=5, description="当前活跃的题材/板块方向（2-5 个）"
    )
    risk_alerts: List[str] = Field(default_factory=list, description="需要警惕的风险信号")
    verification_items: List[VerificationItem] = Field(
        default_factory=list, max_length=5,
        description="明日验证条件（2-5 条）：明天用哪些市场事实检验今晚的判断",
    )

    @field_validator("emotion_phase")
    @classmethod
    def _normalize_phase(cls, v: str) -> str:
        for p in PHASES:
            if p in v:
                return p
        raise ValueError(f"情绪档位需含 {PHASES} 之一，得到 {v!r}")


# 给 JSON 模式的英文键名骨架（比 with_structured_output 对中文 LLM 更稳）
FOCUS_SKELETON = """{
  "emotion_phase": "情绪档位，只能填：冰点/修复/发酵/亢奋/退潮 之一",
  "market_oneliner": "今日盘面一句话总结",
  "focus_directions": [
    {"direction": "题材/板块名", "logic": "今日活跃的支撑依据(逻辑链)", "risk": "风险/证伪点"}
  ],
  "risk_alerts": ["风险信号1", "风险信号2"]
}
（focus_directions 必须 2~5 个）"""

_DISCLAIMER = "> ⚠️ 本页由 AI 多 agent 生成，仅供参考，不构成投资建议；市场有风险，决策与盈亏自负。\n"


def render_tomorrow_focus(tf: TomorrowFocus) -> str:
    """把结构化结论渲染成 markdown。"""
    lines = ["# 盘面研判\n", _DISCLAIMER]
    lines.append(f"**情绪档位**：{tf.emotion_phase}\n")
    lines.append(f"**今日盘面**：{tf.market_oneliner}\n")
    lines.append("\n## 活跃方向\n")
    if not tf.focus_directions:
        lines.append("（无）\n")
    for i, d in enumerate(tf.focus_directions, 1):
        lines.append(f"### {i}. {d.direction}")
        lines.append(f"- 依据：{d.logic}")
        lines.append(f"- 风险/证伪：{d.risk}\n")
    lines.append("## 风险提示")
    if tf.risk_alerts:
        for r in tf.risk_alerts:
            lines.append(f"- {r}")
    else:
        lines.append("- （无）")
    if tf.verification_items:
        # 明日验证条件：不是"明天买什么"，是"明天用哪些客观读数检验今晚的判断"
        from .verification import METRICS

        label = {m.key: m.label for m in METRICS}
        lines.append("## 明日验证条件")
        for v in tf.verification_items:
            lines.append(f"- **{label.get(v.metric, v.metric)}** 预期{v.direction} —— {v.reason}")
        lines.append("")
    return "\n".join(lines)
