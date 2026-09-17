import { LineChart } from "lucide-react";
import { cn } from "@/lib/utils";
import { finite, plain, safeArray } from "@/lib/agent";
import { Caliber } from "@/components/ui/Caliber";
import type { Trend, TrendMetric } from "@/lib/agent";

function Spark({ m }: { m: TrendMetric }) {
  const vals = safeArray<number | null>(m.values).map((v) => finite(v));
  const known = vals.filter((v): v is number => v !== null);
  if (known.length < 2) {
    return <div className="text-[11px] text-muted-foreground/60">样本不足，画不出</div>;
  }
  const min = Math.min(...known), max = Math.max(...known), rng = (max - min) || 1;
  const W = 100, H = 26;
  const last = vals[vals.length - 1];
  const dir = typeof m.higher_is_hotter === "boolean" ? m.higher_is_hotter : null;
  const hot = last == null || dir == null ? null
    : (dir ? last >= (min + max) / 2 : last <= (min + max) / 2);

  const segs: string[] = [];
  let cur: string[] = [];
  vals.forEach((v, i) => {
    if (v == null) { if (cur.length > 1) segs.push(cur.join(" ")); cur = []; return; }
    cur.push(`${(i / (vals.length - 1) * W).toFixed(1)},${(H - (v - min) / rng * H).toFixed(1)}`);
  });
  if (cur.length > 1) segs.push(cur.join(" "));

  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="h-7 w-full">
      {segs.map((pts, i) => (
        <polyline key={i} points={pts} fill="none" strokeWidth="1.5"
          stroke={hot == null ? "hsl(var(--muted-foreground))"
            : hot ? "hsl(var(--danger))" : "hsl(var(--success))"}
          vectorEffect="non-scaling-stroke" />
      ))}
    </svg>
  );
}

function fmt(v: number | null, kind?: string, unit?: string): string {
  if (v == null) return "—";
  if (kind === "rate") return `${Math.round(v * 100)}%`;
  if (kind === "pct") return `${v > 0 ? "+" : ""}${v.toFixed(2)}%`;
  return `${v}${unit || ""}`;
}

export function TrendPanel({ t }: { t?: Trend }) {
  if (!t) return null;
  if (!t.available) {
    return (
      <section className="glass rounded-2xl p-5">
        <h3 className="flex items-center gap-1.5 text-sm font-bold">
          <LineChart className="h-4 w-4 text-primary" /> 最近几天怎么走的
        </h3>
        <p className="mt-1 text-[13px] text-muted-foreground">暂不可用：{plain(t.reason || "未知")}</p>
      </section>
    );
  }
  const days = safeArray<string>(t.days);
  const metrics = safeArray<TrendMetric>(t.metrics);

  return (
    <section className="glass rounded-2xl p-5">
      <div className="mb-1 flex flex-wrap items-center gap-1.5">
        <LineChart className="h-4 w-4 text-primary" />
        <h3 className="text-sm font-bold">最近几天怎么走的</h3>
        <Caliber text={
          "六个核心读数在同一段窗口上的连续值，全部从**已落盘的涨停池缓存**里算。\n" +
          "⚠️ 「赚钱效应中位数」的今日值可能与上面那张卡差一点点：这里用缓存池的**全部**票，" +
          "上面那张卡只计入实时行情取得到的票 —— 样本差一两只，中位数就会差几个百分点的零头。" +
          "两个都对，只是分母不同；卡片上标了各自的样本数。\n" +
          "颜色只表示当前值在窗口里偏热还是偏冷（涨停家数高=热、炸板率高=冷），不是涨跌。\n" +
          "⚠️ 某天缺数据时**断线**，不连过去。\n" +
          "⚠️ 只画走势，不做预测。"
        } />
        <span className="text-[11px] text-muted-foreground">
          单日 diff 太短、「第几天」太抽象，这段才看得出是单日波动还是连续恶化
        </span>
      </div>
      {}
      <p className="mb-3 text-[11px] text-muted-foreground/70">
        {finite(t.sample_days) != null ? `近 ${t.sample_days} 个交易日` : "窗口长度不可用"}
        {days.length >= 2 ? ` · ${days[0]} → ${days[days.length - 1]}` : ""}
      </p>

      <div className="grid gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
        {metrics.map((m) => {
          const vals = safeArray<number | null>(m.values).map((v) => finite(v));
          const last = vals[vals.length - 1];
          const prev = vals.length > 1 ? vals[vals.length - 2] : null;
          const delta = last != null && prev != null ? last - prev : null;
          return (
            <div key={m.key}>
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-[12px] text-muted-foreground">{m.label}</span>
                <span className="text-[13px] font-bold tabular-nums">
                  {fmt(last, m.kind, m.unit)}
                  {delta != null && Math.abs(delta) > 1e-9 && (
                    <span className={cn("ml-1 text-[10px] font-normal",
                      // 只说方向，不判断好坏 —— 好坏要看 higher_is_hotter，交给用户
                      "text-muted-foreground")}>
                      {delta > 0 ? "↑" : "↓"}
                    </span>
                  )}
                </span>
              </div>
              <Spark m={m} />
            </div>
          );
        })}
      </div>
    </section>
  );
}
