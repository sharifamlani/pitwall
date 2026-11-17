# Harness icons

Session rows use one SVG per harness, theme, and state:

```
<harness>-<theme>-<state>.svg
```

States:

- `working` — blue (D17). The claude icon is a solid dot with a 22%-opacity
  glow ring; the other harnesses show their brand mark with no badge. It
  beats like a heartbeat: motion is the signal, pulsing from full size and
  brightness down to 78% / 72% and back every 1.4s. A contraction never
  clips, and the relaxed frame is the same size as every other row.
  Reduced-motion users get the mark at rest.
- `needs` — orange (D17, reserved for "needs you"): the agent is waiting on
  the user. Claude: a solid dot with a 22% glow ring. Others: the brand mark
  plus an orange dot.
- `finished` — the turn finished. Claude: a solid green dot. Others: the mark
  plus a green dot.
- `idle` — the terminal is not open. Claude: a hollow 1.5px grey ring with
  `fill="none"`. Others: the grey mark, no badge.
- `new` — the brand mark plus a hollow ring for a chat the harness has not
  linked yet.

Themes: `light`, `dark`. The ring behind the needs/finished/new badge is painted in the
sidebar background color, so each state has a light and a dark file.

D17 colours (dark / light): working `#4c9aff` / `#2f7cf6`, needs you
`#f0883e` / `#e0701c`, finished `#3fb950` / `#2da44e`, idle `#6b6f76` /
`#818b98`. `node scripts/check-icon-colours.mjs` asserts them.

A session is `idle` whenever its terminal is not open. That does not depend
on the stored `status`, which only changes when a close event is observed.

Do not edit the generated files. Edit the base marks in `base/` and run:

```bash
npm run generate:icons
```

Base marks come from [Simple Icons](https://simpleicons.org) (CC0 metadata):
the Claude, OpenCode, and OpenAI marks, plus the Pi mark from
[pi.dev](https://pi.dev/logo-auto.svg). A mark gets separate light and dark
files only when the two themes need different fills. Claude Code, OpenAI
Codex, opencode, Pi, and their logos are trademarks of their respective owners.
