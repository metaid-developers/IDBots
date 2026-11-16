import type { StudioDecisionQueueItem } from '../studioDecisionQueueStore';

function esc(raw: string): string {
  return String(raw ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function badgeCopy(kind: StudioDecisionQueueItem['kind'], language: 'zh' | 'en'): {
  label: string;
  bg: string;
  fg: string;
} {
  switch (kind) {
    case 'acceptance':
      return {
        label: language === 'zh' ? '最终验收' : 'Ready for Acceptance',
        bg: '#dcfce7',
        fg: '#166534',
      };
    case 'hiring':
      return {
        label: language === 'zh' ? '建议招聘专职员工' : 'Hiring Proposal',
        bg: '#e0e7ff',
        fg: '#3730a3',
      };
    case 'stamp_publish':
      return {
        label: language === 'zh' ? '等待盖章上链' : 'Awaiting Twin Stamp',
        bg: '#fef3c7',
        fg: '#92400e',
      };
    case 'blocker':
      return {
        label: language === 'zh' ? '阻塞需推进' : 'Blocker Escalation',
        bg: '#fee2e2',
        fg: '#991b1b',
      };
    case 'decision':
    default:
      return {
        label: language === 'zh' ? '需要你拍板' : 'Decision Needed',
        bg: '#fef3c7',
        fg: '#92400e',
      };
  }
}

function dedupeTitle(rawTitle: string): string {
  const parts = String(rawTitle ?? '')
    .split(/\s*·\s*/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length >= 2 && parts[0] === parts[1]) {
    return [parts[0], ...parts.slice(2)].join(' · ');
  }
  return String(rawTitle ?? '').trim();
}

function cleanMachineFallback(raw: string, fallback: string): string {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed) return fallback;
  if (/^Continue advancing the Managed Task Tree/i.test(trimmed)) {
    return fallback;
  }
  const progMatch = trimmed.match(/^Progress:\s*(\d+)\s*\/\s*(\d+)\s*accepted$/i);
  if (progMatch) {
    return `已完成核验子项 ${progMatch[1]} / ${progMatch[2]}`;
  }
  return trimmed;
}

/**
 * Generates a self-contained, single-screen executive HTML projection page
 * for a Studio Owner Decision Queue item when no custom HTML file was supplied.
 */
export function buildStudioDecisionReportHtml(input: {
  item: StudioDecisionQueueItem;
  queuePosition?: number;
  queueTotal?: number;
  taskProgress?: { accepted: number; total: number; percent: number } | null;
  language?: 'zh' | 'en';
}): string {
  const lang = input.language ?? 'zh';
  const { item } = input;
  const displayTitle = dedupeTitle(item.title);
  const displayProgress = cleanMachineFallback(
    item.progressSummary,
    lang === 'zh' ? '已完成后台核验' : 'Verified in back office',
  );
  const displayNextStep = cleanMachineFallback(
    item.nextStep,
    lang === 'zh' ? '按你的拍板结论立即执行或归档结项' : 'Proceed immediately per your ruling',
  );
  const badge = badgeCopy(item.kind, lang);
  const queueTag = input.queueTotal && input.queueTotal > 1
    ? (lang === 'zh'
        ? `待拍板队列 ${input.queuePosition ?? 1} / ${input.queueTotal}`
        : `Decision Queue ${input.queuePosition ?? 1} / ${input.queueTotal}`)
    : '';

  const optionsHtml = item.options.length > 0
    ? `<div class="section"><h2>${lang === 'zh' ? '可选方案与利弊' : 'Options & Trade-offs'}</h2><div class="options">` +
      item.options
        .map((opt) =>
          `<div class="opt${opt.recommended ? ' rec' : ''}">` +
          `<div class="opt-head"><strong>${esc(opt.label)}</strong>` +
          (opt.recommended ? `<span class="rec-chip">${lang === 'zh' ? '首推' : 'Recommended'}</span>` : '') +
          `</div>` +
          (opt.description ? `<p>${esc(opt.description)}</p>` : '') +
          `</div>`,
        )
        .join('') +
      `</div></div>`
    : '';

  const evidenceHtml = item.evidence.length > 0
    ? `<div class="section"><h2>${lang === 'zh' ? '已核验交付物与链上凭证' : 'Verified Deliverables & On-Chain Receipts'}</h2><ul class="ev">` +
      item.evidence
        .map((ev) => {
          const uri = String(ev.uri ?? '').trim();
          const linkable = /^(?:pin|metaapp|preview-file|preview-metaapp):\/\//i.test(uri);
          const uriHtml = linkable
            ? `<a href="${esc(uri)}"><code>${esc(uri)}</code></a>`
            : `<code>${esc(uri)}</code>`;
          return `<li><span class="ev-kind">${esc(ev.kind)}</span>${uriHtml}${ev.note ? ` — ${esc(ev.note)}` : ''}</li>`;
        })
        .join('') +
      `</ul></div>`
    : '';

  const progressHtml = input.taskProgress && input.taskProgress.total > 0
    ? `<div class="prog-wrap"><div class="prog-meta"><span>${lang === 'zh' ? '任务树完成度' : 'Task Tree Progress'}</span><strong>${input.taskProgress.accepted} / ${input.taskProgress.total} (${input.taskProgress.percent}%)</strong></div><div class="prog-bar"><div class="prog-fill" style="width:${Math.max(4, Math.min(100, input.taskProgress.percent))}%"></div></div></div>`
    : '';

  return `<!DOCTYPE html>
<html lang="${lang}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(displayTitle)}</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;background:#f4f6f9;color:#15181e;line-height:1.6;padding:28px}
  .sheet{max-width:880px;margin:0 auto;background:#fff;border-radius:18px;padding:28px 32px;box-shadow:0 6px 28px rgba(15,23,42,.06);border:1px solid #e6eaf0}
  .top{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:14px}
  .badge{display:inline-flex;align-items:center;padding:4px 12px;border-radius:999px;font-size:12px;font-weight:700;background:${badge.bg};color:${badge.fg}}
  .queue{font-size:12px;font-weight:600;color:#64748b;background:#f1f5f9;padding:4px 10px;border-radius:999px}
  h1{font-size:24px;line-height:1.25;letter-spacing:-.02em;margin-bottom:16px;color:#0f172a}
  .prog-wrap{background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;padding:12px 14px;margin-bottom:18px}
  .prog-meta{display:flex;justify-content:space-between;font-size:12px;color:#475569;margin-bottom:6px}
  .prog-bar{height:7px;background:#e2e8f0;border-radius:999px;overflow:hidden}
  .prog-fill{height:100%;background:linear-gradient(90deg,#0ea5e9,#10b981);border-radius:999px}
  .grid{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:18px}
  .box{background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;padding:14px 16px}
  .box h3{font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:#64748b;margin-bottom:6px}
  .box p{font-size:13px;color:#1e293b;white-space:pre-line}
  .decision-hero{background:#fffbeb;border:1px solid #fde68a;border-radius:14px;padding:16px 18px;margin-bottom:18px}
  .decision-hero h2{font-size:12px;text-transform:uppercase;letter-spacing:.05em;color:#b45309;margin-bottom:6px}
  .decision-hero p{font-size:15px;font-weight:600;color:#1e293b;white-space:pre-line}
  .section{margin-bottom:18px}
  .section h2{font-size:13px;font-weight:700;color:#334155;margin-bottom:10px}
  .options{display:flex;flex-direction:column;gap:8px}
  .opt{border:1px solid #e2e8f0;border-radius:10px;padding:10px 14px;background:#fff}
  .opt.rec{border-color:#f59e0b;background:#fffdf5}
  .opt-head{display:flex;align-items:center;gap:8px;font-size:13px;color:#0f172a}
  .rec-chip{font-size:11px;font-weight:700;padding:1px 8px;border-radius:999px;background:#fef3c7;color:#b45309}
  .opt p{font-size:12px;color:#475569;margin-top:4px}
  .ev{list-style:none;display:flex;flex-direction:column;gap:6px;font-size:12px;color:#334155}
  .ev li{background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:8px 10px;word-break:break-all}
  .ev-kind{display:inline-block;font-weight:700;text-transform:uppercase;font-size:10px;color:#0369a1;background:#e0f2fe;padding:1px 6px;border-radius:4px;margin-right:8px}
  .footer{display:grid;grid-template-columns:1fr 1fr;gap:14px;border-top:1px solid #e2e8f0;padding-top:16px}
  @media(max-width:680px){.grid,.footer{grid-template-columns:1fr}}
</style>
</head>
<body>
  <main class="sheet">
    <div class="top">
      <span class="badge">${esc(badge.label)}</span>
      ${queueTag ? `<span class="queue">${esc(queueTag)}</span>` : ''}
    </div>
    <h1>${esc(displayTitle)}</h1>
    ${progressHtml}
    <div class="grid">
      <div class="box">
        <h3>${lang === 'zh' ? '任务背景' : 'Background'}</h3>
        <p>${esc(item.backgroundSummary || '-')}</p>
      </div>
      <div class="box">
        <h3>${lang === 'zh' ? '已完成核验进度' : 'Verified Progress'}</h3>
        <p>${esc(displayProgress)}</p>
      </div>
    </div>
    <section class="decision-hero">
      <h2>${lang === 'zh' ? '需要你拍板的事项' : 'Decision Required'}</h2>
      <p>${esc(item.question)}</p>
    </section>
    ${optionsHtml}
    ${evidenceHtml}
    <div class="footer">
      <div class="box">
        <h3>${lang === 'zh' ? '助理首推建议与理由' : 'Recommended Call'}</h3>
        <p>${esc(item.recommendation && item.recommendation !== item.question ? item.recommendation : (lang === 'zh' ? '请结合上方背景直接回复拍板' : 'Reply in chat with your call'))}</p>
      </div>
      <div class="box">
        <h3>${lang === 'zh' ? '拍板后的下一步动作' : 'Immediate Next Step'}</h3>
        <p>${esc(displayNextStep)}</p>
      </div>
    </div>
  </main>
</body>
</html>`;
}
