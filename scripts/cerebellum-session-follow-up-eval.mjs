#!/usr/bin/env node
/**
 * cerebellum-session-follow-up-eval — offline eval of the session follow-up
 * gate (Follow-Up Tasks / 待跟进任务).
 *
 * Each case is one completed turn: the session title plus the last assistant
 * message. The labeled question: does this turn end by asking the human owner
 * to decide / approve / choose / reply (follow-up = true), or is it a final
 * report / bot-to-bot handoff that completes the task (follow-up = false)?
 *
 * The metric that matters is LOST: a case labeled follow-up=true that the
 * gate would settle back (skip). Missed follow-ups strand owner decisions in
 * the collapsed Autonomous fold; extra follow-ups only surface a section.
 *
 * The request body is buildSessionFollowUpRequest, so the wording cannot
 * drift. The production threshold (CEREBELLUM_SESSION_FOLLOW_UP_THRESHOLD) is
 * 0.5 — precision-biased by owner decision (2026-10-31, revisiting the
 * 2026-10-23 recall bias at 0.35; scheduled runs now carry the explicit
 * [FOLLOW_UP: owner|none] tag the gate consumes first) — this script is how it
 * gets measured; see docs/design/2026-10-13-cerebellum-system-handoff.md §2.20.
 *
 * Usage:
 *   node scripts/cerebellum-session-follow-up-eval.mjs eval --dry-run
 *   node scripts/cerebellum-session-follow-up-eval.mjs eval
 *   node scripts/cerebellum-session-follow-up-eval.mjs eval --cases cases.json
 *
 * --cases: [{ id, sessionTitle, taskName?, lastAssistant, followUp }]
 * --out results.json: persist the scored rows + threshold sweep as a
 *   calibration artifact (review Minor 9).
 *
 * API credentials: --key / TYPESAFE_API_KEY (or JEV_API_KEY), --base-url /
 * TYPESAFE_BASE_URL, --model / TYPESAPE_MODEL (sic: TYPESAFE_MODEL).
 */

import { argv, env, exit } from 'node:process';

import {
  CEREBELLUM_SESSION_FOLLOW_UP_THRESHOLD,
  buildSessionFollowUpRequest,
  parseSessionFollowUpAnswer,
  sessionFollowUpFromNoul,
} from '../src/main/cerebellum/sessionFollowUpGate.ts';

const SAMPLE = [
  {
    id: 'f1',
    sessionTitle: '修复构建失败',
    lastAssistant: '构建失败的根因是 pnpm-workspace.yaml 的 overrides 冲突。我已修复并本地验证通过,需要你确认后我再提交,可以吗?',
    followUp: true,
  },
  {
    id: 'f2',
    sessionTitle: '整理本周梦境报告',
    lastAssistant: '本周梦境报告已生成:7 晚全部完成,新增 3 条 value_boundary,固定试卷得分 0.72。报告已保存到 output 目录。',
    followUp: false,
  },
  {
    id: 'f3',
    sessionTitle: '群任务 #12 交付物验收',
    taskName: '官网海报设计',
    lastAssistant: '海报终稿已按验收意见改完配色,回传 Pin 已发布。验收通过,任务关闭。',
    followUp: false,
  },
  {
    id: 'f4',
    sessionTitle: '升级 DSH 内核',
    lastAssistant: '内核 0.2.1 升级计划有两处风险需要你拍板:① 是否接受首个夜间窗口的 15 秒启动延迟;② 回滚保留天数 7 天是否够?请回复 ①② 的决定。',
    followUp: true,
  },
  {
    id: 'f5',
    sessionTitle: '回复私聊询问',
    lastAssistant: '对方问的是链上手续费问题,我已按最新费率回答并附了查询链接,对方已读。',
    followUp: false,
  },
  {
    id: 'f6',
    sessionTitle: '数据库迁移检查',
    lastAssistant: '迁移检查发现 capability_drafts 表缺 origin 列。我可以按幂等模式补迁移,但这会写用户库——需要你授权后执行,还是先只做只读检查?',
    followUp: true,
  },
  {
    id: 'f7',
    sessionTitle: '冲浪报告汇总',
    lastAssistant: '冲浪完成:读了 6 篇,赞了 2 篇,收藏 1 篇到知识库,报告已写入 run 记录。',
    followUp: false,
  },
  {
    id: 'f8',
    sessionTitle: '视频渲染参数确认',
    lastAssistant: '你给的参数里码率与分辨率不匹配目标平台上限。我推荐两个可行组合(高画质 / 小体积),你选一个我就开跑。',
    followUp: true,
  },
  {
    id: 'f9',
    sessionTitle: '链上发布早间简报',
    lastAssistant: '早间简报已发布,Pin ID 已记录,buzz 上已有 3 个赞。定时任务下次运行时间明早 8 点。',
    followUp: false,
  },
  {
    id: 'f10',
    sessionTitle: '清理孤儿会话',
    lastAssistant: '发现 12 个失败冲浪留下的孤儿会话。我可以批量归档(不可逆地移出列表),还是你想先逐个看一眼?',
    followUp: true,
  },
  {
    id: 'f11',
    sessionTitle: 'Bot 人格设定更新',
    lastAssistant: '新 soul 文案已写入草稿,未生效。说「确认」我就替换,说「再改」我继续调整。',
    followUp: true,
  },
  {
    id: 'f12',
    sessionTitle: '知识库索引重建',
    lastAssistant: '索引重建完成,12 个文档全部可检索,耗时 40 秒。',
    followUp: false,
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
      console.log(`  ${item.followUp ? 'FOLLOW-UP' : 'SETTLED '}  ${item.id}  ${item.sessionTitle}`);
    }
    console.log('\nfirst request body that would be sent:');
    const first = cases[0];
    console.log(JSON.stringify(buildSessionFollowUpRequest({
      sessionTitle: first.sessionTitle,
      taskName: first.taskName,
      lastAssistantText: first.lastAssistant,
      model: opts.model,
    }), null, 2));
    return;
  }

  let lost = 0;
  let extra = 0;
  let labeled = 0;
  const scored = [];
  for (const item of cases) {
    const request = buildSessionFollowUpRequest({
      sessionTitle: item.sessionTitle,
      taskName: item.taskName,
      lastAssistantText: item.lastAssistant,
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
    const noul = parseSessionFollowUpAnswer(data);
    if (noul === null) {
      console.error(`  ${item.id} no noul`);
      continue;
    }
    const followUp = sessionFollowUpFromNoul(noul);
    const want = item.followUp === true;
    labeled += 1;
    if (want && !followUp) lost += 1;
    if (!want && followUp) extra += 1;
    scored.push({ ...item, want, noul, followUp });
    const mark = want === followUp ? 'ok' : want ? 'LOST' : 'EXTRA';
    console.log(`${mark.padEnd(5)} ${item.id}  noul=${noul.toFixed(2)}  want=${want ? 'follow-up' : 'settled'}  [${latencyMs}ms]  ${item.sessionTitle}`);
  }

  console.log('—'.repeat(72));
  console.log(`threshold=${CEREBELLUM_SESSION_FOLLOW_UP_THRESHOLD}  lost=${lost}  extra=${extra}  labeled=${labeled}`);
  const sweep = [];
  console.log('threshold sweep (lost / extra):');
  for (const threshold of SWEEP) {
    let sweepLost = 0;
    let sweepExtra = 0;
    for (const item of scored) {
      const followUp = sessionFollowUpFromNoul(item.noul, threshold);
      if (item.want && !followUp) sweepLost += 1;
      if (!item.want && followUp) sweepExtra += 1;
    }
    sweep.push({ threshold, lost: sweepLost, extra: sweepExtra });
    console.log(`  >=${threshold.toFixed(2)}  lost=${sweepLost}  extra=${sweepExtra}`);
  }
  if (labeled < cases.length) {
    console.log(`warning: ${cases.length - labeled} case(s) produced no usable noul — sweep is partial`);
  }
  if (opts.out) {
    // Review Minor 9: persist the calibration artifact for the handoff doc.
    const artifact = {
      generatedAt: new Date().toISOString(),
      model: opts.model,
      productionThreshold: CEREBELLUM_SESSION_FOLLOW_UP_THRESHOLD,
      labeled,
      lost,
      extra,
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
