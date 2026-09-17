import { randomId } from "@/lib/random-id";
import { useSearchParams } from 'react-router-dom';
import { useEffect, useRef, useState } from "react";
import { Microscope, Loader2, Target, Square } from "lucide-react";
import { agentRequest, AgentRequestError, loadAgentConnection, type AgentConnection } from "@/lib/agent-api";
import { useWorkspace } from "@/lib/workspace/state";
import { AgentChat } from "@/components/AgentChat";
import { agentFetch, safeArray, type DeepDiveData, type JobStatus } from "@/lib/agent";

const DISCLAIMER =
  "本页由多 agent AI 基于公开数据现场生成，结论为 AI 判断，仅供参考，不构成投资建议；市场有风险，决策与盈亏自负。";

export function DeepDive() {
  const workspace = useWorkspace();
  const [section, setSection] = useState("summary");
  const [data, setData] = useState<DeepDiveData | null>(null);
  const [symbolQuery, setSymbolQuery] = useSearchParams();
  const stock = symbolQuery.get('symbol') || '';
  const setStock = (value: string) => setSymbolQuery(previous => {
    const next = new URLSearchParams(previous);
    if (value) next.set('symbol', value); else next.delete('symbol');
    return next;
  }, { replace: true });
  const [running, setRunning] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [msg, setMsg] = useState("");
  const [stage, setStage] = useState("");
  const [jobId, setJobId] = useState("");
  const [recovery, setRecovery] = useState(false);
  const polling = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const alive = useRef(true);
  const displayRevision = useRef(0);
  const acceptedKey = "astock-deepdive-accepted";
  const target = useRef(sessionStorage.getItem(acceptedKey) || "");
  type Job = JobStatus & { job_id?: string; stage?: string; status?: string; state_warning?: string };
  type Pending = { stock: string; request_id: string; llm: AgentConnection };
  const pendingKey = "astock-deepdive-pending";

  async function loadLatest() {
    const revision = ++displayRevision.current;
    try {
      const d = await agentFetch<DeepDiveData>("/api/deepdive/latest");
      if (alive.current && revision === displayRevision.current && d?.code) setData(d);
    } catch { if (alive.current) setMsg("读取上次深挖失败；原报告仍保留"); }
  }

  async function pollOnce() {
    if (!alive.current) return;
    try {
      const st = await agentRequest<Job>(`/deepdive${target.current ? `?job_id=${target.current}` : ""}`);
      if (!alive.current) return;
      if (st.job_id && !target.current) { target.current = st.job_id; sessionStorage.setItem(acceptedKey, st.job_id); }
      setJobId(st.job_id || ""); setElapsed(st.elapsed || 0); setStage(st.stage || "");
      setRunning(Boolean(st.running)); polling.current = Boolean(st.running);
      if (st.running) { timer.current = setTimeout(pollOnce, 1500); return; }
      if (st.job_id && st.status === "complete") {
        const revision = ++displayRevision.current;
        const report = await agentRequest<DeepDiveData>(`/deepdive/reports/${st.job_id}`);
        if (alive.current && revision === displayRevision.current) setData(report);
      }
      if (alive.current) setMsg(st.error || st.state_warning || "");
    } catch {
      polling.current = false;
      if (alive.current) { setRunning(false); setMsg("状态读取失败；任务可能仍在进行，请恢复查询，勿重新生成"); setRecovery(true); }
    }
  }

  useEffect(() => {
    alive.current = true;
    void loadLatest();
    if (sessionStorage.getItem(pendingKey)) setRecovery(true);
    void pollOnce();
    return () => { alive.current = false; if (timer.current) clearTimeout(timer.current); };
    // Restoration only reads state; it never starts a paid run.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function deepdive(retry = false) {
    if (polling.current) return;
    let body: Pending;
    if (retry) {
      try { body = JSON.parse(sessionStorage.getItem(pendingKey) || "null"); }
      catch { setMsg("待恢复请求已损坏，请重新选择标的"); return; }
      if (!body) { setRecovery(false); void pollOnce(); return; }
    } else {
      const llm = loadAgentConnection();
      if (!llm) { workspace.connect(); return; }
      if (!stock.trim() || stock.trim().length > 40) { setMsg("请输入 40 字以内的代码或准确简称"); return; }
      body = { stock: stock.trim(), request_id: randomId().replace(/-/g, ""), llm };
      try { sessionStorage.setItem(pendingKey, JSON.stringify(body)); }
      catch { setMsg("无法保存任务恢复标识，未发起深挖"); return; }
    }
    polling.current = true; setRunning(true); setMsg("");
    try {
      const st = await agentRequest<Job>("/deepdive", body);
      if (st.job_id) { target.current = st.job_id; sessionStorage.setItem(acceptedKey, st.job_id); }
      sessionStorage.removeItem(pendingKey);
      if (!alive.current) return;
      setRecovery(false); setJobId(st.job_id || "");
      await pollOnce();
    } catch (error) {
      polling.current = false;
      if (error instanceof AgentRequestError && error.status >= 400 && error.status < 500) {
        sessionStorage.removeItem(pendingKey);
        if (alive.current) { setRunning(false); setRecovery(false); setMsg(error.message); }
        return;
      }
      if (alive.current) { setRunning(false); setRecovery(true); setMsg(`${error instanceof Error ? error.message : "响应中断"}；可用同一请求恢复，避免重复调用`); }
    }
  }

  async function cancel() {
    if (!jobId) return;
    try {
      const st = await agentRequest<Job>("/deepdive/cancel", { job_id: jobId });
      if (alive.current) setStage(st.stage || "正在停止");
    } catch (error) { if (alive.current) setMsg(error instanceof Error ? error.message : "取消未确认，请重新查询"); }
  }

  const sectionText = !data ? "" : section === "summary" ? data.verdict_md || JSON.stringify(data.verdict || {})
    : section === "debate" ? `${data.debate?.join || ""}\n${data.debate?.avoid || ""}`
    : data.reports?.[section as 'theme'|'capital'|'technical'|'risk'] || "本节没有可用资料";
  const plainSection = sectionText.replace(/<[^>]+>/g,' ');
  const reportContext = data ? `当前选中报告：${data.name}（${data.code}），生成于${data.generated_at}。章节：${section}。\n`
    + plainSection.slice(0,7500) + (plainSection.length>7500 ? '\n[本节仅提供前7500字，后续内容未进入本次问答]' : '') : '';
  const v = data?.verdict;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold"><Microscope className="h-6 w-6 text-primary" /> 多空辩论</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            题材、资金、技术、风险四类分析 → 多空双方论证与证据核对
            {data && ` · ${data.name}（${data.code}）· 生成于 ${data.generated_at}`}
            {data?.ai_source && ` · ${data.ai_source.provider} / ${data.ai_source.model}`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <input value={stock} onChange={(e) => setStock(e.target.value)} onKeyDown={(e) => e.key === "Enter" && !e.nativeEvent.isComposing && !recovery && deepdive()}
            maxLength={40} placeholder="代码或简称，如 立新能源 / 001258"
            className="w-56 rounded-lg border border-border bg-card px-3 py-2 text-sm" />
          <button onClick={() => deepdive()} disabled={running || recovery}
            className="flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50">
            {running && <Loader2 className="h-4 w-4 animate-spin" />}
            {running ? `深挖中 ${elapsed}s` : "开始多空辩论"}
          </button>
        </div>
      </div>

      <p className="text-xs text-muted-foreground">本次任务使用已保存的 AI 来源获取公开资料并执行四维分析与辩论，不改变首页 Agent 开关。{stage && `当前阶段：${stage}`}</p>
      {!running && <button onClick={() => { target.current = ""; sessionStorage.removeItem(acceptedKey); void loadLatest(); void pollOnce(); }} className="rounded-lg border border-border px-3 py-2 text-sm">查看最近完成报告</button>}
      {running && <button onClick={cancel} className="flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm"><Square size={14} />取消本次深挖</button>}
      {recovery && !running && <button onClick={() => deepdive(true)} className="rounded-lg border border-border px-3 py-2 text-sm">恢复本次请求 / 查询状态</button>}
      {msg && <div className="glass rounded-xl px-4 py-3 text-sm text-muted-foreground">{msg}</div>}

      {!data && !running && (
        <div className="glass rounded-2xl py-16 text-center text-muted-foreground">
          输入一只票，点「开始多空辩论」。<div className="mt-1 text-xs">4 分析师 + 多空辩论，约 2-3 分钟</div>
        </div>
      )}

      {v && (
        <section>
          <div className="mb-2 text-[11px] font-bold uppercase tracking-[0.2em] text-primary">深挖结论 · Verdict</div>
          <div className="glass rounded-2xl p-6 shadow-glow">
            <div className="mb-3 flex flex-wrap items-center gap-4">
              <span className="flex-1 text-lg font-semibold">{v.one_liner}</span>
            </div>
            {(v.stance || safeArray(v.watch_points).length > 0) && (
              <p className="mb-3 text-sm text-muted-foreground">这份旧记录含当前版本不再展示的操作倾向字段，原记录保留。可重新生成以使用当前研究规则；旧正文尚未重新校验。</p>
            )}
            <div className="my-4 grid gap-3.5 sm:grid-cols-3">
              {([["题材", v.theme], ["资金", v.capital], ["技术", v.technical]] as const).map(([k, val]) => (
                <div key={k} className="border-l-2 border-border pl-3 text-sm">
                  <div className="mb-0.5 text-xs font-semibold uppercase tracking-wider text-primary">{k}</div>{val}
                </div>
              ))}
            </div>
            <div className="grid gap-5 md:grid-cols-2">
              <div>
                <h4 className="mb-1.5 text-sm font-bold text-danger">⚠ 风险</h4>
                <ul className="ml-4 list-disc space-y-1 text-[13px] text-muted-foreground">
                  {safeArray<string>(v.risks).length
                    ? safeArray<string>(v.risks).map((r, i) => <li key={i}>{r}</li>)
                    : <li className="list-none text-muted-foreground/60">暂无结构化风险项</li>}
                </ul>
              </div>
            </div>
            <div className="mt-4 border-t border-border pt-3">
              <h4 className="mb-1 text-sm font-bold">⚔ 多空辩论</h4>
              <p className="text-[13px] text-muted-foreground">{v.debate_takeaway}</p>
            </div>
          </div>
        </section>
      )}

      {data?.reports && (
        <section>
          <div className="mb-2 text-[11px] font-bold uppercase tracking-[0.2em] text-primary">四维分析 · Analysts</div>
          <div className="grid gap-4 md:grid-cols-2">
            {([["题材归属", "theme"], ["资金流向", "capital"], ["技术形态", "technical"], ["风险排查", "risk"]] as const).map(([t, k]) => (
              <div key={k} className="glass rounded-2xl p-5">
                <span className="mb-2 inline-block rounded bg-muted px-2 py-0.5 text-xs font-bold text-foreground/80">{t}</span>
                <div className="prose prose-sm max-w-none text-[13px]" dangerouslySetInnerHTML={{ __html: data.reports![k] || "<p>—</p>" }} />
              </div>
            ))}
          </div>
        </section>
      )}

      {data?.debate && (data.debate.join || data.debate.avoid) && (
        <section>
          <div className="mb-2 text-[11px] font-bold uppercase tracking-[0.2em] text-primary">多空辩论 · Debate</div>
          <div className="grid gap-4 md:grid-cols-2">
            <div className="rounded-2xl border border-success/30 bg-success/5 p-5">
              <div className="mb-2 font-extrabold text-success">▲ 正方</div>
              <div className="prose prose-sm max-w-none text-[13px]" dangerouslySetInnerHTML={{ __html: data.debate.join || "<p>—</p>" }} />
            </div>
            <div className="rounded-2xl border border-danger/30 bg-danger/5 p-5">
              <div className="mb-2 font-extrabold text-danger">▼ 反方</div>
              <div className="prose prose-sm max-w-none text-[13px]" dangerouslySetInnerHTML={{ __html: data.debate.avoid || "<p>—</p>" }} />
            </div>
          </div>
        </section>
      )}

      {data && <label className="block text-sm">追问使用的报告章节<select value={section} onChange={e=>setSection(e.target.value)} className="ml-3 rounded-lg border border-border bg-card px-3 py-2">{[['summary','深挖结论'],['theme','题材归属'],['capital','资金流向'],['technical','技术形态'],['risk','风险排查'],['debate','正反辩论']].map(([id,label])=><option key={id} value={id}>{label}</option>)}</select>{plainSection.length>7500 && <span className="ml-3 text-xs text-muted-foreground">本节较长，本次提供前7500字。</span>}</label>}
      {data && (
        <AgentChat
          // 换标的即重建组件，别把上一只票的问答串进新上下文
          key={`${data.code}-${data.generated_at}-${section}`}
          context={reportContext}
          placeholder={`就 ${data.name || "这只票"} 追问，如：今天的资金和题材说明什么`}
          suggestions={["今天的量能和换手说明什么", "技术位置处在什么区间", "和同板块其他涨停股比资金强度如何", "这类票历史上涨停后的表现统计"]}
        />
      )}

      {data && <details className="glass my-4 rounded-xl p-4"><summary>查看本次冻结资料与数据时点</summary>
        <p className="my-2 text-xs text-muted-foreground">用于核对模型是否正确引用。存在引用不代表推论已经证实；龙虎榜不同窗口不能直接相加。</p>
        {data.input_sources?.length ? data.input_sources.map(source => <details key={`${source.input}:${source.sha256}`} className="my-2"><summary>{source.input} · {new Date(source.fetched_at * 1000).toLocaleString('zh-CN', {timeZone:'Asia/Shanghai',hour12:false})} 北京时间</summary><pre className="whitespace-pre-wrap break-words text-xs">{typeof source.value === 'string' ? source.value : JSON.stringify(source.value, null, 2)}</pre></details>) : <p>旧报告未保存逐项资料；请重新生成以取得可核对的输入。</p>}
      </details>}
      {data && <p className="border-t border-border pt-4 text-xs text-muted-foreground/70"><Target className="mr-1 inline h-3 w-3" /> {DISCLAIMER}</p>}
    </div>
  );
}
