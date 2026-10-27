import { readFileSync, lstatSync, mkdtempSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { boundedProcess } from './bounded-process.mjs';
const fail = () => {
  throw Error('REFUSED');
};
const read = (p, limit) => {
  let st = lstatSync(p);
  if (!st.isFile() || st.size > limit) fail();
  let b = readFileSync(p);
  if (b.length > limit) fail();
  return b;
};
const hash = (b) => createHash('sha256').update(b).digest('hex');
// Experimental: caller supplies a private, exclusive parent and a reviewed key digest.
export async function verifiedTar({
  archive,
  signature,
  keyFile,
  privateParent,
  deadline,
  sourceDigest,
  keyDigest,
  primary,
  signing,
}) {
  if (
    !/^[a-f0-9]{64}$/.test(sourceDigest ?? '') ||
    !/^[a-f0-9]{64}$/.test(keyDigest ?? '') ||
    !/^[A-F0-9]{40}$/.test(primary ?? '') ||
    !/^[A-F0-9]{40}$/.test(signing ?? '')
  )
    fail();
  const st = lstatSync(privateParent);
  if (!st.isDirectory() || st.mode & 0o077 || (process.getuid && st.uid !== process.getuid()))
    fail();
  let bytes = read(archive, 16777216),
    key = read(keyFile, 1048576),
    sig = read(signature, 65536);
  if (hash(bytes) !== sourceDigest || hash(key) !== keyDigest) fail();
  const home = mkdtempSync(join(privateParent, 'gpg-'));
  await boundedProcess(
    'gpg',
    ['--homedir', home, '--batch', '--no-auto-key-retrieve', '--import'],
    { input: key, deadline, maxOutput: 65536 },
  );
  let tar = await boundedProcess('xz', ['--memlimit-decompress=64MiB', '-dc'], {
    input: bytes,
    deadline,
    maxOutput: 134217728,
  });
  // Signature bytes are passed through a pipe descriptor rather than reopened from a mutable path.
  // gpg expects the detached signature as a file: create a private file and bind it before verification.
  const { writeFileSync } = await import('node:fs');
  const sigPath = join(home, 'signature');
  writeFileSync(sigPath, sig, { flag: 'wx', mode: 0o600 });
  const status = (
    await boundedProcess(
      'gpg',
      [
        '--homedir',
        home,
        '--batch',
        '--no-auto-key-retrieve',
        '--status-fd',
        '1',
        '--verify',
        sigPath,
        '-',
      ],
      { input: tar, deadline, maxOutput: 65536 },
    )
  ).toString('utf8');
  if (
    /^\[GNUPG:\] (?:BADSIG|ERRSIG|EXPSIG|EXPKEYSIG|REVKEYSIG|KEYREVOKED|NO_PUBKEY)\b/m.test(status)
  )
    fail();
  let valid = status.split('\n').filter((s) => s.startsWith('[GNUPG:] VALIDSIG '));
  let parts = valid[0]?.trim().split(/\s+/);
  if (valid.length !== 1 || parts[2] !== signing || parts.at(-1) !== primary) fail();
  return tar;
}
