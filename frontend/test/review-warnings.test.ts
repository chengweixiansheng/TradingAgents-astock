import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewWarningMessages } from '../src/lib/review-warnings.ts';

test('legacy missing-key pair becomes one historical data diagnosis', () => {
  const warnings=['题材串：数据缺失，本次复盘少了这一路','[⚠️ 题材涨停原因｜2026-09-04 数据获取失败已降级：涨停原因题材串未取到：没配问财接口密钥 IWENCAI_API_KEY，取不到涨停原因]'];
  const before=[...warnings];const result=reviewWarningMessages(warnings);
  assert.equal(result.length,1);assert.match(result[0],/生成这份报告时未配置问财/);
  assert.doesNotMatch(result[0],/IWENCAI_API_KEY/);assert.deepEqual(warnings,before);
});
test('missing theme alone or source timeout is never classified as missing credentials', () => {
  const warnings=['题材串：数据缺失，本次复盘少了这一路','涨停原因：源站超时','问财 IWENCAI_API_KEY 配置存在，但鉴权失败','问财 IWENCAI_API_KEY 有效，但返回数据缺失'];
  assert.deepEqual(reviewWarningMessages(warnings),warnings);
});
test('other data gaps remain visible alongside the missing-key diagnosis', () => {
  const result=reviewWarningMessages(['未配置 IWENCAI_API_KEY','龙虎榜数据未取到']);
  assert.equal(result.length,2);assert.equal(result[1],'龙虎榜数据未取到');
});
