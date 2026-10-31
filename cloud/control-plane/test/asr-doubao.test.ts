import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { gunzipSync, gzipSync } from 'node:zlib';
import http from 'node:http';
import { WebSocketServer } from 'ws';
import { DoubaoUpstream } from '../src/services/asr/upstream-doubao.js';
import { eventCollector, pollFor } from './asr-helpers.js';

/**
 * Protocol-level tests for DoubaoUpstream against a local fake speaking the
 * same SAUC v3 binary protocol (frame layout re-derived from the official
 * protocol doc, independently of the implementation under test). No real
 * credentials are involved — this validates framing, event mapping, and the
 * EOS handshake without the Volcano service.
 */

const MSG_FULL_CLIENT = 0b0001;
const MSG_AUDIO_ONLY = 0b0010;
const MSG_SERVER_RESPONSE = 0b1001;
const MSG_ERROR = 0b1111;

function saucHeader(msgType: number, flags: number, ser: number, comp: number): Buffer {
  return Buffer.from([(0x1 << 4) | 0x1, (msgType << 4) | flags, (ser << 4) | comp, 0x00]);
}

function serverResponseFrame(seq: number, flags: number, json: unknown): Buffer {
  const payload = gzipSync(Buffer.from(JSON.stringify(json), 'utf8'));
  const seqBuf = Buffer.alloc(4);
  seqBuf.writeInt32BE(seq, 0);
  const size = Buffer.alloc(4);
  size.writeUInt32BE(payload.length, 0);
  return Buffer.concat([saucHeader(MSG_SERVER_RESPONSE, flags, 0b0001, 0b0001), seqBuf, size, payload]);
}

function errorFrame(code: number, message: string): Buffer {
  const msg = Buffer.from(message, 'utf8');
  const codeBuf = Buffer.alloc(4);
  codeBuf.writeUInt32BE(code, 0);
  const size = Buffer.alloc(4);
  size.writeUInt32BE(msg.length, 0);
  return Buffer.concat([saucHeader(MSG_ERROR, 0b0000, 0b0000, 0b0000), codeBuf, size, msg]);
}

interface ParsedClientFrame {
  msgType: number;
  flags: number;
  payload: Buffer; // gunzipped
  raw: Buffer;
}

function parseClientFrame(data: Buffer): ParsedClientFrame {
  assert.equal(data[0], 0x11, 'protocol version / header size nibbles');
  const msgType = data[1] >> 4;
  const flags = data[1] & 0x0f;
  const ser = data[2] >> 4;
  const comp = data[2] & 0x0f;
  assert.equal(data.length >= 8, true, 'frame has at least header + size');
  const payloadSize = data.readUInt32BE(4);
  let payload = data.subarray(8, 8 + payloadSize);
  if (comp === 0b0001) {
    payload = gunzipSync(payload);
  }
  void ser;
  return { msgType, flags, payload, raw: data };
}

interface FakeSaucServer {
  url: string;
  frames: ParsedClientFrame[];
  handshakeHeaders: Record<string, string | undefined>;
  receivedAudio: Buffer[];
  /** Test-side handle for pushing server responses. */
  respond: (frame: Buffer) => void;
  dropClient: () => void;
  close: () => Promise<void>;
}

function startFakeSauc(): Promise<FakeSaucServer> {
  const server = http.createServer((_req, res) => {
    res.writeHead(404);
    res.end();
  });
  const wss = new WebSocketServer({ noServer: true });
  const clients = new Set<WebSocket>();
  const state: FakeSaucServer = {
    url: '',
    frames: [],
    handshakeHeaders: {},
    receivedAudio: [],
    respond: () => {},
    dropClient: () => {},
    close: () =>
      new Promise((resolve) => {
        // server.close() waits for open connections forever otherwise.
        for (const ws of clients) {
          ws.terminate();
        }
        wss.close(() => server.close(() => resolve()));
      }),
  };

  server.on('upgrade', (req, socket, head) => {
    state.handshakeHeaders = {
      'x-api-key': req.headers['x-api-key'] as string | undefined,
      'x-api-resource-id': req.headers['x-api-resource-id'] as string | undefined,
      'x-api-connect-id': req.headers['x-api-connect-id'] as string | undefined,
      'x-app-id': req.headers['x-app-id'] as string | undefined,
      authorization: req.headers.authorization as string | undefined,
    };
    wss.handleUpgrade(req, socket, head, (ws) => {
      clients.add(ws);
      ws.on('close', () => clients.delete(ws));
      state.respond = (frame: Buffer) => ws.send(frame, { binary: true });
      state.dropClient = () => ws.terminate();
      ws.on('message', (data: Buffer) => {
        const parsed = parseClientFrame(data);
        state.frames.push(parsed);
        if (parsed.msgType === MSG_AUDIO_ONLY) {
          state.receivedAudio.push(parsed.payload);
        }
      });
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      state.url = `ws://127.0.0.1:${port}/api/v3/sauc/bigmodel_async`;
      resolve(state);
  });
  });
}

function makeUpstream(fake: FakeSaucServer): DoubaoUpstream {
  return new DoubaoUpstream({
    credentials: {
      endpoint: fake.url,
      resourceId: 'volc.seedasr.sauc.duration',
      apiKey: 'test-api-key',
      appId: null,
      accessToken: null,
    },
  });
}

describe('DoubaoUpstream SAUC v3 protocol (fake server)', () => {
  let fake: FakeSaucServer;

  before(async () => {
    fake = await startFakeSauc();
  });

  after(async () => {
    await fake.close();
  });

  test('connects with API-key headers and a valid full-client request', async () => {
    const c = eventCollector();
    const upstream = makeUpstream(fake);
    const session = await upstream.startSession({ userId: 'u_doubao', onEvent: c.onEvent });
    const ready = await c.wait((e) => e.kind === 'ready');
    assert.equal((ready as { sessionId: string }).sessionId.startsWith('doubao-'), true);

    assert.equal(fake.handshakeHeaders['x-api-key'], 'test-api-key');
    assert.equal(fake.handshakeHeaders['x-api-resource-id'], 'volc.seedasr.sauc.duration');
    assert.ok(fake.handshakeHeaders['x-api-connect-id']);

    const first = await pollFor(() => fake.frames[0] ?? null);
    assert.equal(first.msgType, MSG_FULL_CLIENT, 'first frame is the full-client request');
    assert.equal(first.flags, 0b0000);
    const config = JSON.parse(first.payload.toString('utf8')) as {
      user: { uid: string };
      audio: { format: string; rate: number; bits: number; channel: number };
      request: { model_name: string; result_type: string };
    };
    assert.equal(config.user.uid, 'u_doubao');
    assert.equal(config.audio.format, 'pcm');
    assert.equal(config.audio.rate, 16000);
    assert.equal(config.audio.bits, 16);
    assert.equal(config.audio.channel, 1);
    assert.equal(config.request.model_name, 'bigmodel');
    session.abort();
  });

  test('audio frames round-trip and finish sends the EOS flag', async () => {
    const c = eventCollector();
    const upstream = makeUpstream(fake);
    const session = await upstream.startSession({ userId: 'u_doubao', onEvent: c.onEvent });
    await c.wait((e) => e.kind === 'ready');
    fake.frames.length = 0;
    fake.receivedAudio.length = 0;

    const chunk1 = Buffer.alloc(3200, 0xab);
    const chunk2 = Buffer.alloc(1600, 0xcd);
    session.pushAudio(chunk1);
    session.pushAudio(chunk2);
    session.finish();
    // Let the socket flush.
    await new Promise((r) => setTimeout(r, 100));

    const audioFrames = fake.frames.filter((f) => f.msgType === MSG_AUDIO_ONLY);
    assert.equal(audioFrames.length, 3, 'two audio chunks + one EOS frame');
    assert.deepEqual(
      Buffer.concat([audioFrames[0]!.payload, audioFrames[1]!.payload]),
      Buffer.concat([chunk1, chunk2]),
      'audio bytes round-trip unchanged',
    );
    assert.equal(audioFrames[0]!.flags, 0b0000, 'regular packets carry no final flag');
    assert.equal(audioFrames[2]!.flags, 0b0010, 'EOS packet uses the final-without-sequence flag');
    assert.equal(audioFrames[2]!.payload.length, 0, 'EOS carries an empty payload');
    session.abort();
  });

  test('partial, definite-final and final packet map to the event stream', async () => {
    const c = eventCollector();
    const upstream = makeUpstream(fake);
    const session = await upstream.startSession({ userId: 'u_doubao', onEvent: c.onEvent });
    await c.wait((e) => e.kind === 'ready');

    fake.respond(serverResponseFrame(1, 0b0001, { result: { text: '今天天' } }));
    const partial = await c.wait((e) => e.kind === 'partial');
    assert.equal((partial as { text: string }).text, '今天天');

    fake.respond(
      serverResponseFrame(2, 0b0001, {
        audio_info: { duration: 1705 },
        result: { text: '今天天气', utterances: [{ text: '今天天气', definite: true, start_time: 0, end_time: 1705 }] },
      }),
    );
    const final = await c.wait((e) => e.kind === 'final');
    assert.equal((final as { text: string }).text, '今天天气');

    fake.respond(
      serverResponseFrame(-3, 0b0011, {
        audio_info: { duration: 3696 },
        result: { text: '', utterances: [] },
      }),
    );
    const done = await c.wait((e) => e.kind === 'done');
    assert.equal((done as { durationMs: number }).durationMs, 3696, 'billed audio duration from the final packet');
    // The upstream should have closed itself after done.
    await new Promise((r) => setTimeout(r, 50));
    session.abort();
  });

  test('an upstream error frame maps to a non-retryable DOUBAO_<code> error', async () => {
    const c = eventCollector();
    const upstream = makeUpstream(fake);
    const session = await upstream.startSession({ userId: 'u_doubao', onEvent: c.onEvent });
    await c.wait((e) => e.kind === 'ready');
    fake.respond(errorFrame(45000151, 'invalid audio format'));
    const err = await c.wait((e) => e.kind === 'error');
    assert.equal((err as { code: string }).code, 'DOUBAO_45000151');
    assert.equal((err as { retryable: boolean }).retryable, false);
    session.abort();
  });

  test('an unexpected transport drop maps to a retryable UPSTREAM_LOST', async () => {
    const c = eventCollector();
    const upstream = makeUpstream(fake);
    const session = await upstream.startSession({ userId: 'u_doubao', onEvent: c.onEvent });
    await c.wait((e) => e.kind === 'ready');
    fake.dropClient();
    const err = await c.wait((e) => e.kind === 'error');
    assert.equal((err as { code: string }).code, 'UPSTREAM_LOST');
    assert.equal((err as { retryable: boolean }).retryable, true);
    session.abort();
    // Reconnect for the next test (fake server accepts any number of sessions).
    const c2 = eventCollector();
    const s2 = await upstream.startSession({ userId: 'u_doubao', onEvent: c2.onEvent });
    await c2.wait((e) => e.kind === 'ready');
    s2.abort();
  });
});
