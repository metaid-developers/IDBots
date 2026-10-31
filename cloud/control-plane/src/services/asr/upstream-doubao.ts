import { randomUUID } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import { WebSocket } from 'ws';
import type { AsrUpstreamEvent, AsrUpstreamProvider, AsrUpstreamSession } from './types.js';

/**
 * DoubaoUpstream — Volcengine Doubao Streaming ASR 2.0 ("豆包流式语音识别
 * 大模型 2.0"), optimized bidirectional endpoint
 * `/api/v3/sauc/bigmodel_async`, speaking the SAUC v3 binary protocol.
 *
 * Wire format (all integers big-endian), per the official protocol doc:
 *   byte 0: (protocol version 0b0001 << 4) | (header size 0b0001)  -> 0x11
 *   byte 1: (message type << 4) | message-type flags
 *   byte 2: (serialization << 4) | compression
 *   byte 3: reserved
 * message types: 1 full client request, 2 audio-only request,
 *                9 full server response, 15 error response
 * flags: 0 no sequence, 1 positive sequence follows,
 *        2 final packet without sequence, 3 final packet with negative seq
 * serialization: 0 raw, 1 JSON; compression: 0 none, 1 gzip
 *
 * Frames:
 *   full client request : header + u32 payload size + gzip(JSON config)
 *   audio-only request  : header + u32 payload size + gzip(raw PCM);
 *                         the final packet uses flags 0b0010 (EOS)
 *   full server response: header + i32 sequence + u32 payload size +
 *                         gzip(JSON result)
 *   error response      : header + u32 error code + u32 message size + UTF-8
 *
 * Result mapping: `result.utterances[]` entries with `definite: true` become
 * `final` events (deduped by utterance timing); non-definite `result.text`
 * becomes `partial`; the final packet (flags 0b10/0b11) emits `done` with the
 * upstream-reported `audio_info.duration`.
 *
 * Credentials arrive ONLY through AsrDoubaoCredentials (backed by env vars,
 * see config.ts) and are never logged. Without credentials the config layer
 * refuses CP_ASR_UPSTREAM=doubao at startup, so this class can assume one
 * auth form is present.
 *
 * Live-service facts (validated against the real endpoint on 2026-10-31,
 * evidence in asr-gateway/doubao-live/probe-run2.json):
 * - Request headers X-Api-Request-Id (task id, required) and X-Api-Connect-Id
 *   (trace id) are both sent with one UUID; X-Api-Sequence is the doc-fixed -1.
 * - Response frames MIX layouts: the config ack arrives with flags 0b0000
 *   (no sequence; payload size at offset 4, payload at 8), while recognition
 *   results arrive sequenced (flags 0b0001/0b0011; size at 8, payload at 12).
 *   The parser branches on the flags nibble — a fixed sequenced offset
 *   misreads the first real response as a protocol error.
 * - An empty-payload EOS packet (flags 0b0010) is accepted.
 * - With enable_nonstream the definite utterance comes from "two_pass"
 *   (re-recognition after VAD silence detection), replacing the streamed
 *   partial — both map cleanly onto final/partial events.
 */

const MSG_FULL_CLIENT_REQUEST = 0b0001;
const MSG_AUDIO_ONLY_REQUEST = 0b0010;
const MSG_FULL_SERVER_RESPONSE = 0b1001;
const MSG_ERROR_RESPONSE = 0b1111;

const FLAG_NONE = 0b0000;
const FLAG_FINAL_NO_SEQ = 0b0010;

const SER_RAW = 0b0000;
const SER_JSON = 0b0001;

const COMP_GZIP = 0b0001;

/** 200 ms of s16le 16 kHz mono — the doc's optimal packet size for bigmodel_async. */
const MAX_AUDIO_CHUNK_BYTES = 6400;

export interface AsrDoubaoCredentials {
  endpoint: string;
  resourceId: string;
  /** Preferred API-key auth (X-Api-Key). */
  apiKey: string | null;
  /** Legacy pair: X-App-ID + Authorization bearer token. */
  appId: string | null;
  accessToken: string | null;
}

export interface AsrDoubaoOptions {
  credentials: AsrDoubaoCredentials;
  /** WebSocket max frame size (default 8 MiB, mirrors the /ws proxy). */
  maxPayload?: number;
}

function header(msgType: number, flags: number, serialization: number, compression: number): Buffer {
  const byte = Buffer.from([0x11, (msgType << 4) | flags, (serialization << 4) | compression, 0x00]);
  return byte;
}

function frameWithPayload(
  msgType: number,
  flags: number,
  serialization: number,
  compression: number,
  payload: Buffer,
): Buffer {
  const size = Buffer.alloc(4);
  size.writeUInt32BE(payload.length, 0);
  return Buffer.concat([header(msgType, flags, serialization, compression), size, payload]);
}

export class DoubaoUpstream implements AsrUpstreamProvider {
  readonly name = 'doubao';
  private readonly creds: AsrDoubaoCredentials;
  private readonly maxPayload: number;

  constructor(options: AsrDoubaoOptions) {
    this.creds = options.credentials;
    this.maxPayload = options.maxPayload ?? 8 * 1024 * 1024;
  }

  startSession(opts: { userId: string; onEvent: (event: AsrUpstreamEvent) => void }): Promise<AsrUpstreamSession> {
    const { onEvent } = opts;
    const connectId = randomUUID();
    const headers: Record<string, string> = {
      'X-Api-Resource-Id': this.creds.resourceId,
      // Task id (required by the v3 doc) and trace id share one UUID; the
      // handshake echoes X-Api-Connect-Id back as the response header.
      'X-Api-Request-Id': connectId,
      'X-Api-Connect-Id': connectId,
      'X-Api-Sequence': '-1',
    };
    if (this.creds.apiKey) {
      headers['X-Api-Key'] = this.creds.apiKey;
    } else if (this.creds.appId && this.creds.accessToken) {
      headers['X-Api-App-Key'] = this.creds.appId;
      headers['X-Api-Access-Key'] = this.creds.accessToken;
    }

    // Do not leak credentials through the ws error path: only the message.
    const ws = new WebSocket(this.creds.endpoint, { headers, maxPayload: this.maxPayload });

    let finished = false;
    let done = false;
    let dead = false;
    const emittedFinals = new Set<string>();

    const fail = (code: string, message: string, retryable: boolean): void => {
      if (dead || done) {
        return;
      }
      dead = true;
      try {
        ws.close();
      } catch {
        // already closing
      }
      onEvent({ kind: 'error', code, message, retryable });
    };

    const sendFrame = (data: Buffer): void => {
      if (ws.readyState !== ws.OPEN) {
        return;
      }
      try {
        ws.send(data, { binary: true });
      } catch (err) {
        fail('UPSTREAM_LOST', `doubao: send failed: ${err instanceof Error ? err.message : String(err)}`, true);
      }
    };

    const startRequest = frameWithPayload(
      MSG_FULL_CLIENT_REQUEST,
      FLAG_NONE,
      SER_JSON,
      COMP_GZIP,
      gzipSync(
        Buffer.from(
          JSON.stringify({
            user: { uid: opts.userId },
            audio: { format: 'pcm', rate: 16000, bits: 16, channel: 1 },
            request: {
              model_name: 'bigmodel',
              // Incremental results: result.text covers only the current
              // utterance, which is exactly our `partial` semantics.
              result_type: 'single',
              enable_itn: true,
              enable_punc: true,
              // Semantic smoothing (disfluency removal) — per the delegation
              // spec and the official example payload.
              enable_ddc: true,
              // Two-pass recognition: after VAD silence detection the
              // utterance is re-recognized and the refined definite result
              // replaces the streamed partial (source: "two_pass").
              enable_nonstream: true,
              show_utterances: true,
              // Forced endpointing so short push-to-talk utterances finalize
              // quickly (doc: end_window_size range [300,5000], default 800;
              // force_to_speech_time recommended 1000).
              end_window_size: 800,
              force_to_speech_time: 1000,
            },
          }),
          'utf8',
        ),
      ),
    );

    ws.on('message', (data: Buffer) => {
      if (dead || done || data.length < 4) {
        return;
      }
      if (data[0] !== 0x11) {
        fail('DOUBAO_PROTOCOL', `doubao: unexpected header byte ${data[0].toString(16)}`, false);
        return;
      }
      const msgType = data[1] >> 4;
      const flags = data[1] & 0x0f;

      if (msgType === MSG_ERROR_RESPONSE) {
        if (data.length < 12) {
          fail('DOUBAO_PROTOCOL', 'doubao: short error frame', false);
          return;
        }
        const errorCode = data.readUInt32BE(4);
        const messageSize = data.readUInt32BE(8);
        const message = data.subarray(12, 12 + messageSize).toString('utf8');
        fail(`DOUBAO_${errorCode}`, `doubao: ${message}`, false);
        return;
      }

      if (msgType !== MSG_FULL_SERVER_RESPONSE) {
        return;
      }
      // Live fact (2026-10-31 probe): the service MIXES response layouts.
      // The config ack arrives unsequenced (flags 0b0000 — size at 4, payload
      // at 8); recognition results arrive sequenced (flags 0b0001/0b0011 —
      // size at 8, payload at 12). Branch on the flags nibble.
      const hasSequence = flags === 0b0001 || flags === 0b0011;
      const sizeOffset = hasSequence ? 8 : 4;
      const payloadOffset = hasSequence ? 12 : 8;
      if (data.length < payloadOffset) {
        return;
      }
      const payloadSize = data.readUInt32BE(sizeOffset);
      let payload = data.subarray(payloadOffset, payloadOffset + payloadSize);
      const compression = data[2] & 0x0f;
      if (compression === COMP_GZIP) {
        try {
          payload = gunzipSync(payload);
        } catch {
          fail('DOUBAO_PROTOCOL', 'doubao: gzip decode failed', false);
          return;
        }
      }
      let json: {
        audio_info?: { duration?: number };
        result?: {
          text?: string;
          utterances?: Array<{ text?: string; definite?: boolean; start_time?: number; end_time?: number }>;
        };
      };
      try {
        json = JSON.parse(payload.toString('utf8'));
      } catch {
        fail('DOUBAO_PROTOCOL', 'doubao: result JSON parse failed', false);
        return;
      }

      for (const utt of json.result?.utterances ?? []) {
        if (!utt.definite || typeof utt.text !== 'string') {
          continue;
        }
        const key = `${utt.start_time ?? -1}:${utt.end_time ?? -1}:${utt.text}`;
        if (emittedFinals.has(key)) {
          continue;
        }
        emittedFinals.add(key);
        onEvent({ kind: 'final', text: utt.text });
      }
      const text = json.result?.text ?? '';
      const lastUtt = json.result?.utterances?.[json.result.utterances.length - 1];
      if (text.length > 0 && !lastUtt?.definite) {
        onEvent({ kind: 'partial', text });
      }

      const isFinalPacket = flags === FLAG_FINAL_NO_SEQ || flags === 0b0011;
      if (isFinalPacket) {
        done = true;
        try {
          ws.close(1000);
        } catch {
          // already closing
        }
        onEvent({ kind: 'done', durationMs: json.audio_info?.duration ?? 0 });
      }
    });

    ws.on('close', () => {
      if (!done && !dead) {
        fail('UPSTREAM_LOST', 'doubao: connection closed unexpectedly', true);
      }
    });
    ws.on('error', (err) => {
      fail('UPSTREAM_LOST', `doubao: ${err instanceof Error ? err.message : String(err)}`, true);
    });

    const session: AsrUpstreamSession = {
      pushAudio(chunk: Buffer): void {
        if (dead || done || finished || chunk.length === 0) {
          return;
        }
        // The channel doc has the client batch 100–200 ms per frame; this
        // ceiling guarantees the doc's optimal ≤200 ms packets toward
        // bigmodel_async even if a client misbehaves. Smaller chunks pass
        // through untouched (splitting would only add latency).
        for (let offset = 0; offset < chunk.length; offset += MAX_AUDIO_CHUNK_BYTES) {
          const slice = chunk.subarray(offset, Math.min(offset + MAX_AUDIO_CHUNK_BYTES, chunk.length));
          sendFrame(frameWithPayload(MSG_AUDIO_ONLY_REQUEST, FLAG_NONE, SER_RAW, COMP_GZIP, gzipSync(slice)));
        }
      },
      finish(): void {
        if (dead || done || finished) {
          return;
        }
        finished = true;
        // End-of-stream: final audio-only packet with flags 0b0010. An empty
        // payload is valid — any remaining audio was already pushed.
        sendFrame(frameWithPayload(MSG_AUDIO_ONLY_REQUEST, FLAG_FINAL_NO_SEQ, SER_RAW, COMP_GZIP, gzipSync(Buffer.alloc(0))));
      },
      abort(): void {
        dead = true;
        try {
          ws.close(1000);
        } catch {
          // already closing
        }
      },
    };

    return new Promise<AsrUpstreamSession>((resolve, reject) => {
      const openTimer = setTimeout(() => {
        reject(new Error('doubao: connect timed out after 10s'));
        try {
          ws.terminate();
        } catch {
          // noop
        }
      }, 10_000);
      ws.once('open', () => {
        clearTimeout(openTimer);
        sendFrame(startRequest);
        onEvent({ kind: 'ready', sessionId: `doubao-${connectId}` });
        resolve(session);
      });
      ws.once('error', (err) => {
        clearTimeout(openTimer);
        reject(new Error(`doubao: connect failed: ${err instanceof Error ? err.message : String(err)}`));
      });
    });
  }
}
