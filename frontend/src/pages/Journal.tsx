import { Fragment, useEffect, useRef, useState } from "react";
import { pctColor, UP_TEXT } from "@/lib/colors";
import { NotebookPen, Loader2, Trash2, BarChart3, ShieldAlert } from "lucide-react";
import { cn } from "@/lib/utils";
import { Caliber } from "@/components/ui/Caliber";
import { agentFetch, agentPost, finite, localDate, plain, ratioPct, safeArray, safeRecord } from "@/lib/agent";
import type {
  AtRiskPosition, AtRiskReport, Attribution, Bucket, ExcursionItem, ExcursionSummary,
  Fill, Inbox, InboxItem, JournalStats, ModePerf, ModesResponse, QuadrantCell,
  RiskReport, RiskRules, Rolling, Trade, Violation, WindowStats,
} from "@/lib/agent";

/** 交易日志：记录自己的每一笔交易，并附上成交当天的市场环境快照。
 *
 * ⚠️ 只统计使用者自己录入的历史行为，不产出任何下一笔建议。
 * ⛔ 这些数据不接入任何 AI prompt。
 */

const PLAYBOOKS = ["打板", "低吸", "接力", "半路", "套利", "其它"];

function signed(v?: number | null): string {
  const n = finite(v);
  return n === null ? "—" : `${n > 0 ? "+" : ""}${n.toFixed(2)}%`;
}
function tone(v?: number | null): string {
  const n = finite(v);
  if (n === null) return "text-muted-foreground";
  return pctColor(n);
}
function rate(v?: number | null): string {
  const n = finite(v);
  return n === null ? "—" : `${Math.round(n * 100)}%`;
}
function hhmm(t?: string | null): string {
  return !t || t.length < 4 ? "" : `${t.slice(0, 2)}:${t.slice(2, 4)}`;
}

/** 一组分桶统计的横向对比条 */
function BucketRows({ title, hint, data }: { title: string; hint: string; data?: Record<string, Bucket> }) {
  const rows = Object.entries(safeRecord<Bucket>(data)).filter(([, b]) => b.count > 0);
  if (rows.length === 0) return null;
  return (
    <div className="glass rounded-2xl p-5">
      <h3 className="text-sm font-bold">{title}</h3>
      <p className="mb-3 text-[11px] text-muted-foreground">{hint}</p>
      <div className="space-y-1.5">
        {rows.map(([k, b]) => (
          <div key={k} className="flex flex-wrap items-center gap-2 text-[12px] tabular-nums">
            <span className="w-20 shrink-0 font-semibold">{k}</span>
            <span className={cn("w-16 font-extrabold", tone(b.avg))}>{signed(b.avg)}</span>
            <span className="text-muted-foreground">胜率 {rate(b.win_rate)}</span>
            <span className="text-muted-foreground/70">
              {b.scored}/{b.count} 笔有盈亏
              {b.scored > 0 && b.scored < 10 && <span className="ml-1 text-warning">· 样本少，别下结论</span>}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** 在险资金：现在这些仓位最坏会亏掉多少。
 *  ⚠️ 没写计划止损的仓位风险是**未知**不是零 —— 总在险是下限，必须说明。*/

/** 模式卡表单草稿 —— 每个字段都是输入框里的字符串。*/
type ModeDraft = {
  id?: string; name: string; playbook: string;
  setup?: string; entry?: string; exit?: string; sizing?: string;
  phase?: string; changes?: string;
};

/** 个人模式卡：把打法写下来 + 按版本分段看业绩。
 *  ⚠️ 不预填任何规则内容 —— 预填等于替使用者决定该怎么交易。*/
function ModesPanel({ revision }: { revision: number }) {
  const [data, setData] = useState<ModesResponse | null>(null);
  const [tick, setTick] = useState(0);
  // 表单草稿。⚠️ 不要用 `Partial<ModeCard>`：ModeCard 的 `versions` 是数组，
  // 与"表单只装字符串"冲突，硬套只能靠 `as never` 绕过类型检查。
  const [editing, setEditing] = useState<ModeDraft | null>(null);
  const [msg, setMsg] = useState("");
  useEffect(() => {
    let alive = true;
    (async () => {
      try { const next = await agentFetch<ModesResponse>("/api/modes"); if (alive) { setData(next); setMsg(""); } }
      catch (e) { if (alive) { setData(null); setMsg(e instanceof Error ? e.message : "模式卡加载失败，请刷新重试"); } }
    })();
    return () => { alive = false; };
  }, [tick, revision]);
  if (!data) return msg ? <p role="alert">{msg}</p> : null;
  const perf = data.performance;
  const FIELDS: [keyof ModeDraft, string][] = [
    ["setup", "什么形态才做"], ["entry", "怎么进"], ["exit", "怎么走"],
    ["sizing", "下多少"], ["phase", "适用什么情绪环境"],
  ];
  const save = async () => {
    setMsg("");
    try {
      await agentPost("/api/modes", editing);
      setEditing(null); setTick((t) => t + 1);
    } catch (e) { setMsg(e instanceof Error ? e.message : "保存失败"); }
  };
  // ⚠️ 删卡片会连同它的全部版本历史一起消失，且历史交易会失去分段依据 —— 先确认
  const remove = async (id: string, name: string, versions: number) => {
    if (!window.confirm(
      `删除模式卡「${name}」？\n\n它的 ${versions} 个版本会一并删除，` +
      `按版本分段的业绩统计将不可恢复（交易记录本身不受影响）。`)) return;
    setMsg("");
    try {
      await agentPost("/api/modes/delete", { id });
      if (editing?.id === id) setEditing(null);
      setTick((t) => t + 1);
    } catch (e) { setMsg(e instanceof Error ? e.message : "删除失败"); }
  };
  return (
    <div className="glass rounded-2xl p-5">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-bold">我这套打法</h3>
        <button
          onClick={() => setEditing(editing ? null : { name: "", playbook: data.playbooks_hint[0] })}
          className="cursor-pointer rounded-lg bg-primary/90 px-2.5 py-1 text-[11px] font-bold text-primary-foreground transition-colors hover:bg-primary">
          {editing ? "取消" : "+ 新建模式卡"}
        </button>
      </div>
      <p className="mb-3 text-[11px] leading-relaxed text-muted-foreground">
        <Caliber text={
          "每笔交易先按 `打法` 归到卡片，再按**成交日期落在哪个版本的生效区间**分到该版本。\n\n" +
          "· 归属用的是「那天生效的那个版本的打法」，不是卡片现在的打法 —— " +
          "所以改了卡片不会重写历史归属。\n" +
          "· 卡片创建之前的交易单独列出，不计入任何版本。\n" +
          "· 版本笔数不足下方标注的门槛时带 *，该版本的读数单看没有意义。\n" +
          "· 两个版本都够样本才做比较，否则只显示「暂不比较」。\n\n" +
          "本表胜率 = 盈利 ÷ (盈利 + 亏损)，持平不计入分母 —— 与上方「自我体检」同一口径。"
        } />{" "}
        打法改过之后，改动前后的统计不能混在一起算 —— 混了那个平均数谁都用不上。
        写下来并<b>带版本</b>，业绩就能按版本分段，才能回答「上次那个改动到底是好是坏」。
        写下来同时也给「按计划」一个具体的参照物。修改规则从次日生效，今天及以前的交易仍按原版本统计。
      </p>

      {editing && (
        <div className="mb-3 space-y-2 rounded-xl border border-border bg-muted/20 p-3">
          <div className="flex flex-wrap gap-2">
            <input placeholder="模式名，如「首板早封」" value={editing.name ?? ""}
              onChange={(e) => setEditing({ ...editing, name: e.target.value })}
              className="flex-1 rounded border border-border bg-background px-2 py-1 text-[12px]" />
            <select value={editing.playbook ?? ""}
              onChange={(e) => setEditing({ ...editing, playbook: e.target.value })}
              className="rounded border border-border bg-background px-2 py-1 text-[12px]">
              {safeArray<string>(data.playbooks_hint).map((pb) => (
                <option key={pb} value={pb}>{pb}</option>
              ))}
            </select>
          </div>
          {FIELDS.map(([k, label]) => (
            <input key={k} placeholder={label} value={editing[k] ?? ""}
              onChange={(e) => setEditing({ ...editing, [k]: e.target.value } as ModeDraft)}
              className="w-full rounded border border-border bg-background px-2 py-1 text-[12px]" />
          ))}
          {editing.id && (
            <input placeholder="这次改了什么（会记进新版本）" value={editing.changes ?? ""}
              onChange={(e) => setEditing({ ...editing, changes: e.target.value })}
              className="w-full rounded border border-border bg-background px-2 py-1 text-[12px]" />
          )}
          <div className="flex items-center gap-3">
            <button onClick={save}
              className="cursor-pointer rounded-lg bg-primary px-3 py-1.5 text-[12px] font-bold text-primary-foreground transition-colors hover:bg-primary/85">
              保存
            </button>
            {msg && <span className="text-[12px] text-danger">{msg}</span>}
          </div>
        </div>
      )}

      {!perf.available ? (
        <p className="text-[12px] text-muted-foreground">{perf.reason}</p>
      ) : (
        <div className="space-y-3">
          <p className="text-[11px] text-muted-foreground">{plain(perf.note)}</p>
          {perf.truncated && <p role="alert" className="text-[11px] text-warning">仅载入最近部分交易，历史样本不完整，暂停版本比较。</p>}
          {safeArray<ModePerf>(perf.cards).map((c) => (
            <div key={c.id} className="rounded-xl border border-border p-3">
              <div className="flex flex-wrap items-center gap-2 text-[12px]">
                <b>{c.name}</b>
                <span className="rounded bg-muted px-1.5 py-0.5 text-[10px]">{c.playbook}</span>
                <span className="text-muted-foreground">
                  {c.version_count} 个版本 · 匹配 {c.matched_trades} 笔
                </span>
                <button
                  onClick={() => {
                    const v = c.by_version[c.by_version.length - 1];
                    setEditing({ id: c.id, name: c.name, playbook: c.playbook,
                      setup: v?.setup ?? "", entry: v?.entry ?? "", exit: v?.exit ?? "",
                      sizing: v?.sizing ?? "", phase: v?.phase ?? "" });
                  }}
                  className="cursor-pointer text-[11px] text-primary transition-colors hover:text-primary/80">
                  编辑
                </button>
                <button
                  onClick={() => remove(c.id, c.name, c.version_count)}
                  title="删除这张模式卡"
                  className="cursor-pointer text-muted-foreground/50 transition-colors hover:text-danger">
                  <Trash2 className="h-3 w-3" />
                </button>
              </div>
              <div className="mt-2 overflow-x-auto">
                <table className="w-full min-w-[460px] text-[11px] tabular-nums">
                  <thead>
                    <tr className="border-b border-border text-muted-foreground">
                      <th className="py-1 pr-2 text-left font-normal">版本</th>
                      <th className="px-2 py-1 text-left font-normal">生效</th>
                      <th className="px-2 py-1 text-right font-normal">笔数</th>
                      <th className="px-2 py-1 text-right font-normal">胜率</th>
                      <th className="px-2 py-1 text-right font-normal">中位</th>
                      <th className="px-2 py-1 text-left font-normal">改了什么</th>
                    </tr>
                  </thead>
                  <tbody>
                    {c.by_version.map((v) => (
                      <tr key={v.version} className="border-b border-border/40 last:border-0">
                        <td className="py-1 pr-2">v{v.version}</td>
                        <td className="px-2 py-1 text-muted-foreground">{v.since}</td>
                        <td className={cn("px-2 py-1 text-right",
                          v.enough ? "font-semibold" : "text-muted-foreground/60")}>
                          {v.trades}{!v.enough && "*"}
                        </td>
                        <td className="px-2 py-1 text-right">{ratioPct(v.win_rate)}</td>
                        <td className={cn("px-2 py-1 text-right", tone(v.median_pct))}>
                          {v.median_pct == null ? "—"
                            : `${v.median_pct > 0 ? "+" : ""}${v.median_pct}%`}
                        </td>
                        <td className="px-2 py-1 text-[10px] text-muted-foreground">{v.changes}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {c.by_version.some((v) => !v.enough) && (
                <p className="mt-1 text-[10px] text-warning">
                  * 样本不足 {perf.min_per_version} 笔或历史记录未完整载入，暂不作版本比较。
                </p>
              )}
              {c.compare_blocked && (
                <p className="mt-1 text-[11px] text-warning">
                  版本样本不足或历史记录不完整，<b>暂不比较</b> —— 3 笔对 12 笔的「变差了」没有意义。
                </p>
              )}
              {c.latest_vs_prev && (
                <p className="mt-1 text-[12px]">
                  v{c.latest_vs_prev.from_version} → v{c.latest_vs_prev.to_version}：胜率{" "}
                  <b className={c.latest_vs_prev.win_rate_delta >= 0 ? "text-success" : "text-danger"}>
                    {ratioPct(c.latest_vs_prev.win_rate_delta, true)}
                  </b>
                  ，中位收益{" "}
                  <b className={tone(c.latest_vs_prev.median_delta)}>
                    {c.latest_vs_prev.median_delta > 0 ? "+" : ""}{c.latest_vs_prev.median_delta}%
                  </b>
                  <span className="ml-1 text-[11px] text-muted-foreground">
                    ← 你自己的历史统计，不是对下一笔的预测
                  </span>
                </p>
              )}
              {c.before_card && (c.before_card.trades ?? 0) > 0 && (
                <p className="mt-1 text-[11px] text-muted-foreground">
                  另有 {c.before_card.trades} 笔发生在这张卡建立之前，
                  <b>不计入任何版本</b>（否则等于用现在的规则评价更早的操作）。
                </p>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** MFE/MAE 与盈利回吐：这笔曾经到过哪里、实际拿到了多少。
 *  ⚠️ 偏差必须和结论摆在一起 —— MFE 是日线上界，捕获率被系统性低估。*/

function AtRiskPanel({ revision }: { revision: number }) {
  const [rep, setRep] = useState<AtRiskReport | null>(null);
  const [base, setBase] = useState("");
  const [tick, setTick] = useState(0);
  const [msg, setMsg] = useState("");
  const [loadError, setLoadError] = useState("");
  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const r = await agentFetch<AtRiskReport>("/api/risk/at-risk");
        if (!active) return;
        setLoadError("");
        setRep(r);
        if (r.equity_base) setBase(String(r.equity_base));
      } catch { if (active) { setRep(null); setLoadError("在险资金读取失败，请刷新重试；当前风险未知。"); } }
    })();
    return () => { active = false; };
  }, [tick, revision]);
  if (loadError) return <p role="alert" className="text-danger">{loadError}</p>;
  if (!rep?.available) return null;
  const saveBase = async () => {
    setMsg("");
    const n = Number(base);
    if (!Number.isFinite(n) || n <= 0) { setMsg("账户规模要是正数"); return; }
    try { await agentPost("/api/risk/equity-base", { equity_base: n }); setTick((t) => t + 1); }
    catch (e) { setMsg(e instanceof Error ? e.message : "保存失败"); }
  };
  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.2em] text-primary">
        <ShieldAlert className="h-3.5 w-3.5" /> 在险资金 · AT RISK
      </div>
      <div className="glass rounded-2xl p-5">
        <h3 className="text-sm font-bold">按计划止损估算损失</h3>
        <p className="mb-3 text-[11px] leading-relaxed text-muted-foreground">
          此处是按计划价成交的情景估算；跳空、跌停或无法成交时，实际损失可能更大。
          按你自己写下的计划止损算：<code className="text-[10px]">(成本 − 止损价) × 股数</code>。
          组合风险要按各笔仓位加权：三笔各占账户三分之一、各跌 5%，合计影响约为账户的 5%。
        </p>
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <div>
            <div className="text-xl font-extrabold tabular-nums text-danger">
              {rep.total_at_risk?.toLocaleString()}
            </div>
            <div className="text-[11px] text-muted-foreground">
              有边界的合计在险
              {rep.at_risk_of_equity_pct != null && ` · 账户 ${rep.at_risk_of_equity_pct}%`}
            </div>
          </div>
          <div>
            <div className="text-xl font-extrabold tabular-nums">{rep.position_count}</div>
            <div className="text-[11px] text-muted-foreground">
              笔在场{rep.rules?.max_positions ? ` / 你的上限 ${rep.rules.max_positions}` : ""}
            </div>
          </div>
          <div>
            <div className="text-xl font-extrabold tabular-nums">
              {rep.total_capital?.toLocaleString()}
            </div>
            <div className="text-[11px] text-muted-foreground">
              占用本金
              {rep.capital_of_equity_pct != null && ` · 账户 ${rep.capital_of_equity_pct}%`}
            </div>
          </div>
          <div>
            <div className={cn("text-xl font-extrabold tabular-nums",
              (rep.unbounded_count ?? 0) > 0 ? "text-warning" : "")}>
              {rep.unbounded_count}
            </div>
            <div className="text-[11px] text-muted-foreground">笔未设止损</div>
          </div>
        </div>

        {/* ⚠️ 未设边界的必须显式提示，不能静静地不出现在总数里 */}
        {rep.unbounded_note && (
          <p className="mt-3 rounded-lg bg-warning/10 px-3 py-2 text-[11px] leading-relaxed text-warning">
            {plain(rep.unbounded_note)}
          </p>
        )}
        {rep.over_position_limit && (
          <p className="mt-2 text-[12px] text-danger">
            在场 {rep.over_position_limit.actual} 笔，超过你自己写的上限{" "}
            {rep.over_position_limit.limit} 笔。
          </p>
        )}
        {!!rep.over_per_trade_limit?.length && (
          <p className="mt-1 text-[12px] text-danger">
            单笔在险超过你的上限（{rep.rules?.max_loss_per_trade_pct}%）：
            {rep.over_per_trade_limit.map((o) => `${o.name} ${o.pct_of_equity}%`).join("、")}
          </p>
        )}

        {/* 账户规模：没填就只给绝对金额，绝不用别的值代替 */}
        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border pt-2.5 text-[12px]">
          <span className="text-muted-foreground">账户规模</span>
          <input type="number" min="0" step="any" value={base}
            onChange={(e) => setBase(e.target.value)}
            placeholder="填了才有占比"
            className="w-28 rounded border border-border bg-background px-2 py-1 text-right tabular-nums" />
          <button onClick={saveBase}
            className="cursor-pointer rounded-lg bg-primary/90 px-2.5 py-1 text-[11px] font-bold text-primary-foreground transition-colors hover:bg-primary">
            保存
          </button>
          {msg && <span className="text-muted-foreground">{msg}</span>}
          {rep.equity_base_hint && (
            <span className="text-[11px] text-muted-foreground">{rep.equity_base_hint}</span>
          )}
        </div>

        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[520px] text-[11px] tabular-nums">
            <thead>
              <tr className="border-b border-border text-muted-foreground">
                <th className="py-1 pr-2 text-left font-normal">买入日</th>
                <th className="px-2 py-1 text-left font-normal">标的</th>
                <th className="px-2 py-1 text-right font-normal">股数</th>
                <th className="px-2 py-1 text-right font-normal">成本</th>
                <th className="px-2 py-1 text-right font-normal">计划止损</th>
                <th className="px-2 py-1 text-right font-normal">在险</th>
              </tr>
            </thead>
            <tbody>
              {safeArray<AtRiskPosition>(rep.positions).map((p) => (
                <tr key={p.id} className="border-b border-border/40 last:border-0">
                  <td className="py-1 pr-2 text-muted-foreground">{p.date}</td>
                  <td className="px-2 py-1">
                    {p.name} <span className="text-[10px] text-muted-foreground">{p.code}</span>
                  </td>
                  <td className="px-2 py-1 text-right">{p.shares.toLocaleString()}</td>
                  <td className="px-2 py-1 text-right">{p.avg_cost}</td>
                  <td className={cn("px-2 py-1 text-right",
                    p.bounded ? "" : "text-warning")}>
                    {p.planned_stop ?? "未设"}
                  </td>
                  <td className={cn("px-2 py-1 text-right font-semibold",
                    p.bounded ? "text-danger" : "text-warning")}>
                    {p.at_risk == null ? "未知" : p.at_risk.toLocaleString()}
                    {p.at_risk_pct != null && (
                      <span className="ml-1 text-[10px] font-normal opacity-70">
                        −{p.at_risk_pct}%
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}

/** 异常交易收件箱。判定基准全部来自使用者自己 —— 只说哪里不寻常，不说该怎么做。*/
function InboxPanel({ revision }: { revision: number }) {
  const [rep, setRep] = useState<Inbox | null>(null);
  const [loadError, setLoadError] = useState("");
  useEffect(() => {
    let active = true;
    (async () => {
      try { const next = await agentFetch<Inbox>("/api/risk/inbox"); if (active) { setRep(next); setLoadError(""); } }
      catch { if (active) { setRep(null); setLoadError("异常交易检查读取失败，请刷新重试。"); } }
    })();
    return () => { active = false; };
  }, [revision]);
  if (loadError) return <p role="alert" className="text-danger">{loadError}</p>;
  if (!rep?.available || !(rep.count ?? 0)) return null;
  return (
    <div className="glass rounded-2xl p-5">
      <h3 className="text-sm font-bold">
        值得回头看一眼的
        <span className="ml-2 rounded-full bg-primary/15 px-2 py-0.5 text-[11px] font-bold text-primary">
          {rep.count} / {rep.scanned} 笔
        </span>
      </h3>
      <p className="mb-3 text-[11px] leading-relaxed text-muted-foreground">
        {plain(rep.note)}
        {rep.baseline && !rep.baseline.history_enough && (
          <span className="text-warning">
            {" "}（交易还不到 {rep.baseline.min_history} 笔，
            「相对自己习惯」那几类判定暂时不做 —— 几笔的中位数不是习惯）
          </span>
        )}
      </p>
      <div className="max-h-80 space-y-2 overflow-y-auto">
        {safeArray<InboxItem>(rep.items).map((it) => (
          <div key={it.id} className="rounded-xl border border-border bg-muted/10 p-2.5">
            <div className="flex flex-wrap items-baseline gap-2 text-[12px]">
              <span className="text-muted-foreground tabular-nums">{it.date}</span>
              <b>{it.name}</b>
              <span className="rounded bg-muted px-1.5 py-0.5 text-[10px]">{it.playbook}</span>
              {it.pnl_pct != null && (
                <span className={cn("font-semibold tabular-nums", tone(it.pnl_pct))}>
                  {it.pnl_pct > 0 ? "+" : ""}{it.pnl_pct}%
                </span>
              )}
              {!it.closed && (
                <span className="rounded bg-primary/15 px-1.5 py-0.5 text-[10px] text-primary">
                  还在手上
                </span>
              )}
            </div>
            <ul className="mt-1 space-y-0.5">
              {it.flags.map((f, i) => (
                <li key={i} className="text-[11px] text-muted-foreground">· {f.text}</li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </div>
  );
}


/** 个人模式卡：把打法写下来 + 按版本分段看业绩。
 *  ⚠️ 不预填任何规则内容 —— 那会变成我们在教用户怎么交易。*/

function ExcursionPanel() {
  const [rep, setRep] = useState<ExcursionSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    (async () => {
      try { setRep(await agentFetch<ExcursionSummary>("/api/risk/excursion")); }
      catch { /* 要拉行情，失败就不显示 */ }
      setLoading(false);
    })();
  }, []);
  if (loading || !rep?.available) return null;
  const items = safeArray<ExcursionItem>(rep.items);
  return (
    <div className="glass rounded-2xl p-5">
      <h3 className="text-sm font-bold">是不是总在最高点前就跑了</h3>
      <p className="mb-3 text-[11px] leading-relaxed text-muted-foreground">
        结果只说了终点。<b>MFE</b> = 这笔最多曾赚到多少，<b>MAE</b> = 最多曾亏到多少。
        MFE/MAE 基于持有期日线高低价，是区间上界，不代表盘中曾能按该价成交。差额只提示需要回看交易记录，不能直接归因于卖点或进场判断；复权价格与实际成交价的差异也会影响结果。
      </p>
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <div>
          <div className="text-xl font-extrabold tabular-nums">
            {ratioPct(rep.median_capture_rate)}
          </div>
          <div className="text-[11px] text-muted-foreground">
            捕获率中位数
            {rep.capture_samples != null && `（${rep.capture_samples} 笔有肉的行情）`}
          </div>
        </div>
        <div>
          <div className="text-xl font-extrabold tabular-nums text-warning">
            {rep.median_give_back == null ? "—"
              : `${rep.median_give_back > 0 ? "+" : ""}${rep.median_give_back}%`}
          </div>
          <div className="text-[11px] text-muted-foreground">盈利回吐中位数</div>
        </div>
        <div>
          <div className="text-xl font-extrabold tabular-nums text-danger">
            {rep.median_mae == null ? "—" : `${rep.median_mae}%`}
          </div>
          <div className="text-[11px] text-muted-foreground">最大浮亏中位数</div>
        </div>
        <div>
          <div className="text-xl font-extrabold tabular-nums">
            {rep.bad_entry_count ?? 0}
            <span className="mx-1 text-sm font-normal text-muted-foreground">/</span>
            {rep.endured_count ?? 0}
          </div>
          <div className="text-[11px] text-muted-foreground">
            进场就不对 / 深亏扛回来
          </div>
        </div>
      </div>

      {/* 负捕获率必须解释 —— 否则"−41%"读起来像算错了 */}
      {rep.capture_note && (
        <p className="mt-3 border-t border-border pt-2.5 text-[11px] leading-relaxed text-danger">
          {plain(rep.capture_note)}
        </p>
      )}

      {/* ⚠️ 偏差和结论摆在一起，不能只报漂亮数字 */}
      <p className="mt-3 border-t border-border pt-2.5 text-[11px] leading-relaxed text-warning">
        {plain(rep.bias_note)}
      </p>
      {!rep.enough_samples && (
        <p className="mt-1 text-[11px] font-bold text-warning">
          只有 {rep.trades} 笔，样本太少，别下结论。
        </p>
      )}
      {(rep.failed ?? 0) > 0 && (
        <p className="mt-1 text-[11px] text-muted-foreground">
          {rep.failed} 笔算不了（未平仓 / 没填成交明细 / 取不到行情），已如实排除。
        </p>
      )}

      <button onClick={() => setOpen((v) => !v)}
        className="mt-2 cursor-pointer text-[12px] text-primary transition-colors hover:text-primary/80">
        {open ? "收起逐笔" : `看逐笔（${items.length} 笔）`}
      </button>
      {open && (
        <div className="mt-2 max-h-72 overflow-y-auto">
          <table className="w-full min-w-[520px] text-[11px] tabular-nums">
            <thead>
              <tr className="border-b border-border text-muted-foreground">
                <th className="py-1 pr-2 text-left font-normal">买入 → 卖出</th>
                <th className="px-2 py-1 text-left font-normal">标的</th>
                <th className="px-2 py-1 text-right font-normal">落袋</th>
                <th className="px-2 py-1 text-right font-normal">MFE</th>
                <th className="px-2 py-1 text-right font-normal">MAE</th>
                <th className="px-2 py-1 text-right font-normal">回吐</th>
                <th className="px-2 py-1 text-right font-normal">捕获</th>
                <th className="px-2 py-1 text-left font-normal">精度</th>
              </tr>
            </thead>
            <tbody>
              {items.map((r, i) => (
                <tr key={i} className="border-b border-border/40 last:border-0">
                  <td className="py-1 pr-2 text-muted-foreground">
                    {r.date}{r.exit_date !== r.date && ` → ${r.exit_date}`}
                  </td>
                  <td className="px-2 py-1">{r.name}</td>
                  <td className={cn("px-2 py-1 text-right font-semibold", tone(r.realized_pct))}>
                    {r.realized_pct > 0 ? "+" : ""}{r.realized_pct}%
                  </td>
                  {/* ⚠️ MFE **可能为负**：那段行情里最高价从没超过成本，即这笔从头到尾
                      没浮盈过。硬编码 `+` 会显示成 "+-25.06%"，而且把"从没赚过"
                      涂成绿色，读起来正好相反。 */}
                  <td className={cn("px-2 py-1 text-right",
                    r.mfe_pct > 0 ? UP_TEXT : "text-muted-foreground")}>
                    {r.mfe_pct > 0 ? "+" : ""}{r.mfe_pct}%
                    {r.mfe_certain != null && (
                      <span className="ml-0.5 text-[10px] text-muted-foreground/60"
                        title="确定赚到过（只算中间完整交易日）">
                        ≥{r.mfe_certain}
                      </span>
                    )}
                  </td>
                  <td className="px-2 py-1 text-right text-danger">{r.mae_pct}%</td>
                  <td className="px-2 py-1 text-right text-warning">
                    {r.give_back_pct > 0 ? "+" : ""}{r.give_back_pct}%
                  </td>
                  <td className={cn("px-2 py-1 text-right",
                    (r.capture_rate ?? 0) < 0 ? "text-danger" : "")}
                    title={r.capture_note ?? undefined}>
                    {ratioPct(r.capture_rate)}
                  </td>
                  {/* ⚠️ `bars_inner === 0` 表示**没有**完整的中间交易日 → 那就只有上界，
                      不能写成"中间 0 日可靠"（0 日可靠 = 不可靠，字面正好相反）。
                      相邻两日买卖也是这种情况，不只同日进出。 */}
                  <td className={cn("px-2 py-1 text-[10px]",
                    r.bars_inner > 0 ? "text-muted-foreground/70" : "text-warning")}
                    title={r.precision}>
                    {r.bars_inner > 0 ? `中间 ${r.bars_inner} 日可靠`
                      : (r.same_day ? "同日·仅上界" : "相邻两日·仅上界")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/** 终身 vs 近 10/20/50 笔并排。
 *  ⭐ 终身数字会把最近的退化藏起来：前面赚够了、最近一直亏，终身照样漂亮。*/
function RollingTable({ r }: { r: Rolling }) {
  const life = r.lifetime;
  const cols = ["10", "20", "50"].map((k) => safeRecord<WindowStats>(r.windows)[k]);
  const ROWS: {
    label: string; get: (w?: WindowStats) => string; hint?: string;
    // 钱的那一行要带符号并上色 —— 页面其它地方都这样，只有这张表不带会显得是另一种量
    toneBy?: (w?: WindowStats) => number | null | undefined;
  }[] = [
    { label: "笔数", get: (w) => String(w?.trades ?? "—") },
    { label: "净盈亏", toneBy: (w) => w?.net_pnl,
      get: (w) => w?.net_pnl == null ? "—"
        : `${w.net_pnl > 0 ? "+" : ""}${w.net_pnl.toLocaleString()}` },
    { label: "胜率", get: (w) => ratioPct(w?.win_rate) },
    { label: "盈亏比", get: (w) => w?.payoff_ratio == null ? "—" : String(w.payoff_ratio) },
    { label: "Profit Factor", get: (w) => w?.profit_factor == null ? "—" : String(w.profit_factor) },
    { label: "执行率", get: (w) => ratioPct(w?.execution_rate), hint: "纪律会滑坡，终身看不出最近在放飞" },
  ];
  return (
    <div className="glass rounded-2xl p-5">
      <h3 className="text-sm font-bold">最近还在状态上吗</h3>
      <p className="mb-3 text-[11px] leading-relaxed text-muted-foreground">
        {plain(r.note)}<br />
        <span className="text-muted-foreground/70">
          样本不够那个窗口时标灰并注明 —— 只有 12 笔却报「近 50 笔」，
          会让人以为打法在 50 笔的尺度上验证过。
        </span>
      </p>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[420px] text-[12px] tabular-nums">
          <thead>
            <tr className="border-b border-border text-[11px] text-muted-foreground">
              <th className="py-1.5 pr-3 text-left font-normal"> </th>
              <th className="px-2 py-1.5 text-right font-normal">终身</th>
              {cols.map((w, i) => (
                <th key={i} className="px-2 py-1.5 text-right font-normal">
                  近 {["10", "20", "50"][i]} 笔
                  {w && !w.enough && (
                    <span className="ml-1 text-warning">*</span>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {ROWS.map((row) => (
              <tr key={row.label} className="border-b border-border/40 last:border-0">
                <td className="py-1.5 pr-3 text-muted-foreground" title={row.hint}>
                  {row.label}
                </td>
                <td className={cn("px-2 py-1.5 text-right font-semibold",
                  row.toneBy && tone(row.toneBy(life)))}>{row.get(life)}</td>
                {cols.map((w, i) => (
                  <td key={i}
                    className={cn("px-2 py-1.5 text-right",
                      w?.enough
                        ? cn("font-semibold", row.toneBy && tone(row.toneBy(w)))
                        : "text-muted-foreground/50")}>
                    {row.get(w)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {cols.some((w) => w && !w.enough) && (
        <p className="mt-2 text-[11px] text-warning">
          * 交易笔数还不够这个窗口，数字只是"目前全部"，别当成该尺度上的验证结果。
        </p>
      )}
      {finite(r.win_rate_drift) != null && (
        <p className={cn("mt-2 text-[12px]",
          (r.win_rate_drift ?? 0) < -0.15 ? "text-danger"
            : (r.win_rate_drift ?? 0) > 0.15 ? "text-success" : "text-muted-foreground")}>
          近 10 笔胜率比终身 {(r.win_rate_drift ?? 0) >= 0 ? "高" : "低"}{" "}
          <b>{ratioPct(Math.abs(r.win_rate_drift ?? 0))}</b>
          {finite(r.profit_factor_drift) != null
            && `，Profit Factor 差 ${(r.profit_factor_drift ?? 0) > 0 ? "+" : ""}${r.profit_factor_drift}`}
          <span className="ml-1 text-[11px] opacity-70">
            ← 这是你自己的历史统计，不是对下一笔的预测
          </span>
        </p>
      )}
    </div>
  );
}

/** 判断 vs 执行四格。
 *  ⭐「判对+亏钱」= 执行问题（最值钱的一格）；⚠️「判错+赚钱」= 运气（危险格）。*/
function AttributionGrid() {
  const [rep, setRep] = useState<Attribution | null>(null);
  useEffect(() => {
    (async () => {
      try { setRep(await agentFetch<Attribution>("/api/risk/attribution")); }
      catch { /* 归因需要两层数据都齐，缺了就不显示 */ }
    })();
  }, []);
  if (!rep?.available) return null;
  const q = safeRecord<QuadrantCell>(rep.quadrants);
  const CELLS: { key: string; label: string; tag?: string; tone: string }[] = [
    { key: "right_win", label: "判对 + 赚钱", tone: "border-success/30 bg-success/5" },
    { key: "right_lose", label: "判对 + 亏钱", tag: "⭐ 执行问题", tone: "border-warning/40 bg-warning/10" },
    { key: "wrong_win", label: "判错 + 赚钱", tag: "⚠️ 运气", tone: "border-warning/40 bg-warning/10" },
    { key: "wrong_lose", label: "判错 + 亏钱", tag: "判断问题", tone: "border-danger/30 bg-danger/5" },
  ];
  return (
    <div className="glass rounded-2xl p-5">
      <h3 className="text-sm font-bold">看错了，还是没执行好</h3>
      <p className="mb-3 text-[11px] leading-relaxed text-muted-foreground">
        把「昨晚那份市场判断成立没成立」和「自己那天赚没赚」交叉起来。
        看对了却亏钱和看错了才亏钱是<b>两个病</b>，一个要改执行、一个要改读盘。
        按<b>入场日</b>对齐（那天的操作依据是前一晚的判断），盈亏为 0 的日子不进任何一格。
      </p>
      <div className="grid grid-cols-2 gap-2.5">
        {CELLS.map((c) => {
          const cell = q[c.key];
          const days = cell?.days ?? 0;
          return (
            <div key={c.key}
              className={cn("rounded-xl border p-3", days > 0 ? c.tone : "border-border bg-muted/10")}>
              <div className="flex flex-wrap items-baseline gap-1.5">
                <span className="text-[12px] font-bold">{c.label}</span>
                {c.tag && days > 0 && (
                  <span className="text-[10px] text-warning">{c.tag}</span>
                )}
              </div>
              <div className="mt-1 flex items-baseline gap-2">
                <span className={cn("text-lg font-extrabold tabular-nums",
                  days > 0 ? "" : "text-muted-foreground/50")}>{days}</span>
                <span className="text-[11px] text-muted-foreground">天</span>
                {days > 0 && (
                  <span className={cn("text-[12px] font-bold tabular-nums", tone(cell.pnl))}>
                    {cell.pnl > 0 ? "+" : ""}{cell.pnl.toLocaleString()}
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>
      <p className="mt-2.5 text-[11px] text-muted-foreground">
        共 {rep.days_counted} 个有盈亏的交易日
        {!rep.enough_samples && (
          <b className="text-warning"> · 样本太少，别急着下结论</b>
        )}
        {(rep.skipped_no_read ?? 0) > 0 && ` · ${rep.skipped_no_read} 笔那天没有判断记录，未计入`}
        {(rep.skipped_no_amount ?? 0) > 0 && ` · ${rep.skipped_no_amount} 笔只填了百分比、算不出金额`}
      </p>
    </div>
  );
}

/** 风险宪法编辑器。⚠️ 这些阈值是**使用者自己的规矩**，不是推荐值 ——
 *  不同资金量与打法的合理数值差得远，默认值只是能跑起来的初值。*/
function RulesEditor({ onSaved }: { onSaved: () => void }) {
  const [meta, setMeta] = useState<RiskRules | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState("");
  useEffect(() => {
    (async () => {
      try {
        const m = await agentFetch<RiskRules>("/api/risk/rules");
        setMeta(m);
        const d: Record<string, string> = {};
        for (const k of Object.keys(safeRecord(m.defaults))) d[k] = String(m.rules?.[k] ?? "");
        setDraft(d);
      } catch (error) {
        setMsg(error instanceof Error ? error.message : "读取失败");
        try {
          const schema = await agentFetch<RiskRules>("/api/risk/rules-schema");
          setMeta(schema);
          setDraft(Object.fromEntries(Object.keys(schema.defaults).map(k => [k, ""])));
        } catch { /* Keep the original failure visible; no automatic reset. */ }
      }
    })();
  }, []);
  if (!meta) return <p className="text-[12px] text-muted-foreground">{msg || "载入中…"}</p>;
  const save = async () => {
    setSaving(true); setMsg("");
    try {
      const rules: Record<string, number> = {};
      for (const [k, v] of Object.entries(draft)) {
        const n = Number(v);
        if (!v.trim() || !Number.isFinite(n) || n < 0 || (n === 0 && k !== "max_unplanned_ratio")) { setMsg(`${meta.labels[k] ?? k} 请填写有效数值`); setSaving(false); return; }
        rules[k] = n;
      }
      await agentPost("/api/risk/rules", { rules });
      setMsg("已保存"); onSaved();
    } catch (e) { setMsg(e instanceof Error ? e.message : "保存失败"); }
    setSaving(false);
  };
  return (
    <div className="mt-3 rounded-xl border border-border bg-muted/20 p-3">
      <p className="mb-2 text-[11px] text-muted-foreground">
        这些数字是<b>你自己的规矩</b>，不是我们的推荐值 —— 资金量和打法不同，合理阈值差得远。
        按自己实际的习惯填，系统只负责照着它检查。
      </p>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {Object.keys(safeRecord(meta.defaults)).map((k) => (
          <label key={k} className="flex items-center justify-between gap-2 text-[12px]">
            <span className="text-muted-foreground">{meta.labels[k] ?? k}</span>
            <input
              type="number" step="any" min="0"
              className="w-20 rounded border border-border bg-background px-2 py-1 text-right tabular-nums"
              value={draft[k] ?? ""}
              onChange={(e) => setDraft({ ...draft, [k]: e.target.value })}
            />
          </label>
        ))}
      </div>
      <div className="mt-3 flex items-center gap-3">
        <button onClick={save} disabled={saving}
          className="cursor-pointer rounded-lg bg-primary px-3 py-1.5 text-[12px] font-bold text-primary-foreground transition-colors hover:bg-primary/85 disabled:opacity-50">
          {saving ? "保存中…" : "保存我的规则"}
        </button>
        <button onClick={() => {
            const d: Record<string, string> = {};
            for (const [k, v] of Object.entries(safeRecord<number>(meta.defaults))) d[k] = String(v);
            setDraft(d);
          }}
          className="cursor-pointer text-[12px] text-muted-foreground transition-colors hover:text-foreground">
          恢复默认值
        </button>
        {msg && <span className="text-[12px] text-muted-foreground">{msg}</span>}
      </div>
    </div>
  );
}

function RiskRulesPanel({ value, onSaved }: { value: RiskReport["violations"]; onSaved: () => void }) {
  const [editing, setEditing] = useState(false);
  const vi = value || { available: false };
  return (
        <div className="glass rounded-2xl p-5">
          <h3 className="text-sm font-bold">
            你自己的规则
            <button onClick={() => setEditing((v) => !v)}
              className={cn("ml-2 cursor-pointer rounded px-1.5 py-0.5 text-[10px] font-normal transition-colors",
                vi.is_default_rules
                  ? "bg-warning/15 text-warning hover:bg-warning/25"
                  : "bg-muted text-muted-foreground hover:text-foreground")}>
              {vi.is_default_rules
                ? (editing ? "收起" : "还在用默认阈值 · 点这里改成你自己的")
                : (editing ? "收起" : "改我的规则")}
            </button>
          </h3>
          {editing && <RulesEditor onSaved={onSaved} />}
          <p className="mb-3 text-[11px] text-muted-foreground">
            系统只检查你有没有违反<b>自己写下的</b>规矩，不替你判断该不该交易。
          </p>
          {Object.entries(safeRecord<string>(vi.rule_status)).filter(([, status]) => status.startsWith("unavailable")).map(([key, status]) => (
            <p key={key} role="status" className="mb-2 text-[12px] text-warning">{status.replace(/^unavailable[：:]?/, "核对范围不足：")}</p>
          ))}
          {!vi.available ? <p className="text-[12px] text-muted-foreground">{vi.reason || "尚无可核对的交易样本；可以先设置规则。"}</p> : (vi.violation_count ?? 0) === 0 ? (
            <p className="text-[13px] text-success">{Object.values(vi.rule_status || {}).some(v => v.startsWith("unavailable")) ? "已检查的范围内未发现违规；缺资料的规则不能据此认定通过。" : "已检查的规则暂无违反记录。"}</p>
          ) : (
            <div className="max-h-48 space-y-1 overflow-y-auto">
              {safeArray<Violation>(vi.violations).map((v, i) => (
                <div key={i} className="flex flex-wrap items-center gap-2 text-[12px] tabular-nums">
                  <span className="w-20 shrink-0 text-muted-foreground">{v.date}</span>
                  <span className="rounded bg-danger/15 px-1.5 py-0.5 text-[10px] font-bold text-danger">
                    {v.label}
                  </span>
                  <span className="text-muted-foreground">{v.detail}</span>
                  <span className="text-[10px] text-muted-foreground/60">
                    （你的上限 {v.limit}）
                  </span>
                </div>
              ))}
            </div>
          )}
          {(vi.after_loss_streak?.trades ?? 0) > 0 && (
            <p className="mt-3 border-t border-border pt-2.5 text-[12px] text-muted-foreground">
              你连亏 {vi.after_loss_streak!.threshold} 笔后又做了{" "}
              <b className="text-foreground">{vi.after_loss_streak!.trades}</b> 笔，
              平均 <b className={tone(vi.after_loss_streak!.avg_pct)}>
                {signed(vi.after_loss_streak!.avg_pct)}
              </b>
              、胜率 <b className="text-foreground">{rate(vi.after_loss_streak!.win_rate)}</b>
              <span className="ml-1 text-[11px] opacity-70">
                ← 这是你自己的历史，不是建议
              </span>
            </p>
          )}
        </div>
  );
}

/** 个人风控：权益曲线形状 + 纪律归因 + 自设规则违反。
 *  ⚠️ 只统计使用者自己的交易，不给任何操作建议。⛔ 不接入任何 AI prompt。*/
function RiskPanel({ revision }: { revision: number }) {
  const [rep, setRep] = useState<RiskReport | null>(null);
  const [msg, setMsg] = useState("");
  const [tick, setTick] = useState(0);
  const reload = () => setTick((t) => t + 1);
  useEffect(() => {
    let active = true;
    (async () => {
      try { const value = await agentFetch<RiskReport>("/api/risk/report"); if (active) { setRep(value); setMsg(""); } }
      catch (error) { if (active) { setRep(null); setMsg(error instanceof Error ? error.message : "风控数据读取失败，请刷新重试"); } }
    })();
    return () => { active = false; };
  }, [tick, revision]);
  const eq = rep?.equity;
  const dp = rep?.discipline;
  const vi = rep?.violations;
  if (!eq?.available) {
    return (
      <section className="glass rounded-2xl p-5">
        <h3 className="text-sm font-bold">个人风控</h3>
        <p className="mt-1 text-[12px] text-muted-foreground">
          {msg || eq?.reason || "填了成交明细并平仓后，这里会给出权益曲线形状、纪律归因和规则检查。"}
        </p>
        <RiskRulesPanel value={vi} onSaved={reload} />
      </section>
    );
  }
  const wi = dp?.what_if_only_planned;
  return (
    <section className="space-y-4">
      <div className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.2em] text-primary">
        <ShieldAlert className="h-3.5 w-3.5" /> 个人风控 · Risk
      </div>

      <div className="glass rounded-2xl p-5">
        <h3 className="text-sm font-bold">权益曲线的形状</h3>
        {eq.date_note && <p className="text-[11px] text-muted-foreground">{eq.date_note}</p>}
        <p className="mb-3 text-[11px] text-muted-foreground">
          累计赚多少没什么信息量。真正要看的是回撤多深、多久没创新高、盈利是不是靠少数几笔。
        </p>
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <div>
            <div className={cn("text-xl font-extrabold tabular-nums", tone(eq.net_pnl))}>
              {eq.net_pnl! > 0 ? "+" : ""}{eq.net_pnl?.toLocaleString()}
            </div>
            <div className="text-[11px] text-muted-foreground">净盈亏（{eq.trades} 笔）</div>
          </div>
          <div>
            <div className="text-xl font-extrabold tabular-nums text-danger">
              -{eq.current_drawdown?.toLocaleString()}
            </div>
            <div className="text-[11px] text-muted-foreground">
              距高点回撤（史上最大 {eq.max_drawdown?.toLocaleString()}）
            </div>
          </div>
          <div>
            <div className="text-xl font-extrabold tabular-nums">{eq.trades_since_peak}</div>
            <div className="text-[11px] text-muted-foreground">笔未创新高</div>
          </div>
          <div>
            <div className="text-xl font-extrabold tabular-nums">
              {eq.profit_factor ?? "—"}
            </div>
            <div className="text-[11px] text-muted-foreground">
              Profit Factor（胜率 {rate(eq.win_rate)}）
            </div>
          </div>
        </div>
        {/* 盈利集中度：去掉最好的几笔之后还剩多少 */}
        {eq.net_without_best1 != null && (
          <div className="mt-3 border-t border-border pt-2.5 text-[12px] tabular-nums">
            <span className="text-muted-foreground">去掉最好 1 笔：</span>
            <b className={tone(eq.net_without_best1)}>{eq.net_without_best1.toLocaleString()}</b>
            <span className="mx-2 text-muted-foreground">·</span>
            <span className="text-muted-foreground">去掉最好 3 笔：</span>
            <b className={tone(eq.net_without_best3)}>{eq.net_without_best3?.toLocaleString()}</b>
            {eq.net_without_best1 < 0 && eq.net_pnl! > 0 && (
              <span className="ml-2 text-[11px] text-warning">⚠️ 去掉最好一笔就是亏的</span>
            )}
            <span className="ml-2 text-[11px] text-muted-foreground/70">
              最长连亏 {eq.worst_losing_streak} 笔 · 最差一笔 {eq.worst_trade?.toLocaleString()}
            </span>
          </div>
        )}
      </div>

      {/* 滚动窗口 —— 终身统计会把最近的退化藏起来 */}
      {rep?.rolling?.available && <RollingTable r={rep.rolling} />}

      {/* MFE/MAE —— 单独端点（逐笔要拉行情），不塞进 report 拖慢页面 */}
      <ExcursionPanel />

      {/* 判断 vs 执行四格 —— 只有市场层和个人层都有数据时才算得出来 */}
      <AttributionGrid />

      {/* 纪律归因：只保留「按计划」的交易时，曲线会是什么样 */}
      {dp?.available && wi?.cost_of_indiscipline != null && (
        <div className="glass rounded-2xl p-5">
          <h3 className="text-sm font-bold">纪律值多少钱</h3>
          <p className="mb-3 text-[11px] text-muted-foreground">
            如果删掉所有「计划外」交易，你的账户会是什么样。{dp.note}
          </p>
          <div className="flex flex-wrap items-center gap-4">
            <div>
              <div className={cn("text-xl font-extrabold tabular-nums", tone(wi.actual_net))}>
                {wi.actual_net?.toLocaleString()}
              </div>
              <div className="text-[11px] text-muted-foreground">实际净盈亏</div>
            </div>
            <div className="text-xl text-muted-foreground">→</div>
            <div>
              <div className={cn("text-xl font-extrabold tabular-nums", tone(wi.planned_only_net))}>
                {wi.planned_only_net?.toLocaleString()}
              </div>
              <div className="text-[11px] text-muted-foreground">只做按计划的</div>
            </div>
            <div className={cn("rounded-lg px-3 py-2",
              wi.cost_of_indiscipline < 0 ? "bg-danger/10" : "bg-success/10")}>
              <div className={cn("text-xl font-extrabold tabular-nums",
                wi.cost_of_indiscipline < 0 ? "text-danger" : "text-success")}>
                {wi.cost_of_indiscipline > 0 ? "+" : ""}{wi.cost_of_indiscipline.toLocaleString()}
              </div>
              <div className="text-[11px] text-muted-foreground">
                {wi.cost_of_indiscipline < 0 ? "计划外交易的代价" : "计划外反而赚了"}
              </div>
            </div>
            {dp.execution_rate != null && (
              <div className="text-[12px] text-muted-foreground">
                执行率 <b className="text-foreground">{rate(dp.execution_rate)}</b>
              </div>
            )}
          </div>
        </div>
      )}

      <RiskRulesPanel value={vi} onSaved={reload} />
    </section>
  );
}

/** 给持仓中的交易补一笔成交。
 *  ⚠️ 卖出多于当时持仓会被后端拒掉 —— 那是录入错误，不该默默算出一个数。*/
function AppendFill({ trade, onSubmit, onCancel }: {
  trade: Trade;
  onSubmit: (t: Trade, side: "buy" | "sell", date: string, price: number, shares: number) => Promise<boolean>;
  onCancel: () => void;
}) {
  const [side, setSide] = useState<"buy" | "sell">("sell");
  const [date, setDate] = useState(localDate());
  const [price, setPrice] = useState("");
  const [shares, setShares] = useState("");
  const [busy, setBusy] = useState(false);
  const open = trade.settled?.open_shares ?? 0;

  const submit = async () => {
    const p = Number(price), q = Number(shares);
    if (!(p > 0) || !(q > 0)) return;
    setBusy(true);
    await onSubmit(trade, side, date, p, q);
    setBusy(false);
  };

  return (
    <div className="flex flex-wrap items-center gap-2 text-[12px]">
      <span className="font-semibold">补一笔成交</span>
      <span className="text-muted-foreground">当前持有 {open} 股</span>
      <div className="flex items-center gap-1 rounded-lg border border-border bg-card px-1">
        {(["sell", "buy"] as const).map((v) => (
          <button key={v} onClick={() => setSide(v)}
            className={cn("rounded px-2 py-1 text-[11px] transition-colors",
              side === v ? (v === "sell" ? "bg-danger/15 text-danger" : "bg-success/15 text-success")
                : "text-muted-foreground hover:text-foreground")}>
            {v === "sell" ? "卖出" : "加仓"}
          </button>
        ))}
      </div>
      <input type="date" value={date} onInput={(e) => setDate(e.currentTarget.value)} onChange={(e) => setDate(e.target.value)}
        className="rounded border border-border bg-card px-2 py-1" />
      <input type="number" step="0.01" placeholder="价" value={price}
        onChange={(e) => setPrice(e.target.value)}
        className="w-20 rounded border border-border bg-card px-2 py-1" />
      <input type="number" step="100" placeholder="股数" value={shares}
        onChange={(e) => setShares(e.target.value)}
        className="w-24 rounded border border-border bg-card px-2 py-1" />
      {side === "sell" && open > 0 && (
        <button onClick={() => setShares(String(open))}
          className="text-[11px] text-primary hover:underline">全部</button>
      )}
      <button onClick={submit} disabled={busy}
        className="flex items-center gap-1 rounded-lg bg-primary px-3 py-1 font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50">
        {busy && <Loader2 className="h-3 w-3 animate-spin" />}保存
      </button>
      <button onClick={onCancel} className="text-muted-foreground hover:text-foreground">取消</button>
      <span className="text-[11px] text-muted-foreground/70">
        建仓时间与「下单时写的计划止损」都会原样保留
      </span>
    </div>
  );
}


/** 交易费率。⚠️ 默认值只是能跑起来的初值，**不是推荐值也不是你的真实费率** ——
 *  各家券商佣金差别很大，不改就用初值估算，统计会带着这个偏差。*/
function FeeConfig({onSaved}: {onSaved: () => Promise<void>}) {
  const [fees, setFees] = useState<Record<string, number | string> | null>(null);
  const [labels, setLabels] = useState<Record<string, string>>({});
  const [isDefault, setIsDefault] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const loadId = useRef(0);

  const load = async () => {
    const id = ++loadId.current;
    setLoading(true);
    try {
      const r = await agentFetch<{ fees: Record<string, number | boolean>;
                                  labels: Record<string, string> }>("/api/journal/fees");
      if (id !== loadId.current) return;
      const raw = r.fees || {};
      setIsDefault(Boolean(raw.is_default));
      const nums: Record<string, number> = {};
      for (const [k, v] of Object.entries(raw)) {
        if (k !== "is_default" && typeof v === "number") nums[k] = v;
      }
      const keys = Object.keys(r.labels || {});
      if (!keys.length || keys.some(k => !(k in nums)) || Object.keys(nums).length !== keys.length) throw new Error("费率资料不完整");
      setFees(nums); setLabels(r.labels); setLoadError("");
    } catch (e) {
      if (id !== loadId.current) return;
      setLoadError(e instanceof Error ? e.message : "费率读取失败");
      try {
        const schema = await agentFetch<{labels: Record<string,string>}>("/api/journal/fees-schema");
        if (id !== loadId.current) return;
        setLabels(schema.labels);
        setFees(current => current ?? Object.fromEntries(Object.keys(schema.labels).map(k => [k, ""])));
      } catch { /* 保留已有输入；loadError 与重试入口仍可见。 */ }
    } finally { if (id === loadId.current) setLoading(false); }
  };
  useEffect(() => { load(); return () => { ++loadId.current; }; }, []);
  if (!fees) return <div className="glass rounded-2xl p-5"><h3>交易费率</h3>
    <p role="status">{loadError || "正在读取费率…"}</p>
    {loadError && <button disabled={loading} onClick={load}>重试读取费率</button>}</div>;

  const save = async () => {
    if (!Object.keys(labels).length || Object.keys(labels).some(k => !(k in fees)) || Object.keys(fees).length !== Object.keys(labels).length || Object.values(fees).some(v => String(v).trim() === "")) {
      setMsg("请填写全部费率项目，确认后再保存"); return;
    }
    setBusy(true); setMsg("");
    try {
      const r = await agentPost<{ ok?: boolean; error?: string }>("/api/journal/fees", { fees });
      setMsg(r?.error ? r.error : "已保存");
      if (!r?.error) {
        await load();
        try { await onSaved(); } catch { setMsg("费率已保存，但交易统计刷新失败，请刷新页面"); }
      }
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "保存失败");
    } finally { setBusy(false); }
  };

  return (
    <div className="glass rounded-2xl p-5">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-bold">交易费率</h3>
        {isDefault && (
          <span className="rounded bg-warning/15 px-1.5 py-0.5 text-[10px] text-warning">
            还在用初值
          </span>
        )}
        <Caliber text={
          "所有盈亏都按**净额**算：毛盈亏 − 佣金 − 印花税 − 过户费。\n\n" +
          "· 在成交明细里填了实际费用的，以那个为准（对账单上的数最可靠）。\n" +
          "· 没填的按这里的费率估算，界面上会标「费估」。\n" +
          "· 印花税只在卖出收；佣金有单笔最低值，小仓位试仓时它占比很高。\n\n" +
          "⚠️ 默认值只是能跑起来的初值，**不是推荐值** —— 各家券商佣金差别很大，" +
          "不改成自己的真实费率，胜率与期望会带着偏差。"
        } />
      </div>
      <p className="mb-3 mt-1 text-[11px] text-muted-foreground">
        对高换手的短线打法，费用不是小数：一堆薄利交易在计费后可能接近持平甚至转亏。
      </p>
      {loadError && <div className="mb-3 text-sm text-warning"><p role="alert">{loadError}。读取失败不会修改原文件；可以重试读取，或按自己的账户填写以下项目后保存。</p><button disabled={busy || loading} onClick={load}>重试读取费率</button></div>}
      <div className="flex flex-wrap gap-3">
        {Object.entries(fees).map(([k, v]) => (
          <label key={k} className="flex items-center gap-1.5 text-[12px]">
            <span className="text-muted-foreground">{labels[k] || k}</span>
            <input type="number" step="any" value={v} disabled={busy || loading}
              onChange={(e) => setFees({ ...fees, [k]: e.target.value })}
              className="w-28 rounded border border-border bg-card px-2 py-1 text-right tabular-nums" />
          </label>
        ))}
        <button onClick={save} disabled={busy || loading}
          className="flex items-center gap-1 rounded-lg bg-primary px-3 py-1.5 text-[12px] font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50">
          {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}保存
        </button>
        {msg && <span className="self-center text-[12px] text-muted-foreground">{msg}</span>}
      </div>
      <p className="mt-2 text-[11px] text-muted-foreground/70">
        万 2.5 填 0.00025；印花税 0.05% 填 0.0005。
      </p>
    </div>
  );
}


export function Journal() {
  const [trades, setTrades] = useState<Trade[]>([]);
  const [offset, setOffset] = useState(0);
  const [total, setTotal] = useState(0);
  const [stats, setStats] = useState<JournalStats | null>(null);
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const alive = useRef(true);

  // 录入表单
  const [date, setDate] = useState(localDate());
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [playbook, setPlaybook] = useState("打板");
  const [pnl, setPnl] = useState("");
  const [planned, setPlanned] = useState<boolean | null>(null);
  const [note, setNote] = useState("");
  // 成交明细（可选）。填了就能算加权成本/已实现盈亏/持有天数，支持分批与做 T
  const [fills, setFills] = useState<Fill[]>([]);
  // ⚠️ 计划退出边界必须是下单时填的。后端加了字段而录入表单没接上时，
  //    每个仓位都会变成"未设止损"，且界面上看不出异常。
  const [editId, setEditId] = useState<string | null>(null);   // 正在补成交的那笔
  const [plannedStop, setPlannedStop] = useState("");
  const [plannedTarget, setPlannedTarget] = useState("");
  const addFill = (side: "buy" | "sell") =>
    setFills((prev) => [...prev, { side, date, price: 0, shares: 0 }]);
  const setFill = (i: number, patch: Partial<Fill>) =>
    setFills((prev) => prev.map((f, j) => (j === i ? { ...f, ...patch } : f)));
  const delFill = (i: number) => setFills((prev) => prev.filter((_, j) => j !== i));

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  const listRequest = useRef(0);
  async function load() {
    const requestId = ++listRequest.current;
    try {
      const [l, s] = await Promise.all([
        agentFetch<{ trades: Trade[]; total: number }>(`/api/journal/list?limit=200&offset=${offset}`),
        agentFetch<JournalStats>("/api/journal/stats"),
      ]);
      if (!alive.current || requestId !== listRequest.current) return;
      setTrades(safeArray<Trade>(l?.trades));
      setTotal(l.total);
      setStats(s);
      setRevision(v => v + 1);
    } catch (e) {
      // 账本损坏时后端给 500 + 原因 —— 必须原样显示，别让用户以为记录丢了就重新录
      if (alive.current && requestId === listRequest.current) {
        setMsg(e instanceof Error && e.message
          ? `读取失败：${e.message}（若是账本损坏，先别录新的，去 ~/.duanxian-agents/journal/ 看备份）`
          : "读取失败");
      }
    }
  }
  useEffect(() => { load(); return () => { ++listRequest.current; }; /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [offset]);

  async function submit() {
    if (!code.trim()) { setMsg("请填代码"); return; }
    const parsedPnl = pnl.trim() === "" ? null : Number(pnl.trim().replace(/[%％]$/, ""));
    if (parsedPnl !== null && !Number.isFinite(parsedPnl)) { setMsg("盈亏请填写有效数字，例如 3.2 或 3.2%"); return; }
    setBusy(true); setMsg("");
    try {
      const r = await agentPost<{ ok?: boolean; error?: string }>("/api/journal/add", {
        date, code, name, playbook,
        pnl_pct: parsedPnl,
        as_planned: planned, note,
        // 只把填全的成交行发上去（价量都 >0）
        fills: fills.filter((f) => f.price > 0 && f.shares > 0),
        planned_stop: plannedStop.trim() === "" ? null : Number(plannedStop),
        planned_target: plannedTarget.trim() === "" ? null : Number(plannedTarget),
      });
      // ⚠️ 必须同时检查 error 和 ok：写盘失败时后端返回 ok:false 而没有 error，
      //    只看 error 会在这一笔根本没记上的情况下显示"已记录"。
      if (r?.error) { setMsg(r.error); return; }
      if (r?.ok !== true) { setMsg("记录失败，请重试（这一笔没记上）"); return; }
      setCode(""); setName(""); setPnl(""); setNote(""); setPlanned(null); setFills([]);
      setPlannedStop(""); setPlannedTarget("");
      await load();
      setMsg("已记录");
    } catch (e) {
      setMsg(e instanceof Error && e.message ? `提交失败：${e.message}` : "提交失败");
    } finally {
      if (alive.current) setBusy(false);
    }
  }

  // 补成交：持仓中的记录要能追加卖出/加仓，而不是删了重录。
  // ⚠️ 删了重录会丢掉 created_at 与「计划边界是下单时写的」这个证据 ——
  //    在险资金的全部意义就建立在后者上。
  async function appendFill(t: Trade, side: "buy" | "sell",
                            date: string, price: number, shares: number) {
    setMsg("");
    try {
      const r = await agentPost<{ ok?: boolean; error?: string }>(
        `/api/journal/update?trade_id=${encodeURIComponent(t.id)}`,
        { fills: [...(t.fills ?? []), { side, date, price, shares }] });
      if (r?.error) { setMsg(r.error); return false; }
      if (r?.ok !== true) { setMsg("补成交失败，这一笔没记上"); return false; }
      setEditId(null);
      await load();
      setMsg("已补上");
      return true;
    } catch (e) {
      setMsg(e instanceof Error ? `补成交失败：${e.message}` : "补成交失败");
      return false;
    }
  }

  async function remove(id: string) {
    if (!window.confirm("确认删除这笔交易及其成交明细？删除后无法恢复，并会重新计算持仓和统计。")) return;
    try {
      const result = await agentPost<{ok?: boolean; error?: string; reason?: string}>(`/api/journal/delete?trade_id=${encodeURIComponent(id)}`, {});
      if (result.ok !== true) { setMsg(result.error || result.reason || "删除失败，原记录仍保留"); return; }
      if (trades.length === 1 && offset > 0) setOffset(Math.max(0, offset - 200));
      else await load();
    } catch { setMsg("删除失败"); }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold">
          <NotebookPen className="h-6 w-6 text-primary" /> 交易日志
        </h1>
        <p className="mt-0.5 text-sm text-muted-foreground">
          每笔交易自动钉上当时的市场环境 · 时间久了能回答「我在退潮期是不是明显更差」这类问题
        </p>
      </div>

      {/* 录入 */}
      <section className="glass rounded-2xl p-5">
        <h3 className="mb-3 text-sm font-bold">记一笔</h3>
        <div className="flex flex-wrap gap-2">
          <input type="date" value={date} onInput={(e) => setDate(e.currentTarget.value)} onChange={(e) => setDate(e.target.value)}
            className="rounded-lg border border-border bg-card px-3 py-2 text-sm" />
          <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="代码 如 002879"
            className="w-32 rounded-lg border border-border bg-card px-3 py-2 text-sm" />
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="简称（可选）"
            className="w-32 rounded-lg border border-border bg-card px-3 py-2 text-sm" />
          <select value={playbook} onChange={(e) => setPlaybook(e.target.value)}
            className="rounded-lg border border-border bg-card px-3 py-2 text-sm">
            {PLAYBOOKS.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
          <input value={pnl} onChange={(e) => setPnl(e.target.value)} placeholder="盈亏% 如 3.2 / -5"
            className="w-32 rounded-lg border border-border bg-card px-3 py-2 text-sm" />
          <div className="flex items-center gap-1 rounded-lg border border-border bg-card px-2">
            {[["按计划", true], ["计划外", false]].map(([label, v]) => (
              <button key={String(v)} onClick={() => setPlanned(planned === v ? null : (v as boolean))}
                className={cn("rounded px-2 py-1 text-[12px] transition-colors",
                  planned === v ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground")}>
                {label as string}
              </button>
            ))}
          </div>
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="当时为什么做这笔（复盘时最值钱的一栏）"
            className="min-w-[220px] flex-1 rounded-lg border border-border bg-card px-3 py-2 text-sm" />
          <button onClick={submit} disabled={busy}
            className="flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50">
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}记录
          </button>
        </div>
        {/* 成交明细可选：填了才能算加权成本、已实现盈亏、持有天数（支持分批与做 T）；
            不填则只有手填的盈亏%，统计里归到"未填明细"。*/}
        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border pt-3">
          <span className="text-[12px] font-semibold">计划退出</span>
          <span className="text-[11px] text-muted-foreground">
            下单时就想好的价位（在险资金靠计划止损算；事后补等于造假纪律证据）
          </span>
          <label className="flex items-center gap-1.5 text-[12px]">
            <span className="text-muted-foreground">亏到</span>
            <input type="number" min="0" step="any" value={plannedStop}
              onChange={(e) => setPlannedStop(e.target.value)} placeholder="止损价"
              className="w-24 rounded border border-border bg-background px-2 py-1 text-right tabular-nums" />
            <span className="text-muted-foreground">就走</span>
          </label>
          <label className="flex items-center gap-1.5 text-[12px]">
            <span className="text-muted-foreground">赚到</span>
            <input type="number" min="0" step="any" value={plannedTarget}
              onChange={(e) => setPlannedTarget(e.target.value)} placeholder="目标价（可选）"
              className="w-28 rounded border border-border bg-background px-2 py-1 text-right tabular-nums" />
            <span className="text-muted-foreground">就走</span>
          </label>
        </div>
        <div className="mt-3 border-t border-border pt-3">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <span className="text-[12px] font-semibold">成交明细</span>
            <span className="text-[11px] text-muted-foreground">
              有成交明细时，以明细扣费计算的盈亏覆盖手填盈亏%；未卖出部分不计已实现盈亏。自动算加权成本 / 已实现盈亏 / 持有天数（支持分批与隔日卖；同日买卖需核实可卖底仓）
            </span>
            <button onClick={() => addFill("buy")}
              className="rounded border border-success/40 px-2 py-0.5 text-[11px] text-success hover:bg-success/10">
              + 买入
            </button>
            <button onClick={() => addFill("sell")}
              className="rounded border border-danger/40 px-2 py-0.5 text-[11px] text-danger hover:bg-danger/10">
              + 卖出
            </button>
          </div>
          {fills.map((f, i) => (
            <div key={i} className="mb-1 flex flex-wrap items-center gap-1.5">
              <span className={cn("w-10 rounded px-1.5 py-0.5 text-center text-[11px] font-bold",
                f.side === "buy" ? "bg-success/15 text-success" : "bg-danger/15 text-danger")}>
                {f.side === "buy" ? "买" : "卖"}
              </span>
              <input type="date" value={f.date} onInput={(e) => setFill(i, { date: e.currentTarget.value })} onChange={(e) => setFill(i, { date: e.target.value })}
                className="rounded border border-border bg-card px-2 py-1 text-[12px]" />
              <input type="number" step="0.01" placeholder="价"
                value={f.price || ""} onChange={(e) => setFill(i, { price: Number(e.target.value) })}
                className="w-20 rounded border border-border bg-card px-2 py-1 text-[12px]" />
              <input type="number" step="100" placeholder="股数"
                value={f.shares || ""} onChange={(e) => setFill(i, { shares: Number(e.target.value) })}
                className="w-24 rounded border border-border bg-card px-2 py-1 text-[12px]" />
              <button onClick={() => delFill(i)}
                className="text-muted-foreground/50 hover:text-danger"><Trash2 className="h-3.5 w-3.5" /></button>
            </div>
          ))}
        </div>
        {msg && <p className="mt-2 text-[12px] text-muted-foreground">{msg}</p>}
      </section>

      {/* 自我体检 */}
      {stats?.available && (
        <section className="space-y-4">
          <div className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.2em] text-primary">
            <BarChart3 className="h-3.5 w-3.5" /> 自我体检 · Self Check
            <Caliber text={
              "本区所有读数只统计**你自己录入的交易**，不含任何市场预测。\n\n" +
              "· 胜率 = 盈利笔数 ÷ (盈利 + 亏损) 笔数。**持平不计入分母** —— " +
              "加一笔持平不会拉低胜率；全部持平时显示「—」而不是 0%。\n" +
              "· 平均每笔 / 最好 / 最差：按盈亏**百分比**算，与仓位无关。\n" +
              "· 净盈亏：只汇总**填了成交明细**的那些笔的已实现金额，" +
              "未平仓部分不计浮盈浮亏。所以它的样本数通常小于总笔数。\n" +
              "· **所有盈亏都是净额，已扣佣金、印花税与过户费。** 没在成交里填实际费用时，" +
              "按本页底部配置的费率估算；费率没配过就用一套初值，那不是你的真实费率。\n" +
              "  ⚠️ 对高换手的打法这不是小数：一堆薄利交易在计费后可能接近持平甚至转亏。\n" +
              "· 百分比与金额是两个口径：仓位不同时，两者结论可能相反。\n\n" +
"全站胜率口径一致（模式卡那一块用的是同一个算法）。"
            } />
          </div>
          <div className="glass rounded-2xl p-5">
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
              <div>
                <div className={cn("text-2xl font-extrabold tabular-nums", tone(stats.overall?.avg))}>
                  {signed(stats.overall?.avg)}
                </div>
                <div className="text-[11px] text-muted-foreground">平均每笔</div>
              </div>
              <div>
                <div className="text-2xl font-extrabold tabular-nums">{rate(stats.overall?.win_rate)}</div>
                <div className="text-[11px] text-muted-foreground">胜率</div>
              </div>
              <div>
                <div className="text-2xl font-extrabold tabular-nums text-success">{signed(stats.overall?.best)}</div>
                <div className="text-[11px] text-muted-foreground">最好一笔</div>
              </div>
              <div>
                <div className="text-2xl font-extrabold tabular-nums text-danger">{signed(stats.overall?.worst)}</div>
                <div className="text-[11px] text-muted-foreground">最差一笔</div>
              </div>
              {stats.overall?.net_pnl != null && (
                <div>
                  <div className={cn("text-2xl font-extrabold tabular-nums",
                    pctColor(stats.overall.net_pnl))}>
                    {stats.overall.net_pnl > 0 ? "+" : ""}{stats.overall.net_pnl.toLocaleString()}
                  </div>
                  <div className="text-[11px] text-muted-foreground">
                    净盈亏（元，{stats.overall.money_scored} 笔有明细）
                  </div>
                </div>
              )}
            </div>
            <p className="mt-3 border-t border-border pt-2 text-[11px] text-muted-foreground">
              共 {stats.overall?.count} 笔（{stats.overall?.scored} 笔填了盈亏）。
              ⚠️ 这是对你自己历史行为的统计，不预测市场、不给下一笔建议。
            </p>
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <BucketRows title="按情绪环境" hint="同一套打法在发酵期和退潮期完全是两回事——这是最该看的一组。" data={stats.by_phase} />
            <BucketRows title="按打法" hint="打板 / 低吸 / 接力，哪个更适合你。" data={stats.by_playbook} />
            <BucketRows title="按是否按计划" hint="「计划外」的单子是不是亏得更多——最容易发现纪律问题的一组。" data={stats.by_planned} />
            <BucketRows title="按当时板位" hint="你买的时候它是首板还是高位板。" data={stats.by_boards} />
            <BucketRows title="按持有周期" hint="按自然日分组；同日买卖不等于已核实可执行的做T。" data={stats.by_hold} />
          </div>
        </section>
      )}

      {/* 在险资金：讲的是"最坏"，比浮盈浮亏更要紧，所以排在最前 */}
      <AtRiskPanel revision={revision} />

      {/* 异常交易收件箱 */}
      <InboxPanel revision={revision} />

      {/* 个人风控：权益曲线 / 纪律归因 / 规则违反 */}
      <RiskPanel revision={revision} />

      {/* 个人模式卡 */}
      <ModesPanel revision={revision} />

      {/* 流水 */}
      <section>
        <div className="mb-2 text-[11px] font-bold uppercase tracking-[0.2em] text-primary">交易流水 · Trades</div>
        <div className="mb-3 flex items-center gap-3 text-sm">
          <span>共 {total} 笔 · 当前 {total ? offset + 1 : 0}–{offset + trades.length}</span>
          <button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 200))} className="disabled:opacity-30">上一页</button>
          <button disabled={offset + trades.length >= total} onClick={() => setOffset(offset + 200)} className="disabled:opacity-30">下一页</button>
        </div>
        {trades.length === 0 ? (
          <div className="glass rounded-2xl py-12 text-center text-muted-foreground">
            还没有记录。记第一笔试试 —— 环境会自动钉上去。
          </div>
        ) : (
          <div className="glass overflow-x-auto rounded-2xl p-2">
            <table className="w-full text-[12px] tabular-nums">
              <thead>
                <tr className="border-b border-border text-[11px] text-muted-foreground">
                  {["日期", "标的", "打法", "盈亏", "金额/持有", "当时环境", "当时状态", "备注", ""].map((h) => (
                    <th key={h} className="px-2 py-2 text-left font-semibold">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {trades.map((t) => (
                  <Fragment key={t.id}>
                  <tr className="border-b border-border/40 last:border-0">
                    <td className="px-2 py-2">{t.date}</td>
                    <td className="px-2 py-2">
                      <b>{t.name || t.code}</b>
                      <span className="ml-1 text-[10px] text-muted-foreground">{t.code}</span>
                    </td>
                    <td className="px-2 py-2">
                      <span className="rounded bg-muted px-1.5 py-0.5 text-[11px]">{t.playbook}</span>
                      {t.as_planned === false && <span className="ml-1 text-[10px] text-warning">计划外</span>}
                    </td>
                    <td className={cn("px-2 py-2 font-bold", tone(t.pnl_pct))}>{signed(t.pnl_pct)}</td>
                    <td className="px-2 py-2 text-muted-foreground">
                      {/* ⚠️ 三态必须分清：已实现 / 持仓中（填了明细还没卖）/ 真的没填。
                          只判 `realized_pnl != null` 会把未平仓显示成「未填明细」，
                          与明细被丢弃时的表现一模一样，无法区分。 */}
                      {t.settled?.realized_pnl != null
                        ? <>
                          <b className={pctColor(t.settled.realized_pnl)}
                            title={t.settled.fees != null
                              ? `毛 ${t.settled.gross_pnl} − 费用 ${t.settled.fees}`
                                + `${t.settled.fees_are_estimated ? "（估算）" : "（实填）"}`
                              : undefined}>
                            {t.settled.realized_pnl > 0 ? "+" : ""}{t.settled.realized_pnl.toLocaleString()}
                          </b>
                          {t.settled.fees != null && (
                            <span className="ml-1 text-[10px] text-muted-foreground/70">
                              净{t.settled.fees_are_estimated ? "·费估" : ""}
                            </span>
                          )}
                          {t.settled.hold_days != null
                            && ` · 持${t.settled.hold_days}天${t.settled.settlement_warning ? " · 部分卖出可卖底仓未核实" : ""}`}
                          {t.settled.closed === false && <span className="text-warning"> · 未平</span>}
                        </>
                        : t.settled?.has_fills
                        ? <>
                          <span className="text-warning">持仓中</span>
                          {t.settled.amount != null && ` · 占用 ${t.settled.amount.toLocaleString()}`}
                        </>
                        : <span className="opacity-50">未填明细</span>}
                    </td>
                    <td className="px-2 py-2 text-muted-foreground">
                      {t.market?.emotion_phase
                        ? <>{t.market.emotion_phase}
                          {t.market.money_effect_median != null && ` · 赚钱${signed(t.market.money_effect_median)}`}</>
                        : <span className="opacity-60">无当日复盘</span>}
                    </td>
                    <td className="px-2 py-2 text-muted-foreground">
                      {t.stock?.in_limit_up
                        ? <>{t.stock.boards}板{t.stock.first_seal && ` · 首封${hhmm(t.stock.first_seal)}`}
                          {(t.stock.broken_times ?? 0) > 0 && ` · 炸${t.stock.broken_times}`}
                          {t.stock.sector && ` · ${t.stock.sector}`}</>
                        : <span className="opacity-60">非当日涨停</span>}
                    </td>
                    <td className="max-w-[220px] truncate px-2 py-2 text-muted-foreground" title={t.note}>{t.note}</td>
                    <td className="px-2 py-2">
                      <div className="flex items-center justify-end gap-1.5">
                        {t.settled?.has_fills && t.settled?.closed === false && (
                          <button onClick={() => setEditId(editId === t.id ? null : t.id)}
                            title="补一笔成交（卖出或加仓）"
                            className="rounded border border-border px-1.5 py-0.5 text-[10px] text-primary transition-colors hover:bg-primary/10">
                            补成交
                          </button>
                        )}
                        <button onClick={() => remove(t.id)} title="删除"
                          className="text-muted-foreground/50 transition-colors hover:text-danger">
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </td>
                  </tr>
                  {editId === t.id && (
                    <tr className="border-b border-border/40 bg-muted/20">
                      <td colSpan={9} className="px-2 py-3">
                        <AppendFill trade={t} onSubmit={appendFill}
                          onCancel={() => setEditId(null)} />
                      </td>
                    </tr>
                  )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <FeeConfig onSaved={load} />

      <p className="border-t border-border pt-4 text-xs text-muted-foreground/70">
        数据只存在本机 <code>~/.duanxian-agents/journal/</code>，不上传。
        本页只统计你自己录入的历史行为，不构成投资建议。
      </p>
    </div>
  );
}
