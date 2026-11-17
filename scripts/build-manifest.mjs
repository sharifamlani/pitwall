#!/usr/bin/env node
/**
 * Builds package.json `contributes` from fragments, so the harnesses named in
 * src/harnesses/enabled.json are the only ones the editor sees.
 *
 *   node scripts/build-manifest.mjs                       # rewrite package.json
 *   node scripts/build-manifest.mjs --check               # exit 1 with a diff if out of date
 *   node scripts/build-manifest.mjs --enabled claude,codex --out /tmp/package.json
 *
 * Merge: manifest/core.contributes.json, then src/harnesses/<id>/contributes.json
 * for each enabled id, in order. Object keys merge, arrays concatenate (so
 * `menus.<id>` arrays concatenate). `configuration` sections with the same
 * `title` merge their `properties`. A scalar defined twice with different
 * values is an error.
 *
 * Harness enums: a core setting marked `"x-harness-enum": true` gets one enum
 * value per enabled harness that declares it under its fragment's
 * `"x-harness-enum": { "<setting>": { "label", "description" } }`. The value
 * is the harness id; the label and description go to `enumItemLabels` and
 * `enumDescriptions`. Both markers are removed from the output.
 *
 * Output is 2-space JSON plus a trailing newline. Exit codes: 0 ok, 1 out of
 * date (--check), 2 bad input.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CORE_FRAGMENT = path.join(ROOT, 'manifest', 'core.contributes.json');
const HARNESSES_DIR = path.join(ROOT, 'src', 'harnesses');
const ENUM_MARKER = 'x-harness-enum';

class InputError extends Error {}

function parseArgs(argv) {
  const options = { check: false, enabled: undefined, out: path.join(ROOT, 'package.json') };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--check') {
      options.check = true;
    } else if (arg === '--enabled' || arg === '--out') {
      const value = argv[++i];
      if (value === undefined) {
        throw new InputError(`${arg} needs a value`);
      }
      if (arg === '--enabled') {
        options.enabled = value.split(',').map((id) => id.trim()).filter(Boolean);
      } else {
        options.out = path.resolve(value);
      }
    } else {
      throw new InputError(`unknown argument: ${arg}`);
    }
  }
  return options;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new InputError(`cannot read ${path.relative(ROOT, file)}: ${error.message}`);
  }
}

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const clone = (value) => JSON.parse(JSON.stringify(value));

/** Merge `source` into `target` in place; `at` names the location for errors. */
function merge(target, source, at, origin) {
  for (const [key, value] of Object.entries(source)) {
    const where = `${at}.${key}`;
    if (!(key in target)) {
      target[key] = clone(value);
    } else if (where === 'contributes.configuration' && Array.isArray(target[key]) && Array.isArray(value)) {
      mergeSections(target[key], value, where, origin);
    } else if (Array.isArray(target[key]) && Array.isArray(value)) {
      target[key].push(...clone(value));
    } else if (isObject(target[key]) && isObject(value)) {
      merge(target[key], value, where, origin);
    } else if (JSON.stringify(target[key]) !== JSON.stringify(value)) {
      throw new InputError(`${origin} redefines ${where}`);
    }
  }
}

/** Settings sections are keyed by title: a fragment adds properties to the section it names. */
function mergeSections(sections, additions, at, origin) {
  for (const section of additions) {
    const existing = sections.find((candidate) => candidate.title === section.title);
    if (existing) {
      merge(existing, section, `${at}[${JSON.stringify(section.title)}]`, origin);
    } else {
      sections.push(clone(section));
    }
  }
}

/** The ids to build: `--enabled`, or src/harnesses/enabled.json. */
function enabledIds(requested) {
  const ids = requested ?? readJson(path.join(HARNESSES_DIR, 'enabled.json'));
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string' || !id)) {
    throw new InputError('enabled harnesses must be a list of ids');
  }
  const seen = new Set();
  for (const id of ids) {
    if (seen.has(id)) {
      throw new InputError(`harness "${id}" is enabled twice`);
    }
    seen.add(id);
  }
  return ids;
}

/** The merged `contributes` for the given harness ids, in their order. */
export function buildContributes(ids) {
  const contributes = clone(readJson(CORE_FRAGMENT));
  const enumEntries = new Map();
  for (const id of ids) {
    const file = path.join(HARNESSES_DIR, id, 'contributes.json');
    if (!fs.existsSync(file)) {
      throw new InputError(`harness "${id}" has no ${path.relative(ROOT, file).replace(/\\/g, '/')}`);
    }
    const { [ENUM_MARKER]: enums = {}, ...fragment } = readJson(file);
    merge(contributes, fragment, 'contributes', `src/harnesses/${id}/contributes.json`);
    enumEntries.set(id, enums);
  }

  const properties = Object.assign({}, ...(contributes.configuration ?? []).map((section) => section.properties ?? {}));
  for (const [id, enums] of enumEntries) {
    for (const key of Object.keys(enums)) {
      if (properties[key]?.[ENUM_MARKER] !== true) {
        throw new InputError(`src/harnesses/${id}/contributes.json fills ${key}, which core does not mark "${ENUM_MARKER}"`);
      }
    }
  }
  for (const [key, setting] of Object.entries(properties)) {
    if (setting[ENUM_MARKER] !== true) {
      continue;
    }
    delete setting[ENUM_MARKER];
    setting.enum ??= [];
    setting.enumItemLabels ??= [];
    setting.enumDescriptions ??= [];
    for (const [id, enums] of enumEntries) {
      const entry = enums[key];
      if (entry) {
        setting.enum.push(id);
        setting.enumItemLabels.push(entry.label ?? id);
        setting.enumDescriptions.push(entry.description ?? '');
      }
    }
  }
  return contributes;
}

/** The text `target` should hold: its own fields (or package.json's) with generated contributes. */
export function buildManifestText(ids, target) {
  const base = readJson(fs.existsSync(target) ? target : path.join(ROOT, 'package.json'));
  base.contributes = buildContributes(ids);
  return `${JSON.stringify(base, null, 2)}\n`;
}

/** A unified diff of two texts, three lines of context. */
export function unifiedDiff(before, after, fromName, toName) {
  const a = before.split('\n');
  const b = after.split('\n');
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  // Longest common subsequence over the differing middle only.
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const width = midB.length + 1;
  const lcs = new Uint32Array((midA.length + 1) * width);
  for (let i = midA.length - 1; i >= 0; i--) {
    for (let j = midB.length - 1; j >= 0; j--) {
      lcs[i * width + j] =
        midA[i] === midB[j] ? lcs[(i + 1) * width + j + 1] + 1 : Math.max(lcs[(i + 1) * width + j], lcs[i * width + j + 1]);
    }
  }
  const ops = [];
  for (let k = 0; k < start; k++) ops.push([' ', a[k], k, k]);
  let i = 0;
  let j = 0;
  while (i < midA.length || j < midB.length) {
    if (i < midA.length && j < midB.length && midA[i] === midB[j]) {
      ops.push([' ', midA[i], start + i, start + j]);
      i++;
      j++;
    } else if (j < midB.length && (i === midA.length || lcs[i * width + j + 1] >= lcs[(i + 1) * width + j])) {
      ops.push(['+', midB[j], start + i, start + j]);
      j++;
    } else {
      ops.push(['-', midA[i], start + i, start + j]);
      i++;
    }
  }
  for (let k = 0; k < a.length - endA; k++) ops.push([' ', a[endA + k], endA + k, endB + k]);

  const lines = [`--- ${fromName}`, `+++ ${toName}`];
  const CONTEXT = 3;
  let k = 0;
  while (k < ops.length) {
    if (ops[k][0] === ' ') {
      k++;
      continue;
    }
    let first = Math.max(0, k - CONTEXT);
    let last = k;
    while (last < ops.length) {
      let next = last;
      while (next < ops.length && ops[next][0] === ' ') next++;
      if (next === ops.length || next - last > CONTEXT * 2) break;
      last = next;
      while (last < ops.length && ops[last][0] !== ' ') last++;
    }
    const end = Math.min(ops.length, last + CONTEXT);
    const hunk = ops.slice(first, end);
    const oldCount = hunk.filter((op) => op[0] !== '+').length;
    const newCount = hunk.filter((op) => op[0] !== '-').length;
    lines.push(`@@ -${hunk[0][2] + 1},${oldCount} +${hunk[0][3] + 1},${newCount} @@`);
    for (const [sign, text] of hunk) lines.push(`${sign}${text}`);
    k = end;
  }
  return lines.join('\n');
}

function main(argv) {
  const options = parseArgs(argv);
  const ids = enabledIds(options.enabled);
  const expected = buildManifestText(ids, options.out);
  const shownPath = path.relative(ROOT, options.out).replace(/\\/g, '/') || options.out;

  if (options.check) {
    const current = fs.existsSync(options.out) ? fs.readFileSync(options.out, 'utf8').replace(/\r\n/g, '\n') : '';
    if (current === expected) {
      console.log(`${shownPath} is up to date (harnesses: ${ids.join(', ')}).`);
      return 0;
    }
    console.log(`${shownPath} is out of date for harnesses ${ids.join(', ')}. Run: node scripts/build-manifest.mjs`);
    console.log(unifiedDiff(current, expected, `${shownPath} (on disk)`, `${shownPath} (generated)`));
    return 1;
  }

  fs.writeFileSync(options.out, expected);
  console.log(`Wrote ${shownPath} (harnesses: ${ids.join(', ')}).`);
  return 0;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    if (error instanceof InputError) {
      console.error(`build-manifest: ${error.message}`);
      process.exitCode = 2;
    } else {
      throw error;
    }
  }
}
