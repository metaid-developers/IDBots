# Dev Log: MetaWeb Official Skills Sync – Iterations and Lessons

**Date:** 2025-03-03  
**Scope:** SDD「从 MetaWeb 同步与下载官方 SKILLs」(Task 8 – MetaWeb 官方技能中心全栈实现).

## Summary

The feature was implemented per SDD, but several issues required multiple rounds of fixes before it behaved correctly in both dev and production. This log records the root causes and lessons so future SDDs or similar integrations can avoid the same pitfalls.

---

## Issue 1: Official Skills List Always Empty ("无可用技能")

### What Happened

- User opened「官方推荐技能」tab; the list showed "无可用技能" even though the API  
  `https://manapi.metaid.io/address/pin/list/1MFi1WM2NXnV3kjdLKaUw7Ad23LSvSD9fY?cursor=0&size=20&path=/protocols/metabot-skill`  
  returned data.

### Root Cause

1. **API response shape**  
   The API returns `{ code, message, data: { list: [...], nextCursor, total } }`. The code was reading `data.list` instead of `data.data.list`, so the list was always empty.

2. **Wrong field names in contentSummary**  
   The chain protocol uses `"skill-file"` (with hyphen) for the skill package URI, not `skillFileUri`. Without parsing `parsed['skill-file']`, `skillFileUri` was empty and the item was skipped.

3. **Creator source**  
   SDD specifies `remoteCreator = item.globalMetaId` (top-level pin object). The code was reading creator from the parsed contentSummary, which may not be present.

4. **PIN ID format**  
   PinId can include a suffix (e.g. `...i0`). The regex `[a-fA-F0-9]+` stopped at the first non-hex character and broke the download URL.

### Fixes

- Use `data.data?.list` (with fallbacks) for the pin list.
- Use `parsed['skill-file']` as the primary source for the skill file URI.
- Use `pinObj.globalMetaId` for `remoteCreator`.
- Extract pinId with `uri.replace(/^metafile:\/\//, '')` to support full pinId strings.

### Lesson

- SDD must specify the exact API response path and field names (e.g. `data.data.list`, `skill-file`, `globalMetaId`). Implement against real API samples or doc.

---

## Issue 2: Downloaded Skill Not in Local List / Wrong Install Path

### What Happened

- After clicking「下载」, the skill did not appear in「本地技能」; the project `SKILLs/` folder and `skills.config.json` were unchanged.

### Root Cause

1. **Install path mismatch**  
   Initially the service always used `userData/SKILLs` (e.g. `~/Library/Application Support/IDBots/SKILLs`). In dev, the user and the SkillManager’s bundled root expect the **project** `SKILLs/`; listing and config were read from a different place than install.

2. **Config structure**  
   The written config did not match the existing `skills.config.json` shape (e.g. missing or wrong `order`, `version`, `creator-metaid`, `installedAt`, `enabled`), so the skill was not recognized or ordered correctly.

### Fixes

- In **dev**: use project SKILLs root (`path.resolve(__dirname, '..', '..')/SKILLs`) for install and config so edits in the repo are visible.
- In **production**: use `userData/SKILLs` only.
- Write config with the full structure: `order`, `version`, `creator-metaid`, `installedAt`, `enabled`; new skills get `order: 0` so they sort first.

### Lesson

- Clarify in SDD: which root is used in dev vs prod, and that dev should use project SKILLs for testability. Document the exact config schema and write logic.

---

## Issue 3: ZIP Unpack Produced Extra Nested Folder

### What Happened

- Result was `SKILLs/metabot-post-buzz/metabot-post-buzz/SKILL.md` instead of `SKILLs/metabot-post-buzz/SKILL.md`.

### Root Cause

- The ZIP from the chain can have one or more nested directories with the same name (e.g. `metabot-post-buzz/metabot-post-buzz/SKILL.md`). Logic that only "unwrapped" a single top-level directory was not enough; or the zip had a single top-level dir and we extracted directly into `targetDir`, creating an extra layer.

### Fix

- Do **not** rely on "single top-level directory" heuristics. After extracting to a temp dir, **find `SKILL.md` in the tree**; the directory that contains `SKILL.md` is the content root. Move **only that directory’s contents** into `SKILLs/<skillName>/`. If `targetDir` already exists, remove it first so no leftover structure remains.

### Lesson

- For "unpack and flatten" behavior, prefer **content-based** rules (e.g. locate a known file like `SKILL.md`) over structure-based rules (e.g. "one folder at top"). Document the expected zip layout in the SDD.

---

## Issue 4: After Download, Switching to「本地技能」Did Not Refresh

### What Happened

- User switched to「本地技能」after installing from「官方推荐」; the new skill did not appear.

### Root Cause

1. List was not refreshed when changing tabs; or install wrote to a different root than the one used for listing.
2. No automatic switch to「本地技能」after install, so the user had to switch manually and sometimes saw stale data.

### Fixes

- On install/sync success: call `skillService.loadSkills()` and `dispatch(setSkills(loaded))`, then `setActiveTab('local')` so the UI shows the local tab with the updated list.
- When `activeTab === 'local'`, run a `useEffect` that loads skills and dispatches so switching to local always shows fresh data.
- After install/sync success in main process, send `skills:changed` so any listener can refresh.

### Lesson

- SDD should state: after a successful install/sync, the UI must refresh the local list and optionally switch to the local tab so the new skill is visible immediately.

---

## Issue 5: Deleted Skill Still Shown as "已安装"

### What Happened

- User removed the skill folder from `SKILLs/` and removed its entry from `skills.config.json`, but in「官方推荐技能」the skill still showed "已安装", blocking re-download and testing.

### Root Cause

1. **Status depended only on config**  
   Status was derived only from `config.defaults[name]`. If the config still had an entry (e.g. in userData when the user had only edited project config), the status stayed "已安装".

2. **Dev vs userData config**  
   For a while the service always read/wrote userData; the user had edited the **project** `skills.config.json`, so the app was reading a different file and the "deleted" state was not visible.

### Fixes

- **Always consider directory existence:**  
  Before computing status, check `skillDirExists = fs.existsSync(getSkillsRoot()/name) && isDirectory`. If `!skillDirExists`, set status to `'download'` regardless of config.
- In **dev**, use project SKILLs (and project `skills.config.json`) so that deleting the folder and config entry in the repo correctly makes the skill show as "下载".

### Lesson

- Status for "installed" must be defined as: **directory exists** and (optionally) config matches. If the directory is missing, always show "download". SDD should state this explicitly.

---

## Checklist for Similar SDDs

- [ ] Document exact API response path and field names; validate with real response.
- [ ] Define dev vs prod paths (project vs userData) and document in SDD.
- [ ] Define config file schema and write order (e.g. order, version, creator-metaid, installedAt, enabled).
- [ ] Define unpack rule by content (e.g. find SKILL.md) rather than only by directory structure.
- [ ] Define post-install UI: refresh list, optional tab switch, and/or IPC event.
- [ ] Define status rules: require both directory existence and config where relevant; deletion of dir must yield "download".
