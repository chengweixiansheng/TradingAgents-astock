import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import vm from 'node:vm';
import ts from 'typescript';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
const require=createRequire(import.meta.url);
const source=readFileSync(new URL('../src/pages/Journal.tsx',import.meta.url),'utf8');
const compiled=ts.transpileModule(source+'\nexport {RiskRulesPanel,RiskPanel,FeeConfig};',{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText;
const helpers={safeRecord:(v:unknown)=>v&&typeof v==='object'?v:{},safeArray:(v:unknown)=>Array.isArray(v)?v:[],ratioPct:()=>'',finite:()=>false};
const context:any={exports:{},require:(name:string)=> name==='react'||name==='react/jsx-runtime'?require(name):name==='@/lib/agent'?helpers:name==='@/lib/utils'?{cn:()=>''}:new Proxy({},{get:()=>()=>null})};
vm.runInNewContext(compiled,context);
test('partial risk checks display the missing scope while retaining confirmed violations',()=>{
 const html=renderToStaticMarkup(React.createElement(context.exports.RiskRulesPanel,{onSaved:()=>{},value:{available:true,rule_status:{max_positions:'unavailable：缺平仓日期；已确认超限仍展示'},violation_count:1,violations:[{date:'2026-09-08',label:'最多同时持仓',detail:'同时持有4只',limit:3}]}}));
 assert.match(html,/核对范围不足/);assert.match(html,/同时持有4只/);assert.doesNotMatch(html,/没有违反记录/);
});
test('missing account denominator cannot render an unconditional clean bill',()=>{
 const html=renderToStaticMarkup(React.createElement(context.exports.RiskRulesPanel,{onSaved:()=>{},value:{available:true,rule_status:{max_loss_per_day_pct:'unavailable：没填账户规模'},violation_count:0}}));
 assert.match(html,/没填账户规模/);assert.match(html,/缺资料的规则不能据此认定通过/);
});
test('rules remain accessible before any closed trade produces an equity curve',()=>{
 const html=renderToStaticMarkup(React.createElement(context.exports.RiskPanel,{revision:0}));
 assert.match(html,/你自己的规则/);assert.match(html,/改我的规则/);
});

test('fee configuration is visible while loading rather than silently disappearing',()=>{
 const html=renderToStaticMarkup(React.createElement(context.exports.FeeConfig,{onSaved:async()=>{}}));
 assert.match(html,/交易费率/);assert.match(html,/正在读取费率/);
});
