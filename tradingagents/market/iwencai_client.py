#!/usr/bin/env python3
"""同花顺问财 OpenAPI 统一客户端

覆盖 6 个官方 skill (研报/公告/新闻搜索 + 行情/财务/行业 query) 的能力，
两个核心端点:
  - POST /v1/query2data           NL → 结构化字段 (行情/财务/行业)
  - POST /v1/comprehensive/search NL → 文档段落 (研报/公告/新闻)
"""

from __future__ import annotations

import json
import logging
import os
import secrets
import time
from dataclasses import dataclass, field
from typing import Any, Iterable, Literal

import pandas as pd
import requests

logger = logging.getLogger("iwencai")

DEFAULT_BASE_URL = "https://openapi.iwencai.com"
QUERY_ENDPOINT = "/v1/query2data"
SEARCH_ENDPOINT = "/v1/comprehensive/search"

SearchChannel = Literal["report", "announcement", "news"]


class IwencaiError(Exception):
    """问财 API 调用异常"""


@dataclass
class IwencaiArticle:
    """搜索类返回的文档段落"""

    title: str
    summary: str
    url: str
    publish_date: str
    channel: str
    uid: str
    source_original: str = ""
    data_source: str = ""
    stock_infos: list[dict] = field(default_factory=list)
    score: float = 0.0
    para_index: int = 0
    # 从 extra 提取的研报元信息
    organization: str = ""      # 出具机构, e.g. "国金证券"
    author: str = ""            # 作者, e.g. "苏晨"
    industries: list[str] = field(default_factory=list)  # 同花顺行业代码, e.g. ["S640701"]
    cat_names: list[str] = field(default_factory=list)   # 报告类别, e.g. ["行业深度研究"]
    publish_source: str = ""    # "研报" / "公告" / "新闻"
    raw: dict = field(default_factory=dict)

    @property
    def stock_codes(self) -> list[str]:
        """从 stock_infos 抽取股票代码列表"""
        if not self.stock_infos:
            return []
        codes = []
        for s in self.stock_infos:
            if isinstance(s, dict):
                code = s.get("code") or s.get("stock_code") or s.get("symbol")
                if code:
                    codes.append(str(code))
            elif isinstance(s, str):
                codes.append(s)
        return codes

    @property
    def stock_pairs(self) -> list[tuple[str, str]]:
        """返回 [(代码, 简称)] 列表"""
        if not self.stock_infos:
            return []
        out = []
        for s in self.stock_infos:
            if isinstance(s, dict):
                code = s.get("code") or s.get("stock_code") or s.get("symbol") or ""
                name = s.get("name") or s.get("stock_name") or ""
                if code or name:
                    out.append((str(code), str(name)))
        return out


class IwencaiClient:
    """问财 OpenAPI 客户端，封装两个核心端点 + NL 查询常用模式"""

    SKILL_ID = "report-search"
    SKILL_VERSION = "2.0.0"

    def __init__(
        self,
        api_key: str | None = None,
        base_url: str | None = None,
        timeout: int = 30,
        max_retries: int = 3,
        retry_delay: float = 2.0,
    ) -> None:
        self.api_key = api_key or os.environ.get("IWENCAI_API_KEY", "").strip()
        if not self.api_key:
            raise IwencaiError("未设置 API key (env IWENCAI_API_KEY 或 api_key 参数)")
        self.base_url = (base_url or os.environ.get("IWENCAI_BASE_URL", DEFAULT_BASE_URL)).rstrip("/")
        self.timeout = timeout
        self.max_retries = max_retries
        self.retry_delay = retry_delay
        self._session = requests.Session()
        self._session.headers.update(
            {
                "Authorization": f"Bearer {self.api_key}",
                "Content-Type": "application/json",
            }
        )

    def _claw_headers(self, call_type: str = "normal") -> dict:
        return {
            "X-Claw-Call-Type": call_type,
            "X-Claw-Skill-Id": self.SKILL_ID,
            "X-Claw-Skill-Version": self.SKILL_VERSION,
            "X-Claw-Plugin-Id": "none",
            "X-Claw-Plugin-Version": "none",
            "X-Claw-Trace-Id": secrets.token_hex(32),
        }

    def _post(self, endpoint: str, payload: dict) -> dict:
        url = f"{self.base_url}{endpoint}"
        last_err: Exception | None = None
        for attempt in range(1, self.max_retries + 1):
            try:
                call_type = "retry" if attempt > 1 else "normal"
                r = self._session.post(
                    url, json=payload, timeout=self.timeout,
                    headers=self._claw_headers(call_type),
                )
                if r.status_code != 200:
                    raise IwencaiError(f"HTTP {r.status_code}: {r.text[:200]}")
                data = r.json()
                code = data.get("status_code", 0)
                if code != 0:
                    raise IwencaiError(
                        f"业务错误 status_code={code}: {data.get('status_msg','')}"
                    )
                return data
            except (requests.RequestException, IwencaiError) as e:
                last_err = e
                if attempt < self.max_retries:
                    logger.warning("POST %s 失败 (尝试 %d): %s", endpoint, attempt, e)
                    time.sleep(self.retry_delay * attempt)
        raise IwencaiError(f"重试 {self.max_retries} 次后仍失败: {last_err}")

    def query_raw(
        self,
        query: str,
        page: int = 1,
        limit: int = 10,
        is_cache: bool = True,
        expand_index: bool = True,
    ) -> dict:
        """调用 /v1/query2data 拿原始 JSON"""
        payload = {
            "query": query,
            "page": str(page),
            "limit": str(limit),
            "is_cache": "1" if is_cache else "0",
            "expand_index": "true" if expand_index else "false",
        }
        return self._post(QUERY_ENDPOINT, payload)

    def query(self, query: str, **kw) -> pd.DataFrame:
        """NL 数据查询 → DataFrame，自动包含字段日期标签"""
        data = self.query_raw(query, **kw)
        rows = data.get("datas") or []
        df = pd.DataFrame(rows)
        df.attrs["code_count"] = data.get("code_count", 0)
        df.attrs["query"] = query
        df.attrs["chunks_info"] = data.get("chunks_info", {})
        return df

    def query_iter(
        self, query: str, page_size: int = 50, max_pages: int | None = None
    ) -> Iterable[pd.DataFrame]:
        """分页迭代器；当后端 code_count 大于已拉取数时继续翻页"""
        page = 1
        fetched = 0
        while True:
            df = self.query(query, page=page, limit=page_size)
            if df.empty:
                return
            yield df
            fetched += len(df)
            total = df.attrs.get("code_count", 0)
            if not total or fetched >= total:
                return
            if max_pages and page >= max_pages:
                return
            page += 1

    def search_raw(
        self,
        query: str,
        channel: SearchChannel,
        app_id: str = "AIME_SKILL",
        size: int = 10,
    ) -> dict:
        """调用 /v1/comprehensive/search 拿原始 JSON; size 默认 10, 可调到 50+"""
        payload = {"channels": [channel], "app_id": app_id, "query": query, "size": size}
        return self._post(SEARCH_ENDPOINT, payload)

    def search(
        self,
        query: str,
        channel: SearchChannel = "report",
        dedup_by_uid: bool = True,
        size: int = 50,
    ) -> list[IwencaiArticle]:
        """文档段落语义检索 → 结构化 Article 列表

        - dedup_by_uid: 同一文档的多段落仅保留 score 最高那段
        - size: 每次返回的段落数 (默认 50, 比 API 默认 10 多 5 倍)
        """
        data = self.search_raw(query, channel, size=size)
        items = data.get("data") or []
        articles = [_to_article(it) for it in items]
        if dedup_by_uid:
            articles = _dedup_articles(articles)
        return articles

    def search_reports(self, query: str, **kw) -> list[IwencaiArticle]:
        return self.search(query, channel="report", **kw)

    def search_announcements(self, query: str, **kw) -> list[IwencaiArticle]:
        return self.search(query, channel="announcement", **kw)

    def search_news(self, query: str, **kw) -> list[IwencaiArticle]:
        return self.search(query, channel="news", **kw)

    def collect_reports(
        self,
        queries: list[str],
        channel: SearchChannel = "report",
        dedup_by_uid: bool = True,
        sleep: float = 0.5,
        size: int = 50,
    ) -> list[IwencaiArticle]:
        """批量跑多 query → 合并 + 跨 query 去重; size 每查询拉的段落数"""
        seen: set[str] = set()
        out: list[IwencaiArticle] = []
        for i, q in enumerate(queries, 1):
            try:
                arts = self.search(q, channel=channel, dedup_by_uid=dedup_by_uid, size=size)
            except IwencaiError as e:
                logger.warning("query %r 失败: %s", q, e)
                continue
            new_count = 0
            for a in arts:
                key = a.uid or f"{a.title}|{a.publish_date}"
                if key in seen:
                    continue
                seen.add(key)
                out.append(a)
                new_count += 1
            logger.info("[%d/%d] %s → %d 条 (新增 %d)", i, len(queries), q, len(arts), new_count)
            if sleep:
                time.sleep(sleep)
        return out


def _to_article(raw: dict) -> IwencaiArticle:
    extra = raw.get("extra") or {}
    if isinstance(extra, str):
        try:
            extra = json.loads(extra)
        except Exception:
            extra = {}
    return IwencaiArticle(
        title=raw.get("title", ""),
        summary=raw.get("summary", ""),
        url=raw.get("url", ""),
        publish_date=raw.get("publish_date", ""),
        channel=raw.get("channel", ""),
        uid=raw.get("uid", "") or raw.get("id", ""),
        source_original=raw.get("source_original", ""),
        data_source=raw.get("data_source", ""),
        stock_infos=raw.get("stock_infos") or [],
        score=float(raw.get("score") or 0),
        para_index=int(raw.get("para_index") or 0),
        organization=extra.get("organization", "") or "",
        author=extra.get("author", "") or "",
        industries=list(extra.get("industries") or []),
        cat_names=list(extra.get("cat_names") or []),
        publish_source=extra.get("publish_source", "") or "",
        raw=raw,
    )


def _dedup_articles(articles: list[IwencaiArticle]) -> list[IwencaiArticle]:
    """同一 uid 仅保留 score 最高的段落"""
    best: dict[str, IwencaiArticle] = {}
    for a in articles:
        key = a.uid or f"{a.title}|{a.publish_date}"
        if key not in best or a.score > best[key].score:
            best[key] = a
    return sorted(best.values(), key=lambda x: x.publish_date or "", reverse=True)


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    client = IwencaiClient()
    print("=== query 测试 ===")
    df = client.query("贵州茅台 ROE")
    print(df)
    print(f"code_count: {df.attrs.get('code_count')}")
    print()
    print("=== search 测试 ===")
    arts = client.search_reports("人形机器人产业链 2026")
    for a in arts[:3]:
        print(f"  {a.publish_date[:10]} | {a.title[:60]}")
        print(f"    标的: {a.stock_pairs[:5]}")
