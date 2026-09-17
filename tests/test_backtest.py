"""Backtest 模块单元测试。

覆盖：loader 代码规范化 / 市场检测 / 闸口验证 / 策略信号 / 指标计算。
不依赖网络（mock 取数），不跑完整回测引擎（那属于集成测试）。
"""

from __future__ import annotations

import pandas as pd
import pytest

from tradingagents.backtest.loader import (
    LoaderError,
    _a_share_exchange,
    _to_bs_code,
    bare,
    canonical_code,
    market_of,
)
from tradingagents.backtest.gate import Plan, Refusal, plan_backtest
from tradingagents.backtest.strategies import BuyAndHold, MaCross, RsiReversion
from tradingagents.backtest.metrics import calc_metrics
from tradingagents.backtest.models import TradeRecord


# ── canonical_code ──


class TestCanonicalCode:
    def test_six_digit_infers_exchange(self):
        assert canonical_code("600519") == "600519.SH"
        assert canonical_code("300750") == "300750.SZ"
        assert canonical_code("002475") == "002475.SZ"

    def test_already_canonical(self):
        assert canonical_code("600519.SH") == "600519.SH"
        assert canonical_code("300750.SZ") == "300750.SZ"

    def test_prefix_format(self):
        assert canonical_code("SH.600519") == "600519.SH"
        assert canonical_code("SZ.300750") == "300750.SZ"

    def test_us_stock(self):
        assert canonical_code("AAPL") == "AAPL"

    def test_hk_stock(self):
        assert canonical_code("00700.HK") == "00700.HK"

    def test_empty_raises(self):
        with pytest.raises(LoaderError, match="空的"):
            canonical_code("")

    def test_case_insensitive(self):
        assert canonical_code("sh.600519") == "600519.SH"


# ── _a_share_exchange ──


class TestAShareExchange:
    def test_shanghai_main(self):
        assert _a_share_exchange("600519") == "SH"
        assert _a_share_exchange("601398") == "SH"

    def test_shanghai_star(self):
        assert _a_share_exchange("688017") == "SH"

    def test_shenzhen_main(self):
        assert _a_share_exchange("000001") == "SZ"
        assert _a_share_exchange("002475") == "SZ"

    def test_chinext(self):
        assert _a_share_exchange("300750") == "SZ"
        assert _a_share_exchange("301001") == "SZ"

    def test_bse(self):
        assert _a_share_exchange("430047") == "BJ"
        assert _a_share_exchange("830799") == "BJ"

    def test_unknown_raises(self):
        with pytest.raises(LoaderError, match="认不出"):
            _a_share_exchange("999999")


# ── bare ──


def test_bare():
    assert bare("600519.SH") == "600519"
    assert bare("AAPL") == "AAPL"


# ── market_of ──


class TestMarketOf:
    def test_a_share(self):
        assert market_of("600519.SH") == "a_share"
        assert market_of("300750.SZ") == "a_share"

    def test_us(self):
        assert market_of("AAPL") == "us_equity"

    def test_hk(self):
        assert market_of("00700.HK") == "hk_equity"

    def test_unknown_raises(self):
        with pytest.raises(LoaderError, match="认不出"):
            market_of("XYZ123")


# ── _to_bs_code ──


def test_to_bs_code():
    assert _to_bs_code("600519.SH") == "sh.600519"
    assert _to_bs_code("300750.SZ") == "sz.300750"


# ── 策略信号 ──


def _make_price_df(prices: list[float], start: str = "2024-01-01") -> pd.DataFrame:
    """构造简单价格 DataFrame 用于策略测试。"""
    dates = pd.bdate_range(start, periods=len(prices))
    df = pd.DataFrame({
        "open": prices,
        "high": [p * 1.02 for p in prices],
        "low": [p * 0.98 for p in prices],
        "close": prices,
        "volume": [1_000_000] * len(prices),
    }, index=dates)
    df.index.name = "Date"
    return df


class TestMaCross:
    def test_fast_crosses_above_slow_generates_buy(self):
        # 构造：前20天低位，后20天高位 → MA20 上穿 MA60
        prices = [10.0] * 40 + [20.0] * 40
        df = _make_price_df(prices)
        strat = MaCross(fast=20, slow=60)
        signals = strat.generate({"TEST": df})
        assert "TEST" in signals
        s = signals["TEST"]
        # 应该有非零信号
        assert (s != 0).any()

    def test_fast_below_slow_clears_position(self):
        # 先持续上涨让快线>慢线，再快速下跌让快线<慢线
        prices = [10.0 + i * 0.5 for i in range(80)]  # 上涨
        prices += [50.0 - i * 1.0 for i in range(40)]  # 快速下跌
        df = _make_price_df(prices)
        strat = MaCross(fast=20, slow=60)
        signals = strat.generate({"TEST": df})
        s = signals["TEST"]
        # 上涨中期应该有持仓信号
        assert (s[60:80] > 0).any(), "上涨趋势中应有持仓信号"
        # 下跌后期信号应该归零
        assert (s[110:] == 0).all(), "下跌后信号应归零"

    def test_fast_must_be_less_than_slow(self):
        with pytest.raises(ValueError, match="fast.*slow"):
            MaCross(fast=60, slow=20)


class TestRsiReversion:
    def test_falling_price_generates_buy_signal(self):
        # 持续下跌 → RSI 应低于 buy_below → 买入信号
        prices = [100.0 - i * 0.5 for i in range(80)]
        df = _make_price_df(prices)
        strat = RsiReversion(window=14, buy_below=30, sell_above=70)
        signals = strat.generate({"TEST": df})
        s = signals["TEST"]
        assert (s > 0).any(), "持续下跌应产生买入信号"

    def test_rising_price_clears_position(self):
        # 先下跌让 RSI 进入超卖区买入，再持续上涨让 RSI 超过 sell_above 清仓
        prices = [100.0 - i * 1.0 for i in range(50)]  # 下跌
        prices += [50.0 + i * 1.0 for i in range(150)]  # 上涨
        df = _make_price_df(prices)
        strat = RsiReversion(window=14, buy_below=30, sell_above=70)
        signals = strat.generate({"TEST": df})
        s = signals["TEST"]
        # 应该有过持仓（超卖买入），然后信号归零（超买卖出）
        assert (s > 0).any(), "超卖时应有持仓信号"
        # 上涨后期信号应该归零
        assert (s[180:] == 0).any(), "RSI 超买后信号应归零"


class TestBuyAndHold:
    def test_always_buy(self):
        prices = [10.0] * 10
        df = _make_price_df(prices)
        strat = BuyAndHold()
        signals = strat.generate({"TEST": df})
        s = signals["TEST"]
        # 第一天买入，之后持有（信号为 0 或不重复买入）
        assert s.iloc[0] > 0


# ── 指标计算 ──


def _make_trade(pnl: float) -> TradeRecord:
    """构造简单 TradeRecord 用于测试。"""
    return TradeRecord(
        symbol="TEST", direction=1, entry_price=100.0, exit_price=100.0 + pnl / 100,
        entry_time=pd.Timestamp("2024-01-01"), exit_time=pd.Timestamp("2024-01-10"),
        size=100, leverage=1.0, pnl=pnl, pnl_pct=pnl / 10000,
        exit_reason="signal", holding_bars=5, commission=0, entry_margin=10000, exit_margin=10000,
    )


class TestCalcMetrics:
    def test_positive_return(self):
        equity = pd.Series([1_000_000, 1_050_000, 1_100_000, 1_080_000])
        trades = [_make_trade(50000), _make_trade(-20000)]
        m = calc_metrics(equity, trades, 1_000_000, 252)
        assert m["total_return"] > 0
        assert m["trade_count"] == 2

    def test_negative_return(self):
        equity = pd.Series([1_000_000, 950_000, 900_000])
        trades = [_make_trade(-50000), _make_trade(-50000)]
        m = calc_metrics(equity, trades, 1_000_000, 252)
        assert m["total_return"] < 0

    def test_zero_trades(self):
        equity = pd.Series([1_000_000, 1_000_000])
        m = calc_metrics(equity, [], 1_000_000, 252)
        assert m["trade_count"] == 0
        assert m["win_rate"] == 0.0


# ── 闸口验证 ──


class TestGate:
    def test_valid_plan(self):
        plan = plan_backtest(["600519.SH"], "2024-01-01", "2024-12-31",
                             style="swing", initial_cash=1_000_000)
        assert isinstance(plan, Plan)
        assert "600519.SH" in plan.codes

    def test_empty_codes_refusal(self):
        plan = plan_backtest([], "2024-01-01", "2024-12-31")
        assert isinstance(plan, Refusal)

    def test_invalid_date_range_refusal(self):
        plan = plan_backtest(["600519.SH"], "2024-12-31", "2024-01-01")
        assert isinstance(plan, Refusal)

    def test_etf_refusal(self):
        # 510300 是沪深300 ETF
        plan = plan_backtest(["510300.SH"], "2024-01-01", "2024-12-31")
        assert isinstance(plan, Refusal)