import { randomId } from "@/lib/random-id";
import { useSearchParams } from 'react-router-dom';
import { AgentRequestError, agentRequest, loadAgentConnection } from "@/lib/agent-api";
import { useEffect, useRef, useState } from "react";
import { Swords, Loader2, AlertTriangle, Target, CheckSquare } from "lucide-react";
import { cn } from "@/lib/utils";
import { reviewWarningMessages } from "@/lib/review-warnings";
import { ReviewAgentChat } from "@/components/ReviewAgentChat";
import { EvidenceReferences, GroundedAnalysis } from "@/components/ReportEvidence";
import {
  ConsecPremiumCard, CycleCard, LadderCard, MoneyEffectCard, PromotionCard, splitMetrics,
} from "@/components/EmotionMetricsPanel";
import {
  BoardSystemSection, DiffView, Ledger, LossEffectSection, Matrix, SealQualitySection,
  StatsView, Themes, ThemeTreeView,
} from "@/components/MarketFactsPanel";
import { BreadthPanel } from "@/components/BreadthPanel";
import { TrendPanel } from "@/components/TrendPanel";
import {
  agentFetch, agentPost, finite, localDate, phaseTone, safeArray,
  type FocusDirection, type ReviewData, type VerificationItem,
} from "@/lib/agent";


type DailyStatus = { running: boolean; job_id?: string; date?: string; elapsed?: number; stage?: string; error?: string; status?: string; already_done?: boolean; state_warning?: string };
const pendingKey = "astock-pending-daily";
type PendingDaily = { date: string; force: boolean; request_id: string; source: string };
function readPendingDaily(): PendingDaily | null {
  try {
    const p = JSON.parse(sessionStorage.getItem(pendingKey) || "null");
    return p && /^\d{4}-\d{2}-\d{2}$/.test(p.date) && /^[0-9a-f]{32}$/.test(p.request_id)
      && typeof p.force === "boolean" && typeof p.source === "string" ? p : null;
  } catch { return null; }
}


/** 验证条件里的读数与阈值怎么显示。
 *
 *  三种单位混在一起：家 / 板 是计数，`%` 是已经是百分数的值（赚钱效应中位数 +0.42%），
 *  空单位是 0~1 的比率（晋级率 0.13 = 13%）。混着直接印就会出现「0.13」这种读者
 *  得自己换算的数 —— 与「历史统计位置」那一列犯过的是同一个错。
 */
function statText(v: VerificationItem): string {
  const n = finite(v.base_value);
  if (n == null) return "—";
  if (v.unit === "%") return `${n > 0 ? "+" : ""}${n.toFixed(2)}%`;
  if (!v.unit) return `${Math.round(n * 100)}%`;
  return `${n}${v.unit}`;
}

function epsText(v: VerificationItem): string {
  const e = finite(v.eps);
  if (e == null) return "";
  // 比率与百分数都按"个百分点"说，别写成「超过 0.05」
  if (!v.unit) return `${Math.round(e * 100)} 个百分点`;
  if (v.unit === "%") return `${e} 个百分点`;
  return `${e}${v.unit}`;
}

const METRIC_LABEL: Record<string, string> = {
  limit_up_count: "涨停家数",
  highest_board: "最高连板高度",
  promotion_1to2: "1进2 晋级率",
  money_effect_median: "赚钱效应中位数",
  broken_rate: "炸板率",
  deep_loss_count: "跌超5%家数",
  theme_concentration: "头部题材集中度",
  market_limit_down: "全市场跌停家数",
};

const DISCLAIMER =
  "本页由多 agent AI 基于公开盘面数据（涨跌停/龙虎榜/资金流/题材）现场生成，结论为 AI 判断，仅供参考，不构成投资建议；市场有风险，决策与盈亏自负。";

interface MetricOption {
  key: string; label: string; hint: string; unit: string; available?: boolean | null; higher_is_hotter: boolean;
}

/** 用户自设验证条件 —— AI 挑的是它的判断，自己写下的才会想回来看对没对。
 *  同一指标以用户的为准（后端 merged_items）。*/
function UserConditions({ date }: { date: string }) {
  const [menu, setMenu] = useState<{ metrics: MetricOption[]; directions: string[] } | null>(null);
  const [items, setItems] = useState<VerificationItem[]>([]);
  const [open, setOpen] = useState(false);
  const [msg, setMsg] = useState("");

  useEffect(() => {
    if (!open || !date) return;
    (async () => {
      try {
        const [m, cur] = await Promise.all([
          agentFetch<{ metrics: MetricOption[]; directions: string[] }>(`/api/verification/menu?date=${date}`),
          agentFetch<{ items: VerificationItem[] }>(`/api/verification/items?date=${date}`),
        ]);
        setMenu(m);
        setItems(safeArray<VerificationItem>(cur?.items));
      } catch { setMsg("读取失败"); }
    })();
  }, [open, date]);

  async function save() {
    try {
      const r = await agentPost<{ ok?: boolean; error?: string }>(
        `/api/verification/items?date=${date}`, { items });
      setMsg(r?.error ? r.error : r?.ok ? "已保存，次日自动核验" : "保存失败");
    } catch (e) {
      setMsg(e instanceof Error ? `保存失败：${e.message}` : "保存失败");
    }
  }

  if (!open) {
    return (
      <button onClick={() => setOpen(true)}
        className="mt-2 text-[11px] text-primary underline-offset-2 hover:underline">
        + 自己加一条验证条件（自己写下的，明天才会想回来看对没对）
      </button>
    );
  }
  return (
    <div className="mt-3 rounded-lg border border-dashed border-primary/40 p-3">
      <div className="mb-2 text-[12px] font-semibold">
        我自己的验证条件
        <span className="ml-1.5 font-normal text-muted-foreground">
          同一指标以你写的为准，次日与 AI 的一起核验
        </span>
      </div>
      {items.map((it, i) => (
        <div key={i} className="mb-1.5 flex flex-wrap items-center gap-1.5">
          <select value={it.metric}
            onChange={(e) => setItems(items.map((x, j) => j === i ? { ...x, metric: e.target.value } : x))}
            className="rounded border border-border bg-card px-2 py-1 text-[12px]">
            {safeArray<MetricOption>(menu?.metrics).map((m) => (
              <option key={m.key} value={m.key} title={m.hint}>{m.label}{m.available === false ? "（本日报告未覆盖）" : m.available == null ? "（本日覆盖未确认）" : ""}</option>
            ))}
          </select>
          <select value={it.direction}
            onChange={(e) => setItems(items.map((x, j) => j === i ? { ...x, direction: e.target.value } : x))}
            className="rounded border border-border bg-card px-2 py-1 text-[12px]">
            {safeArray<string>(menu?.directions).map((d) => <option key={d} value={d}>核验方向：{d}</option>)}
          </select>
          <input value={it.reason} placeholder="为什么（可选）"
            onChange={(e) => setItems(items.map((x, j) => j === i ? { ...x, reason: e.target.value } : x))}
            className="min-w-[160px] flex-1 rounded border border-border bg-card px-2 py-1 text-[12px]" />
          <button onClick={() => setItems(items.filter((_, j) => j !== i))}
            className="text-muted-foreground/50 hover:text-danger text-[12px]">×</button>
        </div>
      ))}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button
          onClick={() => setItems([...items, {
            metric: safeArray<MetricOption>(menu?.metrics)[0]?.key || "limit_up_count",
            direction: "上升", reason: "",
          }])}
          disabled={items.length >= 8}
          className="rounded border border-border px-2 py-1 text-[11px] hover:bg-muted disabled:opacity-40">
          + 加一条
        </button>
        <button onClick={save}
          className="rounded bg-primary px-3 py-1 text-[11px] font-semibold text-primary-foreground hover:opacity-90">
          保存
        </button>
        {msg && <span className="text-[11px] text-muted-foreground">{msg}</span>}
      </div>
    </div>
  );
}

export function AgentReview() {
  const [reportQuery, setReportQuery] = useSearchParams();
  const reportDate = reportQuery.get("date") || "";
  const hasDateQuery = reportQuery.has("date");
  const [expectedDate, setExpectedDate] = useState("");
  const [capturing, setCapturing] = useState(false);
  const [data, setData] = useState<ReviewData | null>(null);
  const [running, setRunning] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [stage, setStage] = useState("");
  const [jobId, setJobId] = useState("");
  const [jobDate, setJobDate] = useState("");
  const [date, setDate] = useState<string>(() => hasDateQuery ? reportDate : localDate());
  const [dates, setDates] = useState<string[]>([]);   // 跑过复盘的交易日（历史入口）
  const [missing, setMissing] = useState<string>("");  // 选了某天但那天没跑过
  const [loadingReport, setLoadingReport] = useState(false);
  const [err, setErr] = useState("");
  const [taskErr, setTaskErr] = useState("");
  // 「已复盘/还没收盘」这类不是错误、是正常告知，跟 err 分开显示
  const [notice, setNotice] = useState("");
  // polling: 防重入（React state 在同一轮渲染里读到的是旧值，双击能穿过去）
  // timer / alive: 卸载后停掉轮询，别再 setState
  // reqId: 只接受最后一次请求的响应，防止慢的旧响应覆盖新结果
  const polling = useRef(false);
  const [pendingIntent, setPendingIntent] = useState<PendingDaily | null>(readPendingDaily);
  const pendingDaily = useRef<PendingDaily | null>(pendingIntent);
  function clearPendingDaily() { pendingDaily.current = null; setPendingIntent(null); try { sessionStorage.removeItem(pendingKey); } catch { setNotice("任务状态已更新，但浏览器未清除恢复记录；刷新后请先核对进度。"); } }
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const alive = useRef(true);
  const reqId = useRef(0);
  const pendingSelection = useRef<string | null>(null);
  const adoptedDate = useRef<string | null>(null);
  const selectedDate = useRef(date);
  selectedDate.current = date;

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  /** 读复盘：不传 d 读最近一份；传 d 读那天的历史存档。 */
  async function loadLatest(d?: string) {
    const my = ++reqId.current;
    setLoadingReport(true); setData(null); setMissing(""); setErr("");
    try {
      const r = await agentFetch<ReviewData>(`/api/review/latest${d ? `?date=${d}` : ""}`);
      if (!alive.current || my !== reqId.current) return;   // 已卸载 / 有更新的请求 → 丢弃
      if (r && (r.target_date || r.trade_date)) {
        if (d && (r.target_date || r.trade_date) !== d) throw new Error("report date mismatch");
        setData(r); setMissing("");
        // 没指定日期时（首次加载）把日期框对到真正载入的那一场 ——
        // 默认值是本机今天，而复盘的对象是「最近已收盘那一场」，盘前会差一天
        if (!d) {
          selectedDate.current = r.target_date || r.trade_date || ""; setDate(selectedDate.current);
          adoptedDate.current = selectedDate.current;
          const next = new URLSearchParams(reportQuery); next.set("date", selectedDate.current);
          setReportQuery(next, { replace: true });
        }
      }
      else if (d) { setMissing(d); } // 无存档也保留选择，不能回到旧报告。
    } catch {
      if (alive.current && my === reqId.current) setErr("读取所选日期的复盘失败，请重选日期或刷新后重试。");
    } finally {
      if (alive.current && my === reqId.current) setLoadingReport(false);
    }
  }

  function chooseDate(value: string) {
    if (selectedDate.current === value) return;
    // 原生日期控件的 input 立即生效；不等待失焦后的 change。
    ++reqId.current;
    adoptedDate.current = null;
    pendingSelection.current = value;
    selectedDate.current = value; setDate(value);
    setData(null); setMissing(""); setErr(""); setNotice(""); setLoadingReport(!!value);
    // 空值也写进 URL，刷新保持待选状态，不退回最近档案。
    const next = new URLSearchParams(reportQuery); next.set("date", value);
    setReportQuery(next, { replace: true });
    if (value === reportDate) { pendingSelection.current = null; if (value) loadLatest(value); }
  }

  // 哪些交易日跑过（历史入口）；日期框旁边列出来，免得靠猜
  async function loadDates() {
    try {
      const r = await agentFetch<{ dates: string[] }>("/api/review/dates");
      if (alive.current) setDates(r.dates || []);
    } catch { /* 拿不到就不显示历史列表，不影响主流程 */ }
  }

  useEffect(() => {
    // 连续输入时，旧的路由 effect 不能覆盖刚选的新日期。
    if (pendingSelection.current !== null && pendingSelection.current !== reportDate) return;
    pendingSelection.current = null;
    if (adoptedDate.current === reportDate) { adoptedDate.current = null; return; }
    adoptedDate.current = null;
    if (hasDateQuery && !reportDate) {
      ++reqId.current; selectedDate.current = ""; setDate("");
      setData(null); setMissing(""); setLoadingReport(false); return;
    }
    const requested = /^\d{4}-\d{2}-\d{2}$/.test(reportDate) ? reportDate : undefined;
    if (requested) { selectedDate.current = requested; setDate(requested); }
    setErr(""); setNotice(""); loadLatest(requested);
  /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [reportDate, hasDateQuery]);

  useEffect(() => { loadDates();
    agentFetch<{date: string | null}>("/api/review/expected-date").then(r => { if (alive.current) setExpectedDate(r.date || ""); }).catch(() => {});
    agentRequest<DailyStatus>("/daily").then(st => {
      if (!alive.current) return;
      if (pendingDaily.current?.request_id === st.job_id) clearPendingDaily();
      if (alive.current && st.running) { polling.current = true; setRunning(true); setJobId(st.job_id || ""); pollOnce(); }
      else if (alive.current && st.error && st.date === selectedDate.current) setNotice(`${st.date} 复盘任务：${st.error}`);
    }).catch(() => { if (alive.current) setTaskErr("无法确认复盘任务状态，请刷新后再生成"); }); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  function stopPolling() {
    polling.current = false;
    if (alive.current) setRunning(false);
  }

  async function pollOnce() {
    if (!alive.current) return;
    try {
      const st = await agentRequest<DailyStatus>("/daily");
      if (!alive.current) return;
      setTaskErr("");
      if (pendingDaily.current?.request_id === st.job_id) clearPendingDaily();
      setJobDate(st.date || ""); setElapsed(st.elapsed || 0); setStage(st.stage || ""); setJobId(st.job_id || "");
      if (st.running) { setRunning(true); timer.current = setTimeout(pollOnce, 3000); return; }
      stopPolling();
      if (st.state_warning) setNotice(st.state_warning);
      if (st.error) setTaskErr(`${st.date || "上一次"} 复盘任务：${st.error}`);
      else if (st.status === "cancelled") setNotice(`${st.date || "本次"} 复盘已取消，原报告已保留。`);
      else if (st.status === "complete" && st.date) {
        loadDates();
        if (selectedDate.current === st.date) loadLatest(st.date);
        else setNotice(`${st.date} 的复盘已保存，可从历史日期打开。`);
      }
    } catch {
      if (alive.current) {
        setTaskErr("暂时无法读取进度，正在重连；不要重复生成。");
        timer.current = setTimeout(pollOnce, 5000);
      }
    }
  }

  async function generate(force = false) {
    if (running || polling.current || !date || loadingReport) return;
    if (pendingDaily.current && pendingDaily.current.date !== date) {
      setErr(`尚有 ${pendingDaily.current.date} 的启动请求未确认。请先切回该日期核对任务，当前不会生成其他日期。`);
      return;
    }
    const llm = loadAgentConnection();
    if (!llm) { setErr("请先在设置中完成「复盘与追问 AI 接入」并保存来源。"); return; }
    const source = JSON.stringify({ provider: llm.provider, model: llm.model, baseURL: llm.baseURL });
    const intent = pendingDaily.current || { date, force, source, request_id: randomId().replace(/-/g, "") };
    if (intent.source !== source) { setErr("上一次启动尚未确认，请先刷新任务状态；恢复请求需使用当时的 AI 来源。"); return; }
    try { sessionStorage.setItem(pendingKey, JSON.stringify(intent)); }
    catch { setErr("浏览器无法保存任务恢复记录，请检查存储权限后重试；尚未启动复盘。"); return; }
    pendingDaily.current = intent;
    setPendingIntent(intent);
    polling.current = true;
    setJobId(""); setJobDate(intent.date);
    setRunning(true); setErr(""); setTaskErr(""); setNotice(""); setElapsed(0); setStage("核对输入资料");
    try {
      const body = await agentRequest<DailyStatus>("/daily", {
        date: intent.date, llm, force: intent.force, request_id: intent.request_id,
      });
      clearPendingDaily();
      if (!alive.current) return;
      if (body.already_done) {
        stopPolling(); setNotice(`${body.date} 已有复盘；需要更新时可点重新生成，原版本会保留。`);
        if (body.date && selectedDate.current === body.date) loadLatest(body.date);
        return;
      }
      setJobId(body.job_id || ""); pollOnce();
    } catch (error) {
      if (error instanceof AgentRequestError && [400, 401, 403, 404, 409, 413, 415, 422].includes(error.status)) {
        clearPendingDaily(); stopPolling();
        if (alive.current) setErr(error.message);
      } else {
        if (alive.current) setErr("启动响应未收到，正在核对后台；再次点击将恢复同一请求，不会重复生成。");
        pollOnce();
      }
    }
  }

  async function cancelDaily() {
    try {
      await agentRequest("/daily/cancel", { job_id: jobId });
      if (alive.current) setStage("正在停止；原报告会保留");
    } catch (error) {
      if (alive.current) setTaskErr(error instanceof Error ? error.message : "取消失败，请刷新进度");
    }
  }

  const focus = data?.focus;
  // 页面按"用户复盘的顺序"重排后，各卡片散在不同区块里，这里统一取一次
  const facts = data?.market_facts;
  const em = splitMetrics(data?.emotion_metrics);
  const caliberWarnings: string[] = [];
  const matrixFirst = facts?.feedback_matrix?.matrix?.['首板'];
  const promotionFirst = em.pr?.tiers?.['1'];
  if (matrixFirst && promotionFirst && matrixFirst['合计'] === promotionFirst.base && matrixFirst['晋级涨停'] !== promotionFirst.promoted)
    caliberWarnings.push(`这份历史快照的首板反馈为 ${matrixFirst['晋级涨停']}/${matrixFirst['合计']}，池成员晋级为 ${promotionFirst.promoted}/${promotionFirst.base}。旧报告采用不同判定，不能合并解释；重新生成会统一使用同一份东财池快照，旧版仍保留。`);
  if (em.zt != null && facts?.seal_quality?.total != null && em.zt !== facts.seal_quality.total)
    caliberWarnings.push('这份报告的涨停计数与封板质量样本不一致，请按各自标注的样本阅读，重新生成可复核来源。');

  return (
    <div className="space-y-6">
      {expectedDate && expectedDate !== date && <p className="rounded-lg border border-primary/30 p-3 text-sm">最近已收盘交易日为 {expectedDate}。<button className="ml-2 text-primary underline" disabled={running} onClick={() => chooseDate(expectedDate)}>查看这一天</button> · 没有报告时，点击“生成复盘”。</p>}
      {data && <details className="rounded-xl border border-border p-4"><summary className="cursor-pointer text-sm">上期核验与历史观察记录（截至 {date}）</summary>
        <p className="my-2 text-xs text-muted-foreground">记录市场判断的验证结果，不是交易收益或模型盈利能力。</p>
        {data.reflection ? <p className="text-sm">{data.reflection.prediction_date} 的观察 → {data.reflection.eval_date} 核验：{data.reflection.phase_eval?.hit === true ? "方向符合" : data.reflection.phase_eval?.hit === false ? "方向不符合" : "未分胜负或资料不足"}</p> : <p className="text-sm">尚无可核验的上期记录；需要先有预测，再取得对应次日数据。</p>}
        {data.scoreboard && <p className="mt-2 text-sm">方向符合 {data.scoreboard.phase.hits} / {data.scoreboard.phase.decided} 次 · 持平未计入 {data.scoreboard.phase.flat} 次{!data.scoreboard.phase.enough_samples && ' · 样本不足，不展示醒目命中率'}</p>}
        <button disabled={capturing || running} className="mt-3 rounded border border-border px-3 py-2 text-sm disabled:opacity-50" onClick={async () => { setCapturing(true); try { const r = await agentPost<{ok:boolean;results:Record<string,{ok:boolean;reason?:string}>}>(`/api/review/capture?date=${date}`, {}); setNotice(Object.entries(r.results).map(([k,v]) => `${k}：${v.ok ? '已处理' : '未完成'}${v.reason ? '（'+v.reason+'）' : ''}`).join('；')); await loadLatest(date); } catch(e) { setNotice(e instanceof Error ? e.message : '归档失败'); } finally { setCapturing(false); } }}> {capturing ? '正在补归档与回评…' : '补归档与回评（不重新调用 AI）'} </button>
      </details>}
      {caliberWarnings.map(w => <p key={w} role="status" className="rounded-xl border border-warning/40 bg-warning/10 p-4 text-sm text-warning">{w}</p>)}
      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold">
            <Swords className="h-6 w-6 text-primary" /> 短线复盘看板
          </h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            情绪温度 · 明日验证条件
            {data && ` · 交易日 ${data.target_date || data.trade_date} · 生成于 ${data.generated_at}`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex flex-col items-start">
            <label htmlFor="review-date" className="mb-1 text-xs text-muted-foreground">选择复盘日期（可选未生成的日期）</label>
            <input id="review-date" type="date" value={date}
              onInput={(e) => chooseDate(e.currentTarget.value)}
              onChange={(e) => chooseDate(e.currentTarget.value)}
              className="rounded-lg border border-border bg-card px-3 py-2 text-sm" />
            {/* 跑过的日子直接列出来 —— 不然用户只能靠猜哪天有存档 */}
            {dates.length > 0 && (
              <div className="mt-1 flex flex-wrap gap-1 text-[10px] text-muted-foreground">
                <span>已存报告：</span>
                {dates.slice(0, 5).map((d) => (
                  <button key={d} onClick={() => { if (d === date) loadLatest(d); else chooseDate(d); }}
                    className={`rounded px-1.5 py-0.5 transition-colors hover:text-primary ${
                      (data?.target_date || data?.trade_date) === d ? "bg-primary/15 text-primary" : "bg-muted/40"
                    }`}>{d.slice(5)}</button>
                ))}
              </div>
            )}
          </div>
          <button onClick={() => generate()} disabled={running || !date || loadingReport}
            className="flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50">
            {running && <Loader2 className="h-4 w-4 animate-spin" />}
            {running ? `复盘中 ${elapsed}s` : "生成复盘"}
          </button>
          {!running && data && <button onClick={() => generate(true)} className="rounded-lg border border-border px-3 py-2 text-sm">重新生成</button>}
          {running && jobId && <button onClick={cancelDaily} className="rounded-lg border border-border px-3 py-2 text-sm">取消复盘</button>}
        </div>
      </div>
      {running && <p role="status" className="text-sm text-muted-foreground">复盘日期 {jobDate} · {stage} · 刷新页面可继续查看进度</p>}

      {err && <div role="alert" className="glass rounded-xl border-danger/30 px-4 py-3 text-sm text-danger">出错：{err}</div>}
      {taskErr && <div role="status" className="glass rounded-xl border-danger/30 px-4 py-3 text-sm text-danger">{taskErr}</div>}
      {!running && pendingIntent && <div role="status" className="glass rounded-xl px-4 py-3 text-sm text-muted-foreground">
        {pendingIntent.date} 的启动请求尚未确认，切回该日期再点「生成复盘」将恢复同一请求。
        <button onClick={() => chooseDate(pendingIntent.date)} className="ml-2 text-primary">查看待确认日期</button>
      </div>}
      {notice && <div className="glass rounded-xl border-primary/30 px-4 py-3 text-sm text-muted-foreground">{notice}</div>}
      {data?.warnings?.length ? (
        <div className="rounded-xl border border-warning/30 bg-warning/10 px-4 py-2.5 text-[13px] text-warning">
          <p className="font-medium">本报告有数据缺口</p>
          <ul className="mt-1 list-inside list-disc space-y-1">
            {reviewWarningMessages(data.warnings).map(w => <li key={w}>{w}</li>)}
          </ul>
          <p className="mt-2 text-xs">以上是报告生成时的数据状态，与当前 AI 是否连接是两回事。补齐数据接入后，需要重新生成才能更新这份复盘。</p>
          <details className="mt-2 text-xs">
            <summary className="cursor-pointer">查看原始数据诊断</summary>
            <div className="mt-2 space-y-1 break-words">{data.warnings.map((w, i) => <p key={i}>{w}</p>)}</div>
          </details>
        </div>
      ) : null}

      {!data && (!running || jobDate !== date) && (
        <div className="glass rounded-2xl py-16 text-center text-muted-foreground">
          {loadingReport ? <>正在读取 {date} 的复盘…</> : missing
            ? <>{missing} 这天还没跑过复盘。<div className="mt-1 text-xs">点「生成复盘」补跑，或换一个日期</div></>
            : <>还没有复盘。选个交易日，点「生成复盘」。<div className="mt-1 text-xs">生成需要数分钟，所用 AI 与资料量会影响时长；离开页面后可回来继续查看进度。</div></>}
        </div>
      )}

      {}

      {data && <>
      {/* ① 今天好不好做 */}
      {}
      <BreadthPanel b={facts?.breadth} limitDown={facts?.loss_effect?.market_limit_down} />

      {/* ② 昨天进去的人今天赚不赚钱 —— 用户说这是全页最有用的一块，所以提到第二位 */}
      <section className="space-y-4">
        <div className="text-[11px] font-bold uppercase tracking-[0.2em] text-primary">
          昨天进去的人赚不赚钱 · Feedback
        </div>
        <Matrix fm={facts?.feedback_matrix} />
        <div className="grid gap-4 md:grid-cols-2">
          <MoneyEffectCard me={em.me} />
          <LossEffectSection le={facts?.loss_effect} />
        </div>
      </section>

      {/* ③ 接力生态 —— 原来散在四处的四张卡合成一块 */}
      <section className="space-y-4">
        <div className="flex flex-wrap items-baseline gap-x-3">
          <span className="text-[11px] font-bold uppercase tracking-[0.2em] text-primary">接力生态 · Ladder</span>
          {em.prevDate && em.zt != null && em.ztPrev != null && (
            <span className="text-[11px] text-muted-foreground">
              对照 {em.prevDate} · 涨停家数 {em.ztPrev} → <b className="tabular-nums text-foreground">{em.zt}</b>
            </span>
          )}
        </div>
        <div className="grid gap-4 md:grid-cols-3">
          <PromotionCard pr={em.pr} />
          <LadderCard lg={em.lg} />
          <ConsecPremiumCard cp={em.cp} />
        </div>
        <SealQualitySection sq={facts?.seal_quality} />
      </section>

      {/* ④ 钱往哪去 —— 题材事件树（明细）+ 题材结构（汇总）合并成一块，
          用户说这两块"在讲相近的事"，分开看要来回找 */}
      <section className="space-y-4">
        <div className="text-[11px] font-bold uppercase tracking-[0.2em] text-primary">钱往哪去 · Themes</div>
        <ThemeTreeView t={facts?.theme_tree} />
        <Themes ts={facts?.theme_structure} />
      </section>

      {/* ⑤ 今天风险在哪 —— 事件账本按方向拆开，亏钱那堆在前 */}
      <section className="space-y-4">
        <div className="text-[11px] font-bold uppercase tracking-[0.2em] text-primary">今天风险在哪 · Risk</div>
        <Ledger el={facts?.event_ledger} />
        <BoardSystemSection bb={facts?.by_board} />
      </section>

      {/* ⑥ 跟前几天比在什么位置 */}
      <section className="space-y-4">
        <div className="text-[11px] font-bold uppercase tracking-[0.2em] text-primary">跟前几天比 · Trend</div>
        <TrendPanel t={facts?.trend} />
        <div className="grid gap-4 lg:grid-cols-2">
          <StatsView c={facts?.stats_context} />
          <DiffView d={facts?.day_diff} />
        </div>
        <CycleCard cy={em.cy} />
      </section>

      {/* AI 研判（放在事实之后）*/}
      <GroundedAnalysis key={data?.generated_at} report={data?.report_grounding} />
      {focus && (
        <section>
          <div className="mb-2 text-[11px] font-bold uppercase tracking-[0.2em] text-primary">明天关注点 · Tomorrow</div>
          <div className="glass rounded-2xl p-6 shadow-glow">
            <div className="mb-3 flex flex-wrap items-center gap-4">
              <span className={cn("rounded-full px-4 py-1.5 text-sm font-bold tracking-wider", phaseTone(focus.emotion_phase))}>
                {focus.emotion_phase}
              </span>
              <div className="flex-1 text-lg font-semibold">
                {focus.market_oneliner}
                <EvidenceReferences finding={data?.report_grounding?.summary.market_oneliner} report={data?.report_grounding} />
              </div>
            </div>
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
              {safeArray<FocusDirection>(focus.focus_directions).map((d, i) => (
                <div key={i} className="rounded-xl border border-border border-l-4 border-l-primary bg-card/50 p-4">
                  <h3 className="mb-1.5 text-base font-bold">{d.direction}</h3>
                  <p className="mb-3 text-sm text-muted-foreground">{d.logic}</p>
                  <EvidenceReferences finding={data?.report_grounding?.summary.focus_directions[i]?.logic} report={data?.report_grounding} />
                  {safeArray<string>(d.leader_candidates).length > 0 && (
                    <div className="mb-2.5 flex flex-wrap gap-1.5">
                      {safeArray<string>(d.leader_candidates).map((l, j) => (
                        <span key={j} className="rounded-full bg-primary/10 px-2.5 py-0.5 text-xs font-medium text-primary">{l}</span>
                      ))}
                    </div>
                  )}
                  <div className="border-t border-dashed border-border pt-2 text-xs text-muted-foreground">
                    <span className="font-semibold text-danger">风险</span> {d.risk}
                    <EvidenceReferences finding={data?.report_grounding?.summary.focus_directions[i]?.risk} report={data?.report_grounding} />
                  </div>
                </div>
              ))}
            </div>
            <div className="mt-5 grid gap-5 md:grid-cols-2">
              <div className="border-t-2 border-foreground pt-2.5">
                <h4 className="mb-1.5 flex items-center gap-1.5 text-sm font-bold"><AlertTriangle className="h-4 w-4 text-warning" /> 风险提示</h4>
                <ul className="ml-4 list-disc space-y-1 text-[13px] text-muted-foreground">
                  {safeArray<string>(focus.risk_alerts).map((r, i) => <li key={i}>{r}
                    <EvidenceReferences finding={data?.report_grounding?.summary.risk_alerts[i]} report={data?.report_grounding} />
                  </li>)}
                </ul>
              </div>
            </div>

            {}
            {safeArray<VerificationItem>(focus.verification_items).length > 0 && (
              <div className="mt-5 border-t-2 border-foreground pt-2.5">
                <h4 className="mb-2 flex items-center gap-1.5 text-sm font-bold">
                  <CheckSquare className="h-4 w-4 text-info" /> 明日验证条件
                  {}
                  <span className="text-[11px] font-normal text-muted-foreground">
                    明天用这几个读数检验今晚的判断，明天回来自己对一下
                  </span>
                </h4>
                <div className="flex flex-wrap gap-2">
                  {safeArray<VerificationItem>(focus.verification_items).map((v, i) => (
                    <div key={i} className="flex-1 basis-[240px] rounded-lg border border-border bg-muted/20 px-3 py-2">
                      <div className="text-[13px] font-semibold">
                        {v.label || METRIC_LABEL[v.metric] || v.metric}
                        {}
                        <span className={cn("ml-1.5 rounded px-1.5 py-0.5 text-[11px] font-bold",
                          v.direction === "上升" ? "bg-danger/15 text-danger"
                            : v.direction === "下降" ? "bg-success/15 text-success"
                            : "bg-muted text-muted-foreground")}>核验方向：{v.direction}</span>
                      </div>
                      {/* 今日基准 + 阈值：只写"核验方向：下降"的话，明天从多少降到多少才算降？
                          没有这两个数，第二天只能凭感觉，而凭感觉怎么变都能自圆其说。 */}
                      {finite(v.base_value) != null && (
                        <div className="mt-1 text-[11px] tabular-nums text-foreground/70">
                          今日 <b className="text-foreground">{statText(v)}</b>
                          {epsText(v) && <> · 明天变动超过 {epsText(v)} 才算数</>}
                        </div>
                      )}
                      <div className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">{v.reason}</div>
                      <EvidenceReferences finding={data?.report_grounding?.summary.verification_items.find(item => item.metric === v.metric)?.reason} report={data?.report_grounding} />
                    </div>
                  ))}
                </div>
                <UserConditions date={data?.target_date || data?.trade_date || ""} />
              </div>
            )}
          </div>
        </section>
      )}

      {}

      {data && (
        <ReviewAgentChat
          // 换交易日即重建组件，避免旧对话串到新复盘
          key={data.target_date || data.trade_date}
          anchor={data.target_date || data.trade_date || ""}
        />
      )}

      {data && <p className="border-t border-border pt-4 text-xs text-muted-foreground/70"><Target className="mr-1 inline h-3 w-3" /> {DISCLAIMER}</p>}
      </>}
    </div>
  );
}
