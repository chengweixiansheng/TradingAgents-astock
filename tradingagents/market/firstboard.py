"""首板分析数据层 —— 今日首板涨停股（连板数=1）+ 涨停原因题材串。

短线投资实例专属模块（不回推开源仓库）。
- 首板名单：东财涨停池（astock.em_zt_topic_pool，免费无 key）。
- 涨停原因：同花顺问财 query2data「今日涨停的股票 涨停原因」，需要环境变量
  IWENCAI_API_KEY（不入库）；拿不到时优雅降级为空串，页面照常显示其余字段。
"""

from __future__ import annotations

import os
import time
from datetime import datetime, timedelta

from tradingagents.market import astock
from tradingagents.market.market import BEIJING, _num

_CACHE: dict = {}
_TTL = 600  # 10 分钟；涨停原因盘中变化不快


def _clean_reason(text: str, max_tags: int = 4, max_len: int = 40) -> str:
    """题材串清洗：统一分隔符、限标签数与总长（问财多用 '+' 分隔）。"""
    text = text.replace("，", "+").replace(",", "+").strip()
    tags = [t.strip() for t in text.split("+") if t.strip()]
    out = "+".join(tags[:max_tags])
    return out[:max_len]


def _fetch_reasons(date: str) -> tuple[dict, str | None]:
    """问财拉**指定交易日**的涨停原因，返回 ({6位代码: 题材串}, 错误说明或 None)。

    ⚠️ 查询必须带上日期。写成"今日涨停的股票"有两个问题：
    ① 涨停池会往前回退到最近有数据的交易日（周末、节假日、当天接口短暂失败），
       这时"今日"取回来的原因和池子不是同一天，拼在一起看着完全正常；
    ② 实测收盘当天"今日"这个词本身就常常返回 0 行，而带日期的查询正常有数据 ——
       写死"今日"会让题材串整体为空。
    返回的列名形如 `涨停原因[20260828]`，下面按子串匹配，不要改成精确等于。
    """
    if not os.environ.get("IWENCAI_API_KEY"):
        from tradingagents.review.fetchers import fetch_zt_reasons
        return fetch_zt_reasons(date)
    try:
        from iwencai_client import IwencaiClient

        client = IwencaiClient()
    except Exception as e:  # noqa: BLE001
        return {}, f"问财客户端初始化失败：{type(e).__name__}"

    reasons: dict[str, str] = {}
    try:
        for page in range(1, 4):  # 单页 50，涨停一般 1~3 页
            df = client.query(f"{date}涨停的股票 涨停原因", page=page, limit=50)
            if df is None or len(df) == 0:
                break
            code_cols = [c for c in df.columns if "代码" in c]
            reason_cols = [c for c in df.columns if "涨停原因" in c]
            if not code_cols or not reason_cols:
                return reasons, "问财返回缺少涨停原因列"
            cc, rc = code_cols[0], reason_cols[0]
            for _, row in df.iterrows():
                code6 = str(row[cc])[:6]
                reason = str(row[rc]).strip()
                if reason and reason.lower() != "nan" and code6 not in reasons:
                    reasons[code6] = _clean_reason(reason)
            if len(df) < 50:
                break
    except Exception as e:  # noqa: BLE001
        return reasons, f"问财查询异常：{type(e).__name__}"
    return reasons, None


_REASONS_CACHE: dict = {}


def get_reasons(date: str) -> tuple[dict, str | None]:
    """当日全部涨停股的涨停原因（带缓存，首板页与每日复盘连板表共用）。"""
    hit = _REASONS_CACHE.get(date)
    if hit and time.time() - hit[0] < _TTL:
        return hit[1], hit[2]
    reasons, err = _fetch_reasons(date)
    if reasons:
        _REASONS_CACHE[date] = (time.time(), reasons, err)
    return reasons, err


def _hhmm(v) -> str:
    """池内时间字段（HHMMSS 整数）→ 'HH:MM'。"""
    s = str(_num(v)).zfill(6)
    return f"{s[:2]}:{s[2:4]}" if len(s) == 6 else ""


def _first_board() -> dict:
    today = datetime.now(BEIJING).date()
    resolved, zt = "", []
    for back in range(8):
        d = (today - timedelta(days=back)).strftime("%Y%m%d")
        zt = astock.em_zt_topic_pool("getTopicZTPool", d, "fbt:asc")
        if zt:
            resolved = d
            break
    if not resolved:
        return {}

    reasons, reason_note = get_reasons(resolved)

    stocks = [
        {
            "code": str(p.get("c", "")),
            "name": p.get("n", ""),
            "price": round((astock._numf(p.get("p")) or 0) / 1000, 2),
            "pct": round(astock._numf(p.get("zdp")) or 0, 2),
            "amount": astock._numf(p.get("amount")),
            "float_cap": astock._numf(p.get("ltsz")),
            "industry": p.get("hybk", ""),
            "seal_time": _hhmm(p.get("fbt")),
            "break_count": _num(p.get("zbc")),
            "reason": reasons.get(str(p.get("c", "")), ""),
        }
        for p in zt
        if (_num(p.get("lbc")) or 1) == 1
    ]  # 池接口 sort=fbt:asc，天然按首封时间升序（早封在前）

    return {
        "date": resolved,
        "total_zt": len(zt),
        "first_count": len(stocks),
        "reason_note": reason_note,
        "stocks": stocks,
    }


def get_first_board() -> dict:
    """首板列表（TTL 缓存；空结果不缓存，下次直接重试）。"""
    now = time.time()
    hit = _CACHE.get("first_board")
    if hit and now - hit[0] < _TTL:
        return hit[1]
    val = _first_board()
    if val:
        _CACHE["first_board"] = (now, val)
    return val
