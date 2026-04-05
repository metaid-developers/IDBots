import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { SessionTraceRecord } from './sessionTrace';

export interface TranscriptMessageInput {
  id?: string;
  type: string;
  timestamp?: number | null;
  content: string;
  metadata?: Record<string, unknown>;
}

export interface ExportSessionArtifactsInput {
  trace: SessionTraceRecord;
  transcript: {
    sessionId: string;
    title?: string | null;
    messages: TranscriptMessageInput[];
  };
}

export interface ExportSessionArtifactsResult {
  transcriptMarkdownPath: string;
  traceMarkdownPath: string;
  traceJsonPath: string;
}

function normalizeText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

async function writeFile(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content.endsWith('\n') ? content : `${content}\n`, 'utf8');
}

function renderTranscriptMarkdown(input: ExportSessionArtifactsInput): string {
  const title = normalizeText(input.transcript.title)
    || normalizeText(input.trace.session.title)
    || `Session ${normalizeText(input.transcript.sessionId)}`;
  const lines = [
    `# ${title}`,
    `Session ID: ${normalizeText(input.transcript.sessionId)}`,
  ];

  if (input.trace.channel) {
    lines.push(`Channel: ${input.trace.channel}`);
  }
  if (input.trace.session.externalConversationId) {
    lines.push(`External Conversation ID: ${input.trace.session.externalConversationId}`);
  }
  if (input.trace.order?.id) {
    lines.push(`Order ID: ${input.trace.order.id}`);
  }
  if (input.trace.session.peerName || input.trace.session.peerGlobalMetaId) {
    const peerName = input.trace.session.peerName || 'Unknown Peer';
    const peerGlobalMetaId = input.trace.session.peerGlobalMetaId
      ? ` (${input.trace.session.peerGlobalMetaId})`
      : '';
    lines.push(`Peer: ${peerName}${peerGlobalMetaId}`);
  }

  lines.push('');

  for (const message of input.transcript.messages) {
    lines.push(`[${normalizeText(message.type) || 'message'}] ${String(message.content ?? '')}`);
  }

  return lines.join('\n');
}

function renderTraceMarkdown(trace: SessionTraceRecord): string {
  const lines = [
    `# Trace ${trace.traceId}`,
    `Channel: ${trace.channel || 'unknown'}`,
    `Session ID: ${trace.session.id}`,
  ];

  if (trace.session.externalConversationId) {
    lines.push(`External Conversation ID: ${trace.session.externalConversationId}`);
  }
  if (trace.order?.id) {
    lines.push(`Order ID: ${trace.order.id}`);
  }
  if (trace.order?.paymentTxid) {
    lines.push(`Payment TXID: ${trace.order.paymentTxid}`);
  }
  lines.push(`Transcript: ${trace.artifacts.transcriptMarkdownPath}`);
  lines.push(`Trace JSON: ${trace.artifacts.traceJsonPath}`);

  return lines.join('\n');
}

export async function exportSessionArtifacts(
  input: ExportSessionArtifactsInput
): Promise<ExportSessionArtifactsResult> {
  const transcriptMarkdown = renderTranscriptMarkdown(input);
  await writeFile(input.trace.artifacts.transcriptMarkdownPath, transcriptMarkdown);

  await writeFile(
    input.trace.artifacts.traceJsonPath,
    JSON.stringify(input.trace, null, 2)
  );
  await writeFile(
    input.trace.artifacts.traceMarkdownPath,
    renderTraceMarkdown(input.trace)
  );

  return {
    transcriptMarkdownPath: input.trace.artifacts.transcriptMarkdownPath,
    traceMarkdownPath: input.trace.artifacts.traceMarkdownPath,
    traceJsonPath: input.trace.artifacts.traceJsonPath,
  };
}
