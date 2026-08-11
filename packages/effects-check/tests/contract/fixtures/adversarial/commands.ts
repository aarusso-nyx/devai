import { writeFileSync } from './authority-host-effects.js';

declare function defineCommand(input: { name: string; run: () => void }): unknown;

function sink(): void {
  writeFileSync('fixture.txt', 'fixture');
}

function throughCallback(callback: () => void): void {
  callback();
}

function factory(): () => void {
  return sink;
}

interface Runner {
  run(): void;
}

class FirstRunner implements Runner {
  run(): void {
    sink();
  }
}

class SecondRunner implements Runner {
  run(): void {}
}

function unionRunner(selectFirst: boolean): FirstRunner | SecondRunner {
  return selectFirst ? new FirstRunner() : new SecondRunner();
}

function higherOrder(callback: () => void): () => void {
  return () => callback();
}

const methodRunner: Runner = new FirstRunner();

export const commands = [
  defineCommand({ name: 'fixture callback', run: () => throughCallback(sink) }),
  defineCommand({ name: 'fixture factory', run: () => factory()() }),
  defineCommand({ name: 'fixture union', run: () => unionRunner(true).run() }),
  defineCommand({ name: 'fixture higher-order', run: () => higherOrder(sink)() }),
  defineCommand({ name: 'fixture method', run: () => methodRunner.run() }),
];
