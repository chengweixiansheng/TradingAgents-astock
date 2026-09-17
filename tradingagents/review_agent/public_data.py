"""Bounded Tencent historical daily closes, unadjusted; no arbitrary URLs."""
from __future__ import annotations

import hashlib
import json
import math
import re
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, datetime, timezone

from .evidence import EvidenceError, digest, display_number, valid_date


def stock_symbol(value: str) -> str:
    if not isinstance(value, str) or not re.fullmatch(r"(?:6\d{5}|[03]\d{5}|[48]\d{5}|92\d{4})", value):
        raise EvidenceError("请使用沪深北 A 股六位代码")
    return ("sh" if value.startswith("6") else "bj" if value.startswith(("4", "8", "92")) else "sz") + value


def query_args(symbol: str, first_date: str, last_date: str, anchor: str) -> dict:
    stock_symbol(symbol)
    first, last = date.fromisoformat(valid_date(first_date)), date.fromisoformat(valid_date(last_date))
    if first > last or (last - first).days > 90 or last_date > anchor:
        raise EvidenceError("行情日期须在所选复盘日及之前，单次跨度最多九十天")
    return {"symbol": symbol, "first_date": first_date, "last_date": last_date}


def source_url(args: dict) -> str:
    # Empty adjustment flag requests raw daily prices. Forward adjustment can
    # reflect corporate actions after a historical research anchor.
    param = f"{stock_symbol(args['symbol'])},day,{args['first_date']},{args['last_date']},90,"
    return "https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?" + urllib.parse.urlencode({"param": param})


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise EvidenceError("行情服务发生重定向，本轮未跟随")


def retrieve(args: dict) -> dict:
    receipt = {"args": args, "fetched_at": datetime.now(timezone.utc).isoformat()}
    try:
        request = urllib.request.Request(source_url(args), headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.build_opener(NoRedirect()).open(request, timeout=8) as response:
            raw = response.read(1_000_001)
        if len(raw) > 1_000_000:
            raise EvidenceError("行情响应超过读取上限")
        receipt["raw"] = raw.decode("utf-8")
    except (OSError, UnicodeError, EvidenceError):
        receipt["error"] = "公开行情获取失败或超时，未当作没有行情"
    return receipt


def normalize(receipt: dict, args: dict) -> tuple[list[dict], list[str]]:
    if receipt.get("args") != args:
        raise EvidenceError("行情快照与查询条件不一致")
    try:
        fetched = datetime.fromisoformat(receipt["fetched_at"])
        if fetched.tzinfo is None:
            raise ValueError()
    except (KeyError, TypeError, ValueError):
        raise EvidenceError("行情获取时间无效") from None
    if receipt.get("error"):
        return [], ["公开行情获取失败或超时，未当作没有行情"]
    try:
        raw = receipt["raw"]
        payload = json.loads(raw)
        if payload.get("code") != 0:
            raise ValueError()
        rows = payload["data"][stock_symbol(args["symbol"])]["day"]
        if not isinstance(rows, list) or len(rows) > 100:
            raise ValueError()
        records, seen = [], set()
        sha = hashlib.sha256(raw.encode()).hexdigest()
        for row in rows:
            if not isinstance(row, list) or len(row) < 5:
                raise ValueError()
            day = valid_date(row[0])
            if day in seen:
                raise ValueError()
            seen.add(day)
            values = [float(v) for v in row[1:5]]
            if any(isinstance(v, bool) for v in row[1:5]) or any(not math.isfinite(v) or v <= 0 for v in values):
                raise ValueError()
            opening, close, high, low = values
            if not low <= min(opening, close) <= max(opening, close) <= high:
                raise ValueError()
            if not args["first_date"] <= day <= args["last_date"]:
                continue
            record = {"kind": "stock_price", "metric": "stock_close", "symbol": args["symbol"],
                      "date": day, "value": close, "unit": "元", "display": display_number(close) + " 元",
                      "label": args["symbol"] + " 收盘", "available": True,
                      "source": "腾讯财经历史日线", "source_url": source_url(args), "source_sha256": sha,
                      "fetched_at": receipt["fetched_at"],
                      "note": "不复权历史收盘；跨除权日不能直接解释为投资收益。获取时间不等于资料期。"}
            record["id"] = "ev-" + digest(record)[:16]
            records.append(record)
        records.sort(key=lambda r: r["date"])
        records = records[-20:]
        return records, (["该范围未返回有效日线；可能非交易日或来源未覆盖，不能当作零"] if not records else
                         ["本次只保留范围内最后二十个有效交易日；未核验财报、公告和公司基本面"])
    except (KeyError, TypeError, ValueError, OverflowError):
        return [], ["公开行情返回结构或数值异常，未采用本次读数"]
