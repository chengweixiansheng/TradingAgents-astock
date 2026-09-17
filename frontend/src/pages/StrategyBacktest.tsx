import { randomId } from "@/lib/random-id";
import { useEffect, useRef, useState } from 'react';
import { authHeaders } from '@/lib/api';
import { apiUrl } from '@/lib/base';
import { Link } from 'react-router-dom';
import { PageHeader } from '@/components/ui/PageHeader';
import { agentRequest, loadAgentConnection, type AgentConnection } from '@/lib/agent-api';
type Spec={codes:string[];start:string;end:string;strategy:string;params:Record<string,number>;style:string;initial_cash:number;allow_short:boolean};
type Execution={archive?:boolean;truncated?:boolean;fills_total?:number;equity_total?:number;equity_min?:number;equity_max?:number;fills:Record<string,unknown>[];equity:{date:string;equity:number}[];note:string};
type Result={execution?:Execution;strategy:string;plan:{codes:string[];start:string;end:string;currency:string;notes:string[];limits:string[]};metrics:Record<string,number|null>;required_disclosures:string[];provenance:{code:string;endpoint:string;rows:number;first_bar:string;last_bar:string;note:string;price_basis:string}[]};
type Job={job_id:string;running:boolean;status:string;stage?:string;answer?:string;error?:string;backtest_spec?:Spec|null;backtest_result?:Result;backtest_refused?:boolean};
type Message={role:'user'|'assistant';content:string};
type Pending={request_id:string;messages:Message[];task_kind:'backtest';backtest_args?:Spec;source:Omit<AgentConnection,'apiKey'|'verifiedAt'>};
const storage='astock-backtest-pending-v1';
const strategies:Record<string,string>={buy_and_hold:'买入持有',ma_cross:'均线交叉',rsi_reversion:'RSI 均值回归'};
const metrics:Record<string,string>={total_return:'总收益率',annual_return:'年化收益率',max_drawdown:'最大回撤',sharpe:'夏普比率',calmar:'卡玛比率',sortino:'索提诺比率',win_rate:'胜率（毛）',profit_loss_ratio:'盈亏比（毛）',profit_factor:'盈利因子（毛）',net_win_rate:'胜率（扣费）',net_profit_loss_ratio:'盈亏比（扣费）',net_profit_factor:'盈利因子（扣费）',net_max_consecutive_loss:'连续亏损（扣费）',trade_count:'平仓记录数',fill_count:'成交记录数',avg_holding_days:'平均持有交易日',benchmark_return:'标的自身基准收益',total_turnover:'总换手率',max_consecutive_loss:'最大连续亏损次数',execution_fees:'成交费用'};
const percent=new Set(['total_return','annual_return','max_drawdown','win_rate','net_win_rate','benchmark_return']);
function ExecutionView({data,jobId}:{data:Execution;jobId:string}) {
 const [error,setError]=useState('');
 const values=data.equity.map(x=>x.equity), lo=data.equity_min??Math.min(...values), hi=data.equity_max??Math.max(...values);
 const points=values.map((v,i)=>`${i/Math.max(1,values.length-1)*900},${170-(v-lo)/Math.max(1,hi-lo)*150}`).join(' ');
 const download=async()=>{setError('');try{let blob:Blob;if(data.archive){const response=await fetch(apiUrl(`/api/review-agent/chat-jobs/${jobId}/execution`),{headers:authHeaders()});if(!response.ok){const detail=await response.json().catch(()=>null);throw new Error(typeof detail?.detail==='string'?detail.detail:'完整成交归档读取失败，请重试。')}blob=await response.blob()}else{blob=new Blob([JSON.stringify(data,null,2)],{type:'application/json'})}const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=data.archive?`backtest-${jobId}-execution.zip`:'backtest-execution.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000)}catch(e){setError((e as Error).message)}};
 return <section className="glass space-y-3 rounded-xl p-4"><h3 className="font-semibold">净值曲线与成交明细</h3><p className="text-xs text-muted-foreground">{data.note} 表格金额保留两位小数，悬停与导出保留原精度。共 {data.fills_total??data.fills.length} 笔成交，{data.equity_total??values.length} 个权益观测。</p>{values.length>0&&<><svg role="img" aria-label="扣费账户权益曲线" viewBox="0 0 900 190" className="w-full"><polyline fill="none" stroke="currentColor" className="text-primary" strokeWidth="2" points={points}/></svg><p className="text-xs">{data.equity[0].date} 至 {data.equity[data.equity.length - 1]?.date} · 权益区间 {lo.toLocaleString()}—{hi.toLocaleString()}</p></>}
 <button onClick={()=>void download()} className="rounded border border-border px-3 py-2 text-sm">{data.truncated && !data.archive ? '导出当前已加载记录' : '导出全部成交与权益数据'}</button>{error&&<p role="alert" className="text-danger">{error}</p>}
 <div className="max-h-96 overflow-auto"><table className="w-full text-left text-xs"><thead><tr>{['时间','代码','动作','数量','成交价','费用','原因'].map(x=><th key={x} className="p-2">{x}</th>)}</tr></thead><tbody>{data.fills.slice(0,200).map((f,i)=><tr key={i}>{['timestamp','symbol','action','signed_quantity','execution_price','fee','reason'].map(k=><td key={k} className="p-2" title={String(f[k]??'未提供')}>{typeof f[k] === 'number' ? (f[k] as number).toLocaleString('zh-CN',{maximumFractionDigits:k==='signed_quantity'?4:2}) : String(f[k]??'未提供')}</td>)}</tr>)}</tbody></table></div>{(data.fills_total??data.fills.length)>200&&<p className="text-xs">表格展示前 200 笔；{data.truncated && !data.archive ? `导出仅含已加载的 ${data.fills.length} 笔。` : "导出含全部记录。"}</p>}</section>
}
export function StrategyBacktest(){
  const [text,setText]=useState(''),[messages,setMessages]=useState<Message[]>([]),[job,setJob]=useState<Job|null>(null),[error,setError]=useState(''),[pending,setPending]=useState<Pending|null>(null),[reports,setReports]=useState<{job_id:string;started:number;spec:Spec}[]>([]),[busy,setBusy]=useState(false);
  const alive=useRef(true), handled=useRef('');
  const history=()=>agentRequest<typeof reports>('/backtest-reports').then(d=>{if(alive.current)setReports(d)}).catch(()=>{if(alive.current)setError('回测报告列表暂时读取失败，请刷新页面重试。')});
  useEffect(()=>{alive.current=true;void history();try{const raw=JSON.parse(localStorage.getItem(storage)||'null');if(raw?.task_kind==='backtest'&&/^[0-9a-f]{32}$/.test(raw.request_id)&&Array.isArray(raw.messages)&&raw.source){setPending(raw);setMessages(raw.messages);setBusy(true)}}catch{setError('恢复记录读取失败，已保存报告仍可从下方打开。')}return()=>{alive.current=false}},[]);
  useEffect(()=>{
    if(!pending)return;let stopped=false,timer:ReturnType<typeof setTimeout>;
    const poll=async()=>{try{const row=await agentRequest<Job>(`/chat-jobs/${pending.request_id}`);if(stopped)return;setJob(row);if(row.running){setBusy(true);timer=setTimeout(poll,1500);return}setBusy(false);if(handled.current!==row.job_id){handled.current=row.job_id;setMessages([...pending.messages,...(row.answer?[{role:'assistant' as const,content:row.answer.length>4000?row.answer.slice(0,3950)+"\n[旧条件说明过长，已截断，请重新整理后确认。]":row.answer}]:[])]);if(row.error)setError(row.error);localStorage.removeItem(storage);setPending(null);void history()}}catch(e){if(!stopped){setBusy(false);setError((e as Error).message+'；可重试恢复同一请求。')}}};
    timer=setTimeout(poll,800);return()=>{stopped=true;clearTimeout(timer)};
  },[pending]);
  async function send(spec?:Spec,retry?:Pending){
    if(busy)return;const connection=loadAgentConnection();if(!connection){setError('请先在“接入 AI”选择并测试来源。');return}
    const source={provider:connection.provider,model:connection.model,baseURL:connection.baseURL};
    if(retry&&JSON.stringify(source)!==JSON.stringify(retry.source)){setError('当前 AI 来源已变化，请切回原来源后恢复请求。');return}
    const next=retry?.messages??[...messages,{role:'user' as const,content:spec?'确认以上参数，执行历史回测。':text.trim()}].slice(-12);
    if(!spec&&!retry&&!text.trim())return;
    let request:Pending;
    try{request=retry??{request_id:randomId().replace(/-/g,''),messages:next,task_kind:'backtest',...(spec?{backtest_args:spec}:{}),source};localStorage.setItem(storage,JSON.stringify(request))}catch{setError('无法保存恢复标识，未发起任务。');return}
    setBusy(true);setError('');setJob(spec?{job_id:request.request_id,running:true,status:"running",backtest_spec:spec}:null);setMessages(next);setText('');
    try{const {source:_,...body}=request;await agentRequest<Job>('/chat-jobs',{...body,llm:connection});if(alive.current)setPending({...request})}catch(e){if(alive.current){setPending({...request});setBusy(false);setError((e as Error).message)}}
  }
  const spec=job?.backtest_spec,result=job?.backtest_result;
  return <div className="space-y-6"><PageHeader title="回测" subtitle="把想验证的历史规则说清楚，确认条件后用真实日线计算，结果自动保存在本机。" />
    <p className="text-sm text-muted-foreground">支持 A 股、美股、港股的日线买入持有、均线交叉和 RSI 均值回归。目前只支持上述三种规则；短线是日线级验证，不模拟盘中打板。持有周期由规则触发决定，买入持有一直持有到期末；不支持任意固定 N 日卖出。费用、滑点与市场约束随报告披露；历史表现不能证明未来收益。<Link to="/settings" className="ml-2 text-primary">接入 AI</Link></p>
    <div className="glass space-y-4 rounded-2xl p-5">{messages.map((m,i)=><div key={i} className={`whitespace-pre-wrap rounded-xl p-3 text-sm ${m.role==='user'?'bg-primary/10':'bg-muted/30'}`}><span className="mb-1 block text-xs text-muted-foreground">{m.role==='user'?'你的问题':'条件整理'}</span>{m.content}</div>)}
      <label className="block text-sm">想验证什么？<textarea value={text} onChange={e=>setText(e.target.value)} maxLength={4000} disabled={busy||!!pending} placeholder="例如：验证 600519.SH 在 2023-01-01 至 2025-12-31 的 20/60 日均线交叉，初始资金 10 万元。" className="mt-2 min-h-28 w-full rounded-xl border border-border bg-background/70 p-3 outline-none focus:border-primary" /></label>
      <div className="flex flex-wrap gap-3"><button disabled={busy||!!pending||!text.trim()} onClick={()=>void send()} className="rounded-lg bg-primary px-4 py-2 text-primary-foreground disabled:opacity-40">整理回测条件</button>{spec&&!result&&!pending&&<button disabled={busy} onClick={()=>void send(spec)} className="rounded-lg border border-primary px-4 py-2 text-primary">确认参数并运行</button>}{pending&&!busy&&<button onClick={()=>void send(undefined,pending)} className="rounded-lg border border-border px-4 py-2">恢复同一请求</button>}{pending&&<button onClick={()=>void agentRequest(`/chat-jobs/${pending.request_id}/cancel`,{}).then(()=>setPending({...pending})).catch(e=>setError(e.message))} className="rounded-lg border border-border px-4 py-2">取消本次任务</button>}</div>
      {busy&&<p role="status" className="text-sm text-primary">{job?.stage||'正在处理…'}</p>}{error&&<p role="alert" className="text-sm text-danger">{error}</p>}
    </div>
    {spec&&<section className="glass rounded-xl p-4"><h2 className="mb-2 font-semibold">回测条件</h2><p className="text-sm">{spec.codes.join(' · ')} · {spec.start} 至 {spec.end} · {strategies[spec.strategy]||spec.strategy}</p><p className="mt-2 text-sm text-muted-foreground">初始资金 {spec.initial_cash.toLocaleString()} · {spec.allow_short?'允许做空（仍受市场规则约束）':'不做空'} · 参数 {JSON.stringify(spec.params)}</p></section>}
    {result&&<section className="space-y-4"><h2 className="text-xl font-bold">回测报告 · {result.strategy}</h2>{result.plan.currency==='HKD'&&!(result.plan.notes??[]).some(n=>n.startsWith('市场执行规则 v2：'))&&<p role="alert" className="rounded-xl border border-warning/40 p-4 text-sm text-warning">这份旧港股报告可能使用了美股默认费用与交易单位，请按原条件重新运行后再比较收益。旧记录保留供追溯。</p>}<div className="grid grid-cols-2 gap-3 lg:grid-cols-3">{Object.entries(result.metrics).filter(([k])=>metrics[k]).map(([k,v])=><div key={k} className="glass rounded-xl p-4"><p className="text-xs text-muted-foreground">{metrics[k]}{k==='execution_fees'?` (${result.plan.currency})`:''}</p><p className="mt-2 text-lg font-semibold">{v==null||!Number.isFinite(v)?'未定义':percent.has(k)?`${(v*100).toFixed(2)}%`:v.toLocaleString(undefined,{maximumFractionDigits:4})}</p></div>)}</div>
      <div className="rounded-xl bg-muted/30 p-4 text-sm"><h3 className="mb-2 font-semibold">计算口径与限制</h3>{[...new Set([...(result.plan.notes??[]),...(result.plan.limits??[]),...(result.required_disclosures??[])])].map((s,i)=><p key={i} className="mb-2">{s}</p>)}</div>
      {result.execution ? <ExecutionView key={job!.job_id} data={result.execution} jobId={job!.job_id}/> : <p className="text-sm text-warning">这份旧报告尚未包含界面成交明细，重新运行后可查看曲线并导出。</p>}
      <h3 className="font-semibold">数据来源</h3>{result.provenance.map(p=><p key={p.code} className="text-sm text-muted-foreground">{p.code} · {p.endpoint} · {p.first_bar} 至 {p.last_bar} · {p.rows} 根日线<br/>{p.price_basis} {p.note}</p>)}
    </section>}
    <section className="border-t border-border pt-5"><h2 className="mb-3 text-lg font-semibold">最近回测报告</h2>{!reports.length&&<p className="text-sm text-muted-foreground">完成真实回测后会显示在这里，补充条件的对话不会算成报告。</p>}{reports.map(r=><button key={r.job_id} disabled={busy||!!pending} onClick={()=>{void agentRequest<Job>(`/chat-jobs/${r.job_id}`).then(d=>{setJob(d);setMessages([]);setText('');setError('')}).catch(e=>setError(e.message))}} className="block w-full border-b border-border py-3 text-left text-sm hover:text-primary disabled:opacity-40">{new Date(r.started*1000).toLocaleString()} · {r.spec?.codes.join('、')} · {r.spec&&strategies[r.spec.strategy]}</button>)}</section>
  </div>;
}
