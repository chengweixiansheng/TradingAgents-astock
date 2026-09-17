import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { FileText, ArrowUpRight } from 'lucide-react';
import { agentFetch } from '@/lib/agent';
export function RecentReports() {
  const [dates, setDates] = useState<string[]>([]);
  const [status, setStatus] = useState('正在读取最近报告…');
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let alive = true;
    setStatus('正在读取最近报告…');
    agentFetch<{ dates: string[] }>('/api/review/dates').then(data => {
      if (!Array.isArray(data.dates)) throw new Error('invalid dates');
      const items = [...new Set(data.dates.filter(d => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d)))].sort().reverse().slice(0, 5);
      if (alive) { setDates(items); setStatus(items.length ? '' : '还没有复盘报告，生成后会显示在这里。'); }
    }).catch(() => { if (alive) setStatus('最近报告读取失败，可重试；已保存报告不会受影响。'); });
    return () => { alive = false; };
  }, [revision]);
  return <section aria-labelledby="recent-reports-title" className="mt-7 border-t border-border pt-5">
    <div className="mb-3 flex items-center justify-between gap-3"><h2 id="recent-reports-title" className="text-lg font-bold">最近报告</h2><Link to="/agent/review" className="text-xs text-primary">查看全部复盘报告 →</Link></div>
    {status && <p role="status" className="text-sm text-muted-foreground">{status}{status.includes('失败') && <button onClick={() => setRevision(x => x + 1)} className="ml-3 min-h-10 text-primary">重试</button>}</p>}
    <div className="divide-y divide-border">{dates.map(date => <Link key={date} to={`/agent/review?date=${date}`} className="flex min-h-14 items-center gap-3 rounded px-2 py-3 hover:bg-muted/40"><FileText className="h-4 w-4 text-primary" /><span className="flex-1 text-sm">{date} · 复盘报告</span><ArrowUpRight className="h-4 w-4 text-muted-foreground" /></Link>)}</div>
  </section>;
}
