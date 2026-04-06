import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

async function main() {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const runtimePath = path.resolve(scriptDir, '..', 'dist-electron', 'metabotRuntime', 'cli.js');
  const runtime = await import(pathToFileURL(runtimePath).href);
  const result = await runtime.runMetabotCli(process.argv.slice(2), {
    cwd: process.cwd(),
    env: process.env,
  });

  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exitCode = result.exitCode;
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  process.exitCode = 1;
});
