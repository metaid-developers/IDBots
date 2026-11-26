import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseLsFilesEol,
  selectCrlfCarryover,
  allowsExactCheckout,
  normalizeWorktreeEol,
} from '../scripts/ci-worktree-eol.mjs';

const read = (root, relative) => fs.readFileSync(path.join(root, relative), 'utf8');
const crlf = (text) => text.replace(/\n/g, '\r\n');

// A long-lived Git for Windows workspace: LF files committed, then checked out
// with core.autocrlf=true.
function makeWindowsWorkspace(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-eol-'));
  // Leftover temp dirs are harmless and OS-swept; never let cleanup fail a test.
  t.after(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  });
  const git = (args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const write = (relative, content) => {
    fs.mkdirSync(path.dirname(path.join(dir, relative)), { recursive: true });
    fs.writeFileSync(path.join(dir, relative), content);
  };
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 'ci@example.invalid']);
  git(['config', 'user.name', 'ci']);
  // Commit the fixture bytes exactly as written on every platform (Git for
  // Windows sets core.autocrlf=true system-wide).
  git(['config', 'core.autocrlf', 'false']);
  write('.gitattributes', '*.dat -text\n');
  write('lf.txt', 'a\nb\n');
  write('sub/with space.txt', 'x\ny\n');
  write('deep/nested/module.ts', 'export const n = 1;\n');
  write('committed-crlf.txt', 'a\r\nb\r\n');
  write('binary.dat', '\u0000\u0001\u0002bin\r\n');
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'init']);
  return { dir, git, write };
}

test('parseLsFilesEol: the tab before the path is the separator, so spaces in paths survive', () => {
  const entries = parseLsFilesEol(
    'i/lf    w/crlf  attr/                \tsub/with space.txt\u0000'
      + 'i/-text w/-text attr/-text             \tbinary.dat\u0000'
      + 'i/crlf  w/crlf  attr/                  \tcommitted-crlf.txt\u0000',
  );
  assert.deepEqual(
    entries.map((entry) => [entry.index, entry.work, entry.attr, entry.path]),
    [
      ['lf', 'crlf', '', 'sub/with space.txt'],
      ['-text', '-text', '-text', 'binary.dat'],
      ['crlf', 'crlf', '', 'committed-crlf.txt'],
    ],
  );
});

test('selectCrlfCarryover: only index-LF files whose working copy grew CRs', () => {
  const paths = selectCrlfCarryover([
    { index: 'lf', work: 'crlf', attr: '', path: 'carryover.txt' },
    { index: 'lf', work: 'mixed', attr: '', path: 'mixed.txt' },
    { index: 'lf', work: 'lf', attr: '', path: 'exact.txt' },
    { index: 'crlf', work: 'crlf', attr: '', path: 'committed-crlf.txt' },
    { index: '-text', work: '-text', attr: '-text', path: 'binary.dat' },
    { index: 'lf', work: 'crlf', attr: 'text eol=crlf', path: 'wants-crlf.bat' },
  ]);
  assert.deepEqual(paths, ['carryover.txt', 'mixed.txt']);
});

test('allowsExactCheckout: false, input and unset keep index bytes; true rewrites them', () => {
  assert.equal(allowsExactCheckout(''), true);
  assert.equal(allowsExactCheckout('false'), true);
  assert.equal(allowsExactCheckout('input'), true);
  assert.equal(allowsExactCheckout('true'), false);
  assert.equal(allowsExactCheckout('TRUE'), false);
});

test('normalizeWorktreeEol rewrites CRLF carry-over to the committed bytes and leaves the tree clean', (t) => {
  const { dir, git } = makeWindowsWorkspace(t);
  git(['config', 'core.autocrlf', 'true']);
  for (const relative of ['lf.txt', 'sub/with space.txt', 'deep/nested/module.ts']) fs.rmSync(path.join(dir, relative));
  git(['checkout', '--', '.']);
  assert.equal(read(dir, 'lf.txt'), crlf('a\nb\n'), 'precondition: the workspace carries CRLF copies');
  git(['config', 'core.autocrlf', 'false']);

  const result = normalizeWorktreeEol({ cwd: dir });

  assert.equal(result.rewritten, 3);
  assert.equal(read(dir, 'lf.txt'), 'a\nb\n');
  assert.equal(read(dir, 'sub/with space.txt'), 'x\ny\n');
  assert.equal(read(dir, 'deep/nested/module.ts'), 'export const n = 1;\n');
  // Files that are already byte-exact are not touched.
  assert.equal(read(dir, 'committed-crlf.txt'), 'a\r\nb\r\n');
  assert.equal(read(dir, 'binary.dat'), '\u0000\u0001\u0002bin\r\n');
  // A size-only difference makes git skip its content check, so the index
  // must be refreshed: a dirty tree here would surface in every later step.
  assert.equal(git(['status', '--porcelain']), '');
  assert.equal(git(['diff', '--cached', '--name-only']), '');
});

test('normalizeWorktreeEol is idempotent: a byte-exact tree costs one listing and rewrites nothing', (t) => {
  const { dir, git } = makeWindowsWorkspace(t);
  git(['config', 'core.autocrlf', 'false']);
  const before = fs.statSync(path.join(dir, 'lf.txt')).mtimeMs;

  const first = normalizeWorktreeEol({ cwd: dir });
  const second = normalizeWorktreeEol({ cwd: dir });

  assert.equal(first.rewritten, 0);
  assert.equal(second.rewritten, 0);
  assert.equal(fs.statSync(path.join(dir, 'lf.txt')).mtimeMs, before);
});

test('normalizeWorktreeEol refuses while checkout would convert the files straight back', (t) => {
  const { dir, git } = makeWindowsWorkspace(t);
  git(['config', 'core.autocrlf', 'true']);
  assert.throws(() => normalizeWorktreeEol({ cwd: dir }), /core\.autocrlf=true/);
});
