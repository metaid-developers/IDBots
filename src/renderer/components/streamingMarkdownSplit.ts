const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;

export interface StreamingMarkdownSplit {
  settledBlocks: string[];
  activeTail: string;
}

const MIN_STREAMING_SPLIT_CHARS = 320;
const MIN_SETTLED_CHUNK_CHARS = 100;

export function splitStreamingMarkdownBlocks(markdown: string): StreamingMarkdownSplit {
  if (!markdown || markdown.length < MIN_STREAMING_SPLIT_CHARS) {
    return { settledBlocks: [], activeTail: markdown || '' };
  }

  const lines = markdown.split('\n');
  const settledBlocks: string[] = [];
  let currentLines: string[] = [];
  let currentChars = 0;
  let openFenceMarker: string | null = null;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    currentLines.push(line);
    currentChars += line.length + 1;

    const fenceMatch = FENCE_RE.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1]!;
      if (!openFenceMarker) {
        openFenceMarker = marker;
      } else if (marker[0] === openFenceMarker[0] && marker.length >= openFenceMarker.length) {
        openFenceMarker = null;
      }
      continue;
    }

    if (openFenceMarker) {
      continue;
    }

    if (line.trim() === '' && currentChars >= MIN_SETTLED_CHUNK_CHARS && i + 1 < lines.length) {
      const nextLine = lines[i + 1]!;
      const nextTrimmed = nextLine.trim();
      // Keep list continuations, indented blocks, tables, and consecutive blank lines together until a clean top-level block starts.
      if (
        nextTrimmed !== ''
        && !nextLine.startsWith('  ')
        && !nextLine.startsWith('\t')
        && !nextTrimmed.startsWith('|')
        && !/^([-*+]|\d+\.)\s/.test(nextTrimmed)
      ) {
        settledBlocks.push(currentLines.join('\n').trimEnd());
        currentLines = [];
        currentChars = 0;
      }
    }
  }

  const activeTail = currentLines.join('\n');
  if (settledBlocks.length === 0) {
    return { settledBlocks: [], activeTail: markdown };
  }
  return { settledBlocks, activeTail };
}
