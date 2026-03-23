import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const workflowPath = path.join(process.cwd(), '.github', 'workflows', 'build.yml');
const workflow = fs.readFileSync(workflowPath, 'utf8');

test('Windows release workflow keeps executable resource editing enabled so the app icon is embedded', () => {
  assert.match(workflow, /Build Electron app package \(Windows unsigned\)/);
  assert.doesNotMatch(
    workflow,
    /signAndEditExecutable=false/,
    'Windows release packaging should not disable executable resource editing',
  );
});
