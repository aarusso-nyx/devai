import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  evaluateDetectSignals,
  findStackAdapterPacks,
  resolveSensorParams,
  resolveStackAdapterPack,
  type StackAdapterDetectSignal,
  type StackAdapterPack,
} from '../../src/pack-resolver/index.js';

let root: string;
let adopter: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pack-detection-'));
  adopter = join(root, 'adopter');
  mkdirSync(adopter);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
function pack(
  id: string,
  signals: readonly StackAdapterDetectSignal[],
  priority?: number,
): StackAdapterPack {
  return {
    schemaVersion: '1.0.0',
    id,
    name: id,
    version: '1.0.0',
    stack: { backend: 'test', frontend: 'test', db: 'test' },
    detect: { signals, ...(priority !== undefined && { priority }) },
  };
}
function save(
  value: StackAdapterPack,
  directory = join(root, 'examples', `redox-pack-${value.id}`),
): string {
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'stack-adapter.json'), JSON.stringify(value));
  return directory;
}
function hits(signals: StackAdapterDetectSignal[]): readonly StackAdapterDetectSignal[] {
  return evaluateDetectSignals({ pack: pack('fixture', signals), adopterRoot: adopter });
}
const marker: StackAdapterDetectSignal = { kind: 'file_present', path: 'marker.txt' };
const second: StackAdapterDetectSignal = { kind: 'dir_present', path: 'src' };

describe('pack discovery and explicit selection', () => {
  it('loads only canonical directories plus explicitly supplied pack directories', () => {
    const expected = save(pack('valid', [marker]));
    save(pack('ignored', [marker]), join(root, 'examples', 'unrelated'));
    writeFileSync(join(root, 'examples', 'redox-pack-file'), '{}');
    mkdirSync(join(root, 'examples', 'redox-pack-empty'));
    const malformed = join(root, 'examples', 'redox-pack-malformed');
    mkdirSync(malformed);
    writeFileSync(join(malformed, 'stack-adapter.json'), '{invalid');
    const extra = save(pack('extra', [marker]), join(root, 'explicit-pack'));
    expect(
      findStackAdapterPacks({ repoRoot: root, additionalDirs: [join(root, 'absent'), extra] }),
    ).toEqual([
      { ...pack('valid', [marker]), _packDir: expected },
      { ...pack('extra', [marker]), _packDir: extra },
    ]);
  });

  it('continues with explicit packs if examples is an unreadable directory shape', () => {
    writeFileSync(join(root, 'examples'), 'not a directory');
    const extra = save(pack('extra', [marker]), join(root, 'explicit'));
    expect(findStackAdapterPacks({ repoRoot: root, additionalDirs: [extra] })).toEqual([
      { ...pack('extra', [marker]), _packDir: extra },
    ]);
  });

  it('explicit selection bypasses detection, preserves zero priority and never falls back for an unknown id', () => {
    save(pack('forced', [marker], 0));
    const result = resolveStackAdapterPack({
      repoRoot: root,
      adopterRoot: adopter,
      explicitId: 'forced',
    });
    expect(result.matched?.id).toBe('forced');
    expect(
      result.candidates.map(({ matched_signals, priority }) => ({ matched_signals, priority })),
    ).toEqual([{ matched_signals: [], priority: 0 }]);
    expect(result.ambiguous).toBe(false);
    writeFileSync(join(adopter, 'marker.txt'), '');
    expect(
      resolveStackAdapterPack({ repoRoot: root, adopterRoot: adopter, explicitId: 'missing' }),
    ).toEqual({ matched: null, candidates: [], ambiguous: false });
  });

  it('uses additional directories when resolving a sensor without implicitly discovering adopter packs', () => {
    const extra = save(
      { ...pack('extra', []), extractor_params: { inventory_api: { source: 'src/api' } } },
      join(root, 'explicit'),
    );
    expect(
      resolveSensorParams({
        adopterRoot: adopter,
        sensorKind: 'inventory_api',
        additionalDirs: [extra],
        explicitId: 'extra',
      }),
    ).toBeNull();
    expect(
      resolveSensorParams({
        packsRoot: root,
        adopterRoot: adopter,
        sensorKind: 'inventory_api',
        additionalDirs: [extra],
        explicitId: 'extra',
      })?.params,
    ).toEqual({ source: 'src/api' });
    expect(
      resolveSensorParams({
        packsRoot: root,
        adopterRoot: adopter,
        sensorKind: 'inventory_api',
        additionalDirs: [extra],
        explicitId: 'absent',
      }),
    ).toBeNull();
  });
});

describe('pack detect signals', () => {
  it('distinguishes files and directories and returns every matching signal in input order', () => {
    writeFileSync(join(adopter, 'marker.txt'), '');
    mkdirSync(join(adopter, 'src'));
    const signals: StackAdapterDetectSignal[] = [
      { kind: 'file_present', path: 'absent' },
      { kind: 'dir_present', path: 'marker.txt' },
      second,
      marker,
      { kind: 'file_present', path: 'src' },
      { kind: 'file_present' },
    ];
    expect(hits(signals)).toEqual([second, marker]);
  });

  it.each([
    { filename: 'package.json', key: 'dependencies', kind: 'package_dep_present' },
    { filename: 'package.json', key: 'devDependencies', kind: 'package_dep_present' },
    { filename: 'composer.json', key: 'require', kind: 'composer_dep_present' },
    { filename: 'composer.json', key: 'require-dev', kind: 'composer_dep_present' },
  ] as const)('matches $filename $key by exact owned dependency key', ({ filename, key, kind }) => {
    writeFileSync(
      join(adopter, filename),
      JSON.stringify({ [key]: { '@scope/framework': '1.0.0' } }),
    );
    const present = { kind, package: '@scope/framework' };
    expect(
      hits([
        present,
        { kind, package: '@scope/frame' },
        { kind, package: 'constructor' },
        { kind },
      ]),
    ).toEqual([present]);
  });

  it.each(['missing', 'malformed', 'null', 'string-map', 'wrong-section'])(
    'does not invent dependency matches for %s input',
    (shape) => {
      if (shape !== 'missing') {
        const bytes =
          shape === 'malformed'
            ? '{bad'
            : shape === 'null'
              ? 'null'
              : shape === 'string-map'
                ? '{"dependencies":"framework"}'
                : '{"optionalDependencies":{"framework":"1"}}';
        writeFileSync(join(adopter, 'package.json'), bytes);
      }
      expect(hits([{ kind: 'package_dep_present', package: 'framework' }])).toEqual([]);
    },
  );

  it.each([
    { text: '# comment\n  gem "rails.api+", "~> 1"\n', matches: true },
    { text: "source 'registry'\n\tgem 'rails.api+'\n", matches: true },
    { text: '# gem "rails.api+"\n', matches: false },
    { text: 'gem "railsXapiiii"\n', matches: false },
    { text: 'gem "rails.api+-extra"\n', matches: false },
    { text: 'puts "gem \\"rails.api+\\""\n', matches: false },
  ])('matches literal Gemfile names and real declarations: $text', ({ text, matches }) => {
    writeFileSync(join(adopter, 'Gemfile'), text);
    const signal: StackAdapterDetectSignal = { kind: 'gemfile_dep_present', package: 'rails.api+' };
    expect(hits([signal])).toEqual(matches ? [signal] : []);
  });

  it('does not match missing Gemfiles, unspecified package names or unsupported signal kinds', () => {
    expect(
      hits([
        { kind: 'gemfile_dep_present', package: 'rails' },
        { kind: 'gemfile_dep_present' },
        { kind: 'unsupported' } as unknown as StackAdapterDetectSignal,
      ]),
    ).toEqual([]);
  });
});

describe('pack ranking and ambiguity', () => {
  beforeEach(() => {
    writeFileSync(join(adopter, 'marker.txt'), '');
    mkdirSync(join(adopter, 'src'));
  });

  it('ranks specific signal matches first, priority second and ids last', () => {
    save(pack('z-specific', [marker, second], 5), join(root, 'examples', 'redox-pack-0'));
    save(pack('a-specific', [marker, second], 5), join(root, 'examples', 'redox-pack-1'));
    save(pack('b-default', [marker]));
    save(pack('c-high', [marker], 99));
    save(pack('d-low', [marker], 0));
    save(pack('no-match', [{ kind: 'file_present', path: 'absent' }], 1000));
    const result = resolveStackAdapterPack({ repoRoot: root, adopterRoot: adopter });
    expect(
      result.candidates.map((candidate) => [
        candidate.pack.id,
        candidate.priority,
        candidate.matched_signals.length,
      ]),
    ).toEqual([
      ['a-specific', 5, 2],
      ['z-specific', 5, 2],
      ['c-high', 99, 1],
      ['b-default', 50, 1],
      ['d-low', 0, 1],
    ]);
    expect(result.matched?.id).toBe('a-specific');
    expect(result.ambiguous).toBe(true);
  });

  it('does not declare ambiguity for equal hit counts with different priorities', () => {
    save(pack('lower', [marker], 10));
    save(pack('higher', [marker], 20));
    const result = resolveStackAdapterPack({ repoRoot: root, adopterRoot: adopter });
    expect(result.matched?.id).toBe('higher');
    expect(result.ambiguous).toBe(false);
  });

  it('does not declare ambiguity for equal priority with different hit counts', () => {
    save(pack('generic', [marker], 50));
    save(pack('specific', [marker, second], 50));
    const result = resolveStackAdapterPack({ repoRoot: root, adopterRoot: adopter });
    expect(result.matched?.id).toBe('specific');
    expect(result.ambiguous).toBe(false);
  });
});
