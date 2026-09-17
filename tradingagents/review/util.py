"""共用工具：日期严格校验 + 路径穿越防护（修  #1/#7）"""

from __future__ import annotations

import datetime
import json
import os
import re
import uuid
from pathlib import Path

try:
    from zoneinfo import ZoneInfo

    _CN_TZ = ZoneInfo("Asia/Shanghai")
except Exception:  # noqa: BLE001  拿不到时区库时退回本机时间（聊胜于无）
    _CN_TZ = None


_DEGRADE_PREFIX = "[⚠️"


def is_degraded_report(text: str) -> bool:
    """报告是否为**降级信封**（analysts/_fail 与 data/_degrade 产出的 `[ …]` 开头）"""
    return (text or "").lstrip().startswith(_DEGRADE_PREFIX)


def china_now() -> datetime.datetime:
    return datetime.datetime.now(_CN_TZ) if _CN_TZ else datetime.datetime.now()


def china_today() -> str:
    return china_now().strftime("%Y-%m-%d")


def is_a_share_closed() -> bool:
    """A 股是否已收盘（上海时间 15:05 后）。"""
    n = china_now()
    return (n.hour, n.minute) >= (15, 5)


_NOISE_BRACKET = re.compile(
    r"[（(【\[][^）)】\]]*[Mm][Ii][Mm][Oo][^）)】\]]*(?:身份|模型|作为|助手|AI)[^）)】\]]*[）)】\]]"
)
# 行首自我介绍句：「(作为)我是…MiMo…，」
_NOISE_SENTENCE = re.compile(r"^\s*(?:作为)?我是[^，。\n]*[Mm][Ii][Mm][Oo][^，。\n]*[，。]?\s*", re.M)


def strip_model_noise(text: str) -> str:
    if not text:
        return text
    text = _NOISE_BRACKET.sub("", text)
    text = _NOISE_SENTENCE.sub("", text)
    return text.strip()


def validate_trade_date(date: str) -> str:
    """严格解析 YYYY-MM-DD，拒绝非法/未来日期，返回规范化字符串。

    这是所有入口（API/CLI）的日期闸门：只有通过校验的规范日期才会进入
    文件名和数据查询，杜绝 `../../` 目录穿越。
    """
    if not isinstance(date, str):
        raise ValueError(f"日期需为字符串，得到 {type(date).__name__}")
    try:
        d = datetime.datetime.strptime(date.strip(), "%Y-%m-%d").date()
    except ValueError:
        raise ValueError(f"非法日期 {date!r}，需 YYYY-MM-DD 格式")
    if d.strftime("%Y-%m-%d") > china_today():
        raise ValueError(f"拒绝未来日期 {date}")
    return d.strftime("%Y-%m-%d")


def is_weekend(date: str) -> bool:
    """周六日 → True（非交易日的廉价判据；节假日靠空数据兜底）。"""
    return datetime.datetime.strptime(date, "%Y-%m-%d").date().weekday() >= 5


def is_today(date: str) -> bool:
    return date == china_today()  # 上海时区


def safe_join(base: str, name: str) -> str:
    """把 name 限制在 base 目录内，越界抛错（防目录穿越写文件）。"""
    base_p = Path(base).resolve()
    target = (base_p / name).resolve()
    if target != base_p and base_p not in target.parents:
        raise ValueError(f"路径越界，拒绝写出 base 目录之外：{name!r}")
    return str(target)


def atomic_write_json(path: str, payload: object) -> bool:
    """原子写 JSON 缓存。写成功返回 True，失败返回 False（缓存失败从不影响返回值）"""
    tmp = f"{path}.{uuid.uuid4().hex}.tmp"
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(payload, fh, ensure_ascii=False)
            fh.flush()
            os.fsync(fh.fileno())   # 断电/崩溃时别留下"存在但内容为空"的缓存
        os.replace(tmp, path)
        return True
    except Exception:  # noqa: BLE001
        try:
            os.unlink(tmp)          # 别把半截 tmp 留在缓存目录里
        except OSError:
            pass
        return False
