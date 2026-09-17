"""Single process snapshot of public Eastmoney pools; errors/empty pools are not cached."""
from collections import OrderedDict
from threading import RLock
from time import monotonic
_cache = OrderedDict()
_lock = RLock()

def frame(kind, date):
    import akshare as ak
    fn = getattr(ak, {"zt": "stock_zt_pool_em", "zb": "stock_zt_pool_zbgc_em", "dt": "stock_zt_pool_dtgc_em"}[kind])
    key = (kind, date.replace("-", ""), fn)
    with _lock:
        old = _cache.get(key)
        if old and monotonic() - old[0] < 300:
            return old[1].copy(deep=True)
    value = fn(date=key[1])
    with _lock:
        if value is not None and len(value):
            _cache[key] = (monotonic(), value.copy(deep=True))
            _cache.move_to_end(key)
            while len(_cache) > 64:
                _cache.popitem(last=False)
        return value
