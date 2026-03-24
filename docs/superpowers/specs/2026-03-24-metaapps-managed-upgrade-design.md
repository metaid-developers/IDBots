# IDBots METAAPPs Managed Upgrade Design

## Goal

Define a managed upgrade model for bundled IDBots MetaApps so packaged IDBots releases can:

- install newly bundled MetaApps into the packaged runtime's `userData/METAAPPs`,
- upgrade existing bundled IDBots MetaApps when the bundled version increases,
- avoid overwriting same-version local edits,
- preserve a clean path for future chain-installed and community-installed MetaApps.

This design extends the existing local-launch METAAPPs work without changing the basic runtime boundary:

- development uses repo-root `METAAPPs/`,
- packaged runtime uses `userData/METAAPPs`,
- Cowork and local launching continue to scan the active runtime root only.

## Problem

The current packaged METAAPPs sync model only bootstraps missing app directories from bundled resources into `userData/METAAPPs`. Once a MetaApp directory already exists in `userData`, bundled updates do not replace it.

That behavior is insufficient for bundled IDBots MetaApps because:

- new IDBots versions may ship updated `buzz`, `chat`, or future built-in MetaApps,
- users may reasonably expect packaged built-ins to evolve with the app version,
- a missing upgrade path leaves packaged installs pinned to the first copied MetaApp code forever.

At the same time, the sync model must preserve a deliberate user rule:

- users may modify bundled MetaApp files locally,
- those modifications must survive while the local version remains the same,
- once the bundled IDBots MetaApp version increases, the bundled directory may replace the local copy wholesale.

## Constraints

- A MetaApp is a directory-level unit. Upgrade granularity must be whole-directory replacement, never file-by-file merge.
- Same-version local directories must not be overwritten, even if contents differ.
- Downgrades must not happen automatically.
- Auto-upgrade must only apply to IDBots-managed MetaApps, not community or manual installs.
- Future chain-installed MetaApps must fit the same metadata model.
- The Phase 1 Cowork/local-launch behavior must remain intact.

## Source Model

Every managed MetaApp instance has a source type:

- `bundled-idbots`
- `chain-idbots`
- `chain-community`
- `manual`

These source types imply a management boundary:

- `bundled-idbots` and `chain-idbots` are IDBots-managed sources,
- `chain-community` and `manual` are external sources.

Only IDBots-managed sources participate in automatic IDBots upgrades.

## Identity Model

A local MetaApp must not be identified by directory name alone. Upgrade eligibility must be evaluated using:

- `id`
- `creator-metaid`
- `source-type`

The intent is:

- `id` identifies the app namespace,
- `creator-metaid` distinguishes who owns the app identity,
- `source-type` tells whether IDBots should manage it automatically.

Two MetaApps with the same `id` but different `creator-metaid` are not the same upgrade line and must not silently overwrite each other.

## Metadata Contract

### `APP.md` frontmatter

Each MetaApp root keeps `APP.md` as the primary human-readable manifest. The minimum frontmatter for managed upgrades is:

- `name`
- `description`
- `entry`
- `version`
- `creator-metaid`
- `source-type`

Example:

```md
---
name: buzz-app
description: Browse buzz timelines and open hot/latest/following views
entry: /buzz/app/index.html
version: 1.2.0
creator-metaid: idbots
source-type: bundled-idbots
---
```

`official: true` is intentionally not part of the new contract. The managed/unmanaged distinction comes from `source-type`, not from a vague "official" boolean.

### `metaapps.config.json`

`METAAPPs/metaapps.config.json` provides the machine-readable registry used for packaged sync, future chain install metadata, and update decisions.

Minimum shape:

```json
{
  "version": 1,
  "description": "Default MetaApp configuration for IDBots",
  "defaults": {
    "buzz": {
      "version": "1.2.0",
      "creator-metaid": "idbots",
      "source-type": "bundled-idbots",
      "installedAt": 1774224000000,
      "updatedAt": 1774224000000
    }
  }
}
```

For Phase 1.5, the registry only needs:

- `version`
- `description`
- `defaults`

Each `defaults[appId]` record needs:

- `version`
- `creator-metaid`
- `source-type`
- `installedAt`
- `updatedAt`

The config file is the canonical local install/update registry. `APP.md` remains the human-facing manifest consumed by Cowork routing and local launch selection.

## Bundled IDBots Upgrade Policy

On packaged startup, IDBots compares bundled MetaApps against `userData/METAAPPs`.

For each bundled MetaApp whose `source-type` is `bundled-idbots`, apply the following rules:

### Install rule

If the local app directory does not exist, copy the bundled directory into `userData/METAAPPs/<id>` and write/update the registry entry.

### Upgrade rule

If the local app directory exists, automatic replacement is allowed only when all of the following are true:

- local and bundled `id` match,
- local and bundled `creator-metaid` match,
- local source is IDBots-managed (`bundled-idbots` or `chain-idbots`),
- bundled version is greater than local version.

When those conditions are met, replace the local app by whole-directory overwrite and update the registry entry.

### No-op rules

Do not overwrite when:

- bundled version equals local version,
- bundled version is lower than local version,
- local source is `chain-community`,
- local source is `manual`.

### Conflict rule

If the local directory exists but `creator-metaid` differs from the bundled MetaApp, treat it as a conflict and do not automatically overwrite it.

This prevents silent takeover of a same-name app line owned by a different publisher.

## Why Whole-Directory Replacement Is Required

MetaApps are lightweight application directories, not sparse content bundles. File-level merge would introduce avoidable complexity and risk:

- stale assets could survive after an upgrade,
- renamed files could leave dead references behind,
- partial merges could create half-upgraded apps that fail at runtime.

Whole-directory replacement is simpler and safer:

- each version is a coherent app snapshot,
- upgrades are deterministic,
- rollback and debugging become easier,
- the rule is easy for users to understand.

## Future Chain Install And Update Compatibility

This design deliberately reserves space for future chain-installed MetaApps.

### `chain-idbots`

Future IDBots-published chain MetaApps should install into the same `userData/METAAPPs/<id>` runtime tree and register themselves with:

- the same `id`,
- a `creator-metaid`,
- a version,
- `source-type: chain-idbots`.

This allows future work to decide whether `bundled-idbots` and `chain-idbots` should share one managed upgrade lane.

Phase 1.5 does not need to implement that cross-source upgrade behavior yet. It only needs the metadata model so later implementation does not require a registry redesign.

### `chain-community`

Community chain MetaApps use the same storage pattern and registry shape, but must never be silently overwritten by bundled IDBots updates.

### `manual`

Manual installs are unmanaged by default and must also never be silently overwritten.

## Runtime Read Path

Packaged runtime should continue to read active MetaApps from `userData/METAAPPs`.

This remains important even after managed upgrades because:

- future chain installs need a writable home,
- current local static serving already expects a real filesystem root,
- Cowork prompt building should reflect the locally active version, not the bundled seed copy.

Bundled `METAAPPs` remains the packaged seed source, not the live runtime source of truth.

## Implementation Boundary

This design requires:

- adding `metaapps.config.json` support,
- reading `version`, `creator-metaid`, and `source-type` from `APP.md`,
- classifying local MetaApps as IDBots-managed vs external,
- replacing the current "copy only if missing" packaged sync with the version-driven directory replacement rules above.

This design does not require:

- a MetaApp management UI,
- upgrade toast notifications,
- conflict resolution UI,
- same-version drift repair,
- file-level merge,
- automatic upgrade between `bundled-idbots` and `chain-idbots`,
- chain installation flows yet.

## Test Expectations

The managed upgrade implementation should be covered with tests for at least:

- missing local MetaApp installs successfully,
- higher bundled version replaces local bundled-idbots app,
- same version does not overwrite local changes,
- lower bundled version does not downgrade,
- mismatched `creator-metaid` does not overwrite,
- `chain-community` local app is not overwritten by bundled-idbots,
- `manual` local app is not overwritten by bundled-idbots,
- whole-directory replacement removes files that existed only in the old local version.

## Decision Summary

The approved strategy is:

- allow users to modify bundled MetaApps locally,
- preserve those edits when bundled and local versions are equal,
- replace the entire local MetaApp directory when the bundled IDBots version is newer,
- restrict automatic overwrite to IDBots-managed upgrade lines only,
- reserve a source model that supports future chain-installed MetaApps without redesigning the metadata layer.
