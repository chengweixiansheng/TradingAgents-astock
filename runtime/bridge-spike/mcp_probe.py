"""Offline spike: synthetic reports only, no model or user state access."""
import asyncio
import json
import os
from pathlib import Path
import sys
import tempfile

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client
from review_agent.evidence import build_bundle


async def main():
    with tempfile.TemporaryDirectory(prefix="astock-bridge-中文 ") as temp:
        root = Path(temp)
        for day, count in [("2026-09-01", 30), ("2026-09-02", 45)]:
            (root / f"{day}.json").write_text(json.dumps({
                "target_date": day, "focus_md": "合成公开材料",
                "emotion_metrics": {"promotion": {"available": True, "limit_up_count": count}},
                "journal": "PRIVATE_CANARY", "api_key": "SECRET_CANARY",
            }))
        bundle = build_bundle(root, "2026-09-02")
        assert "CANARY" not in json.dumps(bundle)
        (root / "bundle.json").write_text(json.dumps(bundle))
        env = {key: os.environ[key] for key in ("PATH", "LANG", "PYTHONPATH") if key in os.environ}
        env["ASTOCK_AGENT_RUN"] = str(root)
        params = StdioServerParameters(command=sys.executable, args=["-m", "review_agent.mcp_server"], env=env)
        async with stdio_client(params) as streams:
            async with ClientSession(*streams) as client:
                await client.initialize()
                names = {tool.name for tool in (await client.list_tools()).tools}
                assert names == {"list_evidence", "read_evidence", "compare_metric", "fetch_stock_prices", "compare_stock_prices", "submit_answer"}
                async def call(name, args):
                    result = await client.call_tool(name, args)
                    assert not result.isError, result
                    return json.loads(result.content[0].text)
                rejected = await call("submit_answer", {"status": "complete", "findings": [{"text": "涨停家数增加。", "citations": ["made-up"]}], "gaps": []})
                assert rejected["accepted"] is False
                calc = await call("compare_metric", {"metric": "limit_up_count", "first_date": "2026-09-01", "last_date": "2026-09-02"})
                assert calc["value"] == 15
                accepted = await call("submit_answer", {"status": "complete", "findings": [{"text": "涨停家数增加。", "citations": [calc["id"]]}], "gaps": []})
                assert accepted["accepted"] is True
        print(json.dumps({"scope": "synthetic MCP transport, not a live model", "tools": sorted(names), "invalid_citation_rejected": True, "comparison": 15, "valid_submission": True}))


if __name__ == "__main__":
    asyncio.run(main())
