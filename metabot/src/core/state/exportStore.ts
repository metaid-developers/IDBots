import { promises as fs } from 'node:fs';
import path from 'node:path';
import { resolveMetabotPaths, type MetabotPaths } from './paths';

export interface ExportStore {
  paths: MetabotPaths;
  ensureLayout(): Promise<MetabotPaths>;
  writeJson(name: string, value: unknown): Promise<string>;
  writeMarkdown(name: string, content: string): Promise<string>;
}

function sanitizeExportName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) {
    throw new Error('Export name is required');
  }

  return trimmed.replace(/[^a-zA-Z0-9._-]+/g, '-');
}

async function ensureExportLayout(paths: MetabotPaths): Promise<void> {
  await fs.mkdir(paths.exportRoot, { recursive: true });
}

async function writeExportFile(filePath: string, content: string): Promise<string> {
  await fs.writeFile(filePath, content, 'utf8');
  return filePath;
}

export function createExportStore(homeDirOrPaths: string | MetabotPaths): ExportStore {
  const paths = typeof homeDirOrPaths === 'string' ? resolveMetabotPaths(homeDirOrPaths) : homeDirOrPaths;

  return {
    paths,
    async ensureLayout() {
      await ensureExportLayout(paths);
      return paths;
    },
    async writeJson(name, value) {
      await ensureExportLayout(paths);
      const filePath = path.join(paths.exportRoot, `${sanitizeExportName(name)}.json`);
      return writeExportFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
    },
    async writeMarkdown(name, content) {
      await ensureExportLayout(paths);
      const filePath = path.join(paths.exportRoot, `${sanitizeExportName(name)}.md`);
      return writeExportFile(filePath, content.endsWith('\n') ? content : `${content}\n`);
    }
  };
}
