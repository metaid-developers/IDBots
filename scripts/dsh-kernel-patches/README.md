# dsh-runtime kernel patches

Post-install patches applied to `dsh-runtime/node_modules/**` by
`scripts/apply-dsh-kernel-patches.cjs` (wired into the root `postinstall`,
the `check:dsh-deps` gate, and `pnpm run upgrade:dsh`).

The DSH runtime is a nested pnpm package, so root-level
`patches/` setup cannot reach it. Patches here exist only when a shipped
kernel package has a defect we must fix between kernel releases — they are
technical debt that must be rebased or deleted at the next
`pnpm run upgrade:dsh`.

## Naming

`<package-name>+<exact-version>.patch` — the same convention patch-package
uses, e.g. `@deepseek-ai+dsh-win32-process+0.2.0-rc.1.patch`. The apply
script refuses to run a patch whose version differs from the installed
package, so a kernel upgrade without a patch rebase fails loudly instead of
silently shipping an unpatched kernel.

Diff paths are repository-relative (`a/dsh-runtime/node_modules/...`), so
the script applies them with plain `git apply` from the repo root.

## Current patches

### `@deepseek-ai+dsh-win32-process+0.2.1-rc.2.patch`

On Windows the kernel's subprocess-local service launches every tool
subprocess (bash.exe first of all) through a dedicated "Job runner" child,
which creates the target process with raw `CreateProcessW`/`CreateProcessAsUserW`.
Upstream passes creation flags `CREATE_SUSPENDED | CREATE_BREAKAWAY_FROM_JOB`
without `CREATE_NO_WINDOW` (0x08000000), so each console-subsystem target
allocates a visible console window — the "bash.exe black window flashing on
every bash tool call" Windows users reported. The host-side
`windowsHide: true` fixes and the runtime's own `win32-spawn-shim` cannot
reach this path because the runner process uses FFI bindings, not
`child_process`.

The patch ORs `0x08000000` into all three creation-flag call sites
(`spawnCurrentTokenJobProcess` — the ordinary job path the bash tool uses;
`spawnInheritedJobProcess` — restricted-token job spawns; `spawnPipedProcess`
— piped restricted spawns). `CREATE_NO_WINDOW` only suppresses console
allocation; it does not affect GUI windows.

### `@deepseek-ai+dsh-tool-ask-user+0.2.1-rc.2.patch`

Upstream's `ask_user_question` ships a one-line description ("Ask the user a
concise question…") that actively pushes the model toward firing the question
panel cold: observed in production, the bot writes the full background and
recommendation in its (invisible) reasoning and then pops the modal with no
visible context, leaving the user staring at options like "方案A/方案B" with no
idea what is being decided. The downstream chain already supports a per-question
`detail` markdown block — `dsh-user-questions` passes it through, the
idbots-sdk-server bridge forwards it, and the host modal renders it above the
options (that is how exit_plan_mode plan reviews render) — but the stock tool
neither declares `detail` in its schema nor forwards it in `execute()`.

The patch: (1) extends the tool description to require a short visible
explanation (background, why asking, recommendation) in the same assistant
message before the tool call, plus spelling out internal shorthand;
(2) declares the optional `detail` string property so the model can attach that
context to the panel itself; (3) threads `detail` through `execute()` into the
`ctx.userQuestions.ask` payload so it actually reaches the modal;
(4) forces `timeout = -1` inside `execute()` (`IDBots patch (ask-waits-for-human)`)
so a model-supplied timeout cannot close the question panel. The host mounts
the tool with `timeout: -1` as well. An ask stays until a person answers or
the turn is cancelled.

### `@deepseek-ai+dsh-subprocess-local+0.2.1-rc.2.patch`

Incident (2026-09-24, ~1 in 50 sessions): an external tmp cleanup removed the
shared DSH runtime's private `dsh-subprocess-*` spill directory
(`/var/folders/…/T/dsh-subprocess-ysdKLS`) while the process was serving turns.
The next overflowing bash stdout hit `openSync(spillFile, "wx")` ENOENT inside
the socket `data` handler; the uncaught throw killed the whole runtime process
(exit 1, "DSH runtime is not running") and cascaded into every active
conversation for minutes.

**0.1.7-rc.2 upstreamed the containment half of our fix**: `spillAll` now
wraps the open/append path, degrades through `discardSpill()` plus an
`onFailure` reporter, and the collector moved into a stable `lib/output.js`
(no longer a content-hashed runner bundle). The earlier rebase against the
hashed `runner-launch-*.js` for 0.1.5-rc.2 was dropped.

What remains ours is the **self-heal**: on ENOENT the patch recreates the
private spill directory once (`mkdirSync` recursive, 0700) and retries the
open, so full-output recovery keeps working after an external cleanup instead
of silently degrading to the bounded in-memory tail. Regression test:
`dsh-runtime/test/subprocess-spill-resilience.test.mjs` (case A asserts the
healed file holds the complete output; case B asserts the degraded-but-alive
path, which upstream now satisfies on its own).

### `@deepseek-ai+dsh-session-persistence-jsonl+0.2.1-rc.2.patch`

The 0.1.7 V4 session log publishes staged files with a hard `link()` on
every POSIX path (`publishCurrentExclusive` for generation/migration
publish, `materializePosix` for new-log creation). Volumes without hard
links — exFAT/FAT32/SMB — answer ENOTSUP and EVERY session write fails
("ENOTSUP: operation not supported on socket, link …"). Production
userData sits on APFS/NTFS, but IDBots dev loops run on an exFAT external
SSD (`.worktrees` symlink target, repo-local `.dev-userdata-*`), where
this is fatal.

The patch falls back to `copyFile(..., COPYFILE_EXCL)` on ENOTSUP at both
sites: the exclusive-publish semantics (EEXIST → caller decides) are
preserved, and the staged bytes were already fsynced. `copyFile` is added
to the injectable `defaultFileSystem` seam so the internals contract
stays intact.

### `@deepseek-ai+dsh-attachment-local+0.2.1-rc.2.patch`

Same defect class as the persistence patch: `publishImmutableAlias` and
`publishStagedObject` commit attachment objects with `link()` and treat
EEXIST as the only recoverable race. On volumes without hard links every
attachment write fails with ENOTSUP. The patch adds an ENOTSUP branch
that publishes through an exclusive `copyFile`; an existing target races
into the same sha256 digest verification as the EEXIST branch.

### `@deepseek-ai+dsh-experimental-browser-use-runtime+0.2.1-rc.2.patch`

TICKET-2026-09-04. The experimental browser-use provider executes every
Playwright-MCP tool with zero approval — `browser_navigate`/`browser_click`/
`browser_evaluate` act on arbitrary public websites the moment the model
asks. The kernel's fail-closed approval seam (`ctx.approval`,
`dsh-user-approval`) exists but the provider never calls it.

The patch gates the provider's `tools/execute` dispatch (`lib/types/mcp.js`):
any `mcp__<server>__*` call outside the observation set (`browser_snapshot`,
`browser_take_screenshot`, `browser_console_messages`,
`browser_network_requests`, `browser_wait_for`) first asks
`approval.request(...)` and proceeds only on `allowed-once`; a missing
approval service, rejection, cancellation, or unavailable answerer throws
(fail-closed). In IDBots the ask round-trips through idbots-sdk-server's
global answerer into the renderer permission dialog (60s auto-reject),
and session `autoApproveTools` / permission modes short-circuit repeats —
identical semantics to the bash tool. Regression test:
`dsh-runtime/test/automation-approval.test.mjs`.

The same file carries a second, independent fix (2026-10-16,
**lazy-browser-mount**): upstream `agent/created` awaits
`resources.get(agent, signal)`, so every new session's agent creation
blocks on the Playwright MCP spawn + headless Chromium (~1-4s plus a
several-hundred-MB process). Await-less mounting alone is not enough on a
memory-exhausted host — the spawn's allocation spike still fires at
creation time and swap-stalled the whole app ~15s inside every new
session's first turn (IDBots sessions 8d797eb5/c562e576). The patch
therefore DEFERS the background mount to 8s after creation (cancelled on
agent dispose): a chat turn's first sentence never pays the spike, while a
turn that calls a browser tool spawns on demand — `tools/execute`
dispatches through `resources.run`, whose `entry(agent)` acquires the
resource lazily and awaits `entry.ready`, so browser turns pay the spawn at
the call site. A background spawn failure marks the client blocked instead
of failing agent creation. Browser E2E
(`dsh-runtime/test/browser-use.test.mjs`, which navigates on the first
turn) passes unchanged, proving the execute-side wait works.

### `@deepseek-ai+dsh-experimental-computer-use-cua-driver-native+0.2.1-rc.2.patch`

Same ticket, same seam, higher stakes: cua-driver tools inject real input
into the user's physical desktop, which cannot be rolled back. The patch
gates every catalog tool outside the observation set (`list_apps`,
`list_windows`, `get_window_state`, `get_screen_size`) with the same
one-shot `approval.request(...)` in the provider's `tools/execute`
listener, fail-closed on any non-grant. The tool-name prefix is extracted
to a `TOOL_PREFIX` constant so the gate's bare-name lookup cannot drift
from the registration.

### `@deepseek-ai+dsh-llm-deepseek+0.2.1-rc.2.patch`

Truncated tool-call input JSON no longer fails the whole agent turn. The
Messages adapter settles each tool-call block's accumulated `input_json_delta`
with a bare `JSON.parse`; when a gateway truncates the JSON mid-token the
parse throws `MALFORMED_RESPONSE`, which the kernel deliberately excludes
from step-level retry (`DEFAULT_RETRYABLE_CODES`) — every affected turn died
with "DeepSeek Messages stream: tool input is invalid JSON" and only a
host-side one-shot continue (coworkRunner `isMalformedToolCallDshTurnError`)
could rescue it.

The patch settles tool arguments at `content_block_stop` through
`settleToolArguments`: on parse failure a conservative structural repair
(`repairTruncatedJson`) first cuts the text back to the last fully-read
value, drops the incomplete member that owns the truncation, and closes only
the containers still open at that point. Scalars cut mid-token are never
completed — a truncated string/number prefix may be the wrong value, and
running a tool with semantically wrong arguments is worse than failing —
and the repaired text must re-parse to a JSON object before it is used.
Unrepairable input still throws `MALFORMED_RESPONSE`, preserving the host
fallback semantics. Every successful repair is reported through the new
optional `onToolInputRepaired` dependency (wired to `ctx.logger.warn` in
`registerDeepSeekProvider`) so the repair rate stays observable, and the
adapter's public types declare the new optional dependency. Regression
test: `tests/dshDeepseekToolInputRepair.test.mjs`.

### `@deepseek-ai+dsh-compaction-basic+0.2.1-rc.2.patch`

Context-overflow recovery can now succeed on the route that overflowed.
Upstream's `agent/request-error` handler reacts to a `CONTEXT_WINDOW_EXCEEDED`
request failure by compacting once with `retainTokens: 0`, i.e. the region to
summarize is the whole surface minus its last node — and `summarizeWithLlm`
replays that region as the request prefix (system prompt, tools, region
messages, then the compaction instruction) on the same provider/model that
just rejected the request. A summary request sized like the request that
overflowed is rejected the same way, so the recovery fails deterministically,
the turn dies with the original 400, and the next turn repeats the cycle.

Incident (2026-10-27, session `cw-2c70849f`, Command Code gateway route
`commandcode/z-ai/glm-5.3-flash`, declared 1,048,576 window): the gateway
refuses to start a request above roughly 720K upstream-counted tokens
(`400 context_length_exceeded`, "The prompt exceeds the context window this
endpoint can start from. Compact the conversation and retry.") — accepted
cold starts up to 623,755 and a warm continuation at 716,532, rejected at
~730K. The kernel's proactive threshold for that route was 838,860, so
pressure compaction never fired; turns 182/184/186 each died with the request
400 followed two seconds later by the identical compaction 400. Only the
host's fallback-brain switch (DeepSeek, 1M real window) carried the turns,
and the session recovered only when DeepSeek's own pressure compaction ran.

The patch keeps the first attempt unchanged and adds a shrink ladder: when the
summarization itself fails with a context-window overflow (`code ===
CONTEXT_WINDOW_EXCEEDED` on the cause chain, or overflow wording in the
rendered chain), `overflowShrinkRetainTokens` computes the retained-tail budget
whose `selectCompactableRange` result is the OLDER half of the region (tail +
newer half retained verbatim), re-measures, and retries — up to four rungs
(1/2, 1/4, 1/8, 1/16). A successful rung replaces only the older span with a
checkpoint, after which the kernel's existing `{ kind: "retry" }` resends the
request against the shrunken surface. Non-overflow errors, cancellation, and
an unshrinkable (single-node) region rethrow immediately so the original
request error is preserved exactly as upstream does. The two helpers are
exported for the regression test `tests/dshCompactionOverflowShrink.test.mjs`,
which drives the real patched engine with a stubbed `compactRegion`.

## Adding / rebasing a patch

1. Edit the installed file under `dsh-runtime/node_modules/<pkg>/` directly.
2. Regenerate the diff against the pristine package (reinstall the package
   in a scratch dir or reverse your edit) with repo-relative `a/` `b/`
   labels and save it here as `<name>+<installed-version>.patch`.
3. Run `node scripts/apply-dsh-kernel-patches.cjs` — it must report
   "already applied", and `--check` must pass.
4. On the next `pnpm run upgrade:dsh`, delete or rebase each patch; the
   script fails the upgrade until every patch matches the new versions.
5. **Register the patch's fingerprint in `manifest.json`** (same directory):
   the target file (package-relative), the exact marker its applied form
   leaves behind, and the marker's exact occurrence count — plus
   `platforms: [...]` when the defect only exists on one OS. Deleting a patch
   means deleting its entry. `pnpm run check:dsh-deps` fails while a `.patch`
   has no entry, and CI verifies every entry against the packaged app on each
   OS (`node scripts/verify-dsh-kernel-patches.cjs --root <resources dir>`;
   `--list` prints the current manifest, `--platform` lets a non-Windows
   machine check Windows-scoped markers). Keep the count exact: a
   half-applied patch must fail the gate, not silently pass.
