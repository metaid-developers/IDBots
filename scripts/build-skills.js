#!/usr/bin/env node
'use strict';

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const SKILLS_DIR = path.join(ROOT, 'SKILLs');

const TSC_FLAGS = [
  '--module', 'commonjs',
  '--target', 'ES2020',
  '--lib', 'ES2020',
  '--esModuleInterop',
  '--skipLibCheck',
  '--moduleResolution', 'node',
  '--resolveJsonModule',
  '--strict',
].join(' ');

function findTsFiles(dir) {
  const results = [];
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== 'node_modules' && entry.name !== 'dist') {
      results.push(...findTsFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      const jsPath = full.replace(/\.ts$/, '.js');
      if (fs.existsSync(jsPath)) {
        results.push(full);
      }
    }
  }
  return results;
}

function main() {
  if (!fs.existsSync(SKILLS_DIR)) {
    console.log('SKILLs directory not found, skipping skill compilation.');
    return;
  }

  const tsFiles = findTsFiles(SKILLS_DIR);
  if (tsFiles.length === 0) {
    console.log('No SKILL .ts files (with companion .js) found. Nothing to compile.');
    return;
  }

  console.log(`Compiling ${tsFiles.length} SKILL script(s)...`);
  let failed = 0;

  for (const tsFile of tsFiles) {
    const rel = path.relative(ROOT, tsFile);
    const outDir = path.dirname(tsFile);
    const cmd = `npx tsc ${TSC_FLAGS} --outDir "${outDir}" "${tsFile}"`;
    try {
      execSync(cmd, { cwd: ROOT, stdio: 'pipe' });
      console.log(`  ✓ ${rel}`);
    } catch (err) {
      failed++;
      console.error(`  ✗ ${rel}`);
      if (err.stderr) console.error(`    ${err.stderr.toString().trim()}`);
      if (err.stdout) console.error(`    ${err.stdout.toString().trim()}`);
    }
  }

  if (failed > 0) {
    console.error(`\n${failed} SKILL script(s) failed to compile.`);
    process.exit(1);
  }
  console.log('All SKILL scripts compiled successfully.');
}

main();
