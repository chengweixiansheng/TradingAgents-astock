import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Flame } from 'lucide-react';
import type { YesterdayLadder as Ladder } from '@/lib/api';
import { filterYesterdayTier } from '@/lib/workspace/ladder';
import { pctColor } from '@/lib/colors';
import { cn } from '@/lib/utils';
export function YesterdayLadder({ data }: { data?: Ladder }) {
  const [minimum, setMinimum] = useState(3);
  const rows = filterYesterdayTier(data?.stocks || [], minimum);
  const tiers = [...new Set(rows.map(row => row.boards!))].sort((a, b) => b - a);
  return <section aria-labelledby="yesterday-ladder-title" className="glass mb-5 rounded-xl border border-primary/20 p-4 md:p-5">
    <div className="flex flex-wrap items-start justify-between gap-3"><div><h2 id="yesterday-ladder-title" className="flex items-center gap-2 text-base font-semibold"><Flame className="h-5 w-5 text-primary" />昨日梯队 · 当前表现</h2><p className="mt-2 text-xs leading-5 text-muted-foreground">按前一交易日收盘板数固定分组，今天未封板、回落与缺行情的成员仍保留。</p></div>
      <label className="flex min-h-10 items-center gap-2 text-sm">关注梯队<select aria-label="关注昨日梯队" value={minimum} onChange={e => setMinimum(Number(e.target.value))} className="min-h-10 rounded-lg border border-border bg-card px-3"><option value={3}>昨日 3 板及以上</option><option value={2}>昨日 2 板及以上</option><option value={1}>全部昨日涨停（含首板）</option></select></label>
    </div>
    {!data?.available ? <p role="status" className="mt-4 text-sm text-muted-foreground">{data?.reason || '正在读取昨日样本与行情…'}</p> : <>
      <p className="mt-3 text-xs leading-5 text-muted-foreground">样本日期：{data.sample_date} · 行情交易日：{data.quote_date} · 全池 {data.stocks.length} 只，行情覆盖 {data.covered} 只。休市时显示最近行情所属场次，未取得新一场行情前不当作今日表现。</p>
      {data.warning && <p role="status" className="mt-2 text-xs text-muted-foreground">{data.warning}</p>}
      <div className="mt-4 flex flex-wrap gap-2">{tiers.map(tier => { const group = rows.filter(r => r.boards === tier); return <span key={tier} className="rounded-md border border-border bg-muted/30 px-3 py-2 text-xs">昨日 {tier} 板 · {group.length} 只 / 涨停 {group.filter(r => ['封板中','收盘涨停'].includes(r.status)).length} / 待更新 {group.filter(r => !r.quote_ok).length}</span>; })}</div>
      {!rows.length ? <p className="py-5 text-sm text-muted-foreground">昨日没有符合这一梯队条件的样本，可切换范围查看。</p> : <div className="mt-3 overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr className="border-b border-border text-xs text-muted-foreground">{['昨日梯队','标的 / 行业','现价','本场涨跌','当前状态','行情时间'].map(label => <th key={label} className="whitespace-nowrap px-3 py-3 font-medium">{label}</th>)}</tr></thead><tbody>{rows.map(row => <tr key={row.code} className="border-b border-border/40"><td className="whitespace-nowrap px-3 py-3 font-semibold text-primary">{row.boards} 板</td><td className="px-3 py-3"><Link to={`/stock-data?symbol=${row.code}`} className="whitespace-nowrap hover:text-primary">{row.name} <span className="text-xs text-muted-foreground">{row.code}</span></Link>{row.sector && <p className="mt-1 text-xs text-muted-foreground">{row.sector}</p>}</td><td className="px-3 py-3 tabular-nums">{row.price ?? '—'}</td><td className={cn('px-3 py-3 tabular-nums', pctColor(row.pct))}>{row.pct == null ? '—' : `${row.pct > 0 ? '+' : ''}${row.pct.toFixed(2)}%`}</td><td className={cn('whitespace-nowrap px-3 py-3 text-xs', ['封板中','收盘涨停'].includes(row.status) ? 'text-primary' : 'text-muted-foreground')}>{row.status}</td><td className="whitespace-nowrap px-3 py-3 text-xs text-muted-foreground">{row.quote_time ? `${row.quote_time.slice(0,4)}-${row.quote_time.slice(4,6)}-${row.quote_time.slice(6,8)} ${row.quote_time.slice(8,10)}:${row.quote_time.slice(10,12)}:${row.quote_time.slice(12,14)}` : '未覆盖'}</td></tr>)}</tbody></table></div>}
      <p className="mt-3 text-xs leading-5 text-muted-foreground">“封板中”只表示该行情时点触及涨停价，不等于收盘晋级；“收盘涨停”按已收盘场次显示；分组的涨停数包含这两种状态。“触板回落”依据本场最高价。没有完整触板数据时只显示“未封板”。</p>
    </>}
    <Link to="/agent/intraday" className="mt-4 inline-flex min-h-10 items-center text-sm text-primary">查看复盘验证：竞价强弱、盘中路径与昨日条件 →</Link>
  </section>;
}
