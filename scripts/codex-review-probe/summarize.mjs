// Summarizes one probe run: every tool the model request offered, including the
// responses-lite `additional_tools` input item and the nested tools the code-mode `exec`
// tool declares, and the #321 verdict.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const out = process.argv[2];
const read = (name) => (existsSync(join(out, name)) ? readFileSync(join(out, name), 'utf8') : '');
const requests = read('requests.jsonl')
  .trim()
  .split('\n')
  .filter(Boolean)
  .map((line) => JSON.parse(line));
const model = requests.filter((request) => request.model_request);
console.log(`codex: ${read('codex-version.txt').trim()}`);
console.log(`exit status: ${read('exit-status.txt').trim()}`);
console.log(
  `requests: ${requests.map((r) => (r.method ? `${r.method} ${r.path}` : `catalog forwarded -> ${String(r.status)}`)).join(', ')}`,
);
if (model.length === 0) {
  console.log('RESULT: no model request was captured; see stderr.txt');
  process.exit(1);
}
// An undecodable or unexpected body must never read as "no tools".
for (const request of model) {
  const parsed = request.body;
  if (
    request.body_error !== undefined ||
    parsed === null ||
    typeof parsed !== 'object' ||
    !(Array.isArray(parsed.tools) || Array.isArray(parsed.input))
  ) {
    console.log(
      `RESULT: a model request body could not be read (${String(request.body_error ?? 'no tools or input array')}); no conclusion`,
    );
    process.exit(1);
  }
}
const body = model[0].body;
const top = [];
const sources = [
  ...(Array.isArray(body.tools) ? [{ where: 'tools', tools: body.tools }] : []),
  ...(body.input ?? [])
    .filter((item) => item.type === 'additional_tools')
    .map((item) => ({
      where: `input.additional_tools(${String(item.role)})`,
      tools: item.tools ?? [],
    })),
];
const flatten = (tool, prefix) => {
  if (Array.isArray(tool.tools))
    for (const inner of tool.tools) flatten(inner, `${prefix}${tool.name}.`);
  else top.push({ name: `${prefix}${tool.name ?? tool.type}`, type: tool.type, tool });
};
for (const source of sources) for (const tool of source.tools) flatten(tool, '');
// Nested tools of code mode are declared as `declare const tools: { name(...` blocks.
const nested = [];
for (const entry of top) {
  const description = String(entry.tool.description ?? '');
  for (const match of description.matchAll(/declare const tools: \{ ([A-Za-z0-9_]+)\(/gu))
    nested.push(match[1]);
}
console.log(`model: ${String(body.model)}  tool_choice: ${JSON.stringify(body.tool_choice)}`);
console.log(`tool sources: ${sources.map((s) => s.where).join(', ') || '(none)'}`);
console.log(
  `directly offered tools (${String(top.length)}): ${top.map((t) => `${t.name} [${t.type}]`).join(', ')}`,
);
console.log(
  `nested tools callable from code mode (${String(nested.length)}): ${nested.join(', ') || '(none)'}`,
);
const COMMAND = /^(exec_command|write_stdin|shell|shell_command|local_shell|unified_exec)$/u;
const READS =
  /^(view_image|read_mcp_resource|list_mcp_resources|list_mcp_resource_templates|web_search|web__run)$/u;
const leaf = (name) => name.split('.').at(-1);
const commandTools = [...top.map((t) => leaf(t.name)), ...nested].filter((name) =>
  COMMAND.test(name),
);
const readTools = [...top.map((t) => leaf(t.name)), ...nested, ...top.map((t) => t.type)].filter(
  (name) => READS.test(name),
);
const collaboration = top
  .filter((t) => t.name.startsWith('collaboration.'))
  .map((t) => leaf(t.name));
console.log(`command tools: ${commandTools.join(', ') || 'none'}`);
console.log(`file/resource/web read tools: ${readTools.join(', ') || 'none'}`);
console.log(`sub-agent tools: ${collaboration.join(', ') || 'none'}`);
console.log(
  commandTools.length === 0 && readTools.length === 0
    ? 'RESULT: no command, shell, file-read or web tool is offered'
    : 'RESULT: a command or read tool IS offered',
);
writeFileSync(
  join(out, 'tools-summary.json'),
  `${JSON.stringify({ model: body.model, direct: top.map((t) => ({ name: t.name, type: t.type })), nested, commandTools, readTools, collaboration }, null, 2)}\n`,
);
