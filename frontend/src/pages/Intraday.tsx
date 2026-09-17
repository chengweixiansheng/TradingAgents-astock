import { useEffect, useRef, useState } from "react";
import { pctColor } from "@/lib/colors";
import { Sunrise, Activity, RefreshCw, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { agentFetch, safeArray, safeRecord, finite } from "@/lib/agent";

/** 开盘核验 —— 昨晚的判断，今早开盘就见分晓的那部分。
 *
 * ⚠️ 只给市场层面聚合（高开/低开家数、分板位强弱、最高标客观读数）。
 * 个股不排序、不评分、不给参与倾向 —— "竞价后告诉你今天能打哪只"属于
 * 品种选择 + 买卖时机，明确不做。
 */

interface TierStat { sample: number; avg: number; median: number; up_rate: number; }
interface TopBoard { code: string; name: string; boards: number; sector: string; pct: number; }
interface EarlyItem {
  metric: string; label: string; expect: string;
  early_value: number | null; unit: string; note: string;
}
interface Auction {
  available: boolean; reason?: string;
  date?: string; prev_date?: string; captured_at?: string;
  overall?: {
    sample: number; avg: number; median: number;
    up_count: number; down_count: number; up_rate: number; deep_loss_5: number;
  };
  by_tier?: Record<string, TierStat>;
  top_boards?: TopBoard[];
  top_board_level?: number;
  verification_early?: EarlyItem[];
}
interface LiveCounts {
  limit_up: number; broken: number; limit_down: number;
  highest_board: number; sectors: number;
}
interface PathPoint {
  slot: string; median: number; avg: number; up_rate: number; deep_loss_5: number;
  // ⚠️ 这两项后端一直在给，早先前端漏接了：少了 live，页面就答不了
  // 「早上 60 家涨停炸到 40 家」和「15 家扩散到 40 家」的区别 —— 而那正是这一页的卖点。
  live?: LiveCounts | null;
  coverage_rate?: number | null;
}
interface DayPath { warnings?: string[]; available: boolean; reason?: string; date?: string; points?: PathPoint[]; }

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

export function Intraday() {
  const [auction, setAuction] = useState<Auction | null>(null);
  const [path, setPath] = useState<DayPath | null>(null);
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState("");
  const alive = useRef(true);
  const reqId = useRef(0);

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  async function load(capture = false) {
    const my = ++reqId.current;
    setLoading(true);
    setMsg("");
    try {
      if (capture) {
        // 手动补抓一张（写操作走 POST）
        await agentFetch("/api/intraday/capture", "POST");
      }
      const [a, p] = await Promise.all([
        agentFetch<Auction>("/api/intraday/auction"),
        agentFetch<DayPath>("/api/intraday/path"),
      ]);
      if (!alive.current || my !== reqId.current) return;
      setAuction(a);
      setPath(p);
    } catch {
      if (alive.current && my === reqId.current) setMsg("读取失败，稍后重试");
    } finally {
      if (alive.current && my === reqId.current) setLoading(false);
    }
  }

  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  const ov = auction?.overall;
  const tiers = safeRecord<TierStat>(auction?.by_tier);
  const tierKeys = ["首板", "2板", "3板及以上"].filter((k) => tiers[k]);
  const points = safeArray<PathPoint>(path?.points);
  const maxAbs = Math.max(1, ...points.map((p) => Math.abs(p.median)));

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold">
            <Sunrise className="h-6 w-6 text-primary" /> 复盘验证
          </h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            昨晚的判断，今早开盘就见分晓的那部分 · 昨日涨停股竞价强弱 + 盘中情绪路径
            {auction?.captured_at && ` · 快照于 ${auction.captured_at}`}
          </p>
        </div>
        <button onClick={() => load(true)} disabled={loading}
          className="flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50">
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          抓取当前快照
        </button>
      </div>

      {msg && <div className="glass rounded-xl px-4 py-3 text-sm text-muted-foreground">{msg}</div>}

      {auction && !auction.available ? (
        <div className="glass rounded-2xl py-12 text-center text-muted-foreground">
          暂不可用：{auction.reason}
          <div className="mt-1 text-xs">盘中快照只能在当天交易时段抓取，过了就补不回来</div>
        </div>
      ) : null}

      {ov && (
        <section className="space-y-4">
          <div className="text-[11px] font-bold uppercase tracking-[0.2em] text-primary">
            昨日涨停股 · 今日竞价强弱
          </div>
          <div className="glass rounded-2xl p-5">
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
              <div>
                <div className={cn("text-2xl font-extrabold tabular-nums", tone(ov.median))}>
                  {signed(ov.median)}
                </div>
                <div className="text-[11px] text-muted-foreground">中位数（多数人的体感）</div>
              </div>
              <div>
                <div className={cn("text-2xl font-extrabold tabular-nums", tone(ov.avg))}>{signed(ov.avg)}</div>
                <div className="text-[11px] text-muted-foreground">均值</div>
              </div>
              <div>
                <div className="text-2xl font-extrabold tabular-nums text-foreground">{rate(ov.up_rate)}</div>
                <div className="text-[11px] text-muted-foreground">高开占比 · 相对昨收（{ov.up_count}/{ov.sample}）</div>
              </div>
              <div>
                <div className="text-2xl font-extrabold tabular-nums text-danger">{ov.deep_loss_5}</div>
                <div className="text-[11px] text-muted-foreground">低开超 5%</div>
              </div>
            </div>

            {tierKeys.length > 0 && (
              <div className="mt-4 border-t border-border pt-3">
                <div className="mb-2 text-[11px] font-semibold text-muted-foreground">
                  分昨日板位 —— 首板和高位板的竞价含义完全不同
                </div>
                <div className="flex flex-wrap gap-3">
                  {tierKeys.map((k) => {
                    const t = tiers[k];
                    return (
                      <div key={k} className="min-w-[140px] flex-1 rounded-lg border border-border px-3 py-2">
                        <div className="text-[12px] font-bold">{k} <span className="text-muted-foreground">({t.sample})</span></div>
                        <div className={cn("text-lg font-extrabold tabular-nums", tone(t.median))}>{signed(t.median)}</div>
                        <div className="text-[11px] text-muted-foreground">高开 {rate(t.up_rate)}</div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {safeArray<TopBoard>(auction?.top_boards).length > 0 && (
              <div className="mt-4 border-t border-border pt-3">
                <div className="mb-2 text-[11px] font-semibold text-muted-foreground">
                  最高标（{auction?.top_board_level} 板）· 客观读数
                </div>
                <div className="flex flex-wrap gap-2">
                  {safeArray<TopBoard>(auction?.top_boards).map((t) => (
                    <span key={t.code} className="rounded-lg border border-border px-2.5 py-1 text-[12px]">
                      <b>{t.name}</b> <span className="text-muted-foreground">{t.code} · {t.sector}</span>
                      <b className={cn("ml-1.5 tabular-nums", tone(t.pct))}>{signed(t.pct)}</b>
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>

          {safeArray<EarlyItem>(auction?.verification_early).length > 0 && (
            <div className="glass rounded-2xl p-5">
              <h3 className="mb-1 text-sm font-bold">昨晚立的验证条件 · 竞价阶段读数</h3>
              <p className="mb-3 text-[11px] text-muted-foreground">
                竞价只能看出一部分苗头；要等盘中/收盘才有读数的，如实标出来、不硬凑。
              </p>
              <div className="space-y-1.5">
                {safeArray<EarlyItem>(auction?.verification_early).map((e, i) => (
                  <div key={i} className="flex flex-wrap items-center gap-2 text-[12px]">
                    <span className="font-semibold">{e.label}</span>
                    <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
                      预期{e.expect}
                    </span>
                    {e.early_value != null ? (
                      <span className={cn("tabular-nums font-bold", tone(e.early_value))}>
                        竞价 {signed(e.early_value)}
                      </span>
                    ) : (
                      <span className="text-[11px] text-muted-foreground/70">{e.note}</span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </section>
      )}

      {points.length > 0 && (
        <section>
          <div className="mb-2 text-[11px] font-bold uppercase tracking-[0.2em] text-primary">
            今日情绪路径 · Path
          </div>
          <div className="glass rounded-2xl p-5">
            <p className="mb-3 text-[11px] text-muted-foreground">
              同样是收盘 -2%，「早上 +3% 一路杀下来」和「早上 -5% 修复上来」是完全不同的两天。
              只看收盘值读不出这个差别。
            </p>
            <div className="flex items-end gap-3">
              {points.map((p) => (
                <div key={p.slot} className="flex-1 text-center">
                  <div className={cn("text-[12px] font-bold tabular-nums", tone(p.median))}>
                    {signed(p.median)}
                  </div>
                  <div className="mx-auto mt-1 w-full rounded"
                    style={{
                      height: `${Math.max(4, (Math.abs(p.median) / maxAbs) * 56)}px`,
                      background: p.median >= 0 ? "hsl(var(--success) / 0.6)" : "hsl(var(--danger) / 0.6)",
                    }} />
                  <div className="mt-1 text-[10px] text-muted-foreground">{p.slot}</div>
                  {/* ⚠️ up_rate 只有 09:25 那张才是「高开率」（相对开盘价）；
                      盘中各时点它是相对昨收的**红盘率**。标错是概念错误。 */}
                  <div className="text-[10px] text-muted-foreground/70">
                    {p.slot === "09:25" ? "高开" : "红盘"}{rate(p.up_rate)}
                  </div>
                  {p.live && (
                    <div className="mt-0.5 text-[10px] text-muted-foreground/70">
                      涨停{p.live.limit_up}·炸{p.live.broken}
                    </div>
                  )}
                  {p.coverage_rate != null && p.coverage_rate < 0.8 && (
                    <div className="mt-0.5 text-[10px] text-warning">
                      仅{rate(p.coverage_rate)}样本
                    </div>
                  )}
                </div>
              ))}
            </div>
            <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
              上排是昨日涨停股的中位涨幅（承接强弱），下排是**当时**全市场的涨停/炸板家数（扩散或退潮）。
              同样收盘 40 家涨停，从 60 家炸下来和从 15 家扩上去，含义完全相反 —— 只有把路径留下才看得出来。
              ⚠️ 标「仅 N% 样本」的时点表示当时行情只回来一部分，那个点的读数不代表全体。
            </p>
          </div>
        </section>
      )}

      {path?.warnings?.map((warning,i)=><p key={i} className="my-2 text-xs text-warning">{warning}</p>)}
      {path && !path.available && !ov && (
        <div className="glass rounded-2xl py-12 text-center text-muted-foreground">
          {path.reason}
          <div className="mt-1 text-xs">
            后台会在 09:25 / 09:35 / 10:00 / 11:30 / 14:00 / 15:00 自动抓取
          </div>
        </div>
      )}

      <p className="border-t border-border pt-4 text-xs text-muted-foreground/70">
        <Activity className="mr-1 inline h-3 w-3" />
        本页只呈现市场层面的客观读数与历史事实，不构成投资建议；市场有风险，决策与盈亏自负。
      </p>
    </div>
  );
}
