import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import ts from 'typescript';
import { beijingTime } from '../src/lib/time-display.ts';
function idModule(crypto?: unknown) {
 const code=ts.transpileModule(fs.readFileSync(new URL('../src/lib/random-id.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 const ctx={exports:{},crypto};vm.runInNewContext(code,ctx);return ctx.exports as {randomId:()=>string};
}
test('request creation survives HTTP without randomUUID',()=>{
 const m=idModule({getRandomValues:(bytes:Uint8Array)=>bytes.fill(12)});
 assert.match(m.randomId(),/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
 assert.equal(idModule().randomId().replace(/-/g,'').length,32);
});
test('quote and timezone timestamps are readable without guessing ambiguous source time',()=>{
 assert.equal(beijingTime('20260908161444'),'2026-09-08 16:14:44 北京时间');
 assert.match(beijingTime('2026-09-08T08:00:00Z'),/16:00/);
 assert.equal(beijingTime('2026-09-08 16:00'),'2026-09-08 16:00（原文时间）');
});

test('watch capacity and blocked storage retain the previous list',()=>{
 const code=ts.transpileModule(fs.readFileSync(new URL('../src/lib/watchlist.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 let writes=0;
 const ctx={exports:{},localStorage:{getItem:()=>JSON.stringify(['600000']),setItem:()=>{writes++;throw Error('quota');}}};
 vm.runInNewContext(code,ctx);
 const m=ctx.exports as {loadWatch:()=>string[],saveWatch:(s:string[])=>void,addCodes:(s:string[],raw:string)=>unknown};
 assert.throws(()=>m.addCodes(Array.from({length:100},(_,i)=>String(i).padStart(6,'0')),'600000'),/最多100/);
 assert.equal(writes,0);
 assert.throws(()=>m.saveWatch(['600000','600001']),/未保存/);
 assert.equal(m.loadWatch().join(','),'600000');
});

test('monitor registration failure cannot hide other quotes or retry every poll',async()=>{
 const code=ts.transpileModule(fs.readFileSync(new URL('../src/lib/api.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 const calls:string[]=[];
 const ctx={exports:{},Date,localStorage:{getItem:()=>null},require:(name:string)=>name==='./base'?{apiUrl:(p:string)=>p}:{randomId:()=> 'a'.repeat(32)},fetch:async(path:string,opts:any)=>{
   calls.push(opts.method);
   return opts.method==='POST'?{ok:false,status:400,json:async()=>({detail:'名单已满'})}:{ok:true,status:200,json:async()=>({holdings:[{code:'600000'}],alerts:[]})};
 }};
 vm.runInNewContext(code,ctx);
 const m=ctx.exports as {api:{monitorSnapshot:(s:string)=>Promise<any>}};
 const watch=Array.from({length:101},(_,i)=>String(i).padStart(6,'0')).join(',');
 for(let i=0;i<2;i++){
   const snap=await m.api.monitorSnapshot(watch);
   assert.equal(snap.holdings[0].code,'600000');
   assert.match(snap.watch_warning,/名单已满/);
 }
 assert.equal(calls.join(','),'POST,GET,GET');
});

test('near-term events retain date-only settlements and exclude ambiguous timestamps',async()=>{
 const {closesWithin30Days}=await import('../src/lib/time-display.ts');
 const now=Date.parse('2026-09-09T00:00:00Z');
 for(const date of ['2026-09-09','2026-09-16','2026-10-09','2026-09-16T00:00:00Z'])assert.equal(closesWithin30Days(date,now),true,date);
 for(const date of ['2026-09-08','2026-10-10','2026-02-30','unknown','2026-09-16 12:00'])assert.equal(closesWithin30Days(date,now),false,date);
});

test('page question includes every panel within the API material limit',async()=>{
 const {pageMaterials}=await import('../src/lib/page-materials.ts');
 const blocks=Object.fromEntries(Array.from({length:9},(_,i)=>[`panel${i}`,{date:'2026-09-08',data:'x'.repeat(2000)}]));
 const text=pageMaterials(blocks);
 assert.ok(text.length<8000);
 for(let i=0;i<9;i++)assert.ok(text.includes(`panel${i}：`));
 assert.equal((text.match(/本块仅提供/g)||[]).length,9);
 assert.match(text,/不等于零/);
});
