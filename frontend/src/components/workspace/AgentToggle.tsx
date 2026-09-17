import { useWorkspace } from '@/lib/workspace/state';
export function AgentToggle({ compact = false }: { compact?: boolean }) {
  const state = useWorkspace();
  return <div>
    <button type="button" role="switch" aria-label="开启Agent" aria-checked={state.enabled}
      aria-description="切换新对话模式。关闭时不调用工具，开启时可查询已有复盘证据。已有会话保留原模式。"
      title="新对话使用所选模式；已有会话保留原模式。"
      onClick={state.toggle} className="inline-flex min-h-6 items-center justify-center gap-2 rounded-md text-[10px] leading-4 text-muted-foreground hover:text-foreground">
      {!compact && <span className="whitespace-nowrap">开启Agent</span>}
      <span aria-hidden="true" className={`inline-flex h-4 w-7 shrink-0 items-center rounded-full border ${state.enabled ? 'border-primary bg-primary' : 'border-muted-foreground/40 bg-muted'}`}>
        <span className={`h-2.5 w-2.5 rounded-full bg-white shadow-sm ${state.enabled ? 'translate-x-[14px]' : 'translate-x-[3px]'}`} />
      </span>
      {!compact && <span className="whitespace-nowrap text-[9px]">（更深入·较慢·费Token）</span>}
    </button>
    {state.error && <p role="alert" className="text-xs text-destructive">{state.error}</p>}
  </div>;
}
