import type { BrowserElementSelection } from '@openagentinternet/agent-browser-host-contract';
import type { MarkedElementsTurnCapture } from './elementSelectionsStore';

/**
 * Prompt fragment for ABC element-picker marks, following the selectionFragment
 * example in agent-browser-core/docs/browser-element-picker-host-integration.md:
 * one compact entry per mark — locator + element summary + the human's comment
 * VERBATIM (the comment is the human's intent; the locator is the machine's
 * address for the target).
 *
 * The block rides at the front of the submitted prompt as a markdown
 * blockquote, the same composition the transcript's quoted excerpts use, so
 * the owner can see exactly what context their bot received.
 */

/** Marks per injected block. ABC caps 50 per tab; 50 entries would crowd out the instruction. */
export const MARKED_ELEMENTS_PROMPT_MAX_MARKERS = 10;

const flattenLine = (value: unknown): string =>
  String(value ?? '')
    .replace(/\s*\r?\n\s*/g, ' / ')
    .trim();

const describeSelectedElement = (element: BrowserElementSelection['element']): string => {
  const classes = Array.isArray(element.classes) ? element.classes.filter(Boolean) : [];
  return element.tag
    + (element.id ? `#${element.id}` : '')
    + (classes.length ? `.${classes.join('.')}` : '');
};

const selectionLines = (selection: BrowserElementSelection): string[] => {
  const element = selection.element || ({} as BrowserElementSelection['element']);
  const locator = selection.locator || ({} as BrowserElementSelection['locator']);
  const lines: string[] = [];
  const descriptor = describeSelectedElement(element);
  // Doc format: the element summary reads like a CSS-style selector literal.
  const summary = descriptor ? `<${descriptor}>` : '(element details unavailable)';
  lines.push(`${selection.name || 'Marker'} — ${descriptor ? `\`${summary}\`` : summary}`);
  const cssSelector = flattenLine(locator.cssSelector);
  const xpath = flattenLine(locator.xpath);
  if (cssSelector) {
    lines.push(`locator (${locator.cssScope || 'document'}): \`${cssSelector}\``);
  } else if (xpath) {
    lines.push(`xpath: \`${xpath}\``);
  }
  const text = flattenLine(element.textPreview);
  if (text) lines.push(`text: ${text}`);
  const comment = flattenLine(selection.comment);
  // The comment is the human's intent — always forwarded verbatim (flattened
  // to one line only so the blockquote survives markdown rendering).
  if (comment) lines.push(`comment: ${comment}`);
  return lines;
};

/**
 * Renders the injected block. Empty string when there is nothing to inject.
 */
export function buildMarkedElementsBlock(capture: MarkedElementsTurnCapture): string {
  const snapshot = capture?.snapshot;
  const selections = Array.isArray(snapshot?.selections) ? snapshot.selections : [];
  if (!snapshot || selections.length === 0) return '';

  const title = flattenLine(snapshot.title) || 'untitled page';
  const uri = flattenLine(snapshot.uri);
  const header = `> Marked elements on "${title}"${uri ? ` (\`${uri}\`)` : ''} — captured from the Bot Browser element picker; "this" or "here" in the message below refers to these marks. Human comments are the verbatim intent.`;
  const staleNote = capture.stale
    ? ['>', '> Note: the marks were captured before the latest navigation on this tab, so locators may be stale.']
    : [];

  const shown = selections.slice(0, MARKED_ELEMENTS_PROMPT_MAX_MARKERS);
  const entries = shown.map((selection, index) => {
    const lines = selectionLines(selection);
    const [first, ...rest] = lines;
    const body = [`> ${index + 1}. ${first}`, ...rest.map((line) => `>    ${line}`)];
    return body.join('\n');
  });
  const omitted = selections.length - shown.length;
  const tail = omitted > 0
    ? ['>', `> … ${omitted} more marked element${omitted === 1 ? '' : 's'} omitted.`]
    : [];

  return [header, ...staleNote, ...entries, ...tail].join('\n');
}
