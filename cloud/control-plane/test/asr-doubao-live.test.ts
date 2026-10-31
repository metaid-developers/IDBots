import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { gunzipSync, gzipSync } from 'node:zlib';
import http from 'node:http';
import { WebSocketServer } from 'ws';
import { DoubaoUpstream } from '../src/services/asr/upstream-doubao.js';
import { eventCollector, pollFor } from './asr-helpers.js';

/**
 * Regression gates for facts confirmed against the LIVE Volcengine endpoint
 * (2026-10-31, evidence: asr-gateway/doubao-live/probe-run2.json). The
 * pre-existing asr-doubao.test.ts only ever framed sequenced responses, so a
 * parser regression against the real service would have stayed invisible:
 *
 *  1. bigmodel_async MIXES response layouts — the config ack arrives with
 *     flags 0b0000 (no sequence: size at offset 4, payload at 8) while
 *     recognition results are sequenced (flags 0b0001/0b0011: size at 8,
 *     payload at 12). A fixed sequenced offset misparses the ack frame.
 *  2. Audio packets are capped at 200 ms (6400 B); oversized client chunks
 *     are split, byte-exact, into ≤6400 B frames.
 *  3. The handshake carries X-Api-Request-Id (required by the v3 doc)
 *     alongside the trace X-Api-Connect-Id.
 */

function saucHeader(msgType: number, flags: number, ser: number, comp: number): Buffer {
  return Buffer.from([(0x1 << 4) | 0x1, (msgType << 4) | flags, (ser << 4) | comp, 0x00]);
}

function sequencedResponse(seq: number, flags: number, json: unknown): Buffer {
  const payload = gzipSync(Buffer.from(JSON.stringify(json), 'utf8'));
  const seqBuf = Buffer.alloc(4);
  seqBuf.writeInt32BE(seq, 0);
  const size = Buffer.alloc(4);
  size.writeUInt32BE(payload.length, 0);
  return Buffer.concat([saucHeader(0b1001, flags, 0b0001, 0b0001), seqBuf, size, payload]);
}

/** Live shape of the config-ack frame: flags 0b0000, NO sequence field. */
function noSeqResponse(json: unknown): Buffer {
  const payload = gzipSync(Buffer.from(JSON.stringify(json), 'utf8'));
  const size = Buffer.alloc(4);
  size.writeUInt32BE(payload.length, 0);
  return Buffer.concat([saucHeader(0b1001, 0b0000, 0b0001, 0b0001), size, payload]);
}

interface ParsedClientFrame {
  msgType: number;
  flags: number;
  payload: Buffer;
}

function parseClientFrame(data: Buffer): ParsedClientFrame {
  assert.equal(data[0], 0x11);
  const msgType = data[1] >> 4;
  const flags = data[1] & 0x0f;
  const comp = data[2] & 0x0f;
  const payloadSize = data.readUInt32BE(4);
  let payload = data.subarray(8, 8 + payloadSize);
  if (comp === 0b0001) {
    payload = gunzipSync(payload);
  }
  return { msgType, flags, payload };
}

describe('DoubaoUpstream live-confirmed protocol facts (fake server)', () => {
  let server: http.Server;
  let wss: WebSocketServer;
  let url = '';
  const frames: ParsedClientFrame[] = [];
  const handshake: Record<string, string | undefined> = {};
  let respond: (frame: Buffer) => void = () => {};

  before(async () => {
    server = http.createServer((_req, res) => {
      res.writeHead(404);
      res.end();
    });
    wss = new WebSocketServer({ noServer: true });
    server.on('upgrade', (req, socket, head) => {
      handshake['x-api-request-id'] = req.headers['x-api-request-id'] as string | undefined;
      handshake['x-api-connect-id'] = req.headers['x-api-connect-id'] as string | undefined;
      wss.handleUpgrade(req, socket, head, (ws) => {
        respond = (frame: Buffer) => ws.send(frame, { binary: true });
        ws.on('message', (data: Buffer) => frames.push(parseClientFrame(data)));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `ws://127.0.0.1:${(server.address() as { port: number }).port}/api/v3/sauc/bigmodel_async`;
  });

  after(async () => {
    for (const client of wss.clients) {
      client.terminate();
    }
    await new Promise<void>((resolve) => wss.close(() => server.close(() => resolve())));
  });

  function makeUpstream(): DoubaoUpstream {
    return new DoubaoUpstream({
      credentials: {
        endpoint: url,
        resourceId: 'volc.seedasr.sauc.duration',
        apiKey: 'dummy-key',
        appId: null,
        accessToken: null,
      },
    });
  }

  test('unsequenced config ack parses; a sequenced partial afterwards still maps', async () => {
    const c = eventCollector();
    const session = await makeUpstream().startSession({ userId: 'u_live', onEvent: c.onEvent });
    await c.wait((e) => e.kind === 'ready');

    // The live config-ack shape — flags 0b0000, no sequence field.
    respond(noSeqResponse({ result: { text: '' } }));
    // A sequenced partial right after must parse through the same handler.
    respond(sequencedResponse(1, 0b0001, { result: { text: '今天天气' } }));
    const partial = await c.wait((e) => e.kind === 'partial');
    assert.equal((partial as { text: string }).text, '今天天气');
    // No protocol error may have been emitted for the ack frame.
    assert.equal(c.events.some((e) => e.kind === 'error'), false);
    session.abort();
  });

  test('audio chunks larger than 200 ms split into ≤6400 B frames, byte-exact', async () => {
    const c = eventCollector();
    const session = await makeUpstream().startSession({ userId: 'u_live', onEvent: c.onEvent });
    await c.wait((e) => e.kind === 'ready');
    frames.length = 0;

    const oversized = Buffer.alloc(6400 + 3200, 0x5a); // 400 ms of PCM
    session.pushAudio(oversized);
    await new Promise((r) => setTimeout(r, 100));

    const audioFrames = frames.filter((f) => f.msgType === 0b0010);
    assert.equal(audioFrames.length, 2, '400 ms chunk splits into two 200 ms frames');
    assert.ok(
      audioFrames.every((f) => f.payload.length <= 6400),
      'every frame carries at most 200 ms of audio',
    );
    assert.deepEqual(Buffer.concat(audioFrames.map((f) => f.payload)), oversized, 'bytes round-trip unchanged');
    session.abort();
  });

  test('handshake carries X-Api-Request-Id alongside X-Api-Connect-Id', async () => {
    const c = eventCollector();
    const session = await makeUpstream().startSession({ userId: 'u_live', onEvent: c.onEvent });
    await c.wait((e) => e.kind === 'ready');
    await pollFor(() => (Object.keys(handshake).length > 0 ? handshake : null));
    assert.ok(handshake['x-api-request-id'], 'X-Api-Request-Id is required by the v3 doc');
    assert.ok(handshake['x-api-connect-id'], 'trace X-Api-Connect-Id stays (response header echoes it)');
    session.abort();
  });
});
