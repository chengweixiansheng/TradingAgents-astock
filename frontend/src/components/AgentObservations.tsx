import { useEffect, useState } from "react";
import { agentRequest } from "@/lib/agent-api";
import { agentFetch } from "@/lib/agent";

type Metric = { id: string; kind: string; metric?: string; date: string; label: string; display?: string; available?: boolean };
type Check = { date: string; status: string; actual: string | null; expected: string; threshold: number; threshold_unit: string;
  baseline: Metric; current: Metric | null; note: string };
type Rule = { metric: string; threshold: number; threshold_unit: string };
type Observation = { id: string; metric: string; direction: string; baseline: Metric; rule: Rule | null; checks: Check[] };

export function AgentObservations({ conversationId, anchor, turns }: { conversationId: string; anchor: string;
  turns: { id: string; result: { evidence: Metric[] } | null }[] }) {
  const [items, setItems] = useState<Observation[]>([]);
  const [rules, setRules] = useState<Rule[]>([]);
  const [metric, setMetric] = useState("");
  const [direction, setDirection] = useState("上升");
  const [day, setDay] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [dates, setDates] = useState<string[]>([]);
  const options = turns.flatMap(t => (t.result?.evidence || []).filter(e => e.kind === "metric" && e.available && e.date === anchor)
    .map(e => ({ turn: t.id, evidence: e })));
  const unique = options.filter((v, i) => options.findIndex(x => x.evidence.metric === v.evidence.metric) === i);

  async function refresh() { setItems(await agentRequest<Observation[]>(`/observations?conversation_id=${conversationId}`)); }
  useEffect(() => {
    const controller = new AbortController();
    setItems([]); setDay(""); setDates([]); setMetric(""); setError("");
    void agentRequest<Observation[]>(`/observations?conversation_id=${conversationId}`, undefined, controller.signal)
      .then(setItems).catch(e => { if (!controller.signal.aborted) setError(e.message); });
    void agentRequest<Rule[]>("/observations/menu", undefined, controller.signal)
      .then(setRules).catch(e => { if (!controller.signal.aborted) setError(e.message); });
    return () => controller.abort();
  }, [conversationId]);

  useEffect(() => {
    let alive = true;
    void agentFetch<{ dates: string[] }>("/api/review/dates").then(r => {
      if (alive) setDates((r.dates || []).filter(d => d > anchor));
    }).catch(() => { if (alive) setError("后续复盘日期读取失败，可刷新列表重试。"); });
    return () => { alive = false; };
  }, [conversationId, anchor]);

  async function refreshDates() {
    setBusy(true); setError("");
    try {
      const r = await agentFetch<{ dates: string[] }>("/api/review/dates");
      setDates((r.dates || []).filter(d => d > anchor));
    } catch { setError("后续复盘日期读取失败，请重试。"); }
    finally { setBusy(false); }
  }

  async function save() {
    const choice = unique.find(v => v.evidence.metric === metric);
    if (!choice) return;
    setBusy(true); setError("");
    try { await agentRequest("/observations", { turn_id: choice.turn, metric, direction }); await refresh(); }
    catch (e) { setError(e instanceof Error ? e.message : "保存未完成"); }
    finally { setBusy(false); }
  }
  async function check(id: string) {
    setBusy(true); setError("");
    try { await agentRequest(`/observations/${id}/check`, { date: day }); await refresh(); }
    catch (e) { setError(e instanceof Error ? e.message : "核验未完成"); }
    finally { setBusy(false); }
  }

  return <section aria-label="后续核验" className="mt-5 space-y-3 rounded-xl border border-border p-4 text-xs">
    <h3 className="text-sm font-semibold">保存观察，后续核验</h3>
    <p className="leading-6 text-muted-foreground">从本会话引用的当日市场指标建立条件。生成后续日期的复盘后，可按同一阈值核验；观察条件由此处手动确认保存。</p>
    <div className="flex flex-wrap gap-2">
      <label>指标 <select aria-label="核验指标" value={metric} onChange={e => setMetric(e.target.value)} className="rounded border border-border bg-background p-2">
        <option value="">选择已引用指标</option>{unique.map(v => <option key={v.evidence.metric} value={v.evidence.metric}>{v.evidence.label} · {v.evidence.display}</option>)}
      </select></label>
      <label>预期 <select aria-label="核验预期" value={direction} onChange={e => setDirection(e.target.value)} className="rounded border border-border bg-background p-2">
        {["上升", "下降", "持平"].map(d => <option key={d}>{d}</option>)}
      </select></label>
      <button disabled={busy || !metric || !rules.length} onClick={() => void save()} className="rounded border border-border px-3 py-2 disabled:opacity-50">保存核验条件</button>
    </div>
    {rules.filter(r => r.metric === metric).map(r => <p key={r.metric}>确认规则：相对基准变化超过 {r.threshold} {r.threshold_unit} 才算上升或下降，否则为持平。保存后阈值固定。</p>)}
    {!unique.length && <p>先让 Agent 读取并引用所选日的市场指标，即可选择。</p>}
    {!!items.length && <div className="flex flex-wrap items-center gap-2">
      <label>已有后续复盘 <select aria-label="已有后续复盘" value={dates.includes(day) ? day : ""} onInput={e => setDay(e.currentTarget.value)} onChange={e => setDay(e.target.value)} className="rounded border border-border bg-background p-2">
        <option value="">选择日期</option>{dates.map(d => <option key={d} value={d}>{d}</option>)}
      </select></label>
      <button disabled={busy} onClick={() => void refreshDates()} className="rounded border border-border px-3 py-2 disabled:opacity-50">刷新日期列表</button>
      <label>指定核验日 <input type="date" aria-label="后续核验日" value={day} onInput={e => setDay(e.currentTarget.value)} onChange={e => setDay(e.target.value)} className="rounded border border-border bg-background p-2" /></label>
      {!dates.length && <p className="w-full text-muted-foreground">尚无后续日期的完整复盘。先在每日复盘页面生成，再刷新此列表；也可指定日期检查资料是否齐全。</p>}
    </div>}
    {items.map(item => <article key={item.id} className="space-y-2 rounded-lg bg-muted p-3">
      <p>{item.baseline.label} · {item.baseline.date} 基准 {item.baseline.display} · 预期{item.direction}</p>
      <p>{item.rule ? `固定阈值：超过 ${item.rule.threshold} ${item.rule.threshold_unit} 才算升降，否则为持平。` : "旧条件未保存阈值，需要重新确认。"}</p>
      <button disabled={busy || !day || day <= anchor} onClick={() => void check(item.id)} className="rounded border border-border px-3 py-2 disabled:opacity-50">核验这个条件</button>
      {item.checks?.map((c, i) => <div key={i} className="leading-6"><p>{c.date} · {c.status} · 实际{c.actual || "未获取"} · 当日 {c.current?.display || "未获取"}</p><p>变化阈值：{c.threshold} {c.threshold_unit}。{c.note}</p></div>)}
    </article>)}
    {error && <p role="alert">{error}</p>}
  </section>;
}
