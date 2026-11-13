#!/usr/bin/env node
/**
 * IDBots release runbook.
 *
 * Keeps a small state file at .release-runbook.json so a multi-hour release can
 * be resumed without re-reading every SOP section. Every command is idempotent;
 * sensitive values are never written to the state file.
 *
 * Usage:
 *   node scripts/release-runbook.mjs init <version>
 *   node scripts/release-runbook.mjs status
 *   node scripts/release-runbook.mjs next
 *   node scripts/release-runbook.mjs mark <phase>
 *   node scripts/release-runbook.mjs local
 *   node scripts/release-runbook.mjs check
 *   node scripts/release-runbook.mjs monitor
 *   node scripts/release-runbook.mjs download
 *   node scripts/release-runbook.mjs oss
 *   node scripts/release-runbook.mjs website
 */

import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const STATE_PATH = process.env.RUNBOOK_STATE
  ? resolve(process.env.RUNBOOK_STATE)
  : join(REPO_ROOT, ".release-runbook.json");
const KNOWN_PHASES = ["bump", "local", "ci", "check", "download", "oss", "website"];

export function run(command, args, options = {}) {
  const output = execFileSync(command, args, {
    cwd: options.cwd || REPO_ROOT,
    encoding: "utf8",
    stdio: options.stdio || "pipe",
    ...options.execOptions,
  });
  // stdio:"inherit" streams child output to the terminal and returns null.
  return typeof output === "string" ? output.trim() : "";
}

function nowIso() {
  return new Date().toISOString();
}

function loadState() {
  if (!existsSync(STATE_PATH)) {
    return emptyState();
  }
  const raw = readFileSync(STATE_PATH, "utf8").trim();
  if (!raw) {
    return emptyState();
  }
  return JSON.parse(raw);
}

function emptyState() {
  return {
    version: null,
    tag: null,
    createdAt: null,
    updatedAt: null,
    phases: {},
  };
}

function saveState(state) {
  state.updatedAt = nowIso();
  writeFileSync(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function phaseStarted(state, name) {
  const phase = state.phases[name] || {};
  if (!phase.startedAt) {
    phase.startedAt = nowIso();
  }
  state.phases[name] = phase;
  saveState(state);
}

function phaseFinished(state, name, result = {}) {
  const phase = state.phases[name] || {};
  phase.finishedAt = nowIso();
  phase.result = result;
  state.phases[name] = phase;
  saveState(state);
}

function phaseStatus(state, name) {
  const phase = state.phases[name];
  if (!phase) return "not-started";
  if (!phase.finishedAt) return "in-progress";
  return phase.result && phase.result.ok ? "done" : "failed";
}

function phaseElapsedMs(state, name) {
  const phase = state.phases[name];
  if (!phase || !phase.startedAt) return null;
  const end = phase.finishedAt ? Date.parse(phase.finishedAt) : Date.now();
  return Math.max(0, end - Date.parse(phase.startedAt));
}

function phaseTimings(state) {
  return Object.fromEntries(
    KNOWN_PHASES.map((name) => {
      const ms = phaseElapsedMs(state, name);
      return [name, ms === null ? null : `${Math.round(ms / 1000)}s`];
    }),
  );
}

function getGitSha(ref = "HEAD") {
  return run("git", ["rev-parse", ref]);
}

function getMainStatus() {
  run("git", ["fetch", "origin", "--tags", "--prune"]);
  const local = getGitSha("main");
  const remote = getGitSha("origin/main");
  return { local, remote, synced: local === remote };
}

function ghJson(args) {
  const raw = run("gh", ["api", ...args], { stdio: "pipe" });
  return JSON.parse(raw);
}

async function checkRelease() {
  const state = loadState();
  const tag = state.tag || (state.version ? `v${state.version}` : null);
  if (!tag) {
    console.error("No version initialized. Run: node scripts/release-runbook.mjs init <version>");
    process.exitCode = 1;
    return;
  }

  phaseStarted(state, "check");
  try {
    const mainStatus = getMainStatus();
    const release = ghJson([
      "repos/metaid-developers/IDBots/releases/tags/" + encodeURIComponent(tag),
      "--jq",
      "{tag_name,draft,prerelease,published_at,assets:[.assets[].name]}",
    ]);
    console.log(JSON.stringify({ mainStatus, tag, release }, null, 2));
    phaseFinished(state, "check", {
      ok: mainStatus.synced && !release.draft && !release.prerelease,
      main: mainStatus.local,
      releaseUrl: `https://github.com/metaid-developers/IDBots/releases/tag/${tag}`,
    });
  } catch (error) {
    phaseFinished(state, "check", { ok: false, error: String(error) });
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

async function monitorCi(state, tag) {
  console.log(`Waiting for tag run ${tag} to finish...`);
  const started = Date.now();
  phaseStarted(state, "ci");

  // gh run watch keeps streaming; use it with --exit-status and rely on exit code.
  const child = spawn("gh", [
    "run", "watch", tag, "--repo", "metaid-developers/IDBots", "--exit-status", "--interval", "30",
  ], {
    cwd: REPO_ROOT,
    stdio: "inherit",
  });

  const exitCode = await new Promise((resolve) => {
    child.on("exit", resolve);
  });
  const elapsedMin = Math.round((Date.now() - started) / 60000);
  if (exitCode === 0) {
    console.log(`CI completed successfully in ~${elapsedMin}m`);
    phaseFinished(state, "ci", { ok: true, elapsedMin });
    return;
  }
  phaseFinished(state, "ci", { ok: false, elapsedMin, exitCode });
  process.exitCode = exitCode || 1;
}

function latestTagRunForRef(tag) {
  const runs = JSON.parse(run("gh", ["api",
    "repos/metaid-developers/IDBots/actions/runs?per_page=20",
    "--jq", `[.workflow_runs[] | select(.head_branch=="${tag}") | {id,status,conclusion,created_at}]`]));
  return runs[0] || null;
}

async function monitorCommand(state) {
  const tag = state.tag;
  phaseStarted(state, "ci");
  try {
    const runInfo = latestTagRunForRef(tag);
    if (!runInfo) {
      console.error(`No Actions run found for ref ${tag}`);
      phaseFinished(state, "ci", { ok: false, error: "no run found" });
      process.exitCode = 1;
      return;
    }
    console.log(`Found tag run ${runInfo.id} (${runInfo.status})`);
    await monitorCi(state, String(runInfo.id));
  } catch (error) {
    phaseFinished(state, "ci", { ok: false, error: String(error) });
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

function createInitialState(version) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`Invalid version: ${version}`);
  }
  const state = loadState();
  if (state.version && state.version !== version) {
    throw new Error(`State already initialized for ${state.version}; cannot re-init to ${version}`);
  }
  state.version = version;
  state.tag = `v${version}`;
  state.createdAt = state.createdAt || nowIso();
  saveState(state);
  return state;
}

function verifyLocalGates() {
  const commands = [
    ["pnpm", ["run", "build"]],
    ["pnpm", ["run", "compile:electron"]],
    ["pnpm", ["run", "check:dsh-deps"]],
    ["node", ["--test", "tests/runtimeDependencyContract.test.mjs", "tests/dshRuntimeDepsCheck.test.mjs"]],
    ["node", ["scripts/check-cross-platform-paths.js", "--skip-lint", "--skip-compile"]],
  ];
  for (const [cmd, args] of commands) {
    console.log(`\n$ ${cmd} ${args.join(" ")}`);
    run(cmd, args, { stdio: "inherit" });
  }
}

async function runLocalGates() {
  const state = loadState();
  if (!state.version) {
    console.error("Run init first.");
    process.exitCode = 1;
    return;
  }
  phaseStarted(state, "local");
  try {
    verifyLocalGates();
    const mainJs = join(REPO_ROOT, "dist-electron", "main.js");
    const mainDir = join(REPO_ROOT, "dist-electron", "main");
    if (!existsSync(mainJs) || !existsSync(mainDir)) {
      throw new Error("dist-electron/main.js or dist-electron/main missing after gates");
    }
    console.log("Local gates passed; dist-electron artifacts present");
    phaseFinished(state, "local", { ok: true });
  } catch (error) {
    phaseFinished(state, "local", { ok: false, error: String(error) });
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

function computeSha512Base64(filePath) {
  const hash = createHash("sha512");
  hash.update(readFileSync(filePath));
  return hash.digest("base64");
}

async function downloadArtifacts() {
  const state = loadState();
  const version = state.version;
  const tag = state.tag;
  if (!version || !tag) {
    console.error("Run init first.");
    process.exitCode = 1;
    return;
  }
  phaseStarted(state, "download");
  const assetDir = join(process.env.HOME || homedir(), "Downloads", "working", "IDBots", tag);
  mkdirSync(assetDir, { recursive: true });
  try {
    console.log(`Downloading ${tag} assets into ${assetDir}`);
    const assets = ghJson([
      `repos/metaid-developers/IDBots/releases/tags/${encodeURIComponent(tag)}`,
      "--jq", "[.assets[] | {name,size}]",
    ]);
    const wanted = new Set([
      `IDBots-${version}-arm64.dmg`,
      `IDBots-${version}-x64.dmg`,
      `IDBots.Setup.${version}.exe`,
      "latest-mac.yml",
      "latest-mac-x64.yml",
      "latest.yml",
    ]);
    for (const asset of assets) {
      if (!wanted.has(asset.name)) continue;
      const localPath = join(assetDir, asset.name);
      if (existsSync(localPath) && statSync(localPath).size === asset.size) {
        console.log(`Skip existing ${asset.name} (${asset.size} bytes)`);
        continue;
      }
      run("gh", ["release", "download", tag, "--repo", "metaid-developers/IDBots",
        "--pattern", asset.name, "--dir", assetDir, "--clobber"], { stdio: "inherit" });
    }
    for (const dmgName of [`IDBots-${version}-arm64.dmg`, `IDBots-${version}-x64.dmg`]) {
      const dmgSize = statSync(join(assetDir, dmgName)).size;
      const dmgSha512 = computeSha512Base64(join(assetDir, dmgName));
      console.log(`DMG ${dmgName} size=${dmgSize} sha512=${dmgSha512}`);
    }
    const exeName = `IDBots.Setup.${version}.exe`;
    const exeSize = statSync(join(assetDir, exeName)).size;
    console.log(`EXE size=${exeSize}`);
    phaseFinished(state, "download", { ok: true, assetDir });
  } catch (error) {
    phaseFinished(state, "download", { ok: false, error: String(error) });
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

async function uploadOss() {
  const state = loadState();
  const version = state.version;
  if (!version) {
    console.error("Run init first.");
    process.exitCode = 1;
    return;
  }
  phaseStarted(state, "oss");
  const secretDoc = join(process.env.HOME || homedir(), "Documents", "MetaID_Projects", "servers", "windows-sign-machine.md");
  if (!existsSync(secretDoc)) {
    phaseFinished(state, "oss", { ok: false, error: "windows-sign-machine.md not found" });
    process.exitCode = 1;
    return;
  }
  const doc = readFileSync(secretDoc, "utf8");
  const keyMatch = doc.match(/AccessKey ID[:：]\s*([A-Za-z0-9]+)/);
  const secretMatch = doc.match(/AccessKey Secret[:：]\s*([A-Za-z0-9]{30})/);
  if (!keyMatch || !secretMatch) {
    phaseFinished(state, "oss", { ok: false, error: "cannot parse RAM credentials" });
    process.exitCode = 1;
    return;
  }
  const assetDir = join(process.env.HOME || homedir(), "Downloads", "working", "IDBots", state.tag);
  const python = "/usr/bin/python3";
  const code = `
import hashlib, os, sys, json, time
import oss2
from aliyunsdkcore.client import AcsClient
from aliyunsdkcore.request import CommonRequest
key_id = os.environ["OSS_ACCESS_KEY_ID"]
key_secret = os.environ["OSS_ACCESS_KEY_SECRET"]
bucket = os.environ["OSS_BUCKET"]
endpoint = os.environ["OSS_ENDPOINT"]
b = oss2.Bucket(oss2.Auth(key_id, key_secret), endpoint, bucket)
b.session.trust_env = False
version = os.environ["RUNBOOK_VERSION"]
dirpath = os.environ["RUNBOOK_ASSET_DIR"]
objects = [
  ("IDBots-" + version + "-arm64.dmg", "IDBots-" + version + "-arm64.dmg", "application/octet-stream", 'attachment; filename="IDBots-' + version + '-arm64.dmg"', "public, max-age=31536000, immutable"),
  ("IDBots-" + version + "-x64.dmg", "IDBots-" + version + "-x64.dmg", "application/octet-stream", 'attachment; filename="IDBots-' + version + '-x64.dmg"', "public, max-age=31536000, immutable"),
  ("IDBots-Setup-" + version + ".exe", "IDBots.Setup." + version + ".exe", "application/octet-stream", 'attachment; filename="IDBots-Setup-' + version + '.exe"', "public, max-age=31536000, immutable"),
  ("latest-mac.yml", "latest-mac.yml", "application/x-yaml", "inline", "no-cache, max-age=0, must-revalidate"),
  ("latest-mac-x64.yml", "latest-mac-x64.yml", "application/x-yaml", "inline", "no-cache, max-age=0, must-revalidate"),
  ("latest.yml", "latest.yml", "application/x-yaml", "inline", "no-cache, max-age=0, must-revalidate"),
]
for key, local_name, content_type, disposition, cache in objects:
    local_path = os.path.join(dirpath, local_name)
    if not os.path.exists(local_path):
        raise SystemExit("missing " + local_path)
    b.put_object_from_file(key, local_path, headers={
        "Content-Type": content_type,
        "Content-Disposition": disposition,
        "Cache-Control": cache,
    })
    b.put_object_acl(key, oss2.OBJECT_ACL_PUBLIC_READ)
    head = b.head_object(key)
    assert int(head.content_length) == os.path.getsize(local_path)
    print("uploaded", key)

urls = [
  "https://download.idbots.ai/IDBots-" + version + "-arm64.dmg",
  "https://download.idbots.ai/IDBots-" + version + "-x64.dmg",
  "https://download.idbots.ai/IDBots-Setup-" + version + ".exe",
]

def cdn_request(action):
    req = CommonRequest()
    req.set_accept_format("json")
    req.set_domain("cdn.aliyuncs.com")
    req.set_version("2018-05-10")
    req.set_action_name(action)
    req.set_method("POST")
    return req

client = AcsClient(key_id, key_secret, "cn-hongkong")
req = cdn_request("PushObjectCache")
req.add_query_param("ObjectPath", "\\n".join(urls))
req.add_query_param("Area", "overseas")
raw = client.do_action_with_exception(req).decode()
push_data = json.loads(raw)
task_id = push_data.get("PushTaskId", "")
print("prewarm task", task_id)

query = cdn_request("DescribeRefreshTasks")
if task_id:
    query.add_query_param("TaskId", task_id)
for _ in range(60):
    raw = client.do_action_with_exception(query).decode()
    data = json.loads(raw)
    tasks = data.get("Tasks", {}).get("CDNTask", [])
    if tasks:
        for task in tasks:
            print(task.get("Status"), task.get("Process"), task.get("ObjectPath"))
        if all(t.get("Status") == "Complete" and t.get("Process") == "100%" for t in tasks):
            print("PREWARM_COMPLETE")
            break
    time.sleep(10)
else:
    raise SystemExit("prewarm polling did not complete")
`;
  try {
    const result = execFileSync(python, ["-c", code], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env: {
        ...process.env,
        OSS_ACCESS_KEY_ID: keyMatch[1],
        OSS_ACCESS_KEY_SECRET: secretMatch[1],
        OSS_BUCKET: "fc-console-gen-cn-hongkong-1109466802058619",
        OSS_ENDPOINT: "https://oss-cn-hongkong.aliyuncs.com",
        RUNBOOK_VERSION: version,
        RUNBOOK_TAG: state.tag,
        RUNBOOK_ASSET_DIR: assetDir,
      },
      stdio: "inherit",
    });
    console.log(result || "OSS upload completed");
    phaseFinished(state, "oss", { ok: true, assetDir });
  } catch (error) {
    phaseFinished(state, "oss", { ok: false, error: String(error) });
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

async function main() {
  const [command, arg] = process.argv.slice(2);
  if (!command) {
    console.error("Usage: node scripts/release-runbook.mjs <init|status|next|mark|local|check|monitor|download|oss|website>");
    process.exitCode = 1;
    return;
  }

  if (command === "init") {
    if (!arg) {
      console.error("Usage: init <version>");
      process.exitCode = 1;
      return;
    }
    const state = createInitialState(arg);
    console.log(`Initialized runbook for ${state.tag}; state=${STATE_PATH}`);
    return;
  }

  const state = loadState();
  if (!state.version) {
    console.error("Run init first.");
    process.exitCode = 1;
    return;
  }

  if (command === "status") {
    console.log(JSON.stringify({
      version: state.version,
      tag: state.tag,
      phases: Object.fromEntries(KNOWN_PHASES.map((name) => [name, phaseStatus(state, name)])),
      timings: phaseTimings(state),
      updatedAt: state.updatedAt,
    }, null, 2));
    return;
  }

  if (command === "next") {
    const phaseMap = {
      local: "Run: node scripts/release-runbook.mjs local  (release-branch worktree, after bump)",
      bump: "Commit the package.json/pnpm-lock.yaml bump, post the dev-journal Buzz, merge to main, push, then create annotated tag __TAG__",
      ci: "After the tag is pushed, run: node scripts/release-runbook.mjs monitor",
      check: "Run: node scripts/release-runbook.mjs check",
      download: "Run: node scripts/release-runbook.mjs download",
      oss: "Run: node scripts/release-runbook.mjs oss",
      website: "Verify live update.json: node scripts/release-runbook.mjs website; then run the website SOP for production deploy",
    };
    const next = KNOWN_PHASES.find((name) => phaseStatus(state, name) === "not-started");
    const active = KNOWN_PHASES.find((name) => phaseStatus(state, name) === "in-progress");
    const hint = active
      ? `In progress: ${active}`
      : next
        ? phaseMap[next].replace("__TAG__", state.tag)
        : "All runbook phases done; website SOP remains";
    console.log(hint);
    return;
  }

  if (command === "mark") {
    const phaseName = arg;
    if (!KNOWN_PHASES.includes(phaseName)) {
      console.error(`Unknown phase: ${phaseName}; known=${KNOWN_PHASES.join(", ")}`);
      process.exitCode = 1;
      return;
    }
    phaseFinished(state, phaseName, { ok: true, manual: true });
    console.log(`Marked ${phaseName} done`);
    return;
  }

  if (command === "local") {
    await runLocalGates();
    return;
  }

  if (command === "check") {
    await checkRelease();
    return;
  }

  if (command === "monitor") {
    await monitorCommand(state);
    return;
  }

  if (command === "download") {
    await downloadArtifacts();
    return;
  }

  if (command === "oss") {
    await uploadOss();
    return;
  }

  if (command === "website") {
    console.log("Website/update.json release is handled by the website SOP; this command verifies the live manifest.");
    phaseStarted(state, "website");
    try {
      const url = "https://idbots.ai/update.json";
      const body = run("curl", ["--noproxy", "*", "-fsSL", url]);
      const json = JSON.parse(body);
      const value = json.data.value;
      console.log(JSON.stringify({
        liveVersion: value.version,
        expected: state.version,
        macArmUrl: value.macArm?.url,
        macIntelUrl: value.macIntel?.url,
        windowsUrl: value.windowsX64.url,
      }, null, 2));
      const ok = value.version === state.version;
      phaseFinished(state, "website", { ok });
      if (!ok) {
        console.error(`Live update.json version ${value.version} does not match ${state.version}`);
        process.exitCode = 1;
      }
    } catch (error) {
      phaseFinished(state, "website", { ok: false, error: String(error) });
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
    return;
  }

  console.error(`Unknown command: ${command}`);
  process.exitCode = 1;
}

const isDirectRun = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
