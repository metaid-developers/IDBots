import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mainSourcePath = path.join(projectRoot, 'src', 'main', 'main.ts');

test('my-service order IPC loads seller orders and ratings through all service chain pins', () => {
  const source = fs.readFileSync(mainSourcePath, 'utf8');

  assert.match(source, /getMyServicePinIds/);
  assert.match(source, /const servicePinIds = getMyServicePinIds\(service\)/);
  assert.match(source, /servicePinIdSet\.has\(toSafeString\(order\.servicePinId\)\.trim\(\)\)/);
  assert.match(source, /for \(const ratingServiceId of servicePinIds\)/);
  assert.match(source, /servicePinIds,/);
  assert.doesNotMatch(source, /\.filter\(\(order\) => toSafeString\(order\.servicePinId\)\.trim\(\) === currentPinId\)/);
});
