#!/usr/bin/env node
// Context-budget report (Phase 2 slice 0) — the measurement base for the
// Studio context-slimming line.
//
// Reads one or many DSH session logs (session.v4.jsonl.zstd under
// <userData>/dsh-sessions/v0/<encoded-cwd>/<cw-id>/) and reports where the
// context budget actually goes:
//
//   • static baseline per session start: tool schema bytes/count, system
//     prompt size, per-surface first-request totals;
//   • volatile-tail accumulation: per-section injection counts + bytes
//     (browser_context vs ownerMemories vs …), the near-duplicate drift the
//     2026-11-18 post-mortem measured (446K chars/day, 63% browser_context);
//   • tool usage census (per surface, for the slice-1 slimming): how often
//     each tool was actually called;
//   • compaction events (active triggers) per session.
//
// Usage:
//   node scripts/context-budget-report.mjs <cw-session-id> [more-ids...]
//   node scripts/context-budget-report.mjs --since 2026-11-18
//   node scripts/context-budget-report.mjs --all --limit 20
//
// Session roots scanned (first existing wins):
//   $IDBOTS_USERDATA/dsh-sessions/v0     (env override)
//   ~/Library/Application Support/IDBots/dsh-sessions/v0   (macOS default)

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import zlib from 'node:zlib';

const CJK = /[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/;

function userDataRoot() {
  if (process.env.IDBOTS_USERDATA) return process.env.IDBOTS_USERDATA;
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'IDBots');
  }
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), 'IDBots');
  }
  return path.join(os.homedir(), '.config', 'IDBots');
}

function sessionRoots() {
  const base = path.join(userDataRoot(), 'dsh-sessions', 'v0');
  if (!fs.existsSync(base)) {
    console.error(`No dsh session root found at ${base}`);
    process.exit(2);
  }
  return base;
}

function listSessionDirs(base) {
  const out = [];
  for (const bucket of fs.readdirSync(base)) {
    const bucketPath = path.join(base, bucket);
    let entries;
    try {
      entries = fs.readdirSync(bucketPath);
    } catch {
      continue;
    }
    for (const dir of entries) {
      if (dir.startsWith('cw-')) out.push(path.join(bucketPath, dir));
    }
  }
  return out;
}

/** Streams a session log's lines without materializing the whole file twice. */
function* readSessionEvents(sessionDir) {
  const zstdPath = path.join(sessionDir, 'session.v4.jsonl.zstd');
  const plainPath = path.join(sessionDir, 'session.v4.jsonl');
  let lines = [];
  if (fs.existsSync(zstdPath)) {
    let stdout;
    try {
      stdout = execFileSync('zstd', ['-dc', zstdPath], { maxBuffer: 512 * 1024 * 1024 });
    } catch (error) {
      console.error(`  (zstd failed for ${zstdPath}: ${error.message})`);
      return;
    }
    lines = stdout.toString('utf8').split('\n');
  } else if (fs.existsSync(plainPath)) {
    // Plain-JSONL fallback: cold archives and synthetic test fixtures.
    lines = fs.readFileSync(plainPath, 'utf8').split('\n');
  } else {
    return;
  }
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      yield JSON.parse(line);
    } catch {
      // Ignore malformed lines; the log is append-only JSONL.
    }
  }
}

const textOf = (content) => Array.isArray(content) ? content.map((block) => (typeof block?.text === 'string' ? block.text : '')).join('') : '';

function estimateTokens(chars, { cjkAware = true } = {}) {
  if (typeof chars !== 'string') return Math.ceil(chars / 4);
  if (!cjkAware) return Math.ceil(chars / 4);
  // chars/4 overcounts CJK by ~2x; blend: CJK chars at 0.33 tokens/char
  // (empirical 11-19 calibration), the rest at 0.25.
  let cjkCount = 0;
  for (const ch of chars) if (CJK.test(ch)) cjkCount += 1;
  const rest = chars.length - cjkCount;
  return Math.ceil(cjkCount * 0.33 + rest * 0.25);
}

function analyzeSession(sessionDir, { sinceMs }) {
  const report = {
    dir: sessionDir,
    id: path.basename(sessionDir),
    cwd: '',
    createdAt: null,
    routes: [],
    toolSchemaSamples: [], // { bytes, count } per request/header
    systemMessages: [], // { seq, chars }
    userInjections: [], // { seq, chars, sections: { name: chars } }
    toolCalls: new Map(), // name -> calls
    assistantMessages: 0,
    turns: 0,
    compactions: 0,
    quotaDeaths: 0,
    firstRequestTokens: null,
    lastCacheReadTokens: null,
  };
  const SECTION_TAGS = [
    'ownerMemories', 'contactMemories', 'conversationMemories', 'ownerOperationalPreferences',
    'recent_sessions', 'metabot_self_identity', 'work_reviews', 'proven_techniques',
    'recent_daily_summaries', 'knowledge', 'procedures', 'local_worker_impressions',
    'team_culture', 'knowledge_bases', 'browser_context', 'browser_guide',
    'active_tasks', 'task_intents', 'studio_continuity_brief', 'twin_pending_todos',
    'studio_active_workers', 'active_studio_briefing', 'studio_queue_awareness',
    'session_chapters', 'goal', 'remote_services', 'skills', 'channel_capabilities',
    'available_skills',
  ];
  for (const event of readSessionEvents(sessionDir)) {
    if (sinceMs && (event.time ?? 0) < sinceMs) continue;
    switch (event.type) {
      case 'session': {
        // v4 session header: id/createdAt/cwd live at the TOP level.
        report.cwd = event.cwd ?? event.data?.cwd ?? '';
        report.createdAt = event.createdAt ?? event.time ?? null;
        break;
      }
      case 'model/selection': {
        const key = `${event.data?.provider ?? '?'}/${event.data?.model ?? '?'}`;
        report.routes.push(key);
        break;
      }
      case 'request/header': {
        const tools = event.data?.header?.tools ?? [];
        const bytes = JSON.stringify(tools).length;
        report.toolSchemaSamples.push({ bytes, count: tools.length });
        break;
      }
      case 'request/context': {
        if (event.data?.contextWindow && report.firstRequestTokens == null) {
          // Filled from usage below; recorded for the window value.
          report.contextWindow = event.data.contextWindow;
        }
        break;
      }
      case 'system/message': {
        const chars = textOf(event.data?.message?.content ?? []).length;
        if (chars > 0) report.systemMessages.push({ seq: event.seq, chars });
        break;
      }
      case 'user/message': {
        const text = textOf(event.data?.content ?? []);
        if (text.length < 400) break;
        const sections = {};
        for (const tag of SECTION_TAGS) {
          const at = text.indexOf(`<${tag}>`);
          if (at < 0) continue;
          const end = text.indexOf(`</${tag}>`, at);
          const span = (end > at ? end + tag.length + 3 : text.length) - at;
          sections[tag] = span;
        }
        report.userInjections.push({ seq: event.seq, chars: text.length, sections });
        break;
      }
      case 'tool/call': {
        const name = event.data?.call?.name ?? event.data?.name ?? '?';
        report.toolCalls.set(name, (report.toolCalls.get(name) ?? 0) + 1);
        break;
      }
      case 'assistant/message': {
        report.assistantMessages += 1;
        const usage = event.data?.usage;
        if (usage && typeof usage.cacheReadTokens === 'number' && usage.cacheReadTokens > 0) {
          report.lastCacheReadTokens = usage.cacheReadTokens + (usage.inputTokens ?? 0);
        }
        if (report.firstRequestTokens == null && usage && (usage.inputTokens ?? 0) + (usage.cacheReadTokens ?? 0) > 1000) {
          report.firstRequestTokens = (usage.inputTokens ?? 0) + (usage.cacheReadTokens ?? 0);
        }
        break;
      }
      case 'turn/start':
        report.turns += 1;
        break;
      case 'compaction/summary':
        report.compactions += 1;
        break;
      case 'turn/end':
        if (event.data?.reason?.kind === 'error' && /insufficient|quota/i.test(event.data?.reason?.error?.message ?? '')) {
          report.quotaDeaths += 1;
        }
        break;
      default:
        break;
    }
  }
  return report;
}

function fmtK(n) {
  return n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)}M` : `${Math.round(n / 1024)}K`;
}

function printReport(reports) {
  console.log(`# Context budget report — ${reports.length} session(s)\n`);
  const aggTools = new Map();
  for (const r of reports) {
    const date = r.createdAt ? new Date(r.createdAt).toISOString().slice(0, 16).replace('T', ' ') : '?';
    console.log(`## ${r.id}`);
    console.log(`- started ${date}, cwd ${r.cwd || '?'}`);
    const routes = [...new Set(r.routes)];
    console.log(`- routes seen: ${routes.join(' → ') || '?'}`);
    console.log(`- turns: ${r.turns}, assistant msgs: ${r.assistantMessages}, compactions: ${r.compactions}, quota deaths: ${r.quotaDeaths}`);
    const header = r.toolSchemaSamples[0];
    if (header) {
      console.log(`- tool schema (first header): ${header.count} tools, ${fmtK(header.bytes)} bytes ≈ ${fmtK(estimateTokens(header.bytes))} tokens (chars/4: ${fmtK(Math.ceil(header.bytes / 4))})`);
      const max = r.toolSchemaSamples.reduce((a, b) => (b.count > a.count ? b : a), header);
      if (max.count !== header.count) {
        console.log(`- tool schema max: ${max.count} tools, ${fmtK(max.bytes)} bytes`);
      }
    }
    if (r.contextWindow) console.log(`- declared context window: ${r.contextWindow.toLocaleString()}`);
    if (r.firstRequestTokens != null) console.log(`- first measured request: ~${r.firstRequestTokens.toLocaleString()} tokens`);
    if (r.lastCacheReadTokens != null) console.log(`- last measured context: ~${r.lastCacheReadTokens.toLocaleString()} tokens`);
    const sys = r.systemMessages.filter((m) => m.chars > 0);
    if (sys.length > 0) {
      const biggest = sys.reduce((a, b) => (b.chars > a.chars ? b : a));
      console.log(`- system prompts: ${sys.length} snapshot(s), biggest ${fmtK(biggest.chars)} chars`);
    }
    // Volatile injection aggregate
    const sectionAgg = new Map();
    let injectTotal = 0;
    for (const inj of r.userInjections) {
      injectTotal += inj.chars;
      for (const [tag, span] of Object.entries(inj.sections)) {
        sectionAgg.set(tag, (sectionAgg.get(tag) ?? 0) + span);
      }
    }
    if (r.userInjections.length > 0) {
      console.log(`- big user-message injections: ${r.userInjections.length} × avg ${fmtK(injectTotal / r.userInjections.length)} chars, total ${fmtK(injectTotal)} chars`);
      const top = [...sectionAgg.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
      for (const [tag, span] of top) {
        console.log(`    ${tag.padEnd(28)} ${fmtK(span)} (${Math.round((span / injectTotal) * 100)}%)`);
      }
    }
    for (const [name, calls] of r.toolCalls) {
      aggTools.set(name, (aggTools.get(name) ?? 0) + calls);
    }
    console.log('');
  }
  if (aggTools.size > 0) {
    console.log(`## Tool usage census (${reports.length} session(s), ${aggTools.size} distinct tools called)\n`);
    const sorted = [...aggTools.entries()].sort((a, b) => b[1] - a[1]);
    for (const [name, calls] of sorted.slice(0, 40)) {
      console.log(`  ${String(calls).padStart(5)}  ${name}`);
    }
    if (sorted.length > 40) console.log(`  … ${sorted.length - 40} more tools called at least once`);
  }
}

function main() {
  const args = process.argv.slice(2);
  const base = sessionRoots();
  let dirs = [];
  let sinceMs = null;
  if (args[0] === '--all' || args[0] === '--since') {
    const all = listSessionDirs(base);
    const sinceIdx = args.indexOf('--since');
    if (sinceIdx >= 0 && args[sinceIdx + 1]) {
      sinceMs = Date.parse(args[sinceIdx + 1]);
      if (Number.isNaN(sinceMs)) {
        console.error('Bad --since date');
        process.exit(2);
      }
    }
    const limitIdx = args.indexOf('--limit');
    const limit = limitIdx >= 0 ? Number(args[limitIdx + 1] ?? 20) : 20;
    dirs = all
      .map((dir) => {
        const logPath = path.join(dir, 'session.v4.jsonl.zstd');
        const plainPath = path.join(dir, 'session.v4.jsonl');
        try {
          const stat = fs.existsSync(logPath)
            ? fs.statSync(logPath)
            : fs.existsSync(plainPath)
              ? fs.statSync(plainPath)
              : null;
          return stat ? { dir, mtime: stat.mtimeMs } : null;
        } catch {
          return null;
        }
      })
      .filter((entry) => entry != null)
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, limit)
      .map((entry) => entry.dir);
  } else {
    dirs = args.flatMap((id) => listSessionDirs(base).filter((dir) => path.basename(dir).includes(id)));
    if (dirs.length === 0) {
      console.error(`No session matching: ${args.join(' ')}`);
      process.exit(2);
    }
  }
  const reports = dirs.map((dir) => analyzeSession(dir, { sinceMs }));
  printReport(reports);
}

main();
