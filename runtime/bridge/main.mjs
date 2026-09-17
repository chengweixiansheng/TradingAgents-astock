/** Private NDJSON transport. One request per process; Python owns its process group. */
import readline from 'node:readline';
import { runLocalAgent, probeClaude, probeCodeBuddy, LocalAgentError } from './local_agent_runtime.ts';
const abort = new AbortController();
let started = false, settled = false;
const emit = (value) => process.stdout.write(JSON.stringify(value) + '\n');
const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on('line', async (line) => {
  if (started) { if (line === '{"cancel":true}') abort.abort(); return; }
  started = true;
  try {
    if (line.length > 150000) throw new Error('bad_request');
    const req = JSON.parse(line);
    if (req.protocol !== 1 || !['claude','codebuddy'].includes(req.agent)) throw new Error('bad_request');
    if (req.action === 'status') {
      emit({ type: 'result', status: await (req.agent === 'claude' ? probeClaude() : probeCodeBuddy()) });
    } else if (req.action === 'run') {
      if (typeof req.prompt !== 'string' || typeof req.system !== 'string' || !/^[\w./-]{1,100}$/.test(req.model)) throw new Error('bad_request');
      emit({ type: 'started' });
      const text = await runLocalAgent(req.agent, {userPrompt:req.prompt, systemPrompt:req.system,
        model:req.model, signal:abort.signal, timeoutMs:req.timeout * 1000, controlledMcp:req.mcp, env:process.env});
      emit({type:'result', text});
    } else throw new Error('bad_request');
  } catch (e) {
    // Never echo an OS/CLI/provider error, prompt, key or private path.
    emit({type:'failed', code:e instanceof LocalAgentError ? e.code : 'bridge_failed',
      message:e instanceof LocalAgentError ? e.message : '订阅运行桥未完成，请检查安装或连接设置'});
    process.exitCode = 1;
  } finally { settled = true; lines.close(); process.stdin.destroy(); }
});
lines.on('close', () => { if (started && !settled) abort.abort(); });
