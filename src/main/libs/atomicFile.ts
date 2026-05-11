import fs from 'fs';

export interface AtomicFileWriteDeps {
  writeFileSync?: typeof fs.writeFileSync;
  renameSync?: typeof fs.renameSync;
  unlinkSync?: typeof fs.unlinkSync;
  existsSync?: typeof fs.existsSync;
}

export function writeFileAtomicSync(
  filePath: string,
  data: NodeJS.ArrayBufferView,
  deps: AtomicFileWriteDeps = {},
): void {
  const writeFileSync = deps.writeFileSync ?? fs.writeFileSync;
  const renameSync = deps.renameSync ?? fs.renameSync;
  const unlinkSync = deps.unlinkSync ?? fs.unlinkSync;
  const existsSync = deps.existsSync ?? fs.existsSync;
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  let renamed = false;

  try {
    writeFileSync(tempPath, data);
    renameSync(tempPath, filePath);
    renamed = true;
  } finally {
    if (!renamed && existsSync(tempPath)) {
      try {
        unlinkSync(tempPath);
      } catch {
        // Best effort cleanup; preserving the original target is the important part.
      }
    }
  }
}
