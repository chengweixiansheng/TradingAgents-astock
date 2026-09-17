"""A2 browser contracts; dedicated profile, all API calls synthetic and network-blocked."""
import json,time,os
from pathlib import Path
assert os.environ.get('BU_CDP_URL')=='http://127.0.0.1:9227'
out=Path('.local/alignment-a2-20260907').resolve();checks=[]
def check(name,ok):
 checks.append({'name':name,'passed':bool(ok)})
 if not ok:print('FAILED',name)
def until(expr,seconds=10):
 end=time.monotonic()+seconds
 while time.monotonic()<end:
  if js(expr):return True
  wait(.1)
 return False
def fill(text):
 js("(()=>{const e=document.querySelector('textarea[aria-label=\"聊天问题\"]');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,"+json.dumps(text)+");e.dispatchEvent(new Event('input',{bubbles:true}));})()")
def click(text):
 js("[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==="+json.dumps(text)+")?.click()")
new_tab('about:blank');cdp('Page.bringToFront');cdp('Network.enable');cdp('Network.setBlockedURLs',urls=['*/api/*'])
fixture=cdp('Page.addScriptToEvaluateOnNewDocument',source='''
const real=window.fetch.bind(window);
window.__calls=[];window.__failSend=false;window.__finish=false;
const store=()=>JSON.parse(sessionStorage.getItem('a2-backend')||'{"conversations":{},"requests":{}}');
window.__done=()=>{const s=store();for(const c of Object.values(s.conversations))for(const t of c.turns){if(t.status==='running'){t.status='complete';t.result={status:'complete',text:c.context.mode==='direct'?'合成普通回答':undefined,findings:[{text:'合成指标增加，仅作比较。',citations:['ev-test']}],gaps:[],evidence:c.context.mode==='direct'?[]:[{id:'ev-test',kind:'metric',date:c.anchor,label:'合成测试读数',display:'15.00 家',note:'合成夹具，非真实市场',source:'测试来源'}]};}}sessionStorage.setItem('a2-backend',JSON.stringify(s));};
window.fetch=async(input,init)=>{
 const url=new URL(String(input),location.href);if(!url.pathname.startsWith('/api/'))return real(input,init);
 const p=url.pathname.replace('/api/review-agent','');const b=init?.body?JSON.parse(init.body):null;
 window.__calls.push({p,b});let s=store(),data={};
 if(p==='/status')data={installed:true,subscription_ready:true,models_error:'',models:[],default_model:'test'};
 else if(p==='/access')data={status:'idle'};
 else if(p==='/conversations')data=Object.values(s.conversations).filter(c=>(c.context.mode||'agent')===url.searchParams.get('mode')&&c.context.page===url.searchParams.get('page'));
 else if(p.startsWith('/conversations/'))data=s.conversations[p.split('/')[2]];
 else if(p==='/turns'&&b){
  if(s.requests[b.request_id])data=s.requests[b.request_id];else{
   const id='a'.repeat(31)+(Object.keys(s.conversations).length+1);const cid=b.conversation_id||id;
   const c=s.conversations[cid]||(s.conversations[cid]={id:cid,title:b.question,anchor:b.anchor,source:{provider:b.llm.provider,model:b.llm.model},context:b.scope,turns:[]});
   data={id:'b'.repeat(30)+String(Object.keys(s.requests).length+1).padStart(2,'0'),conversation_id:cid,question:b.question,status:'running',result:null,error:null,events:[{message:'测试任务等待中'}]};c.turns.push(data);s.requests[b.request_id]=data;
   sessionStorage.setItem('a2-backend',JSON.stringify(s));
  }
  await new Promise(r=>setTimeout(r,350));if(window.__failSend){window.__failSend=false;throw new TypeError('synthetic response lost');}
 }
 else if(p.startsWith('/turns/')){
  data=Object.values(s.conversations).flatMap(c=>c.turns).find(t=>t.id===p.split('/')[2]);
  if(p.endsWith('/cancel')){data.status='cancelled';data.error='任务已取消';sessionStorage.setItem('a2-backend',JSON.stringify(s));}
 }
 else data={};
 return new Response(JSON.stringify(data),{headers:{'Content-Type':'application/json'}});
};
''')
goto_url('http://127.0.0.1:5918/');wait_for_element('[data-home-agent]',timeout=10)
js("localStorage.removeItem('astock-agent-connection');localStorage.removeItem('astock-workspace-last:首页');localStorage.setItem('astock-workspace-agent-v1','off');sessionStorage.clear();location.reload()")
wait_for_element('[data-home-agent]',timeout=10);until("!document.querySelector('.ai-send').disabled")
fill('未连接时保留这句');click('发送');wait(.2)
check('missing source preserves rejected draft',js("document.querySelector('textarea[aria-label=\"聊天问题\"]').value==='未连接时保留这句'"))
js("document.querySelector('button[aria-label=\"暂不接入，先浏览\"]')?.click();localStorage.setItem('astock-agent-connection',JSON.stringify({provider:'codex-private',model:'test',baseURL:'',apiKey:''}));window.dispatchEvent(new Event('astock-connection-changed'))")
fill('x'*2001);click('发送');wait(.1)
check('over-limit rejected draft preserved',js("document.querySelector('textarea').value.length===2001"))
check('rejected requests never reached turns',js("__calls.filter(x=>x.p==='/turns').length===0"))
fill('普通问题');click('发送');wait(.08);fill('等待时写的新草稿')
check('direct dispatch completes',until("document.body.textContent.includes('测试任务等待中')"))
check('HTTP completion preserves next draft',js("document.querySelector('textarea').value==='等待时写的新草稿'"))
check('direct has no market scope',js("__calls.find(x=>x.p==='/turns').b.scope.mode==='direct'&&!__calls.find(x=>x.p==='/turns').b.scope.allow_network"))
js('__done()');check('direct answer rendered',until("document.body.textContent.includes('合成普通回答')"))
check('direct has no evidence cards',js("!document.body.textContent.includes('合成测试读数')"))
js('location.reload()');wait_for_element('[data-home-agent]',timeout=10)
check('reload restores saved answer',until("document.body.textContent.includes('合成普通回答')"))
check('reload never resubmits',js("__calls.filter(x=>x.p==='/turns').length===0"))
js("document.querySelector('button[role=switch][aria-label=\"开启Agent\"]').click()")
check('mode change preserves fixed conversation',until("document.body.textContent.includes('开关已改变')"))
check('mode mismatch prevents send',js("document.querySelector('.ai-send').disabled"))
click('新建对话');fill('对比合成指标');click('发送');until("document.body.textContent.includes('测试任务等待中')")
check('agent source and mode explicit',js("__calls.filter(x=>x.p==='/turns').at(-1).b.scope.mode==='agent'&&__calls.filter(x=>x.p==='/turns').at(-1).b.llm.provider==='codex-private'"))
js('__done()');check('agent evidence cards rendered',until("document.body.textContent.includes('合成测试读数')"))
click('新建对话');js('__failSend=true');fill('模拟响应丢失');click('发送')
check('lost response exposes recovery',until("document.body.textContent.includes('恢复上次发送')"))
click('恢复上次发送（同一请求）');check('recovery resumes accepted turn',until("document.body.textContent.includes('测试任务等待中')"))
check('recovery same request id',js("(()=>{const a=__calls.filter(x=>x.p==='/turns'&&x.b.question==='模拟响应丢失');return a.length===2&&a[0].b.request_id===a[1].b.request_id;})()"))
click('停止');check('cancellation rendered',until("document.body.textContent.includes('任务已取消')"))
check('cancel request dispatched',js("__calls.some(x=>x.p.endsWith('/cancel'))"))
capture_screenshot(str(out/'a2-chat-dark.png'),max_dim=1600)
(out/'browser-contracts.json').write_text(json.dumps(checks,ensure_ascii=False,indent=2))
print(json.dumps({'passed':sum(x['passed'] for x in checks),'total':len(checks)},ensure_ascii=False))
assert all(x['passed'] for x in checks)
