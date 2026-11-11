import { test, expect, attachScreen, startNewChatViaPicker } from './fixtures';

/**
 * Chat tab (REQ-E-12): streamed reply, stop, the permission bottom sheet,
 * and the quota-exhausted card opening the recharge overlay.
 */

async function sendMessage(page: import('@playwright/test').Page, text: string): Promise<void> {
  const composer = page.getByPlaceholder('Type a message…');
  await composer.fill(text);
  await page.getByTestId('chat-composer-input').press('Enter');
}

test.describe('chat', () => {
  test('streamed reply renders markdown', async ({ page }, testInfo) => {
    await page.goto('/app/');
    await sendMessage(page, 'hello');
    // The mock streams the canned reply token by token through the same
    // cowork:stream:* events the desktop renderer consumes.
    await expect(page.getByText('Every reply in this demo is streamed token by token')).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByText('Mock bridge online.', { exact: true })).toBeVisible();
    await attachScreen(testInfo, page, 'chat-streamed-reply');
  });

  test('composer keeps a wide input, groups emoji under plus, and sends with Enter', async ({ page }, testInfo) => {
    await page.goto('/app/');
    const composer = page.getByTestId('chat-composer-input');
    await expect(composer).toBeVisible();
    expect(await composer.evaluate((element) => element.getBoundingClientRect().width)).toBeGreaterThan(220);
    await expect(page.getByRole('button', { name: 'Send', exact: true })).toHaveCount(0);
    await expect(page.getByTestId('voice-btn-idle')).toBeVisible();

    await page.getByTestId('composer-plus').click();
    await expect(page.getByTestId('composer-action-sheet')).toBeVisible();
    await page.getByTestId('composer-action-emoji').click();
    await expect(page.locator('#mobile-chat-emoji-panel')).toBeVisible();
    await page.getByRole('option').first().click();
    await expect(composer).not.toHaveValue('');

    await composer.fill('first line');
    await composer.press('Shift+Enter');
    await composer.pressSequentially('second line');
    await expect(composer).toHaveValue('first line\nsecond line');
    await attachScreen(testInfo, page, 'chat-wide-composer');
    await composer.press('Enter');
    await expect(page.getByTestId('chat-user-message').last()).toHaveText('first line\nsecond line');
  });

  test('IME confirmation Enter stays in the composer instead of sending', async ({ page }) => {
    await page.goto('/app/');
    const composer = page.getByTestId('chat-composer-input');
    await composer.fill('正在输入');
    await composer.evaluate((element) => {
      element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true }));
    });
    await expect(composer).toHaveValue('正在输入');
    await expect(page.getByTestId('chat-user-message')).toHaveCount(0);
    await composer.press('Enter');
    await expect(page.getByTestId('chat-user-message').last()).toHaveText('正在输入');
  });

  test('stop aborts the in-flight stream', async ({ page }, testInfo) => {
    await page.goto('/app/');
    await sendMessage(page, 'hello');
    await page.getByRole('button', { name: 'Stop' }).click();
    await expect(page.getByTestId('chat-composer-input')).toBeVisible();
    await expect(page.getByText('Every reply in this demo is streamed token by token')).toBeHidden();
    await attachScreen(testInfo, page, 'chat-stopped');
  });

  test('permission request surfaces, answers, and completes the turn', async ({ page }, testInfo) => {
    await page.goto('/app/');
    await sendMessage(page, 'please run the permission demo');

    const dialog = page.getByRole('dialog', { name: 'Tool permission requested' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText(/write_file/).first()).toBeVisible();
    await attachScreen(testInfo, page, 'chat-permission-sheet');

    await page.getByRole('button', { name: 'Allow once' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByText('the write completed')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('tool-call-list')).toHaveCount(0);
    await attachScreen(testInfo, page, 'chat-permission-approved');
  });

  test('quota card opens the recharge overlay', async ({ page }, testInfo) => {
    await page.goto('/app/');
    await sendMessage(page, 'check my quota');

    const quotaCard = page.getByTestId('quota-card');
    await expect(quotaCard).toBeVisible({ timeout: 30_000 });
    await expect(quotaCard).toContainText('Free quota used up this week');
    await attachScreen(testInfo, page, 'chat-quota-card');

    await quotaCard.getByRole('button', { name: 'Recharge' }).click();
    await expect(page.getByRole('heading', { name: 'Choose a plan' })).toBeVisible();
    await attachScreen(testInfo, page, 'chat-recharge-overlay');

    await page.getByRole('button', { name: 'Close' }).click();
    await expect(quotaCard).toBeVisible();
  });

  test('multiple attachments survive reload and enter the final prompt in order', async ({ page }, testInfo) => {
    await page.goto('/app/');
    await page.getByRole('button', { name: 'Sessions' }).click();
    await startNewChatViaPicker(page);
    await chooseFiles(page, [
      { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('notes') },
      { name: 'report.pdf', mimeType: 'application/pdf', buffer: Buffer.from('pdf') },
    ]);
    await expect(page.getByTestId('chat-attachment')).toHaveText(['notes.txt', 'report.pdf']);
    await page.getByPlaceholder('Type a message…').fill('compare documents');
    await page.reload();
    await expect(page.getByTestId('chat-attachment')).toHaveText(['notes.txt', 'report.pdf']);
    await expect(page.getByPlaceholder('Type a message…')).toHaveValue('compare documents');
    await page.getByTestId('chat-composer-input').press('Enter');
    await expect(page.getByTestId('chat-user-message').last()).toHaveText(
      'compare documents\n\nInput file: /data/workspace/uploads/mock-1-notes.txt\nInput file: /data/workspace/uploads/mock-2-report.pdf',
    );
    await expect(page.getByTestId('chat-attachments')).toHaveCount(0);
    await attachScreen(testInfo, page, 'chat-attachments-submitted');
  });

  test('attachment-only follow-up can steer a running turn', async ({ page }) => {
    await page.goto('/app/');
    await sendMessage(page, 'start work');
    await expect(page.getByRole('button', { name: 'Stop' })).toBeVisible();
    await chooseFiles(page, [{ name: 'follow-up.txt', mimeType: 'text/plain', buffer: Buffer.from('follow up') }]);
    await expect(page.getByTestId('chat-attachment')).toHaveText('follow-up.txt');
    await page.getByTestId('chat-composer-input').press('Enter');
    await expect(page.getByTestId('chat-user-message').last()).toHaveText(
      'Input file: /data/workspace/uploads/mock-1-follow-up.txt',
    );
  });

  test('removed pending uploads stay removed and typed errors preserve the text draft', async ({ page }) => {
    await page.goto('/app/');
    await page.getByRole('button', { name: 'Sessions' }).click();
    await startNewChatViaPicker(page);
    await page.getByPlaceholder('Type a message…').fill('keep this draft');
    await chooseFiles(page, [{ name: 'fixture-slow.txt', mimeType: 'text/plain', buffer: Buffer.from('slow') }]);
    const pending = page.locator('[data-testid="chat-upload"][data-upload-status="uploading"]');
    await expect(pending).toHaveAttribute('data-upload-status', 'uploading');
    await page.getByRole('button', { name: 'Remove pending upload fixture-slow.txt' }).click();
    await expect(page.getByTestId('chat-upload')).toHaveCount(0);
    await expect(page.getByTestId('chat-attachment')).toHaveCount(0);

    await chooseFiles(page, [{ name: 'fixture-quota.txt', mimeType: 'text/plain', buffer: Buffer.from('quota') }]);
    await expect(page.getByRole('alert')).toContainText('Cloud storage is full');
    await expect(page.getByPlaceholder('Type a message…')).toHaveValue('keep this draft');
    await expect(page.getByTestId('chat-composer-input')).toBeEnabled();
  });

  test('image preview downloads real bytes and shares the signed URL without leaving chat', async ({ page }, testInfo) => {
    await openMockArtifact(page, 'chart.png');
    const image = page.getByTestId('artifact-image');
    await expect(image).toBeVisible();
    await expect.poll(() => image.evaluate((element) => (element as HTMLImageElement).naturalWidth)).toBe(1);
    const src = await image.getAttribute('src');
    const response = await page.evaluate(async (url) => {
      const result = await fetch(url, { credentials: 'include' });
      return {
        type: result.headers.get('content-type'),
        disposition: result.headers.get('content-disposition'),
        bytes: Array.from(new Uint8Array(await result.arrayBuffer()).slice(0, 8)),
      };
    }, src);
    expect(response.type).toBe('image/png');
    expect(response.disposition).toContain('inline');
    expect(response.bytes).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    await attachScreen(testInfo, page, 'artifact-image-preview');

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByTestId('artifact-download').click(),
    ]);
    expect(download.suggestedFilename()).toBe('chart.png');
    const { readFileSync } = await import('node:fs');
    expect(Array.from(readFileSync(await download.path()).subarray(0, 8))).toEqual(response.bytes);

    await page.evaluate(() => {
      const host = window as unknown as { __sharedArtifactUrl?: string };
      Object.defineProperty(navigator, 'share', {
        configurable: true,
        value: async (data: { url: string }) => { host.__sharedArtifactUrl = data.url; },
      });
    });
    await page.getByTestId('artifact-share').click();
    const downloadHref = await page.getByTestId('artifact-download').getAttribute('href');
    await expect.poll(() => page.evaluate(() => (window as unknown as { __sharedArtifactUrl?: string }).__sharedArtifactUrl))
      .toBe(new URL(downloadHref, page.url()).toString());
    await page.getByPlaceholder('Type a message…').fill('continue working');
    await closeMockArtifact(page, 'chart.png');
    await expect(page.getByPlaceholder('Type a message…')).toHaveValue('continue working');
  });

  test('PDF preview uses the real inline document and keeps an open-new-tab fallback', async ({ page }, testInfo) => {
    await openMockArtifact(page, 'report.pdf');
    const frame = page.getByTestId('artifact-pdf');
    await expect(frame).toBeVisible();
    const src = await frame.getAttribute('src');
    const response = await page.evaluate(async (url) => {
      const result = await fetch(url, { credentials: 'include' });
      return {
        type: result.headers.get('content-type'),
        disposition: result.headers.get('content-disposition'),
        startsWithPdf: (await result.text()).startsWith('%PDF-'),
      };
    }, src);
    expect(response.type).toBe('application/pdf');
    expect(response.disposition).toContain('inline');
    expect(response.startsWithPdf).toBe(true);
    await expect(page.getByTestId('artifact-open-new-tab')).toHaveAttribute('target', '_blank');
    await attachScreen(testInfo, page, 'artifact-pdf-preview');
  });

  test('Markdown preview reads signed content and supports download and copy fallback', async ({ page }, testInfo) => {
    await openMockArtifact(page, 'notes.md');
    const preview = page.getByTestId('artifact-markdown');
    await expect(preview).toContainText('This Markdown came from the signed file.');
    await expect(preview).toContainText('Preview stays in chat.');
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByTestId('artifact-download').click(),
    ]);
    expect(download.suggestedFilename()).toBe('notes.md');
    const { readFileSync } = await import('node:fs');
    expect(readFileSync(await download.path(), 'utf8')).toContain('This **Markdown** came from the signed file.');

    await page.evaluate(() => {
      const host = window as unknown as { __copiedArtifactUrl?: string };
      Object.defineProperty(navigator, 'share', { configurable: true, value: undefined });
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: async (text: string) => { host.__copiedArtifactUrl = text; } },
      });
    });
    await page.getByTestId('artifact-share').click();
    await expect(page.getByRole('status').filter({ hasText: 'File link copied.' })).toBeVisible();
    const downloadHref = await page.getByTestId('artifact-download').getAttribute('href');
    expect(await page.evaluate(() => (window as unknown as { __copiedArtifactUrl?: string }).__copiedArtifactUrl))
      .toBe(new URL(downloadHref, page.url()).toString());
    await page.getByPlaceholder('Type a message…').fill('preserve this draft');
    await closeMockArtifact(page, 'notes.md');
    await expect(page.getByPlaceholder('Type a message…')).toHaveValue('preserve this draft');
    await attachScreen(testInfo, page, 'artifact-markdown-preview');
  });

  test('link refresh keeps the same preview and composer state', async ({ page }) => {
    await openMockArtifact(page, 'refresh.md');
    const download = page.getByTestId('artifact-download');
    const initialHref = await download.getAttribute('href');
    await expect.poll(() => download.getAttribute('href'), { timeout: 10_000 }).not.toBe(initialHref);
    await expect(page.getByRole('dialog', { name: 'refresh.md', exact: true })).toBeVisible();
    await expect(page.getByTestId('artifact-markdown')).toContainText('The preview remains open when this URL rotates.');
    await page.getByPlaceholder('Type a message…').fill('draft during refresh');
    await closeMockArtifact(page, 'refresh.md');
    await expect(page.getByPlaceholder('Type a message…')).toHaveValue('draft during refresh');
  });
});

async function openMockArtifact(page: import('@playwright/test').Page, filename: string): Promise<void> {
  await page.goto('/app/');
  await sendMessage(page, 'show artifacts');
  const link = page.getByRole('link', { name: filename, exact: true });
  await expect(link).toBeVisible({ timeout: 30_000 });
  await link.click();
  await expect(page.getByRole('dialog', { name: filename, exact: true })).toBeVisible();
}

async function closeMockArtifact(page: import('@playwright/test').Page, filename: string): Promise<void> {
  await page.getByRole('button', { name: '✕', exact: true }).click();
  await expect(page.getByRole('dialog', { name: filename, exact: true })).toHaveCount(0);
}

async function chooseFiles(
  page: import('@playwright/test').Page,
  files: Array<{ name: string; mimeType: string; buffer: Buffer }>,
): Promise<void> {
  const chooserPromise = page.waitForEvent('filechooser');
  await page.getByTestId('composer-plus').click();
  await page.getByTestId('composer-action-attachment').click();
  const chooser = await chooserPromise;
  await chooser.setFiles(files);
}
