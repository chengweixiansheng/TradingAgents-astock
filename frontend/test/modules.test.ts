import test from 'node:test';
import assert from 'node:assert/strict';
import { MODULES, moduleFor, chatPageFor } from '../src/lib/workspace/modules.ts';
import { filterYesterdayTier } from '../src/lib/workspace/ladder.ts';
import { mergeStockCodes } from '../src/lib/workspace/stock-list.ts';
test('seven primary modules ordered as approved', () => {
  assert.deepEqual(MODULES.map(x => x.title), ['首页','盯盘','复盘','资讯雷达','个股研究','回测','我的股票']);
});
test('old deep links resolve to their parent, rather than becoming extra primary entries', () => {
  for (const route of ['/heat','/first-board','/backtest','/agent/review']) assert.equal(moduleFor(route)?.title, '复盘');
  assert.equal(moduleFor('/agent/intraday')?.title, '盯盘');
  assert.equal(moduleFor('/agent/deepdive')?.title, '个股研究');
  for (const route of ['/portfolio','/watchlist','/journal']) assert.equal(moduleFor(route)?.title, '我的股票');
  assert.equal(moduleFor('/settings'), undefined);
});
test('tier filter uses yesterday board count and retains losers and missing quotes', () => {
  const rows = [{ boards:1,pct:10 }, { boards:2,pct:-10 }, { boards:3,pct:null }, { boards:5,pct:-5 }];
  assert.deepEqual(filterYesterdayTier(rows, 3), rows.slice(2));
  assert.deepEqual(filterYesterdayTier(rows, 2), rows.slice(1));
  assert.deepEqual(filterYesterdayTier(rows, 1), rows);
});
test('holdings and watchlist overlap becomes one row without modifying either source', () => {
  const holds = [{code:'000001'}, {code:'000002'}], watch = ['000002','000003'];
  assert.deepEqual(mergeStockCodes(holds, watch), ['000001','000002','000003']);
  assert.deepEqual(watch, ['000002','000003']); assert.equal(holds.length, 2);
});

test('renamed navigation preserves legacy conversation and recovery identities', () => {
  const expected = {'/watch':'盯盘','/agent/review':'复盘看板','/agent/intraday':'盘中核验','/stock-data':'个股数据','/agent/deepdive':'个股深挖','/backtest':'涨停样本统计','/portfolio':'持仓股','/watchlist':'自选股'};
  for (const [route, identity] of Object.entries(expected)) assert.equal(chatPageFor(route), identity);
});

test('watch pages and retained legacy links belong to correct modules',()=>{for(const route of ['/daily-review','/watch','/yesterday-ladder']) assert.equal(moduleFor(route)?.title,'盯盘');assert.equal(moduleFor('/backtest-agent')?.title,'回测');});
