import { test, expect, startNewChatViaPicker } from './fixtures';

type PermissionWindow = Window & {
  electron: { cowork: Record<string, (...args: unknown[]) => unknown> };
  idbotsMobile: {
    mock: {
      simulateReconnect: () => void;
      emitCoworkStream: (channel: 'permission' | 'permissionResolved', payload: unknown) => void;
    };
  };
  __sessionId: string | null;
  __permissionResults: Array<{
    requestId: string;
    result: {
      behavior: string;
      message?: string;
      updatedInput?: { answers?: Record<string, string>; autoAnswered?: string[] };
    };
  }>;
};

async function startSession(page: import('@playwright/test').Page): Promise<string> {
  await page.goto('/app/');
  await page.evaluate(() => {
    const w = window as unknown as PermissionWindow;
    w.__sessionId = null;
    w.__permissionResults = [];
    const cowork = w.electron.cowork;
    const originalStart = cowork.startSession;
    cowork.startSession = async (options: unknown) => {
      const result = await originalStart(options);
      w.__sessionId = (result as { session?: { id?: string } }).session?.id ?? null;
      return result;
    };
    const originalRespond = cowork.respondToPermission;
    cowork.respondToPermission = async (input: unknown) => {
      w.__permissionResults.push(input as PermissionWindow['__permissionResults'][number]);
      return originalRespond(input);
    };
  });
  await page.getByRole('button', { name: 'Sessions' }).click();
  await startNewChatViaPicker(page);
  await page.getByPlaceholder('Type a message…').fill('start the clarification test');
  await page.getByTestId('chat-composer-input').press('Enter');
  await page.waitForFunction(() => Boolean((window as unknown as PermissionWindow).__sessionId));
  return (await page.evaluate(() => (window as unknown as PermissionWindow).__sessionId))!;
}

async function emitPermission(
  page: import('@playwright/test').Page,
  sessionId: string,
  requestId: string,
  toolInput: Record<string, unknown>,
  perQuestionTimeoutMs: number | null = null,
): Promise<void> {
  await page.evaluate(({ sessionId: sid, requestId: rid, toolInput: input, perQuestionTimeoutMs: timeout }) => {
    const w = window as unknown as PermissionWindow;
    w.idbotsMobile.mock.emitCoworkStream('permission', {
      sessionId: sid,
      request: {
        sessionId: sid,
        requestId: rid,
        toolName: 'AskUserQuestion',
        toolInput: input,
        perQuestionTimeoutMs: timeout,
      },
    });
  }, { sessionId, requestId, toolInput, perQuestionTimeoutMs });
}

async function results(page: import('@playwright/test').Page): Promise<PermissionWindow['__permissionResults']> {
  return page.evaluate(() => (window as unknown as PermissionWindow).__permissionResults);
}

test('multi-step clarification preserves single/multi/Other/skip answers and plan detail', async ({ page }) => {
  const sessionId = await startSession(page);
  await emitPermission(page, sessionId, 'multi-step', {
    questions: [
      {
        question: 'Which approach?',
        header: 'Plan',
        detail: 'Full plan detail text',
        options: [{ label: 'Use plan A' }, { label: 'Use plan B' }],
      },
      {
        question: 'Which outputs?',
        options: [{ label: 'Report' }, { label: 'Slides' }, { label: 'Data' }],
        multiSelect: true,
      },
      {
        question: 'Custom constraint?',
        options: [{ label: 'Default constraint' }],
      },
      {
        question: 'Optional extra?',
        options: [{ label: 'Include extra' }],
      },
    ],
  });
  const dialog = page.getByRole('dialog', { name: 'Tool permission requested' });
  await expect(dialog).toBeVisible();
  await expect(page.getByText('Full plan detail text')).toBeVisible();
  await page.getByRole('radio', { name: /Use plan A/ }).click();
  await expect(page.getByText('Which outputs?')).toBeVisible();
  await page.getByRole('checkbox', { name: /Report/ }).click();
  await page.getByRole('checkbox', { name: /Data/ }).click();
  await page.getByRole('button', { name: 'Next', exact: true }).last().click();
  await dialog.locator('input[type="text"]').fill('My custom constraint');
  await page.getByRole('button', { name: 'Next', exact: true }).last().click();
  await page.getByRole('button', { name: 'Skip this question' }).click();
  await page.getByRole('button', { name: 'Submit', exact: true }).click();
  await expect(dialog).toHaveCount(0);

  const answered = await results(page);
  expect(answered.length).toBe(1);
  expect(answered[0].result.behavior).toBe('allow');
  expect(answered[0].result.updatedInput?.answers).toEqual({
    'Which approach?': 'Use plan A',
    'Which outputs?': 'Report|||Data',
    'Custom constraint?': 'My custom constraint',
  });
  expect(answered[0].result.updatedInput?.autoAnswered).toEqual([]);
});

test('per-question timeout submits the recommended answer with autoAnswered metadata', async ({ page }) => {
  const sessionId = await startSession(page);
  await emitPermission(page, sessionId, 'timeout', {
    questions: [{
      question: 'Pick timeout',
      options: [{ label: 'Fast path (Recommended)' }, { label: 'Slow path' }],
    }],
  }, 50);
  await expect.poll(async () => (await results(page)).length).toBe(1);
  const [answered] = await results(page);
  expect(answered.result.behavior).toBe('allow');
  expect(answered.result.updatedInput?.answers).toEqual({ 'Pick timeout': 'Fast path (Recommended)' });
  expect(answered.result.updatedInput?.autoAnswered).toEqual(['Pick timeout']);
});

test('dismissed pending request reopens and survives reconnect without invented approval', async ({ page }) => {
  const sessionId = await startSession(page);
  await emitPermission(page, sessionId, 'recover', {
    questions: [{ question: 'Continue?', options: [{ label: 'Continue' }] }],
  });
  const dialog = page.getByRole('dialog', { name: 'Tool permission requested' });
  await expect(dialog).toBeVisible();
  await page.getByRole('button', { name: '✕' }).click();
  await expect(dialog).toHaveCount(0);
  await page.getByRole('button', { name: '1 requests need your attention' }).click();
  await expect(dialog).toBeVisible();
  await page.evaluate(() => (window as unknown as PermissionWindow).idbotsMobile.mock.simulateReconnect());
  await expect(page.locator('[data-connection-state]')).toHaveAttribute('data-connection-state', 'online', { timeout: 10_000 });
  await expect(dialog).toBeVisible({ timeout: 10_000 });
  await page.evaluate((sessionId) => {
    const w = window as unknown as PermissionWindow;
    w.idbotsMobile.mock.emitCoworkStream('permissionResolved', { sessionId, requestId: 'recover' });
  }, sessionId);
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText('Approved', { exact: true })).toHaveCount(0);
});

test('safety approval returns the first safety option', async ({ page }) => {
  const sessionId = await startSession(page);
  await emitPermission(page, sessionId, 'safety', {
    context: {
      requestedToolName: 'Bash',
      requestedToolInput: { command: 'rm -rf /data/workspace/demo' },
    },
    questions: [{
      question: 'Delete this directory?',
      options: [{ label: 'Delete once' }, { label: 'Cancel' }],
    }],
  });
  await expect(page.getByText('This action will delete files')).toBeVisible();
  await page.getByRole('button', { name: 'Allow deletion' }).click();
  await expect.poll(async () => (await results(page)).length).toBe(1);
  const [answered] = await results(page);
  expect(answered.result.behavior).toBe('allow');
  expect(answered.result.updatedInput?.answers).toEqual({ 'Delete this directory?': 'Delete once' });
});

test('real tenant ask payload renders options and submits by question text (F-17a regression)', async ({ page }) => {
  // Byte-faithful shape of the 2026-10-28 阿燃 incident payload (tenant row
  // e9083d66, session 64c3d955): `id` + snake_case `multi_select` ride along
  // with the standard question fields — they must not break parsing.
  const sessionId = await startSession(page);
  await emitPermission(page, sessionId, 'f17a-real', {
    questions: [{
      id: 'confirm_create',
      header: '确认入职',
      question: '这张卡可以照着建吗？',
      multi_select: false,
      detail: '建完他会是一个独立的本地 Worker Bot：有自己的钱包和链上身份（globalMetaId）。',
      options: [
        { label: '就这个（推荐）', description: '按现在的名字、人格、火箭头像创建。' },
        { label: '名字换一个', description: '保留人格和头像，我再出 3 个名字备选。' },
        { label: '头像换一个', description: '保留名字和人格，我从铃铛/猫头鹰/狮子等其它图里再挑。' },
      ],
    }],
  });
  const dialog = page.getByRole('dialog', { name: 'Tool permission requested' });
  await expect(dialog).toBeVisible();
  await expect(page.getByText('这张卡可以照着建吗？')).toBeVisible();
  await expect(page.getByRole('radio', { name: /就这个（推荐）/ })).toBeVisible();
  await page.getByRole('radio', { name: /就这个（推荐）/ }).click();
  await page.getByRole('button', { name: 'Submit', exact: true }).click();
  const [answered] = await results(page);
  expect(answered.result.behavior).toBe('allow');
  expect(answered.result.updatedInput?.answers).toEqual({ '这张卡可以照着建吗？': '就这个（推荐）' });
});

test('string-only options still render as selectable choices (F-17a tolerance)', async ({ page }) => {
  const sessionId = await startSession(page);
  await emitPermission(page, sessionId, 'string-options', {
    questions: [{
      question: 'Pick a lane?',
      options: ['Fast path', 'Slow path'],
    }],
  });
  const dialog = page.getByRole('dialog', { name: 'Tool permission requested' });
  await expect(dialog).toBeVisible();
  await expect(page.getByRole('radio', { name: 'Fast path' })).toBeVisible();
  await page.getByRole('radio', { name: 'Fast path' }).click();
  await page.getByRole('button', { name: 'Submit', exact: true }).click();
  const [answered] = await results(page);
  expect(answered.result.behavior).toBe('allow');
  expect(answered.result.updatedInput?.answers).toEqual({ 'Pick a lane?': 'Fast path' });
});

test('malformed clarification degrades to a plain-text card with Allow and Deny (F-17a)', async ({ page }) => {
  const sessionId = await startSession(page);
  await emitPermission(page, sessionId, 'malformed', { questions: [] });
  await expect(page.getByText('Request unavailable')).toBeVisible();
  // F-17a: the payload is still readable (raw JSON fallback) and the user is
  // never boxed into deny-only — Allow forwards the payload unchanged.
  await expect(page.getByText('"questions"')).toBeVisible();
  const denyButton = page.getByRole('button', { name: 'Deny', exact: true });
  await expect(denyButton).toBeVisible();
  const allowButton = page.getByRole('button', { name: 'Allow once' });
  await expect(allowButton).toBeVisible();
  await denyButton.click();
  await expect.poll(async () => (await results(page)).length).toBe(1);
  const [answered] = await results(page);
  expect(answered.result.behavior).toBe('deny');
  expect(answered.result.message).toBe('Permission denied');
});

test('malformed clarification Allow forwards the payload unchanged (F-17a fallback)', async ({ page }) => {
  const sessionId = await startSession(page);
  await emitPermission(page, sessionId, 'malformed-allow', { questions: [] });
  await expect(page.getByText('Request unavailable')).toBeVisible();
  await page.getByRole('button', { name: 'Allow once' }).click();
  await expect.poll(async () => (await results(page)).length).toBe(1);
  const [answered] = await results(page);
  expect(answered.result.behavior).toBe('allow');
});
