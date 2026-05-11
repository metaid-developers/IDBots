import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

function readSource(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

function assertContains(source, pattern, message) {
  assert.match(source, pattern, message);
}

test('nested sqlite-backed title generation catches rethrow WASM errors', () => {
  assertContains(
    readSource('src/main/libs/coworkUtil.ts'),
    /catch \(error\) \{\s*if \(isSqliteWasmBoundsError\(error\)\) \{\s*throw error;\s*\}/s,
    'generateSessionTitle must not turn SQLite WASM errors into fallback titles',
  );

  assertContains(
    readSource('src/main/services/privateChatOrderCowork.ts'),
    /generateSessionTitle\(request\.prompt\)\.catch\(\(error\) => \{\s*if \(isSqliteWasmBoundsError\(error\)\) \{\s*throw error;\s*\}/s,
    'private chat order cowork title fallback must not swallow SQLite WASM errors',
  );

  assertContains(
    readSource('src/main/services/serviceOrderObserverSession.ts'),
    /generateSessionTitle\(firstMessage \|\| fallbackTitle\)\.catch\(\(error\) => \{\s*if \(isSqliteWasmBoundsError\(error\)\) \{\s*throw error;\s*\}/s,
    'service order observer title fallback must not swallow SQLite WASM errors',
  );
});

test('nested GigSquare and refund recovery catches rethrow WASM errors', () => {
  const mainSource = readSource('src/main/main.ts');

  assertContains(
    mainSource,
    /providerDiscoveryService\.refreshNow\(\)\.catch\(\(error\) => \{\s*rethrowSqliteWasmBoundsError\(error\);/s,
    'GigSquare provider discovery refresh catch must rethrow SQLite WASM errors',
  );

  assertContains(
    mainSource,
    /catch \(error\) \{\s*rethrowSqliteWasmBoundsError\(error\);\s*console\.warn\('\[GigSquare\] My services remote refresh failed'/s,
    'GigSquare my-services refresh catch must rethrow SQLite WASM errors',
  );

  const refundObserverRecoveryCatchCount = (
    mainSource.match(
      /recoverMissingRefundPendingOrderObserverSessions\(\)\.catch\(\(error\) => \{\s*rethrowSqliteWasmBoundsError\(error\);/gs,
    ) ?? []
  ).length;
  assert.equal(
    refundObserverRecoveryCatchCount >= 2,
    true,
    'refund/order event observer recovery catches must rethrow SQLite WASM errors',
  );
});

test('private chat order cowork fallback catches rethrow WASM errors', () => {
  const source = readSource('src/main/services/privateChatOrderCowork.ts');

  assertContains(
    source,
    /resolveTimeoutFallback\(sessionId, acc\)\.catch\(\(error\) => \{\s*if \(isSqliteWasmBoundsError\(error\)\) \{/s,
    'timeout fallback catch must reject instead of swallowing SQLite WASM errors',
  );

  assertContains(
    source,
    /\}\)\.catch\(\(error\) => \{\s*if \(isSqliteWasmBoundsError\(error\)\) \{\s*accumulator\.reject/s,
    'completed order finalization catch must reject instead of swallowing SQLite WASM errors',
  );

  const directRethrowCatchCount = (
    source.match(/catch \(error\) \{\s*if \(isSqliteWasmBoundsError\(error\)\) \{\s*throw error;\s*\}/gs) ?? []
  ).length;
  assert.equal(
    directRethrowCatchCount >= 4,
    true,
    'order artifact, status update, and rating fallback catches must rethrow SQLite WASM errors',
  );
});

test('delayed GigSquare publish-service sync uses recovery-aware background runner', () => {
  assertContains(
    readSource('src/main/main.ts'),
    /runSqliteBackgroundJob\(\s*'gigSquare:publishServiceDelayedSync',\s*'\[GigSquare\] Delayed publish-service sync failed',\s*syncRemoteSkillServices,\s*\);/s,
    'delayed publish service sync must use the recovery-aware SQLite background job runner',
  );
});

test('publish-service immediate local insert uses recovery without retrying chain publish', () => {
  const mainSource = readSource('src/main/main.ts');
  assertContains(
    mainSource,
    /await withSqliteRecovery\('gigSquare:publishServiceLocalInsert', \(\) => \{\s*insertGigSquareServiceRow\(localServiceRecord\);\s*\}\);/s,
    'publish-service local insert must use SQLite recovery without repeating createPin',
  );
  assertContains(
    mainSource,
    /if \(isSqliteWasmBoundsError\(err\)\) \{\s*await recoverSqliteStore\(err, 'gigSquare:publishServiceLocalInsert:retryFailed'\)/s,
    'publish-service local insert retry failure must still trigger recovery before returning existing pin result',
  );
});
