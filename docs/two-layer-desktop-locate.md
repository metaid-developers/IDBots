# Two-layer desktop locate: AX first, visual fallback

Feature branch: `feat/agent-desktop-ax` (off `upstream/main` @ `6de51ee6`).
Files: `dsh-runtime/plugins/idbots-desktop-ax.mjs`,
`dsh-runtime/lib/generate-runtime-config.mjs` (mount),
`dsh-runtime/test/desktop-ax-plugin.test.mjs`,
`tests/desktopAxLiveHarness.mjs`.

## What the user gets

MetaBot editor → 高级 → **桌面操作（实验）** (the switch keyed on
`cowork.computerUse`) now turns on an AX-first locate layer *with* the driver it
fronts. Nothing else needs to be enabled: the switch already gates the DSH
computer-use backend, and this plugin rides the same branch. The app-level
kill switch (`automation.experimentalEnabled`) still turns both off at once.

## Why AX first

The mounted cua-driver backend locates targets by pixels: capture a screenshot,
let the model read a coordinate, click that coordinate. A few points of error
clicks the neighbouring row. macOS publishes the same window's accessibility
(AX) tree, so a control with a role and a name can be addressed semantically —
and an AX press never moves the user's physical pointer, which is the direction
the existing route guard already enforces.

## Layers

| Layer | When | Cost | Delivery |
|---|---|---|---|
| AX | role/name/text resolves | 2 process calls | `AXPress` / AX attribute write — no focus steal, no pointer movement |
| Visual | no AX match, no addressable ref, or unreadable tree | 1 target read + 1 capture (+1 window lookup) | the tool returns the PNG path and its geometry; the caller clicks through the existing background pixel tool |

Every result carries `layer`; a fallback also carries `reason`
(`no_ax_match` / `ax_unavailable` / `ax_empty_after_retry`) and the full call log.
The layer never silently degrades.

## The two-call budget

The CLI has no "click this role+text" verb, so the naive loop is
`find` → `click` → `find` (three spawns) or `snapshot` → `find` → `click` → `find`
(four, plus a full tree). The plugin collapses act and verify into one spawn by
passing the CLI's own post-condition wait to the acting call:

```
1  find  --window-id w-… --role button --text <label> --first       # resolve + pre-state
2  click @<snapshot>:eN --wait-for "statictext:count=1" --wait-timeout 5000
                                                                     # act + read-back
```

`data.matched_selector` in call 2 is the proof; it becomes
`verification: { state: 'verified', selector, snapshotId }`. An acting call that
returns `ok: true` without the selector is a **failed** verification, and an
action with no expectation is reported `unverified` — never assumed to have
worked.

One exception, measured live: the acting call can fail its wait with a transient
read error (`APP_UNRESPONSIVE`, "Accessibility surface read was incomplete") while
the press actually landed — the DOM advanced but the post-condition poll could not
read the tree. Reporting that as "failed" is a false negative, so the layer does
one **read-only** re-read of the expectation and records
`verified` + `recoveredAfter: <code>` when it shows up. That third spawn happens
only on this failure path; the happy path stays at two calls.

Measured on this machine (macOS 26, agent-desktop 1.1.0, Electron harness,
720×460 window):

| Path | Process calls | Wall time |
|---|---|---|
| `find` → `click` → `find` (pre-feature baseline) | 3 | ≈ 1060 ms |
| `snapshot` → `find` → `click` → `find` | 4 | ≈ 1550 ms |
| this layer, warm | **2** | **592 ms / 567 ms** (two consecutive runs: 408+184, 386+181) |
| this layer, first read of a freshly created Chromium window | 2 | ≈ 2.76 s (find 2544 ms + click 218 ms) |

The cold number is real and is not hidden: the first AX read of a brand-new
Chromium window costs ~2.5 s — the same cold cost the pre-feature snapshot
measured (2563 ms). Warm reads are 386–524 ms, the acting call 181–228 ms.

## Readable-empty vs error

Two failures that must never be conflated:

- **readable empty** — `ok: true`, `total_matches: 0`. The tree answered; the
  element is genuinely not in it (canvas, custom control). This is the only shape
  a bounded retry helps, because a freshly created Chromium window can answer
  empty before its renderer publishes accessibility. Default: 2 retries, 150 ms
  apart — so a canvas target costs three reads before the visual path opens.
- **error** — `ok: false` (`WINDOW_NOT_FOUND`, `PERM_DENIED`, `TIMEOUT`, or an
  unparseable envelope). The tree could not be read at all. Retried only when the
  CLI itself marks `disposition.retry: "safe"`, and reported as `ax_unavailable`
  — never as "no match".

## Where the binary comes from (distribution)

`agent-desktop@1.1.0` is a pure prebuilt CLI: `package.json` has no `main`/
`exports`, the package ships no `.node` addon and no dylib, `require('agent-desktop')`
throws `MODULE_NOT_FOUND`, `process.dlopen()` on the shipped binary fails, and its
Mach-O header is `MH_EXECUTE`. Its ~30 MB of per-platform binaries arrive through
the package's own `postinstall`.

Resolution order (`resolveAgentDesktopBin`):

1. `AGD_BIN` — an explicit absolute path; if it is set but not executable the
   plugin says exactly that instead of silently falling through.
2. Bundled resource — `<dsh-runtime>/node_modules/agent-desktop/bin/agent-desktop-<platform>-<arch>`
   and the packaged twin `<Resources>/dsh-runtime/node_modules/...` (the
   electron-builder `extraResources` entry copies the whole `dsh-runtime` tree,
   filter included, so the dependency travels with the app).
3. `PATH` — a system or global install.

When none matches, the tool fails with `AGENT_DESKTOP_NOT_FOUND`, the full
candidate list with each tier's path, and three fixes (`pnpm --dir dsh-runtime add
agent-desktop`, `AGD_BIN=…`, `npm i -g agent-desktop`). It never surfaces as a
bare `ENOENT` from inside a spawn.

The default install path is a real dependency plus its postinstall:
`dsh-runtime/package.json` declares `agent-desktop`, and
`dsh-runtime/pnpm-workspace.yaml` lists it under `allowBuilds`. **That entry is
load-bearing, not decoration**: pnpm 11 blocks dependency build scripts by default
and the first install failed with `ERR_PNPM_IGNORED_BUILDS: Ignored build scripts:
agent-desktop@1.1.0` until the key was set to `true`. Without it the dependency is
present but the binary is not, and the tool would report "not found" on a machine
where the install "succeeded".

Packaging status: the packaged lookup path is unit-covered with a simulated
`Resources/dsh-runtime` layout, and the live harness resolves through tier ② for
real (`binary=runtime-dependency`). A full `electron-builder` run was **not**
executed in this environment, so the signed/notarized artefact itself is unproven.

## Security gate (identical to the driver it fronts)

`desktop_ax` can change desktop state, so it must never be registered the way the
read-only screenshot tool is (`buildScreenshotAgentTools` mounts unconditionally
on every cowork session). It is a DSH plugin hung on `input.computerUse`, which is
fed by `computerUseProvider` → `metabotAutomationProviders.computer()`, which
checks BOTH levels in this order:

1. app-wide kill switch `automation.experimentalEnabled` (`'0'` disables every bot);
2. per-bot `cowork.computerUse` (`'0'` opts that bot out; missing means on).

A bot-less session (`metabotId: null`) resolves to `false` as well. There is **no
unconditionally mounted AX tool**: the read-only `locate` action lives in the same
plugin and disappears with the same gate. The read-only screenshot tool stays
unconditional and unchanged — it captures pixels and never acts.

`tests/desktopAxComputerUseGate.test.mjs` runs the real gate functions, the real
generator and the real plugin, and asserts the resulting tool list in five
combinations (both on, per-bot off, app off, app-off-overrides-bot-on, bot-less),
plus source drift guards on `main.ts` / `coworkRunner.ts` / the generator so the
gate cannot be weakened silently.

## Route guard

`dsh-runtime/plugins/idbots-cu-route-guard.mjs` is untouched. The new tool exposes
no `delivery_mode`, `scope`, `target`, `drag`, `modifier(s)`, `move_cursor`,
`set_config` or `replay_trajectory` parameter at all, so its six denied routes
cannot be reached through it — a unit test asserts the schema contains none of
those keys. AX delivery is semantic (`AXPress`), and the visual fallback only
*returns* a point; the click stays on the guarded pixel tool.

## ELECTRON_RUN_AS_NODE (the trap that costs an hour)

The IDBots host shell exports `ELECTRON_RUN_AS_NODE=1`. Any Electron binary
started with that variable inherited runs as **plain node**: no GUI app, no
window, and `electron --version` prints the *node* version. Step 1 lost time to
exactly this — the symptom looks like a broken harness, not like an environment
variable.

Two defences:

1. `sanitizeCliEnv()` deletes `ELECTRON_RUN_AS_NODE`, `ELECTRON_NO_ATTACH_CONSOLE`
   and `ELECTRON_ENABLE_LOGGING` from the CLI child environment.
2. `tests/desktopAxLiveHarness.mjs` refuses to run when `process.versions.electron`
   is undefined and prints the exact re-run command:

   ```bash
   env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron tests/desktopAxLiveHarness.mjs
   ```

## Verification

```bash
node --test dsh-runtime/test/desktop-ax-plugin.test.mjs     # 23 tests, no GUI
env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron tests/desktopAxLiveHarness.mjs
```

Live cases (real Electron window, real CLI, real plugin mounted through `apply(ctx)`):

- (a) AX button: `layer=ax`, 2 calls, `verified`, DOM `count=0 → count=1`.
- (b) canvas control with no AX entry: `layer=visual`, `reason=no_ax_match`, the
  CLI captures the window (1576×1056 px, scale 2), the pad is found in the pixels
  (largest connected `#2a2a2a` region: 483×195 px, 89 299 px), the click lands
  (`pad=idle → pad=hit@120,48`), and an independent AX read returns the hit text.
- (c) same target twice: both `layer=ax`, both `verified`, both 2 calls,
  `count=1 → 2 → 3`.

## What the first implementation got wrong

The first cut registered the tool through `coworkRunner`'s memory-tool list with a
`computerUseProvider` gate. That looks equivalent but is not: the switch the owner
flips mounts **DSH runtime backends** through
`generate-runtime-config.mjs`, and a tool registered on the Claude path simply
does not exist in a DSH session — the switch would have appeared to do nothing for
the AX layer. That registration and its two `src/main/libs/desktopAx*.ts` modules
were removed rather than kept alongside the plugin, so exactly one implementation
ships.

## Known limits

- The visual fallback hands back a point; the plugin does not perform the physical
  click itself.
- The first AX read of a fresh Chromium window costs ~2.5 s (cold).
- The fallback captures the window on the primary display.
- `os.tmpdir()` holds the fallback PNG; it is not cleaned up automatically.
