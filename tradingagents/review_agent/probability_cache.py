"""Single-flight public quote cache; stale data remains explicitly marked."""
import threading
import time
from pydantic import BaseModel, ConfigDict, Field, ValidationError
from .evidence import EvidenceError
from .public_worker import fetch_public
_lock = threading.Lock()
_value = None
_updated = 0.0


class ProbabilityItem(BaseModel):
    model_config = ConfigDict(extra='allow', strict=True)
    module: str
    venue: str
    title: str
    leg: str
    prob: float | None = Field(ge=0, le=1, allow_inf_nan=False)
    volume: float = Field(allow_inf_nan=False)
    volume_missing: bool
    close: str
    as_of: str
    ticker: str


class ProbabilitySnapshot(BaseModel):
    model_config = ConfigDict(extra='allow', strict=True)
    items: list[ProbabilityItem]
    as_of: str
    guard: str
    warnings: list[str]
    errors: list[str]
    sources_partial: list[str]


def get_probability(root):
    global _value, _updated
    with _lock:
        if _value is not None and time.monotonic() - _updated < 300:
            return {**_value, 'stale': False, 'cached': True, 'cache_age_seconds': int(time.monotonic() - _updated)}
        deadline = time.monotonic() + 150
        def check():
            remaining = deadline - time.monotonic()
            if remaining <= 0: raise EvidenceError('事件概率取数超时')
            return remaining
        directory = root / 'public-probability'
        directory.mkdir(mode=0o700, exist_ok=True)
        try:
            value = fetch_public('macro_probability', [], directory, check, timeout=145)
            try:
                value = ProbabilitySnapshot.model_validate(value).model_dump()
            except ValidationError:
                raise EvidenceError('事件概率数据格式异常，未替换已知快照') from None
            _value, _updated = value, time.monotonic()
            return {**value, 'stale': False, 'cached': False, 'cache_age_seconds': 0}
        except EvidenceError:
            if _value is not None:
                return {**_value, 'stale': True, 'cached': True, 'cache_age_seconds': int(time.monotonic() - _updated), 'refresh_error': '刷新失败，显示上次快照；请留意每项采集时间。'}
            raise
