import { Flame, TrendingUp, Layers, CalendarClock } from "lucide-react";
import { pctColor, UP_TEXT, DOWN_TEXT } from "@/lib/colors";
import { cn } from "@/lib/utils";
import { Caliber } from "@/components/ui/Caliber";
import { finite, plain, safeArray, safeRecord } from "@/lib/agent";
import type {
  ConsecPremium, EmotionCycle, EmotionMetrics, LadderGap, MoneyEffect, Promotion,
} from "@/lib/agent";

/** 0~1 的比率 → 百分比文本 */
function rate(v?: number | null): string {
  const n = finite(v);
  return n == null ? "—" : `${Math.round(n * 100)}%`;
}
/** 涨跌幅数字 → 带符号文本 */
function signed(v?: number | null): string {
  const n = finite(v);
  return n == null ? "—" : `${n > 0 ? "+" : ""}${n.toFixed(2)}%`;
}
function tone(v?: number | null): string {
  const n = finite(v);
  return n == null ? "text-muted-foreground" : pctColor(n);
}

/** 指标卡外壳。`caliber` = 这个数到底怎么算的（见 Caliber 组件的说明）。 */
export function Card({
  icon: Icon, title, hint, caliber, available, reason, children,
}: {
  icon: typeof Flame; title: string; hint: string; caliber?: string;
  available?: boolean; reason?: string; children: React.ReactNode;
}) {
  return (
    <div className="glass rounded-2xl p-5">
      <div className="mb-1 flex items-center gap-1.5">
        <Icon className="h-4 w-4 text-primary" />
        <h3 className="text-sm font-bold">{title}</h3>
        {caliber && <Caliber text={caliber} />}
      </div>
      <p className="mb-3 text-[11px] leading-relaxed text-muted-foreground/70">{hint}</p>
      {available ? children : (
        <p className="text-[13px] text-muted-foreground">数据不可用{reason ? `：${plain(reason)}` : ""}</p>
      )}
    </div>
  );
}

/** 一个读数：大字 + 说明 */
export function Stat({ label, value, valueClass }: { label: string; value: string; valueClass?: string }) {
  return (
    <div>
      <div className={cn("text-2xl font-extrabold tabular-nums", valueClass)}>{value}</div>
      <div className="text-[11px] text-muted-foreground">{label}</div>
    </div>
  );
}


export function MoneyEffectCard({ me }: { me: MoneyEffect }) {
  return (
    <Card
      icon={Flame} title="赚钱效应"
      hint="昨日涨停股今天的表现。中位数代表「多数人的体感」，均值会被少数大涨拉高"
      caliber={"样本 = 昨日涨停池全部个股（含一字板、含各涨跌幅制度，连板与首板同权）。\n" +
        "涨跌幅 = 今日收盘价相对昨日收盘价，不是相对今日开盘。\n" +
        "⚠️ 一字板次日多半买不进，所以这个数是「昨天那批票的整体去向」，不等于「你能拿到的收益」。\n" +
        "翻红率 = 今天收涨的占比，**平盘不算翻红**；分母是这批票里今天算得出涨跌幅的。\n" +
        "再度涨停 = 今天收盘仍封死在涨停价，盘中摸板后炸开的不算。\n" +
        "⚠️ 需要今日收盘价 → 只有最近一个已收盘交易日算得出，盘中会标不可用。"}
      available={me.available} reason={me.reason}
    >
      <div className="flex items-end gap-6">
        <Stat label="中位数" value={signed(me.median)} valueClass={tone(me.median)} />
        <Stat label="均值" value={signed(me.avg)} valueClass={tone(me.avg)} />
      </div>
      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 border-t border-dashed border-border pt-2 text-[12px] text-muted-foreground">
        <span>样本 {me.sample ?? "—"} 只</span>
        <span>翻红率 <b className="text-foreground">{rate(me.positive_rate)}</b></span>
        <span>再度涨停 <b className="text-foreground">{rate(me.limit_up_again_rate)}</b></span>
      </div>
    </Card>
  );
}

export function PromotionCard({ pr }: { pr: Promotion }) {
  const tiers = safeRecord<{ base: number; promoted: number; rate: number | null }>(pr.tiers);
  return (
    <Card
      icon={TrendingUp} title="晋级率"
      hint="昨日各档连板今天仍涨停的比例。1进2反映接力变化，需结合封板质量、样本规模与亏钱效应判断情绪"
      caliber={"分母 = 昨日收盘时处在该板位的全部个股；分子 = 其中今日收盘仍涨停的。\n" +
        "板位按**昨日收盘**的连板数算，断板后反包不计入原板位。\n" +
        "一字涨停算正常晋级（只看结果不看能否买到）。\n" +
        "三档是同一批票按昨日板位拆开算，所以三档的分子分母加起来就是「整体晋级率」那一行。\n" +
        "⚠️「3板以上」是合并档 —— 4进5 和 6进7 难度不同，样本太少才合并，别当成同一件事。"}
      available={pr.available} reason={pr.reason}
    >
      <Stat label="整体晋级率" value={rate(pr.overall?.rate)} />
      <div className="mt-3 space-y-1.5 border-t border-dashed border-border pt-2">
        {Object.entries(tiers)
          .filter(([, t]) => t && (finite(t.base) ?? 0) > 0)
          .map(([name, t]) => (
          <div key={name} className="flex items-center gap-2 text-[12px]">
            <span className="w-20 shrink-0 text-muted-foreground">{name}</span>
            {}
            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
              {finite(t.rate) != null && (
                <div className="h-full rounded-full bg-primary"
                  style={{ width: `${Math.round(finite(t.rate)! * 100)}%` }} />
              )}
            </div>
            <span className="w-20 shrink-0 text-right tabular-nums">
              {t.promoted}/{t.base}（{rate(t.rate)}）
            </span>
          </div>
        ))}
      </div>
    </Card>
  );
}

export function ConsecPremiumCard({ cp }: { cp: ConsecPremium }) {
  return (
    <Card
      icon={Layers} title="连板溢价"
      hint="昨日 2 板以上个股今天的表现；仅描述该样本的涨跌，不能单凭溢价判断承接"
      caliber={"样本 = 昨日收盘时 2 板及以上的个股，口径同赚钱效应（收盘对收盘）。\n" +
        "它和赚钱效应的差值就是「高位比整体更抗跌还是更惨」。\n" +
        "翻红率同上：今天收涨的占比，平盘不算。"}
      available={cp.available} reason={cp.reason}
    >
      <div className="flex items-end gap-6">
        <Stat label="中位数" value={signed(cp.median)} valueClass={tone(cp.median)} />
        <Stat label="均值" value={signed(cp.avg)} valueClass={tone(cp.avg)} />
      </div>
      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 border-t border-dashed border-border pt-2 text-[12px] text-muted-foreground">
        <span>样本 {cp.sample ?? "—"} 只</span>
        <span>翻红率 <b className="text-foreground">{rate(cp.positive_rate)}</b></span>
      </div>
    </Card>
  );
}

export function LadderCard({ lg }: { lg: LadderGap }) {
  return (
    <Card
      icon={Layers} title="梯队结构"
      hint="全市场各板位有没有缺档。⚠️ 板位连续≠同题材内部有梯队（2板可能题材A、5板题材C），别据此推断断板后有人承接。"
      caliber={"统计的是**今日收盘涨停**的个股按连板数分档，全市场口径、不分题材。\n" +
        "只统计 **2 板及以上**，首板不算梯队里的一档，所以缺档也只在 2 板到最高板之间找。\n" +
        "「缺档」= 某个板位一只都没有，而它上下都有票。"}
      available={lg.available} reason={lg.reason}
    >
      <div className="flex flex-wrap items-end gap-2">
        {Object.entries(safeRecord<number>(lg.tiers)).map(([b, c]) => (
          <span key={b} className="rounded-lg bg-primary/10 px-2.5 py-1 text-[13px] font-semibold text-primary tabular-nums">
            {b}板 × {c}
          </span>
        ))}
        {safeArray<number>(lg.gaps).map((g) => (
          <span key={`gap${g}`} className="rounded-lg border border-dashed border-danger/50 px-2.5 py-1 text-[13px] font-semibold text-danger tabular-nums">
            {g}板 缺
          </span>
        ))}
        {!Object.keys(safeRecord<number>(lg.tiers)).length && <span className="text-[13px] text-muted-foreground">无 2 板以上</span>}
      </div>
      {}
      <p className={cn("mt-3 border-t border-dashed border-border pt-2 text-[12px]",
        lg.continuous === false ? "text-danger" : "text-muted-foreground")}>
        {ladderNote(lg)}
      </p>
    </Card>
  );
}

/** 断层那句在前端按结构化字段组，而不是直接印后端存下来的 `note`。
 *
 *  原因：这句话曾把方向写反（写成"最高标上方悬空" —— 而缺的档在最高标**下面**，
 *  危险是断板后没有下一梯队接），而 `note` 是算完即落盘的字符串，
 *  历史复盘里那句错话会一直留在页面上。`gaps` / `highest` 是结构化的，
 *  用它们现场组句，翻回上周的复盘也说得对。
 *  后端那份 note 继续留着喂分析师，两者说的是同一件事。 */
function ladderNote(lg: LadderGap): string {
  const gaps = safeArray<number>(lg.gaps);
  if (!gaps.length) return plain(lg.note);
  const hi = lg.highest != null ? `（${lg.highest}板）` : "";
  return `板位缺档 ${gaps.map((g) => `${g}板`).join("、")} → 最高标${hi}下方断层，是否有同题材承接需另查，板位缺档本身不能判定`;
}

export function CycleCard({ cy }: { cy: EmotionCycle }) {
  return (
    <Card
      icon={CalendarClock} title="情绪周期"
      hint="窗口内情绪分最低的那天视为本轮起点"
      caliber={"情绪分 = 涨停家数、最高连板、炸板率三项在窗口内归一化后的平均，只用涨停池算。\n" +
        "炸板率是「越高越冷」，所以取反后再平均 —— 三项都指向同一个方向，分越高越热。\n" +
        "「第 N 天」= 今天距窗口最低点第几个交易日，不是自然日。\n" +
        "🔴 这是**可解释的启发式，不是精确的周期划分**：全市场压成一个数，而不同题材\n" +
        "完全可能同时处在启动、高潮和退潮。窗口内一路走低时，起点会落在最后一天\n" +
        "（= 仍在探底、记为第 1 天）。当参考，别当结论。"}
      available={cy.available} reason={cy.reason}
    >
      <div className="flex items-end gap-6">
        <Stat label={`起点 ${cy.trough_date ?? "—"}`} value={`第 ${cy.day_n ?? "—"} 天`} />
        <Stat label="当前情绪分" value={finite(cy.current_score) != null ? finite(cy.current_score)!.toFixed(2) : "—"}
          valueClass={
            cy.trend?.includes("走强") ? UP_TEXT
              : cy.trend?.includes("转弱") ? DOWN_TEXT : "text-foreground"
          } />
      </div>
      {}
      <p className="mt-2 rounded-lg bg-muted/40 px-2.5 py-1.5 text-[11px] leading-relaxed text-muted-foreground">
        ⚠️ 启发式，不是精确周期划分。全市场压成一个数，而不同题材可能同时处在启动 / 高潮 / 退潮。
      </p>
      {}
      <div className="mt-3 border-t border-dashed border-border pt-2">
        <div className="flex h-10 items-end gap-1">
          {}
          {safeArray<NonNullable<EmotionCycle["series"]>[number]>(cy.series).map((d) => {
            const sc = finite(d?.score);
            return (
              <div key={d?.date ?? Math.random()}
                title={`${d?.date} 情绪分 ${sc ?? "—"}｜涨停 ${d?.limit_up ?? "—"} 家｜最高 ${d?.highest_consec ?? "—"} 板`}
                className={cn("flex-1 rounded-t",
                  sc == null ? "bg-muted" : d.date === cy.trough_date ? "bg-danger" : "bg-primary/50")}
                style={sc == null ? undefined : { height: `${Math.max(6, Math.round(sc * 100))}%` }} />
            );
          })}
        </div>
        <div className="mt-1 flex gap-1">
          {safeArray<NonNullable<EmotionCycle["series"]>[number]>(cy.series).map((d, i, arr) => {
            const isLast = i === arr.length - 1;          // 最后一根 = 本次复盘那天
            const isTrough = d.date === cy.trough_date;
            return (
              <span key={d.date}
                className={cn(
                  "flex-1 text-center text-[9px] leading-tight tabular-nums",
                  isTrough ? "font-bold text-danger"
                    : isLast ? "font-bold text-foreground" : "text-muted-foreground/70",
                )}>
                {d.date.slice(5).replace("-", "/")}
              </span>
            );
          })}
        </div>
      </div>
      <p className="mt-1.5 text-[12px] text-muted-foreground">
        {}
        近 {cy.window ?? "—"} 个交易日 · 距窗口低点第 {cy.day_n ?? "—"} 天
        {cy.trend && <> · <b className={
          cy.trend.includes("走强") ? UP_TEXT
            : cy.trend.includes("转弱") ? DOWN_TEXT : "text-foreground"
        }>{cy.trend}</b></>}
        {finite(cy.pctile) != null && ` · 位于十日区间 ${Math.round(finite(cy.pctile)! * 100)}% 分位`}
        <span className="ml-1.5 inline-block h-2 w-2 rounded-sm bg-danger align-middle" /> 起点
        <span className="ml-2 font-bold text-foreground">加粗</span> 复盘当日
      </p>
    </Card>
  );
}

/** 把 EmotionMetrics 拆成各卡需要的片段，省得每个调用点都写一遍判空。 */
export function splitMetrics(m?: EmotionMetrics) {
  return {
    me: m?.money_effect ?? { available: false } as MoneyEffect,
    pr: m?.promotion ?? { available: false } as Promotion,
    cp: m?.consec_premium ?? { available: false } as ConsecPremium,
    lg: m?.ladder_gap ?? { available: false } as LadderGap,
    cy: m?.cycle ?? { available: false } as EmotionCycle,
    prevDate: m?.prev_date,
    zt: m?.promotion?.limit_up_count,
    ztPrev: m?.promotion?.prev_limit_up_count,
    empty: !m || (!m.money_effect && !m.promotion && !m.consec_premium),
  };
}
