import { spawnSync } from 'node:child_process';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import * as effects from '../../src/boundaries/host-effects.js';
import * as authority from '../../src/index.js';
import { createIssuer, runtimeApi } from './authority-runtime-testkit.js';
import { boundaryApi, expectBoundaryFailure } from './authority-boundary-testkit.js';

// Publicly known marker only. These fixtures generate no reconciliation key.
const BYTES = 'FAKE_PRIVATE_BUNDLE_TEST_DATA_NOT_A_KEY\n';
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function directory() {
  const root = mkdtempSync(join(tmpdir(), 'devai-private-publication-'));
  roots.push(root);
  return root;
}
type Observation = {
  available: boolean;
  writes: number[];
  links: number[];
  names: string[];
  mode?: number;
  identity?: { dev: string; ino: string; birthtimeNs: string };
  foreign_identity?: string;
  error?: {
    code?: string;
    message: string;
    path?: string;
    staged_remaining?: boolean;
    identity?: unknown;
  };
};
function probe(kind: 'default' | 'private', scenario = 'normal') {
  const root = directory();
  const publication = join(root, 'publication');
  mkdirSync(publication, { mode: 0o700 });
  const target = join(publication, 'issuer.json');
  const reportPath = join(root, 'observation.json');
  const moduleUrl = pathToFileURL(
    resolve(import.meta.dirname, '../../src/boundaries/host-publish.ts'),
  ).href;
  const child = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    import { inspect } from 'node:util';
    process.umask(0o022); // Isolated child only; never changes the test runner/product process.
    const [kind, scenario, target, reportPath, moduleUrl, bytes] = process.argv.slice(1);
    const raw = { ...fs };
    const observation = { available:false, writes:[], links:[], names:[] };
    const stagedFds = new Set();
    let writes = 0;
    let replacedStage = false;
    fs.openSync = (...args) => {
      if (scenario==='open-failure' && String(args[0]).endsWith('.publish-staged')) throw Object.assign(new Error('fixture EIO'),{code:'EIO'});
      const fd=raw.openSync(...args);
      if (String(args[0]).endsWith('.publish-staged')) stagedFds.add(fd);
      return fd;
    };
    fs.writeSync = (...args) => {
      if (stagedFds.has(args[0])) {
        observation.writes.push(raw.fstatSync(args[0]).mode & 0o777);
        writes++;
        if (scenario==='write-failure' || (scenario==='partial-write' && writes>1)) throw Object.assign(new Error('fixture EIO'),{code:'EIO'});
        if (scenario==='partial-write') args[3]=Math.min(args[3],5);
      }
      return raw.writeSync(...args);
    };
    fs.fstatSync = (fd, ...args) => {
      if (scenario==='initial-fstat' && stagedFds.has(fd)) throw Object.assign(new Error('fixture EIO'),{code:'EIO'});
      return raw.fstatSync(fd,...args);
    };
    fs.fsyncSync = (fd) => {
      const stat=raw.fstatSync(fd);
      if ((scenario==='stage-fsync' && !stat.isDirectory()) || (scenario==='directory-fsync' && stat.isDirectory())) throw Object.assign(new Error('fixture EIO'),{code:'EIO'});
      return raw.fsyncSync(fd);
    };
    fs.linkSync = (from,to) => {
      observation.links.push(raw.lstatSync(from).mode & 0o777);
      if (scenario==='pre-link') throw Object.assign(new Error('fixture EIO'),{code:'EIO'});
      if (scenario==='foreign-target') {
        raw.writeFileSync(to,'FOREIGN\\n',{mode:0o600});
        observation.foreign_identity=String(raw.lstatSync(to,{bigint:true}).ino);
      }
      raw.linkSync(from,to);
      if (scenario==='sigkill-after-link') {
        raw.writeFileSync(reportPath,JSON.stringify(observation));
        process.kill(process.pid,'SIGKILL');
      }
    };
    fs.unlinkSync = (path) => {
      if (scenario==='foreign-stage-cleanup' && String(path).endsWith('.publish-staged') && !replacedStage) {
        replacedStage=true;
        raw.renameSync(path,path+'.owned-retained');
        raw.writeFileSync(path,'FOREIGN-STAGE\\n',{mode:0o600,flag:'wx'});
        throw Object.assign(new Error('fixture EIO'),{code:'EIO'});
      }
      if (scenario==='unlink-stage' && String(path).endsWith('.publish-staged')) throw Object.assign(new Error('fixture EIO'),{code:'EIO'});
      return raw.unlinkSync(path);
    };
    syncBuiltinESMExports();
    const module=await import(moduleUrl);
    const publish=module[kind==='private'?'publishPrivateNoReplaceSteps':'publishNoReplaceSteps'];
    observation.available=typeof publish==='function';
    if (observation.available) {
      try {
        const identity=publish(target,bytes);
        observation.identity=Object.fromEntries(Object.entries(identity).map(([key,value])=>[key,String(value)]));
      } catch(error) {
        observation.error={code:error.code,message:error.message,path:error.path,staged_remaining:error.staged_remaining,identity:error.identity,diagnostic:inspect(error,{depth:6})};
      }
    }
    observation.names=raw.readdirSync(new URL('.', 'file://'+target).pathname);
    if (raw.existsSync(target)) observation.mode=raw.lstatSync(target).mode & 0o777;
    raw.writeFileSync(reportPath,JSON.stringify(observation,(_key,value)=>typeof value==='bigint'?String(value):value));
  `,
      kind,
      scenario,
      target,
      reportPath,
      moduleUrl,
      BYTES,
    ],
    { encoding: 'utf8' },
  );
  expect(child.error).toBeUndefined();
  expect(child.status === 0 || child.signal === 'SIGKILL', child.stderr).toBe(true);
  const observation = JSON.parse(readFileSync(reportPath, 'utf8')) as Observation;
  return { root: publication, target, observation, child };
}
function privateProbe(scenario = 'normal') {
  const result = probe('private', scenario);
  expect(result.observation.available, 'required private primitive is absent at this source').toBe(
    true,
  );
  return result;
}
type PrivatePublish = (path: string, bytes: string | Uint8Array) => unknown;
function guardedPrivate(): PrivatePublish {
  const candidate = (effects as unknown as Record<string, unknown>)[
    'publishPrivateFileNoReplaceSync'
  ];
  expect(candidate).toBeTypeOf('function');
  return candidate as PrivatePublish;
}

describe('isolated private no-replace publication prerequisite', () => {
  it('preserves the actual default0644 baseline under ordinary022 umask', () => {
    const { observation, target } = probe('default');
    expect(observation.writes).toEqual([0o644]);
    expect(observation.links).toEqual([0o644]);
    expect(observation.mode).toBe(0o644);
    expect(readFileSync(target, 'utf8')).toBe(BYTES);
  });

  it('provides guarded and package-barrel private primitives without a caller mode/hooks argument', () => {
    guardedPrivate();
    expect(
      (authority as unknown as Record<string, unknown>)['publishPrivateFileNoReplaceSync'],
    ).toBeTypeOf('function');
  });

  it('has0600 from first secret write through link and returns the exact target identity', () => {
    const { observation, target, root } = privateProbe();
    expect(observation.writes).toEqual([0o600]);
    expect(observation.links).toEqual([0o600]);
    expect(observation.mode).toBe(0o600);
    const stat = lstatSync(target, { bigint: true });
    expect(observation.identity).toEqual({
      dev: String(stat.dev),
      ino: String(stat.ino),
      birthtimeNs: String(stat.birthtimeNs),
    });
    expect(readFileSync(target, 'utf8')).toBe(BYTES);
    expect(readdirSync(root)).toEqual(['issuer.json']);
  });

  it.each(['open-failure', 'write-failure', 'partial-write', 'stage-fsync', 'pre-link'])(
    '%s leaves no target or staged secret file',
    (scenario) => {
      const { observation, root } = privateProbe(scenario);
      expect(observation.error?.code).toBe('EIO');
      expect(readdirSync(root)).toEqual([]);
      expect(observation.writes.every((mode) => mode === 0o600)).toBe(true);
      expect(JSON.stringify(observation.error)).not.toContain(BYTES.trim());
    },
  );

  it('preserves a foreign target inode/bytes instead of replacement or removal', () => {
    const { observation, target, root } = privateProbe('foreign-target');
    expect(observation.error?.code).toBe('EEXIST');
    expect(readFileSync(target, 'utf8')).toBe('FOREIGN\n');
    expect(String(lstatSync(target, { bigint: true }).ino)).toBe(observation.foreign_identity);
    expect(readdirSync(root)).toEqual(['issuer.json']);
  });

  it('an initial descriptor-stat failure writes no private bytes and retains only an empty unclaimed stage', () => {
    const { observation, root } = privateProbe('initial-fstat');
    expect(observation.error?.code).toBe('EIO');
    expect(observation.writes).toEqual([]);
    expect(observation.links).toEqual([]);
    const names = readdirSync(root);
    expect(names).toHaveLength(1);
    expect(names[0]).toMatch(/\.publish-staged$/u);
    expect(readFileSync(join(root, names[0] ?? '')).byteLength).toBe(0);
    expect(lstatSync(join(root, names[0] ?? '')).mode & 0o777).toBe(0o600);
  });

  it('cleanup preserves a foreign staged inode and reports uncertainty for the whole private target', () => {
    const { observation, target, root } = privateProbe('foreign-stage-cleanup');
    expect(observation.error).toMatchObject({
      code: 'AUTHORITY_PUBLISH_CLEANUP_INCOMPLETE',
      staged_remaining: true,
    });
    expect(readFileSync(target, 'utf8')).toBe(BYTES);
    const names = readdirSync(root);
    const foreign = names.find((name) => name.endsWith('.publish-staged'));
    const retained = names.find((name) => name.endsWith('.owned-retained'));
    expect(foreign).toBeDefined();
    expect(retained).toBeDefined();
    expect(readFileSync(join(root, foreign ?? ''), 'utf8')).toBe('FOREIGN-STAGE\n');
    expect(lstatSync(join(root, retained ?? '')).ino).toBe(lstatSync(target).ino);
    for (const name of names) expect(lstatSync(join(root, name)).mode & 0o777).toBe(0o600);
    expect(JSON.stringify(observation.error)).not.toContain(BYTES.trim());
  });

  it.each(['unlink-stage', 'directory-fsync'])(
    '%s retains exact private target and reports ownership without durability success',
    (scenario) => {
      const { observation, target, root } = privateProbe(scenario);
      expect(observation.error).toMatchObject({
        code: 'AUTHORITY_PUBLISH_CLEANUP_INCOMPLETE',
        path: target,
        staged_remaining: scenario === 'unlink-stage',
      });
      const stat = lstatSync(target, { bigint: true });
      expect(observation.error?.identity).toEqual({
        dev: String(stat.dev),
        ino: String(stat.ino),
        birthtimeNs: String(stat.birthtimeNs),
      });
      expect(observation.mode).toBe(0o600);
      expect(readFileSync(target, 'utf8')).toBe(BYTES);
      expect(JSON.stringify(observation.error)).not.toContain(BYTES.trim());
      for (const name of readdirSync(root))
        expect(lstatSync(join(root, name)).mode & 0o777).toBe(0o600);
    },
  );

  it('actual child self-SIGKILL after link preserves a whole private target and owned stage', () => {
    const { child, target, root } = privateProbe('sigkill-after-link');
    expect(child.signal).toBe('SIGKILL');
    expect(readFileSync(target, 'utf8')).toBe(BYTES);
    const targetStat = lstatSync(target);
    expect(targetStat.mode & 0o777).toBe(0o600);
    const names = readdirSync(root);
    expect(names).toHaveLength(2);
    for (const name of names) {
      const stat = lstatSync(join(root, name));
      expect(stat.ino).toBe(targetStat.ino);
      expect(stat.mode & 0o777).toBe(0o600);
    }
  });
});

describe('private publication remains behind ordinary trusted host effects', () => {
  it('the new symbol is classified by the direct-mutator inventory rather than escaping static custody', async () => {
    const api = await boundaryApi();
    const result = api.validateDirectMutatorInventory({
      inventory: { entries: [], totals: { exemptions: 0 } },
      virtual_sources: {
        'packages/evidence/src/evidence/reconciliation-bootstrap.ts':
          "import { publishPrivateFileNoReplaceSync } from './untrusted-raw-publisher.js';\npublishPrivateFileNoReplaceSync('issuer.json', 'fixture');\n",
      },
    });
    const guarded = api.validateDirectMutatorInventory({
      inventory: { entries: [], totals: { exemptions: 0 } },
      virtual_sources: {
        'packages/evidence/src/evidence/reconciliation-bootstrap.ts':
          "import { publishPrivateFileNoReplaceSync } from '@devai-nyx/authority';\npublishPrivateFileNoReplaceSync('issuer.json', 'fixture');\n",
      },
    });
    expect(guarded).toMatchObject({ ok: true });
    expectBoundaryFailure(result, 'refused', 'AUTHORITY_DIRECT_MUTATOR_INVENTORY_STALE');
    expect(result).toMatchObject({
      unauthorized: [
        {
          path: 'packages/evidence/src/evidence/reconciliation-bootstrap.ts',
          line: 2,
          symbol: 'publishPrivateFileNoReplaceSync',
        },
      ],
    });
  });

  it('rejects an unscoped caller before creating anything', () => {
    const root = directory();
    const publish = guardedPrivate();
    expect(() => publish(join(root, 'issuer.json'), BYTES)).toThrow();
    expect(readdirSync(root)).toEqual([]);
  });

  it('is exactly one target effect and obeys denial before file creation', async () => {
    const publish = guardedPrivate();
    const root = directory();
    const target = join(root, 'issuer.json');
    const issuer = createIssuer(await runtimeApi(), { invocation_id: 'private-publication' });
    const requests: effects.AuthorityHostEffectRequest[] = [];
    try {
      expect(() =>
        effects.runWithAuthorityHostEffects(
          {
            action_id: 'private publisher fixture',
            invocation_id: 'private-publication',
            effect: 'local-write',
            receipt_store: issuer,
            apply_effect: (request) => {
              requests.push(request);
              throw new Error('AUTHORITY_POLICY_DENIED');
            },
          },
          () => publish(target, BYTES),
        ),
      ).toThrow('AUTHORITY_POLICY_DENIED');
      expect(readdirSync(root)).toEqual([]);
      expect(
        requests.map((request) => [request.kind, request.symbol, request.arguments[0]]),
      ).toEqual([['filesystem', 'publishPrivateFileNoReplaceSync', target]]);
    } finally {
      issuer.dispose();
    }
  });
});
