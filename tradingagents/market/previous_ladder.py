"""A fixed previous-session limit-up cohort, joined to dated public quotes.

No fallback to today's winners or an older available pool: that would remove
failed continuations from the very cohort the user wants to monitor.
"""
from __future__ import annotations

import math
import re
from datetime import date, timedelta

from tradingagents.review import market_facts, trade_calendar


def load_cohort(quote_date: str | None) -> dict:
    result = {'available': False, 'quote_date': quote_date, 'sample_date': None, 'stocks': []}
    if not quote_date:
        return {**result, 'reason': '行情交易日尚未确认，无法确定昨日梯队'}
    try:
        end = (date.fromisoformat(quote_date) - timedelta(days=1)).isoformat()
        dates = trade_calendar.trade_dates_ending_at(end, 1)
        if not dates or dates[-1] > end:
            return {**result, 'reason': '前一交易日历不可用；未按工作日猜测'}
        result['sample_date'] = dates[-1]
        pool = market_facts.pools(dates[-1])
        if not isinstance(pool, dict) or not isinstance(pool.get('zt'), list):
            return {**result, 'reason': '昨日涨停池不可用；未改用其他日期的名单'}
        stocks = []
        seen = set()
        for row in pool['zt']:
            if not isinstance(row, dict):
                raise ValueError('invalid pool row')
            code, boards = row.get('code'), row.get('boards')
            if (not isinstance(code, str) or not re.fullmatch(r'\d{6}', code)
                    or isinstance(boards, bool) or not isinstance(boards, (int, float))
                    or not math.isfinite(boards) or boards < 1 or int(boards) != boards
                    or code in seen):
                raise ValueError('invalid cohort identity')
            seen.add(code)
            stocks.append({'code': code, 'name': str(row.get('name') or code),
                           'boards': int(boards), 'sector': str(row.get('sector') or '')})
        return {**result, 'available': True, 'stocks': sorted(stocks, key=lambda x: (-x['boards'], x['code']))}
    except Exception:
        return {**result, 'reason': '昨日梯队读取或校验失败，请稍后重试；未展示替代样本'}


def number(value):
    return value if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) else None


def render_cohort(cohort: dict, quotes: dict, *, phase: str | None = None) -> dict:
    rows = []
    day = (cohort.get('quote_date') or '').replace('-', '')
    for stock in cohort.get('stocks', []):
        q = quotes.get(stock['code']) or {}
        stamp = str(q.get('quote_time') or '')
        price = number(q.get('price'))
        valid = bool(day and re.fullmatch(r'\d{14}', stamp) and stamp[:8] == day and price is not None and price > 0)
        limit = number(q.get('zt_price'))
        high = number(q.get('high'))
        status = '行情待更新'
        if valid:
            if phase in {"auction", "closing"} or stamp[8:12] < "0925":
                status = '竞价试撮合'
            elif phase == "unknown":
                status = '交易状态未确认'
            elif limit is None or limit <= 0:
                status = '涨停价未覆盖'
            elif price >= limit - 1e-6:
                status = '收盘涨停' if phase == 'closed' else '封板中'
            elif high is not None and high >= limit - 1e-6:
                status = '触板回落'
            else:
                status = '未封板'
        rows.append({**stock, 'price': price if valid else None,
                     'pct': number(q.get('pct')) if valid else None,
                     'amount': number(q.get('amount')) if valid else None,
                     'quote_time': stamp or None, 'quote_ok': valid, 'status': status})
    return {**cohort, 'stocks': rows, 'covered': sum(r['quote_ok'] for r in rows)}
