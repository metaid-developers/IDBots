// src/cli.ts — MetaTask TS adapter CLI (S2c). Run via `pnpm run -s replay -- ...`
// (tsx); see package.json.
//
// Contract: see README.md (flags, canonJ stdout, exit codes). This base is a
// SKELETON: argument parsing is wired, the adapter body is TODO. The vendored
// engine under vendor/metatask-engine/ is READ-ONLY (see its README).
import { replayMetaTask } from '../vendor/metatask-engine/engine';
import { canonJ } from '../vendor/metatask-engine/canon';
import { readFileSync } from 'node:fs';

interface CliArgs {
  events: string;
  root: string;
  now?: number;
  guard: boolean;
}

const parseArgs = (argv: string[]): CliArgs => {
  const out: Partial<CliArgs> = { guard: false };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--guard') {
      out.guard = true;
    } else if (flag === '--events' || flag === '--root' || flag === '--now') {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`missing value for ${flag}`);
      i += 1;
      if (flag === '--events') out.events = value;
      if (flag === '--root') out.root = value;
      if (flag === '--now') out.now = Number(value);
    } else {
      throw new Error(`unknown argument: ${flag}`);
    }
  }
  if (!out.events || !out.root) throw new Error('--events and --root are required');
  return out as CliArgs;
};

const main = (): number => {
  let args: CliArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
  // TODO(S2c): load the events file (bare array or { events, options }),
  // call replayMetaTask(events, { rootPinId: args.root, now: args.now }),
  // and print canonJ({ nodeStates, taskComplete, settlement }).
  // `guard` maps to strict event-set validation — define its adapter-level
  // behavior in your implementation notes.
  void replayMetaTask;
  process.stderr.write('adapter body is not implemented yet — this is the S2c base skeleton\n');
  void args;
  return 2;
};

process.exit(main());
