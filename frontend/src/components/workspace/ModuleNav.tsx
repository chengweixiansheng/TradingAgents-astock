import { useEffect, useId, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { MODULES, moduleFor, navigationPath } from '@/lib/workspace/modules';
import { cn } from '@/lib/utils';

/** Sidebar disclosure groups; links retain their existing route and chat identity. */
export function ModuleNav({ compact, expandSidebar, navigate }: {
  compact: boolean;
  expandSidebar: () => void;
  navigate: () => void;
}) {
  const { pathname, search } = useLocation();
  const active = moduleFor(pathname);
  const id = useId();
  const [expanded, setExpanded] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(MODULES.map(module => [module.to, true])));
  // A deep link or a home shortcut reveals its destination even if previously folded.
  useEffect(() => {
    if (active) setExpanded(previous => ({ ...previous, [active.to]: true }));
  }, [pathname, active]);
  const symbol = active?.title === '个股研究' ? new URLSearchParams(search).get('symbol') : null;
  return <>{MODULES.map(({ to, title, icon: Icon, pages }, index) => {
    const selected = active?.to === to;
    const groupId = `${id}-module-${index}`;
    const open = !compact && expanded[to];
    const classes = cn('workspace-nav-link flex w-full items-center text-[13px] text-muted-foreground hover:bg-muted/50 hover:text-foreground',
      compact ? 'justify-center p-2.5' : 'gap-3 px-3 py-2.5');
    if (pages.length === 1) return <Link key={to} to={to} onClick={navigate} aria-label={title} title={title}
      aria-current={selected ? 'page' : undefined} className={classes}>
      <Icon className="h-4 w-4 shrink-0" />{!compact && <span>{title}</span>}
    </Link>;
    return <div key={to}>
      <button type="button" aria-label={title} title={`${open ? '收起' : '展开'}${title}`} aria-expanded={!!open}
        aria-controls={groupId} aria-current={compact && selected ? 'page' : undefined} onClick={() => {
          if (compact) { setExpanded(previous => ({ ...previous, [to]: true })); expandSidebar(); }
          else setExpanded(previous => ({ ...previous, [to]: !previous[to] }));
        }} className={cn(classes, selected && 'font-medium text-primary')}>
        <Icon className="h-4 w-4 shrink-0" />{!compact && <>
          <span className="flex-1 text-left">{title}</span>
          <svg aria-hidden="true" viewBox="0 0 12 12" className={cn('h-3 w-3 shrink-0 transition-transform motion-reduce:transition-none', open && 'rotate-90')} fill="currentColor"><path d="M4 2 9 6 4 10Z" /></svg>
        </>}
      </button>
      <ul id={groupId} hidden={!open} aria-label={`${title}二级栏目`} className="mb-2 ml-5 space-y-0.5 border-l border-border pl-2">
        {pages.map(page => <li key={page.to}><Link
          to={page.to + (title === '个股研究' && symbol ? `?symbol=${encodeURIComponent(symbol)}` : '')}
          onClick={navigate} aria-current={navigationPath(pathname) === page.to ? 'page' : undefined}
          className="workspace-nav-link flex items-center px-3 py-2 text-xs leading-5 text-muted-foreground hover:bg-muted/50 hover:text-foreground">
          {page.title}
        </Link></li>)}
      </ul>
    </div>;
  })}</>;
}
