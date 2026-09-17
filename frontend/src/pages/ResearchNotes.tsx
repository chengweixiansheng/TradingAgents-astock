import { useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { loadNotes, deleteNote, type Note } from '@/lib/notes';

export function ResearchNotes() {
  const [error, setError] = useState('');
  const [notes, setNotes] = useState<Note[]>(() => { try { return loadNotes(); } catch { return []; } });
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const current = notes.find(n => n.id === selected);
  const refresh = () => { try { setNotes(loadNotes()); setError(''); } catch (e) { setError(e instanceof Error ? e.message : '读取失败'); } };
  useEffect(refresh, []);
  const remove = (id: string) => {
    if (!window.confirm('确认删除这篇研究记录？此操作无法撤销。')) return;
    try { setNotes(deleteNote(id)); setSelected(null); } catch (e) { setError(e instanceof Error ? e.message : '删除失败'); }
  };
  const exportAll = () => {
    try {
      const data = loadNotes();
      const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], {type: 'application/json'}));
      const a = document.createElement('a'); a.href = url; a.download = 'astock-research-notes.json'; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) { setError(e instanceof Error ? e.message : '导出失败'); }
  };
  return <div className="space-y-4">
    <h1 className="text-2xl font-bold">研究记录</h1>
    <p className="text-sm text-muted-foreground">本浏览器保存的分析与问答 · 共 {notes.length} 篇 · 导出可另存备份</p>
    <div className="flex gap-3"><input aria-label="搜索研究记录" className="rounded-lg border border-border bg-card p-2" value={query} onChange={e => setQuery(e.target.value)} placeholder="搜索标题或正文" /><button onClick={refresh}>重新读取</button><button onClick={exportAll}>导出全部</button></div>
    {error && <p role="alert" className="text-danger">{error}</p>}
    <div className="grid gap-4 lg:grid-cols-[280px_1fr]">
      <div className="space-y-2">{notes.filter(n => `${n.title} ${n.content}`.includes(query)).map(n => <button key={n.id} onClick={() => setSelected(n.id)} className="block w-full rounded-xl border border-border bg-card p-3 text-left"><b>{n.title}</b><span className="block text-xs text-muted-foreground">{n.kind} · {new Date(n.ts).toLocaleString('zh-CN')}</span></button>)}{notes.length === 0 && <p>暂无记录；可在分析结果下点击“存入研究记录”。</p>}</div>
      {current ? <article className="rounded-xl border border-border bg-card p-5"><div className="mb-4 flex justify-between gap-3"><h2>{current.title}</h2><button className="text-danger" onClick={() => remove(current.id)}>删除</button></div><div className="prose prose-sm max-w-none dark:prose-invert"><ReactMarkdown remarkPlugins={[remarkGfm]}>{current.content}</ReactMarkdown></div></article> : <p className="text-muted-foreground">选择一篇记录阅读。</p>}
    </div>
  </div>;
}
