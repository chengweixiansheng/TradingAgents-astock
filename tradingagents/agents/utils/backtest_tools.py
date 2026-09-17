"""回测工具 —— 供 Trader Agent 调用，验证历史规则表现。"""

from __future__ import annotations

import json
import tempfile
from pathlib import Path
from typing import Annotated

from langchain_core.tools import tool


@tool
def run_backtest(
    codes: Annotated[str, "Comma-separated A-stock codes, e.g. '600519,300750'"],
    start_date: Annotated[str, "Start date YYYY-MM-DD"],
    end_date: Annotated[str, "End date YYYY-MM-DD"],
    style: Annotated[str, "Backtest style: 'long' (monthly), 'swing' (weekly), 'intraday' (T+0)"] = "swing",
    strategy: Annotated[str, "Strategy: 'buy_and_hold', 'ma_cross', 'rsi_reversion'"] = "buy_and_hold",
) -> str:
    """Run a historical backtest on A-share stocks to validate a trading strategy.

    Returns: performance metrics (total return, annualized return, max drawdown,
    Sharpe ratio, win rate, etc.) and market-rule disclosures.

    Args:
        codes: Comma-separated stock codes (e.g. '600519' or '600519,300750')
        start_date: Backtest start date (YYYY-MM-DD)
        end_date: Backtest end date (YYYY-MM-DD)
        style: 'long' (monthly holding), 'swing' (weekly), 'intraday' (T+0, blocked for A-shares)
        strategy: 'buy_and_hold', 'ma_cross', 'rsi_reversion'
    """
    from tradingagents.backtest.gate import Plan, plan_backtest
    from tradingagents.backtest.run import BacktestNotValid, run
    from tradingagents.backtest.strategies import BUILTIN

    # Parse codes
    code_list = [c.strip() for c in codes.split(",") if c.strip()]
    if not code_list:
        return json.dumps({"ok": False, "error": "No stock codes provided"}, ensure_ascii=False)

    # Run gate check
    plan = plan_backtest(
        codes=code_list,
        start=start_date,
        end=end_date,
        style=style,
    )
    if not isinstance(plan, Plan):
        return json.dumps(
            {"ok": False, "refused": {"reason": plan.reason, "remedy": plan.remedy}},
            ensure_ascii=False,
        )

    # Resolve strategy
    if strategy not in BUILTIN:
        return json.dumps(
            {"ok": False, "error": f"Unknown strategy: {strategy}. Available: {', '.join(BUILTIN)}"},
            ensure_ascii=False,
        )
    strat = BUILTIN[strategy]()

    # Run backtest
    try:
        with tempfile.TemporaryDirectory(prefix="backtest-") as scratch:
            result = run(plan, strat, run_dir=Path(scratch))

        m = result.metrics
        output = {
            "ok": True,
            "strategy": result.strategy,
            "codes": plan.codes,
            "period": f"{plan.start} → {plan.end}",
            "style": plan.style.label,
            "market": plan.market.label,
            "metrics": {
                "total_return": f"{m.get('total_return', 0) * 100:.2f}%",
                "annual_return": f"{m.get('annual_return', 0) * 100:.2f}%",
                "max_drawdown": f"{m.get('max_drawdown', 0) * 100:.2f}%",
                "sharpe": round(m.get("sharpe") or 0, 2),
                "win_rate": f"{m.get('win_rate', 0) * 100:.1f}%",
                "trade_count": m.get("trade_count", 0),
            },
            "limits": plan.limits,
            "missing": result.missing,
        }
        if result.missing:
            output["warning"] = "Some symbols had no data and were excluded from backtest."

        return json.dumps(output, ensure_ascii=False, indent=2)

    except BacktestNotValid as exc:
        return json.dumps(
            {"ok": False, "refused": {"reason": str(exc), "remedy": "Adjust parameters and retry"}},
            ensure_ascii=False,
        )
    except Exception as exc:
        return json.dumps(
            {"ok": False, "error": f"Backtest failed: {type(exc).__name__}: {exc}"},
            ensure_ascii=False,
        )