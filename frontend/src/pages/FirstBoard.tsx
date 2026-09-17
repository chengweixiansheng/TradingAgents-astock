import { Fragment, useEffect, useState } from "react";
import { Flame, Loader2, Sparkles, AlertCircle, X } from "lucide-react";
import { PageHeader } from "@/components/ui/PageHeader";
import { GlassCard } from "@/components/ui/GlassCard";
import { Caliber } from "@/components/ui/Caliber";
import { Disclaimer } from "@/components/ui/Disclaimer";
import { useDeepDive, DeepDivePanel, RunAllButton, type DiveItem } from "@/components/ui/DeepDive";
import { api, type FirstBoardData, type FirstBoardStock } from "@/lib/api";

const fmt = (v: number) => v.toLocaleString("zh-CN", { maximumFractionDigits: 2 });
const yi = (v: number | null) => (v == null ? "—" : `${fmt(v / 1e8)} 亿`); // 元 → 亿

const dateLabel = (d: string) =>
  d.length === 8 ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6)}` : d;

export function FirstBoard() {
  const [data, setData] = useState<FirstBoardData | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const dd = useDeepDive("firstboard", data?.date || "");

  useEffect(() => {
    api.firstBoard().then(setData).catch((error: unknown) => {
      setLoadError(error instanceof Error ? error.message : "首板名单读取失败，请刷新重试");
    }).finally(() => setLoaded(true));
  }, []);

  const buildPrompt = (s: FirstBoardStock) =>
    `交易日（${dateLabel(data?.date || "")}）A 股首板涨停股「${s.name}（${s.code}）」的客观数据：\n` +
    `现价 ${s.price} 元，涨停 +${s.pct}%，首次封板时间 ${s.seal_time || "未知"}，` +
    `炸板 ${s.break_count} 次，成交额 ${yi(s.amount)}，流通市值 ${yi(s.float_cap)}，` +
    `所属行业 ${s.industry || "未知"}，涨停原因题材：${s.reason || "（暂缺，需要自查）"}。\n\n` +
    "请深入分析这只股票在该交易日涨停的原因：\n" +
    "1. 若本次允许工具，查询该交易日及之前的新闻研报；未开启工具则仅依据给定资料并明确新闻研报尚未核实。结合题材串说明可能驱动，源站归因不是公司确认事实，不得用之后的新闻倒推当天原因；\n" +
    "2. 材料只有单股数据，不能据此判定整个题材板块强度、阶段、扩散或持续性。缺少同日板块广度、梯队和历史对照时写「板块证据不足」，不要猜测情绪性一日游或产业趋势；\n" +
    "3. 按「已知事实」「尚未核实」「后续核验条件」三段，每段最多三条，全文约300字。首次封板09:25属于开盘集合竞价，不能称连续竞价中的早盘承接；炸板0次仅说明数据源未记录开板，不证明买盘强弱或持续性。流通市值只报原值，缺少横截面比较不能自定大中小盘。\n" +
    "后续核验条件只写需要补查的公开资料和可观察变化，不写交易动作、个股参与倾向、点位、仓位或价格预测，也不要复述被禁止的词语。" +
    "不要展示工具开关、参数名、allow_tools、JSON等实现细节；没有查到新闻研报就直接说「新闻研报尚未核实」。" +
    "个股层面只陈述已经发生的客观数据与事实；方向与强弱判断做到题材板块层面为止，且必须有这个题材板块整体的证据；不要由此推断这只个股接下来会怎样。不预测个股涨跌，不给个股参与倾向，不推荐任何标的，不构成投资建议。这是约束，不必在答案中复述。" +
    "输出用纯 Markdown（不要在表格或正文里使用 <br> 等 HTML 标签）。";

  const ctx = (s: FirstBoardStock) => `首板股 ${s.name}(${s.code}) 涨停原因深入分析`;
  const diveItem = (s: FirstBoardStock): DiveItem => ({ key: s.code, prompt: buildPrompt(s), context: ctx(s) });

  const stocks = data?.stocks ?? [];
  const nameByCode = Object.fromEntries(stocks.map((s) => [s.code, s.name]));

  return (
    <div>
      <PageHeader
        title="首板分析"
        subtitle="按下方交易日展示首板涨停股（连板数=1）· 涨停原因题材 · 每只可让 AI 深入分析"
      />

      {data && (
        <div className="mb-4 grid grid-cols-3 gap-3">
          {[
            { label: "交易日", value: dateLabel(data.date) },
            { label: "该交易日涨停", value: `${data.total_zt} 家` },
            { label: "其中首板", value: `${data.first_count} 家` },
          ].map((c) => (
            <GlassCard key={c.label} className="py-3 text-center">
              <div className="text-xs text-muted-foreground">{c.label}</div>
              <div className="mt-1 font-mono text-lg font-bold text-primary">{c.value}</div>
            </GlassCard>
          ))}
        </div>
      )}

      {data?.reason_note && (
        <p className="mb-3 flex items-center gap-1.5 text-xs text-muted-foreground">
          <AlertCircle className="h-3.5 w-3.5" /> 涨停原因：{data.reason_note}
        </p>
      )}

      <GlassCard>
        <div className="mb-2 flex flex-wrap items-center gap-2 text-sm font-semibold">
          <Flame className="h-4 w-4 text-primary" /> 首板名单
          <Caliber text={
            "「炸板」为数据源记录的当日开板次数；0 表示未记录开板，不证明买盘强弱或持续性。\n" +
            "榜单是取数时点仍涨停的股票，盘中还可能变化；收盘后才可作为最终涨停名单。\n" +
            "名单按首次封板时间从早到晚排。\n" +
            "「行业」经常只有四个字（像「互联网电」「自动化设」）——是上游把名字截到四字，\n" +
            "不是这里显示不全；怕猜错所以不替它补全称。"
          } />
          <span className="text-xs font-normal text-muted-foreground">
            按首次封板时间排序（早封在前）· 客观公开榜单，非推荐 / 非预测
          </span>
          <span className="ml-auto font-normal">
            <RunAllButton dd={dd} items={stocks.map(diveItem)} nameOf={(k) => nameByCode[k] || k} />
          </span>
        </div>
        {!loaded ? (
          <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> 加载中…
          </div>
        ) : loadError ? (
          <p role="alert" className="py-8 text-center text-sm text-danger">首板名单读取失败：{loadError}。请刷新页面重试。</p>
        ) : stocks.length === 0 ? (
          <div className="py-8 text-center text-sm text-muted-foreground">暂无数据（数据源异常或非交易日）</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border/50 text-left text-xs text-muted-foreground">
                  {["名称", "首封", "炸板", "现价", "当日涨幅", "成交额", "流通市值", "涨停原因", "行业", ""].map((h) => (
                    <th key={h} className="whitespace-nowrap px-2 py-2 font-medium">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {stocks.map((s) => (
                  <Fragment key={s.code}>
                    <tr className="border-b border-border/30">
                      <td className="whitespace-nowrap px-2 py-2">
                        <span className="font-medium">{s.name}</span>{" "}
                        <span className="text-xs text-muted-foreground/50">{s.code}</span>
                      </td>
                      <td className="whitespace-nowrap px-2 py-2 font-mono text-muted-foreground">{s.seal_time || "—"}</td>
                      <td className="whitespace-nowrap px-2 py-2 font-mono">
                        {s.break_count > 0 ? <span className="text-primary">{s.break_count} 次</span> : <span className="text-muted-foreground/50">0</span>}
                      </td>
                      <td className="px-2 py-2 font-mono">{s.price}</td>
                      <td className="px-2 py-2 font-mono text-danger">+{s.pct}%</td>
                      <td className="whitespace-nowrap px-2 py-2 font-mono text-muted-foreground">{yi(s.amount)}</td>
                      <td className="whitespace-nowrap px-2 py-2 font-mono text-muted-foreground">{yi(s.float_cap)}</td>
                      <td className="max-w-56 px-2 py-2 text-xs">
                        {s.reason ? <span className="text-foreground">{s.reason}</span> : <span className="text-muted-foreground/50">—</span>}
                      </td>
                      <td className="whitespace-nowrap px-2 py-2 text-xs text-muted-foreground">{s.industry}</td>
                      <td className="whitespace-nowrap px-2 py-2 text-right">
                        <button
                          onClick={() => dd.toggle(diveItem(s))}
                          className="inline-flex items-center gap-1 rounded-lg border border-primary/50 bg-primary/10 px-2.5 py-1 text-xs font-medium text-primary transition-colors hover:bg-primary/20"
                        >
                          {dd.running === s.code ? <Loader2 className="h-3 w-3 animate-spin" /> : dd.open === s.code ? <X className="h-3 w-3" /> : <Sparkles className="h-3 w-3" />}
                          {dd.open === s.code ? "收起" : dd.analysis[s.code] ? "展开" : "深入分析"}
                        </button>
                      </td>
                    </tr>
                    {dd.open === s.code && (
                      <DeepDivePanel
                        dd={dd}
                        stockKey={s.code}
                        colSpan={10}
                        noteTitle={`首板深析 · ${s.name}`}
                        onRerun={() => dd.rerun(diveItem(s))}
                      />
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </GlassCard>

      <Disclaimer />
    </div>
  );
}
