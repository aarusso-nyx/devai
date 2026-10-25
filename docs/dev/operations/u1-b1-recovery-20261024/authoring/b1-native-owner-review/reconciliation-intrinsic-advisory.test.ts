import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { analyzeEffectProgram, type EffectReport } from '../../../../../../packages/effects-check/src/index.js';
const calls = [
  ['packages/authority/src/boundaries/host-reconciliation-admission.ts','nativePromiseThen','value','[undefined, () => undefined]'],
  ['packages/authority/src/runtime/reconciliation-owner-record.ts','byteLengthGetter','value','[]'],
  ['packages/authority/src/runtime/reconciliation-owner-record.ts','bufferGetter','value','[]'],
  ['packages/authority/src/runtime/reconciliation-owner-record.ts','byteSet','copy','[value]'],
  ['packages/authority/src/runtime/reconciliation-owner-state.ts','byteLength','input','[]'],
] as const;
let root: string;
let report: EffectReport;
const expected: {path:string;line:number;allowed:boolean;pattern:string}[]=[];
beforeAll(async()=>{
 root=mkdtempSync(join(tmpdir(),'devai-intrinsic-advisory-inspector-'));
 const sources=new Map<string,string[]>();
 for(const [path,fn,receiver,args] of calls){
  const variants=[
   [`Reflect.apply(${fn}, ${receiver}, ${args});`,true,'apply'],
   [`Reflect.apply(other, ${receiver}, ${args});`,false,'apply'],
   [`Reflect.apply(${fn}, other, ${args});`,false,'apply'],
   [`Reflect.apply(${fn}, ${receiver}, [other]);`,false,'apply'],
   [`Reflect.apply(${fn}, ${receiver});`,false,'apply'],
   [`Reflect.apply(${fn}, ${receiver}, ${args}, extra);`,false,'apply'],
   [`Reflect.construct(${fn}, ${receiver}, ${args});`,false,'construct'],
   [`Reflect.apply(${fn}, ${receiver}, args);`,false,'apply'],
   ['eval(other);',false,'eval'],
  ] as const;
  const lines=sources.get(path)??[];
  for(const [source,allowed,kind] of variants){lines.push(source);expected.push({path,line:lines.length,allowed,pattern:kind==='eval'?'eval':`Reflect.${kind} with a non-literal target`});}
  sources.set(path,lines);
  const copy=path.replace('.ts','-copy.ts');const copyLines=sources.get(copy)??[];copyLines.push(variants[0][0]);sources.set(copy,copyLines);expected.push({path:copy,line:copyLines.length,allowed:false,pattern:'Reflect.apply with a non-literal target'});
 }
 for(const [path,lines] of sources){mkdirSync(dirname(join(root,path)),{recursive:true});writeFileSync(join(root,path),lines.join('\n')+'\n');}
 const tsconfigPath=join(root,'tsconfig.json');writeFileSync(tsconfigPath,JSON.stringify({compilerOptions:{target:'ES2022',module:'NodeNext'},files:[...sources.keys()]}));
 report=await analyzeEffectProgram({tsconfigPath,catalog:[],contracts:[],subprocessRegistry:{templates:[]}});
},30000);
afterAll(()=>{if(root)rmSync(root,{recursive:true,force:true});});
it('disposes exactly the five captured intrinsic call shapes and retains all forty-five counterexamples',()=>{
 for(const item of expected){const edge=`${item.path}:${item.line}:${item.pattern}`;const disposition=report.advisory_patterns.dispositions.find(d=>d.edge===edge);if(item.allowed){expect(disposition?.reason).toMatch(/captured Promise or typed-array intrinsic/u);expect(report.findings.some(f=>f.message.includes(`at ${edge} `))).toBe(false);}else{expect(disposition).toBeUndefined();expect(report.findings).toContainEqual({code:'EFFECT_UNANALYZABLE_PATTERN',message:`${item.pattern} at ${edge} is outside the audited advisory allowlist.`});}}
 expect(report.advisory_patterns.dispositions).toHaveLength(5);expect(report.advisory_patterns.violations).toBe(45);expect(report.actions).toEqual({});
});
