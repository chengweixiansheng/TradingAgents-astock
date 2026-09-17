import { useState } from 'react';
import { KeyRound } from 'lucide-react';
import { PageHeader } from '@/components/ui/PageHeader';
import { AgentAccess } from '@/components/AgentAccess';
import { AgentToggle } from '@/components/workspace/AgentToggle';
import { useWorkspace } from '@/lib/workspace/state';
import { loadAccessKey, saveAccessKey } from '@/lib/api';
import { toast } from 'sonner';
export function Settings() {
  const workspace = useWorkspace();
  const [accessKey, setAccessKey] = useState(loadAccessKey());
  return <div className="space-y-6">
    <PageHeader title="接入 AI" subtitle="选择一个来源，首页、复盘、深挖与页面问答共用。" />
    <section className="glass rounded-2xl p-5"><div className="mb-4 flex items-center justify-between"><h2 className="font-semibold">AI 来源</h2><AgentToggle /></div><AgentAccess onSaved={workspace.refresh} /></section>
    <p className="text-sm text-muted-foreground">旧版分散的 AI 设置不再用于产品调用。原有配置留在本机，没有自动迁移密钥或替换已保存来源。页面问答在 Agent 关闭时仅阅读本次明确提供的材料；开启后可查询公开资料。完整复盘与个股深挖由各自的任务按钮明确发起。</p>
    <details className="glass rounded-2xl p-5"><summary className="cursor-pointer text-sm font-medium">后端访问设置</summary><div className="mt-4 space-y-3"><h3 className="flex items-center gap-2 text-sm"><KeyRound size={16} />后端访问密钥（可选）</h3><p className="text-xs text-muted-foreground">仅当后端设置了访问密钥时填写，本机默认可留空。保存在本浏览器中，清理网站数据会移除；这不是 AI 服务商密钥。</p><div className="flex gap-2"><input type="password" value={accessKey} onChange={e=>setAccessKey(e.target.value)} className="min-w-0 flex-1 rounded-lg border border-border bg-card px-3 py-2" aria-label="后端访问密钥" /><button className="rounded-lg bg-primary px-4 py-2 text-primary-foreground" onClick={()=>{try { saveAccessKey(accessKey.trim()); workspace.refresh(); toast.success('已保存后端访问设置'); } catch(e) { toast.error(e instanceof Error ? e.message : '保存失败'); }}}>保存</button></div></div></details>
  </div>;
}
