import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { subscriptionStatus, connectionLabel } from '../src/lib/workspace/status.ts';
import { FEATURE_GROUPS, FEATURES } from '../src/lib/workspace/features.ts';

test('preserve approved feature groups, merged stocks and research notes', () => {
  assert.equal(FEATURE_GROUPS.length, 5);
  const expected = ['/agent/review','/daily-review','/first-board','/heat','/watch','/agent/intraday','/stock-data','/agent/deepdive','/intel','/my-stocks','/notes','/journal','/backtest','/settings'];
  assert.deepEqual(FEATURES.map(x => x.to).sort(), expected.sort());
  const routes = fs.readFileSync(new URL('../src/router.tsx', import.meta.url), 'utf8');
  for (const route of expected) assert.ok(routes.includes(`path: "${route}"`));
  assert.ok(routes.includes('{ path: "/", element: <Home /> }'));
  assert.equal(FEATURES.find(x => x.to === '/backtest')?.title, '涨停样本统计');
});
for (const [name, input, status] of [
  ['local login only', { installed: true, subscription_ready: true, models_error: '' }, 'authenticated'],
  ['catalog/network failure despite local login', { installed: true, subscription_ready: true, models_error: 'network failed' }, 'error'],
  ['engine missing', { installed: false, subscription_ready: false, models_error: '' }, 'uninstalled'],
  ['logged out', { installed: true, subscription_ready: false, models_error: '' }, 'invalid'],
  ['missing fields', { subscription_ready: true }, 'error'],
  ['wrong shapes', { installed: 'yes', subscription_ready: 'true', models_error: '' }, 'error'],
  ['null response', null, 'error'],
] as const) test(`read-only source state: ${name}`, () => assert.equal(subscriptionStatus(input), status));
test('read-only authentication and saved API never claim verified connection', () => {
  assert.match(connectionLabel('authenticated', 'Codex订阅版'), /连接待实测/);
  assert.match(connectionLabel('saved', 'MiMo API'), /待实测/);
  assert.doesNotMatch(connectionLabel('uninstalled', ''), /登录失效/);
});
test('past probe success is disclosed without overriding current failures', () => {
  assert.match(connectionLabel('authenticated', 'Codex', true), /此前连接实测通过/);
  assert.match(connectionLabel('saved', 'API', true), /此前连接实测通过/);
  for (const status of ['missing', 'checking', 'invalid', 'uninstalled', 'error'] as const) {
    assert.equal(connectionLabel(status, 'Codex', true), connectionLabel(status, 'Codex'));
  }
});
