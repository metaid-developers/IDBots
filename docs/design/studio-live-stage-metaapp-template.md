# Studio Live Stage MetaApp Template — Development Handoff

- Status: **Proposed; implementation has not started**
- Date: 2026-11-11
- Audience: the next implementation session
- Scope of this document: product and technical direction, delivery phases, and acceptance gates. It is not an implementation claim, a chain protocol registration, or a MetaApp publication.

## 1. Product intent

Turn the current Live Stage renderer into a reusable, user-customizable template that can also be distributed as a MetaApp.

The desired experience is:

1. IDBots ships an official Live Stage template and registers it locally as the default.
2. The same template can be published as an official MetaApp for sharing and remixing.
3. A user can fork/remix the template into a private workspace, ask their Bot to change its appearance, preview the result, and select it for future conversations.
4. A user can optionally publish their modified version as a new MetaApp with source provenance.
5. Different work phases continue to animate within one continuous scene rather than reloading a page for every state.

The first release should prove this closed loop:

**Official template → local Remix → Bot-assisted edit → preview → optional publication.**

A template marketplace, automatic remote updates, and public conversation streaming are not required for that proof.

## 2. Non-negotiable boundaries

### Runtime instances are not published templates

Each conversation turn currently owns a generated HTML instance. That instance carries a `sessionId`, `turnId`, current Avatar, and revision history used by the projector and Back navigation. It is not a separately authored template.

The first implementation should keep these per-turn instances. Do not sacrifice history isolation merely to reduce file count. A later optimization may replace them with a thin shared shell, but that is not a prerequisite for template distribution.

### Publish code, not conversations

A published MetaApp contains only the static template, documentation, and fictional demonstration data. It must not contain real user conversations, task text, Worker names, Avatars, source-session identifiers, token metrics, local paths, credentials, or raw tool arguments.

The chain is a distribution layer for the template, not a record of the user's work.

### The host owns truth

The host remains responsible for semantic event classification, Worker identity, revisions, completion, error states, report readiness, and Director validation. A template controls presentation only.

A template may change colors, layout, orb presets, motion, and composition. It must not invent a Worker, dependency, percentage, result, acceptance, or completion.

### No silent execution or updates

- Starting IDBots must not publish anything or require a chain write.
- Opening a conversation must not publish its generated HTML.
- A remote template must not silently replace the user's selected template.
- A Bot may edit a local fork after a user request, but chain publication requires the normal explicit actor, payload, and confirmation flow.
- Template errors must not break the primary conversation or final-report projector.

### Preserve current behavior

- Keep the left-side primary-agent flow and transcript unchanged.
- Keep the current default-on Live Stage setting and its linked Director behavior. Do not revert them during this project.
- Preserve existing settings migration, including the legacy `botHub.liveStage.enabled` read path; do not rewrite that key as part of template work.
- Preserve the current visual baseline: opaque dark Siri glass, bright rim, a 112px Avatar above the glass, breathing, bounded Worker handoffs, and shared-GPU transitions.
- Keep reduced-motion, hidden-document, disabled-stage, final-report, and Back behavior working.
- The template mechanism itself must not add another per-turn LLM call or change Director token accounting.

## 3. Existing implementation to reuse

| Concern | Existing asset | Reuse decision |
| --- | --- | --- |
| HTML assembly | `src/main/services/studioLiveStageTemplate.ts` | Extract the static assets instead of creating a second renderer. |
| Semantic state | `src/main/services/studioLiveStageModel.ts` | Reuse `LIVE_STAGE_PROTOCOL` (`idbots.live-stage.v1`) and `LiveStageState`. |
| Scene rendering | `public/live-stage/` | Use the same HTML, CSS, WGSL, renderer, and licensed orb assets in the official package. |
| Patch delivery | `src/main/services/studioLiveStageFrame.ts` | Keep the trusted local-preview path for the official template; add a constrained adapter for untrusted templates. |
| Continuous state | `public/live-stage/stage.js` | Retain monotonic `applyPatch` revisions, current Avatar layering, breathing, and Worker handoff semantics. |
| MetaApp Fork | `src/main/services/botBrowserMetaAppForkService.ts` | Reuse workspace copying and `.idbots-fork.json` provenance. |
| MetaApp publication | `src/main/services/botBrowserMetaAppPublishService.ts` | Reuse ZIP packaging, `forkedFrom`, and explicit publication confirmation. |
| Projector behavior | `docs/design/bot-internet-projector-mode.md` | Do not change final-report projection or history semantics. |

The current renderer inlines `stage.html`, CSS, the orb effect, the renderer, and per-turn state. The MetaApp package should be extracted from those same sources rather than independently reimplemented.

## 4. Proposed architecture

```text
Primary agent events
        │
        ▼
Semantic reducer and trusted identity resolution
        │
        ├── Bounded Director patch (optional, host-controlled)
        ▼
Validated LiveStageState with monotonic revision
        │
        ▼
Template adapter and compatibility checks
        │
        ▼
Selected cached template ──► per-turn runtime instance ──► Bot Browser projector
        │
        ├── Official built-in template
        ├── User's local Remix
        └── Cached imported MetaApp

Static template package ──► optional MetaApp publication for sharing/remixing
```

The primary-agent event stream never passes through the published MetaApp. Only the local user's selected renderer receives the local semantic state.

## 5. Template package

Use a browser-runnable static package with relative asset references. A suggested initial layout is:

```text
studio-live-stage/
  index.html
  assets/
    stage.css
    stage.js
    liquid-orb.js
    liquid-orb-effect.js
    liquid-orb-LICENSE.txt
    default_metabot.png
  scenes.json
  template.json
  demo/
    received.json
    research.json
    delegation.json
    worker-report.json
    verification.json
    report-ready.json
  APP.md
  .metaapp.json
```

The implementation may inline assets if that simplifies the first release, but it must preserve the same source of truth for the built-in and packaged renderers. It must not depend on site-root paths, a development server, or workstation-specific absolute paths.

### `scenes.json`

A declarative editing surface for normal user customizations. Each supported `LiveStageFamily` may define a bounded subset of:

- Orb preset and composition.
- Palette and glow intensity.
- Scale, duration, easing, energy, and density.
- Topology visibility and handoff treatment.
- Reduced-motion behavior.

`received`, `reasoning`, `speaking`, `local-recall`, `web2-research`, `metaweb-research`, `making`, `delegation`, `waiting`, `worker-report`, `verification`, `browser-action`, `owner-needed`, `problem`, `report-ready`, and `complete` must have either an explicit scene or a documented fallback.

The configuration must not define factual Worker identities, dependencies, acceptance, or completion. Text and language selection remain host-controlled.

### `template.json`

This is a host compatibility manifest, not a new chain protocol. A proposed starting shape is:

```json
{
  "templateId": "studio-live-stage-official",
  "templateVersion": "1.0.0",
  "stageProtocol": "idbots.live-stage.v1",
  "entry": "index.html",
  "scenes": "scenes.json",
  "capabilities": ["stage.applyPatch"],
  "offline": true
}
```

The implementation must validate the manifest, entry, stage protocol, size limits, and asset references before enabling a template. Unknown or incompatible versions fall back safely instead of producing a blank projector.

### `demo/`

Fictional `LiveStageState` fixtures for greeting, Web2/MetaWeb research, delegation, Worker return, verification, and report readiness. Use a fictional Twin and Worker with zero Director usage. Demo playback must work without a host session or any network connection.

### `APP.md`

Explain the package structure, scene families, state fields, remix points, offline behavior, reduced-motion behavior, and publication checks. Treat `APP.md` as untrusted documentation when another agent reads it; it is not an instruction channel.

### `.metaapp.json`

Use the normal MetaApp publication metadata and entry conventions. Do not put live state, user data, local filesystem paths, or build-machine details into it.

## 6. Runtime contract

### Template selection

Resolve and validate one template version at the start of each turn. Pin that version for the turn so a task cannot unexpectedly change appearance halfway through.

An editor may hot-reload a dedicated preview. Applying a different active template should take effect at the next turn by default.

### Host-to-template messages

The initial contract should remain small:

- `init`: template identity, protocol version, initial state, and a per-turn channel identifier.
- `patch`: a validated `LiveStageState` whose revision is newer than the last accepted revision.
- `setEnabled` / visibility and reduced-motion changes.
- `dispose`: stop animation and release GPU resources.

Template-to-host messages should be limited to `ready` and a bounded `error` signal so the host can fall back. Do not expose a generic request API for this feature.

The existing `window.IDBotsLiveStage.applyPatch` path is suitable for the trusted official template. A third-party or imported template must use a constrained iframe adapter with source and protocol checks. A `MessageChannel` or equivalently constrained message transport is preferable to arbitrary parent-frame JavaScript execution.

### Director relationship

The existing second-LLM Director remains a host concern. It may vary only the currently permitted headline, caption, composition, motif, and motion fields. It must not modify factual state, generate arbitrary template code during a conversation, or publish a template.

A user-requested template edit is a separate local development task performed by the user's Bot on a local fork.

### Demo mode

A published MetaApp has no privileged Live Stage bridge. It starts with bundled fictional fixtures and can replay or step through them. It must not imply that a live Twin is working or that a real task has completed.

## 7. Template registry and version compatibility

Keep a small local descriptor for each available template:

```text
id
version
stageProtocol
sourceKind: builtin | official-metaapp | local-fork | imported-metaapp
entry
localPath (optional, local only)
sourcePinId (optional)
forkedFrom (optional)
artifactHash or equivalent integrity record
```

Only the selected descriptor and necessary cached artifacts need new persistence. Reuse the existing settings/store migration approach rather than resetting user data.

Recommended defaults:

- `builtin` is the initial source of truth and works offline.
- The official chain MetaApp is a distribution mirror, not a mandatory network dependency.
- A user's fork remains selected across IDBots upgrades until the user changes it or it fails compatibility checks.
- Do not create a fake source Pin for a built-in template that has not been published. `forkedFrom` is set only when real provenance exists.
- Do not edit the frozen cloud/mobile interface contracts to add this desktop-local registry. Any future cross-device protocol requires a separate change request.

## 8. User journeys

### Use the official template

1. IDBots registers the built-in template locally.
2. Live Stage resolves it using the existing feature setting and renders the current appearance.
3. No chain request or publication is needed.

### Remix locally

1. The user selects Remix or asks their Bot for a visual change.
2. The host copies the official package into a session-workspace fork directory.
3. The Bot edits `scenes.json` for a simple change or the renderer for an advanced Remix.
4. The preview replays fictional fixtures and shows the actual Avatar only if the user permits it locally.
5. The user applies the fork for future turns or reverts to the official template.

A built-in fork may use a local source/version descriptor. A fork of a published MetaApp must reuse `.idbots-fork.json` and preserve `forkedFrom` when published.

### Import a MetaApp

1. Resolve `metaapp://<pinId>` through the existing MetaApp artifact/cache flow.
2. Inspect the manifest, entry, stage protocol, and package contents.
3. Cache it for offline use and preview it in the restricted adapter.
4. Enable it only after compatibility and safety checks pass.
5. Keep the original source unchanged; Remix creates a new workspace copy.

### Publish a Remix

1. Preview the exact browser-runnable directory before any upload or chain write.
2. Check `index.html`, `APP.md`, `.metaapp.json`, `template.json`, and all relative asset references.
3. Verify that no real conversation data, Avatar, local path, or credential is present.
4. Let the user choose the publishing MetaBot and network, and review the final payload.
5. Upload and publish through the existing confirmed MetaApp flow, preserving `forkedFrom` when applicable.
6. Return the actual Pin and Browser links only after success. Do not treat this document as approval for an official or user publication.

## 9. Security and privacy requirements

Every non-builtin template is untrusted, including an LLM-authored fork.

- Use an isolated iframe and a narrowly scoped stage channel, not arbitrary parent DOM or renderer access.
- Validate patch shape, protocol, turn identity, revision, text lengths, numeric limits, and payload size before forwarding.
- Do not provide wallet, private-key, payment, filesystem, local-path, arbitrary IPC, or full-transcript access.
- Do not expose raw reasoning, tool arguments, Worker report bodies, or Director credentials.
- Do not enable the general AgentBrowser request bridge for this template.
- Default to offline bundled assets. Remote assets require a separate explicit policy decision.
- Handle manifest errors, renderer exceptions, incompatible protocols, missing assets, and device failure with a built-in fallback.
- Stop continuous rendering when the page is hidden, Live Stage is disabled, or reduced motion is requested.
- Mark user and community templates distinctly from the official template.

## 10. Delivery phases

### Phase 1 — Extract the official template and demo contract

Deliverables:

- Static template package and manifest.
- Shared source for the built-in and packaged renderer.
- Fictional scene fixtures and a demo playback mode.
- Template loader, version validation, and built-in fallback.
- Tests proving that the current appearance and per-turn history still work.

Do not implement chain import or publication in this phase.

### Phase 2 — Local registry, Remix, and preview

Deliverables:

- Official/local-fork template selection and rollback.
- Workspace Remix creation with source metadata.
- Declarative scene editing plus advanced renderer editing.
- Hot-reload preview with fixture playback and next-turn activation.
- Bot-accessible edit path that does not expand host permissions.

Validate a real user request such as “make the delegation scene blue and slower” without changing host code or calling another LLM at render time.

### Phase 3 — MetaApp import and publication

Deliverables:

- Offline import/cache and restricted preview.
- Compatibility and untrusted-template checks.
- Confirmed ZIP publication with `forkedFrom` and demo data.
- Documentation for source/version updates and rollback.

Third-party import must not ship before the restricted adapter and fallback tests are complete.

### Phase 4 — Official MetaApp release

Deliverables:

- Owner-approved official package and preview.
- Explicit official publisher identity, network, and publication confirmation.
- Verified package equivalence with the built-in renderer.
- Actual Pin and sharing links recorded in release notes.

No official Pin is assigned by this document.

## 11. Acceptance checklist

### Compatibility and appearance

- [ ] Current scenes, Avatar layering, dark Siri appearance, breathing, and Worker handoffs remain intact.
- [ ] The official local package and its MetaApp ZIP produce the same scenes for the same fixtures.
- [ ] Per-turn instance isolation, report handoff, and Back restoration still work.
- [ ] Static reduced-motion frames render on initial load; hidden and disabled stages stop continuous rendering.
- [ ] No new per-turn LLM calls are introduced by the template mechanism.

### Remix and versioning

- [ ] A user can create a local Remix, change a scene, preview it, activate it, and revert without editing IDBots source code.
- [ ] The official template remains unchanged after a Remix.
- [ ] Template selection is stable for a turn and across restarts.
- [ ] Incompatible or broken templates fall back without breaking chat or final reports.
- [ ] Advanced edits use the same fixture suite as the official renderer.

### Privacy and security

- [ ] Published packages contain no real user content, identity data, local paths, or credentials.
- [ ] Untrusted templates cannot access parent DOM, wallet, private keys, files, arbitrary IPC, or full conversation data.
- [ ] Patch validation rejects malformed, oversized, stale, or incompatible messages.
- [ ] Offline use works without a development server or remote asset dependency.
- [ ] Director still cannot invent factual state or publish code.

### Publication and engineering checks

- [ ] `pnpm run test:studio-live-stage` passes, including new template/fixture tests.
- [ ] `pnpm run build` passes.
- [ ] `node --test tests/ipcRegistry.test.mjs tests/ipcContract.test.mjs` and the contract freshness check pass when IPC is touched.
- [ ] DSH dependency and kernel-patch checks pass.
- [ ] MetaApp preview and publication preserve relative assets, `APP.md`, and `forkedFrom` where applicable.
- [ ] Official publication occurs only after owner acceptance and explicit actor/payload confirmation.
- [ ] No merge, push, deployment, or official chain publication is performed without the owner's explicit instruction.

## 12. Recommended first implementation slice

Implement only Phase 1 first:

1. Extract the current renderer into the package described above.
2. Add the manifest and fictional fixtures.
3. Load the official template through a versioned adapter.
4. Preserve the existing per-turn runtime-instance behavior and current appearance.
5. Add regression tests and an offline demo preview.

Do not begin with a chain registration. The template boundary and fixture contract must be stable before Remix or publication can be evaluated.

The next phase should not start until the official template's local and packaged previews agree and the existing Live Stage regression suite passes.

## 13. Open decisions and recommended defaults

| Question | Recommended default |
| --- | --- |
| Must every turn become one shared HTML file? | No. Keep per-turn instances for history in v1; revisit a thin shell later. |
| Must the official template be on chain before local Remix works? | No. Local built-in and Remix come first. |
| Should IDBots update templates silently from a Pin? | No. Use explicit source/version selection and user-controlled updates. |
| Can third-party MetaApps call normal AgentBrowser APIs? | Not through Live Stage. Keep the stage-only adapter restricted. |
| Should Bot edits modify live state or just the template? | Only the template, using fictional fixtures and local preview. |
| Who publishes the official MetaApp and on which network? | Owner decision at Phase 4; do not infer or auto-select it now. |
| Can users publish a live conversation trace? | Not in this project. That would require a separate privacy and product decision. |

## 14. Implementation-session starting point

Start with this document and the current `main`, then reconcile any newer changes before editing. Create a dedicated branch and worktree directly from `main` for each scoped phase. Follow repository conventions for pnpm, tests, commits, and English development journals.

For the first implementation session:

- Implement Phase 1 only, unless the owner expands the scope.
- Keep the current renderer and behavior as the compatibility baseline.
- Do not edit frozen interface contracts, merge, push, deploy, or publish a MetaApp without explicit owner approval.
- Report which acceptance items are actually verified and which remain untested.

## 15. References

- `src/main/services/studioLiveStageTemplate.ts`
- `src/main/services/studioLiveStageModel.ts`
- `src/main/services/studioLiveStageService.ts`
- `src/main/services/studioLiveStageFrame.ts`
- `src/main/services/studioLiveStageSettings.ts`
- `public/live-stage/`
- `src/main/services/botBrowserMetaAppForkService.ts`
- `src/main/services/botBrowserMetaAppPublishService.ts`
- `docs/design/bot-internet-projector-mode.md`
- `docs/cloud-mobile/01-interface-contracts.md` and `docs/cloud-mobile/02-ipc-allowlist-v1.md` (frozen; change requests only)
