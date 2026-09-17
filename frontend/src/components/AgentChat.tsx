import { randomId } from "@/lib/random-id";
import { useEffect, useRef, useState } from "react";
import { Send, Loader2, MessageCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { chatStream, type ChatMsg } from "@/lib/llm";
import { useWorkspace } from "@/lib/workspace/state";

interface Props {
  context: string;
  placeholder?: string;
  suggestions?: string[];
}

export function AgentChat({ context, placeholder = "就上面的结论追问…", suggestions = [] }: Props) {
  const workspace = useWorkspace();
  const active = useRef<AbortController | null>(null);
  const sessionId = useRef(randomId());
  useEffect(() => () => active.current?.abort(), []);
  const [msgs, setMsgs] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function send(q?: string) {
    const text = (q ?? input).trim();
    if (!text || loading || active.current) return;
    const controller = new AbortController(); active.current = controller;
    const next: ChatMsg[] = [...msgs, { role: "user", content: text }];
    setMsgs(next);
    setInput("");
    setLoading(true); setError("");
    try {
      const r = await chatStream(next, context, {sessionId:sessionId.current}, controller.signal);
      if (!controller.signal.aborted) setMsgs([...next, { role: "assistant", content: r.content }]);
    } catch (e) {
      if (!controller.signal.aborted) { setMsgs(msgs); setError(e instanceof Error ? e.message : "请求失败；可用原问题恢复"); setInput(current=>current||text); }
    }
    if (active.current === controller) { active.current = null; setLoading(false); }
  }

  return (
    <section>
      <div className="mb-2 flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-[0.2em] text-primary">
        <MessageCircle className="h-3.5 w-3.5" /> 追问 · Ask
      </div>
      <p className="mb-2 text-xs text-muted-foreground">解释当前打开的报告，使用统一保存的 AI 来源。{workspace.enabled ? "本次可查询公开资料。" : "本次只读这份材料；如需查询新资料，请开启 Agent。"}</p>
      <p className="mb-2 text-xs text-muted-foreground">每次最多带入最近五轮，较长的历史消息会明确节选。</p>
      <button disabled={loading} onClick={()=>{sessionId.current=randomId();setMsgs([]);setError("");setInput("");}} className="mb-2 mr-2 rounded-lg border border-border px-3 py-1 text-sm">新建对话</button>
      {error && <p role="alert" className="mb-2 text-sm text-destructive">{error}</p>}
      {loading && <button onClick={()=>{active.current?.abort(); active.current=null;setLoading(false);}} className="mb-2 rounded-lg border border-border px-3 py-1 text-sm">取消回答</button>}
      <div className="glass rounded-2xl p-4">
        {msgs.length === 0 && suggestions.length > 0 && (
          <div className="mb-3 flex flex-wrap gap-2">
            {suggestions.map((s, i) => (
              <button key={i} onClick={() => setInput(s)}
                className="rounded-full border border-border bg-muted/40 px-3 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground">
                {s}
              </button>
            ))}
          </div>
        )}
        {msgs.length > 0 && (
          <div className="mb-3 space-y-3">
            {msgs.map((m, i) => (
              <div key={i} className={cn("flex", m.role === "user" ? "justify-end" : "justify-start")}>
                <div className={cn("max-w-[85%] whitespace-pre-wrap rounded-2xl px-3.5 py-2 text-sm leading-relaxed",
                  m.role === "user" ? "bg-primary text-primary-foreground" : "bg-muted text-foreground")}>
                  {m.content}
                </div>
              </div>
            ))}
            {loading && <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> 思考中…</div>}
          </div>
        )}
        <div className="flex items-center gap-2">
          <input aria-label="报告追问" value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => e.key === "Enter" && !e.nativeEvent.isComposing && send()}
            placeholder={placeholder}
            className="flex-1 rounded-lg border border-border bg-card px-3 py-2 text-sm" />
          <button aria-label="发送报告问题" onClick={() => send()} disabled={loading}
            className="flex items-center gap-1 rounded-lg bg-primary px-3.5 py-2 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50">
            <Send className="h-4 w-4" />
          </button>
        </div>
      </div>
    </section>
  );
}
