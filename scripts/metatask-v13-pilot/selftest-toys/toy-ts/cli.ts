// Toy S2c "pseudo-passing" adapter — selftest fixture ONLY.
//
// Unlike the S2a/S2b toys this one runs the REAL vendored reference engine
// (vendor/metatask-engine/, read-only) behind the CLI contract — which is
// exactly what an S2c submission is supposed to do.
import { replayMetaTask } from '../vendor/metatask-engine/engine';
import { canonJ } from '../vendor/metatask-engine/canon';
import { readFileSync } from 'node:fs';

const parseArgs = (argv: string[]) => {
  const out: { events?: string; root?: string; now?: number; guard: boolean } = { guard: false };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--guard') out.guard = true;
    else if (flag === '--events' || flag === '--root' || flag === '--now') {
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
  return out;
};

const main = (): number => {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(args.events as string, 'utf-8'));
  } catch (error) {
    process.stderr.write(`invalid events input: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
  const events = Array.isArray(parsed) ? parsed : (parsed as { events?: unknown[] }).events ?? [];
  const options = Array.isArray(parsed) ? {} : ((parsed as { options?: Record<string, unknown> }).options ?? {});
  const now = args.now ?? (typeof options.now === 'number' ? options.now : undefined);
  try {
    const projection = replayMetaTask(events as never[], {
      rootPinId: args.root,
      ...(now !== undefined ? { now } : {}),
    });
    const nodeStates: Record<string, unknown> = {};
    for (const [id, node] of Object.entries(projection.nodeStates)) {
      nodeStates[id] = { status: (node as { status: string }).status };
    }
    process.stdout.write(
      canonJ({ nodeStates, taskComplete: projection.taskComplete, settlement: projection.settlement }).toString('utf-8') + '\n',
    );
    return 0;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
};

process.exit(main());
