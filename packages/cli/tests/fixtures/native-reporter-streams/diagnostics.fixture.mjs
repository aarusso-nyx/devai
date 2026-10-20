// Synthetic stream fixture only: never a registered production run or sensor reading.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
const write = (stream, content) =>
  new Promise((resolve, reject) => {
    stream.write(content, (error) => (error ? reject(error) : resolve()));
  });
beforeAll(async () => {
  await write(process.stdout, '{"level":30,"msg":"PINO_BEFORE_COLLECTION_PRESERVED"}\n');
  await write(process.stdout, 'AWAITED_BEFORE_STDOUT_α\n');
  await write(process.stderr, 'AWAITED_BEFORE_STDERR_β\n');
});
afterAll(async () => {
  await write(process.stdout, 'AWAITED_AFTER_STDOUT_γ\n');
  await write(process.stderr, 'AWAITED_AFTER_STDERR_δ\n');
});
describe('native reporter stream fixture', () => {
  it('awaited diagnostics', async () => {
    await write(process.stdout, 'RAW_STDOUT_PRESERVED_Ω\n');
    await write(process.stdout, '{"level":30,"msg":"PINO_EQUIVALENT_PRESERVED"}\n');
    await write(process.stderr, 'RAW_STDERR_PRESERVED_λ\n');
    console.log('CONSOLE_LOG_PRESERVED_é');
    console.error('CONSOLE_ERROR_PRESERVED_ç');
    console.warn('CONSOLE_WARN_PRESERVED_ñ');
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(true).toBe(true);
  });
  it('native assertion outcome', () => {
    expect(process.env['DEVAI_STREAM_FIXTURE_FAIL_ONLY']).not.toBe('1');
  });
  it.skip('retained skipped case', () => {
    throw new Error('Skipped fixture must not execute');
  });
});
