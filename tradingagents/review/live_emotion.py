"""今日**实时**打板情绪（盘面数据页用）。

和 `emotion_metrics` 的分工：
  · `emotion_metrics` = 复盘口径，要当天的**收盘**数据，只算已收盘那一场；
  · 这里 = 盘中快照，回答"此刻打板好不好做"，数字随盘变化。

⚠️ 为什么不复用 `vr/` 的 `/api/market/emotion`：那条被
   `server._pin_pool_to_settled_session()` 锁在已收盘那一场了（复盘类块需要），
   而这里恰恰要今天。所以走那个锁留下的未加锁出口 `_pool_unpinned`。

⚠️ 炸板率必须**另取炸板池**：涨停池里的 `zbc` 只是"这一只炸过几次"，
   全市场炸了多少家它答不了。分母 = 最终封住 + 炸板未回封 = 尝试过涨停的家数。
"""

from __future__ import annotations

import sys
import threading
import time
from typing import Optional

from . import trade_calendar
from .util import china_now

# 取一次要打四个池（涨停/炸板/跌停/昨日涨停），实测约 8 秒 ——
# 而界面是 5 秒一刷，不缓存就会请求叠着堆（日志里能看到并发好几条），
# 既拖慢页面又白撞东财的限流。
#
# 分两档：**昨日的池子盘中不会变**，缓存到当天结束都行；今日的池子缓存 15 秒
# （比 5 秒的刷新间隔长一点，够挡住叠加；行情本身也不值得更细）。
# ⚠️ `trade_calendar.prev_trade_date` / `is_settled` **每次调用都打网络**
#    （各约 1.7-3.2 秒，那边自己没缓存）。只缓存四个池子的话，热态还是要 3.9 秒 ——
#    比 5 秒的刷新间隔差不了多少，等于没修。日历结果一天内不会变，一起缓存掉。
_TODAY_TTL = 15.0
_PREV_TTL = 3600.0
_CAL_TTL = 3600.0
_cache: dict[str, tuple[float, object]] = {}
_lock = threading.Lock()


_MISS = object()


def _cached(key: str, ttl: float, build):
    """极简 TTL 缓存。**失败不缓存**（下次重试），但「空但有效」要缓存。

    ⚠️ 判据必须是 `is not None`，不能写 `if val:` —— 那会把**合法的空结果**
    当成失败：今天跌停 0 家时 `dt` 是 `[]`，用真值判断就永不入缓存，
    每次请求都重打一次网络（实测热态因此卡在 1.78 秒，等于没缓存）。
    取数失败时 `_pool` 返回 None，两者本来就能区分。
    """
    now = time.monotonic()
    with _lock:
        hit = _cache.get(key)
        if hit and now - hit[0] < ttl:
            return hit[1]
    val = build()
    if val is not None:
        with _lock:
            _cache[key] = (now, val)
    return val


def _pool(kind: str, ymd: str) -> Optional[list[dict]]:
    """取东财涨停板四池之一。走未加锁出口；拿不到返回 None（不把失败当成 0 家）。"""
    astock = sys.modules.get("astock")
    if astock is None:
        return None
    fetch = getattr(astock, "_pool_unpinned", None) or getattr(astock, "em_zt_topic_pool", None)
    if fetch is None:
        return None
    try:
        result = fetch(kind, ymd, "fbt:asc")
        return result if isinstance(result, list) else None
    except Exception:  # noqa: BLE001  取不到就整块标不可用
        return None


def _rate(hit: int, total: int) -> Optional[float]:
    return round(hit / total, 4) if total else None


def snapshot() -> dict:
    """今日实时打板情绪。非交易时段 / 取不到数据 → available=False 并说明原因。"""
    today = china_now().strftime("%Y-%m-%d")
    ymd = today.replace("-", "")
    quote_day = trade_calendar.quote_trade_day()
    phase = trade_calendar.session_phase(china_now(), quote_day)
    if quote_day != today:
        return {"available": False, "date": today, "reason": phase["label"] + "；未取得本场行情，不计算今日晋级率"}
    if phase["phase_key"] in {"auction", "wait", "unknown", "closing"}:
        return {"available": False, "date": today, "reason": phase["label"] + "；连续交易情绪统计稍后更新"}

    settled = _cached(f"settled:{today}", _CAL_TTL,
                      lambda: ("Y" if trade_calendar.is_settled(today) else "N")) == "Y"

    zt = _cached(f"zt:{ymd}", _TODAY_TTL, lambda: _pool("getTopicZTPool", ymd))
    if zt is None:
        return {"available": False, "reason": "涨停池取数失败"}
    if not zt:
        return {"available": False, "date": today,
                "reason": "今日还没有涨停池（未开盘 / 非交易日）"}

    zb = _cached(f"zb:{ymd}", _TODAY_TTL, lambda: _pool("getTopicZBPool", ymd))   # 炸板未回封
    dt = _cached(f"dt:{ymd}", _TODAY_TTL, lambda: _pool("getTopicDTPool", ymd))   # 跌停

    boards = [int(p.get("lbc") or 1) for p in zt]
    zt_n, zb_n = len(zt), (len(zb) if zb is not None else None)
    tried = zt_n + zb_n if zb_n is not None else None   # 尝试过涨停的家数

    # 晋级率：昨日涨停的票今天又封住的比例（= 界面上那句"昨涨停今又停"）。
    # **不需要行情**，只比两天的池子成员，所以盘中也算得出
    # （`emotion_metrics` 那份要收盘价，盘中给不了）。
    # ⚠️ 别用东财的 `getYesterdayZTPool` —— 实测它对任何日期都返回 0 条。
    #    直接取「上一交易日」的涨停池自己比。
    prev_day = _cached(f"prevday:{today}", _CAL_TTL,
                       lambda: trade_calendar.prev_trade_date(today))
    prev = (_cached(f"zt:{prev_day}", _PREV_TTL,
                    lambda: _pool("getTopicZTPool", prev_day.replace("-", "")))
            if prev_day else None)
    today_codes = {str(p.get("c")) for p in zt}
    promo: Optional[float] = None
    promo_base: Optional[int] = None
    if prev:
        promo_base = len(prev)
        promo = _rate(sum(1 for p in prev if str(p.get("c")) in today_codes), promo_base)

    return {
        "available": True,
        "date": today,
        "as_of": china_now().strftime("%H:%M"),
        "phase": phase["label"],
        "settled": settled,
        "zt_count": zt_n,
        "dt_count": len(dt) if dt is not None else None,
        "zb_count": zb_n,
        "max_boards": max(boards) if boards else 0,
        "lianban_count": sum(1 for b in boards if b >= 2),
        "seal_rate": _rate(zt_n, tried) if tried else None,
        "break_rate": _rate(zb_n, tried) if (tried and zb_n is not None) else None,
        "promotion_rate": promo,
        "promotion_base": promo_base,
        # 分母是哪一场 —— 界面上两张卡都叫「晋级率」，如果只写"昨"，
        # 实时那张的"昨"是最近已收盘那场、定稿那张的"昨"是它的前一天，
        # 同一个字指两个不同的日子。把日期给出去，让界面直接写死。
        "promotion_base_date": prev_day,
    }
