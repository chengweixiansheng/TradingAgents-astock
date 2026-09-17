"""Compatible presentation envelope for existing stock deep-dive archives."""
from ..util import china_now
from ..review_store import md_to_html as _md_to_html, strip_prefix as _strip_prefix
SCHEMA_VERSION = 1

def serialize(final: dict) -> dict:
    ds = final.get("debate_state", {}) or {}
    now = china_now().strftime("%Y-%m-%d %H:%M") + " CST"
    return {
        "schema_version": SCHEMA_VERSION,
        "run_type": "stock_deepdive",
        "code": final.get("code", ""),
        "name": final.get("name", ""),
        "trade_date": final.get("trade_date", ""),
        "generated_at": now,
        "verdict": final.get("verdict_struct"),
        "verdict_md": final.get("verdict", ""),
        "reports": {
            "theme": _md_to_html(final.get("theme_report", "")),
            "capital": _md_to_html(final.get("capital_report", "")),
            "technical": _md_to_html(final.get("technical_report", "")),
            "risk": _md_to_html(final.get("risk_report", "")),
        },
        "debate": {
            "join": _md_to_html(_strip_prefix(_strip_prefix(ds.get("join_history", ""), "正方:"), "参与派:")),
            "avoid": _md_to_html(_strip_prefix(_strip_prefix(ds.get("avoid_history", ""), "反方:"), "回避派:")),
        },
    }
