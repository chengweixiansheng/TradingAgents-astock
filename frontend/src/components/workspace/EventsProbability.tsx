import { beijingTime, closesWithin30Days } from '@/lib/time-display';
import { useEffect, useState } from 'react';
import { agentRequest } from '@/lib/agent-api';
type Item = {source_url?:string;module:string;venue:string;title:string;leg:string;prob:number|null;volume:number;volume_missing:boolean;close:string;as_of:string;ticker:string};
type Snapshot = {items:Item[];as_of:string;guard:string;warnings:string[];errors:string[];sources_partial:string[];stale:boolean;cached:boolean;cache_age_seconds:number;refresh_error?:string};
export function EventsProbability() {
  const [data,setData]=useState<Snapshot|null>(null),[error,setError]=useState(''),[loading,setLoading]=useState(false),[revision,setRevision]=useState(0);
  useEffect(()=>{let alive=true;setLoading(true);setError('');agentRequest<Snapshot>('/macro-probability').then(d=>{if(alive)setData(d)}).catch(e=>{if(alive)setError(e.message)}).finally(()=>{if(alive)setLoading(false)});return()=>{alive=false}},[revision]);
  const [near, setNear] = useState(false);
  const items = (data?.items || []).filter(i => !near || closesWithin30Days(i.close));
  const partial=!!data && (data.sources_partial.length>0 || data.errors.length>0 || data.warnings.length>0);
  return <div className="space-y-4"><div className="flex flex-wrap items-center justify-between gap-2"><p className="text-xs text-muted-foreground">Kalshi · Polymarket · 公开只读{data && ` · 采集完成 ${beijingTime(data.as_of)}`}</p><button disabled={loading} onClick={()=>setRevision(x=>x+1)} className="rounded-lg border border-border px-3 py-2 text-sm disabled:opacity-50">{loading?'正在取数…':'刷新'}</button></div>
    {data && <p className="text-xs text-muted-foreground">{error?`本次刷新失败，下方仍为 ${beijingTime(data.as_of)} 的快照。`:data.cached?`当前使用 ${Math.ceil(data.cache_age_seconds/60)} 分钟前采集的快照${data.stale?"，本次刷新失败。":"，五分钟内复用以减少源站请求。"}`:'本次已从源站采集最新快照。'}</p>}
    {loading && <p role="status" className="text-sm text-muted-foreground">正在查询公开合约，首次可能需要一至两分钟。</p>}
    {error && <p role="alert" className="text-sm text-danger">{error}</p>}
    <p className="text-sm text-muted-foreground">用于观察宏观预期，不是个股涨跌概率。先看结算日期与成交量；远期事件仅作背景，不能直接判断今日短线机会。来源链接展示源站当前数据，可能与本次快照不同。</p>
    <label className="flex gap-2 text-sm"><input type="checkbox" checked={near} onChange={e => setNear(e.target.checked)} />只看未来 30 天内结算（按源站日期筛选；未给时刻的仅精确到日，日期不明的保留在全部清单）</label>
    {near && !items.length && <p className="text-sm">当前快照无日期可确认的近 30 天事件；取消筛选可查看全部宏观背景。</p>}
    {data && <><p className="rounded-lg bg-muted/40 p-3 text-sm text-muted-foreground">{data.guard.replace(/\*\*/g, "")}</p>
      {(partial||data.stale) && <p role="status" className="text-sm text-warning">{data.refresh_error || '部分来源未完整查完，当前是采样清单，不能据此断言未出现的事件没有市场报价。'}</p>}
      {!data.items.length && <p>本轮没有取得符合条件的合约报价，不代表没有相关事件。</p>}
      {[...new Set(items.map(i=>i.module))].map(group=><section key={group}><h4 className="mb-2 font-semibold">{group}</h4><div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr className="text-muted-foreground">{['合约 / 情形','市场概率','结算日期','24h 成交量','来源 / 采集时间'].map(x=><th key={x} className="px-3 py-2 font-normal">{x}</th>)}</tr></thead><tbody>{items.filter(i=>i.module===group).map(i=><tr key={JSON.stringify([i.venue,i.ticker,i.leg])} className="border-t border-border/60"><td className="min-w-56 px-3 py-3">{i.title}<div className="text-xs text-muted-foreground">{i.leg}</div></td><td className="whitespace-nowrap px-3 text-primary">{i.prob==null?'未覆盖':`${(i.prob*100).toFixed(1)}%`}</td><td className="whitespace-nowrap px-3">{beijingTime(i.close)}</td><td className="px-3">{i.volume_missing?'未覆盖':i.volume.toLocaleString()}</td><td className="px-3 text-xs text-muted-foreground">{i.venue}{i.source_url && /^https:\/\/(api\.elections\.kalshi\.com|gamma-api\.polymarket\.com)\//.test(i.source_url) && <a className="ml-2 text-primary underline" href={i.source_url} target="_blank" rel="noopener noreferrer">源站当前数据</a>}<div className="whitespace-nowrap">{beijingTime(i.as_of)}</div></td></tr>)}</tbody></table></div></section>)}
      {partial && <details className="text-xs text-muted-foreground"><summary>查看数据覆盖说明</summary>{[...data.warnings,...data.errors].map((s,i)=><p key={i} className="mt-2">{s}</p>)}</details>}</>}
  </div>;
}
