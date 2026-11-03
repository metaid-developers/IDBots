// Inline Twemoji rendering in message bubbles — regression coverage for the
// assistant-side emoji alignment bug (reported 2026-11-03): the bot's emoji
// rendered shifted UP relative to the surrounding text, while the user side
// was fine. Root cause: assistant bubbles wrap MarkdownContent in typography's
// `prose`, whose img rule paints margin-top/bottom (~1.7em) on EVERY image;
// on a text-scale inline glyph that margin pushed the emoji off the text
// baseline. The glyph must carry its own zero block margins so `prose` (or
// any other wrapper) cannot move it.
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import MarkdownContent from '../src/renderer/components/MarkdownContent';

const pickTwemojiImg = (markup: string): string =>
  markup.match(/<img[^>]*alt="😄"[^>]*>/)?.[0] ?? '';

test('catalog emoji render as text-scale inline twemoji images with zero block margins', () => {
  const markup = renderToStaticMarkup(
    React.createElement(MarkdownContent, {
      content: '明天星期三 😄 链路正常',
      emojiImages: true,
    }),
  );
  const img = pickTwemojiImg(markup);
  assert.ok(img, 'the 😄 codepoint must render as an inline twemoji image');
  assert.ok(img.includes('my-0'), "zero block margins — prose's img rule must not push the glyph off the text baseline");
  assert.ok(img.includes('inline-block'));
  assert.ok(img.includes('h-[1.25em]'));
  assert.ok(img.includes('align-[-0.2em]'));
});

test('the same zero-margin inline twemoji classes hold inside a prose wrapper (assistant bubble)', () => {
  // The assistant bubble (and the professional-mode row) passes
  // `prose dark:prose-invert` — the exact context that exposed the bug.
  const markup = renderToStaticMarkup(
    React.createElement(MarkdownContent, {
      content: '知道呀 😄 有啥想聊的',
      emojiImages: true,
      className: 'prose dark:prose-invert max-w-none',
    }),
  );
  const img = pickTwemojiImg(markup);
  assert.ok(img, 'the 😄 codepoint must render as an inline twemoji image');
  assert.ok(img.includes('my-0'));
  assert.ok(img.includes('inline-block'));
  assert.ok(img.includes('h-[1.25em]'));
  assert.ok(img.includes('align-[-0.2em]'));
});
