import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import {expect,it} from 'vitest';
import {buildEvidenceRecord,computeEvidenceManifestHash} from '@devai-nyx/utils';
import {validators} from '@devai-nyx/schemas';
const old=readFileSync('release-280/b1-design/normal-chain.before-pure-record-kernel.ts.txt','utf8');
const start=old.indexOf('export function appendRecord('),end=old.indexOf('\nexport interface VerifyResult',start);
if(start<0||end<start)throw new Error('missing exact historical construction span');
const js=ts.transpileModule(old.slice(start,end),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
function oracle(draft:any,head:string|null,derive?:((head:string|null)=>string)){
 const chain={head,records:[] as any[]};const events:string[]=[];const exports:Record<string,any>={};
 runInNewContext(js,{exports,DOMAIN_SEPARATOR:'GENESIS',computeManifestHash:computeEvidenceManifestHash,validateEvidence:validators.evidence,withAppendLock:(_path:string,fn:()=>unknown)=>{events.push('lock');return fn();},loadChain:()=>{events.push('load');return chain;},saveChain:()=>events.push('save')});
 const record=exports.appendRecord('synthetic-chain',draft,head??undefined,()=>events.push('before'),derive);
 expect(events).toEqual(['lock','before','load','save']);return record;
}
const base={id:'EV-0123456789abcdef',timestamp:'2026-10-24T12:00:00.000Z',actor:'devai',actor_role:'harness',action:'evidence.reconcile.canonical-selection',status:'completed',context:{repo_root:'.',git:{head_sha:'a'.repeat(40),dirty_files:[]}}};
const cases=[{}, {artifacts:[{path:'a',sha256:null},{path:'b',sha256:'b'.repeat(64)}]}, {notes:['Unicode café','round_id=R-0025'],findings_summary:{info:0,error:2}}, {proof_path:'record/proofs/work/generic/R-0025.jsonl',proof_sequence:7,proof_sha256:'c'.repeat(64),recovered_from:{source_chain_path:'record/proofs/original.json',source_chain_sha256:'d'.repeat(64),source_entry_id:'EV-1111111111111111',source_entry_sequence:165,source_entry_manifest_hash:'e'.repeat(64),fork_sequence:6}}];
for(const head of [null,'f'.repeat(64)])for(const [index,extra]of cases.entries())it(`preserves exact old bytes at ${head===null?'genesis':'nonempty'} with option vector ${index}`,()=>{const draft={...base,...structuredClone(extra)};const original=oracle(draft,head);const actual=buildEvidenceRecord(draft,head,1);expect(JSON.stringify(actual)).toBe(JSON.stringify(original));expect(validators.evidence(actual)).toBe(true);if(draft.notes)expect(actual.notes).not.toBe(draft.notes);if(draft.artifacts)expect(actual.artifacts).not.toBe(draft.artifacts);if(draft.recovered_from)expect(actual.recovered_from).not.toBe(draft.recovered_from);expect(actual.context).toBe(draft.context);});
it('preserves derived identifier binding to exact actual predecessor',()=>{const head='9'.repeat(64);const seen:(string|null)[]=[];const derive=(previous:string|null)=>{seen.push(previous);return 'EV-9999999999999999';};const expected=oracle(base,head,derive);const actual=buildEvidenceRecord(base,head,1,derive(head));expect(JSON.stringify(actual)).toBe(JSON.stringify(expected));expect(seen).toEqual([head,head]);});
