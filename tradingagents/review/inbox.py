"""异常交易收件箱：按客观条件筛出少数几笔值得回头看的交易，附上"为什么进来"。

流水一长就没人会逐笔翻，最该被看见的那几笔会淹没在里面。

## 判定基准全部来自使用者自己

⚠️ 这里**没有任何外部标准**："仓位偏大"是相对**他自己的中位仓位**，
"持有偏久"是相对**他自己的中位持有天数**；规则违反用的是 `risk.load_rules()` 里
他自己写下的阈值。把行业经验塞进阈值就变成了在教他怎么交易。

## ⚠️ 不排序"严重程度"，也不给建议

每条只说哪里不寻常，不说"所以应该怎样"。排序按**日期倒序**，
不按任何主观的严重程度。

## 边界

只统计使用者自己录入的交易 + 他自己写下的规则 + 公开行情。
⛔ 本模块的数据**不接入任何 AI prompt**。
"""

from __future__ import annotations

from statistics import median
from typing import Any, Optional

# 偏离多少倍中位数才算"不寻常"。⚠️ 这不是"多少算大"的行业标准，
# 只是"相对他自己明显偏离"的门槛 —— 2 倍是个宽松的筛子，宁可少报不多报。
_DEVIATION_X = 2.0

# 少于这么多笔就不做"相对自己习惯"的判定（3 笔的中位数不是习惯）
_MIN_HISTORY = 8

# MAE 深到这个程度算"扛过大幅浮亏"（相对成本的百分比）
_DEEP_MAE = -8.0

# 捕获率低于此值且行情本来有肉 → "看对了没吃到"
_LOW_CAPTURE = 0.3


def _num(v: Any) -> Optional[float]:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return None if f != f else f


def _capital_of(t: dict) -> Optional[float]:
    st = t.get("settled") or {}
    # ⚠️ 字段名是 `amount`（`journal._settle` 里的"建仓总金额 = 这笔占用的资金"），
    # **不是** capital_used。写错的话主路径恒失效、悄悄退到下面按 fills 重算 ——
    # 结果还对，但那段查表白写了，而且下次有人改 fills 结构就会静默出错。
    v = _num(st.get("amount"))
    if v is not None:
        return v
    cost, shares = _num(st.get("avg_cost")), None
    for f in t.get("fills") or []:
        if f.get("side") == "buy":
            shares = (shares or 0) + (_num(f.get("shares")) or 0)
    return round(cost * shares, 2) if (cost and shares) else None


def build(limit: int = 500) -> dict:
    """筛出异常交易。每条带 `flags`（为什么进来）。"""
    from . import journal, risk

    try:
        trades = (journal.list_trades(limit=limit) or {}).get("trades") or []
    except Exception as exc:  # noqa: BLE001
        return {"available": False, "reason": f"读交易日志失败：{exc}"}
    if not trades:
        return {"available": False, "reason": "还没有交易记录"}

    rules = risk.load_rules()
    # 自己的习惯基线（样本不够就不做这类判定，而不是拿 3 笔当习惯）
    caps = [c for c in (_capital_of(t) for t in trades) if c]
    holds = [h for h in ((t.get("settled") or {}).get("hold_days") for t in trades)
             if h is not None]
    med_cap = median(caps) if len(caps) >= _MIN_HISTORY else None
    med_hold = median(holds) if len(holds) >= _MIN_HISTORY else None

    # MFE/MAE 类判定 —— ⚠️ **只用已缓存的行情，一次网络请求都不发**。
    # 内联去拉的话，几百笔的账本首次打开就是几百次串行请求，接口会卡几分钟甚至超时。
    # 没缓存的笔数如实计数，并提示"先打开 MFE/MAE 面板囤一遍"。
    exc_by_id: dict[str, dict] = {}
    exc_skipped = 0
    try:
        from . import excursion

        for t in trades:
            if not (t.get("settled") or {}).get("closed"):
                continue                     # 未平仓没有 MFE/MAE 可言
            r = excursion.for_trade_cached_only(t)
            if r and t.get("id"):
                exc_by_id[t["id"]] = r
            elif t.get("id"):
                exc_skipped += 1
    except Exception:  # noqa: BLE001  行情不可用时收件箱照常工作，只少一类判定
        pass

    items = []
    for t in trades:
        st = t.get("settled") or {}
        flags: list[dict] = []

        # ① 违反自己写下的单笔亏损上限
        lim = _num(rules.get("max_loss_per_trade_pct"))
        pnl = _num(t.get("pnl_pct"))
        if lim and pnl is not None and pnl < -lim:
            flags.append({"key": "over_loss_limit",
                          "text": f"亏 {pnl:.1f}%，超过你自己写的单笔上限 {lim:g}%"})

        # ② 仓位明显偏离自己的中位（相对他自己，不是行业标准）
        cap = _capital_of(t)
        if med_cap and cap and cap > med_cap * _DEVIATION_X:
            flags.append({"key": "oversized",
                          "text": f"占用 {cap:,.0f} 元，是你中位仓位（{med_cap:,.0f}）的 "
                                  f"{cap / med_cap:.1f} 倍"})

        # ③ 持有时间明显偏离自己的中位
        hold = st.get("hold_days")
        if med_hold is not None and hold is not None and med_hold > 0 \
                and hold > med_hold * _DEVIATION_X:
            flags.append({"key": "held_long",
                          "text": f"持有 {hold} 天，是你中位持有（{med_hold:g} 天）的 "
                                  f"{hold / med_hold:.1f} 倍"})

        # ④ 计划外交易
        if t.get("as_planned") is False:
            flags.append({"key": "unplanned", "text": "自己标了「计划外」"})

        # ⑤ 未平仓却没写计划止损 —— 在险资金无从估计
        if not st.get("closed") and st.get("has_fills") and not t.get("planned_stop"):
            flags.append({"key": "no_stop",
                          "text": "还在手上，但没写计划止损 —— 最坏情况无从估计"})

        ex = exc_by_id.get(t.get("id") or "")
        if ex:
            # ⑥ 扛过大幅浮亏（不论最后赚没赚，都是值得看一眼的样本）
            if ex["mae_pct"] <= _DEEP_MAE:
                tail = "最后还是赚的" if ex["realized_pct"] > 0 else "最后亏了"
                flags.append({"key": "deep_mae",
                              "text": f"中途最多浮亏 {ex['mae_pct']:.1f}%（{tail}）"})
            # ⑦ 行情本来有肉但几乎没吃到
            cr = ex.get("capture_rate")
            if cr is not None and cr < _LOW_CAPTURE:
                flags.append({"key": "low_capture",
                              "text": f"这段最多能赚 {ex['mfe_pct']:.1f}%，实际落袋 "
                                      f"{ex['realized_pct']:.1f}%（吃到 {cr:.0%}）"
                                      + ("；同日进出，MFE 只是上界" if ex["same_day"] else "")})

        if flags:
            items.append({
                "id": t.get("id"), "date": st.get("first_buy") or t.get("date"),
                "code": t.get("code"), "name": t.get("name"),
                "playbook": t.get("playbook"), "pnl_pct": pnl,
                "note": t.get("note") or "",
                "closed": bool(st.get("closed")),
                "flags": flags,
            })

    # ⚠️ 按日期倒序（最近的先看），**不按"我们觉得多严重"排** —— 那是替用户判断
    items.sort(key=lambda r: (r["date"] or ""), reverse=True)
    by_key: dict[str, int] = {}
    for it in items:
        for f in it["flags"]:
            by_key[f["key"]] = by_key.get(f["key"], 0) + 1
    return {
        "available": True,
        "items": items,
        "count": len(items),
        "scanned": len(trades),
        "by_flag": by_key,
        "baseline": {"median_capital": med_cap, "median_hold_days": med_hold,
                     "history_enough": med_cap is not None,
                     "min_history": _MIN_HISTORY},
        "rules_is_default": bool(rules.get("_is_default")),
        # 有多少笔因为行情没缓存而跳过了 MFE/MAE 类判定 —— 说清楚，别让人以为"没问题"
        "excursion_skipped": exc_skipped,
        "excursion_hint": (f"{exc_skipped} 笔的行情还没缓存，扛大幅浮亏 / 没吃到行情"
                           "这两类判定暂时跳过了 —— 打开上面的 MFE/MAE 面板会把行情囤下来，"
                           "之后刷新这里就有了。"
                           if exc_skipped else None),
        "note": ("判定基准全部来自你自己：仓位/持有久不久是相对**你自己的中位数**，"
                 "亏损上限用的是**你写下的**阈值。这里只说哪里不寻常，不说该怎么做。"),
        "excursion_available": bool(exc_by_id),
    }
