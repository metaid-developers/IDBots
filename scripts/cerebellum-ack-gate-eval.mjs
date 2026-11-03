#!/usr/bin/env node
/**
 * cerebellum-ack-gate-eval — offline eval of the turn-ack gate (first-sentence
 * bubble).
 *
 * Each case is one just-arrived user message. The labeled question: does
 * answering it take noticeable time — tool use (local-machine / web2 /
 * AI-internet search, files, shell, browser), recall of past conversations,
 * multi-step work, or a long composed answer (needsAck = true, keep the
 * interim ack bubble) — or can the assistant cover it in one short
 * conversational reply from context (needsAck = false, skip the ack so the
 * main reply is the single bubble)?
 *
 * The metric that matters is SILENT: a case labeled needsAck=true that the
 * gate would skip. A skipped ack on a slow turn leaves the owner staring at a
 * bare activity indicator; a redundant ack on a quick turn only costs one
 * extra bubble.
 *
 * The request body is buildTurnAckGateRequest, so the wording cannot drift.
 * The production threshold (CEREBELLUM_TURN_ACK_GATE_THRESHOLD) is 0.5 — this
 * script is how it gets measured; see
 * docs/design/2026-10-13-cerebellum-system-handoff.md for the gate pattern.
 *
 * Usage:
 *   node scripts/cerebellum-ack-gate-eval.mjs eval --dry-run
 *   node scripts/cerebellum-ack-gate-eval.mjs eval
 *   node scripts/cerebellum-ack-gate-eval.mjs eval --cases cases.json
 *
 * --cases: [{ id, userMessage, needsAck }]
 * --out results.json: persist the scored rows + threshold sweep as a
 *   calibration artifact.
 *
 * API credentials: --key / TYPESAFE_API_KEY (or JEV_API_KEY), --base-url /
 * TYPESAFE_BASE_URL, --model / TYPESAPE_MODEL (sic: TYPESAFE_MODEL).
 */

import { argv, env, exit } from 'node:process';

import {
  CEREBELLUM_TURN_ACK_GATE_THRESHOLD,
  buildTurnAckGateRequest,
  parseTurnAckGateAnswer,
  turnAckNeededFromNoul,
} from '../src/main/cerebellum/ackGate.ts';

const SAMPLE = [
  // The 2026-11-03 incident messages (session 3ecd2a2f) lead the set.
  {
    id: 'a1',
    userMessage: '我们随便聊聊，主要是测试一下手机响应时间。你就正常回复我就好了。你知道明天是几月几号吗？',
    needsAck: false,
  },
  {
    id: 'a2',
    userMessage: '你还记得我说过要去香港见投资人的事情吗❓',
    needsAck: true,
  },
  {
    id: 'a3',
    userMessage: '在吗',
    needsAck: false,
  },
  {
    id: 'a4',
    userMessage: '早上好呀，今天心情不错',
    needsAck: false,
  },
  {
    id: 'a5',
    userMessage: '谢谢，辛苦了',
    needsAck: false,
  },
  {
    id: 'a6',
    userMessage: '1 英寸等于多少厘米？',
    needsAck: false,
  },
  {
    id: 'a7',
    userMessage: '这个文件好像之前申请过的，你要不搜一下本机看有没有？',
    needsAck: true,
  },
  {
    id: 'a8',
    userMessage: '帮我查一下昨天让你发的那条 buzz 发出去没有，链上状态如何',
    needsAck: true,
  },
  {
    id: 'a9',
    userMessage: '帮我把这个 bug 修一下：点一键购买报"购买未完成，请重试"',
    needsAck: true,
  },
  {
    id: 'a10',
    userMessage: 'web3 和 web2 的区别，三句话以内说清',
    needsAck: false,
  },
  {
    id: 'a11',
    userMessage: '给我详细讲讲量子计算的原理，从量子比特开始',
    needsAck: true,
  },
  {
    id: 'a12',
    userMessage: '去网上搜一下最近 MVC 链的手续费有没有变化，顺便看看 AI 互联网上有没有人讨论',
    needsAck: true,
  },
  {
    id: 'a13',
    userMessage: '继续',
    needsAck: false,
  },
  {
    id: 'a14',
    userMessage: '把上周的梦境报告翻出来，汇总成一份月报发给我',
    needsAck: true,
  },
];

const SWEEP = [0.2, 0.35, 0.5, 0.65];

function parseArgs(args) {
  const opts = {};
  const positional = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--verbose') opts.verbose = true;
    else if (arg === '--key') opts.apiKey = args[++i];
    else if (arg === '--base-url') opts.baseUrl = args[++i];
    else if (arg === '--model') opts.model = args[++i];
    else if (arg === '--cases') opts.cases = args[++i];
    else if (arg === '--out') opts.out = args[++i];
    else if (arg.startsWith('--')) {
      console.error(`unknown option: ${arg}`);
      exit(2);
    } else positional.push(arg);
  }
  return { mode: positional[0] ?? 'eval', opts };
}

async function postJson(url, apiKey, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  const started = Date.now();
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
    return { data: JSON.parse(text), latencyMs: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

async function runEval(opts) {
  const cases = opts.casesData ?? SAMPLE;
  if (opts.dryRun) {
    console.log(`dry-run: ${cases.length} cases — no API calls made.\n`);
    for (const item of cases) {
      console.log(`  ${item.needsAck ? 'ACK  ' : 'SKIP '}  ${item.id}  ${item.userMessage.slice(0, 40)}`);
    }
    console.log('\nfirst request body that would be sent:');
    console.log(JSON.stringify(buildTurnAckGateRequest({
      currentUserText: cases[0].userMessage,
      model: opts.model,
    }), null, 2));
    return;
  }

  let silent = 0;
  let redundant = 0;
  let labeled = 0;
  const scored = [];
  for (const item of cases) {
    const request = buildTurnAckGateRequest({
      currentUserText: item.userMessage,
      model: opts.model,
    });
    let data;
    let latencyMs;
    try {
      ({ data, latencyMs } = await postJson(`${opts.baseUrl}/v1/systemone`, opts.apiKey, request));
    } catch (error) {
      console.error(`  ${item.id} failed: ${error.message}`);
      continue;
    }
    const noul = parseTurnAckGateAnswer(data);
    if (noul === null) {
      console.error(`  ${item.id} no noul`);
      continue;
    }
    const needsAck = turnAckNeededFromNoul(noul);
    const want = item.needsAck === true;
    labeled += 1;
    if (want && !needsAck) silent += 1;
    if (!want && needsAck) redundant += 1;
    scored.push({ ...item, want, noul, needsAck });
    const mark = want === needsAck ? 'ok' : want ? 'SILENT' : 'REDUNDANT';
    console.log(`${mark.padEnd(9)} ${item.id}  noul=${noul.toFixed(2)}  want=${want ? 'ack' : 'skip'}  [${latencyMs}ms]  ${item.userMessage.slice(0, 40)}`);
  }

  console.log('—'.repeat(72));
  console.log(`threshold=${CEREBELLUM_TURN_ACK_GATE_THRESHOLD}  silent=${silent}  redundant=${redundant}  labeled=${labeled}`);
  const sweep = [];
  console.log('threshold sweep (silent / redundant):');
  for (const threshold of SWEEP) {
    let sweepSilent = 0;
    let sweepRedundant = 0;
    for (const item of scored) {
      const needsAck = turnAckNeededFromNoul(item.noul, threshold);
      if (item.want && !needsAck) sweepSilent += 1;
      if (!item.want && needsAck) sweepRedundant += 1;
    }
    sweep.push({ threshold, silent: sweepSilent, redundant: sweepRedundant });
    console.log(`  >=${threshold.toFixed(2)}  silent=${sweepSilent}  redundant=${sweepRedundant}`);
  }
  if (labeled < cases.length) {
    console.log(`warning: ${cases.length - labeled} case(s) produced no usable noul — sweep is partial`);
  }
  if (opts.out) {
    const artifact = {
      generatedAt: new Date().toISOString(),
      model: opts.model,
      productionThreshold: CEREBELLUM_TURN_ACK_GATE_THRESHOLD,
      labeled,
      silent,
      redundant,
      cases: scored,
      sweep,
    };
    await (await import('node:fs/promises')).writeFile(opts.out, JSON.stringify(artifact, null, 2));
    console.log(`results written to ${opts.out}`);
  }
}

const { mode, opts } = parseArgs(argv.slice(2));
const apiKey = opts.apiKey ?? env.TYPESAFE_API_KEY ?? env.JEV_API_KEY;
const baseUrl = (opts.baseUrl ?? env.TYPESAFE_BASE_URL ?? 'https://api.typesafe.ai').replace(/\/+$/, '');
const model = opts.model ?? env.TYPESAFE_MODEL ?? 'jev-latest';

if (!apiKey && !opts.dryRun) {
  console.error('missing API key: pass --key or set TYPESAFE_API_KEY (or pass --dry-run)');
  exit(2);
}
if (opts.cases) {
  opts.casesData = JSON.parse(await (await import('node:fs/promises')).readFile(opts.cases, 'utf8'));
}

try {
  if (mode !== 'eval') {
    console.error(`unknown mode: ${mode} (use eval)`);
    exit(2);
  }
  await runEval({ ...opts, apiKey, baseUrl, model });
} catch (error) {
  console.error(error.message);
  exit(1);
}
