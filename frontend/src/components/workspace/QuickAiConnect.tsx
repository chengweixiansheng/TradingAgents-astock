import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, Sparkles, Terminal, X } from 'lucide-react';
import { SUBSCRIPTIONS } from '@/lib/workspace/features';
import { useWorkspace } from '@/lib/workspace/state';
import { Dialog } from './Dialog';
import { AgentAccess } from '@/components/AgentAccess';
export function QuickAiConnect() {
  const state = useWorkspace();
  const [accessBusy,setAccessBusy]=useState(false);
  const [selected, setSelected] = useState('');
  return <Dialog titleId="quick-ai-title" close={()=>{if(!accessBusy)state.closeConnect();}} className="max-w-xl max-h-[90dvh] overflow-auto">
    <div className="p-6 sm:p-7">
      <div className="flex items-start justify-between gap-3">
        <span className="rounded-xl border border-primary/20 bg-primary/10 p-3 text-primary"><Sparkles className="h-6 w-6" /></span>
        <button type="button" disabled={accessBusy} onClick={state.closeConnect} aria-label="暂不接入，先浏览" className="rounded-lg p-2 text-muted-foreground hover:bg-muted"><X className="h-4 w-4" /></button>
      </div>
      <h2 id="quick-ai-title" className="mt-5 text-2xl font-semibold">请接入AI</h2>
      <p className="mt-2 text-sm leading-6 text-muted-foreground">使用已有订阅，或连接自己的模型 API。</p>
      <p className="mt-2 text-xs leading-5 text-muted-foreground">先检测所选来源，再显式测试连接。通过后首页、复盘和追问共用该来源。</p>
      <div className="mt-6 space-y-2">
        {SUBSCRIPTIONS.map(option => <button key={option.id} type="button" data-connect-provider={option.id}
          disabled={accessBusy} onClick={() => setSelected(option.id)}
          className="group flex w-full items-center gap-3 rounded-xl border border-border bg-muted/20 p-4 text-left hover:border-primary/50 hover:bg-primary/5">
          <Terminal className="h-5 w-5 shrink-0 text-primary" /><span className="min-w-0 flex-1"><span className="block text-sm font-semibold">{option.label}</span><span className="mt-1 block text-xs leading-5 text-muted-foreground">{option.detail}</span></span><ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground" />
        </button>)}
      </div>
      <p className="mt-3 text-[11px] leading-5 text-muted-foreground">正式连接测试会使用少量所选服务额度。浏览、检测状态和关闭弹窗不触发模型测试。</p>
      <button type="button" disabled={accessBusy} onClick={() => setSelected('deepseek')} className="mt-3 w-full rounded-xl border border-border p-3 text-left text-sm">连接 API · DeepSeek、通义、Kimi 等</button>
      {accessBusy && <p role="status" className="mt-3 text-xs text-muted-foreground">连接正在进行，请等待结果；需要退出时先取消测试。</p>}
      {selected && <div className="mt-4"><AgentAccess key={selected} initialProvider={selected} onSaved={state.refresh} onBusyChange={setAccessBusy} /></div>}
      <Link to="/settings" aria-disabled={accessBusy} onClick={event=>{if(accessBusy)event.preventDefault();else state.closeConnect();}} className="mt-5 flex items-center justify-between rounded-xl border border-border px-4 py-3 text-sm hover:bg-muted/50"><span>其他接入方式<span className="mt-1 block text-xs text-muted-foreground">所有来源与连接状态</span></span><ArrowRight className="h-4 w-4" /></Link>
    </div>
  </Dialog>;
}
