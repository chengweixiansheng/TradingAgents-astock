import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
// Exercise the actual component's storage functions; React rendering is not needed here.
function storage(fail=false) {
  let saved='{}';
  const source=readFileSync(new URL('../src/components/ui/DeepDive.tsx',import.meta.url),'utf8');
  const code=ts.transpileModule(source+'\nexport {loadStore,persistStore};', {compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022}}).outputText;
  const context:any={exports:{},require:()=>({}),localStorage:{getItem:()=>saved,setItem:(_k:string,v:string)=>{if(fail)throw Error('quota');saved=v;}}};
  vm.runInNewContext(code,context);
  return {api:context.exports,raw:()=>JSON.parse(saved),seed:(value:string)=>{saved=value;}};
}
test('saving an older review retains that day and four recent days',()=>{
  const s=storage();const rows=Object.fromEntries(['20260901','20260902','20260903','20260904','20260907','20260701'].map(d=>[d+'|firstboard|600000',{text:d,tools:[],ts:1}]));
  s.api.persistStore(rows,'20260701');
  assert.equal(Object.keys(s.raw()).length,5);assert.ok(s.raw()['20260701|firstboard|600000']);assert.equal(s.raw()['20260901|firstboard|600000'],undefined);
});
test('storage failure cannot be reported as archived success',()=>{
 const s=storage(true);assert.throws(()=>s.api.persistStore({'20260908|x|600000':{text:'result',tools:[],ts:1}},'20260908'),/未能存档/);
});
test('malformed stored records cannot crash reopened completed rows',()=>{
 const s=storage();s.seed(JSON.stringify({bad:null,broken:{text:'x',tools:[null]},good:{text:'done',tools:[],ts:1}}));
 assert.deepEqual(Object.keys(s.api.loadStore()),['good']);
});
