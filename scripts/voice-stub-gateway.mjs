#!/usr/bin/env node
/**
 * Voice ASR stub gateway (voice P0, subtask #10) — DRAFT v0 dialect
 * (src/mobile/app/voice/protocol.ts is the frontend half of the contract).
 *
 * Purpose: let the PWA voice e2e prove "speech → streaming text → draft
 * backfill" end-to-end before the real gateway (Builder阿码, parallel work)
 * exists. The stub accepts the draft-v0 handshake, receives binary PCM
 * (content is ignored), and streams a canned sentence as progressively longer
 * `partial` events, then a `final` that differs from the last partial
 * (proving partial→final replacement in the UI), then `end`.
 *
 * Usage: node scripts/voice-stub-gateway.mjs [--port 8791]
 * Env:   VOICE_STUB_PARTIAL_MS (default 250) — delay between partials.
 */
import { WebSocketServer } from 'ws';

const args = process.argv.slice(2);
const portFlag = args.indexOf('--port');
const PORT = Number(portFlag >= 0 ? args[portFlag + 1] : process.env.VOICE_STUB_PORT || 8791);
const PARTIAL_MS = Number(process.env.VOICE_STUB_PARTIAL_MS || 250);

/** Canned recognition: partials grow, final extends the last partial. */
const PARTIALS = ['今天', '今天天气', '今天天气不错', '今天天气不错，适合', '今天天气不错，适合'];
const FINAL_TEXT = '今天天气不错，适合出门走走。';

const wss = new WebSocketServer({ port: PORT, host: '127.0.0.1' });

/** Stats printed on shutdown — evidence for the delivery notes. */
let sessions = 0;
let pcmBytes = 0;

wss.on('listening', () => {
  console.log(`[voice-stub] listening on ws://127.0.0.1:${PORT} (draft v0, partial every ${PARTIAL_MS}ms)`);
});

wss.on('connection', (ws) => {
  sessions += 1;
  let started = false;
  let partialTimer = null;
  let partialIndex = 0;
  let pcmChunks = 0;
  const send = (obj) => ws.send(JSON.stringify(obj));

  const clearPartialTimer = () => {
    if (partialTimer !== null) {
      clearInterval(partialTimer);
      partialTimer = null;
    }
  };

  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      if (!started) return; // PCM before start is dropped
      pcmChunks += 1;
      pcmBytes += data.length;
      if (partialTimer === null && partialIndex < PARTIALS.length) {
        // Stream the canned hypothesis while "audio" flows in.
        partialTimer = setInterval(() => {
          if (partialIndex >= PARTIALS.length) {
            clearPartialTimer();
            return;
          }
          send({ type: 'partial', text: PARTIALS[partialIndex] });
          partialIndex += 1;
          if (partialIndex >= PARTIALS.length) clearPartialTimer();
        }, PARTIAL_MS);
      }
      return;
    }
    let frame;
    try {
      frame = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (frame.type === 'start') {
      started = true;
      send({ type: 'ready', sessionId: `stub-${Date.now()}`, quotaRemainingSeconds: 3600 });
      return;
    }
    if (frame.type === 'stop') {
      clearPartialTimer();
      send({ type: 'final', text: FINAL_TEXT });
      send({ type: 'end' });
      ws.close(1000, 'stub session end');
    }
  });

  ws.on('close', clearPartialTimer);
  ws.on('error', () => clearPartialTimer());
});

process.on('SIGTERM', () => {
  console.log(`[voice-stub] shutdown: ${sessions} session(s), ${pcmBytes} PCM bytes received`);
  wss.close(() => process.exit(0));
});
