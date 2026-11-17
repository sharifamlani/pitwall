#!/usr/bin/env node
/**
 * Generates the session-tree icons from the base harness marks.
 *
 * A tree item can only show one image, so each state is baked into the SVG:
 *
 * - `working`: the whole mark beats like a heartbeat, with no badge — motion
 *   is the signal, and it reads at 16px where a tiny status glyph would not.
 *   It pulses from full size and full brightness down to 78% size and 72%
 *   opacity and back; a contraction never clips, and the resting frame stays
 *   the same size as every other row.
 * - `needs`: the mark plus an orange dot (ROADMAP D17 reserves orange for
 *   "needs you"): the agent is waiting on the user.
 * - `finished`: the mark plus a green dot, so a finished turn gains a badge.
 * - `idle`: the mark recolored grey, no badge.
 *
 * The claude harness is different: its icons are plain D17 status dots
 * (working and needs you: solid with a 22% glow ring; finished: solid; idle:
 * a 1.5px ring with fill="none"). Its `new` icon is a dashed hollow idle-grey ring (no Claude mark or clay).
 * - `new`: the mark plus a hollow ring for a session that has not started.
 *
 * Usage: npm run generate:icons
 * Edit the files under resources/icons/harness/base/ and rerun; never edit
 * the generated files in resources/icons/harness/ directly.
 */
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const baseDir = path.join(root, 'resources', 'icons', 'harness', 'base');
const outDir = path.join(root, 'resources', 'icons', 'harness');

const STATES = ['working', 'needs', 'finished', 'idle', 'new'];

/**
 * ROADMAP D17 status colours. The claude icons are pure status dots in these
 * colours (scripts/check-icon-colours.mjs asserts them); the other harnesses
 * keep their brand mark and take the finished green for their badge.
 */
const D17 = {
  dark: { working: '#4c9aff', needs: '#f0883e', finished: '#3fb950', idle: '#6b6f76' },
  light: { working: '#2f7cf6', needs: '#e0701c', finished: '#2da44e', idle: '#818b98' },
};
const THEMES = ['light', 'dark'];
const RING = { light: '#f3f3f3', dark: '#252526' };
const HARNESSES = [
  { id: 'claude', base: { light: 'claude.svg', dark: 'claude.svg' } },
  {
    id: 'opencode',
    base: { light: 'opencode-light.svg', dark: 'opencode-dark.svg' },
  },
  {
    id: 'codex',
    base: { light: 'codex-light.svg', dark: 'codex-dark.svg' },
  },
  {
    id: 'pi',
    // The mark is colored, so both themes share it.
    base: { light: 'pi.svg', dark: 'pi.svg' },
  },
];

/** Badge geometry inside the 24x24 viewBox. */
const CX = 18.2;
const CY = 18.2;
const RING_R = 5.6;
const BADGE_R = 4.2;

/**
 * The working state animates the whole mark. Scaling around the viewBox
 * center keeps both marks inside the 16px box, and because the beat is a
 * contraction from 100% there is no frame that clips.
 */
const BEAT_CSS =
  '<style>' +
  '.pitwall-mark{transform-box:view-box;transform-origin:center;' +
  'animation:pitwall-beat 1.4s ease-in-out infinite}' +
  '@keyframes pitwall-beat{' +
  '0%,100%{transform:scale(1);opacity:1}' +
  '50%{transform:scale(.78);opacity:.72}}' +
  '@media (prefers-reduced-motion:reduce){.pitwall-mark{animation:none}}' +
  '</style>';

function badge(state, theme) {
  // Idle rows are recognizable by the grey mark itself; no badge is needed
  // on the many sessions that are simply not open.
  if (state === 'idle') {
    return '';
  }

  const ring = `<circle cx="${CX}" cy="${CY}" r="${RING_R}" fill="${RING[theme]}"/>`;

  if (state === 'finished') {
    return `${ring}<circle cx="${CX}" cy="${CY}" r="${BADGE_R}" fill="${D17[theme].finished}"/>`;
  }

  if (state === 'needs') {
    return `${ring}<circle cx="${CX}" cy="${CY}" r="${BADGE_R}" fill="${D17[theme].needs}"/>`;
  }

  // "new": a hollow ring, so it reads as an empty session.
  return (
    `${ring}<circle cx="${CX}" cy="${CY}" r="3.4" fill="none" ` +
    `stroke="#8a8a8a" stroke-width="1.6"/>`
  );
}

/** Wrap everything after the <title> so one animation moves the whole mark. */
function wrapMark(svg) {
  const titleEnd = svg.indexOf('</title>');
  const bodyStart =
    titleEnd === -1 ? svg.indexOf('>') + 1 : titleEnd + '</title>'.length;
  const bodyEnd = svg.lastIndexOf('</svg>');
  return (
    `${svg.slice(0, bodyStart)}<g class="pitwall-mark">` +
    `${svg.slice(bodyStart, bodyEnd)}</g>${svg.slice(bodyEnd)}`
  );
}

/** A claude status icon: a bare D17 dot, 16x16, no brand mark. */
function claudeDot(state, theme) {
  const c = D17[theme][state];
  const open = '<svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" role="img">';
  const title = `<title>Session: ${state}</title>`;
  let body;
  if (state === 'new') {
    // Brand book: no Claude name/mark/clay. A fresh session is a dashed hollow ring in idle grey.
    body = `<circle cx="8" cy="8" r="4" fill="none" stroke="${D17[theme].idle}" stroke-width="1.5" stroke-dasharray="2 1.6"/>`;
  } else if (state === 'working') {
    body =
      `<g class="pitwall-mark"><circle cx="8" cy="8" r="7" fill="${c}" opacity=".22"/>` +
      `<circle cx="8" cy="8" r="4.5" fill="${c}"/></g>${BEAT_CSS}`;
  } else if (state === 'needs') {
    body = `<circle cx="8" cy="8" r="7" fill="${c}" opacity=".22"/><circle cx="8" cy="8" r="4.5" fill="${c}"/>`;
  } else if (state === 'finished') {
    body = `<circle cx="8" cy="8" r="4.5" fill="${c}"/>`;
  } else {
    body = `<circle cx="8" cy="8" r="4" fill="none" stroke="${c}" stroke-width="1.5"/>`;
  }
  return `${open}${title}${body}<!-- generated by scripts/generate-harness-icons.mjs --></svg>
`;
}

for (const harness of HARNESSES) {
  for (const theme of THEMES) {
    let base = fs
      .readFileSync(path.join(baseDir, harness.base[theme]), 'utf8')
      .trim();

    // Give the icon an intrinsic size so it renders crisply at 16px in the
    // tree even when a host doesn't force the dimensions.
    if (!/<svg\b[^>]*\bwidth=/.test(base)) {
      base = base.replace('<svg ', '<svg width="16" height="16" ');
    }

    for (const state of STATES) {
      if (harness.id === 'claude') {
        fs.writeFileSync(
          path.join(outDir, `claude-${theme}-${state}.svg`),
          claudeDot(state, theme)
        );
        continue;
      }
      // An idle session keeps its harness mark but drops the brand color, so
      // "not open" reads at 16px without a badge taking space from the logo.
      let svg =
        state === 'idle'
          ? base.replace(/fill="#[0-9A-Fa-f]{6}"/g, 'fill="#8a8a8a"')
          : base;

      if (state === 'working') {
        svg = wrapMark(svg);
      }

      const extra = state === 'working' ? BEAT_CSS : badge(state, theme);
      svg = svg.replace(
        '</svg>',
        `${extra}<!-- generated by scripts/generate-harness-icons.mjs --></svg>`
      );
      fs.writeFileSync(
        path.join(outDir, `${harness.id}-${theme}-${state}.svg`),
        `${svg}\n`
      );
    }
  }
}

console.log(`Generated ${HARNESSES.length * THEMES.length * STATES.length} harness icons.`);
