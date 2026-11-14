import { previewFileUriFromFileUri } from '@openagentinternet/agent-browser-core';
import { buildLocalFileUrl } from '../../renderer/services/localFileUrl';

export type MobileArtifactKind = 'image' | 'pdf' | 'markdown' | 'html' | 'other';

export function artifactFilename(path: string): string {
  return path.replace(/\\/g, '/').split('/').pop() || 'file';
}

export function artifactKind(path: string): MobileArtifactKind {
  const extension = artifactFilename(path).slice(artifactFilename(path).lastIndexOf('.')).toLowerCase();
  if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.avif'].includes(extension)) return 'image';
  if (extension === '.pdf') return 'pdf';
  if (['.md', '.markdown', '.txt'].includes(extension)) return 'markdown';
  if (['.html', '.htm'].includes(extension)) return 'html';
  return 'other';
}

export function artifactBrowserUri(path: string): string | null {
  return artifactKind(path) === 'html'
    ? previewFileUriFromFileUri(buildLocalFileUrl(path))
    : null;
}

export async function fetchArtifactText(
  url: string,
  options: { fetchImpl?: typeof fetch; signal?: AbortSignal } = {},
): Promise<string> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(url, { credentials: 'include', signal: options.signal });
  if (!response.ok) throw new Error(`Artifact request failed (${response.status})`);
  return response.text();
}

export type ArtifactShareResult = 'shared' | 'copied' | 'cancelled';

export interface ArtifactShareDriver {
  share?: (data: { title: string; url: string }) => Promise<void>;
  copy?: (text: string) => Promise<void>;
}

export async function shareArtifactUrl(
  url: string,
  title: string,
  origin: string,
  driver: ArtifactShareDriver,
): Promise<ArtifactShareResult> {
  const absoluteUrl = new URL(url, origin).toString();
  if (driver.share) {
    try {
      await driver.share({ title, url: absoluteUrl });
      return 'shared';
    } catch (error) {
      if ((error as { name?: unknown } | null)?.name === 'AbortError') return 'cancelled';
    }
  }
  if (!driver.copy) throw new Error('Sharing is unavailable');
  await driver.copy(absoluteUrl);
  return 'copied';
}
