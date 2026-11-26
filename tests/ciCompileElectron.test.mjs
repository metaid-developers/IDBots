import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { compile, readOutDir, STATE_FILE_NAME, OUTPUTS_FILE_NAME } = require('../scripts/compile-electron.cjs');
const tsc = require.resolve('typescript/bin/tsc');

const OLD = new Date('2020-01-01T00:00:00Z');

// A miniature stand-in for src/main: two modules, one importing the other.
function makeProject(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-compile-'));
  // Leftover temp dirs are harmless and OS-swept; never let cleanup fail a test.
  t.after(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  });
  const write = (relative, content) => {
    fs.mkdirSync(path.dirname(path.join(dir, relative)), { recursive: true });
    fs.writeFileSync(path.join(dir, relative), content);
  };
  write('tsconfig.json', JSON.stringify({
    compilerOptions: { outDir: 'out', rootDir: 'src', strict: true, module: 'commonjs', target: 'es2020', types: [] },
    include: ['src'],
  }));
  write('src/a.ts', 'export const a: number = 1;\n');
  write('src/b.ts', "import { a } from './a';\nexport const b: string = String(a);\n");
  const out = (relative) => path.join(dir, 'out', relative);
  const freezeOutputs = () => {
    for (const relative of ['a.js', 'b.js']) fs.utimesSync(out(relative), OLD, OLD);
  };
  const run = () => compile({ project: 'tsconfig.json', cwd: dir, tsc });
  return { dir, write, out, freezeOutputs, run };
}

test('readOutDir resolves compilerOptions.outDir against the tsconfig directory', () => {
  const projectRoot = path.resolve(import.meta.dirname, '..');
  assert.equal(readOutDir(path.join(projectRoot, 'electron-tsconfig.json')), path.join(projectRoot, 'dist-electron'));
});

test('an unchanged tree is re-checked without rewriting any output', (t) => {
  const project = makeProject(t);
  assert.equal(project.run(), 0);
  assert.equal(fs.existsSync(project.out('a.js')), true);
  assert.equal(fs.existsSync(project.out(STATE_FILE_NAME)), true, 'the state lives with the outputs');
  project.freezeOutputs();

  assert.equal(project.run(), 0);

  assert.equal(fs.statSync(project.out('a.js')).mtimeMs, OLD.getTime());
  assert.equal(fs.statSync(project.out('b.js')).mtimeMs, OLD.getTime());
});

test('a changed file is re-emitted and modules that depend on it see the new value', (t) => {
  const project = makeProject(t);
  assert.equal(project.run(), 0);
  project.freezeOutputs();

  project.write('src/a.ts', 'export const a: number = 2;\n');
  assert.equal(project.run(), 0);

  assert.match(fs.readFileSync(project.out('a.js'), 'utf8'), /a = 2/);
  // tsc may re-emit importers of a changed file; what matters is that every
  // output is complete and correct afterwards.
  assert.match(fs.readFileSync(project.out('b.js'), 'utf8'), /require\(".\/a"\)/);
});

test('a new type error still fails the compile, and fixing it succeeds again', (t) => {
  const project = makeProject(t);
  assert.equal(project.run(), 0);

  project.write('src/b.ts', 'export const b: string = 123;\n');
  assert.notEqual(project.run(), 0, 'incremental must not hide a new type error');

  project.write('src/b.ts', 'export const b: string = "ok";\n');
  assert.equal(project.run(), 0);
  assert.match(fs.readFileSync(project.out('b.js'), 'utf8'), /"ok"/);
});

test('wiping the output directory also wipes the state, so everything is emitted again', (t) => {
  const project = makeProject(t);
  assert.equal(project.run(), 0);
  // What `npx rimraf dist-electron && ...` does before test:memory / test:dsh.
  fs.rmSync(path.join(project.dir, 'out'), { recursive: true, force: true });

  assert.equal(project.run(), 0);

  assert.equal(fs.existsSync(project.out('a.js')), true, 'the deleted-output trap: tsc must not report success on an empty outDir');
  assert.equal(fs.existsSync(project.out('b.js')), true);
});

test('an output deleted while the state survives is detected and emitted again', (t) => {
  const project = makeProject(t);
  assert.equal(project.run(), 0);
  // "Delete the output to force a clean compile" — but only part of it.
  fs.rmSync(project.out('a.js'));
  assert.equal(fs.existsSync(project.out(STATE_FILE_NAME)), true, 'precondition: the state outlived the output');

  assert.equal(project.run(), 0);

  assert.equal(fs.existsSync(project.out('a.js')), true, 'tsc alone would report success on an empty slot');
  assert.match(fs.readFileSync(project.out('a.js'), 'utf8'), /a = 1/);
});

test('a manifest that does not match the disk forces a full emit', (t) => {
  const project = makeProject(t);
  assert.equal(project.run(), 0);
  project.freezeOutputs();
  fs.writeFileSync(project.out(OUTPUTS_FILE_NAME), JSON.stringify(['no-longer-emitted.js']));

  assert.equal(project.run(), 0);

  assert.notEqual(fs.statSync(project.out('a.js')).mtimeMs, OLD.getTime());
});

test('a file added after the first compile is picked up', (t) => {
  const project = makeProject(t);
  assert.equal(project.run(), 0);

  project.write('src/c.ts', 'export const c = 3;\n');
  assert.equal(project.run(), 0);

  assert.equal(fs.existsSync(project.out('c.js')), true);
});

test('a missing state file falls back to a full emit', (t) => {
  const project = makeProject(t);
  assert.equal(project.run(), 0);
  project.freezeOutputs();
  fs.rmSync(project.out(STATE_FILE_NAME));

  assert.equal(project.run(), 0);

  assert.notEqual(fs.statSync(project.out('a.js')).mtimeMs, OLD.getTime());
  assert.equal(fs.existsSync(project.out(STATE_FILE_NAME)), true);
});
