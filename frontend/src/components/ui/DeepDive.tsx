// 「AI 深入分析」共享单元：行内展开的流式分析面板（首板分析 / 每日复盘连板表共用）。
// useDeepDive 管理展开态 + 流式请求 + 本地存档 + 一键全部分析；DeepDivePanel 渲染表格内的展开行。
// 存档只存本地 localStorage（与研究记录同体系，不上传、不进仓库），按「日期|页面|代码」为键，
// 自动保留本次写入日与其他最近 4 个交易日 —— 分析过的股票刷新页面后按钮变「展开」，不再重复花模型调用。
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Loader2, RefreshCw, Sparkles } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { SaveNoteButton } from "@/components/ui/SaveNoteButton";
import { hasLlm, chatStream } from "@/lib/llm";
import { readMode } from "@/lib/workspace/state";

const TOOL_LABEL: Record<string, string> = {
  query_quote: "查行情",
  query_valuation: "查估值",
  query_reports: "查研报",
  query_news: "查新闻",
  query_global_stock: "查外盘",
};

// ---------- 本地存档 ----------
const STORE_KEY = "vr-deepdive";
const KEEP_DAYS = 5; // 当前写入日优先，历史回看不能刚保存就被淘汰

interface DiveRecord {
  text: string;
  tools: string[];
  ts: number;
}

type Store = Record<string, DiveRecord>; // key = `${date}|${ns}|${code}`

function loadStore(): Store {
  try {
    const v = JSON.parse(localStorage.getItem(STORE_KEY) || "{}");
    if (!v || typeof v !== "object" || Array.isArray(v)) return {};
    return Object.fromEntries(Object.entries(v).filter(([, r]) =>
      r && typeof r === "object" && typeof (r as DiveRecord).text === "string" &&
      Array.isArray((r as DiveRecord).tools) && (r as DiveRecord).tools.every(t => typeof t === "string"))) as Store;
  } catch {
    return {};
  }
}

function persistStore(store: Store, day: string) {
  // 清理：按 key 前缀日期，只保留最近 KEEP_DAYS 个交易日
  const dates = [...new Set(Object.keys(store).map((k) => k.split("|")[0]))].sort().reverse();
  const keep = new Set([day, ...dates.filter(d => d !== day).slice(0, KEEP_DAYS - 1)]);
  const next: Store = {};
  for (const [k, v] of Object.entries(store)) {
    if (keep.has(k.split("|")[0])) next[k] = v;
  }
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(next));
  } catch {
    throw new Error("分析已生成，但本机存储空间不足，未能存档；请先复制结果保存。");
  }
}

const normDate = (d: string) => d.split("-").join(""); // '2026-07-15' / '20260715' → '20260715'

// ---------- hook ----------
export interface DiveItem {
  key: string;      // 一般用股票代码
  prompt: string;
  context: string;
}

export interface DeepDiveState {
  open: string | null;
  analysis: Record<string, string>;
  completed: Record<string, boolean>;
  tools: Record<string, string[]>;
  running: string | null;
  aiErr: string | null;
  needConfig: boolean;
  batch: { done: number; total: number; current: string } | null; // 一键全部分析进度
  toggle: (item: DiveItem) => void;
  rerun: (item: DiveItem) => void;
  runAll: (items: DiveItem[]) => void;
  stopAll: () => void;
}

export function useDeepDive(ns: string, date: string): DeepDiveState {
  const [open, setOpen] = useState<string | null>(null);
  const [analysis, setAnalysis] = useState<Record<string, string>>({});
  const [completed, setCompleted] = useState<Record<string, boolean>>({});
  const completedRef = useRef<Record<string, boolean>>({});
  const batchActive = useRef(false);
  const epoch = useRef(0);
  const [tools, setTools] = useState<Record<string, string[]>>({});
  const [running, setRunning] = useState<string | null>(null);
  const [aiErr, setAiErr] = useState<string | null>(null);
  const [needConfig, setNeedConfig] = useState(false);
  const [batch, setBatch] = useState<DeepDiveState["batch"]>(null);
  const acRef = useRef<AbortController | null>(null);
  const batchStopRef = useRef(false);
  const day = normDate(date);

  // 日期就绪/变化时：载入该日该页面的存档
  useEffect(() => {
    epoch.current += 1;
    batchStopRef.current = true;
    acRef.current?.abort();
    batchActive.current = false;
    setBatch(null);
    setAnalysis({}); setTools({}); completedRef.current = {}; setCompleted({});
    if (!day) return;
    const store = loadStore();
    const prefix = `${day}|${ns}|`;
    const a: Record<string, string> = {};
    const t: Record<string, string[]> = {};
    for (const [k, v] of Object.entries(store)) {
      if (k.startsWith(prefix)) {
        const code = k.slice(prefix.length);
        a[code] = v.text;
        t[code] = v.tools;
      }
    }
    completedRef.current = Object.fromEntries(Object.keys(a).filter(k => a[k]?.trim()).map(k => [k, true]));
    setCompleted(completedRef.current);
    setAnalysis(a);
    setTools(t);
  }, [ns, day]);

  useEffect(() => () => { batchStopRef.current = true; acRef.current?.abort(); }, []);

  const saveRecord = (code: string, text: string, toolList: string[]) => {
    if (!day || !text.trim()) return;
    const store = loadStore();
    store[`${day}|${ns}|${code}`] = { text, tools: toolList, ts: Date.now() };
    persistStore(store, day);
  };

  /** 跑一只。expand=true 时展开面板（单只点击）；批量模式传 false 只后台跑。成功返回 true。 */
  const start = async (item: DiveItem, expand: boolean): Promise<boolean> => {
    setAiErr(null);
    setNeedConfig(false);
    if (!day) { setOpen(item.key); setAiErr("交易日期尚未就绪，请等待数据加载"); return false; }
    if (expand) setOpen(item.key);
    if (!hasLlm()) {
      setNeedConfig(true);
      if (!expand) setOpen(item.key); // 批量时也把配置提示亮出来
      return false;
    }
    acRef.current?.abort();
    const ac = new AbortController();
    acRef.current = ac;
    setRunning(item.key);
    completedRef.current = { ...completedRef.current, [item.key]: false };
    setCompleted(completedRef.current);
    setAnalysis((m) => ({ ...m, [item.key]: "" }));
    setTools((m) => ({ ...m, [item.key]: [] }));
    let text = "";
    let toolList: string[] = [];
    try {
      await chatStream([{ role: "user", content: item.prompt }], item.context, {
        onDelta: (t) => {
          if (ac.signal.aborted) return;
          text += t;
          setAnalysis((m) => ({ ...m, [item.key]: (m[item.key] || "") + t }));
        },
        onTool: (tool) => {
          if (ac.signal.aborted) return;
          const label = TOOL_LABEL[tool] || tool;
          if (!toolList.includes(label)) toolList = [...toolList, label];
          setTools((m) => ({ ...m, [item.key]: toolList }));
        },
      }, ac.signal);
      if (ac.signal.aborted) return false;
      if (!text.trim()) throw new Error("模型没有返回分析内容，请重试");
      saveRecord(item.key, text, toolList);
      completedRef.current = { ...completedRef.current, [item.key]: true };
      setCompleted(completedRef.current);
      return true;
    } catch (e) {
      if (!ac.signal.aborted) {
        setAiErr(e instanceof Error ? e.message : "分析失败");
        setOpen(item.key);
      }
      return false;
    } finally {
      if (acRef.current === ac) setRunning(null);
    }
  };

  const toggle = (item: DiveItem) => {
    if (open === item.key) {
      if (running === item.key) acRef.current?.abort();
      setOpen(null);
      return;
    }
    setAiErr(null);
    setNeedConfig(false);
    if (completedRef.current[item.key]) {
      setOpen(item.key); // 已有结果（本次会话或存档），展开即可
      return;
    }
    if (batchActive.current) { setOpen(item.key); return; }
    void start(item, true);
  };

  /** 一键全部分析：串行队列（兼容 CLI 订阅通道，不并发），跳过已分析的，可随时停止。 */
  const runAll = async (items: DiveItem[]) => {
    if (batchActive.current || running) return;
    const todo = items.filter((it) => !completedRef.current[it.key]);
    if (todo.length === 0) return;
    if (!hasLlm()) {
      setNeedConfig(true);
      if (todo[0]) setOpen(todo[0].key);
      return;
    }
    batchActive.current = true;
    batchStopRef.current = false;
    const generation = epoch.current;
    let done = 0;
    for (const it of todo) {
      if (batchStopRef.current || generation !== epoch.current) break;
      setBatch({ done, total: todo.length, current: it.key });
      const ok = await start(it, false);
      // 出错立即暂停，保留已成功的进度；重试不会跳过失败的半段文本。
      if (!ok || generation !== epoch.current) break;
      done += 1;
      setBatch({ done, total: todo.length, current: "" });
    }
    if (generation === epoch.current) {
      batchActive.current = false;
      setBatch(null);
    }
  };

  const stopAll = () => {
    epoch.current += 1;
    batchActive.current = false;
    batchStopRef.current = true;
    acRef.current?.abort();
    setBatch(null);
    setRunning(null);
  };

  return {
    open, analysis, completed, tools, running, aiErr, needConfig, batch,
    toggle,
    rerun: (item) => { if (!batchActive.current) void start(item, true); },
    runAll: (items) => void runAll(items),
    stopAll,
  };
}

// ---------- 表格内展开行 ----------
interface PanelProps {
  dd: DeepDiveState;
  stockKey: string;
  colSpan: number;
  noteTitle: string; // 存研究记录的标题
  onRerun: () => void;
}

export function DeepDivePanel({ dd, stockKey, colSpan, noteTitle, onRerun }: PanelProps) {
  const text = dd.analysis[stockKey] || "";
  const isRunning = dd.running === stockKey;
  return (
    <tr className="border-b border-border/30 bg-primary/[0.03]">
      <td colSpan={colSpan} className="px-3 py-3">
        {dd.needConfig ? (
          <p className="text-sm text-muted-foreground">
            还没接入 AI —— 先去 <Link to="/settings" className="text-primary underline">接入 AI</Link> 页配置一次（订阅 CLI 或 API key），回来即可一键深入分析。
          </p>
        ) : (
          <div>
            <div className="mb-1.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
              <Sparkles className="h-3.5 w-3.5 text-primary" />
              AI 深入分析（由你配置的模型给出，非本产品观点，不构成投资建议）
              {(dd.tools[stockKey] || []).map((t) => (
                <span key={t} className="rounded-full border border-secondary/40 bg-secondary/10 px-2 py-0.5">{t}</span>
              ))}
              {isRunning && <Loader2 className="h-3 w-3 animate-spin" />}
              {!isRunning && text && dd.completed[stockKey] && (
                <>
                  <button
                    onClick={onRerun}
                    className="inline-flex items-center gap-1 rounded border border-border/60 px-1.5 py-0.5 hover:text-foreground"
                  >
                    <RefreshCw className="h-3 w-3" /> 重新分析
                  </button>
                  <SaveNoteButton kind="问AI" title={noteTitle} content={text} />
                </>
              )}
            </div>
            {dd.aiErr && dd.open === stockKey && <p className="mb-1 text-xs text-danger">{dd.aiErr}</p>}
            {!isRunning && text && !dd.completed[stockKey] && <p className="text-xs text-danger">本次分析未完整完成或未存档，不能作为已完成研究；可重新分析。</p>}
            {dd.batch && !text && !isRunning && <p className="text-xs text-muted-foreground">批量分析排队中…</p>}
            <div className="prose prose-sm prose-invert max-w-none text-foreground">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {text || (isRunning ? (readMode() ? "正在分析，实际查询记录将显示在上方…" : "正在阅读已提供资料并整理回答…") : "")}
              </ReactMarkdown>
            </div>
          </div>
        )}
      </td>
    </tr>
  );
}

// ---------- 一键全部分析按钮（带进度/停止） ----------
interface RunAllProps {
  dd: DeepDiveState;
  items: DiveItem[];
  nameOf?: (key: string) => string; // 进度里显示名称（默认显示 key）
}

export function RunAllButton({ dd, items, nameOf }: RunAllProps) {
  const remaining = items.filter((it) => !dd.completed[it.key]).length;
  if (!items.length) return null;
  if (dd.batch) {
    return (
      <span className="inline-flex items-center gap-2 text-xs text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
        批量分析中 {dd.batch.done}/{dd.batch.total}
        {dd.batch.current && <>· {nameOf ? nameOf(dd.batch.current) : dd.batch.current}</>}
        <button
          onClick={dd.stopAll}
          className="rounded border border-border/60 px-1.5 py-0.5 hover:text-foreground"
        >
          停止
        </button>
      </span>
    );
  }
  return (
    <button
      onClick={() => dd.runAll(items)}
      disabled={remaining === 0 || !!dd.running}
      className="inline-flex items-center gap-1 rounded-lg border border-primary/50 bg-primary/10 px-2.5 py-1 text-xs font-medium text-primary transition-colors hover:bg-primary/20 disabled:cursor-not-allowed disabled:opacity-40"
    >
      <Sparkles className="h-3 w-3" />
      {remaining === 0 ? "已全部分析" : `一键全部分析（剩 ${remaining} 只）`}
    </button>
  );
}
