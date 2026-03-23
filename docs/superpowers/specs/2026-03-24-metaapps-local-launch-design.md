# IDBots METAAPPs Local Launch Design

## Goal

Add a first-phase `METAAPPs` system that behaves like `SKILLs` at the packaging and runtime boundary, but is specialized for opening local MetaID applications in the user's browser from Cowork sessions.

The desired user experience is:

- users can keep built-in MetaApps under `METAAPPs/`,
- packaged installs carry those MetaApps as bundled resources,
- packaged runtime copies bundled MetaApps into `userData/METAAPPs`,
- Cowork can recognize requests such as "open buzz" or "use the chat app",
- the model reads the selected `APP.md`,
- IDBots ensures a local static server is available,
- IDBots opens the resolved `http://127.0.0.1:<port>/<appId>/...` URL in the default browser,
- the assistant reply also includes the opened local URL.

## Constraints

- Phase 1 applies to Cowork only.
- Phase 1 is local-only. No chain sync, official marketplace sync, remote install, update comparison, or conflict handling.
- `METAAPPs` must be treated as a first-class packaged resource, not as an incidental source folder.
- Runtime behavior should follow the same storage pattern as `SKILLs`: dev uses the repo directory; packaged runtime prefers `userData`.
- URL opening must be deterministic and validated by the main process. The model must not be trusted with arbitrary external URLs.
- The local web server must bind to `127.0.0.1` only.
- The implementation must preserve existing Cowork skill routing and prompt behavior outside the new MetaApp path.

## Phase 1 Scope

- Add `METAAPPs` to packaged `extraResources`.
- Add a `MetaAppManager` in the Electron main process to:
  - resolve the active MetaApps root,
  - sync bundled MetaApps into `userData/METAAPPs` in packaged builds,
  - scan `APP.md` files,
  - expose MetaApp records to Cowork prompt builders,
  - watch for local changes and notify the renderer if needed later.
- Define an `APP.md` contract with lightweight frontmatter and readable body guidance.
- Add a Cowork-only MetaApp auto-routing prompt alongside the existing skills prompt.
- Add a main-process local static server that serves files from the active `METAAPPs` root.
- Add a Cowork tool action to open a selected MetaApp path after validation.
- Open the resolved local URL via the existing default-browser shell path and also surface the URL in the assistant response.

## Non-Goals

- no chain-backed MetaApp sync or install flow,
- no `apps.config.json` versioning/conflict system in Phase 1,
- no dedicated MetaApp management UI,
- no automatic support for Scheduled Tasks, private chat daemons, or orchestrator flows,
- no multiple MetaApp opens in a single turn by default,
- no general plugin runtime or remote app execution framework.

## UX Model

### User trigger

Phase 1 only targets Cowork conversations where the user's intent is clearly to enter a local application UI, for example:

- "open buzz"
- "use the chat app"
- "open the app to view hot buzz"

It should not auto-open for informational requests such as:

- "what is buzz"
- "summarize recent buzz activity"
- "explain the chat protocol"

### Cowork behavior

When no manual MetaApp selection exists, Cowork injects a MetaApp auto-routing prompt that lists available MetaApps. The model should:

1. inspect `<available_metaapps>`,
2. choose at most one clearly matching MetaApp,
3. read that app's `APP.md`,
4. construct a validated local target path,
5. call the `open_metaapp` tool,
6. reply with a short confirmation plus the resulting URL.

If multiple MetaApps might match, the model should ask for clarification instead of guessing.

## Storage And Runtime Boundary

### Source root

The repository root contains:

- `METAAPPs/<appId>/APP.md`
- `METAAPPs/<appId>/app/**`

`APP.md` is the registration source for each MetaApp. The folder name is the stable `appId`.

### Packaged resources

`electron-builder.json` should bundle `METAAPPs` through `extraResources`, parallel to `SKILLs`.

Packaged installs therefore include:

- `resources/METAAPPs/**`

This bundled directory acts as the packaged seed source.

### Runtime root

The active runtime root should follow the same rule as `SKILLs`:

- development: repo-root `METAAPPs/`
- packaged: `app.getPath('userData')/METAAPPs`

Packaged startup should call `syncBundledMetaAppsToUserData()` before Cowork sessions need MetaApps. Static serving and URL resolution then prefer the userData copy.

### Why `userData` is the primary packaged root

- packaged resources behave like shipped assets and should remain replaceable,
- future chain sync or install/update flows can write into `userData/METAAPPs` without redesigning the runtime boundary,
- serving from a writable real filesystem path is simpler and more predictable than relying on packaged read-only assets.

## `APP.md` Contract

### Required layout

Each MetaApp root must contain `APP.md`.

Recommended shape:

```md
---
name: buzz-app
description: buzz 是一个链上推特，展示 buzz 协议内容，可查看最新、热门、关注与推荐 buzz
official: true
entry: /buzz/app/index.html
---

# Buzz MetaApp

## When To Use
适合查看 buzz 流、发现热门内容、进入 buzz 社交场景。

## URL Parameters
- `view`: latest | hot | following | recommended
- `author`: 指定作者
- `q`: 搜索关键词

## Examples
- `/buzz/app/index.html`
- `/buzz/app/index.html?view=hot`
```

### Frontmatter fields

Phase 1 relies on lightweight scalar frontmatter only:

- `name`
- `description`
- `entry`
- `official` optional

The body remains human-readable guidance for the model. No complex YAML schema is required in Phase 1.

### `entry` rules

`entry` is an HTTP path, not a filesystem path.

Allowed example:

- `/buzz/app/index.html`

Disallowed examples:

- `app/index.html`
- `/Users/.../METAAPPs/buzz/app/index.html`

Validation rules:

- must start with `/`,
- must start with `/${appId}/`,
- after removing query/hash, it must map safely into `<metaAppsRoot>/<appId>/...`,
- the referenced file must exist.

### Registration behavior

- missing `APP.md`: do not register,
- missing `name` or `description`: fall back to folder name or first non-empty body line,
- missing or invalid `entry`: do not register,
- empty body: register if `entry` is valid, but the model gets less guidance.

Current implications for the existing sample folders:

- `METAAPPs/buzz/APP.md` needs an `entry` frontmatter field,
- `METAAPPs/chat/APP.md` is currently empty and should not register until completed.

## `MetaAppRecord` Model

The main-process registry record should contain:

- `id`: folder name such as `buzz`,
- `name`,
- `description`,
- `isOfficial`,
- `updatedAt`,
- `entry`,
- `appPath`: absolute path to `APP.md`,
- `appRoot`: absolute path to the MetaApp root directory,
- `prompt`: `APP.md` body without frontmatter.

This mirrors the useful parts of `SkillRecord` without introducing Phase 1-only noise such as versioning or enable/disable state.

## Cowork Prompting Model

### Prompt block

Cowork should receive a MetaApp auto-routing prompt parallel to the existing skills prompt. The prompt should:

- instruct the model to scan `<available_metaapps>`,
- tell the model to read exactly one `APP.md` when one MetaApp clearly applies,
- forbid opening a MetaApp when the user only asked for explanation or analysis,
- forbid inventing paths, parameters, or external URLs,
- default to opening at most one MetaApp per turn.

`<available_metaapps>` entries should include:

- `id`
- `name`
- `description`
- `entry`
- `location`

### Why MetaApps should not be merged into skills

`SKILLs` represent model workflows and executable capabilities.

`METAAPPs` represent user-facing local applications that the model may choose to open.

Merging them into one registry would blur two different behaviors:

- execute something,
- open an application UI.

Phase 1 should therefore keep them as parallel prompt systems with different instructions.

## Local Static Server

### Service shape

Add a main-process singleton service, for example `metaAppLocalServer.ts`, responsible for:

- ensuring a localhost static server exists,
- serving only the active `METAAPPs` root,
- returning a reusable base URL such as `http://127.0.0.1:38421`.

### Startup strategy

The server should be demand-started:

- do not start at app boot,
- start when `open_metaapp` needs it,
- reuse the same server until app shutdown.

### Port selection

Use an ephemeral free port on `127.0.0.1`, discovered via the existing free-port helper pattern.

Do not hardcode a fixed port for Phase 1.

### Health endpoint

Expose an internal health route such as:

- `GET /__idbots/metaapps/health`

Response example:

```json
{
  "ok": true,
  "service": "idbots-metaapps",
  "root": "/absolute/path/to/METAAPPs",
  "packaged": true
}
```

This allows `ensureMetaAppServerReady()` to verify that an already known port is still serving the expected `METAAPPs` root.

### Serving rules

The server should:

- bind only to `127.0.0.1`,
- allow `GET` and `HEAD` only,
- serve only paths under `/<appId>/...`,
- safely map request paths into `<metaAppsRoot>/<appId>/...`,
- reject traversal attempts and non-existent files,
- avoid directory listing behavior.

## `open_metaapp` Tool

### Input

The Cowork tool input should remain small and structured:

```json
{
  "appId": "buzz",
  "targetPath": "/buzz/app/index.html?view=hot"
}
```

The model should not provide the full base URL.

### Main-process execution flow

The tool handler should:

1. look up `appId` in `MetaAppManager`,
2. validate `targetPath`,
3. ensure the local MetaApp server is ready,
4. combine `baseUrl + targetPath`,
5. validate that the final URL still targets the local MetaApp server,
6. call `shell.openExternal(finalUrl)`,
7. return structured success/failure data.

### Validation rules

`targetPath` must:

- start with `/`,
- start with `/${appId}/`,
- resolve to a real file under the selected app directory,
- preserve query and hash only after the path portion is validated.

If the model omits a specific page but selected the app correctly, the handler may fall back to the registered `entry`.

### Output

Success result shape:

```json
{
  "success": true,
  "appId": "buzz",
  "name": "buzz-app",
  "url": "http://127.0.0.1:38421/buzz/app/index.html?view=hot"
}
```

Failure result shape:

```json
{
  "success": false,
  "error": "MetaApp not found: buzz"
}
```

## User-Facing Response Contract

Because Phase 1 should both auto-open and show the link, the model's post-tool reply should include:

- which MetaApp was opened,
- the local URL that was opened.

Suggested response shape:

- "Opened `buzz-app`."
- "Link: `http://127.0.0.1:38421/buzz/app/index.html?view=hot`"

If the tool fails, the assistant should explain the failure instead of claiming success.

## Security Boundaries

- only `http://127.0.0.1:<port>/...` URLs may be opened through this flow,
- the model may choose a MetaApp and path, but the main process must validate both,
- no external hosts,
- no arbitrary `file://` access,
- no access outside the active `METAAPPs` root,
- no multiple automatic opens in one turn by default.

## Proposed File Boundaries

Main process:

- `src/main/metaAppManager.ts`
- `src/main/services/metaAppLocalServer.ts`
- `src/main/main.ts` for startup wiring, IPC/tool registration, and cleanup

Shared prompt integration:

- Cowork prompt composition area in the renderer and/or main process, parallel to skill auto-routing

Packaging:

- `electron-builder.json`

Tests:

- `tests/metaAppManager.test.mjs`
- `tests/metaAppLocalServer.test.mjs`
- `tests/metaAppOpenTool.test.mjs`

## Validation Plan

Minimum acceptance for Phase 1:

1. Development mode can discover `METAAPPs/buzz` after `APP.md` is completed.
2. Packaged startup copies bundled MetaApps into `userData/METAAPPs`.
3. `open_metaapp` starts a localhost server if needed.
4. `open_metaapp` rejects invalid paths and traversal attempts.
5. Valid `targetPath` opens the correct local URL in the default browser.
6. Cowork prompt text clearly distinguishes MetaApps from skills.
7. A request such as "open buzz and show hot buzz" results in one MetaApp open with a stable local URL.

## Follow-Up Work After Phase 1

Later phases can add:

- chain-backed MetaApp sync and install flows,
- version and conflict handling,
- dedicated MetaApp management UI,
- structured parameter schemas beyond freeform `APP.md` guidance,
- support in Scheduled Tasks, private chat, or orchestrator flows.
