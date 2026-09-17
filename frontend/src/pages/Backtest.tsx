import { useEffect, useRef, useState } from "react";
import { pctColor } from "@/lib/colors";
import { TrendingDown, Loader2, RefreshCw, Info } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  agentFetch, finite, plain, safeArray, safeRecord,
  type BacktestData, type BacktestDay, type BacktestStats,
  type ArchiveSummary, type ArchiveDrift, type DriftReport, type DriftMetric,
} from "@/lib/agent";

const DISCLAIMER =
  "本页统计历史涨停样本的后续表现，不代表可执行策略的收益，也不产出前瞻标的。";

// ⚠️ 这段警告不能删也不能弱化。样本是"事后知道封住了"的名单 ——
// 实测某日 141 只票冲过板、只有 116 只封住，18% 的失败样本完全不在统计里。
// 把这里的数字当成"打板这套打法的期望"是会亏钱的误读。
const CAVEAT =
  "样本是收盘仍在涨停池里的事后名单，包含一字板等未必能成交的股票，未排除排队买不到的情况。"
  + "冲板失败且未回封的股票不在样本内。没有成交模拟，不能推导真实交易收益或打法期望。";

const EMPTY: BacktestStats = {
  sample: 0, win_rate: null, avg: null, median: null, best: null, worst: null, limit_up_rate: null,
};

// ⚠️ 一律先过 finite()：NaN / Infinity 会溜过 `v == null`，显示成 "NaN%" 或灌进 CSS 宽高
function pctOf(v?: number | null): string {
  const n = finite(v);
  return n === null ? "—" : `${Math.round(n * 100)}%`;
}
function signed(v?: number | null): string {
  const n = finite(v);
  return n === null ? "—" : `${n > 0 ? "+" : ""}${n.toFixed(2)}%`;
}
function tone(v?: number | null): string {
  const n = finite(v);
  if (n === null) return "text-muted-foreground";
  return pctColor(n);
}

/** 分环境一行：同一套打法在不同情绪环境下往往是两回事 */
function RegimeRow({ name, s }: { name: string; s: BacktestStats }) {
  if (!s.sample) return null;
  return (
    <div className="flex items-center gap-2 text-[12px]">
      <span className="w-12 shrink-0 text-muted-foreground">{name}</span>
      <span className={cn("w-16 shrink-0 text-right font-semibold tabular-nums", tone(s.avg))}>{signed(s.avg)}</span>
      <span className="w-14 shrink-0 text-right tabular-nums text-muted-foreground">胜 {pctOf(s.win_rate)}</span>
      <span className="tabular-nums text-muted-foreground/60">n={s.sample}</span>
    </div>
  );
}

/** 归档状态：囤了多久、字段有没有漂移过。
 *  ⚠️ 数据源改字段会在派生曲线上造出一个**假断点**，不检测就会被读成"市场变了"。*/
function ArchiveNote() {
  const [sum, setSum] = useState<ArchiveSummary | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    (async () => {
      try { setSum(await agentFetch<ArchiveSummary>("/api/archive/summary")); } catch { /* 归档只是附加信息，读不到就不显示 */ }
    })();
  }, []);
  if (!sum) return null;
  const drifts = Object.values(safeRecord<ArchiveDrift>(sum.drift)).filter((d) => d.changed);
  return (
    <div className="rounded-xl border border-border bg-muted/20 px-4 py-2.5 text-[12px] leading-relaxed text-muted-foreground">
      {sum.coverage_note && <p role="status" className="text-warning">{sum.coverage_note}</p>}
      <b className="text-foreground">原始数据已归档 {sum.days} 天</b>
      （{sum.date_from} ~ {sum.date_to}，{sum.size_mb} MB，
      {Object.keys(safeRecord(sum.datasets)).length} 类数据）。
      归档存的是<b className="text-foreground">数据源原样返回的内容</b>，永不删除 ——
      所以口径改了之后，历史那些天可以按新口径<b className="text-foreground">重新算一遍</b>，
      而上面的缓存只是为了跑得快、随时能删掉重建。
      {drifts.length > 0 ? (
        <button onClick={() => setOpen((v) => !v)}
          className="ml-1 cursor-pointer text-warning underline decoration-dotted transition-colors hover:text-warning/80">
          ⚠ {drifts.length} 类数据的字段变过（{open ? "收起" : "看是哪些"}）
        </button>
      ) : (
        <span className="ml-1 text-success">仅在已有归档中未检出字段变化，不证明未覆盖日期稳定。</span>
      )}
      {open && (
        <div className="mt-2 space-y-1.5 border-t border-border pt-2">
          <p className="text-[11px]">
            数据源改字段要当<b className="text-foreground">制度变化</b>看待 ——
            跨这些日期的统计上会出现一个断点，它来自数据源、跟市场无关。
          </p>
          {drifts.map((d) => (
            <div key={d.slug} className="text-[11px]">
              <b className="text-foreground">{d.slug}</b>：
              {safeArray<{ since: string; fields: string[] }>(d.versions)
                .map((v) => `${v.since} 起 ${v.fields.length} 字段`).join(" → ")}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** 结构漂移：把「制度变了 / 数据源变了 / 市场真变了」三类分开。
 *  ⚠️ 不区分这三类，就会把前两类读成第三类，然后基于一个假信号调整打法。*/
function DriftNote() {
  const [rep, setRep] = useState<DriftReport | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    (async () => {
      try { setRep(await agentFetch<DriftReport>("/api/drift")); } catch { /* 附加信息 */ }
    })();
  }, []);
  if (!rep) return null;
  const st = rep.structure;
  const shifted = safeArray<DriftMetric>(st?.metrics).filter((m) => m.shifted);
  const fieldChanged = safeArray<string>(rep.field_changed);
  const quiet = !shifted.length && !fieldChanged.length;
  return (
    <div className={cn("rounded-xl border px-4 py-2.5 text-[12px] leading-relaxed",
      quiet ? "border-border bg-muted/20 text-muted-foreground"
            : "border-warning/40 bg-warning/10 text-warning")}>
      <b className={quiet ? "text-foreground" : ""}>结构漂移检测</b>
      {" · "}归档截至 {rep.last_archived_session || "未覆盖"} · {rep.summary}
      {rep.coverage_note && <p role="status" className="text-warning">{rep.coverage_note}</p>}
      <button onClick={() => setOpen((v) => !v)}
        className="ml-1 cursor-pointer underline decoration-dotted transition-opacity hover:opacity-80">
        {open ? "收起" : "展开"}
      </button>
      {open && (
        <div className="mt-2 space-y-2 border-t border-current/20 pt-2 text-[11px]">
          <p className="text-muted-foreground">
            所有历史统计都隐含一个假设：<b className="text-foreground">过去和现在是同一个游戏</b>。
            这个假设经常不成立 —— 制度改了（涨跌幅、920 号段、连板口径）、
            数据源改了口径、或者市场结构真的变了。<b className="text-foreground">三类要分开看</b>，
            把前两类读成第三类就会基于一个假信号调整打法。
          </p>
          {st?.available ? (
            <div className="overflow-x-auto">
              <div className="mb-1 text-muted-foreground">
                最近 {st.recent_window?.days} 天（{st.recent_window?.from} ~ {st.recent_window?.to}）
                {" vs "}之前 {st.prior_window?.days} 天
              </div>
              <table className="w-full min-w-[380px] tabular-nums">
                <tbody>
                  {safeArray<DriftMetric>(st.metrics).map((m) => (
                    <tr key={m.metric} className="border-b border-current/10 last:border-0">
                      <td className="py-1 pr-3 text-muted-foreground">{m.label}</td>
                      <td className="px-2 py-1 text-right">{m.recent}</td>
                      <td className="px-1 py-1 text-center text-muted-foreground/60">←</td>
                      <td className="px-2 py-1 text-right text-muted-foreground">{m.prior}</td>
                      <td className={cn("px-2 py-1", m.shifted ? "text-warning" : "text-success")}>
                        {m.shifted ? "⚠ 明显移位" : "稳定"}
                        {m.rel_change != null && ` (${(m.rel_change * 100).toFixed(0)}%)`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {st.note && <p className="mt-1 text-muted-foreground">{plain(st.note)}</p>}
            </div>
          ) : (
            <p className="text-muted-foreground">结构比较暂不可用：{st?.reason}</p>
          )}
          {!!fieldChanged.length && (
            <p className="text-warning">
              数据源字段变过：{fieldChanged.join("、")} —— 跨那些日期的统计里，
              那个断点可能来自数据源而不是市场。
            </p>
          )}
          <p className="text-muted-foreground">{plain(rep.regime_note)}</p>
          {!!safeArray(rep.regime_events).length && (
            <ul className="space-y-0.5">
              {safeArray<{ date: string; title: string; note?: string }>(rep.regime_events).map((e, i) => (
                <li key={i} className="text-muted-foreground">
                  <span className="tabular-nums">{e.date}</span> · {e.title}
                  {e.note && ` —— ${e.note}`}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

export function Backtest() {
  const [data, setData] = useState<BacktestData | null>(null);
  const [loading, setLoading] = useState(false);
  // 默认 30：数据源对更早的日期留存有限，拉 60/90 会有大量必然失败的请求空等
  const [days, setDays] = useState(30);
  const [err, setErr] = useState("");

  // ⚠️ 切换 20/30/60/90 天会并发发起多个请求。90 天先发、20 天后发时，
  // 若 90 天最后返回就会覆盖 20 天的结果，而下拉框仍显示 20 天 —— 口径直接错。
  // 只接受最后一次请求的响应。
  const reqId = useRef(0);
  const alive = useRef(true);
  // ⚠️ alive 必须在**挂载时置回 true**：React 18 StrictMode 开发下会 mount→unmount→mount，
  // 只在 cleanup 里置 false 的话第二次挂载后它永远是 false，所有响应都被当"已卸载"丢弃
  // （表现＝接口 200 但页面空白）。
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  async function load(refresh = false) {
    const my = ++reqId.current;
    const forDays = days;
    setLoading(true); setErr("");
    try {
      // 强制刷新走 POST：它会访问外网、算一两分钟、写盘，后端只认 POST（防跨站 GET 触发）
      const d = refresh
        ? await agentFetch<BacktestData>(`/api/backtest/refresh?days=${forDays}`, "POST")
        : await agentFetch<BacktestData>(`/api/backtest?days=${forDays}`);
      if (!alive.current || my !== reqId.current) return;   // 有更新的请求 → 丢弃这份
      setData(d);
      if (!d.available) setErr(d.reason || "回测不可用");
    } catch {
      if (alive.current && my === reqId.current) setErr("请求失败，Agent 后端（8910）是否已启动？");
    } finally {
      if (alive.current && my === reqId.current) setLoading(false);
    }
  }
  // days 变化时重新拉取（走后端缓存，通常很快）
  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [days]);

  const strategies = Object.entries(data?.strategies ?? {});
  const curve = (data?.seal_curve ?? []).filter((b) => b.sample > 0);
  // 「全体涨停」是基准线，其它策略对照它才知道有没有超额
  const base = data?.strategies?.["全体涨停"]?.overall.avg ?? null;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold">
            <TrendingDown className="h-6 w-6 text-primary" /> 历史统计
          </h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            昨日涨停样本在次日的历史表现 · 不是策略回测
            {data?.available && ` · ${data.date_from} ~ ${data.date_to} · ${data.days_used} 个交易日`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <select value={days} onChange={(e) => setDays(Number(e.target.value))}
            className="rounded-lg border border-border bg-card px-3 py-2 text-sm">
            {[20, 30, 60, 90].map((d) => <option key={d} value={d}>近 {d} 个交易日</option>)}
          </select>
          <button onClick={() => load(true)} disabled={loading}
            className="flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50">
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            {loading ? "回测中" : "重新回测"}
          </button>
        </div>
      </div>

      <div className="flex items-start gap-2 rounded-xl border border-warning/30 bg-warning/10 px-4 py-2.5 text-[12px] leading-relaxed text-warning">
        <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {CAVEAT}
      </div>

      {err && <div className="glass rounded-xl border-danger/30 px-4 py-3 text-sm text-danger">出错：{err}</div>}
      {data?.stale && (
        <div className="rounded-xl border border-warning/30 bg-warning/10 px-4 py-2.5 text-[13px] text-warning">
          ⚠ 本次刷新失败，展示的是上一份有效结果
        </div>
      )}
      {!!data?.missing_days?.length && (
        <div className="rounded-xl border border-border bg-muted/20 px-4 py-2.5 text-[12px] leading-relaxed text-muted-foreground">
          请求 {data.days_requested} 天，实际可用 <b className="text-foreground">{data.days_used}</b> 天：
          有 {data.missing_days.length} 个交易日取数失败已剔除
          （{data.missing_days.slice(0, 6).join("、")}{data.missing_days.length > 6 ? " …" : ""}）。
          <br />
          数据源只留最近约 15 个交易日，<b className="text-foreground">过期不候</b>。
          每次跑复盘会自动把当天语料囤下来
          {data.corpus?.days != null && (
            <>——已囤 <b className="text-foreground">{data.corpus.days}</b> 天
              {data.corpus.from && `（${data.corpus.from} 起）`}</>
          )}
          ，窗口会随日子推移自己变长。
        </div>
      )}

      {/* 原始数据归档 —— "半年后还能重算"的地基。派生缓存可以随时删掉重建，归档不能。 */}
      <ArchiveNote />

      {/* 结构漂移 —— 所有历史统计都隐含"过去和现在是同一个游戏"，这假设经常不成立 */}
      <DriftNote />

      {loading && !data && (
        <div className="glass rounded-2xl py-16 text-center text-muted-foreground">
          正在逐日取数回测…<div className="mt-1 text-xs">首次约 1-2 分钟，之后走缓存很快</div>
        </div>
      )}

      {/* 封板时间曲线：首板里最强的单一过滤变量，把悬崖位置直接摆出来 */}
      {!!curve.length && (
        <div className="glass rounded-2xl p-5">
          <h3 className="text-base font-bold">首板 · 最后封板时间曲线</h3>
          <p className="mb-4 text-[11px] leading-relaxed text-muted-foreground/70">
            同样是首板，什么时候把板<b>最终封住</b>决定了期望是正是负。数据源给的是<b>最后封板时间</b>，
            所以"晚"同时意味着封得晚、或中途炸开过又回封——两者都指向同一件事：这个板不稳。
            只统计首板，连板股的封板时间含义不同、混在一起会污染结论。
          </p>
          <div className="space-y-2">
            {curve.map((b) => {
              const w = Math.min(100, Math.abs(b.avg ?? 0) * 30);
              return (
                <div key={b.bucket} className="flex items-center gap-3 text-[12px]">
                  <span className="w-24 shrink-0 text-muted-foreground">{b.bucket}</span>
                  {/* 以 0 为中轴，左红右绿 */}
                  <div className="flex flex-1 items-center">
                    <div className="flex h-4 w-1/2 justify-end">
                      {(b.avg ?? 0) < 0 && <div className="h-full rounded-l bg-success/70" style={{ width: `${w}%` }} />}
                    </div>
                    <div className="h-4 w-px bg-border" />
                    <div className="flex h-4 w-1/2">
                      {(b.avg ?? 0) > 0 && <div className="h-full rounded-r bg-danger/70" style={{ width: `${w}%` }} />}
                    </div>
                  </div>
                  <span className={cn("w-16 shrink-0 text-right font-bold tabular-nums", tone(b.avg))}>{signed(b.avg)}</span>
                  <span className="w-28 shrink-0 text-right tabular-nums text-muted-foreground">
                    胜 {pctOf(b.win_rate)} · 再涨停 {pctOf(b.limit_up_rate)}
                  </span>
                  <span className="w-14 shrink-0 text-right tabular-nums text-muted-foreground/60">n={b.sample}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        {strategies.map(([name, s]) => {
          // ⚠️ 单条策略的嵌套结构也可能缺（旧缓存 schema），不能假定完整
          const o = s?.overall ?? EMPTY;
          const daily = safeArray<BacktestDay>(s?.daily);
          const isBase = name === "全体涨停";
          const excess = !isBase && base != null && o.avg != null ? o.avg - base : null;
          return (
            <div key={name} className={cn("glass rounded-2xl p-5", isBase && "border border-dashed border-border")}>
              <div className="mb-1 flex flex-wrap items-center gap-2">
                <h3 className="text-base font-bold">{name}</h3>
                {isBase && <span className="rounded bg-muted px-2 py-0.5 text-[10px] font-bold text-muted-foreground">基准</span>}
                {excess != null && (
                  <span className={cn("rounded px-2 py-0.5 text-[10px] font-bold",
                    excess > 0 ? "bg-danger/15 text-danger" : "bg-success/15 text-success")}>
                    超额 {signed(excess)}
                  </span>
                )}
                {!!o.sample && o.sample < 60 && (
                  <span className="rounded bg-warning/15 px-2 py-0.5 text-[10px] font-bold text-warning">样本偏小</span>
                )}
              </div>
              <p className="mb-3 text-[11px] leading-relaxed text-muted-foreground/70">{s.desc}</p>

              {o.sample ? (
                <>
                  <div className="flex items-end gap-6">
                    <div>
                      <div className={cn("text-2xl font-extrabold tabular-nums", tone(o.avg))}>{signed(o.avg)}</div>
                      <div className="text-[11px] text-muted-foreground">期望（均值）</div>
                    </div>
                    <div>
                      <div className={cn("text-2xl font-extrabold tabular-nums", tone(o.median))}>{signed(o.median)}</div>
                      <div className="text-[11px] text-muted-foreground">中位数</div>
                    </div>
                    <div>
                      <div className="text-2xl font-extrabold tabular-nums">{pctOf(o.win_rate)}</div>
                      <div className="text-[11px] text-muted-foreground">胜率</div>
                    </div>
                  </div>

                  <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 border-t border-dashed border-border pt-2 text-[12px] text-muted-foreground">
                    <span>样本 {o.sample}</span>
                    <span>再涨停 <b className="text-foreground">{pctOf(o.limit_up_rate)}</b></span>
                    <span>最好 <b className="text-success">{signed(o.best)}</b></span>
                    <span>最差 <b className="text-danger">{signed(o.worst)}</b></span>
                  </div>

                  <div className="mt-3 space-y-1 border-t border-dashed border-border pt-2">
                    <div className="mb-1 text-[11px] font-semibold text-primary">分情绪环境</div>
                    {["情绪强", "情绪中", "情绪弱", "环境未覆盖"].map((k) => (
                      <RegimeRow key={k} name={k} s={s.by_regime?.[k] ?? EMPTY} />
                    ))}
                  </div>

                  {/* 日均收益柱：一眼看出赚亏集中在哪几天 */}
                  <div className="mt-3 flex h-9 items-stretch gap-px border-t border-dashed border-border pt-2">
                    {daily.map((d) => (
                      <div key={d.date} title={`${d.date}｜${d.regime}｜均涨 ${signed(d.avg)}｜样本 ${d.sample}`}
                        className="flex flex-1 flex-col justify-center">
                        <div className="flex h-1/2 items-end">
                          {(d.avg ?? 0) > 0 && (
                            <div className="w-full bg-danger/70"
                              style={{ height: `${Math.min(100, Math.abs(d.avg!) * 10)}%` }} />
                          )}
                        </div>
                        <div className="flex h-1/2 items-start">
                          {(d.avg ?? 0) < 0 && (
                            <div className="w-full bg-success/70"
                              style={{ height: `${Math.min(100, Math.abs(d.avg!) * 10)}%` }} />
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                  <div className="mt-1 text-[11px] text-muted-foreground/60">逐日均收益（上红下绿 · 红涨绿跌）</div>
                </>
              ) : (
                <p className="text-[13px] text-muted-foreground">该策略在此窗口内无样本</p>
              )}
            </div>
          );
        })}
      </div>

      {data && (
        <p className="border-t border-border pt-4 text-xs text-muted-foreground/70">
          <Info className="mr-1 inline h-3 w-3" /> {DISCLAIMER}
        </p>
      )}
    </div>
  );
}
