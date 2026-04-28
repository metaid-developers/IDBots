export interface CoworkProviderErrorSignalInput {
  proxyLastError?: string | null;
  stderr?: string | null;
}

function normalizeErrorPart(value: string | null | undefined): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function buildCoworkProviderErrorSignal(
  errorMessage: string,
  input: CoworkProviderErrorSignalInput = {},
): string {
  const parts = [
    normalizeErrorPart(errorMessage),
    normalizeErrorPart(input.proxyLastError),
    normalizeErrorPart(input.stderr),
  ].filter(Boolean);

  const uniqueParts: string[] = [];
  for (const part of parts) {
    if (!uniqueParts.includes(part)) {
      uniqueParts.push(part);
    }
  }

  return uniqueParts.join('\n');
}

export function isDeepSeekMissingReasoningContentError(message: string): boolean {
  if (!message) return false;
  const normalized = message.toLowerCase();
  return normalized.includes('reasoning_content')
    && (
      normalized.includes('thinking mode')
      || normalized.includes('deepseek thinking request is missing')
    );
}
