import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import { run } from "../scripts/release-runbook.mjs";

const script = resolve(import.meta.dirname, "../scripts/release-runbook.mjs");

function runWithState(dir, args) {
  return execFileSync(process.execPath, [script, ...args], {
    env: {
      ...process.env,
      RUNBOOK_STATE: join(dir, "state.json"),
    },
    encoding: "utf8",
  });
}

test("release-runbook init/status tracks phases and timestamps", () => {
  const dir = mkdtempSync(join(tmpdir(), "release-runbook-test-"));
  try {
    const initOut = runWithState(dir, ["init", "1.2.3"]);
    assert.match(initOut, /v1\.2\.3/);

    const statusOut = runWithState(dir, ["status"]);
    const status = JSON.parse(statusOut);
    assert.equal(status.version, "1.2.3");
    assert.equal(status.tag, "v1.2.3");
    assert.equal(status.phases.check, "not-started");

    const stateFile = readFileSync(join(dir, "state.json"), "utf8");
    const saved = JSON.parse(stateFile);
    assert.equal(saved.version, "1.2.3");
    assert.ok(saved.createdAt);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("release-runbook refuses invalid or conflicting versions", () => {
  const dir = mkdtempSync(join(tmpdir(), "release-runbook-test-"));
  try {
    assert.throws(() => runWithState(dir, ["init", "abc"]), /Invalid version/);
    runWithState(dir, ["init", "2.0.0"]);
    assert.throws(() => runWithState(dir, ["init", "3.0.0"]), /already initialized/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("release-runbook next/mark navigate manual phases", () => {
  const dir = mkdtempSync(join(tmpdir(), "release-runbook-test-"));
  try {
    runWithState(dir, ["init", "4.5.6"]);
    const first = runWithState(dir, ["next"]);
    assert.match(first, /bump/);
    assert.match(first, /v4\.5\.6/);

    runWithState(dir, ["mark", "bump"]);
    const second = runWithState(dir, ["next"]);
    assert.match(second, /local/);

    const status = JSON.parse(runWithState(dir, ["status"]));
    assert.equal(status.phases.bump, "done");
    assert.equal(status.phases.local, "not-started");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("run() trims piped output and tolerates stdio:inherit returning null", () => {
  // execFileSync returns null under stdio:"inherit"; the local/download phases
  // used to crash on .trim() even when the gate command itself succeeded.
  assert.equal(run(process.execPath, ["-e", "console.log('hello')"]), "hello");
  assert.equal(
    run(process.execPath, ["-e", "console.log('hello')"], { stdio: "inherit" }),
    "",
  );
});

test("release-runbook local gates invoke pnpm rather than npm", () => {
  const source = readFileSync(script, "utf8");
  assert.doesNotMatch(source, /\["npm",/);
  assert.match(source, /\["pnpm",\s*\["run",\s*"build"\]\]/);
  assert.match(source, /\["pnpm",\s*\["run",\s*"compile:electron"\]\]/);
  assert.match(source, /\["pnpm",\s*\["run",\s*"check:dsh-deps"\]\]/);
});
