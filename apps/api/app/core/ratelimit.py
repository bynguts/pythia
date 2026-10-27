"""In-process sliding-window counters: the login throttle and the assistant quota.

One uvicorn worker only (like the token registry in app.core.auth): counts live in
memory and reset on restart. Memory is bounded twice: each key keeps at most
`limit` timestamps, and past `max_keys` the least recently used key is dropped.
"""

from __future__ import annotations

import math
import threading
import time
from collections import OrderedDict, deque


class SlidingWindowLimiter:
    def __init__(self, limit: int, window_seconds: float, max_keys: int = 10_000) -> None:
        self.limit = limit
        self.window_seconds = window_seconds
        self.max_keys = max_keys
        self._hits: OrderedDict[str, deque[float]] = OrderedDict()
        self._lock = threading.Lock()

    def _live(self, key: str, now: float) -> deque[float] | None:
        hits = self._hits.get(key)
        if hits is None:
            return None
        while hits and now - hits[0] >= self.window_seconds:
            hits.popleft()
        if not hits:
            del self._hits[key]
            return None
        return hits

    def retry_after(self, key: str) -> int:
        """Seconds until `key` may try again; 0 when it is under the limit."""
        now = time.monotonic()
        with self._lock:
            hits = self._live(key, now)
            if hits is None or len(hits) < self.limit:
                return 0
            return max(1, math.ceil(hits[0] + self.window_seconds - now))

    def hit(self, key: str) -> None:
        now = time.monotonic()
        with self._lock:
            hits = self._live(key, now)
            if hits is None:
                while len(self._hits) >= self.max_keys:
                    self._hits.popitem(last=False)
                hits = self._hits[key] = deque(maxlen=self.limit)
            hits.append(now)
            self._hits.move_to_end(key)

    def clear(self, key: str) -> None:
        with self._lock:
            self._hits.pop(key, None)

    def reset(self) -> None:
        with self._lock:
            self._hits.clear()
