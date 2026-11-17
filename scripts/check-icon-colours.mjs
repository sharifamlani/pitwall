#!/usr/bin/env node
/**
 * Asserts the claude status icons use the exact ROADMAP D17 colours and
 * shapes, and that the activity-bar icon is four one-colour dots with the
 * second largest. Exits 1 on any violation.
 *
 * Usage: node scripts/check-icon-colours.mjs
 */
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, 'resources', 'icons', 'harness');
const D17 = {
  dark: { working: '#4c9aff', needs: '#f0883e', finished: '#3fb950', idle: '#6b6f76' },
  light: { working: '#2f7cf6', needs: '#e0701c', finished: '#2da44e', idle: '#818b98' },
};
const problems = [];
const attrs = (svg, name) => [...svg.matchAll(new RegExp(`\\b${name}="([^"]*)"`, 'g'))].map((m) => m[1]);

for (const theme of Object.keys(D17)) {
  for (const [state, hex] of Object.entries(D17[theme])) {
    const file = `claude-${theme}-${state}.svg`;
    let svg;
    try {
      svg = fs.readFileSync(path.join(dir, file), 'utf8');
    } catch {
      problems.push(`${file}: missing`);
      continue;
    }
    const colours = [...attrs(svg, 'fill'), ...attrs(svg, 'stroke')].filter((v) => v !== 'none');
    if (colours.length === 0) problems.push(`${file}: no colour`);
    for (const colour of colours) {
      if (colour.toLowerCase() !== hex) problems.push(`${file}: ${colour} is not ${hex}`);
    }
    const glows = attrs(svg, 'opacity');
    if ((state === 'working' || state === 'needs') && !glows.includes('.22')) {
      problems.push(`${file}: missing 22% glow ring`);
    }
    if ((state === 'finished' || state === 'idle') && glows.length > 0) {
      problems.push(`${file}: ${state} must not carry a glow`);
    }
    if (state === 'idle') {
      if (!attrs(svg, 'fill').includes('none')) problems.push(`${file}: idle must be a ring with fill="none"`);
      if (!attrs(svg, 'stroke-width').includes('1.5')) problems.push(`${file}: idle ring must be 1.5px`);
    }
  }
}

// Brand book: claude status SVGs are circles only, never Claude clay, and `new`
// is a dashed hollow ring in the idle grey.
for (const theme of Object.keys(D17)) {
  for (const state of [...Object.keys(D17[theme]), 'new']) {
    const file = `claude-${theme}-${state}.svg`;
    let svg;
    try {
      svg = fs.readFileSync(path.join(dir, file), 'utf8');
    } catch {
      problems.push(`${file}: missing`);
      continue;
    }
    const shape = /<(path|rect|polygon|polyline|ellipse|line|use|image)\b/i.exec(svg);
    if (shape) problems.push(`${file}: <${shape[1]}> not allowed, circles only`);
    if (/#D97757/i.test(svg)) problems.push(`${file}: contains Claude clay #D97757`);
    if (state === 'new') {
      if (!attrs(svg, 'fill').includes('none')) problems.push(`${file}: new must be hollow (fill="none")`);
      if (attrs(svg, 'stroke-dasharray').length === 0) problems.push(`${file}: new must be dashed`);
      if (!attrs(svg, 'stroke').every((v) => v.toLowerCase() === D17[theme].idle) || attrs(svg, 'stroke').length === 0) {
        problems.push(`${file}: new must be stroked in idle grey ${D17[theme].idle}`);
      }
    }
  }
}

const bar = fs.readFileSync(path.join(root, 'resources', 'icons', 'pitwall-activitybar.svg'), 'utf8');
const circles = [...bar.matchAll(/<circle\b[^>]*>/g)].map((m) => m[0]);
if (circles.length !== 4) {
  problems.push(`pitwall-activitybar.svg: ${circles.length} circles, expected 4`);
} else {
  const radii = circles.map((c) => Number(attrs(c, 'r')[0]));
  if (!radii.every((r, i) => i === 1 || r < radii[1])) problems.push('pitwall-activitybar.svg: 2nd circle must be largest');
}
const barColours = new Set([...attrs(bar, 'fill'), ...attrs(bar, 'stroke')].filter((v) => v !== 'none'));
if (barColours.size !== 1) problems.push(`pitwall-activitybar.svg: ${barColours.size} colours, expected 1`);

if (problems.length > 0) {
  for (const p of problems) console.error(`FAIL ${p}`);
  process.exit(1);
}
console.log('icon colours OK: 8 claude status icons match D17; activity-bar icon is 4 one-colour dots');
