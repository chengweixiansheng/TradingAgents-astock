import { randomId } from "@/lib/random-id";
import { useEffect, useRef, useState } from 'react';
import { Sparkles } from 'lucide-react';
import { AiComposer, AiMessages, type AiMsg } from './AiMessages';
import { EvidenceCard, type Evidence } from '@/components/ReviewAgentChat';
import { agentFetch } from '@/lib/agent';
import { agentRequest, loadAgentConnection } from '@/lib/agent-api';
import { useWorkspace } from '@/lib/workspace/state';
const SIMPLE = ['解释一下涨停样本统计的口径', '怎么阅读复盘里的证据与缺口？', '行业分组和概念题材有什么区别？', '这款工作台能帮助整理哪些复盘资料？'];
const TASKS = ['这份复盘的主要依据是什么？', '与前一日相比，涨停家数发生了什么变化？', '核对复盘中引用的公开材料'];
type Answer = { text?: string; findings: {text:string;citations:string[]}[]; gaps:string[]; evidence:Evidence[];status:string };
type Turn = {id:string;conversation_id:string;question:string;status:string;result:Answer|null;error:string|null;events:{message:string}[]};
type Summary = {id:string;title:string;anchor:string};
type Conversation = Summary & {source:{provider:string;model:string;baseURL?:string};context:{mode?:string;page?:string};turns:Turn[]};
type Pending = {id:string;question:string;conversation_id:string|null;anchor:string;mode:string;source:string};
function today() { const d=new Date();return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; }
function readPending(key:string):Pending|null { try {const v=JSON.parse(sessionStorage.getItem(key)||'null');return v&&/^[a-f0-9]{32}$/.test(v.id)&&typeof v.question==='string'?v:null;}catch{return null;} }
function answerText(turn:Turn) {return turn.result?.text || (turn.result ? [...turn.result.findings.map(f=>f.text), ...(turn.result.gaps.length?['资料缺口：',...turn.result.gaps]:[])].join('\n\n') : turn.error || (turn.status==='cancelled'?'任务已取消':''));}
/** Existing turns remain bound to their source and mode; retries reuse one request id. */
export function WorkspaceChat({ page = '首页' }: { page?: string }) {
 const state=useWorkspace();const mode=state.enabled?'agent':'direct';
 const cacheKey=`astock-workspace-pending:${page}`;
 const [draft,setDraft]=useState('');const [error,setError]=useState<string|null>(null);
 const [datesLoaded,setDatesLoaded]=useState(false);const [datesError,setDatesError]=useState('');
 const [reportDates,setReportDates]=useState<string[]>([]);const dateTouched=useRef(false);
 const [anchor,setAnchor]=useState(()=>readPending(cacheKey)?.anchor||today());const [conversation,setConversation]=useState<Conversation|null>(null);
 const [list,setList]=useState<Summary[]>([]);const [loading,setLoading]=useState(true);const [sending,setSending]=useState(false);
 const [recovery,setRecovery]=useState<Pending|null>(()=>readPending(cacheKey));
 const [refresh,setRefresh]=useState(0);const busy=useRef(false);const version=useRef(0);const alive=useRef(true);
 const container=useRef<HTMLElement>(null);const retry=useRef<Pending|null>(recovery);
 const running=conversation?.turns.find(t=>t.status==='running');
 const fixedMode=conversation?.context.mode||'agent';const modeChanged=!!conversation&&fixedMode!==mode;
 const pick=(value:string)=>{setDraft(value);container.current?.querySelector('textarea')?.focus();};
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
 useEffect(()=>{
  const abort=new AbortController();
  void agentRequest<Summary[]>(`/conversations?mode=${mode}&page=${encodeURIComponent(page)}`,undefined,abort.signal)
   .then(v=>{if(!abort.signal.aborted)setList(v);}).catch(()=>{if(!abort.signal.aborted)setError('无法读取历史会话，请刷新重试。');});
  return()=>abort.abort();
 },[mode,page,refresh]);
 useEffect(()=>{
  let active=true;
  if(mode!=='agent')return;
  setDatesLoaded(false);setDatesError('');
  void agentFetch<{dates:string[]}>('/api/review/dates').then(result=>{
   if(!active)return;const dates=result.dates.filter(d=>/^\d{4}-\d{2}-\d{2}$/.test(d)).sort().reverse();setReportDates(dates);setDatesLoaded(true);
   if(!conversation&&!recovery&&!dateTouched.current&&dates.length)setAnchor(dates[0]);
  }).catch(()=>{if(active)setDatesError('日期清单读取失败，可重新读取；发送时仍由服务端核对报告。');});
  return()=>{active=false;};
 },[mode,conversation?.id,refresh]);
 // Restore only the chosen conversation. Reading never restarts an interrupted model request.
 useEffect(()=>{
  const abort=new AbortController();setLoading(true);let id:string|null=null;
  try{id=localStorage.getItem(`astock-workspace-last:${page}`);}catch{setError('无法读取本地会话选择。');}
  if(id&&/^[a-f0-9]{32}$/.test(id)) void agentRequest<Conversation>(`/conversations/${id}`,undefined,abort.signal)
   .then(v=>{if(!abort.signal.aborted&&v.context.page===page){setConversation(v);setAnchor(v.anchor);}})
   .catch(()=>{if(!abort.signal.aborted)setError('上次会话暂时无法恢复，请从历史会话重试。');})
   .finally(()=>{if(!abort.signal.aborted)setLoading(false);});
  else setLoading(false);
  return()=>abort.abort();
 },[page]);
 useEffect(()=>{
  if(!running)return;const abort=new AbortController();let timer:ReturnType<typeof setTimeout>;
  const poll=async()=>{try{
   const turn=await agentRequest<Turn>(`/turns/${running.id}`,undefined,abort.signal);if(abort.signal.aborted)return;
   setConversation(prev=>prev?.id===turn.conversation_id?{...prev,turns:prev.turns.map(t=>t.id===turn.id?turn:t)}:prev);
   if(turn.status==='running')timer=setTimeout(poll,1000);
  }catch{if(!abort.signal.aborted){setError('暂时无法读取进度，正在重新连接；不会重复启动任务。');timer=setTimeout(poll,2000);}}};
  void poll();return()=>{abort.abort();clearTimeout(timer);};
 },[running?.id]);
 function remember(c:Conversation) {setConversation(c);setAnchor(c.anchor);try{localStorage.setItem(`astock-workspace-last:${page}`,c.id);}catch{setError('回答已在服务端保存，但浏览器无法保存会话选择。');}}
 async function choose(id:string){
  if(sending||running)return;const current=++version.current;setError(null);
  if(!id){setConversation(null);dateTouched.current=false;setAnchor(mode==='agent'&&reportDates.length?reportDates[0]:today());try{localStorage.removeItem(`astock-workspace-last:${page}`);}catch{}return;}
  setLoading(true);try{const c=await agentRequest<Conversation>(`/conversations/${id}`);if(alive.current&&current===version.current)remember(c);}
  catch{if(alive.current)setError('无法读取所选会话。');}finally{if(alive.current&&current===version.current)setLoading(false);}
 }
 async function removeConversation(){
  if(!conversation||sending||running||loading)return;
  if(!window.confirm('确认删除当前会话、回答及其验证条件？此操作无法撤销。'))return;
  setLoading(true);
  try{const result=await agentRequest<{ok:boolean}>(`/conversations/${conversation.id}/delete`,{});
   if(!result.ok)throw new Error('删除失败');
   setList(old=>old.filter(v=>v.id!==conversation.id));setConversation(null);
   try{localStorage.removeItem(`astock-workspace-last:${page}`);}catch{}
  }catch(e){setError(e instanceof Error?e.message:'删除失败');}finally{setLoading(false);}
 }
 async function send(text:string){
  if(busy.current||running||loading)return;const question=text.trim();if(!question||question.length>2000){setError('问题最多两千字。');pick(text);return;}
  if(mode==='agent'&&!conversation&&datesLoaded&&!reportDates.includes(anchor)){setError('所选日期尚无已存报告。请先到复盘报告生成，或选择下方已有日期。');pick(text);return;}
  const llm=loadAgentConnection();if(!llm){setError('请先接入并测试 AI。');pick(text);state.connect();return;}
  if(modeChanged){setError('模式已改变，请新建会话后发送。');pick(text);return;}
  const source=JSON.stringify({provider:llm.provider,model:llm.model,baseURL:llm.baseURL});
  const cid=conversation?.id||null;
  if(!retry.current||retry.current.question!==question||retry.current.source!==source||retry.current.conversation_id!==cid||retry.current.mode!==mode||retry.current.anchor!==anchor)
   retry.current={id:randomId().replace(/-/g,''),question,conversation_id:cid,anchor,mode,source};
  const pending=retry.current;
  // Persist identity BEFORE dispatch. Storage failure must not create an unrecoverable paid request.
  try{sessionStorage.setItem(cacheKey,JSON.stringify(pending));}catch{setError('无法保存请求编号，请允许本地存储后重试。');pick(text);return;}
  busy.current=true;setSending(true);setRecovery(pending);setError(null);
  try{
   const turn=await agentRequest<Turn>('/turns',{anchor,question,request_id:pending.id,conversation_id:cid,
    llm:{provider:llm.provider,model:llm.model,baseURL:llm.baseURL,apiKey:llm.apiKey},scope:{mode,page,allow_network:false,symbol:''}});
   // Keep recovery id until the conversation was also retrieved; a lost response retries the same request.
   const c=await agentRequest<Conversation>(`/conversations/${turn.conversation_id}`);
   if(alive.current){remember(c);setRefresh(n=>n+1);setRecovery(null);}
   retry.current=null;sessionStorage.removeItem(cacheKey);
  }catch(e){if(alive.current){setError(e instanceof Error?e.message:'发送未确认，可恢复同一请求。');setDraft(current=>current||text);}}
  finally{busy.current=false;if(alive.current)setSending(false);}
 }
 async function recover(){
  if(!recovery)return;const llm=loadAgentConnection();const source=llm?JSON.stringify({provider:llm.provider,model:llm.model,baseURL:llm.baseURL}):'';
  if(source!==recovery.source||mode!==recovery.mode||anchor!==recovery.anchor||(conversation?.id||null)!==recovery.conversation_id){setError('请恢复原 AI 来源、模式、日期和会话后重试；原请求不会自动重新生成。');return;}
  retry.current=recovery;await send(recovery.question);
 }
 async function cancel(){if(!running)return;try{const t=await agentRequest<Turn>(`/turns/${running.id}/cancel`,{});if(alive.current)setConversation(prev=>prev?{...prev,turns:prev.turns.map(x=>x.id===t.id?t:x)}:prev);}catch{if(alive.current)setError('尚未确认取消，请重试。');}}
 const msgs:AiMsg[]=(conversation?.turns||[]).flatMap(t=>[{role:'user' as const,content:t.question},...(answerText(t)?[{role:'assistant' as const,content:answerText(t),id:t.id}]:[])]);
 return <section ref={container} data-home-agent={page==='首页'?'':undefined} aria-label={`${page}聊天`} className="ai-surface flex h-[620px] min-h-[390px] flex-col overflow-hidden sm:h-[550px]">
  <div className="ai-surface-header flex items-center gap-2.5 border-b border-border/60 px-4 py-3 sm:px-5"><span className="rounded-lg bg-primary/10 p-2 text-primary"><Sparkles className="h-4 w-4"/></span><div><h2 className="font-bold">{page==='首页'?state.enabled?'今天，想复盘什么？':'今天，想聊什么？':`聊聊「${page}」`}</h2><p className="text-[11px] leading-5 text-muted-foreground">{conversation?`本会话：${fixedMode==='direct'?'普通对话':'证据 Agent'} · ${conversation.source.provider} · ${conversation.source.model}`:state.enabled?'Vibe AStock Agent · 查证据、比较变化':'普通对话 · 不调用工具'}</p></div></div>
  <div className="flex shrink-0 flex-wrap items-center gap-2 px-5 pt-3 text-xs text-muted-foreground"><span>{state.label}</span><button type="button" onClick={state.connect} className="rounded-lg border border-primary/30 px-3 py-2 text-primary">查看接入</button>
   <label>会话 <select aria-label={`${page}历史会话`} disabled={sending||!!running||loading} value={conversation?.id||''} onChange={e=>void choose(e.target.value)} className="max-w-44 rounded border border-border bg-background p-2"><option value="">新会话</option>{conversation&&!list.some(c=>c.id===conversation.id)&&<option value={conversation.id}>{conversation.title}</option>}{list.map(c=><option key={c.id} value={c.id}>{c.title}</option>)}</select></label><button disabled={sending||!!running||loading} onClick={()=>void choose('')} className="text-primary disabled:opacity-50">新建对话</button>
   {(state.enabled||conversation&&fixedMode==='agent')&&<label>复盘日 <input aria-label={`${page}复盘日期`} type="date" value={anchor} disabled={!!conversation||sending} onInput={e=>{dateTouched.current=true;setError(null);setAnchor(e.currentTarget.value);}} onChange={e=>{dateTouched.current=true;setError(null);setAnchor(e.target.value);}} className="rounded border border-border bg-background p-2"/></label>}
   {state.enabled&&!conversation&&<span className="flex flex-wrap gap-2">已存报告：{!datesLoaded?(datesError||'正在读取日期…'):reportDates.length?reportDates.slice(0,5).map(d=><button key={d} disabled={sending} onClick={()=>{dateTouched.current=true;setError(null);setAnchor(d);}} className="text-primary underline">{d}</button>):'尚无报告，请先生成复盘'}{datesError&&<button className="text-primary underline" onClick={()=>setRefresh(v=>v+1)}>重新读取日期</button>}</span>}
  </div>
  <AiMessages msgs={msgs} loading={sending||!!running||loading} err={error} info={modeChanged?'开关已改变，新建会话后使用所选模式。':running?.events[running.events.length-1]?.message||null}
   notice={state.enabled?'仅查询所选日及此前已有的公开复盘。没有资料时会明确报告缺口；本聊天不补充联网数据。':'普通对话仅发送问题与本会话历史，不读取页面、复盘或本地文件。'} suggestions={state.enabled?TASKS:SIMPLE} suggestionStyle="tasks" onPick={pick}
   renderReplyActions={(_reply,_question,id)=>{const result=conversation?.turns.find(t=>t.id===id)?.result;return result?.evidence.length?<div className="mt-3 grid gap-2">{result.evidence.map(e=><EvidenceCard key={e.id} evidence={e} all={result.evidence}/>)}</div>:null;}}/>
  {recovery&&!sending&&<div className="flex flex-wrap gap-3 px-5 pb-2 text-xs"><button onClick={()=>void recover()} className="text-primary underline">恢复上次发送（同一请求）</button><button onClick={()=>pick(recovery.question)} className="text-primary underline">放回草稿</button></div>}
  {conversation&&<button disabled={sending||!!running||loading} onClick={()=>void removeConversation()} className="mx-5 text-xs text-muted-foreground hover:text-danger disabled:opacity-30">删除当前会话</button>}
  <AiComposer placeholder="说说要聊什么、复盘什么…（Shift+Enter 换行）" disabled={sending||!!running||loading||modeChanged} value={draft} onValueChange={setDraft} highlighted onSend={text=>void send(text)} onStop={running?()=>void cancel():undefined}/>
 </section>;
}
