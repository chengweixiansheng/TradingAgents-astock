import { RecentReports } from '@/components/workspace/RecentReports';
import { useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { ArrowUpRight } from 'lucide-react';
import { WorkspaceChat } from '@/components/workspace/WorkspaceChat';
import { FEATURE_GROUPS } from '@/lib/workspace/features';
import { useWorkspace } from '@/lib/workspace/state';
/** Layout adapted from Research v1.1.0 Home; links retain the AStock domain. */
export function Home() {
  const state = useWorkspace();
  const offered = useRef(false);
  useEffect(() => {
    if (!offered.current && state.status === 'missing') { offered.current = true; state.connect(); }
  }, [state.status, state.connect]);
  return <div>
    <h1 className="sr-only">Vibe AStock 复盘工作台</h1>
    <WorkspaceChat />
    <section id="home-features" className="mt-5" aria-labelledby="feature-heading">
      <div className="mb-3 flex items-end justify-between gap-4"><div><p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-primary">Workbench</p><h2 id="feature-heading" className="mt-1 text-lg font-bold">复盘工具，一站直达</h2></div><span className="text-xs text-muted-foreground">常用功能</span></div>
      <div data-feature-grid className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
        {FEATURE_GROUPS.map((group, index) => <div key={group.title} data-feature-category className="glass min-w-0 rounded-xl border border-primary/20 p-3">
          <div className="mb-2 flex items-center gap-2 border-b border-primary/15 pb-2"><span className="text-[10px] font-medium text-primary">0{index + 1}</span><h3 className="text-[13px] font-semibold">{group.title}</h3></div>
          <div className="grid gap-1.5">{group.features.map(({ to, title, detail }) => <Link key={to} to={to} title={detail} className="group flex min-h-10 items-center gap-2 rounded-lg border border-border bg-muted/30 px-2.5 py-2 hover:border-primary/40 hover:bg-primary/[0.06]"><span className="min-w-0 flex-1 text-xs font-medium group-hover:text-primary">{title}</span><ArrowUpRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground group-hover:text-primary" /></Link>)}</div>
        </div>)}
      </div>
    </section>
    <RecentReports />
    <p className="mt-5 text-[11px] leading-5 text-muted-foreground">AI 生成内容仅供参考，不构成投资建议。数据缺口、样本口径和原始依据以各业务页面披露为准。</p>
  </div>;
}
