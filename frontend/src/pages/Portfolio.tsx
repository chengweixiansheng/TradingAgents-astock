import { useCallback, useEffect, useState, useRef } from "react";
import { Loader2, RefreshCw, AlertCircle, ArrowRight, Download } from "lucide-react";
import { Link } from "react-router-dom";
import { pctColor } from "@/lib/colors";
import { cn } from "@/lib/utils";
import { PageHeader } from "@/components/ui/PageHeader";
import { Disclaimer } from "@/components/ui/Disclaimer";
import { Caliber } from "@/components/ui/Caliber";
import { agentFetch, agentPost, safeArray, type PositionsReport, type PositionRow } from "@/lib/agent";

/** 持仓股 —— **交易日志的一个视图**，不是另一本账。
 *
 * 持仓 = 日志里所有成交明细折算下来还剩什么。要建仓/平仓就去改那笔交易的成交明细，
 * 这样两边永远对得上，也不用同一笔录两次。
 * ⛔ 这些数据不接入任何 AI prompt。
 */

const fmt = (v: number) => v.toLocaleString("zh-CN", { maximumFractionDigits: 2 });
const fmtPx = (v: number) => v.toLocaleString("zh-CN", { maximumFractionDigits: 4 });

function Row({ h }: { h: PositionRow }) {
  return (
    <tr className="border-b border-border/40 last:border-0">
      <td className="px-2 py-2">
        <b>{h.name || h.code}</b>
        <span className="ml-1 text-[10px] text-muted-foreground">{h.code}</span>
        {h.playbooks.length > 0 && (
          <span className="ml-1 rounded bg-muted px-1.5 py-0.5 text-[10px]">{h.playbooks[0]}</span>
        )}
      </td>
      <td className="px-2 py-2 text-right tabular-nums">{fmt(h.shares)}</td>
      <td className="px-2 py-2 text-right tabular-nums">{fmtPx(h.cost)}</td>
      <td className="px-2 py-2 text-right tabular-nums">
        {/* ⚠️ 取不到行情时如实说明。显示 0 会让市值变 0、盈亏变 −100%，
            界面上就成了"持仓全部归零"——那是假的。 */}
        {h.quote_ok ? fmtPx(h.price as number)
          : <span className="text-warning">行情不可用</span>}
      </td>
      <td className="px-2 py-2 text-right tabular-nums">
        {h.quote_ok ? fmt(h.market_value as number) : "—"}
      </td>
      <td className={cn("px-2 py-2 text-right font-semibold tabular-nums",
        h.quote_ok ? pctColor(h.pnl as number) : "")}>
        {h.quote_ok ? `${(h.pnl as number) > 0 ? "+" : ""}${fmt(h.pnl as number)}` : "—"}
      </td>
      <td className={cn("px-2 py-2 text-right tabular-nums",
        h.quote_ok && h.pnl_pct != null ? pctColor(h.pnl_pct) : "")}>
        {h.quote_ok && h.pnl_pct != null
          ? `${h.pnl_pct > 0 ? "+" : ""}${h.pnl_pct.toFixed(2)}%` : "—"}
      </td>
      <td className="px-2 py-2 text-right tabular-nums text-muted-foreground">
        {h.planned_stop != null ? fmtPx(h.planned_stop)
          : <span className="text-warning/80">未设</span>}
      </td>
    </tr>
  );
}

export function Portfolio({ embedded = false }: { embedded?: boolean }) {
  const [data, setData] = useState<PositionsReport | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const importBusy = useRef(false);
  const [msg, setMsg] = useState("");

  const load = useCallback(async () => {
    try {
      setData(await agentFetch<PositionsReport>("/api/positions"));
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "读取失败");
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const saveLegacy = async (selected?: {holdings: unknown[]}) => {
    setMsg("");
    try {
      const r = await agentPost<{ imported: number; skipped: number; errors?: string[]; message?: string }>(
        "/api/positions/import-legacy", selected ?? {});
      setMsg(r.message
        ? r.message
        : `导入 ${r.imported} 条、跳过 ${r.skipped} 条${r.errors?.length ? `；${r.errors.length} 条有问题：${r.errors[0]}` : ""}`);
      await load();
    } catch (e) {
      setMsg(e instanceof Error ? `导入失败：${e.message}` : "导入失败");
    }
  };

  const importLegacy = async () => {
    if(importBusy.current)return;
    importBusy.current=true;setBusy(true);
    try{await saveLegacy();}finally{importBusy.current=false;setBusy(false);}
  };
  const selectLegacy = async (file?: File) => {
    if (!file || importBusy.current) return;
    importBusy.current=true;setBusy(true);
    try {
      if(file.size>500000) throw new Error('文件过大，请选择持仓 JSON 文件');
      const value:unknown=JSON.parse(await file.text());
      if(!value || typeof value!=='object' || !('holdings' in value) || !Array.isArray(value.holdings)) throw new Error('文件须包含 holdings 持仓数组');
      if(!window.confirm(`将所选文件中的 ${value.holdings.length} 条当前持仓导入本机交易日志？原文件保留；不会覆盖已有成交记录；没有成交日期的会明确注明。`))return;
      await saveLegacy({holdings:value.holdings});
    } catch(e){setMsg(e instanceof SyntaxError ? '这不是有效的 JSON 持仓文件，尚未导入任何记录；请重新选择原文件。' : e instanceof Error ? e.message : '读取文件失败');}
    finally{importBusy.current=false;setBusy(false);}
  };

  const holdings = safeArray<PositionRow>(data?.holdings);
  const total = data?.total;

  return (
    <div className="space-y-6">
      <PageHeader level={embedded ? 2 : 1} title="持仓股"
        subtitle="由交易日志的成交明细聚合而来 · 数据只存本机" />

      <div className="glass rounded-2xl p-5">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-bold">当前持仓</h3>
          <Caliber text={
            "持仓不是单独的一本账，而是**交易日志的一个视图**：\n" +
            "把日志里所有成交明细折算下来，还剩多少就是持仓多少。\n\n" +
            "· 成本按剩余股数的加权均价算（与券商的移动加权口径一致）。\n" +
            "· 同一只票在多笔交易里都有剩余时合并成一行。\n" +
            "· 建仓 / 加仓 / 平仓都去交易日志改那笔的成交明细，这里会跟着变。\n\n" +
            "⚠️ 行情取不到时那一行显示「行情不可用」，不会显示成 0 —— " +
            "显示 0 会让市值变 0、盈亏变 −100%，看着像持仓归零，那是假的。" +
            "有这种行时，上面的合计也会标成「不完整」。"
          } />
          <button onClick={load}
            className="ml-auto flex items-center gap-1 rounded-lg border border-border px-2.5 py-1 text-[12px] transition-colors hover:bg-muted/50">
            <RefreshCw className="h-3.5 w-3.5" /> 刷新
          </button>
        </div>

        {err && (
          <p className="mb-3 flex items-center gap-1.5 text-[12px] text-danger">
            <AlertCircle className="h-4 w-4" />{err}
          </p>
        )}

        {total && (
          <div className="mb-4 flex flex-wrap items-baseline gap-6 border-b border-border pb-3">
            <div>
              <div className={cn("text-2xl font-extrabold tabular-nums", pctColor(total.pnl))}>
                {total.pnl > 0 ? "+" : ""}{fmt(total.pnl)}
              </div>
              <div className="text-[11px] text-muted-foreground">
                浮动盈亏（元）{total.pnl_pct != null && ` · ${total.pnl_pct > 0 ? "+" : ""}${total.pnl_pct.toFixed(2)}%`}
              </div>
            </div>
            <div>
              <div className="text-lg font-bold tabular-nums">{fmt(total.market_value)}</div>
              <div className="text-[11px] text-muted-foreground">市值</div>
            </div>
            <div>
              <div className="text-lg font-bold tabular-nums">{fmt(total.cost)}</div>
              <div className="text-[11px] text-muted-foreground">成本</div>
            </div>
            {!total.complete && (
              <div className="text-[12px] text-warning">
                ⚠️ 合计不完整：{total.of - total.counted} 只取不到行情，只统计了 {total.counted}/{total.of} 只
              </div>
            )}
          </div>
        )}

        {holdings.length === 0 ? (
          <div className="py-10 text-center">
            <p className="text-muted-foreground">当前没有未平仓的交易</p>
            <p className="mt-2 text-[12px] text-muted-foreground/80">
              持仓由交易日志聚合而来 —— 去
              <Link to="/journal" className="mx-1 text-primary hover:underline">交易日志</Link>
              记一笔带成交明细的交易，这里就有了。
            </p>
            <Link to="/journal"
              className="mt-3 inline-flex items-center gap-1 rounded-lg bg-primary px-3 py-1.5 text-[12px] font-semibold text-primary-foreground transition-opacity hover:opacity-90">
              去记一笔 <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-[12px]">
              <thead>
                <tr className="border-b border-border text-[11px] text-muted-foreground">
                  {["标的", "股数", "成本", "现价", "市值", "浮盈", "浮盈%", "计划止损"].map((h, i) => (
                    <th key={h} className={cn("px-2 py-2 font-semibold", i === 0 ? "text-left" : "text-right")}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>{holdings.map((h) => <Row key={h.code} h={h} />)}</tbody>
            </table>
          </div>
        )}

        <p className="mt-3 border-t border-border pt-2 text-[11px] leading-relaxed text-muted-foreground">
          要建仓、加仓或平仓，去
          <Link to="/journal" className="mx-1 text-primary hover:underline">交易日志</Link>
          改那笔交易的成交明细 —— 一份账本，两边永远对得上，不用同一笔录两次。
        </p>
      </div>

      <div className="glass rounded-2xl p-5">
        <h3 className="text-sm font-bold">从旧持仓导入</h3>
        <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
          早先版本的持仓和交易日志是两套账。Mac 客户端不会自动读取其他产品目录；可选择原来的 portfolio.json 文件。
          点一下把里面的**当前持仓**导进日志，之后只维护一份。
          ⚠️ 旧记录没有成交明细，建仓日期取原记录的日期或今天，会在备注里注明；
          重复点不会重复导入。
        </p>
        <div className="mt-3 flex items-center gap-3">
          <button onClick={()=>void importLegacy()} disabled={busy}
            className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-[12px] font-semibold transition-colors hover:bg-muted/50 disabled:opacity-50">
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
            导入本产品旧持仓
          </button>
          <label className="rounded-lg border border-border px-3 py-1.5 text-xs">选择旧持仓文件
            <input aria-label="选择旧持仓 JSON 文件" type="file" accept=".json,application/json" disabled={busy} className="block max-w-56 text-xs" onChange={e=>{void selectLegacy(e.target.files?.[0]);e.target.value='';}} />
          </label>
          {msg && <span className="text-[12px] text-muted-foreground">{msg}</span>}
        </div>
      </div>

      <Disclaimer />
    </div>
  );
}
