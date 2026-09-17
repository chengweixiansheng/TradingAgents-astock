import { Link } from "react-router-dom";
import { YesterdayLadder } from '@/components/workspace/YesterdayLadder';
import { useEffect, useRef, useState } from "react";
import { pctColor } from "@/lib/colors";
import { Wallet, Star, Building2, BarChart3, BellRing, Loader2, Plus, X } from "lucide-react";
import { PageHeader } from "@/components/ui/PageHeader";
import { GlassCard } from "@/components/ui/GlassCard";
import { Disclaimer } from "@/components/ui/Disclaimer";
import { api, type MonitorSnapshot, type WatchRow } from "@/lib/api";
import { loadWatch, saveWatch, addCodes } from "@/lib/watchlist";

const fmt = (v: number) => v.toLocaleString("zh-CN", { maximumFractionDigits: 2 });
const yi = (v: number | null | undefined) => (v == null ? "—" : `${fmt(v / 1e8)} 亿`);

const pctText = (p: number | null | undefined) => (p == null ? "—" : `${p > 0 ? "+" : ""}${p}%`);

const PHASE_LABEL: Record<string, string> = { open: "连续交易", break: "午间休市", closed: "非交易时段 · 行情日期见下方", auction: "集合竞价 · 试撮合", wait: "竞价结束 · 等待开盘", closing: "收盘集合竞价", unknown: "行情日期未确认" };
const KIND_STYLE: Record<string, string> = {
  急拉: "border-danger/50 bg-danger/10 text-danger",
  急跌: "border-success/50 bg-success/10 text-success",
  封板: "border-primary/50 bg-primary/10 text-primary",
  开板: "border-secondary/50 bg-secondary/10 text-secondary",
};

/** 星标：加/移自选（所有出现股票的地方都挂它） */
function WatchStar({ code, watch, onToggle }: { code: string; watch: string[]; onToggle: (c: string) => void }) {
  const inWatch = watch.includes(code);
  return (
    <button
      onClick={() => onToggle(code)}
      title={inWatch ? "移出自选" : "加入自选"}
      className={`rounded p-0.5 transition-colors ${inWatch ? "text-primary" : "text-muted-foreground/40 hover:text-primary"}`}
    >
      <Star className="h-3.5 w-3.5" fill={inWatch ? "currentColor" : "none"} />
    </button>
  );
}

interface QuoteTableProps {
  rows: WatchRow[];
  cols: ("pnl" | "boards" | "amount")[];
  watch: string[];
  onToggleWatch: (code: string) => void;
  onRemove?: (code: string) => void; // 持仓行删除
}

function QuoteTable({ rows, cols, watch, onToggleWatch, onRemove }: QuoteTableProps) {
  if (rows.length === 0) return <p className="py-4 text-center text-xs text-muted-foreground/60">暂无标的</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border/50 text-left text-xs text-muted-foreground">
            <th className="whitespace-nowrap px-2 py-1.5 font-medium">名称</th>
            {cols.includes("boards") && <th className="whitespace-nowrap px-2 py-1.5 font-medium">连板</th>}
            <th className="whitespace-nowrap px-2 py-1.5 font-medium">现价</th>
            <th className="whitespace-nowrap px-2 py-1.5 font-medium">本场</th>
            {cols.includes("pnl") && <th className="whitespace-nowrap px-2 py-1.5 font-medium">浮动盈亏</th>}
            {cols.includes("amount") && <th className="whitespace-nowrap px-2 py-1.5 font-medium">成交额</th>}
            <th className="px-1 py-1.5"></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.code} className="border-b border-border/30">
              <td className="whitespace-nowrap px-2 py-1.5">
                <span className="font-medium">{r.name || r.code}</span>{" "}
                <span className="text-xs text-muted-foreground/50">{r.code}</span>
                {r.is_limit === true && <span className="ml-1 rounded border border-primary/50 bg-primary/10 px-1 text-[10px] text-primary">封</span>}
                {r.is_limit === false && <span className="ml-1 rounded border border-secondary/50 bg-secondary/10 px-1 text-[10px] text-secondary">开</span>}
              </td>
              {cols.includes("boards") && (
                <td className="whitespace-nowrap px-2 py-1.5 font-mono font-bold text-primary">{r.boards} 板</td>
              )}
              <td className="px-2 py-1.5 font-mono">{r.price ?? "—"}</td>
              <td className={`px-2 py-1.5 font-mono ${pctColor(r.pct)}`}>{pctText(r.pct)}</td>
              {cols.includes("pnl") && (
                <td className={`px-2 py-1.5 font-mono ${pctColor(r.pnl_pct)}`}>{pctText(r.pnl_pct)}</td>
              )}
              {cols.includes("amount") && (
                <td className="whitespace-nowrap px-2 py-1.5 font-mono text-muted-foreground">{yi(r.amount)}</td>
              )}
              <td className="whitespace-nowrap px-1 py-1.5 text-right">
                <span className="inline-flex items-center gap-0.5">
                  <WatchStar code={r.code} watch={watch} onToggle={onToggleWatch} />
                  {onRemove && (
                    <button onClick={() => onRemove(r.code)} title="删除" className="rounded p-0.5 text-muted-foreground/40 hover:text-danger">
                      <X className="h-3.5 w-3.5" />
                    </button>
                  )}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function DailyWatch({ view = "live" }: { view?: "live" | "yesterday" }) {
  const [threshold, setThreshold] = useState(1.5);
  const [alertScope, setAlertScope] = useState("all");
  const [snap, setSnap] = useState<MonitorSnapshot | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [watch, setWatch] = useState<string[]>(() => loadWatch());
  const [watchInput, setWatchInput] = useState("");
  const watchRef = useRef(watch);
  watchRef.current = watch;

  useEffect(() => {
    const pull = () => {
      api.monitorSnapshot(watchRef.current.join(","))
        .then((d) => { setSnap(d); setErr(d.watch_warning || null); })
        .catch((e) => setErr(e instanceof Error ? e.message : "读取失败"));
    };
    pull();
    const t = window.setInterval(pull, 3000);
    return () => window.clearInterval(t);
  }, []);

  const alerts = (snap?.alerts || []).filter(a =>
    (a.change_pct == null || Math.abs(a.change_pct) >= threshold) &&
    (alertScope === "all" || watch.includes(a.code) || (snap?.holdings || []).some(p => p.code === a.code)));
  const [watchError, setWatchError] = useState<string | null>(null);
  const toggleWatch = (code: string) => {
    try {
      const next = watch.includes(code) ? watch.filter(c => c !== code) : [...watch, code];
      saveWatch(next); setWatch(next); setWatchError(null);
    } catch(e) { setWatchError(e instanceof Error ? e.message : "自选保存失败"); }
  };
  const addWatchInput = () => {
    if (!watchInput.trim()) return;
    try {
      const { next } = addCodes(watch, watchInput);
      saveWatch(next); setWatch(next); setWatchInput(""); setWatchError(null);
    } catch(e) { setWatchError(e instanceof Error ? e.message : "自选保存失败"); }
  };

  const phase = snap?.phase || "closed";
  const inputCls = "rounded-lg border border-border/60 bg-background/50 px-2 py-1 text-xs outline-none focus:border-primary/60";

  if (view === "yesterday") return <div><PageHeader title="昨日梯队" subtitle="跟踪上一交易日涨停及连板梯队的当前表现，可筛选二板以上或三板以上。" />{err && <p role="alert">{err}</p>}<YesterdayLadder data={snap?.yesterday_ladder} /></div>;

  return (
    <div>
      {watchError && <p role="alert" className="text-danger">{watchError}</p>}
      <PageHeader
        title="实时动态"
        subtitle="持仓与自选 · 市场异动 —— 自动刷新；实际时效以行情时间为准"
      />

      {/* 状态条 */}
      <div className="mb-4 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
        <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 ${phase === "open" ? "border-danger/50 bg-danger/10 text-danger" : "border-border/60"}`}>
          {phase === "open" && <Loader2 className="h-3 w-3 animate-spin" />}
          {PHASE_LABEL[phase]}
        </span>
        {snap?.ts && <span>快照 {snap.ts}</span>}
        <span>监控池：500亿大票 {!snap || snap.warming_up ? "载入中" : snap.bigcap.total} 只 + 持仓/自选/昨日涨停/昨十</span>
        <span className="inline-flex items-center gap-1"><BellRing className="h-3.5 w-3.5" /> 已记录异动 {!snap || snap.warming_up ? "载入中" : alerts.length} 条</span>
        {err && <span className="text-danger">{err}</span>}
      </div>


      <div className="mb-4 flex flex-wrap items-center gap-3 text-sm">
        <label>3 分钟急拉急跌阈值 <select aria-label="异动幅度阈值" value={threshold} onChange={e => setThreshold(Number(e.target.value))} className="rounded border border-border bg-card p-2">{[1.5,3,5].map(v => <option key={v} value={v}>{v}%</option>)}</select></label>
        <label>显示范围 <select aria-label="异动显示范围" value={alertScope} onChange={e => setAlertScope(e.target.value)} className="rounded border border-border bg-card p-2"><option value="all">全部监控池</option><option value="mine">持仓与自选</option></select></label>
        <span className="text-xs text-muted-foreground">仅筛选本页；封板、开板事件始终保留。低于 1.5% 的变动未采集。</span>
      </div>
      {/* 异动流 */}
      <GlassCard className="mb-4" glow>
        <div className="mb-2 flex items-center gap-2 text-sm font-semibold">
          <BellRing className="h-4 w-4 text-primary" /> 异动流
          <span className="text-xs font-normal text-muted-foreground">急拉/急跌（3分钟±1.5%）· 封板/开板 · 同票同类 5 分钟冷却 · 客观数据事件，非推荐/非预测</span>
        </div>
        {(alerts.length ?? 0) === 0 ? (
          <p className="py-3 text-center text-xs text-muted-foreground/60">
            {!snap || snap.warming_up ? "正在建立监控池，尚不能判断是否有异动" : phase === "open" ? "暂无异动（开盘初需积累约 1 分钟数据）" : "非交易时段 · 开盘后自动开始监控"}
          </p>
        ) : (
          <div className="max-h-64 space-y-1.5 overflow-y-auto">
            {alerts.map((a, i) => (
              <div key={`${a.ts}-${a.code}-${i}`} className="flex flex-wrap items-center gap-2 text-sm">
                <span className="font-mono text-xs text-muted-foreground">{a.ts}</span>
                <span className={`rounded border px-1.5 py-0.5 text-xs font-medium ${KIND_STYLE[a.kind] || "border-border/60"}`}>{a.kind}</span>
                <span className="font-medium">{a.name}</span>
                <span className="text-xs text-muted-foreground/50">{a.code}</span>
                <WatchStar code={a.code} watch={watch} onToggle={toggleWatch} />
                <span className="text-xs text-muted-foreground">{a.msg}</span>
                <span className="ml-auto flex gap-1">
                  {a.sources.map((s) => (
                    <span key={s} className="rounded-full border border-secondary/40 bg-secondary/10 px-1.5 py-0.5 text-[10px] text-secondary">{s}</span>
                  ))}
                </span>
              </div>
            ))}
          </div>
        )}
      </GlassCard>

      {/* 持仓 / 自选 */}
      <div className="mb-4 grid gap-4 lg:grid-cols-2">
        <GlassCard>
          <div className="mb-2 flex flex-wrap items-center gap-2 text-sm font-semibold">
            <Wallet className="h-4 w-4 text-primary" /> 持仓股
            <Link to="/journal" className="ml-auto text-xs font-normal text-primary">管理交易记录 →</Link>
          </div>
          <p className="mb-1 text-[10px] text-muted-foreground">与“我的股票”共用交易日志汇总；此处只读，不另记一份持仓。</p>
          {snap?.holdings_error && <p role="alert" className="mb-2 text-xs text-warning">{snap.holdings_error}</p>}
          <QuoteTable rows={snap?.holdings ?? []} cols={["pnl"]} watch={watch} onToggleWatch={toggleWatch} />
        </GlassCard>
        <GlassCard>
          <div className="mb-2 flex flex-wrap items-center gap-2 text-sm font-semibold">
            <Star className="h-4 w-4 text-primary" /> 自选股
            <span className="ml-auto flex items-center gap-1.5 font-normal">
              <input className={`w-44 ${inputCls}`} placeholder="代码，可粘贴一串（空格/逗号分隔）" value={watchInput}
                     onChange={(e) => setWatchInput(e.target.value)}
                     onKeyDown={(e) => e.key === "Enter" && addWatchInput()} />
              <button onClick={addWatchInput}
                      className="inline-flex items-center gap-1 rounded-lg border border-primary/50 bg-primary/10 px-2 py-1 text-xs font-medium text-primary hover:bg-primary/20">
                <Plus className="h-3 w-3" />添加
              </button>
            </span>
          </div>
          <p className="mb-1 text-[10px] text-muted-foreground/60">与「持仓自选」页同一份本地数据 · 各表行尾 ★ 一键加自选</p>
          <QuoteTable rows={snap?.watchlist ?? []} cols={[]} watch={watch} onToggleWatch={toggleWatch} />
        </GlassCard>
      </div>

      {/* 大票 / 三板+ / 昨十 */}
      <div className="grid gap-4 lg:grid-cols-2">
        <GlassCard>
          <div className="mb-2 flex items-center gap-2 text-sm font-semibold">
            <Building2 className="h-4 w-4 text-primary" /> 500亿大票
            <span className="text-xs font-normal text-muted-foreground">池 {snap?.bigcap.total ?? 0} 只 · 异动见上方异动流 · 下为行情所属场次涨幅前十</span>
          </div>
          <QuoteTable rows={snap?.bigcap.top ?? []} cols={["amount"]} watch={watch} onToggleWatch={toggleWatch} />
        </GlassCard>
        <GlassCard>
          <div className="mb-2 flex items-center gap-2 text-sm font-semibold">
            <BarChart3 className="h-4 w-4 text-primary" /> {snap?.turnover.label || "昨日成交前十"}
          </div>
          <QuoteTable rows={snap?.turnover.stocks ?? []} cols={["amount"]} watch={watch} onToggleWatch={toggleWatch} />
        </GlassCard>
      </div>

      <Disclaimer />
    </div>
  );
}
