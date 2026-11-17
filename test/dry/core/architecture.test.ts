import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { createRequire } from 'module';
import type { build as esbuildBuild } from 'esbuild';

// The bundle runs from test/dry/.build, so the repo root is three levels up.
const ROOT = path.resolve(__dirname, '..', '..', '..');
const SRC = path.join(ROOT, 'src');
const CORE = path.join(SRC, 'core');
const HARNESSES = path.join(SRC, 'harnesses');

function tsFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return tsFiles(full);
    }
    return entry.name.endsWith('.ts') ? [full] : [];
  });
}

/** Every static `from '...'`, side-effect `import '...'`, `require('...')` and dynamic `import('...')` specifier. */
function importSpecifiers(source: string): string[] {
  const patterns = [
    /\b(?:import|export)\s[^'"]*?\sfrom\s*['"]([^'"]+)['"]/g,
    /\bimport\s*['"]([^'"]+)['"]/g,
    /\b(?:require|import)\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  return patterns.flatMap((re) => [...source.matchAll(re)].map((m) => m[1]));
}

test('core never imports from a harness folder', () => {
  assert.ok(fs.existsSync(CORE), 'src/core/ must exist');
  const files = tsFiles(CORE);
  assert.ok(files.length > 0, 'src/core/ must contain source files');
  const offenders: string[] = [];
  for (const file of files) {
    for (const spec of importSpecifiers(fs.readFileSync(file, 'utf8'))) {
      if (!spec.startsWith('.')) {
        continue;
      }
      const resolved = path.resolve(path.dirname(file), spec);
      if (resolved === HARNESSES || resolved.startsWith(HARNESSES + path.sep)) {
        offenders.push(`${path.relative(ROOT, file)} -> ${spec}`);
      }
    }
  }
  assert.deepEqual(offenders, []);
});

test('extension.ts reaches harnesses only through harnesses/index', () => {
  const file = path.join(SRC, 'extension.ts');
  const harnessImports = importSpecifiers(fs.readFileSync(file, 'utf8')).filter((spec) => {
    if (!spec.startsWith('.')) {
      return false;
    }
    const resolved = path.resolve(path.dirname(file), spec);
    return resolved === HARNESSES || resolved.startsWith(HARNESSES + path.sep);
  });
  assert.ok(harnessImports.length > 0, 'extension.ts must import enabledHarnesses from ./harnesses');
  for (const spec of harnessImports) {
    assert.ok(spec === './harnesses' || spec === './harnesses/index', `forbidden harness import in extension.ts: ${spec}`);
  }
});

test('core reaches no harness folder, directly or transitively, in any import syntax', async () => {
  // Loaded at run time: the dry runner bundles this file, and esbuild cannot be bundled.
  const { build } = createRequire(__filename)('esbuild') as { build: typeof esbuildBuild };
  const files = tsFiles(CORE).map((file) => path.relative(ROOT, file).split(path.sep).join('/'));
  assert.ok(files.length > 0, 'src/core/ must contain source files');
  const result = await build({
    stdin: { contents: files.map((file) => `import './${file}';`).join('\n'), resolveDir: ROOT, loader: 'ts' },
    bundle: true,
    write: false,
    metafile: true,
    platform: 'node',
    external: ['vscode'],
    logLevel: 'silent',
  });
  const inputs = Object.keys(result.metafile.inputs).map((input) => input.split(path.sep).join('/'));
  assert.ok(inputs.some((input) => input.startsWith('src/core/')), 'the graph includes core files');
  const reached = inputs.filter((input) => input.startsWith('src/harnesses/') || input === 'src/extension.ts');
  assert.deepEqual(reached, []);
});

test('src/ holds only core, harnesses and extension.ts', () => {
  assert.deepEqual(fs.readdirSync(SRC).sort(), ['core', 'extension.ts', 'harnesses']);
});
