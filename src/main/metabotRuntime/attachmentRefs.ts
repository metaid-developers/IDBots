const METAFILE_PREFIX = 'metafile://';

export function normalizeAttachmentRefs(input: unknown[]): string[] {
  if (!Array.isArray(input)) return [];
  return input
    .map((value) => String(value ?? '').trim())
    .filter((value) => value.startsWith(METAFILE_PREFIX) && value.length > METAFILE_PREFIX.length);
}
