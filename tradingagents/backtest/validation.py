"""Validation utilities for backtest outputs.

Minimal implementation — the full validation module from vibe-astock is not
needed for the initial integration. Only ``_json_safe`` is used by risk_xray
and rebalance_notes.
"""

from __future__ import annotations

import math
from typing import Any


def _json_safe(value: Any) -> Any:
    """Recursively sanitize a value for strict JSON serialization.

    NaN/Inf → None. Passes through lists, dicts, and scalars unchanged.
    """
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if isinstance(value, dict):
        return {str(k): _json_safe(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_json_safe(v) for v in value]
    return value


def run_validation(config, equity_series, trades, initial_cash, bars_per_year):
    """Stub — full validation not yet integrated."""
    return {}


def write_validation_json(path, results):
    """Stub — full validation not yet integrated."""
    pass