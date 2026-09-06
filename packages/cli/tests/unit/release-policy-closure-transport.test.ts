import { describe, expect, it } from 'vitest';
import { canonicalJson } from '@devai-nyx/utils';
import {
  decodeReleasePolicyClosure,
  encodeReleasePolicyClosure,
  type ReleasePolicyClosureTransportLimits,
} from '../../src/services/release-policy-closure-transport.js';
import {
  createReleasePolicyClosure,
  verifyReleasePolicyClosure,
  type ReleasePolicyClosure,
} from '../../src/services/release-policy-closure.js';
import { createLifecyclePolicyFixture } from '../helpers/release-policy-resolution-fixture.js';

const LIMITS: ReleasePolicyClosureTransportLimits = {
  maximum_transport_bytes: 8 * 1024 * 1024,
  maximum_decoded_bytes: 8 * 1024 * 1024,
  maximum_entries: 20_000,
};

function fixtureClosure(): {
  readonly fixture: ReturnType<typeof createLifecyclePolicyFixture>;
  readonly closure: ReleasePolicyClosure;
} {
  const fixture = createLifecyclePolicyFixture();
  return {
    fixture,
    closure: createReleasePolicyClosure({ plan: fixture.receipt, resolution: fixture.resolution }),
  };
}

function verify(
  fixture: ReturnType<typeof createLifecyclePolicyFixture>,
  closure: ReleasePolicyClosure,
) {
  return verifyReleasePolicyClosure({
    closure,
    expected: fixture.expected,
    implementation: fixture.package_snapshot,
    limits: {
      maximum_archive_bytes: 4 * 1024 * 1024,
      maximum_unpacked_bytes: 4 * 1024 * 1024,
      maximum_git_bytes: 4 * 1024 * 1024,
      maximum_git_entries: 2000,
    },
  });
}

function wire(bytes: Uint8Array): Record<string, unknown> {
  return JSON.parse(Buffer.from(bytes).toString('utf8')) as Record<string, unknown>;
}

function canonicalWire(value: unknown): Buffer {
  return Buffer.from(canonicalJson(value));
}

function expectRefusal(operation: () => unknown): void {
  expect(operation).toThrow(/^rpl-policy-resolution-mismatch$/u);
}

function flipFirstByte(bytes: Uint8Array, message: string): void {
  const first = bytes[0];
  if (first === undefined) throw new Error(message);
  bytes[0] = first ^ 0xff;
}

describe('release policy closure transport', () => {
  it('round-trips the producer closure and reconstructs the original semantic proof', () => {
    const { fixture, closure } = fixtureClosure();
    const decoded = decodeReleasePolicyClosure(encodeReleasePolicyClosure(closure, LIMITS), LIMITS);

    expect(verify(fixture, decoded).repository).toEqual(fixture.candidate.repository);
    expect(decoded.plan).toEqual(closure.plan);
    expect(decoded.evidence.producer).toBeDefined();
  });

  it('sorts unordered input maps into one deterministic transport', () => {
    const { closure } = fixtureClosure();
    const producer = closure.evidence.producer;
    if (producer === undefined) throw new Error('producer fixture missing');
    const reversed: ReleasePolicyClosure = {
      ...closure,
      evidence: {
        ...closure.evidence,
        candidate_objects: new Map([...closure.evidence.candidate_objects].reverse()),
        producer: {
          files: new Map([...producer.files].reverse()),
          source_objects: new Map([...producer.source_objects].reverse()),
          build_provenance: producer.build_provenance,
        },
      },
    };

    expect(encodeReleasePolicyClosure(reversed, LIMITS)).toEqual(
      encodeReleasePolicyClosure(closure, LIMITS),
    );
  });

  it('copies input and decoded raw bytes across the transport boundary', () => {
    const { fixture, closure } = fixtureClosure();
    const encoded = encodeReleasePolicyClosure(closure, LIMITS);
    flipFirstByte(closure.evidence.archive, 'archive fixture missing');
    const firstInput = closure.evidence.candidate_objects.values().next().value;
    if (firstInput === undefined) throw new Error('candidate fixture missing');
    flipFirstByte(firstInput.bytes, 'candidate object bytes missing');
    const producer = closure.evidence.producer;
    if (producer === undefined) throw new Error('producer fixture missing');
    flipFirstByte(producer.build_provenance, 'producer provenance missing');
    const firstProducerFile = producer.files.values().next().value;
    if (firstProducerFile === undefined) throw new Error('producer file fixture missing');
    flipFirstByte(firstProducerFile, 'producer file bytes missing');

    const decoded = decodeReleasePolicyClosure(encoded, LIMITS);
    expect(verify(fixture, decoded).repository).toEqual(fixture.candidate.repository);
    flipFirstByte(decoded.evidence.archive, 'decoded archive missing');
    const again = decodeReleasePolicyClosure(encoded, LIMITS);
    expect(verify(fixture, again).repository).toEqual(fixture.candidate.repository);
  });

  it('does not mistake codec integrity for semantic closure authority', () => {
    const { fixture, closure } = fixtureClosure();
    const decoded = decodeReleasePolicyClosure(encodeReleasePolicyClosure(closure, LIMITS), LIMITS);
    flipFirstByte(decoded.evidence.archive, 'decoded archive missing');
    const altered = decodeReleasePolicyClosure(encodeReleasePolicyClosure(decoded, LIMITS), LIMITS);

    expect(() => verify(fixture, altered)).toThrow(/^rpl-package-identity-mismatch$/u);
  });

  it('refuses impostor maps and limit objects with an unexpected member', () => {
    const { closure } = fixtureClosure();
    const encoded = encodeReleasePolicyClosure(closure, LIMITS);
    expectRefusal(() =>
      encodeReleasePolicyClosure(
        {
          ...closure,
          evidence: {
            ...closure.evidence,
            candidate_objects: { entries: () => closure.evidence.candidate_objects.entries() },
          },
        } as never,
        LIMITS,
      ),
    );
    expectRefusal(() =>
      decodeReleasePolicyClosure(encoded, { ...LIMITS, untrusted_extra: 1 } as never),
    );
  });

  it.each([
    ['unknown top-level member', (value: Record<string, unknown>) => ({ ...value, extra: true })],
    [
      'unknown object member',
      (value: Record<string, unknown>) => ({
        ...value,
        candidate_objects: [
          { ...(value['candidate_objects'] as readonly Record<string, unknown>[])[0], extra: true },
          ...(value['candidate_objects'] as readonly Record<string, unknown>[]).slice(1),
        ],
      }),
    ],
    [
      'duplicate Git object',
      (value: Record<string, unknown>) => ({
        ...value,
        candidate_objects: [
          ...(value['candidate_objects'] as readonly Record<string, unknown>[]),
          (value['candidate_objects'] as readonly Record<string, unknown>[])[0],
        ],
      }),
    ],
    [
      'out-of-order Git objects',
      (value: Record<string, unknown>) => ({
        ...value,
        candidate_objects: [...(value['candidate_objects'] as readonly unknown[])].reverse(),
      }),
    ],
    [
      'unsafe producer path',
      (value: Record<string, unknown>) => {
        const producer = value['producer'] as Record<string, unknown>;
        const files = producer['files'] as readonly Record<string, unknown>[];
        return {
          ...value,
          producer: {
            ...producer,
            files: [{ ...files[0], path: '../outside' }, ...files.slice(1)],
          },
        };
      },
    ],
  ])('refuses canonical wire with %s', (_name, mutate) => {
    const { closure } = fixtureClosure();
    expectRefusal(() =>
      decodeReleasePolicyClosure(
        canonicalWire(mutate(wire(encodeReleasePolicyClosure(closure, LIMITS)))),
        LIMITS,
      ),
    );
  });

  it('refuses duplicate members, noncanonical JSON, and malformed base64 before reconstruction', () => {
    const { closure } = fixtureClosure();
    const encoded = encodeReleasePolicyClosure(closure, LIMITS);
    const parsed = wire(encoded);
    expectRefusal(() =>
      decodeReleasePolicyClosure(
        Buffer.from(`{"format":"other","format":${JSON.stringify(parsed['format'])}}`),
        LIMITS,
      ),
    );
    expectRefusal(() =>
      decodeReleasePolicyClosure(Buffer.from(` ${encoded.toString('utf8')}`), LIMITS),
    );
    expectRefusal(() =>
      decodeReleasePolicyClosure(canonicalWire({ ...parsed, archive: 'not-base64!' }), LIMITS),
    );
  });

  it.each([
    ['transport bytes', { ...LIMITS, maximum_transport_bytes: 1 }],
    ['decoded bytes', { ...LIMITS, maximum_decoded_bytes: 1 }],
    ['entries', { ...LIMITS, maximum_entries: 1 }],
  ])('enforces the %s quota on encode and decode', (_name, limits) => {
    const { closure } = fixtureClosure();
    const encoded = encodeReleasePolicyClosure(closure, LIMITS);
    expectRefusal(() => encodeReleasePolicyClosure(closure, limits));
    expectRefusal(() => decodeReleasePolicyClosure(encoded, limits));
  });
});
