#!/usr/bin/env node

// Validates every campaign plan under product/campaigns against
// law/schemas/campaign.schema.json and the structural rules of
// law/policy/campaign-execution.json: unique ids, resolvable acyclic
// dependencies, record coverage, pipeline order, prompt presence, prompt
// role and task naming, acceptance parity between plan and prompt, and
// the absence of credential shapes in prompts.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const CREDENTIAL_SHAPE =
  /gh[pousr]_[A-Za-z0-9]{16,}|github_pat_|-----BEGIN [A-Z ]*PRIVATE KEY-----/u;
const POSITIONS = ['architect', 'inspector', 'engineer'];

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function adrIds(root) {
  const dir = join(root, 'law/adr');
  if (!existsSync(dir)) return new Set();
  return new Set(
    readdirSync(dir)
      .map((name) => /^(ADR-[A-Z][A-Z0-9]*(?:-[A-Z][A-Z0-9]*)*-[0-9]{4})-/u.exec(name)?.[1])
      .filter((id) => id !== undefined),
  );
}

export function checkCampaign(root, campaignDir) {
  const problems = [];
  const problem = (message) => problems.push(message);
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  const validate = ajv.compile(readJson(join(root, 'law/schemas/campaign.schema.json')));
  const planPath = join(campaignDir, 'campaign.json');
  if (!existsSync(planPath)) return { ok: false, problems: ['campaign.json missing'] };
  const campaign = readJson(planPath);
  if (!validate(campaign)) {
    for (const error of validate.errors ?? []) {
      problem(`schema ${error.instancePath || '/'} ${error.message ?? ''}`.trim());
    }
    return { ok: false, problems };
  }
  const known = adrIds(root);
  const ids = new Map();
  const declare = (id, kind) => {
    if (ids.has(id)) problem(`duplicate id ${id}`);
    ids.set(id, kind);
  };
  const roundIds = new Set(campaign.rounds.map((round) => round.id));
  for (const record of campaign.records) {
    if (!known.has(record)) problem(`record ${record} has no file under law/adr`);
  }
  if (!existsSync(join(campaignDir, campaign.prompts.preamble))) problem('preamble missing');
  for (const effect of campaign.owner_effects) {
    if (!roundIds.has(effect.required_before)) problem(`${effect.id} names unknown round`);
  }
  const coveredByRound = new Set();
  for (const round of campaign.rounds) {
    declare(round.id, 'round');
    for (const dependency of round.depends_on) {
      if (!roundIds.has(dependency)) problem(`${round.id} depends on unknown ${dependency}`);
      if (dependency === round.id) problem(`${round.id} depends on itself`);
    }
    for (const record of round.records) {
      coveredByRound.add(record);
      if (!campaign.records.includes(record))
        problem(`${round.id} record ${record} not on campaign`);
    }
    for (const effect of round.owner_effects_required) {
      if (!campaign.owner_effects.some((candidate) => candidate.id === effect)) {
        problem(`${round.id} unknown owner effect ${effect}`);
      }
    }
    const waveIds = new Set(round.waves.map((wave) => wave.id));
    const coveredByWave = new Set();
    for (const wave of round.waves) {
      declare(wave.id, 'wave');
      for (const dependency of wave.depends_on) {
        if (!waveIds.has(dependency)) problem(`${wave.id} depends on unknown wave ${dependency}`);
      }
      for (const record of wave.records) {
        coveredByWave.add(record);
        if (!round.records.includes(record)) problem(`${wave.id} record ${record} not on round`);
      }
      const disciplines = wave.tasks.map((task) => task.discipline);
      if (wave.type === 'coupled-triplet' && disciplines.join() !== POSITIONS.join()) {
        problem(`${wave.id} triplet must be architect, inspector, engineer`);
      }
      if (wave.type === 'single-role' && wave.tasks.length !== 1) {
        problem(`${wave.id} single-role wave must hold one task`);
      }
      let upstream = null;
      for (const task of wave.tasks) {
        declare(task.id, 'task');
        if (task.discipline !== task.coupled_pipeline_position) {
          problem(`${task.id} discipline differs from position`);
        }
        if (task.upstream_task_id !== upstream) problem(`${task.id} upstream must be ${upstream}`);
        upstream = task.id;
        const promptPath = join(campaignDir, task.prompt.path);
        if (!existsSync(promptPath)) {
          problem(`${task.id} prompt missing ${task.prompt.path}`);
          continue;
        }
        const body = readFileSync(promptPath, 'utf8');
        if (!body.includes(task.id)) problem(`${task.id} prompt does not name the task`);
        const role = task.discipline[0].toUpperCase() + task.discipline.slice(1);
        if (!body.includes(`Role: ${role}`)) problem(`${task.id} prompt does not declare ${role}`);
        if (CREDENTIAL_SHAPE.test(body)) problem(`${task.id} prompt contains a credential shape`);
        const blocks = [...body.matchAll(/```bash\n([\s\S]*?)```/gu)].flatMap((match) =>
          match[1]
            .trim()
            .split('\n')
            .map((line) => line.trim()),
        );
        const declared = task.acceptance_commands.map((argv) => argv.join(' '));
        if (JSON.stringify(blocks) !== JSON.stringify(declared)) {
          problem(`${task.id} prompt acceptance block differs from acceptance_commands`);
        }
        for (const path of task.boundary.paths) {
          const base = path.replace(/\/$/u, '');
          if (!body.includes(base) && !body.includes(base.split('/').pop() ?? base)) {
            problem(`${task.id} prompt does not mention boundary path ${path}`);
          }
        }
      }
    }
    for (const record of round.records) {
      if (!coveredByWave.has(record)) problem(`${round.id} record ${record} on no wave`);
    }
  }
  for (const record of campaign.records) {
    if (!coveredByRound.has(record)) problem(`record ${record} on no round`);
  }
  const byId = new Map(campaign.rounds.map((round) => [round.id, round]));
  const visiting = new Set();
  const done = new Set();
  const visit = (id) => {
    if (done.has(id)) return;
    if (visiting.has(id)) {
      problem(`round dependency cycle at ${id}`);
      return;
    }
    visiting.add(id);
    for (const dependency of byId.get(id)?.depends_on ?? []) visit(dependency);
    visiting.delete(id);
    done.add(id);
  };
  for (const round of campaign.rounds) visit(round.id);
  const promptDir = join(campaignDir, 'prompts');
  if (existsSync(promptDir)) {
    const referenced = new Set(
      campaign.rounds.flatMap((round) =>
        round.waves.flatMap((wave) => wave.tasks.map((task) => task.prompt.path)),
      ),
    );
    referenced.add(campaign.prompts.preamble);
    for (const name of readdirSync(promptDir)) {
      if (!referenced.has(`prompts/${name}`)) problem(`orphan prompt prompts/${name}`);
    }
  }
  return { ok: problems.length === 0, id: campaign.id, problems };
}

export function checkCampaignTree(root = process.cwd()) {
  const campaignsRoot = join(resolve(root), 'product/campaigns');
  if (!existsSync(campaignsRoot)) return { ok: true, campaigns: [] };
  const campaigns = readdirSync(campaignsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => checkCampaign(resolve(root), join(campaignsRoot, entry.name)));
  return { ok: campaigns.every((campaign) => campaign.ok), campaigns };
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = checkCampaignTree(process.argv[2] ?? process.cwd());
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = result.ok ? 0 : 1;
}
