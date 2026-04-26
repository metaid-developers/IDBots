import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import Toast from '../src/renderer/components/Toast';

test('Toast uses explicit high-contrast dark mode surface styles', () => {
  const markup = renderToStaticMarkup(
    <Toast message="metaid 已复制" onClose={() => {}} />,
  );

  assert.match(markup, /dark:bg-\[#111827\]/);
  assert.match(markup, /dark:text-white/);
  assert.match(markup, /dark:border-white\/15/);
});
