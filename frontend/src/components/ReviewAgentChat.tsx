import { randomId } from "@/lib/random-id";
import { useEffect, useRef, useState } from "react";
import { Loader2, MessageCircle, Send, Square } from "lucide-react";
import { Link } from "react-router-dom";
import { authHeaders } from "@/lib/api";
import { apiUrl } from "@/lib/base";
import { loadAgentConnection } from "@/lib/agent-api";
import { AgentObservations } from "@/components/AgentObservations";

export type Evidence = {
  id: string; kind: string; label: string; date: string; first_date?: string;
  display?: string; text?: string; source: string; source_file?: string;
  source_sha256?: string; note: string; inputs?: string[];
  metric?: string; available?: boolean; fetched_at?: string; source_url?: string;
};
type Answer = { status: string; findings: { text: string; citations: string[] }[]; gaps: string[]; evidence: Evidence[]; format_corrections?: number };
type Turn = { id: string; question: string; status: string; conversation_id: string; result: Answer | null;
  error: string | null; events: { message: string }[] };
type Summary = { id: string; title: string };
type Target = { sector: string; stocks: { code: string; name: string }[] };
type Conversation = Summary & { anchor: string; dates: string[]; revision: string; turns: Turn[]; source: { provider: string; model: string }; context: { allow_network: boolean; symbol: string }; targets: Target[] };
type Health = { installed: boolean; subscription_ready: boolean; engine: string; default_model: string };

async function request<T>(path: string, signal: AbortSignal, body?: unknown): Promise<T> {
  const response = await fetch(apiUrl(`/api/review-agent${path}`), {
    method: body === undefined ? "GET" : "POST", signal,
    headers: { ...authHeaders(), ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(typeof data.detail === "string" ? data.detail : `请求失败（${response.status}）`);
  return data as T;
}

export function EvidenceCard({ evidence, all }: { evidence: Evidence; all: Evidence[] }) {
  return <details className="min-w-0 rounded-xl border border-border bg-background p-3 text-xs">
    <summary className="cursor-pointer break-words leading-relaxed">
      {evidence.first_date ? `${evidence.first_date} → ` : ""}{evidence.date} · {evidence.label}
      {evidence.display && <strong className="ml-2 text-sm">{evidence.display}</strong>}
      {evidence.kind === "narrative" && <span className="ml-2 text-muted-foreground">AI 叙述线索</span>}
    </summary>
    <div className="mt-3 space-y-2 break-words text-muted-foreground">
      <p>{evidence.note}</p><p>{evidence.source} {evidence.source_file}</p>
      {evidence.fetched_at && <p>获取时间：{evidence.fetched_at}</p>}
      {evidence.source_url?.startsWith("https://web.ifzq.gtimg.cn/") && <a href={evidence.source_url} target="_blank" rel="noreferrer" className="text-primary underline">查看行情来源</a>}
      {evidence.inputs?.map(id => {
        const input = all.find(e => e.id === id);
        return <p key={id}>计算输入：{input ? `${input.date} · ${input.label} · ${input.display}` : "输入未覆盖"}</p>;
      })}
      {evidence.text && <p className="max-h-48 overflow-auto whitespace-pre-wrap">{evidence.text}</p>}
      <p className="break-all">证据编号：{evidence.id}</p>
      {evidence.source_sha256 && <p className="break-all">快照校验值：{evidence.source_sha256}</p>}
    </div>
  </details>;
}

export function ReviewAgentChat({ anchor }: { anchor: string }) {
  const [health, setHealth] = useState<Health | null>(null);
  const [conversations, setConversations] = useState<Summary[]>([]);
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [input, setInput] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [loading, setLoading] = useState(true);
  const [network, setNetwork] = useState(false);
  const [symbol, setSymbol] = useState("");
  const [sector, setSector] = useState("");
  const [targets, setTargets] = useState<Target[]>([]);
  const controller = useRef(new AbortController());
  const busy = useRef(false);
  const selection = useRef(0);
  const retry = useRef<{ question: string; conversation: string | null; source: string; id: string } | null>(null);
  const running = conversation?.turns.find(t => t.status === "running");

  useEffect(() => {
    if (conversation) {
      setNetwork(conversation.context?.allow_network || false);
      setSymbol(conversation.context?.symbol || "");
    }
  }, [conversation?.id]);

  useEffect(() => {
    const abort = new AbortController();
    controller.current = abort;
    let live = true;
    (async () => {
      try {
        const [status, list, catalog] = await Promise.all([
          request<Health>("/status", abort.signal),
          request<Summary[]>(`/conversations?anchor=${encodeURIComponent(anchor)}`, abort.signal),
          request<{ targets: Target[] }>(`/catalog?anchor=${encodeURIComponent(anchor)}`, abort.signal).catch(() => ({ targets: [] })),
        ]);
        if (!live) return;
        setHealth(status); setConversations(list); setTargets(catalog.targets);
        if (list[0]) {
          const saved = await request<Conversation>(`/conversations/${list[0].id}`, abort.signal);
          if (live) setConversation(saved);
        }
      } catch (e) {
        if (live) setError(e instanceof Error ? e.message : "加载失败");
      } finally { if (live) setLoading(false); }
    })();
    return () => { live = false; abort.abort(); };
  }, [anchor]);

  useEffect(() => {
    if (!running) return;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const turn = await request<Turn>(`/turns/${running.id}`, abort.signal);
        if (abort.signal.aborted) return;
        setError("");
        setConversation(prev => prev?.id === turn.conversation_id
          ? { ...prev, turns: prev.turns.map(t => t.id === turn.id ? turn : t) } : prev);
        if (turn.status === "running") timer = setTimeout(poll, 1500);
      } catch {
        if (!abort.signal.aborted) {
          setError("暂时无法读取任务状态；正在重连，结果会保留。");
          timer = setTimeout(poll, 3000);
        }
      }
    };
    timer = setTimeout(poll, 500);
    return () => { abort.abort(); clearTimeout(timer); };
  }, [running?.id]);

  async function choose(id: string) {
    const version = ++selection.current;
    setError("");
    if (!id) { setConversation(null); return; }
    setLoading(true);
    try {
      const saved = await request<Conversation>(`/conversations/${id}`, controller.current.signal);
      if (version === selection.current) setConversation(saved);
    } catch (e) { if (version === selection.current) setError(e instanceof Error ? e.message : "加载失败"); }
    finally { if (version === selection.current) setLoading(false); }
  }

  async function send(question = input) {
    const text = question.trim();
    if (!text || busy.current || running || loading) return;
    const dedicated = loadAgentConnection();
    const llm = dedicated;
    if (!llm) { setError("请先到「接入 AI」选择并测试工作台 AI 来源。"); return; }
    if (!llm.model.trim()) { setError("请先到「接入 AI」选择并测试可用模型。"); return; }
    const cid = conversation?.id ?? null;
    const source = JSON.stringify({ provider: llm.provider, model: llm.model, baseURL: llm.baseURL, network, symbol });
    if (!retry.current || retry.current.question !== text || retry.current.conversation !== cid || retry.current.source !== source) {
      retry.current = { question: text, conversation: cid, source, id: randomId().replace(/-/g, "") };
    }
    busy.current = true; setPending(true); setError("");
    try {
      const turn = await request<Turn>("/turns", controller.current.signal, {
        anchor, question: text, request_id: retry.current.id, conversation_id: cid, llm, scope: { allow_network: network, symbol },
      });
      const saved = await request<Conversation>(`/conversations/${turn.conversation_id}`, controller.current.signal);
      setConversation(saved); setInput(""); retry.current = null;
      setConversations(prev => prev.some(c => c.id === saved.id) ? prev : [{ id: saved.id, title: saved.title }, ...prev]);
    } catch (e) {
      if (!controller.current.signal.aborted) setError(e instanceof Error ? e.message : "请求失败；可重试同一问题");
    } finally { busy.current = false; setPending(false); }
  }

  async function cancel() {
    if (!running) return;
    try {
      const turn = await request<Turn>(`/turns/${running.id}/cancel`, controller.current.signal, {});
      setConversation(prev => prev ? { ...prev, turns: prev.turns.map(t => t.id === turn.id ? turn : t) } : prev);
    } catch (e) { setError(e instanceof Error ? e.message : "取消失败"); }
  }

  return <section aria-label="复盘 Agent" className="glass rounded-2xl border border-border p-4 sm:p-5">
    <h2 className="flex items-center gap-2 text-base font-semibold"><MessageCircle className="h-4 w-4 text-primary" />复盘 Agent <span className="text-xs font-normal text-muted-foreground">试用版</span></h2>
    <p className="mt-2 text-xs leading-relaxed text-muted-foreground">围绕 {anchor} 的复盘追问，可比较此前已存的市场指标。只读取公开市场快照，不读取个人持仓或交易日志。</p>
    <div className="my-4 flex flex-wrap items-center gap-2 text-xs">
      <label>会话 <select aria-label="选择复盘会话" disabled={pending || !!running || loading} value={conversation?.id || ""}
        onChange={e => void choose(e.target.value)} className="ml-1 max-w-60 rounded-lg border border-border bg-background p-2">
        <option value="">新会话</option>{conversations.map(c => <option key={c.id} value={c.id}>{c.title}</option>)}
      </select></label>
      <span>固定使用工作台 AI 来源{conversation ? ` · ${conversation.source.provider} / ${conversation.source.model}` : ''}</span>
      <Link className="text-primary underline" to="/settings">接入 AI</Link>
    </div>
    <div className="mb-4 space-y-3 rounded-xl bg-muted/50 p-3 text-xs">
      <p className="font-medium">市场复盘 → 板块观察 → 个股行情 → 后续核验</p>
      <div className="flex flex-wrap items-center gap-2">
        <label>行业分组 <select aria-label="研究板块" value={sector} onChange={e => setSector(e.target.value)} className="max-w-48 rounded border border-border bg-background p-2">
          <option value="">选择复盘分组</option>{(conversation?.targets || targets).map(t => <option key={t.sector}>{t.sector}</option>)}
        </select></label>
        <button disabled={!sector || pending || !!running || loading} onClick={() => void send(`读取并分析所选复盘中「${sector}」行业分组的指标，说明样本和资料局限。`)} className="rounded border border-border px-3 py-2 disabled:opacity-50">继续研究板块</button>
      </div>
      <p className="text-muted-foreground">这里使用复盘的行业分组与涨停样本，不能替代概念题材和完整成分。</p>
      <div className="flex flex-wrap items-center gap-2">
        <label>手选代码 <input aria-label="研究个股代码" value={symbol} maxLength={6} disabled={!!conversation || pending || !!running} onChange={e => setSymbol(e.target.value)} placeholder="六位 A 股代码" className="w-36 rounded border border-border bg-background p-2" /></label>
        <label className="flex items-center gap-2"><input type="checkbox" checked={network} disabled={!!conversation || pending || !!running} onChange={e => setNetwork(e.target.checked)} />本会话允许补充公开历史行情</label>
      </div>
      <div className="flex flex-wrap gap-2">{((conversation?.targets || targets).find(t => t.sector === sector)?.stocks || []).map(s =>
        <button key={s.code} disabled={!network || pending || !!running || loading} onClick={() => void send(`围绕 ${s.name}（${s.code}），获取截至所选日的近期历史日线，使用工具比较最早和最近收盘，并说明仍缺少的公司资料。`)} className="rounded border border-border px-3 py-2 disabled:opacity-50">{s.name} · {s.code}</button>)}
        {!!symbol && <button disabled={!network || pending || !!running || loading} onClick={() => void send(`获取 ${symbol} 截至所选日的近期历史日线，使用工具比较最早和最近收盘。说明走势观察与公司研究还缺的资料。`)} className="rounded border border-border px-3 py-2 disabled:opacity-50">研究手选个股</button>}
      </div>
      <p className="text-muted-foreground">联网选择和手选代码在新会话固定。仅补充复盘日及之前的历史日线；财报、公告和基本面缺口会明确列出。</p>
    </div>
    {health && !health.installed && loadAgentConnection()?.provider === "codex-private" && <p role="alert" className="mb-3 text-sm">Agent 引擎尚未安装，请按项目文档完成一次安装：<code>npm ci --prefix runtime</code></p>}
    {conversation && <p className="mb-4 text-xs text-muted-foreground">本会话已固定 {conversation.dates.length} 份历史快照（{conversation.dates[conversation.dates.length - 1]} 至 {conversation.anchor}），刷新可继续。生成新复盘后，请新建会话使用更新资料。</p>}
    {loading && <p role="status" className="text-sm text-muted-foreground">正在加载会话…</p>}
    <div className="space-y-5">
      {conversation?.turns.map(turn => <article key={turn.id} className="min-w-0 space-y-3 border-t border-border pt-4">
        <p className="whitespace-pre-wrap break-words text-sm font-medium">{turn.question}</p>
        {turn.result && <>
          <p className="text-xs text-muted-foreground">{turn.result.status === "incomplete" ? "资料不完整，已保留可核验部分" : "回答已生成，引用已核对"} · 解释属于 AI 推断</p>
          {!!turn.result.format_corrections && <p className="text-xs text-muted-foreground">本轮经过 {turn.result.format_corrections} 次回答校正。</p>}
          {turn.result.findings.map((finding, i) => <div key={i} className="space-y-2">
            <p className="whitespace-pre-wrap break-words text-sm leading-7">{finding.text}</p>
            <div className="grid gap-2 sm:grid-cols-2">{finding.citations.map(id => {
              const evidence = turn.result!.evidence.find(e => e.id === id);
              return evidence && <EvidenceCard key={id} evidence={evidence} all={turn.result!.evidence} />;
            })}</div>
          </div>)}
          {turn.result.gaps.length > 0 && <div className="rounded-xl bg-muted p-3 text-xs leading-6"><strong>数据缺口</strong>{turn.result.gaps.map((gap, i) => <p key={i}>{gap}</p>)}</div>}
        </>}
        {turn.error && <p role="alert" className="text-sm">{turn.error}</p>}
        {turn.status === "running" && <div role="status" aria-live="polite" className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />{turn.events[turn.events.length - 1]?.message || "正在准备复盘资料"}<button onClick={() => void cancel()} className="ml-auto flex items-center gap-1 rounded-lg border border-border px-3 py-2"><Square className="h-3 w-3" />取消</button></div>}
      </article>)}
    </div>
    {!conversation && !loading && <div className="my-3 flex flex-wrap gap-2">{["与前一日相比，涨停家数发生了什么变化？", "哪些指标能支持这份复盘，哪些资料还缺失？"].map(q => <button key={q} disabled={pending} onClick={() => void send(q)} className="rounded-xl border border-border px-3 py-2 text-left text-xs hover:bg-muted disabled:opacity-50">{q}</button>)}</div>}
    {error && <p role="alert" className="my-3 text-sm">{error}</p>}
    <form className="mt-4 flex items-end gap-2" onSubmit={e => { e.preventDefault(); void send(); }}>
      <label className="min-w-0 flex-1"><span className="sr-only">复盘问题</span><textarea rows={2} maxLength={2000} value={input} onChange={e => setInput(e.target.value)} placeholder="提问或继续追问…" disabled={pending || !!running} className="w-full resize-y rounded-xl border border-border bg-background p-3 text-sm" /></label>
      <button type="submit" disabled={pending || !!running || loading || !input.trim() || !health?.installed} className="mb-1 flex items-center gap-1 rounded-xl bg-primary px-3 py-3 text-sm font-medium text-primary-foreground disabled:opacity-50">{pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}发送</button>
    </form>
    {conversation && <AgentObservations key={conversation.id} conversationId={conversation.id} anchor={anchor} turns={conversation.turns} />}
    <p className="mt-2 text-xs leading-relaxed text-muted-foreground">指标由程序展示，缺失不当作零；历史 AI 叙述仅作为线索。回答在同轮中校验，最多提交四次，失败保留原因。</p>
  </section>;
}
