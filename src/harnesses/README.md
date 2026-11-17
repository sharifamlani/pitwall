# Harnesses

One folder per coding agent ("harness"). Core (`src/core/`) never imports from here;
`src/extension.ts` reaches these folders only through `src/harnesses/index.ts`, and
`test/dry/core/architecture.test.ts` fails if that changes.

| Path | Role |
|---|---|
| `<id>/index.ts` | Exports the harness's `HarnessModule`: builds its adapter (and watcher). |
| `<id>/contributes.json` | Its manifest fragment: commands, menus, settings, and `x-harness-enum` entries. |
| `index.ts` | `ALL_HARNESSES` (every harness in the repo) and `enabledHarnesses()`. |
| `enabled.json` | **The one switch.** The ids this build ships, in order. Today `["claude"]`. |

`enabled.json` drives both halves of a build:

- **Runtime.** `enabledHarnesses()` decides which modules activation constructs. A disabled
  harness is never built, so nothing polls or spawns its CLI. Its stored chats and searches stay
  in storage and are skipped wherever they are read (`HarnessRegistry.has(id)`).
- **Manifest.** `node scripts/build-manifest.mjs` merges `manifest/core.contributes.json` with
  each enabled harness's `contributes.json`, in `enabled.json` order, into `package.json`.
  `--check` fails with a diff when `package.json` is out of date.

## Turn a dormant harness back on

Codex, opencode and Pi are in the tree, tested, and switched off. To ship one, add its id to
`enabled.json` (for example `["claude", "codex"]`), run `node scripts/build-manifest.mjs`, and
commit both files. Then change `SHIPPED_HARNESSES` in `test/dry/core/manifest.test.ts` to the same list, or `npm test` fails by design.

## Add an agent

1. Create `src/harnesses/<id>/` with an `index.ts` that exports a `HarnessModule`, and a
   `contributes.json` holding every manifest entry that names this harness.
2. Add the module to `ALL_HARNESSES` in `src/harnesses/index.ts`.
3. Add its id to `src/harnesses/enabled.json`.
4. Run `node scripts/build-manifest.mjs` to regenerate `package.json`.
5. Icons: add its base marks to `resources/icons/harness/base/` and its entry to
   `scripts/generate-harness-icons.mjs`, then run `node scripts/generate-harness-icons.mjs`.
6. Put its tests in `test/dry/harnesses/<id>/`.

## Fragment rules

`scripts/build-manifest.mjs` merges `contributes` objects:

- Object keys merge; arrays concatenate, so each `menus.<menu>` array concatenates.
- `configuration` sections with the same `title` merge their `properties`. A harness adds its
  settings to an existing section (for example `"title": "Agent Commands"`).
- A scalar defined twice with different values is an error.
- A core setting marked `"x-harness-enum": true` (`pitwall.defaultHarness`,
  `pitwall.sessionSearch.harness`) gets one enum value per enabled harness that lists it under
  its fragment's `"x-harness-enum"`, with the label and description given there. A harness that
  cannot run Find Session (opencode) simply leaves that setting out.

An entry belongs in a harness fragment when its id, `when` clause or enum names that harness.
Entries that apply to every harness stay in core and must not name one: the session-row menus
match any native-UI suffix with `viewItem =~ /^(chat|…)(\w+Ui)?$/`, so a new UI harness touches
no row menu.
