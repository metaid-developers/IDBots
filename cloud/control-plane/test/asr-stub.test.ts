import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { StubUpstream } from '../src/services/asr/upstream-stub.js';
import { eventCollector } from './asr-helpers.js';

const CHUNK = Buffer.alloc(3200, 1); // 100 ms of s16le 16 kHz mono

describe('StubUpstream (fake ASR provider)', () => {
  test('ready → partials → finish → final + done', async () => {
    const stub = new StubUpstream({ transcript: '今天天气怎么样', expectedChunks: 4 });
    const c = eventCollector();
    const session = await stub.startSession({ userId: 'u1', onEvent: c.onEvent });
    await c.wait((e) => e.kind === 'ready');

    session.pushAudio(CHUNK);
    session.pushAudio(CHUNK);
    session.pushAudio(CHUNK);
    session.pushAudio(CHUNK);
    await c.wait((e) => e.kind === 'partial');
    const partials = c.events.filter((e) => e.kind === 'partial').map((e) => (e as { text: string }).text);
    assert.ok(partials.length >= 2, `got partials: ${partials.join('|')}`);
    assert.ok(partials[partials.length - 1]!.length > partials[0]!.length, 'partials grow towards the transcript');

    session.finish();
    const final = await c.wait((e) => e.kind === 'final');
    assert.equal((final as { text: string }).text, '今天天气怎么样');
    const done = await c.wait((e) => e.kind === 'done');
    assert.equal((done as { durationMs: number }).durationMs, 400, 'nominal 100 ms per chunk');
  });

  test('delayMs delays the ready event', async () => {
    const stub = new StubUpstream({ faults: { delayMs: 120 }, transcript: 'ab', expectedChunks: 1 });
    const c = eventCollector();
    const started = Date.now();
    await stub.startSession({ userId: 'u1', onEvent: c.onEvent });
    await c.wait((e) => e.kind === 'ready');
    assert.ok(Date.now() - started >= 110, 'ready was delayed by delayMs');
  });

  test('disconnectAfterMs kills the session with a retryable UPSTREAM_LOST', async () => {
    const stub = new StubUpstream({ faults: { disconnectAfterMs: 80 }, transcript: 'ab', expectedChunks: 4 });
    const c = eventCollector();
    await stub.startSession({ userId: 'u1', onEvent: c.onEvent });
    const err = await c.wait((e) => e.kind === 'error');
    assert.equal((err as { code: string }).code, 'UPSTREAM_LOST');
    assert.equal((err as { retryable: boolean }).retryable, true);
  });

  test('slowFinalMs delays final/done after finish', async () => {
    const stub = new StubUpstream({ faults: { slowFinalMs: 150 }, transcript: 'ab', expectedChunks: 1 });
    const c = eventCollector();
    const session = await stub.startSession({ userId: 'u1', onEvent: c.onEvent });
    session.pushAudio(CHUNK);
    await c.wait((e) => e.kind === 'ready');
    const finishedAt = Date.now();
    session.finish();
    await c.wait((e) => e.kind === 'done');
    assert.ok(Date.now() - finishedAt >= 140, 'final path was delayed by slowFinalMs');
  });
});
