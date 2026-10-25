import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { runInNewContext } from 'node:vm';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const ts = require('typescript');
const broker = resolve('packages/cli/src/authority/broker.ts');
const source = fs.readFileSync(broker, 'utf8');
const start = source.indexOf('function reviewFile(');
const end = source.indexOf('\nfunction reviewInstalledBundle(', start);
assert(start >= 0 && end > start);
const exactFunctions = source.slice(start,end);
const js = ts.transpileModule(exactFunctions, {compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText;
const sha = b => createHash('sha256').update(b).digest('hex');
const base = fs.mkdtempSync(join(tmpdir(),'devai-independent-link-watch-'));
const root = fs.realpathSync(fs.mkdirSync(join(base,'repo'),{recursive:true}) ?? join(base,'repo'));
const outside = join(base,'outside');fs.writeFileSync(outside,'PRIVATE-TARGET-CONTENT');
let targetReads=0, race=false;
const api=runInNewContext(js+'; ({reviewFile,reviewSourceFile})', {
 resolve,dirname,lstatSync:fs.lstatSync,realpathSync:fs.realpathSync,
 readFileSync:(path,...args)=>{if(path===outside){targetReads++;throw Error('target must not be read');}return fs.readFileSync(path,...args);},
 readlinkSync:(path,...args)=>{const b=fs.readlinkSync(path,...args);if(race){fs.unlinkSync(path);fs.symlinkSync('different-target',path);}return b;},
 within:(a,b)=>b===a||b.startsWith(a+sep),sha256Bytes:sha,
});
const passed=[]; const test=(name,f)=>{f();passed.push(name);};
const unsupported=f=>assert.throws(f,e=>e.message==='AUTHORITY_POLICY_REVIEW_INPUTS_UNSUPPORTED');
const regular=join(root,'regular'); fs.writeFileSync(regular,'regular-text');
const leaf=join(root,'link');fs.symlinkSync(outside,leaf);
test('regular source retains strict regular observation',()=>assert.equal(JSON.stringify(api.reviewSourceFile(root,'regular')),JSON.stringify(api.reviewFile(root,'regular'))));
test('outside source link is opaque hashed metadata and target is unread',()=>{assert.equal(JSON.stringify(api.reviewSourceFile(root,'link')),JSON.stringify({present:true,kind:'symlink',sha256:sha(Buffer.from(outside))}));assert.equal(targetReads,0);});
const before=JSON.stringify(api.reviewSourceFile(root,'link'));
test('target-content mutation changes no link observation',()=>{fs.writeFileSync(outside,'CHANGED-PRIVATE-CONTENT');assert.equal(JSON.stringify(api.reviewSourceFile(root,'link')),before);assert.equal(targetReads,0);});
test('raw target text is absent from observation',()=>assert(!before.includes(outside)));
test('dangling source link is observed without following',()=>{fs.symlinkSync('does-not-exist',join(root,'dangling'));assert.equal(api.reviewSourceFile(root,'dangling').sha256,sha('does-not-exist'));});
test('link-byte replacement changes full observed snapshot',()=>{fs.unlinkSync(leaf);fs.symlinkSync('changed-target',leaf);assert.notEqual(JSON.stringify(api.reviewSourceFile(root,'link')),before);});
test('regular-to-link kind substitution changes snapshot',()=>{const previous=JSON.stringify(api.reviewSourceFile(root,'regular'));fs.unlinkSync(regular);fs.symlinkSync('regular-text',regular);assert.notEqual(JSON.stringify(api.reviewSourceFile(root,'regular')),previous);});
test('source leaf link through a symlink parent refuses',()=>{const dir=join(base,'parent');fs.mkdirSync(dir);fs.symlinkSync('no-target',join(dir,'leaf'));fs.symlinkSync(dir,join(root,'parent'));unsupported(()=>api.reviewSourceFile(root,'parent/leaf'));});
test('strict authority/package/binding helper still refuses link',()=>unsupported(()=>api.reviewFile(root,'link')));
test('strict authority/package/binding helper refuses symlink parent',()=>unsupported(()=>api.reviewFile(root,'parent/leaf')));
test('lexically outside source paths refuse',()=>unsupported(()=>api.reviewSourceFile(root,'../outside')));
test('directory source refuses',()=>{fs.mkdirSync(join(root,'directory'));unsupported(()=>api.reviewSourceFile(root,'directory'));});
test('concurrent in-read link replacement refuses metadata comparison',()=>{race=true;try{unsupported(()=>api.reviewSourceFile(root,'link'));}finally{race=false;}});
const observation={kind:'independent-exact-source-helper-tests',broker_sha256:sha(source),extracted_functions_sha256:sha(exactFunctions),passed,tests:passed.length,target_content_reads:targetReads,limitations:['Exact private helper source executed through TypeScript transpilation and VM; no product code changes.','In-read replacement uses instrumented readlink hook; other filesystem cases use real native temporary files/links.','Snapshot difference proves watched data changes; installed public preview/apply refusal and target create-only route remain separately required.']};
fs.writeFileSync(resolve(import.meta.dirname,'p1-source-symlink-watch-results.json'),JSON.stringify(observation,null,2)+'\n');
console.log(JSON.stringify(observation,null,2));
