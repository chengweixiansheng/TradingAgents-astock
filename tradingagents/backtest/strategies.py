"""内置策略 —— 开箱能跑的几个，同时也是"策略长什么样"的模板。

策略只有一条契约::

    generate(data_map: {代码: OHLCV DataFrame}) -> {代码: pd.Series}

返回的 Series 是**目标仓位权重**，取值 -1 ~ 1（1 = 满仓做多，0 = 空仓，-1 = 满仓做空）。
引擎会自己做三件事，策略里**不要重复做**：

1. **整体后移一根** —— 今天收盘算出来的信号，明天开盘才成交。所以策略里可以放心用
   当天的 close，不会变成未来函数。
2. **归一化** —— 各票权重绝对值之和超过 1 时按比例缩回，不会超额加杠杆。
3. **市场规则** —— 涨跌停封死、T+1、整手、做空限制，由引擎按市场拒单。

🔴 策略里**不许出现"未来"的数据**：`shift(-1)`、`iloc[-1]` 当成每天都知道的常数、
   用整段序列算出来的分位数再回头用……这类写法回测会非常好看，实盘一分钱赚不到。
"""

from __future__ import annotations

from typing import Callable, Dict

import pandas as pd


class BuyAndHold:
    """一直满仓拿着 —— 任何策略的及格线：跑不赢它就没有意义。"""

    name = "买入持有"

    def generate(self, data_map: Dict[str, pd.DataFrame]) -> Dict[str, pd.Series]:
        n = len(data_map) or 1
        return {c: pd.Series(1.0 / n, index=df.index) for c, df in data_map.items()}


class MaCross:
    """均线交叉：快线在慢线上方满仓，下方空仓。"""

    def __init__(self, fast: int = 20, slow: int = 60) -> None:
        if not (isinstance(fast, int) and isinstance(slow, int)) or fast < 1 or slow < 1:
            raise ValueError(f"均线窗口要是正整数，收到 fast={fast!r} slow={slow!r}")
        if fast >= slow:
            raise ValueError(f"快线要短于慢线，收到 fast={fast} slow={slow}")
        self.fast, self.slow = fast, slow
        self.name = f"均线交叉 MA{fast}/MA{slow}"

    def generate(self, data_map: Dict[str, pd.DataFrame]) -> Dict[str, pd.Series]:
        n = len(data_map) or 1
        out = {}
        for code, df in data_map.items():
            c = df["close"]
            # min_periods 用满窗口：不足窗口时是 NaN，引擎会当 0（空仓）。
            # 若用 min_periods=1，头几天会拿 3 天均线冒充 60 天均线，
            # 那是**用一个不成立的指标开仓**，而回测里看不出来。
            fast = c.rolling(self.fast, min_periods=self.fast).mean()
            slow = c.rolling(self.slow, min_periods=self.slow).mean()
            out[code] = (fast > slow).astype(float) / n
        return out


class RsiReversion:
    """RSI 均值回归：超卖买入、超买清仓（短线口径的常见形态）。"""

    def __init__(self, window: int = 14, buy_below: float = 30.0, sell_above: float = 70.0) -> None:
        if not isinstance(window, int) or window < 2:
            raise ValueError(f"RSI 窗口要是 ≥2 的整数，收到 {window!r}")
        # 阈值反了 / 超界不会报错，只会静默生成一个「永不进场」或「永不退出」的策略 ——
        # 回测跑完给出零成交或全程满仓的结果，看不出是参数配错了
        if not (0 <= buy_below < sell_above <= 100):
            raise ValueError(
                f"RSI 阈值要满足 0 ≤ 买入线 < 卖出线 ≤ 100，收到 {buy_below!r} / {sell_above!r}"
            )
        self.window, self.buy_below, self.sell_above = window, float(buy_below), float(sell_above)
        self.name = f"RSI{window} 均值回归（<{buy_below:g} 买 / >{sell_above:g} 清）"

    def generate(self, data_map: Dict[str, pd.DataFrame]) -> Dict[str, pd.Series]:
        n = len(data_map) or 1
        out = {}
        for code, df in data_map.items():
            delta = df["close"].diff()
            gain = delta.clip(lower=0).rolling(self.window, min_periods=self.window).mean()
            loss = (-delta.clip(upper=0)).rolling(self.window, min_periods=self.window).mean()
            # 全是上涨时 loss=0 → rs 无穷 → rsi=100。直接相除会得到 inf/NaN，
            # 而 NaN 会被当成 0（空仓）—— 那等于"单边上涨时反而不持仓"，方向正好反了。
            rs = gain / loss.replace(0.0, pd.NA)
            rsi = 100 - 100 / (1 + rs)
            rsi = rsi.where(loss != 0, 100.0).where(gain.notna())
            pos = pd.Series(0.0, index=df.index)
            pos[rsi < self.buy_below] = 1.0 / n
            # 中间地带保持上一状态：不写的话每天都会在满仓与空仓之间跳，换手被费用吃光
            pos = pos.where((rsi < self.buy_below) | (rsi > self.sell_above)).ffill().fillna(0.0)
            out[code] = pos
        return out


BUILTIN: Dict[str, Callable[..., object]] = {
    "buy_and_hold": BuyAndHold,
    "ma_cross": MaCross,
    "rsi_reversion": RsiReversion,
}
