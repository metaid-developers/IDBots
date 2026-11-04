import { test, expect, attachScreen } from './fixtures';

/**
 * AC-E-2 smoke spec: the mobile app on the REAL bridge (gateway client +
 * contract shim, no mock). The runner (scripts/run-mobile-e2e-gateway.mjs)
 * provides a standalone gateway fixture and sets E2E_GATEWAY; without it
 * these tests are skipped so the mock suite stays self-contained.
 */

const isGatewayRun = Boolean(process.env.E2E_GATEWAY);

/** Optional on-disk evidence copy for the F-11 acceptance trail. */
async function screenTo(page: import('@playwright/test').Page, testInfo: import('@playwright/test').TestInfo, name: string): Promise<void> {
  await attachScreen(testInfo, page, name);
  const dir = process.env.F11_EVIDENCE_DIR;
  if (dir) {
    const fs = await import('node:fs');
    const path = await import('node:path');
    fs.mkdirSync(dir, { recursive: true });
    const project = testInfo.project.name;
    fs.writeFileSync(path.join(dir, `${name}-${project}.png`), await page.screenshot());
  }
}

async function startNewChat(page: import('@playwright/test').Page): Promise<void> {
  await page.getByRole('button', { name: 'Sessions' }).click();
  // A3 rework: New chat opens the Bot picker; pick the first (Twin-first).
  await page.getByTestId('session-new-chat').click();
  await page.getByTestId('bot-picker-list').getByRole('button').first().click();
}

test.describe('gateway-backed smoke', () => {
  test.skip(!isGatewayRun, 'requires the gateway harness (scripts/run-mobile-e2e-gateway.mjs)');

  test('handshake + welcome + chat send + streamed reply @gateway', async ({ page }, testInfo) => {
    await page.goto('/app/');

    // The real shim installed window.electron from the IPC contract and the
    // client facts next to it; the app shell mounts only after the welcome
    // frame passed the version guard.
    const facts = await page.evaluate(() => {
      const mobile = (window as unknown as { idbotsMobile?: Record<string, unknown> }).idbotsMobile;
      return { isMobile: mobile?.isMobile, hasMockControl: Boolean(mobile && 'mock' in mobile) };
    });
    expect(facts.isMobile).toBe(true);
    expect(facts.hasMockControl).toBe(false);

    await expect(page.getByRole('button', { name: 'Chat', exact: true })).toBeVisible();
    await attachScreen(testInfo, page, 'gateway-app-shell');

    await startNewChat(page);
    await page.getByPlaceholder('Type a message…').fill('hello over the gateway');
    await page.getByRole('button', { name: 'Send' }).click();

    // The fixture streams the canned reply over cowork:stream:* events.
    await expect(page.getByText('This reply streamed over a real C2 gateway socket.')).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByText('Gateway fixture online.', { exact: true })).toBeVisible();
    await attachScreen(testInfo, page, 'gateway-streamed-reply');

    // The session lands in the drawer, hydrated over cowork:session:list.
    await page.getByRole('button', { name: 'Sessions' }).click();
    await expect(page.getByTestId('session-drawer-list')).toContainText('hello over the gateway', {
      timeout: 15_000,
    });
    await attachScreen(testInfo, page, 'gateway-session-drawer');
  });

  test('F-11: chat file links render as same-origin /files downloads and really download @gateway', async ({ page }, testInfo) => {
    test.skip(process.env.GW_FIXTURE_FILE === '0', 'requires the default file-delivery fixture (explicitly disabled with GW_FIXTURE_FILE=0)');

    // Mirror of FIXTURE_FILE_BYTES in scripts/run-mobile-e2e-gateway.mjs.
    const expectedPayload = 'PK\x03\x04 gateway fixture docx payload 0123456789abcdef';

    await page.goto('/app/');
    await startNewChat(page);
    await page.getByPlaceholder('Type a message…').fill('generate a report');
    await page.getByRole('button', { name: 'Send' }).click();

    // Wait for the settled turn and the final directory label, not only the artifact list.
    await expect(page.getByRole('link', { name: 'gateway-e2e-refresh.md', exact: true })).toBeVisible({ timeout: 30_000 });
    const link = page.getByRole('link', { name: /gateway-e2e-report\.docx/ });
    await expect(link).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('turn-phase')).toHaveCount(0, { timeout: 30_000 });
    await expect(page.getByText('工作目录', { exact: true })).toBeVisible({ timeout: 30_000 });
    await screenTo(page, testInfo, 'f11-message-before-click');

    // F-11 criterion: zero container paths in the rendered surface — no
    // file:// anywhere in visible text or in any anchor href.
    const surface = await page.evaluate(() => ({
      text: document.body.innerText,
      hrefs: Array.from(document.querySelectorAll('a')).map((a) => a.getAttribute('href') ?? ''),
    }));
    expect(surface.text).not.toContain('file://');
    expect(surface.text).not.toContain('/data/workspace');
    for (const href of surface.hrefs) {
      expect(href.startsWith('file://')).toBe(false);
    }

    // The link points at the same-origin signed route, not the tenant route.
    const href = await link.getAttribute('href');
    expect(href).toMatch(/^\/files\/[^/]+/);
    expect(href).not.toContain('/gateway/v1/');

    // The preview opens first; its download action really fetches the bytes.
    await link.click();
    await expect(page.getByRole('dialog', { name: 'gateway-e2e-report.docx', exact: true })).toBeVisible();
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 30_000 }),
      page.getByTestId('artifact-download').click(),
    ]);
    expect(download.suggestedFilename()).toBe('gateway-e2e-report.docx');
    const downloadedPath = await download.path();
    const { readFileSync } = await import('node:fs');
    expect(readFileSync(downloadedPath, 'utf8')).toBe(expectedPayload);
    await screenTo(page, testInfo, 'f11-after-download');

    // Authorized fetch through the same route returns the docx content-type.
    const routeProbe = await page.evaluate(async (url: string) => {
      const res = await fetch(url, { credentials: 'include' });
      return {
        status: res.status,
        contentType: res.headers.get('content-type'),
        disposition: res.headers.get('content-disposition'),
        bytes: (await res.arrayBuffer()).byteLength,
      };
    }, href);
    expect(routeProbe.status).toBe(200);
    expect(routeProbe.contentType).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    expect(routeProbe.disposition).toMatch(/^attachment/);
    expect(routeProbe.bytes).toBe(expectedPayload.length);

    // The directory link (工作目录) never became an anchor.
    const dirLinks = await page.evaluate(() =>
      Array.from(document.querySelectorAll('a')).filter((a) => (a.textContent ?? '').includes('工作目录')).length,
    );
    expect(dirLinks).toBe(0);
  });

  test('real uploads reach start and steer prompts in picker order @gateway', async ({ page, browserName }, testInfo) => {
    const uploads: Array<{ path: string; size: number }> = [];
    const uploadErrors: unknown[] = [];
    // WebKit can drop a proxied large request; Chromium can evict the inspector response body.
    if (browserName === 'webkit') {
      page.on('response', (response) => {
        if (new URL(response.url()).pathname !== '/upload') return;
        void response.json().then((body: { path: string; size: number }) => {
          uploads.push(body);
        }).catch((error: unknown) => uploadErrors.push(error));
      });
    } else {
      await page.route('**/upload?*', async (route) => {
        const response = await route.fetch();
        uploads.push(await response.json() as { path: string; size: number });
        await route.fulfill({ response });
      });
    }
    const waitForUploads = (count: number) => expect.poll(() => {
      if (uploadErrors.length) throw new Error(`Upload response read failed: ${String(uploadErrors[0])}`);
      return uploads.length;
    }, { timeout: 30_000 }).toBe(count);
    await page.goto('/app/');
    await startNewChat(page);
    await chooseFiles(page, [
      { name: 'twenty-megabytes.pdf', mimeType: 'application/pdf', buffer: Buffer.alloc(20 * 1024 * 1024, 7) },
      { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('notes') },
    ]);
    await waitForUploads(2);
    expect(uploads[0].size).toBe(20 * 1024 * 1024);
    await expect(page.getByTestId('chat-attachment')).toHaveText(['twenty-megabytes.pdf', 'notes.txt']);
    await page.getByPlaceholder('Type a message…').fill('review uploaded files');
    await page.getByRole('button', { name: 'Send' }).click();
    await expect(page.getByTestId('chat-user-message').last()).toHaveText(
      `review uploaded files\n\nInput file: ${uploads[0].path}\nInput file: ${uploads[1].path}`,
    );

    await chooseFiles(page, [{ name: 'follow-up.txt', mimeType: 'text/plain', buffer: Buffer.from('follow up') }]);
    await waitForUploads(3);
    await page.getByRole('button', { name: 'Send' }).click();
    await expect(page.getByTestId('chat-user-message').last()).toHaveText(`Input file: ${uploads[2].path}`);
    const promptBox = page.getByTestId('chat-user-message').last();
    expect(await promptBox.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    await attachScreen(testInfo, page, 'gateway-attachments-in-prompt');
  });

  test('oversize files never send bytes and blocked types return a visible 415 @gateway', async ({ page }) => {
    const uploadRequests: string[] = [];
    const uploadStatuses: number[] = [];
    page.on('request', (request) => {
      if (new URL(request.url()).pathname === '/upload') uploadRequests.push(request.url());
    });
    page.on('response', (response) => {
      if (new URL(response.url()).pathname === '/upload') uploadStatuses.push(response.status());
    });
    await page.goto('/app/');
    await startNewChat(page);
    await chooseFiles(page, [{
      name: 'too-large.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.alloc(25 * 1024 * 1024 + 1),
    }]);
    await expect(page.getByRole('alert')).toContainText('too-large.pdf is over 25 MB');
    expect(uploadRequests).toHaveLength(0);

    await chooseFiles(page, [{ name: 'blocked.exe', mimeType: 'application/x-msdownload', buffer: Buffer.from('blocked') }]);
    await expect(page.getByRole('alert').filter({ hasText: 'The file type of blocked.exe is not supported.' })).toBeVisible();
    await expect.poll(() => uploadStatuses).toContain(415);
    expect(uploadRequests).toHaveLength(1);
  });

  test('real image, PDF, Markdown and other artifacts open in-app and download @gateway', async ({ page }, testInfo) => {
    await openGatewayArtifact(page, 'gateway-e2e-image.png');
    const image = page.getByTestId('artifact-image');
    await expect.poll(() => image.evaluate((element) => (element as HTMLImageElement).naturalWidth)).toBe(1);
    const imageSrc = await image.getAttribute('src');
    const imageResponse = await page.evaluate(async (url) => {
      const response = await fetch(url, { credentials: 'include' });
      return {
        type: response.headers.get('content-type'),
        disposition: response.headers.get('content-disposition'),
        bytes: Array.from(new Uint8Array(await response.arrayBuffer()).slice(0, 8)),
      };
    }, imageSrc);
    expect(imageResponse.type).toBe('image/png');
    expect(imageResponse.disposition).toContain('inline');
    expect(imageResponse.bytes).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    await closeGatewayArtifact(page, 'gateway-e2e-image.png');

    await openGatewayArtifact(page, 'gateway-e2e-preview.pdf');
    const pdf = page.getByTestId('artifact-pdf');
    await expect(pdf).toBeVisible();
    const pdfSrc = await pdf.getAttribute('src');
    const pdfResponse = await page.evaluate(async (url) => {
      const response = await fetch(url, { credentials: 'include' });
      return {
        type: response.headers.get('content-type'),
        disposition: response.headers.get('content-disposition'),
        startsWithPdf: (await response.text()).startsWith('%PDF-'),
      };
    }, pdfSrc);
    expect(pdfResponse.type).toBe('application/pdf');
    expect(pdfResponse.disposition).toContain('inline');
    expect(pdfResponse.startsWithPdf).toBe(true);
    await expect(page.getByTestId('artifact-open-new-tab')).toHaveAttribute('target', '_blank');
    await closeGatewayArtifact(page, 'gateway-e2e-preview.pdf');

    await openGatewayArtifact(page, 'gateway-e2e-notes.md');
    await expect(page.getByTestId('artifact-markdown')).toContainText('This Markdown was served by the tenant.');
    const [notes] = await Promise.all([
      page.waitForEvent('download'),
      page.getByTestId('artifact-download').click(),
    ]);
    expect(notes.suggestedFilename()).toBe('gateway-e2e-notes.md');
    const { readFileSync } = await import('node:fs');
    expect(readFileSync(await notes.path(), 'utf8')).toBe('# Gateway notes\n\nThis Markdown was served by the tenant.\n');
    await attachScreen(testInfo, page, 'gateway-artifact-markdown');
    await closeGatewayArtifact(page, 'gateway-e2e-notes.md');

    await openGatewayArtifact(page, 'gateway-e2e-report.docx');
    await expect(page.getByTestId('artifact-preview')).toHaveAttribute('data-artifact-kind', 'other');
    await expect(page.getByTestId('artifact-pdf')).toHaveCount(0);
    await expect(page.getByTestId('artifact-image')).toHaveCount(0);
    const [docx] = await Promise.all([
      page.waitForEvent('download'),
      page.getByTestId('artifact-download').click(),
    ]);
    expect(docx.suggestedFilename()).toBe('gateway-e2e-report.docx');
    expect(readFileSync(await docx.path(), 'utf8')).toBe('PK\x03\x04 gateway fixture docx payload 0123456789abcdef');
    await page.getByPlaceholder('Type a message…').fill('continue after previews');
    await closeGatewayArtifact(page, 'gateway-e2e-report.docx');
    await expect(page.getByPlaceholder('Type a message…')).toHaveValue('continue after previews');
  });

  test('signed link rotation keeps the gateway artifact and chat alive @gateway', async ({ page }) => {
    await openGatewayArtifact(page, 'gateway-e2e-refresh.md');
    const download = page.getByTestId('artifact-download');
    const initialHref = await download.getAttribute('href');
    await expect.poll(() => download.getAttribute('href'), { timeout: 10_000 }).not.toBe(initialHref);
    await expect(page.getByRole('dialog', { name: 'gateway-e2e-refresh.md', exact: true })).toBeVisible();
    await expect(page.getByTestId('artifact-markdown')).toContainText('The tenant link rotated without closing this preview.');
    await expect(page).toHaveURL(/\/app\/$/);
  });
});

async function openGatewayArtifact(page: import('@playwright/test').Page, filename: string): Promise<void> {
  await page.goto('/app/');
  await startNewChat(page);
  await page.getByPlaceholder('Type a message…').fill('generate a report');
  await page.getByRole('button', { name: 'Send' }).click();
  const link = page.getByRole('link', { name: filename, exact: true });
  await expect(link).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('turn-phase')).toHaveCount(0, { timeout: 30_000 });
  await link.click();
  await expect(page.getByRole('dialog', { name: filename, exact: true })).toBeVisible();
}

async function closeGatewayArtifact(page: import('@playwright/test').Page, filename: string): Promise<void> {
  await page.getByRole('button', { name: '✕', exact: true }).click();
  await expect(page.getByRole('dialog', { name: filename, exact: true })).toHaveCount(0);
}

async function chooseFiles(
  page: import('@playwright/test').Page,
  files: Array<{ name: string; mimeType: string; buffer: Buffer }>,
): Promise<void> {
  const chooserPromise = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Add photo or file' }).click();
  const chooser = await chooserPromise;
  await chooser.setFiles(files);
}
