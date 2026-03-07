#!/usr/bin/env node
/**
 * MetaApp Packaging Script (Node.js)
 *
 * Packages a MetaApp frontend project into a distributable zip archive.
 * Validates project structure and creates a timestamped zip file.
 *
 * Usage:
 *   node scripts/package_metaapp.js <project_root> [--output <output_dir>]
 *
 * Examples:
 *   node scripts/package_metaapp.js ~/idbots/project/MyApp
 *   node scripts/package_metaapp.js ~/idbots/project/MyApp --output ./dist
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const zlib = require('zlib');
const { spawnSync } = require('child_process');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const METAAPP_REQUIRED_FILES = ['index.html', 'app.js', 'app.css', 'idframework.js'];
const METAAPP_REQUIRED_DIRS = ['idcomponents', 'commands'];

const EXCLUDE_DIRS = new Set([
  '.git', '.idea', '.vscode', 'node_modules', '__pycache__', 'dist', 'build', '.DS_Store',
]);

const EXCLUDE_FILE_PREFIXES = new Set(['.DS_Store', '.gitignore', '.gitattributes']);
const EXCLUDE_EXTENSIONS = new Set(['.zip', '.log']);

// ---------------------------------------------------------------------------
// CRC-32
// ---------------------------------------------------------------------------

const crc32Table = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c;
  }
  return t;
})();

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = crc32Table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

// ---------------------------------------------------------------------------
// ZIP writer (no external deps, uses Node built-in zlib for DEFLATE)
// ---------------------------------------------------------------------------

/**
 * @param {Array<{name: string, data: Buffer}>} entries
 * @returns {Buffer}
 */
function buildZip(entries) {
  const parts = [];
  const centralDir = [];
  let offset = 0;

  for (const { name, data } of entries) {
    const nameBytes = Buffer.from(name, 'utf8');
    const deflated = zlib.deflateRawSync(data, { level: 6 });
    const useDeflate = deflated.length < data.length;
    const compData = useDeflate ? deflated : data;
    const compMethod = useDeflate ? 8 : 0;
    const crc = crc32(data);

    // Local file header
    const lh = Buffer.allocUnsafe(30 + nameBytes.length);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0, 6);
    lh.writeUInt16LE(compMethod, 8);
    lh.writeUInt16LE(0, 10);
    lh.writeUInt16LE(0, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(compData.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nameBytes.length, 26);
    lh.writeUInt16LE(0, 28);
    nameBytes.copy(lh, 30);

    parts.push(lh, compData);

    // Central directory entry
    const cd = Buffer.allocUnsafe(46 + nameBytes.length);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0, 8);
    cd.writeUInt16LE(compMethod, 10);
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(0, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(compData.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBytes.length, 28);
    cd.writeUInt16LE(0, 30);
    cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34);
    cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(0, 38);
    cd.writeUInt32LE(offset, 42);
    nameBytes.copy(cd, 46);

    centralDir.push(cd);
    offset += lh.length + compData.length;
  }

  const cdBuf = Buffer.concat(centralDir);
  const eocd = Buffer.allocUnsafe(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(centralDir.length, 8);
  eocd.writeUInt16LE(centralDir.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...parts, cdBuf, eocd]);
}

// ---------------------------------------------------------------------------
// Project validation
// ---------------------------------------------------------------------------

function isMetaAppProject(root) {
  const missing = [];
  for (const f of METAAPP_REQUIRED_FILES) {
    if (!fs.existsSync(path.join(root, f)) || !fs.statSync(path.join(root, f)).isFile()) {
      missing.push(`File: ${f}`);
    }
  }
  for (const d of METAAPP_REQUIRED_DIRS) {
    if (!fs.existsSync(path.join(root, d)) || !fs.statSync(path.join(root, d)).isDirectory()) {
      missing.push(`Directory: ${d}`);
    }
  }
  return { valid: missing.length === 0, missing };
}

// ---------------------------------------------------------------------------
// File/dir exclusion
// ---------------------------------------------------------------------------

function shouldExclude(filePath, srcRoot) {
  let rel;
  try {
    rel = path.relative(srcRoot, filePath);
  } catch {
    return true;
  }

  const parts = rel.split(path.sep);
  for (const part of parts) {
    if (EXCLUDE_DIRS.has(part)) return true;
    if (part.startsWith('.') && part !== '.' && part !== '..') return true;
  }

  const stat = fs.existsSync(filePath) ? fs.statSync(filePath) : null;
  if (stat && stat.isFile()) {
    const baseName = path.basename(filePath);
    for (const prefix of EXCLUDE_FILE_PREFIXES) {
      if (baseName.startsWith(prefix)) return true;
    }
    const ext = path.extname(filePath).toLowerCase();
    if (EXCLUDE_EXTENSIONS.has(ext)) return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Zip creation
// ---------------------------------------------------------------------------

function createZipArchive(srcRoot, zipPath) {
  const srcPathResolved = path.resolve(srcRoot);
  const zipPathResolved = path.resolve(zipPath);

  // Ensure output directory exists
  fs.mkdirSync(path.dirname(zipPathResolved), { recursive: true });

  const entries = [];

  function walk(dir) {
    const items = fs.readdirSync(dir);
    for (const item of items) {
      const fullPath = path.join(dir, item);
      if (shouldExclude(fullPath, srcPathResolved)) continue;

      const stat = fs.statSync(fullPath);
      if (stat.isDirectory()) {
        walk(fullPath);
      } else if (stat.isFile()) {
        const relPath = path.relative(srcPathResolved, fullPath).replace(/\\/g, '/');
        const data = fs.readFileSync(fullPath);
        entries.push({ name: relPath, data });
      }
    }
  }

  walk(srcPathResolved);

  const zipBuf = buildZip(entries);
  fs.writeFileSync(zipPathResolved, zipBuf);
  return { zipPath: zipPathResolved, size: zipBuf.length, fileCount: entries.length };
}

// ---------------------------------------------------------------------------
// Checklist gate
// ---------------------------------------------------------------------------

function runChecklistGate(projectRoot) {
  const thisScript = path.resolve(__filename);
  const scriptsDir = path.dirname(thisScript);

  // Prefer .js validator, fall back to .py
  const jsValidator = path.join(scriptsDir, 'validate_metaapp_checklist.js');
  const pyValidator = path.join(scriptsDir, 'validate_metaapp_checklist.py');

  if (fs.existsSync(jsValidator)) {
    console.log('🔍 Running hard checklist gate (predeliver) via JS validator...');
    const result = spawnSync(
      process.execPath,
      [jsValidator, '--phase', 'predeliver', '--project', projectRoot],
      { stdio: 'inherit' },
    );
    return result.status === 0;
  }

  if (fs.existsSync(pyValidator)) {
    console.log('🔍 Running hard checklist gate (predeliver) via Python validator...');
    const result = spawnSync(
      process.platform === 'win32' ? 'python' : 'python3',
      [pyValidator, '--phase', 'predeliver', '--project', projectRoot],
      { stdio: 'inherit' },
    );
    return result.status === 0;
  }

  process.stderr.write(`⚠️  Warning: checklist validator not found in ${scriptsDir}\n`);
  return true; // Allow packaging if validator is missing (warn only)
}

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------

function main() {
  const args = process.argv.slice(2);

  const getArg = (flag) => {
    const idx = args.indexOf(flag);
    return idx !== -1 ? args[idx + 1] : null;
  };

  // First positional arg is project root
  const positional = args.filter((a) => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--output');
  const projectArg = positional[0] || '.';
  const outputArg = getArg('--output');

  // Expand ~
  const expand = (p) => (p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p);

  const projectRoot = path.resolve(expand(projectArg));

  if (!fs.existsSync(projectRoot)) {
    process.stderr.write(`❌ Error: Project root does not exist: ${projectRoot}\n`);
    process.exit(1);
  }
  if (!fs.statSync(projectRoot).isDirectory()) {
    process.stderr.write(`❌ Error: Project root is not a directory: ${projectRoot}\n`);
    process.exit(1);
  }

  const { valid, missing } = isMetaAppProject(projectRoot);
  if (!valid) {
    process.stderr.write(`❌ Error: Directory is not a valid MetaApp project: ${projectRoot}\n`);
    process.stderr.write('\nMissing required items:\n');
    for (const item of missing) process.stderr.write(`  - ${item}\n`);
    process.stderr.write(`\nRequired files: ${METAAPP_REQUIRED_FILES.join(', ')}\n`);
    process.stderr.write(`Required directories: ${METAAPP_REQUIRED_DIRS.join(', ')}\n`);
    process.exit(1);
  }

  // Hard gate: predeliver checklist
  const gateOk = runChecklistGate(projectRoot);
  if (!gateOk) {
    process.stderr.write('❌ Packaging aborted: checklist gate failed.\n');
    process.exit(1);
  }

  // Determine output path
  const timestamp = Math.floor(Date.now() / 1000);
  let zipPath;
  if (outputArg) {
    const outputDir = path.resolve(expand(outputArg));
    fs.mkdirSync(outputDir, { recursive: true });
    zipPath = path.join(outputDir, `dist-${timestamp}.zip`);
  } else {
    zipPath = path.join(projectRoot, `dist-${timestamp}.zip`);
  }

  console.log(`📦 Packaging MetaApp project: ${projectRoot}`);
  console.log(`📁 Output: ${zipPath}`);

  try {
    const { size, fileCount } = createZipArchive(projectRoot, zipPath);
    const sizeMb = (size / (1024 * 1024)).toFixed(2);
    console.log('✅ Success! MetaApp packaged successfully');
    console.log(`   File: ${zipPath}`);
    console.log(`   Size: ${sizeMb} MB (${size.toLocaleString()} bytes)`);
    console.log(`   Files: ${fileCount} files packed`);
  } catch (err) {
    process.stderr.write(`❌ Error: Failed to create zip archive: ${err.message}\n`);
    console.error(err);
    process.exit(1);
  }
}

main();
