"""A3 real UI / synthetic API. Dedicated Chrome only; no provider or private data."""
import json,time,os
from pathlib import Path
assert os.environ.get('BU_CDP_URL')=='http://127.0.0.1:9227'
out=Path('.local/alignment-a3-20260907').resolve(); checks=[]
def check(name,ok):
 checks.append({'name':name,'passed':bool(ok)})
 if not ok:print('FAILED',name)
def until(expr,seconds=10):
 end=time.monotonic()+seconds
 while time.monotonic()<end:
  if js(expr):return True
  wait(.1)
 return False
def fill(selector,value):
 js(f"(()=>{{const e=document.querySelector({json.dumps(selector)});Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,{json.dumps(value)});e.dispatchEvent(new Event('input',{{bubbles:true}}));}})()")
def click(text):js(f"[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==={json.dumps(text)})?.click()")
new_tab('about:blank');cdp('Page.bringToFront');cdp('Network.enable');cdp('Network.setBlockedURLs',urls=['*/api/*'])
cdp('Emulation.setDeviceMetricsOverride',width=1440,height=1000,deviceScaleFactor=1,mobile=False)
script=cdp('Page.addScriptToEvaluateOnNewDocument',source=r'''
window.__calls=[];window.__chatJobs={};window.__failedPoll=false;
const A='a'.repeat(32),B='b'.repeat(32);
window.__dd={job_id:A,status:'complete',running:false,stage:'已保存',stock:'600519',elapsed:3};
window.__report={code:'600519',name:'合成标的A',trade_date:'2026-09-07',generated_at:'合成时间',ai_source:{provider:'codex-private',model:'test'},verdict:{one_liner:'本次报告A',risks:[]},verdict_md:'本次报告A',reports:{theme:'题材章节'+('合成材料'.repeat(2200)),capital:'资金章节',technical:'技术章节',risk:'风险章节'},debate:{join:'正方',avoid:'反方'},input_sources:[{privateMetadataNotForQuestion:'禁止自动混入'}]};
const original=window.fetch.bind(window);
window.fetch=async(input,init)=>{
 const u=new URL(typeof input==='string'?input:input.url,location.href);
 if(!u.pathname.startsWith('/api/'))return original(input,init);
 const p=u.pathname.replace('/api/review-agent',''),b=init?.body?JSON.parse(init.body):null;__calls.push({p,b,query:u.search});let data={};
 if(p==='/status')data={installed:true,subscription_ready:true,models:[],default_model:'test'};
 else if(p==='/access')data={status:'idle'};
 else if(p==='/api/deepdive/latest'){await new Promise(r=>setTimeout(r,800));data={...__report,verdict_md:'旧报告不得覆盖',verdict:{one_liner:'旧报告不得覆盖',risks:[]}};}
 else if(p==='/deepdive'){
  if(b){__dd={job_id:b.request_id,status:'running',running:true,stage:'资金流向',stock:b.stock};data=__dd;}
  else data=u.searchParams.has('job_id')&&u.searchParams.get('job_id')===A?{job_id:A,status:'complete',running:false}:__dd;
 }
 else if(p.startsWith('/deepdive/reports/'))data=__report;
 else if(p==='/deepdive/cancel'){data=__dd={...__dd,status:'cancelled',running:false,error:'已取消'};}
 else if(p==='/chat-jobs'&&b){
  if(!__chatJobs[b.request_id])__chatJobs[b.request_id]={job_id:b.request_id,running:true,status:'running',input:b,trace:[]};
  data=__chatJobs[b.request_id];
 } else if(p.startsWith('/chat-jobs/')){
  const id=p.split('/')[2];data=__chatJobs[id];
  if(p.endsWith('/cancel')){
   if(window.__cancelFail)throw new TypeError('synthetic cancellation network failure');
   data.running=false;data.status='cancelled';data.error='已取消';
  } else {
   if(window.__failPoll){window.__failPoll=false;throw new TypeError('synthetic poll loss');}
   if(!window.__hold){data.running=false;data.status='complete';data.result={content:window.__long?'长回答'.repeat(1800):'合成回答已完成',trace:[],rounds:1};}
  }
 }
 return new Response(JSON.stringify(data),{headers:{'Content-Type':'application/json'}});
};
''')
goto_url('http://127.0.0.1:5918/agent/deepdive');wait_for_element('h1')
js("localStorage.setItem('astock-agent-connection',JSON.stringify({provider:'codex-private',model:'test',baseURL:'',apiKey:'',verifiedAt:Date.now()-1000}));localStorage.setItem('astock-workspace-agent-v1','off');sessionStorage.clear();location.reload()")
wait_for_element('input[aria-label="报告追问"]');wait(1)
check('late legacy report never overrides job report',js("document.body.textContent.includes('本次报告A')&&!document.body.textContent.includes('旧报告不得覆盖')"))
check('visible report source',js("document.body.textContent.includes('codex-private / test')"))
for i in range(7):
 fill('[aria-label="报告追问"]',f'问题{i}')
 js("document.querySelector('[aria-label=\"发送报告问题\"]').click()")
 check(f'question {i+1} completes',until("!document.querySelector('[aria-label=\"发送报告问题\"]').disabled"))
check('verification metadata never enters model request',js("__calls.filter(c=>c.p==='/chat-jobs').length>0&&__calls.filter(c=>c.p==='/chat-jobs').every(c=>Object.keys(c.b.llm).sort().join(',')==='apiKey,baseURL,model,provider')"))
check('seven questions accepted and old history bounded',js("Object.keys(__chatJobs).length===7&&__calls.filter(c=>c.p==='/chat-jobs').every(c=>c.b.messages.length<=11)"))
check('question uses selected report without internal metadata',js("__calls.filter(c=>c.p==='/chat-jobs').every(c=>c.b.context.includes('本次报告A')&&!c.b.context.includes('禁止自动混入')&&!c.b.allow_tools)"))
js('__long=true');fill('[aria-label="报告追问"]','长回答测试');js("document.querySelector('[aria-label=\"发送报告问题\"]').click()")
until("!document.querySelector('[aria-label=\"发送报告问题\"]').disabled")
js('__long=false');fill('[aria-label="报告追问"]','继续追问');js("document.querySelector('[aria-label=\"发送报告问题\"]').click()")
check('followup after long answer succeeds',until("!document.querySelector('[aria-label=\"发送报告问题\"]').disabled"))
check('long old answer explicitly excerpted',js("__calls.filter(c=>c.p==='/chat-jobs').at(-1).b.messages.some(m=>m.content.includes('较早消息已节选'))"))
js('__failPoll=true');fill('[aria-label="报告追问"]','恢复测试');js("document.querySelector('[aria-label=\"发送报告问题\"]').click()")
until("document.querySelector('[role=alert]')!==null");js('window.__jobsBeforeRetry=Object.keys(__chatJobs).length')
js("document.querySelector('[aria-label=\"发送报告问题\"]').click()")
check('retry after poll loss succeeds',until("!document.querySelector('[aria-label=\"发送报告问题\"]').disabled"))
check('retry creates no second paid job',js('Object.keys(__chatJobs).length===__jobsBeforeRetry'))
js('__failPoll=true');fill('[aria-label="报告追问"]','为什么');js("document.querySelector('[aria-label=\"发送报告问题\"]').click()")
until("document.querySelector('[role=alert]')!==null");js("window.__oldPending=__calls.filter(c=>c.p==='/chat-jobs').at(-1).b.request_id")
click('新建对话');fill('[aria-label="报告追问"]','为什么');js("document.querySelector('[aria-label=\"发送报告问题\"]').click()")
check('same question in new conversation completes',until("!document.querySelector('[aria-label=\"发送报告问题\"]').disabled"))
check('new conversation never restores old snapshot',js("__calls.filter(c=>c.p==='/chat-jobs').at(-1).b.request_id!==__oldPending&&__calls.filter(c=>c.p==='/chat-jobs').at(-1).b.messages.length===1"))
js("(()=>{const s=document.querySelector('label select');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(s,'theme');s.dispatchEvent(new Event('change',{bubbles:true}));})()")
fill('[aria-label="报告追问"]','解释题材');js("document.querySelector('[aria-label=\"发送报告问题\"]').click()")
check('long report section can be questioned',until("!document.querySelector('[aria-label=\"发送报告问题\"]').disabled"))
check('section truncation disclosed',js("__calls.filter(c=>c.p==='/chat-jobs').at(-1).b.context.includes('本节仅提供前7500字')&&document.body.textContent.includes('本次提供前7500字')"))
js('__hold=true;__cancelFail=true');fill('[aria-label="报告追问"]','取消失败测试');js("document.querySelector('[aria-label=\"发送报告问题\"]').click()")
until("[...document.querySelectorAll('button')].some(b=>b.textContent==='取消回答')");click('取消回答')
check('unconfirmed cancellation visible with retry',until("document.body.textContent.includes('取消尚未确认')&&document.body.textContent.includes('重试取消')"))
js('__cancelFail=false');click('重试取消');wait(.3)
check('retry cancellation reached exact job',js("__calls.filter(c=>c.p.endsWith('/cancel')).length>=2"))
capture_screenshot(str(out/'a3-report-chat-dark.png'),max_dim=1600)
(out/'browser-checks.json').write_text(json.dumps(checks,ensure_ascii=False,indent=2));print(json.dumps({'passed':sum(c['passed'] for c in checks),'total':len(checks)},ensure_ascii=False))
goto_url('about:blank');cdp('Page.removeScriptToEvaluateOnNewDocument',identifier=script['identifier'])
assert all(c['passed'] for c in checks)
