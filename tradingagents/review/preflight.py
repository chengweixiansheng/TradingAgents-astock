"""跑复盘之前先体检输入。

为什么要有这一步：2026-07-30 盘前点过一次复盘，涨停池 / 龙虎榜 / 资金流全是空的，
四个分析师都如实写了"数据缺失"，**裁判照样端出三个方向 + 点名个股** ——
点到一只当天 -6.81% 的票当"主线代表"，而龙头跟踪自己已经写了
"今日无法识别有效最高标龙头"。落盘的 `warnings` 还是 `[]`。

结论不由我们把关（那是使用者自己 AI 的判断），但**喂进去的东西必须是真的**。
所以：核心数据缺 → 不跑，明说缺什么；非核心缺 → 照跑，但如实记进 warnings。

⚠️ 这里**直接调分析师会拿到的那几个取数口**，检的就是真输入，
   不用"交易日历说今天该有数据"这类替代指标 —— 替代指标正是上次失灵的地方
   （日历说 07-30 是交易日，可盘前根本没有池子）。
"""

from __future__ import annotations

from typing import Optional

from . import data
from .util import is_degraded_report

# (标签, `data` 里的取数函数名, 是不是核心)
#
# ⚠️ 存**名字**而不是函数对象：直接写 `data.get_sentiment_data` 会在 import 时
#    把引用冻住，之后任何对 `data` 的替换（测试打桩、或日后换数据层）都作用不到
#    这里 —— 体检查的就不再是分析师真正调的那个东西了，而这正是体检存在的意义。
# 核心 = 缺了整份复盘就没有骨架：
#   · 盘口统计 —— 涨停/跌停/炸板家数，所有情绪判断的原料
#   · 派生情绪指标 —— 赚钱效应 / 晋级率 / 梯队，"今天好不好做"全靠它
#   · 龙头跟踪 —— 缺了就没有"最高标"，而那是打板复盘的锚
# 非核心 = 缺了照样能复盘，只是少一路印证
_CHECKS: tuple[tuple[str, str, bool], ...] = (
    ("盘口统计", "get_sentiment_data", True),
    ("派生情绪指标", "get_emotion_metrics", True),
    ("龙头跟踪", "get_leader_data", True),
    ("资金面", "get_capital_data", False),
    ("龙虎榜", "get_dragon_tiger_data", False),
    ("题材串", "get_theme_reasons", False),
)


def _text_of(v: object) -> str:
    """取数口有的返回字符串、有的返回 (文本, 结构)，统一取文本那一份。"""
    if isinstance(v, tuple):
        return str(v[0]) if v else ""
    return str(v or "")


def _looks_degraded(text: str) -> bool:
    """降级有两种长相，都要认。

    ① 引擎注入的信封：`[⚠️ … 数据获取失败已降级 …]`，以 `[⚠️` 开头 —— `is_degraded_report` 认这个。
    ② **取数成功但没有内容**：空串 / 只有空白。这种不带前缀，
       上次就是它漏过去的（模型拿到空数据，自己用散文说"数据缺失"，
       而引擎数出 0 份降级）。
    """
    t = (text or "").strip()
    return not t or is_degraded_report(t)


def check(date: str, *, data_source=data) -> dict:
    """体检 `date` 这一场的输入。

    返回 `{"ok": bool, "missing_core": [...], "missing_optional": [...], "warnings": [...]}`。
    `ok=False` 表示**不该跑** —— 由调用方拒绝并把 `missing_core` 告诉用户。
    """
    # 第一道：这一场还没收盘 → 拿到的必然是盘中半成品（实测 09:35 只有 18 家涨停，
    # 收盘是 81 家），而复盘要的是定稿数据。这条不看内容、只看日期，因为
    # 盘中数据**是"有内容"的**，靠内容判断分不出来。
    from . import trade_calendar

    if not trade_calendar.is_settled(date):
        return {"ok": False, "missing_core": [f"{date} 还没收盘"],
                "missing_optional": [], "warnings": []}

    missing_core: list[str] = []
    missing_optional: list[str] = []

    for label, fname, is_core in _CHECKS:
        try:
            text = _text_of(getattr(data_source, fname)(date))
        except Exception as exc:  # noqa: BLE001  体检本身别把复盘搞崩
            text = f"[⚠️ {label} 体检取数异常：{type(exc).__name__}: {exc}]"
        if _looks_degraded(text):
            (missing_core if is_core else missing_optional).append(label)

    return {
        "ok": not missing_core,
        "missing_core": missing_core,
        "missing_optional": missing_optional,
        # 给 review_store 落盘用：非核心的缺失要如实显示在界面上，
        # 不能像上次那样 warnings 是空的、看着一切正常。
        "warnings": [f"{m}：数据缺失，本次复盘少了这一路" for m in missing_optional],
    }


def refuse_reason(result: dict, date: str) -> Optional[str]:
    """体检没过时给一句能照着办的话。"""
    if result.get("ok"):
        return None
    miss = "、".join(result.get("missing_core") or [])
    return (f"{date} 的核心数据取不到（{miss}），这一场不做复盘 —— "
            "喂空数据进去只会让 AI 硬凑出看着可信的结论。"
            "请确认该日是已收盘的交易日、以及数据源是否可达。")
