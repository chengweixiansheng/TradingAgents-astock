"""回测取数层 —— 接入 TradingAgents-astock 的数据源。

引擎与数据之间只有一条缝：``loader.fetch()`` 返回 ``{代码: OHLCV DataFrame}``。

A 股走 ``get_stock_data()``（mootdx TCP → 新浪 HTTP 降级链），
US/HK 走 yfinance。
与原版 vibe-astock 的区别：不走 subprocess / baostock，直接调本项目的数据函数。

🔴 **只做日线**。要 5 分钟线就明说取不到，绝不悄悄拿日线顶替。
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import date, datetime
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional

import pandas as pd


# ── 延迟导入 ──

_bs = None
_sina_kline = None
_yf = None


def _ensure_imports():
    """延迟导入，避免循环依赖和重模块开销。"""
    global _bs, _sina_kline, _yf
    if _bs is None:
        import baostock as _b
        _bs = _b
    if _sina_kline is None:
        from tradingagents.dataflows.a_stock import _sina_kline_fallback as _sk
        _sina_kline = _sk
    if _yf is None:
        import yfinance as _yf_mod
        _yf = _yf_mod


def _to_bs_code(code: str) -> str:
    """600519.SH → sh.600519（baostock 格式）。"""
    six, ex = code.split(".")
    return f"{ex.lower()}.{six}"


# ── 市场检测 ──

_A_SUFFIX_RE = re.compile(r"^\d{6}\.(SZ|SH|BJ)$", re.I)
_HK_SUFFIX_RE = re.compile(r"^\d{3,5}\.HK$", re.I)
_US_ALPHA_RE = re.compile(r"^[A-Z]{1,5}$")


class LoaderError(RuntimeError):
    """取数在**能不能开始回测**这一层就失败了。"""


def price_basis(market: str) -> str:
    """数据来源说明，随回测结果一起呈现。"""
    if market == "a_share":
        return (
            "A 股取 baostock 前复权日线（adjustflag=2），与 vibe-astock 同源；"
            "baostock 不可用时降级到新浪财经 HTTP（未复权）。"
            "引擎不单独记现金分红、再投资或公司行动现金流。"
            "历史序列按本次取数版本重建，不同日期重跑可变。"
        )
    return (
        "港美股取 yfinance 日线（Yahoo Finance）。"
        "引擎不单独记现金分红、再投资或公司行动现金流。"
        "历史序列按本次取数版本重建，不同日期重跑可变。"
    )


@dataclass
class SymbolProvenance:
    """一只票的数据来自哪儿 —— 回测结论要能顺着这条链查回去。"""
    code: str
    market: str
    endpoint: str
    raw_refs: List[str] = field(default_factory=list)
    rows: int = 0
    first_bar: Optional[str] = None
    last_bar: Optional[str] = None
    halted_bars: int = 0
    note: str = ""
    price_basis: str = ""


def canonical_code(code: str) -> str:
    """把代码规整成**市场判得出来**的写法。"""
    c = str(code).strip().upper()
    if not c:
        raise LoaderError("代码是空的")
    m = re.fullmatch(r"(SZ|SH|BJ)\.(\d{6})", c)
    if m:
        return f"{m.group(2)}.{m.group(1)}"
    if re.fullmatch(r"\d{6}", c):
        return f"{c}.{_a_share_exchange(c)}"
    return c


def _a_share_exchange(six: str) -> str:
    """六位代码 → 交易所后缀。认不出就报错。"""
    _A_PREFIX = (
        ("688", "SH"), ("689", "SH"),
        ("6", "SH"),
        ("300", "SZ"), ("301", "SZ"), ("302", "SZ"),
        ("000", "SZ"), ("001", "SZ"),
        ("002", "SZ"), ("003", "SZ"),
        ("43", "BJ"), ("83", "BJ"), ("87", "BJ"),
        ("88", "BJ"), ("92", "BJ"),
    )
    for prefix, ex in _A_PREFIX:
        if six.startswith(prefix):
            return ex
    raise LoaderError(f"认不出六位代码 {six} 属于哪个交易所，请写全后缀，如 {six}.SH / {six}.SZ")


def bare(code: str) -> str:
    """去掉交易所后缀。"""
    return code.split(".")[0]


def market_of(code: str) -> str:
    """判市场。认不出就报错。"""
    c = canonical_code(code)
    if _A_SUFFIX_RE.fullmatch(c):
        return "a_share"
    if _HK_SUFFIX_RE.fullmatch(c):
        return "hk_equity"
    if _US_ALPHA_RE.fullmatch(c):
        return "us_equity"
    raise LoaderError(
        f"认不出 {code!r} 是哪个市场的代码。"
        "这一版认这三种写法：A股 600519.SH / 美股 AAPL / 港股 00700.HK"
    )


def assert_a_share_stock(code: str) -> None:
    """A 股这一版只回测个股。ETF/指数/可转债明确拒掉。"""
    six = bare(code)
    _ETF_INDEX_BOND = (
        ("50", "SH"), ("51", "SH"), ("52", "SH"),
        ("53", "SH"), ("56", "SH"), ("58", "SH"),
        ("110", "SH"), ("111", "SH"), ("113", "SH"),
        ("12", "SZ"), ("15", "SZ"), ("16", "SZ"), ("18", "SZ"),
    )
    for prefix, _ex in _ETF_INDEX_BOND:
        if six.startswith(prefix):
            raise LoaderError(
                f"{code} 不是个股（ETF/指数/可转债号段）—— "
                "这一版的日线取数只覆盖个股"
            )


# ── A 股取数（baostock 前复权优先，新浪 HTTP 降级）──

def _fetch_a_share(code: str, start_date: str, end_date: str) -> tuple[pd.DataFrame, int, str]:
    """取 A 股日线：baostock 前复权优先，登录失败或取不到就降级到新浪 HTTP。

    返回: (DataFrame, 停牌bar数, 数据源描述)
    """
    _ensure_imports()

    # ── 优先 baostock 前复权日线 ──
    try:
        bs_code = _to_bs_code(code)
        lg = _bs.login()
        if lg.error_code == "0":
            try:
                rs = _bs.query_history_k_data_plus(
                    bs_code,
                    "date,code,open,high,low,close,volume,tradestatus",
                    start_date=start_date,
                    end_date=end_date,
                    frequency="d",
                    adjustflag="2",  # 前复权
                )
                if rs.error_code == "0":
                    rows = []
                    while rs.next():
                        rows.append(dict(zip(rs.fields, rs.get_row_data())))
                    if rows:
                        df = pd.DataFrame(rows)
                        # 转数值列
                        for col in ["open", "high", "low", "close", "volume"]:
                            df[col] = pd.to_numeric(df[col], errors="coerce")
                        # 停牌标记
                        halted = 0
                        if "tradestatus" in df.columns:
                            mask = df["tradestatus"].astype(str) == "1"
                            halted = int((~mask).sum())
                            df = df[mask]
                        df = df.drop(columns=["code", "tradestatus"], errors="ignore")
                        df["date"] = pd.to_datetime(df["date"])
                        df = df.set_index("date").sort_index()
                        # 添加 preclose
                        df["pre_close"] = df["close"].shift(1)
                        # 确保 datetime64[ns]
                        if df.index.dtype != "datetime64[ns]":
                            df.index = df.index.astype("datetime64[ns]")
                        if not df.empty:
                            return df, halted, "baostock (前复权)"
            finally:
                _bs.logout()
    except Exception:
        pass  # 降级到新浪

    # ── 降级：新浪 HTTP ──
    six = bare(code)
    df = _sina_kline(six, start_date, end_date)

    if df.empty:
        raise LoaderError(f"baostock 和新浪 HTTP 取 {code} 均返回空数据")

    # _sina_kline_fallback 返回的列：Date, Open, High, Low, Close, Volume
    df = df.set_index("Date").sort_index()

    # 统一列名为小写（引擎期望 open/high/low/close）
    df = df.rename(columns={
        "Open": "open", "High": "high", "Low": "low",
        "Close": "close", "Volume": "volume",
    })

    # 过滤无效数据
    before = len(df)
    df = df.dropna(subset=["open", "high", "low", "close"])
    df = df[(df[["open", "high", "low", "close"]] > 0).all(axis=1)]
    halted = before - len(df)

    # 添加 preclose 列（前一日收盘价）
    df["pre_close"] = df["close"].shift(1)

    # 确保索引是 datetime64[ns]
    if df.index.dtype != "datetime64[ns]":
        df.index = df.index.astype("datetime64[ns]")

    return df, halted, "sina HTTP (fallback)"


# ── US/HK 取数 ──

def _fetch_yfinance(code: str, start_date: str, end_date: str) -> tuple[pd.DataFrame, int, str]:
    """从 yfinance 取 US/HK 日线。"""
    _ensure_imports()

    symbol = code if code.endswith(".HK") else bare(code)
    ticker = _yf.Ticker(symbol.upper())

    try:
        data = ticker.history(start=start_date, end=end_date)
    except Exception as exc:
        raise LoaderError(f"yfinance 取 {symbol} 失败：{exc}") from exc

    if data.empty:
        return pd.DataFrame(), 0, "yfinance"

    # 去掉时区
    if data.index.tz is not None:
        data.index = data.index.tz_localize(None)

    # 统一列名
    df = data.rename(columns={
        "Open": "open", "High": "high", "Low": "low",
        "Close": "close", "Volume": "volume",
    })

    # 添加 preclose
    df["pre_close"] = df["close"].shift(1)

    # 过滤无效数据
    before = len(df)
    df = df.dropna(subset=["open", "high", "low", "close"])
    df = df[(df[["open", "high", "low", "close"]] > 0).all(axis=1)]

    # 确保索引是 datetime64[ns]
    if not isinstance(df.index, pd.DatetimeIndex):
        df.index = pd.to_datetime(df.index)
    if df.index.dtype != "datetime64[ns]":
        df.index = df.index.astype("datetime64[ns]")

    return df, before - len(df), "yfinance"


# ── Loader 主类 ──

SUPPORTED_INTERVALS = ("1D", "1d", "D", "day", "daily")


class AStockLoader:
    """回测引擎的数据源 —— 接入 TradingAgents-astock 的数据层。

    引擎只调 ``fetch()``。
    """

    name = "tradingagents"

    def __init__(self, out_dir: Optional[Path] = None) -> None:
        self.out_dir = Path(out_dir) if out_dir else Path("/tmp/backtest-data")
        self.out_dir.mkdir(parents=True, exist_ok=True)
        self.provenance: Dict[str, SymbolProvenance] = {}
        self.failures: Dict[str, str] = {}

    def fetch(self, codes: Iterable[str], start_date: str, end_date: str,
              fields: Optional[Any] = None, interval: str = "1D") -> Dict[str, pd.DataFrame]:
        """引擎调的就是这一个。"""
        if interval not in SUPPORTED_INTERVALS:
            raise LoaderError(f"这一版只做日线，取不到 {interval!r} 的数据。")
        out: Dict[str, pd.DataFrame] = {}
        for raw_code in codes:
            code = canonical_code(raw_code)
            try:
                df, prov = self._fetch_one(code, start_date, end_date)
            except LoaderError as exc:
                self.failures[code] = str(exc)
                self.provenance.pop(code, None)
                continue
            except Exception as exc:
                self.failures[code] = f"{type(exc).__name__}: {exc}"
                self.provenance.pop(code, None)
                continue
            if df.empty:
                self.failures[code] = "区间内一根 bar 都没有"
                self.provenance.pop(code, None)
                continue
            out[code] = df
            self.provenance[code] = prov
            self.failures.pop(code, None)
        return out

    def _fetch_one(self, code: str, start_date: str, end_date: str):
        mkt = market_of(code)

        if mkt == "a_share":
            assert_a_share_stock(code)
            if code.endswith(".BJ") and date.fromisoformat(start_date) < date(2021, 11, 15):
                raise LoaderError("北交所仅支持 2021-11-15 起的区间")
            df, dropped, source = _fetch_a_share(code, start_date, end_date)
            endpoint = source
        elif mkt in ("us_equity", "hk_equity"):
            df, dropped, source = _fetch_yfinance(code, start_date, end_date)
            endpoint = source
        else:
            raise LoaderError(f"不支持的市场：{mkt}")

        prov = SymbolProvenance(
            code=code, market=mkt, endpoint=endpoint,
            rows=len(df),
            first_bar=str(df.index[0].date()) if len(df) else None,
            last_bar=str(df.index[-1].date()) if len(df) else None,
            halted_bars=dropped,
            note=("停牌/无成交 %d 根已剔除" % dropped) if dropped else "",
            price_basis=price_basis(mkt),
        )
        return df, prov