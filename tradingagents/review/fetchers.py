"""A 股复盘数据取数层（自包含，只依赖 requests / pandas / akshare）。

数据源：
  · 板块资金流（今日 f62 / 5 日 f164 / 10 日 f174）、个股资金流、板块涨跌
        → push2delay.eastmoney.com 的 clist 接口
        （push2.eastmoney.com 在部分网络下被重置，故用 delay 镜像）
  · 涨停池 / 炸板池 / 强势股池 / 龙虎榜 / 情绪总览 → akshare 原生
  · 涨停原因题材串 → 同花顺问财增强源；未配置密钥时走公开涨停揭秘（逐行核对封板日期）
  · 5 日 / 10 日累计净额由 clist 三窗口直取，不逐板块拉 daykline
        （push2his 历史接口在部分网络下被封，delay 镜像只给当日）
"""

from .pool_source import frame as pool_frame

import os
import re
import json
import time
import datetime
import requests
import pandas as pd

# 先把仓库根的 .env 读进来 —— 下面的代理开关要用它。
# 🔴 顺序要紧：README 让用户把配置写在 .env 里，如果开关在 _load_env() 之前就算完，
#    .env 里写的 VIBE_MARKET_PROXY / VR_DATA_PROXY 这边永远看不见，
#    而 vr/astock.py 是后 import 的、它看得见 —— 两边对同一台机器给出不同的路由，
#    没有任何报错。
# 仓库根（本文件在 duanxian/ 里，往上一级）—— 用来找可选的 .env
_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _load_env():
    """读仓库根的 .env（放 IWENCAI_API_KEY 等），不依赖 python-dotenv。

    环境变量里已有的不覆盖；文件不存在就什么也不做。
    """
    env_path = os.path.join(_REPO_ROOT, ".env")
    if not os.path.exists(env_path):
        return
    try:
        with open(env_path, encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                if line.startswith("export "):
                    line = line[len("export "):]
                if "=" not in line:
                    continue
                k, v = line.split("=", 1)
                k, v = k.strip(), v.strip().strip('"').strip("'")
                if k and k not in os.environ:
                    os.environ[k] = v
    except Exception:
        pass


_load_env()




# ---- 代理：本模块自己直连，但**不替整个进程做决定** -------------------------
# 东财 / 腾讯是国内站，开着科学上网时系统代理常把它们的路由挂掉，所以本模块自己发的
# 请求默认直连（`trust_env=False`，见 `_direct_get`）。这一层只影响本模块，安全。
#
# ⛔ 这个模块在 server 启动时就被 import，所以**任何进程级的环境改动都会波及别人**：
#   · 早先这里在模块顶层 pop 掉了 HTTP_PROXY / HTTPS_PROXY / ALL_PROXY ——
#     等于顺手废掉整个进程的代理，而同一进程里 LLM 调用可能正靠它出网，
#     表现只是"模型调不通"，没人会联想到取数模块；
#   · 改成"把 eastmoney.com 加进 NO_PROXY"也不行：`vr/astock.py` 的东财客户端
#     本来就是**直连优先、失败自动回退系统代理**，而它的代理会话是 `trust_env=True`
#     （靠环境变量拿代理）。往 NO_PROXY 里塞 eastmoney.com 会把那条自愈回退
#     静默废成"再直连一次"。而且 akshare 用的四个东财域名 vr 全都在用，
#     没法只绕自己那份。
#
# 所以默认**什么都不改**。代价：akshare 内部自己 new requests（塞不进本模块的会话），
# 在"系统代理挂掉东财"的机器上它会失败 —— 但那是响亮的失败：核心数据缺 → 体检拒跑 →
# 界面给一句能照着办的话，而不是静默给错数。要连 akshare 一起强行直连就显式开
# VIBE_MARKET_DIRECT=1（下面会说清它是进程级的）。
_DIRECT_HOSTS = ("eastmoney.com", "qt.gtimg.cn")


def _flag(name: str) -> bool:
    return os.environ.get(name, "").strip().lower() in ("1", "true", "yes")


# 行情要走代理（东财在这台机器上只能经代理访问）。VR_DATA_PROXY 是 vr/ 那边同义的
# 开关，一并认，别让两处互相拆台。
_USE_PROXY_FOR_MARKET = _flag("VIBE_MARKET_PROXY") or _flag("VR_DATA_PROXY")
# 反向：连 akshare 也强行直连。**这条是进程级的**，会一并关掉 vr 对东财的代理回退，
# 所以必须由用户显式打开，不能当默认。
_FORCE_DIRECT = _flag("VIBE_MARKET_DIRECT") and not _USE_PROXY_FOR_MARKET

if _FORCE_DIRECT:
    # 🔴 大小写两个变量都要写。requests 取 no_proxy 时**小写优先**
    # （`os.environ.get(k) or os.environ.get(k.upper())`），只更新 NO_PROXY 的话，
    # 凡是环境里已经有小写 no_proxy 的机器上这一整段就白做 —— 照样走代理、照样 403，
    # 而且现象和"没改过"一模一样，看不出来。
    _existing = [h.strip()
                 for v in (os.environ.get("no_proxy", ""), os.environ.get("NO_PROXY", ""))
                 for h in v.split(",") if h.strip()]
    _merged = ",".join(dict.fromkeys([*_existing, *_DIRECT_HOSTS]))
    os.environ["NO_PROXY"] = _merged
    os.environ["no_proxy"] = _merged

_TRUST_ENV = _USE_PROXY_FOR_MARKET


def _direct_get(url, **kw):
    """本模块自己发的 GET。

    每次新建会话而不是共用一个：`Session` 的 cookie jar 是可变共享状态，而这个服务
    是并发的（复盘在后台线程跑，页面同时在拉行情）。这两处都是一次性 GET，
    省下的连接复用不值得拿并发正确性去换。
    """
    with requests.Session() as s:
        s.trust_env = _TRUST_ENV
        return s.get(url, **kw)

# ----------------------------------------------------------------------------
# 常量
# ----------------------------------------------------------------------------
def _iwencai_client_cls():
    """拿到 IwencaiClient 类。

    它在 `vr/` 里（随仓库分发）。裸 `import iwencai_client` 只在 `vr/` 恰好
    已经在 sys.path 上时才成立 —— server 启动时会加，但 CLI 直接跑 main.py 不会，
    于是同一段代码在网页里能用、命令行里报 ImportError。这里自己把路补上。
    """
    import sys

    vr = os.path.join(_REPO_ROOT, "vr")
    if os.path.isdir(vr) and vr not in sys.path:
        sys.path.append(vr)
    from iwencai_client import IwencaiClient  # noqa: PLC0415

    return IwencaiClient



DELAY_HOST = "https://push2delay.eastmoney.com/api/qt/clist/get"
UT_FUND = "b2884a393a59ad64002292a3e90d46a5"  # 资金流 ut
HEADERS = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                         "AppleWebKit/537.36 (KHTML, like Gecko) "
                         "Chrome/120.0 Safari/537.36"}
YI = 1e8  # 元 → 亿

# 沪深京全 A 股票筛子 (clist fs 参数)
ALL_A_FS = ("m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23,m:0+t:7,m:1+t:3,"
            "m:0+t:13,m:0+t:81+s:2048")


# ----------------------------------------------------------------------------
# 通用 push2delay clist 拉取 (自动翻页)
# ----------------------------------------------------------------------------
def _clist(fs, fid, fields, ut=UT_FUND, pz=100, max_pages=80, retries=3):
    """
    通用 clist 抓取, 返回 list[dict].
    注意: push2delay 镜像把单页 pz 硬截到 100, 所以按"实际累计返回数"翻页,
    不能用 page*pz 估算 (否则会提前停)。
    """
    rows = []
    page = 1
    total = None
    while page <= max_pages:
        params = {
            "pn": page, "pz": pz, "po": 1, "np": 1, "ut": ut,
            "fltt": 2, "invt": 2, "fid": fid, "fs": fs,
            "fields": fields, "_": int(time.time() * 1000),
        }
        data = None
        for attempt in range(retries):
            try:
                r = _direct_get(DELAY_HOST, params=params,
                                 headers=HEADERS, timeout=15)
                data = r.json().get("data")
                break
            except Exception:
                if attempt == retries - 1:
                    raise
                time.sleep(1.5)
        if not data or not data.get("diff"):
            break
        diff = data["diff"]
        rows.extend(diff)
        total = data.get("total", 0)
        if len(rows) >= total or len(diff) == 0:
            break
        page += 1
    return rows


def _f(v):
    """安全转 float, '-'/None → None."""
    try:
        if v in ("-", "", None):
            return None
        return float(v)
    except (ValueError, TypeError):
        return None


# ----------------------------------------------------------------------------
# 1. 市场情绪总览 (akshare 原生)
# ----------------------------------------------------------------------------
def fetch_sentiment(highest_consec, ind_flat, zt):
    """市场情绪总览 — 不再依赖 legulegu.com。

    原 ak.stock_market_activity_legu() 因 legulegu.com 页面结构变动(current-index
    节点被移除)而失效。改为自算: 涨/跌/平家数来自已抓取的全市场个股(ind_flat, 含
    change_pct), 真实涨停/炸板/跌停来自涨停池/炸板池/跌停池(fetch_zt_pool 已取)。
    全部走东财数据, 零第三方情绪页依赖, 更稳。
    """
    up = down = flat = 0
    for r in ind_flat:
        cp = r.get("change_pct")
        if cp is None:
            continue  # 停牌/无行情的票不计入涨跌家数
        if cp > 0:
            up += 1
        elif cp < 0:
            down += 1
        else:
            flat += 1
    total = up + down + flat

    zt_df = zt.get("zt")
    # 东财涨停池 = 实际封住涨停的票 = 真实涨停; 炸板池 = 曾涨停后开板; 涨停(含开) = 两者之和
    limit_up_real = int(len(zt_df)) if zt_df is not None else 0
    broken_board = int(zt.get("zb_count", 0) or 0)
    limit_up = limit_up_real + broken_board
    limit_down = int(zt.get("dt_count", 0) or 0)
    # 活跃度: 用涨家占比(上涨/全部有行情)作为市场参与度的可读代理, 形如 "62% 涨家占比"
    activity = f"{round(up / total * 100)}% 涨家占比" if total else ""

    return {
        "up_count": up, "down_count": down, "flat_count": flat,
        "limit_up": limit_up, "limit_up_real": limit_up_real,
        "limit_down": limit_down,
        "broken_board": broken_board,
        "broken_rate": None,   # main 里算 (炸板率)
        "activity": activity,
        "highest_consec": highest_consec,
        "market_label": None,  # main 里算 (大盘宽度)
        "theme_label": None,   # main 里算 (题材投机)
        "label": None,         # main 里算 (组合串)
        "error": None if total else "市场情绪: 全市场个股涨跌幅为空, 无法统计涨跌家数",
    }


def label_sentiment(s):
    """
    双维度情绪标签:
      market_label — 大盘宽度, 按 r = up_count/down_count
      theme_label  — 题材投机, 按 真实涨停数 lu + 炸板率 br
      label        — 组合串 f"大盘{market}·题材{theme}"
    返回 (market_label, theme_label, label)
    """
    up = s["up_count"] or 0
    down = s["down_count"] or 0
    lu = s["limit_up_real"] or 0
    br = s["broken_rate"]

    # 情绪取数失败(up/down 全为 0)时不臆造标签, 直接标"数据缺失"
    if up == 0 and down == 0:
        return "数据缺失", "数据缺失", "情绪数据缺失"

    # --- 大盘宽度维度 ---
    r = (up / down) if down else float("inf")
    if r < 0.4:
        market = "冰点"
    elif r < 0.8:
        market = "偏弱"
    elif r < 1.25:
        market = "中性"
    elif r < 2.5:
        market = "偏强"
    else:
        market = "普涨"

    # --- 题材投机维度 ---
    if lu >= 80:
        theme = "亢奋" if (br is not None and br < 0.30) else "活跃"
    elif lu >= 50:
        theme = "活跃"
    elif lu >= 25:
        theme = "普通"
    else:
        theme = "冰点"

    label = f"大盘{market}·题材{theme}"
    return market, theme, label


# ----------------------------------------------------------------------------
# 2. 涨停池 / 炸板池 (akshare 原生)
# ----------------------------------------------------------------------------
def fetch_zt_pool(date):
    import akshare as ak
    out = {"zt": None, "zb_count": 0, "dt_count": 0, "highest_consec": 0, "ladder": []}
    try:
        zt = pool_frame("zt", date)
        out["zt"] = zt
        if "连板数" in zt.columns and len(zt):
            out["highest_consec"] = int(zt["连板数"].max())
        # 连板梯队: 按连板数降序
        zt_sorted = zt.sort_values("连板数", ascending=False)
        for _, r in zt_sorted.iterrows():
            out["ladder"].append({
                "code": str(r["代码"]),
                "name": str(r["名称"]),
                "consec_boards": int(r["连板数"]) if pd.notna(r["连板数"]) else 0,
                "sector": str(r.get("所属行业", "")),
                "first_seal_time": str(r.get("首次封板时间", "")),
            })
    except Exception as e:
        out["error_zt"] = f"{type(e).__name__}: {str(e)[:100]}"
    try:
        zb = pool_frame("zb", date)
        out["zb_count"] = len(zb)
    except Exception as e:
        out["error_zb"] = f"{type(e).__name__}: {str(e)[:100]}"
    try:
        dt = pool_frame("dt", date)
        out["dt_count"] = len(dt)
    except Exception as e:
        out["error_dt"] = f"{type(e).__name__}: {str(e)[:100]}"
    return out


# ----------------------------------------------------------------------------
# 2b. 涨停原因/题材 (iwencai query2data)
#     东财涨停池无"涨停原因"列, 只有所属行业; 用同花顺问财结构化查询补题材串.
#     返回 {6位代码: reason}. 拿不到 → 空 dict, 调用方填 "—".
# ----------------------------------------------------------------------------
def fetch_zt_reasons(date):
    """
    date: 'YYYYMMDD'
    iwencai 返回 涨停原因[YYYYMMDD] 列, 代码形如 002491.SZ, 取前6位匹配.
    reason 形如 '光纤光缆+产能扩张+数据中心', 已是简洁题材串, 直接用.

    ⚠️ 问的必须是 `date` 那一场，不能问"今日" —— 复盘的常态就是收盘后回看上一场，
    问"今日"会把当天的题材当成被复盘那天的题材，而且看不出来（题材串本身没有日期）。
    返回列名里带着问财实际给的日期（`涨停原因[YYYYMMDD]`），拿它和请求的日期对一遍：
    不一致就当取数失败，宁可没有题材串，也不能把别的交易日的题材塞进这一场。
    """
    if not os.environ.get("IWENCAI_API_KEY"):
        from .historical_sources import public_limit_reasons
        try:
            return public_limit_reasons(str(date))
        except Exception as exc:
            return {}, f"公开涨停原因源不可用：{exc}；可重试或配置问财增强源"
    try:
        IwencaiClient = _iwencai_client_cls()
    except Exception as e:
        return {}, f"import IwencaiClient 失败: {type(e).__name__}: {str(e)[:80]}"
    if not os.environ.get("IWENCAI_API_KEY"):
        return {}, "没配问财接口密钥 IWENCAI_API_KEY，取不到涨停原因"

    try:
        client = IwencaiClient()
    except Exception as e:
        return {}, f"IwencaiClient 初始化失败: {type(e).__name__}: {str(e)[:80]}"

    if not (len(str(date)) == 8 and str(date).isdigit()):
        return {}, f"日期格式应为 YYYYMMDD, 收到 {date!r}"
    d = str(date)
    query = f"{d[:4]}-{d[4:6]}-{d[6:8]}涨停的股票 涨停原因"

    reasons = {}
    err = None
    try:
        # 翻页拿全部涨停 (单页 limit=50, 一般 1~2 页够)
        for page in range(1, 4):
            df = client.query(query, page=page, limit=50)
            if df is None or len(df) == 0:
                break
            code_cols = [c for c in df.columns if "代码" in c]
            reason_cols = [c for c in df.columns if "涨停原因" in c]
            if not code_cols or not reason_cols:
                err = f"返回无涨停原因列, cols={list(df.columns)[:6]}"
                break
            # 只认**能验出场次**的列。列名形如 涨停原因[20260729]；验不出来就当失败，
            # 别"匹配不到就放行" —— 那等于在最需要拦的时候（返回了没日期的通用列）
            # 恰好不拦，错场次的题材照样进来。
            dated = {m.group(1): c for c in reason_cols
                     if (m := re.search(r"\[(\d{8})\]", c))}
            if not dated:
                return {}, f"涨停原因列没带日期, 无法确认是哪一场: {reason_cols[:3]}"
            if d not in dated:
                return {}, f"问财返回的是 {sorted(dated)} 的涨停原因, 不是 {d}"
            cc, rc = code_cols[0], dated[d]
            for _, r in df.iterrows():
                code6 = str(r[cc])[:6]
                reason = str(r[rc]).strip()
                if reason and reason.lower() != "nan" and code6 not in reasons:
                    reasons[code6] = _clean_reason(reason)
            if len(df) < 50:
                break
    except Exception as e:
        err = f"{type(e).__name__}: {str(e)[:90]}"
    return reasons, err


def _clean_reason(text, max_tags=4, max_len=30):
    """题材串清洗: 去空白, 限标签数与长度 (iwencai 多用 '+' 分隔)."""
    text = text.replace("，", "+").replace(",", "+").strip()
    parts = [p.strip() for p in text.split("+") if p.strip()]
    if parts:
        text = "+".join(parts[:max_tags])
    return text[:max_len]


# ----------------------------------------------------------------------------
# 3. 龙虎榜 (akshare 原生)
# ----------------------------------------------------------------------------
def fetch_lhb(date, top=15):
    import akshare as ak
    rows = []
    try:
        df = ak.stock_lhb_detail_em(start_date=date, end_date=date)
        if len(df):
            # The request date alone is not evidence: upstream has returned
            # another session despite identical start/end parameters.
            import datetime
            expected = datetime.datetime.strptime(date, "%Y%m%d").date().isoformat()
            if "上榜日" not in df.columns:
                return [{"error": "龙虎榜缺少上榜日期，无法核实目标日"}]
            days = df["上榜日"].map(lambda value: str(value)[:10])
            if not days.eq(expected).all():
                return [{"error": "龙虎榜返回日期与目标日不符，未使用该批数据"}]
            df = df.sort_values("龙虎榜净买额", ascending=False)
            # 机构净买: 该接口无独立机构净买列, 从「解读」推断不可靠 → 填 null
            for _, r in df.head(top).iterrows():
                rows.append({
                    "code": str(r["代码"]),
                    "name": str(r["名称"]),
                    "net_buy": round(_f(r["龙虎榜净买额"]) / YI, 2)
                    if _f(r["龙虎榜净买额"]) is not None else None,
                    "reason": str(r.get("上榜原因", ""))[:40],
                    "inst_net": None,  # 该接口不直接提供机构净买额
                })
    except Exception as e:
        return [{"error": f"{type(e).__name__}: {str(e)[:100]}"}]
    return rows


# ----------------------------------------------------------------------------
# 3b. 大盘指数 (腾讯 qt.gtimg.cn) — 与 Home /market/home 同一套指数
#     指数代码来自 universe.json indices.aShare/us; 涨跌幅取腾讯 f[32], 无需自算.
# ----------------------------------------------------------------------------
TENCENT_Q = "http://qt.gtimg.cn/q="
# 与 agent/universe.json indices 一致 (A股4 + 美股3, A前US后)
A_INDICES = [
    ("sh000001", "上证指数"), ("sz399001", "深证成指"),
    ("sz399006", "创业板指"), ("sh000300", "沪深300"),
]
US_INDICES = [
    ("usDJI", "道琼斯"), ("usIXIC", "纳斯达克"), ("usINX", "标普500"),
]


def fetch_indices():
    """返回 [{code,name,price,changePct,group}] (A股在前, 美股在后).
    腾讯字段: f[1]=名称, f[3]=现价, f[32]=涨跌幅%. 拿不到的字段填 None 不崩.
    """
    spec = [(c, n, "A") for c, n in A_INDICES] + \
           [(c, n, "US") for c, n in US_INDICES]
    codes = [c for c, _, _ in spec]
    parsed = {}
    try:
        url = TENCENT_Q + ",".join(codes)
        r = _direct_get(url, headers=HEADERS, timeout=10)
        raw = r.content.decode("gbk", "ignore")
        for line in raw.split("\n"):
            if "~" not in line:
                continue
            f = line.split("~")
            if len(f) < 33:
                continue
            code = line.split("=")[0].split("_")[-1]
            parsed[code] = {
                "price": _f(f[3]),
                "changePct": _f(f[32]),
            }
    except Exception:
        pass  # 整体失败也按顺序输出, price/changePct=None

    out = []
    for code, name, group in spec:
        q = parsed.get(code, {})
        out.append({
            "code": code, "name": name,
            "price": q.get("price"),
            "changePct": q.get("changePct"),
            "group": group,
        })
    return out


# ----------------------------------------------------------------------------
# 4. 个股资金流排名 (push2delay)
# ----------------------------------------------------------------------------
def fetch_individual_fund_flow():
    """全市场个股主力净流入, 返回 code → {name,price,change_pct,inflow(元)}."""
    fields = "f12,f14,f2,f3,f62"
    rows = _clist(ALL_A_FS, "f62", fields, ut=UT_FUND, pz=100, max_pages=80)
    by_code = {}
    flat = []
    for r in rows:
        code = str(r.get("f12", ""))
        rec = {
            "code": code,
            "name": str(r.get("f14", "")),
            "price": _f(r.get("f2")),
            "change_pct": _f(r.get("f3")),
            "inflow_raw": _f(r.get("f62")),  # 元
        }
        by_code[code] = rec
        flat.append(rec)
    return by_code, flat


# ----------------------------------------------------------------------------
# 4b. 成交额 TOP20 (push2delay) — 全市场热度温度计
#     clist 按 f6(成交额) 降序, f100 直接带所属行业, 只取前20 (不翻全量)
# ----------------------------------------------------------------------------
def fetch_turnover_top20(top=20):
    """返回 [{code,name,price,change_pct,amount(亿),sector}], 按成交额降序."""
    rows = _clist(ALL_A_FS, "f6", "f12,f14,f2,f3,f6,f100",
                  ut=UT_FUND, pz=top, max_pages=1)
    out = []
    for r in rows[:top]:
        amt = _f(r.get("f6"))
        sector = str(r.get("f100", "")).strip()
        out.append({
            "code": str(r.get("f12", "")),
            "name": str(r.get("f14", "")),
            "price": _f(r.get("f2")),
            "change_pct": _f(r.get("f3")),
            "amount": round(amt / YI, 2) if amt is not None else None,
            "sector": sector if sector and sector != "-" else None,
        })
    return out


# ----------------------------------------------------------------------------
# 5. 板块资金流 + 涨跌 (push2delay) — 行业 / 概念
#    今日(f62) / 5日(f164) / 10日(f174) 三个累计窗口各一次 clist 全量拉,
#    无需逐板块拉 daykline (push2his 历史接口本机被封, daykline 镜像只给当日)
# ----------------------------------------------------------------------------
def fetch_sector_flow(sector_t):
    """
    sector_t: '2'=行业, '3'=概念
    一次性拿全部板块的 今日/5日/10日 主力净额 + 涨跌幅 + 领涨股.
    返回 list[dict]: bk_code/name/change_pct/inflow_raw/in5_raw/in10_raw/lead_stock
    """
    fs = f"m:90 t:{sector_t}"
    # 今日: fid=f62, 带涨跌幅 f3 + 领涨股 f128
    today_rows = _clist(fs, "f62", "f12,f14,f3,f62,f128",
                        ut=UT_FUND, pz=100, max_pages=10)
    # 5日累计主力净额: f164
    five_rows = _clist(fs, "f164", "f12,f164", ut=UT_FUND, pz=100, max_pages=10)
    # 10日累计主力净额: f174
    ten_rows = _clist(fs, "f174", "f12,f174", ut=UT_FUND, pz=100, max_pages=10)

    five_map = {str(r.get("f12")): _f(r.get("f164")) for r in five_rows}
    ten_map = {str(r.get("f12")): _f(r.get("f174")) for r in ten_rows}

    out = []
    for r in today_rows:
        bk = str(r.get("f12", ""))
        out.append({
            "bk_code": bk,
            "name": str(r.get("f14", "")),
            "change_pct": _f(r.get("f3")),
            "inflow_raw": _f(r.get("f62")),   # 今日主力净额(元)
            "in5_raw": five_map.get(bk),       # 5日累计(元)
            "in10_raw": ten_map.get(bk),       # 10日累计(元)
            "lead_stock": str(r.get("f128", "")),
        })
    return out


# ----------------------------------------------------------------------------
# 6. 趋势加工 — 用 今日/5日/10日 三窗口推 consec(近似) + trend_tag
#    consec_inflow_days: 无 daykline 历史, 用三窗口符号一致性近似(0~3档)
# ----------------------------------------------------------------------------
def enrich_trend(sector_list):
    for s in sector_list:
        s["inflow_today"] = round(s["inflow_raw"] / YI, 2) \
            if s["inflow_raw"] is not None else None
        s["inflow_5d"] = round(s["in5_raw"] / YI, 2) \
            if s["in5_raw"] is not None else None
        s["inflow_10d"] = round(s["in10_raw"] / YI, 2) \
            if s["in10_raw"] is not None else None
        # 近似"连续流入档位": 今日/5日/10日 同为正各记 1 (0~3),
        # 非真实逐日连板天数, 是三窗口一致性代理.
        t, f5, f10 = s["inflow_today"], s["inflow_5d"], s["inflow_10d"]
        consec = None
        if t is not None and f5 is not None and f10 is not None:
            consec = sum(1 for x in (t, f5, f10) if x > 0)
        s["consec_inflow_days"] = consec


def tag_trend(s):
    """
    趋势标签 (基于 今日/5日/10日 三累计窗口):
      consec(三窗口同正)>=3 且 5日>0 → 趋势流入
      今日>0 但 5日<0            → 今日脉冲
      今日<0 且 5日<0 且 10日<0   → 趋势流出
      其余                       → 震荡
    """
    consec = s.get("consec_inflow_days")
    in5 = s.get("inflow_5d")
    in10 = s.get("inflow_10d")
    today = s.get("inflow_today")
    if consec is not None and consec >= 3 and in5 is not None and in5 > 0:
        return "趋势流入"
    if today is not None and today > 0 and in5 is not None and in5 < 0:
        return "今日脉冲"
    if (today is not None and today < 0 and in5 is not None and in5 < 0
            and in10 is not None and in10 < 0):
        return "趋势流出"
    return "震荡"


def clean_sector(s):
    """输出用的精简字段."""
    return {
        "name": s["name"],
        "change_pct": s["change_pct"],
        "inflow_today": s["inflow_today"],
        "inflow_5d": s["inflow_5d"],
        "inflow_10d": s["inflow_10d"],
        "consec_inflow_days": s["consec_inflow_days"],
        "lead_stock": s["lead_stock"],
        "trend_tag": s["trend_tag"],
    }


# ----------------------------------------------------------------------------
# 7. watchlist 交叉 (home-pool.json)
