"""隔夜外围：美股 / 港股指数 + 美股七姐妹。

为什么自己取而不用 `vr/` 的 `/api/global/indices`：
  · 那个接口只回 name/price/change_pct，**把行情时间丢了** —— 界面就无法说清
    「这批数是哪一场的」，盘前只能按本机今天贴日期，等于说谎。
  · 东财 push2 的价格是**缩放整数**，而且比例不统一（指数 ÷100、美股个股 ÷1000），
    读错一位就是十倍错。腾讯直接给明文小数，少一层出错空间。

⚠️ 腾讯给的行情时间是**各交易所本地时间**（美股 16:00 收盘 = 美东时间，
   港股 16:00 = 港时），不是北京时间。这里只取**日期**用于「哪一场」的标注，
   不做时区换算 —— 换算出来的「北京时间凌晨 4 点」对读者没有意义，
   而「美股 07-29 收盘」才是他习惯的说法。
"""

from __future__ import annotations

import urllib.request
from typing import Optional

_TENCENT = "https://qt.gtimg.cn/q="
_F_NAME, _F_PRICE, _F_TIME, _F_PCT = 1, 3, 30, 32

# 腾讯代码 → 展示名。名字自己给：腾讯返回的 "Meta Platforms, Inc." 太长，
# 而「谷歌-A」这类它给得挺好，统一在这里定，避免界面里再做字符串裁剪。
_INDICES = (
    ("usDJI", "道琼斯", "美股"),
    ("usINX", "标普500", "美股"),
    ("usIXIC", "纳斯达克", "美股"),
    ("hkHSI", "恒生指数", "港股"),
    ("hkHSTECH", "恒生科技", "港股"),
)

# 美股七姐妹（Magnificent Seven）
_MAG7 = (
    ("usAAPL", "苹果", "AAPL"),
    ("usMSFT", "微软", "MSFT"),
    ("usNVDA", "英伟达", "NVDA"),
    ("usGOOGL", "谷歌", "GOOGL"),
    ("usAMZN", "亚马逊", "AMZN"),
    ("usMETA", "Meta", "META"),
    ("usTSLA", "特斯拉", "TSLA"),
)


def _session_of(quote_time: str) -> Optional[str]:
    """行情时间 → 交易日 YYYY-MM-DD。

    美股给 `2026-07-29 16:00:01`、港股给 `2026/07/29 16:08:46` —— 分隔符不同，
    统一成横杠再取日期。取不到就返回 None，**不要拿今天顶替**。
    """
    head = (quote_time or "").strip().replace("/", "-").split(" ")[0]
    parts = head.split("-")
    if len(parts) != 3 or not all(p.isdigit() for p in parts):
        return None
    y, m, d = parts
    return f"{y}-{m.zfill(2)}-{d.zfill(2)}" if len(y) == 4 else None


def _fetch(symbols: list[str]) -> dict[str, list[str]]:
    """批量取腾讯行情，返回 {腾讯代码: 字段数组}。整批失败返回空 dict。"""
    if not symbols:
        return {}
    try:
        req = urllib.request.Request(_TENCENT + ",".join(symbols),
                                     headers={"User-Agent": "Mozilla/5.0"})
        raw = urllib.request.urlopen(req, timeout=12).read().decode("gbk", "ignore")
    except Exception:  # noqa: BLE001  取不到就整块标不可用，不给半份数据
        return {}
    out: dict[str, list[str]] = {}
    for line in raw.split(";"):
        if '"' not in line or "~" not in line:
            continue
        # 形如 v_usAAPL="...~苹果~338.19~..."
        key = line.split("=")[0].strip().split("_", 1)[-1]
        fields = line.split('"')[1].split("~")
        if len(fields) > _F_PCT:
            out[key] = fields
    return out


def _num(v: str) -> Optional[float]:
    try:
        return float(v)
    except (TypeError, ValueError):
        return None



def _market_label(market: str, session: Optional[str]) -> Optional[str]:
    """「美股 2026-07-29 收盘」/「港股 2026-07-30 盘前」这类可直接展示的一句话。

    判断依据是**北京时间的钟点 + 这批行情属于哪一场**：
      · 港股 09:30-16:00 交易（港时 = 北京时），09:00 起开盘前竞价；
      · 美股在北京时间的夜里交易（夏令时 21:30-04:00、冬令时 22:30-05:00）。

    🔴 光看钟点不够：周末、美股节假日、以及 21:00-21:30 这段还没开盘的时间里，
       钟点都落在"交易窗口"内，但行情其实是**上一场的收盘**，标成「盘中」就又在说谎
       （这个接口正是为了不让过期行情冒充实时才加的）。
       所以再加一条：**只有这批行情的场次就是"美股此刻正在进行的那一天"时才叫盘中。**
       周末 / 节假日 / 开盘前，行情停在上一场 → 两个日期不等 → 如实标「收盘」。
       这样不需要节假日日历。

    ⚠️ 夏/冬令时只按 21:00 / 05:00 粗略兜住 —— 有了上面那条日期比对兜底，
       这半小时的模糊只会让"刚开盘半小时"短暂标成收盘，不会把过期行情说成实时。
    """
    if not session:
        return None
    import datetime

    from .util import china_now, china_today

    now = china_now()
    hhmm = now.hour * 60 + now.minute
    if market == "美股":
        # 美东比北京晚 12-13 小时：北京 12:00 之后 = 美股同一日历日的早晨/白天；
        # 北京 12:00 之前 = 美股前一日历日的下午/夜里。
        us_today = (now.date() if now.hour >= 12
                    else now.date() - datetime.timedelta(days=1)).strftime("%Y-%m-%d")
        in_window = hhmm >= 21 * 60 or hhmm < 5 * 60
        trading = in_window and session == us_today
        return f"美股 {session} {'盘中' if trading else '收盘'}"
    # 港股：只有"这一场就是今天"时才可能还没收
    if session != china_today():
        return f"港股 {session} 收盘"
    if hhmm < 9 * 60 + 30:
        return f"港股 {session} 盘前"
    if hhmm < 16 * 60 + 10:
        return f"港股 {session} 盘中"
    return f"港股 {session} 收盘"


def overseas_snapshot() -> dict:
    """美港股指数 + 七姐妹，各自带上「属于哪一场」。"""
    raw = _fetch([s for s, *_ in _INDICES] + [s for s, *_ in _MAG7])
    if not raw:
        return {"available": False, "reason": "腾讯海外行情取数失败"}

    def row(symbol: str, name: str, extra: dict) -> Optional[dict]:
        f = raw.get(symbol)
        if not f:
            return None
        price, pct = _num(f[_F_PRICE]), _num(f[_F_PCT])
        if price is None or pct is None:
            return None
        return {"name": name, "price": round(price, 2), "change_pct": round(pct, 2),
                "session": _session_of(f[_F_TIME]), **extra}

    indices = [r for s, n, reg in _INDICES if (r := row(s, n, {"region": reg}))]
    mag7 = [r for s, n, tk in _MAG7 if (r := row(s, n, {"ticker": tk}))]

    def one_session(rows: list[dict], region: Optional[str] = None) -> Optional[str]:
        """这批里出现最多的那个交易日。同一市场理应一致，取众数可容忍个别异常。"""
        days = [r["session"] for r in rows
                if r.get("session") and (region is None or r.get("region") == region)]
        return max(set(days), key=days.count) if days else None

    us, hk = one_session(indices, "美股") or one_session(mag7), one_session(indices, "港股")
    return {
        "available": True,
        "indices": indices,
        "mag7": mag7,
        "us_session": us,
        "hk_session": hk,
        # 直接给可展示的一句话。**别让前端自己拼"XX 收盘"** —— 港股在北京时间白天
        # 是可能正在交易的，那时候标"收盘"就是错的（实测 09:16 打开标成
        # 「港股 2026-07-30 收盘」，而它正处在开盘前竞价）。
        "us_label": _market_label("美股", us),
        "hk_label": _market_label("港股", hk),
    }
