"""个股深挖结论 schema —— 客观画像 + 风险披露。

**不含参与倾向（值得关注/回避之类）、不含关注点位或买卖时机** —— 见 `prompts.py` 顶部说明。
"""

from __future__ import annotations

from typing import List

from pydantic import BaseModel, Field


class StockProfile(BaseModel):
    one_liner: str = Field(min_length=4, description="一句话概括该标的当前的客观状态")
    theme: str = Field(min_length=2, description="题材归属与和当前主线的关系")
    capital: str = Field(min_length=2, description="资金面（龙虎榜/量能/主力动向）")
    technical: str = Field(min_length=2, description="技术位置（所处区间、形态、连板情况）")
    risks: List[str] = Field(min_length=1, max_length=6, description="需要披露的风险点（至少 1 条）")
    debate_takeaway: str = Field(min_length=4, description="正反两方的核心分歧")


PROFILE_SKELETON = """{
  "one_liner": "一句话概括该标的当前的客观状态",
  "theme": "题材归属与是否当前主线",
  "capital": "资金面(龙虎榜/量能/主力)",
  "technical": "技术位置(所处区间/形态/连板)",
  "risks": ["风险1", "风险2"],
  "debate_takeaway": "正反两方核心分歧"
}"""

_DISCLAIMER = "> ⚠️ 本页由 AI 多 agent 生成，仅供参考，不构成投资建议；市场有风险，决策与盈亏自负。\n"


def render_profile(p: StockProfile) -> str:
    lines = ["# 个股画像\n", _DISCLAIMER]
    lines.append(f"**画像**：{p.one_liner}\n")
    lines.append(f"- 题材：{p.theme}")
    lines.append(f"- 资金：{p.capital}")
    lines.append(f"- 技术：{p.technical}\n")
    lines.append("**风险**：\n" + ("\n".join(f"- {r}" for r in p.risks) or "- —"))
    lines.append(f"\n**正反分歧**：{p.debate_takeaway}\n")
    return "\n".join(lines)
