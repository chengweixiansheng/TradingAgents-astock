"""交易日历 —— 全系统唯一的交易日推导入口"""

from __future__ import annotations

import datetime
import logging
import threading
from typing import Optional

logger = logging.getLogger(__name__)

from .util import china_now, china_today, is_a_share_closed, is_weekend

_REF_STOCK = "sh600000"  # 浦发银行，流动性好、每个交易日都有，用来取真实交易日序列


def _ref_dates(start: str, end: str) -> list[str]:
    """参考股在 [start, end] 区间内的真实交易日（升序，YYYY-MM-DD）。失败返回空表。"""
    try:
        import akshare as ak

        df = ak.stock_zh_a_hist_tx(
            symbol=_REF_STOCK, start_date=start.replace("-", ""), end_date=end.replace("-", "")
        )
        if df is None or "date" not in df.columns:
            return []
        return sorted(str(x) for x in df["date"])
    except Exception:
        return []


def next_trade_date(date: str) -> Optional[str]:
    """date 的次一交易日。

    取不到交易日历时兜底『下一个工作日』——节假日兜底不精确没关系：
    若落到非交易日，个股 hist 查不到该日，调用方自然会跳过。
    """
    end = (datetime.datetime.strptime(date, "%Y-%m-%d") + datetime.timedelta(days=12)).strftime("%Y-%m-%d")
    for d in _ref_dates(date, end):
        if d > date:
            return d
    d = datetime.datetime.strptime(date, "%Y-%m-%d")
    for i in range(1, 6):
        nd = d + datetime.timedelta(days=i)
        if nd.weekday() < 5:
            return nd.strftime("%Y-%m-%d")
    return None


def prev_trade_date(date: str) -> Optional[str]:
    """date 的前一交易日。取不到交易日历时兜底『上一个工作日』。"""
    start = (datetime.datetime.strptime(date, "%Y-%m-%d") - datetime.timedelta(days=16)).strftime("%Y-%m-%d")
    earlier = [d for d in _ref_dates(start, date) if d < date]
    if earlier:
        return earlier[-1]
    d = datetime.datetime.strptime(date, "%Y-%m-%d")
    for i in range(1, 6):
        pd_ = d - datetime.timedelta(days=i)
        if pd_.weekday() < 5:
            return pd_.strftime("%Y-%m-%d")
    return None


def last_trade_dates(n: int = 5) -> list[str]:
    """最近 n 个**已收盘**交易日（升序）。上海时区未收盘的今天会被剔除。"""
    today = china_now().date()
    start = (today - datetime.timedelta(days=n * 3 + 12)).strftime("%Y-%m-%d")
    dates = _ref_dates(start, today.strftime("%Y-%m-%d"))
    if dates and dates[-1] == china_today() and not is_a_share_closed():
        dates = dates[:-1]
    return dates[-n:]


def trade_dates_ending_at(end_date: str, n: int = 10) -> list[str]:
    """**以 end_date 为终点**向前取 n 个交易日（升序，含 end_date 本身若它是交易日）"""
    start = (
        datetime.datetime.strptime(end_date, "%Y-%m-%d") - datetime.timedelta(days=n * 3 + 16)
    ).strftime("%Y-%m-%d")
    dates = [d for d in _ref_dates(start, end_date) if d <= end_date]
    # 未收盘的今天不算「已定稿」，与 last_trade_dates 口径保持一致
    if dates and dates[-1] == china_today() and not is_a_share_closed():
        dates = dates[:-1]
    return dates[-n:]


_QUOTE_URL = "http://qt.gtimg.cn/q="
_F_QUOTE_TIME = 30      # 腾讯实时行情的时间戳字段，形如 20260724161450
_QUOTE_DAY_TTL = 120.0
_QUOTE_DAY_BOUNDARIES = ((9, 15), (9, 25), (9, 30), (11, 30), (13, 0), (14, 57), (15, 0), (15, 5))    # 开盘（集合竞价）/ 收盘定稿
_quote_day_cache: dict[str, object] = {}      # {"day": …, "until": 单调时钟}
_quote_day_lock = threading.Lock()


def _seconds_to_next_boundary() -> float:
    """距下一个交易状态边界还有几秒（跨天则算到明天那个）"""
    n = china_now()
    now_s = (n.hour * 3600 + n.minute * 60 + n.second) + n.microsecond / 1e6
    for h, m in _QUOTE_DAY_BOUNDARIES:
        b = float(h * 3600 + m * 60)
        if b > now_s:
            return b - now_s
    first = float(_QUOTE_DAY_BOUNDARIES[0][0] * 3600 + _QUOTE_DAY_BOUNDARIES[0][1] * 60)
    return 24 * 3600 - now_s + first


def quote_trade_day() -> Optional[str]:
    """参考股**实时行情**里的交易日（YYYY-MM-DD）。判不了返回 None"""
    import time as _time

    now = _time.monotonic()          # 单调时钟：不受系统改时间 / 夏令时影响
    until = _quote_day_cache.get("until")
    if isinstance(until, float) and now < until:
        return _quote_day_cache.get("day")  # type: ignore[return-value]

    with _quote_day_lock:            # 单飞：别让开盘前的慢请求覆盖开盘后的新结果
        now = _time.monotonic()
        until = _quote_day_cache.get("until")
        if isinstance(until, float) and now < until:
            return _quote_day_cache.get("day")  # type: ignore[return-value]

        deadline = now + min(_QUOTE_DAY_TTL, max(0.0, _seconds_to_next_boundary()))

        day = None
        try:
            import urllib.request

            raw = urllib.request.urlopen(_QUOTE_URL + _REF_STOCK, timeout=8).read().decode("gbk", "ignore")
            f = raw.split("~")
            ts = f[_F_QUOTE_TIME].strip() if len(f) > _F_QUOTE_TIME else ""
            if len(ts) >= 8 and ts[:8].isdigit():
                day = f"{ts[:4]}-{ts[4:6]}-{ts[6:8]}"
        except Exception:  # noqa: BLE001  判不了就判不了，交给调用方保守降级
            day = None
        if _time.monotonic() < deadline:
            _quote_day_cache.clear()
            _quote_day_cache.update({"day": day, "until": deadline})
        else:
            _quote_day_cache.clear()
            logger.warning("取行情交易日时跨过了状态边界，本次结果不入缓存")
        return day


def latest_session() -> Optional[str]:
    """最近一个已收盘交易日。三层判据缺一不可："""
    today = china_today()
    if not is_weekend(today) and is_a_share_closed() and quote_trade_day() == today:
        return today
    latest = last_trade_dates(1)
    return latest[-1] if latest else None


def is_settled(date: str) -> bool:
    """date 是否已经收盘，可以保存快照；不代表上游此后不会修订"""
    return date < china_today() or date == latest_session()


def is_latest_closed_session(date: str) -> bool:
    """date 是否就是最近一个已收盘交易日"""
    return date == latest_session()


def live_quotes_are_close_of(date: str) -> tuple[bool, str]:
    """现在去拉实时行情，拿到的值能不能当作 `date` 的**收盘**涨跌幅？

    ⚠️ 这个判据只回答「**实时行情**这条路通不通」。它为 False **不等于**
    那一天算不出来 —— 已收盘的场次走定稿记录（`data.fetch_prev_pool`）照样能算，
    那才是复盘类指标的首选路径。把它当成"整块不可用"的闸，
    会让历史场次永远看不到（复盘系统的基本功能就没了）。
    """
    if date != latest_session():
        return False, f"{date} 非最近已收盘交易日；实时行情只有当前值，不能冒充历史收盘"

    qd = quote_trade_day()
    if qd is None:
        return False, ("判不出实时行情属于哪个交易日（取数失败），"
                       "保守起见不拿它当收盘用")
    if qd != date:
        # 盘中问昨天，就会走到这里：行情已经跳到今天这一场了
        return False, (f"实时行情当前属于 {qd} 这一场，不能当作 {date} 的收盘表现"
                       f"（{date} 那一场的价已经过去了）"
                       "—— 这只说明**实时行情**这条路不通；已收盘场次改用定稿记录")
    if date == china_today() and not is_a_share_closed():
        # 同一场、但这场还没结束 → 手里是**今天盘中**的价
        return False, (f"当前是交易时段，实时行情是**今天盘中**的价，"
                       f"不能当作 {date} 的收盘表现 —— 今天这一场要等收盘才有定稿数据")
    return True, ""


def session_phase(now: datetime.datetime, quote_day: Optional[str]) -> dict:
    """沪深竞价、连续交易和休市分段；旧日期行情不能认作今日交易。"""
    today = now.strftime("%Y-%m-%d")
    hm = now.hour * 60 + now.minute
    if not quote_day:
        key, label = "unknown", "行情日期未确认"
    elif now.weekday() >= 5 or quote_day != today:
        key, label = "closed", f"尚无今日行情 · 显示 {quote_day} 数据"
    elif hm < 555:
        key, label = "closed", "盘前 · 尚未开始竞价"
    elif hm < 565:
        key, label = "auction", "集合竞价 · 试撮合报价，尚未成交"
    elif hm < 570:
        key, label = "wait", "竞价结束 · 等待连续交易"
    elif hm < 690:
        key, label = "open", "盘中 · 连续交易"
    elif hm < 780:
        key, label = "break", "午间休市 · 上午末笔行情"
    elif hm < 897:
        key, label = "open", "盘中 · 连续交易"
    elif hm < 900:
        key, label = "closing", "收盘集合竞价 · 试撮合报价"
    else:
        key, label = "closed", "已收盘 · 等待数据定稿" if hm < 905 else "已收盘"
    if key == "closed" and (quote_day != today or hm < 555):
        return {"phase_key": key, "phase": "盘前" if now.weekday() < 5 and hm < 555 else "尚无今日行情",
                "label": label, "poll": False}
    names = {"unknown": "未知", "closed": "已收盘", "auction": "集合竞价",
             "wait": "竞价结束", "open": "盘中", "break": "午间休市", "closing": "收盘竞价"}
    return {"phase_key": key, "phase": names[key], "label": label,
            "poll": key in {"auction", "wait", "open", "closing"}}
