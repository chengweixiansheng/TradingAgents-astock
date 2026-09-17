"""Official MCP SDK, stdio only; the host pins the bundle and ledger paths."""
from __future__ import annotations

import json
import os
from pathlib import Path

from mcp.server.fastmcp import FastMCP

from .evidence import ToolSession


def main() -> None:
    run = Path(os.environ["ASTOCK_AGENT_RUN"])
    session = ToolSession(json.loads((run / "bundle.json").read_text(encoding="utf-8")), run / "tools.jsonl")
    mcp = FastMCP("astock_public_review")

    @mcp.tool()
    def list_evidence() -> dict:
        """List dates and evidence ids in the frozen public review scope. No new network data."""
        return session.list_evidence()

    @mcp.tool()
    def read_evidence(ids: list[str]) -> list[dict]:
        """Read up to sixteen existing evidence ids. Narrative is AI-generated, not a numeric fact."""
        return session.read_evidence(ids)

    @mcp.tool()
    def compare_metric(metric: str, first_date: str, last_date: str) -> dict:
        """Calculate later minus earlier for a registered market metric. Rates use percentage points.

        metric: limit_up_count, highest_board, promotion_1to2, money_effect_median,
        broken_rate, deep_loss_count, theme_concentration, market_limit_down.
        Missing values are errors, never zero. Return a citable calculation id.
        """
        return session.compare_metric(metric, first_date, last_date)

    @mcp.tool()
    def fetch_stock_prices(symbol: str, first_date: str, last_date: str) -> dict:
        """Fetch Tencent unadjusted daily closes, only if network is enabled for this conversation.
        symbol must be a catalog stock or explicitly selected six-digit code. Dates <= anchor,
        maximum ninety calendar days; last twenty valid sessions retained. Maximum four calls.
        No financial statements or news; preserve all gaps. Read returned ids for citations.
        """
        return session.fetch_stock_prices(symbol, first_date, last_date)

    @mcp.tool()
    def compare_stock_prices(first_id: str, last_id: str) -> dict:
        """Subtract earlier from later raw close for the same stock. Not an investment return."""
        return session.compare_stock_prices(first_id, last_id)

    @mcp.tool()
    def submit_answer(status: str, findings: list[dict], gaps: list[str]) -> dict:
        """Submit final answer: status complete/incomplete; findings [{text,citations}]; gaps [text].
        Text is qualitative only; numbers belong to evidence cards. If accepted=false,
        fix the reported problem and submit again in this turn. At most four submissions.
        Once accepted=true, finish the turn without further tool calls.
        """
        return session.submit_answer(status, findings, gaps)

    mcp.run(transport="stdio")


if __name__ == "__main__":
    main()
