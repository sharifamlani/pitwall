# Landing page at getpitwall.dev, with one-click installs for Cursor and VS Code

> Owner: landing-page agent (independent of the build team). Design: [Pitwall landing page canvas](https://claude.ai/artifact/SYBNjvV4QLqeLT1k8GPH2i), v9 approved by Sharif 2026-11-20.
> ROADMAP mapping: Phase 6 (Package + launch). Needs the §3 edit below, approved by Sharif, before any row starts.

```
LANDING PAGE — phase plan
─────────────────────────────────
Phase L1 : Design mockup (canvas v9)       [████████████████████] ✅ (approved)
Phase L1b: GitHub chip + download pop-up   [████████████████████] ✅ (canvas v11)
Phase L2 : Domain getpitwall.dev           [██████████⏸.........] waiting on you (phone number)
Phase L3 : Publish to Open VSX + Marketplace
Phase L4 : Static site + install buttons
Phase L5 : Deploy + end-to-end install walk
```

## Goal

A visitor on getpitwall.dev clicks **Download for Cursor** or **Download for VS Code** and lands on Pitwall's install page inside that editor, one click from installed. If the editor isn't installed or the link isn't handled, the page shows a fallback (store page + `.vsix` download) within 2 seconds.

## How the buttons work

| Button | Link (primary) | Opens | Store that serves it |
|---|---|---|---|
| Download for Cursor | `cursor:extension/sharifamlani.pitwall` | Cursor's extension page for Pitwall | Open VSX (Cursor's marketplace proxy reads Open VSX) |
| Download for VS Code | `vscode:extension/sharifamlani.pitwall` | VS Code's extension page for Pitwall | Visual Studio Marketplace |
| Fallback (both) | `https://github.com/sharifamlani/pitwall/releases/latest/download/pitwall.vsix` | Browser download | GitHub release asset |

Extension ID `sharifamlani.pitwall` comes from `package.json` (`publisher` + `name`). Neither link scheme has official docs: `vscode:extension/<id>` is what the Marketplace's own Install button uses, and Cursor registers `cursor:` the same way. Smoke S3 proves both on a real machine before anything depends on them.

**What this requires from the release (why the §3 edit):** the buttons only work if Pitwall is *in* both stores. Row 6.4 (Open VSX) changes from optional to required, a new row publishes to the VS Code Marketplace, and Q3 ("Open VSX / Marketplace, or `.vsix` only") is answered: **both stores plus the `.vsix`**.

### Proposed ROADMAP §3 edit (Phase 6), for Sharif's approval

| # | Task | Change |
|---|---|---|
| 6.4 | Publish to Open VSX with `OVSX_PAT` | (Optional) → **required**; claim namespace `sharifamlani` first |
| 6.4b | Publish to VS Code Marketplace with `VSCE_PAT` (publisher `sharifamlani`) | **new** |
| 6.3 | `gh release create` with the `.vsix` attached | also attach an unversioned copy `pitwall.vsix` so `releases/latest/download/pitwall.vsix` always works |
| 6.7 | Landing page live at getpitwall.dev with both install buttons and the fallback | **new** |
| 6.8 | Tip jar: `.github/FUNDING.yml` (`github: sharifamlani`, `buy_me_a_coffee: <handle>`) and `"sponsor": {"url": "https://github.com/sponsors/sharifamlani"}` in `package.json` (Sponsor button on the repo and on the extension page in both editors) | **new**; needs Sharif's GitHub Sponsors profile and Buy Me a Coffee page first |
| Q3 | Open VSX / Marketplace, or `.vsix` only | **answered:** both stores + `.vsix` |

## Folder / file structure

```
pitwall/
├── site/                                   NEW: the public landing page, deployed by Vercel
│   ├── _README.md                          what this folder is, how it deploys, who owns it
│   ├── index.html                          the canvas v9 design as static HTML (intro lights,
│   │                                       typewriter hero, live sessions demo, sections)
│   ├── install.js                          button click → download pop-up → editor link →
│   │                                       2 s fallback; tip jar (3 presets, BMC, GitHub Sponsors)
│   ├── stars.js                            GitHub star count for the nav chip (cached fetch)
│   ├── favicon.svg                         the four-dot status row mark
│   └── vercel.json                         static config, security headers, no build step
├── scripts/
│   ├── verify-site.mjs                     NEW: asserts both hrefs, fallback URLs, no console errors
│   └── check-store-listings.mjs            NEW: Open VSX + Marketplace versions == latest tag
├── .github/workflows/release.yml           CHANGED (build team, Phase 6): vsce publish + ovsx publish
│                                           + upload pitwall.vsix alias on tag push
├── ROADMAP.md                              CHANGED: the §3 edit above (after Sharif approves)
└── docs/superpowers/plans/
    └── 2026-11-20-landing-page-getpitwall-dev.md   this plan
```

`release.yml` belongs to the build team's Phase 6 rows; this plan names the requirement, not the code.

## Flowchart

```
+-------------------+     +--------------------------+     +----------------------+
| Visitor opens     | --> | getpitwall.dev (Vercel,  | --> | Intro lights -> hero |
| getpitwall.dev    |     | static site/ folder)     |     | Download buttons     |
+-------------------+     +--------------------------+     +----------+-----------+
                                                                      |
                         +--------------------------------------------+
                         | click
             +-----------+------------+
             v                        v
  +---------------------+   +----------------------+
  | cursor:extension/   |   | vscode:extension/    |
  | sharifamlani.pitwall|   | sharifamlani.pitwall |
  +----------+----------+   +----------+-----------+
             |                         |
     handled?|yes                      |yes
             v                         v
  +---------------------+   +----------------------+
  | Cursor opens the    |   | VS Code opens the    |
  | extension page      |   | extension page       |
  | (Open VSX listing)  |   | (Marketplace listing)|
  +----------+----------+   +----------+-----------+
             | Install                 | Install
             v                         v
       +-----------------------------------------+
       | Pitwall installed -> sidebar appears    |
       +-----------------------------------------+

  no blur within 2 s (editor missing / link not handled)
             |
             v
  +---------------------------------------------------------+
  | Fallback panel: "Didn't open?"                          |
  |  - Open the store page (open-vsx.org / marketplace)     |
  |  - Download pitwall.vsix -> Extensions: Install from    |
  |    VSIX...  (GitHub releases/latest/download)           |
  +---------------------------------------------------------+

Release side (tag vX.Y.Z pushed) --> release.yml --> vsce publish (Marketplace)
                                                 --> ovsx publish (Open VSX) --> Cursor proxy
                                                 --> gh release: pitwall-X.Y.Z.vsix + pitwall.vsix
```

## UI wireframes: the download buttons

**Hero and Download section buttons**

```
BEFORE (canvas v9: placeholder hrefs)        AFTER
[Download for Cursor] [Download for VS Code]  [Download for Cursor] [Download for VS Code]
 href="[CURSOR MARKETPLACE LINK]"             href="cursor:extension/sharifamlani.pitwall"
                                              href="vscode:extension/sharifamlani.pitwall"
```

**State: just clicked**

```
[Opening Cursor…] [Download for VS Code]      ← label swaps for 2 s; page stays put
```

**State: editor didn't open (no window blur within 2 s)**

```
+------------------------------------------------------------+
| Didn't open?                                         [x]   |
| Cursor may not be installed, or it blocked the link.       |
| [Open on Open VSX]   [Download pitwall.vsix]               |
| Then in Cursor: Extensions > ... > Install from VSIX...    |
+------------------------------------------------------------+
  (VS Code variant: "Open on the Marketplace")
```

**State: before v1.0.0 is in the stores**

```
[Download for Cursor] [Download for VS Code]
Coming with v1.0. Until then: [Download the .vsix]   ← the [AVAILABILITY LINE] slot
```

| UI piece | BEFORE | AFTER |
|---|---|---|
| Cursor button | placeholder href | `cursor:extension/sharifamlani.pitwall` + 2 s fallback |
| VS Code button | placeholder href | `vscode:extension/sharifamlani.pitwall` + 2 s fallback |
| Clicked label | none | "Opening Cursor…" / "Opening VS Code…" for 2 s |
| Fallback panel | none | store link + `.vsix` link + install-from-VSIX hint |
| Availability line | placeholder | "Coming with v1.0" until the stores list it, then removed |

## Derisking (in dependency order)

| # | What it proves | Command | Expected | If it fails → |
|---|---|---|---|---|
| S1 | We own the domain and it points at Vercel | `nslookup getpitwall.dev` then `curl -sI https://getpitwall.dev` | an IP from Vercel's range; `HTTP/2 200` (after S5 deploys) | check the order with `get_domain_order`; fix DNS in Vercel → Domains |
| S2 | We can publish to both stores | `npx vsce verify-pat sharifamlani` and `npx ovsx verify-pat sharifamlani` | `The Personal Access Token verification succeeded` (both) | create the Azure DevOps publisher / claim the Open VSX namespace; add the PATs to `.env` and CI secrets |
| S3 | Both link schemes open the editor's extension page (using an already published extension, so it doesn't depend on Pitwall being listed) | in the tester's Cursor test profile: `start cursor:extension/ms-python.python`; in VS Code: `start vscode:extension/ms-python.python` | each editor focuses and shows that extension's page (tester screenshot) | if Cursor ignores it, drop the Cursor deep link and send that button to the Open VSX page + `.vsix` |
| S4 | The fallback fires when no editor handles the link | `node scripts/verify-site.mjs --fallback` (headless Playwright, which has no handlers) | `fallback panel visible after <= 2000 ms` | fix `install.js` blur/visibility timer |
| S5 | The site deploys and serves the right hrefs | `vercel --prod --yes` in `site/`, then `node scripts/verify-site.mjs https://getpitwall.dev` | `cursor href OK · vscode href OK · vsix 302→200 · 0 console errors` | read the Vercel build log; fix the failing assertion |
| S6 | The listings exist at the tag's version (after the v1.0.0 release) | `node scripts/check-store-listings.mjs v1.0.0` | `openvsx 1.0.0 OK · marketplace 1.0.0 OK` | re-run `release.yml`; check publisher and namespace ownership |
| S7 | End to end, real use | tester (real screen, no source): fresh Windows profile → getpitwall.dev → each button → Install | `cursor --list-extensions` and `code --list-extensions` both include `sharifamlani.pitwall` | route the failing step to its owner with the screenshot |

Ground truth after S7: Open VSX API `GET https://open-vsx.org/api/sharifamlani/pitwall` shows `version` = the tag and a download count ≥ 1.

## Evaluation criteria (definition of done; graded by an independent evaluator, not this agent)

| Criterion | Metric + threshold | How measured | Evidence |
|---|---|---|---|
| E1. The domain serves the page | `HTTP/2 200` and the hero h1 present | `curl -sI https://getpitwall.dev`; Playwright snapshot | curl output + snapshot file |
| E2. The Cursor button carries the right link | href equals `cursor:extension/sharifamlani.pitwall` exactly, in both the hero and Download sections | `scripts/verify-site.mjs` | script output line |
| E3. The VS Code button carries the right link | href equals `vscode:extension/sharifamlani.pitwall` exactly, both places | `scripts/verify-site.mjs` | script output line |
| E4. The fallback works | panel visible ≤ 2000 ms after click when unhandled; both its links return 200 (after redirects) | Playwright headless + `curl -sIL` on each link | timings + status codes |
| E5. Pitwall is listed in both stores at the release version | Open VSX and Marketplace `version` == latest tag | `scripts/check-store-listings.mjs` | script output |
| E6. A real user installs from the page in Cursor | 1 click on the page + 1 Install click → `sharifamlani.pitwall` in `cursor --list-extensions`; 3/3 fresh profiles | tester walk, computer use | screenshots + list output ×3 |
| E7. Same in VS Code | → `code --list-extensions` includes it; 3/3 fresh profiles | tester walk | screenshots + list output ×3 |
| E8. The page is clean | 0 console errors, 0 failed network requests on load, at 1440 px and 390 px | Playwright | console + network logs |

E6 and E7 are the end-to-end criteria; S7 is the smoke that feeds them. Close-out: the evaluator's scorecard `| Criterion | Threshold | Result | Evidence | PASS/FAIL |`, with every row PASS.

## Implementation steps (each runs against its smoke)

1. **Domain**: register getpitwall.dev (Vercel, 1 yr, auto-renew); attach it to a new Vercel project rooted at `site/`. → S1
2. **Stores**: create the Marketplace publisher and Open VSX namespace `sharifamlani`; PATs into `.env` (names only in `.env.example`) and CI secrets. → S2
3. **Link proof**: tester runs S3 in its test profiles (never Sharif's own Cursor).
4. **Site**: port canvas v9 to `site/index.html` + `install.js`; write `scripts/verify-site.mjs`. → S4
5. **Deploy**: `vercel --prod`; verify on the live URL. → S5, E1–E4, E8
6. **Release hook** (build team, Phase 6): `release.yml` publishes to both stores and uploads `pitwall.vsix`. → S6, E5
7. **Walk**: tester walks E6/E7 after the v1.0.0 tag; the evaluator grades E1–E8.
8. **Close**: drop the availability line; ROADMAP rows 6.4, 6.4b, 6.7 flipped with SHAs; §6 changelog entry.

## Open items

- **Pre-v1 window:** until v1.0.0 is in the stores, the editor links would open a "not found" page. The availability line plus the `.vsix` fallback cover this; the buttons go live in step 8.
- **Cursor lag:** Cursor's proxy can trail Open VSX by hours (forum reports). E6 is graded ≥ 24 h after the tag.
