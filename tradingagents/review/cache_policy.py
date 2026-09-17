"""Refresh recent source observations without silently overwriting history."""
from datetime import datetime
from pathlib import Path
import hashlib
import json
import time
from .util import china_today, atomic_write_json


def fresh(path: str, date: str) -> bool:
    try:
        age_days = (datetime.fromisoformat(china_today()) - datetime.fromisoformat(date)).days
        age_seconds = time.time() - Path(path).stat().st_mtime
        if age_seconds < 0 or age_days < 0:
            return False
        # Recent sources can revise. Older unavailable source windows retain the
        # captured observation; this is not proof of source finality.
        return age_days > 20 or age_seconds < (300 if age_days == 0 else 86400)
    except (OSError, ValueError):
        return False


def write(path: str, payload: object) -> bool:
    p = Path(path)
    if p.exists():
        try:
            previous = p.read_bytes()
            old = json.loads(previous)
            if old != payload:
                revision = p.parent / '_revisions' / p.stem / (hashlib.sha256(previous).hexdigest() + '.json')
                if not revision.exists() and not atomic_write_json(str(revision), old):
                    return False  # Cannot preserve the old observation: do not replace it.
        except (OSError, ValueError):
            return False  # Damaged cache is retained for recovery, never overwritten.
    return atomic_write_json(path, payload)
