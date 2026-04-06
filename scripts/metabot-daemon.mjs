import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import readline from 'node:readline';

async function main() {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const runtimePath = path.resolve(scriptDir, '..', 'dist-electron', 'metabotRuntime', 'cli.js');
  const runtime = await import(pathToFileURL(runtimePath).href);
  const args = process.argv.slice(2);
  let exitCode = 0;
  let sawInput = false;

  const emitResult = async (stdinText) => {
    const result = await runtime.runMetabotDaemon(args, {
      cwd: process.cwd(),
      env: process.env,
      stdinText,
    });
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    return result.exitCode;
  };

  const rl = readline.createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (!line.trim()) continue;
    sawInput = true;
    exitCode = await emitResult(`${line}\n`);
    if (exitCode !== 0) {
      rl.close();
      break;
    }
  }

  if (!sawInput) {
    exitCode = await emitResult('');
  }

  process.exitCode = exitCode;
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  process.exitCode = 1;
});
