import { writeFileSync } from 'node:fs';

interface Program {
  action(handler: () => void): void;
}
declare function defineCommand(input: {
  name: string;
  run?: () => void;
  register?: (program: Program) => void;
}): unknown;
declare function unrelated(input: { name: string; run: () => void }): unknown;
const arrow = () => writeFileSync('target', 'data');
const expression = function () {
  writeFileSync('target', 'data');
};
function named() {
  writeFileSync('target', 'data');
}
const handlers = {
  write() {
    writeFileSync('target', 'data');
  },
};

function namedFactory(name: string) {
  return defineCommand({
    name,
    register(program) {
      program.action(arrow);
    },
  });
}
function templateFactory(domain: string, operation: string) {
  return defineCommand({
    name: `${domain} ${operation}`,
    register(program) {
      program.action(expression);
    },
  });
}
// Parsed only. No filesystem operation is invoked by the test.
export const commands = [
  defineCommand({
    name: 'method register',
    register(program) {
      program.action(arrow);
    },
  }),
  defineCommand({
    name: 'arrow register',
    register: (program) => {
      program.action(expression);
    },
  }),
  defineCommand({
    name: 'expression register',
    register: function (program) {
      program.action(arrow);
    },
  }),
  defineCommand({ name: 'quoted run', run: expression }),
  defineCommand({ name: 'named run', run: named }),
  defineCommand({ name: 'property run', run: handlers.write }),
  defineCommand({ name: 'wrapped run', run: arrow as () => void }),
  namedFactory('factory shorthand'),
  templateFactory('factory', 'template'),
  defineCommand({ name: 'not selected', run: arrow }),
  unrelated({ name: 'method register', run: () => {} }),
];
