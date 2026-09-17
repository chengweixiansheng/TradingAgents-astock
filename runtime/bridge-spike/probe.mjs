// Candidate Research process transport -> existing Python MCP, without an LLM.
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runResearchProcess } from './research_process.ts';
const repo = fileURLToPath(new URL('../../', import.meta.url));
const env = { PATH: process.env.PATH || '', LANG: 'en_US.UTF-8', PYTHONPATH: repo };
let output = '';
const result = await runResearchProcess(path.join(repo, '.venv/bin/python'), ['runtime/bridge-spike/mcp_probe.py'], {
  cwd: repo, env, timeout: 30000, maxBuffer: 1024 * 1024, onStdout: chunk => { output += chunk; },
});
assert.equal(result.status, 0, result.stderr);
assert.equal(result.error, undefined);
assert.equal(JSON.parse(output).valid_submission, true);
console.log(output.trim());
