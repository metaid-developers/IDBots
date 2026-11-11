import { test, expect, startNewChatViaPicker } from './fixtures';

type Wp0Message = { id: string; type: string; content: string; timestamp: number; metadata?: Record<string, unknown> };
type Wp0Window = Window & {
  electron: { cowork: Record<string, (...args: unknown[]) => unknown> };
  idbotsMobile: {
    mock: {
      emitCoworkStream: (
        channel: 'message' | 'complete' | 'permission' | 'permissionResolved',
        payload: unknown,
      ) => void;
    };
  };
  __wp0StartOptions: unknown[];
  __wp0SessionId: string | null;
};

async function capture(page: import('@playwright/test').Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as Wp0Window;
    w.__wp0StartOptions = [];
    w.__wp0SessionId = null;
    const cowork = w.electron.cowork;
    const originalStart = cowork.startSession;
    cowork.startSession = async (options: unknown) => {
      w.__wp0StartOptions.push(options);
      const result = await originalStart(options);
      const session = (result as { session?: { id?: string } }).session;
      if (session?.id) w.__wp0SessionId = session.id;
      return result;
    };
  });
}

async function emit(
  page: import('@playwright/test').Page,
  method: 'onStreamMessage' | 'onStreamComplete' | 'onStreamPermission' | 'onStreamPermissionResolved',
  payload: unknown,
): Promise<void> {
  const channels = {
    onStreamMessage: 'message',
    onStreamComplete: 'complete',
    onStreamPermission: 'permission',
    onStreamPermissionResolved: 'permissionResolved',
  } as const;
  const channel = channels[method];
  await page.evaluate(({ channel: name, payload: data }) => {
    const w = window as unknown as Wp0Window;
    w.idbotsMobile.mock.emitCoworkStream(name, data);
  }, { channel, payload });
}

async function currentSessionId(page: import('@playwright/test').Page): Promise<string> {
  const id = await page.evaluate(() => (window as unknown as Wp0Window).__wp0SessionId);
  if (!id) throw new Error('No started session captured');
  return id;
}

async function startNewChat(page: import('@playwright/test').Page): Promise<void> {
  await page.getByRole('button', { name: 'Sessions' }).click();
  await startNewChatViaPicker(page);
}

async function sendMessage(page: import('@playwright/test').Page, text: string): Promise<void> {
  await page.getByPlaceholder('Type a message…').fill(text);
  await page.getByTestId('chat-composer-input').press('Enter');
}

function message(id: string, type: string, content: string, metadata?: Record<string, unknown>): Wp0Message {
  return { id, type, content, timestamp: Date.now(), ...(metadata ? { metadata } : {}) };
}

test('WP1 regression: first chat binds the actual Twin, not metabotId=null', async ({ page }) => {
  await page.goto('/app/');
  await capture(page);
  await startNewChat(page);
  await sendMessage(page, 'bind my Twin');
  const options = await page.evaluate(() => {
    const w = window as unknown as Wp0Window;
    return w.__wp0StartOptions[0] as { metabotId?: number | null } | undefined;
  });
  expect(options?.metabotId).toBe(1);
});

test('WP1 regression: another session cannot append into the open transcript', async ({ page }) => {
  await page.goto('/app/');
  await capture(page);
  await emit(page, 'onStreamMessage', {
    sessionId: 'background-session',
    message: message('bg-1', 'assistant', 'BACKGROUND_MUST_NOT_APPEAR'),
  });
  await expect(page.getByText('BACKGROUND_MUST_NOT_APPEAR')).toHaveCount(0, { timeout: 1200 });
});

test('WP1 regression: another session cannot complete the visible turn', async ({ page }) => {
  await page.goto('/app/');
  await capture(page);
  await startNewChat(page);
  await sendMessage(page, 'keep this turn running');
  await expect(page.getByRole('button', { name: 'Stop' })).toBeVisible();
  await emit(page, 'onStreamComplete', { sessionId: 'background-session', claudeSessionId: null });
  await expect(page.getByRole('button', { name: 'Stop' })).toBeVisible({ timeout: 1200 });
});

test('WP1 regression: another session cannot raise a permission sheet', async ({ page }) => {
  await page.goto('/app/');
  await capture(page);
  await emit(page, 'onStreamPermission', {
    sessionId: 'background-session',
    request: {
      sessionId: 'background-session',
      requestId: 'bg-permission',
      toolName: 'write_file',
      toolInput: { path: '/data/workspace/background.txt' },
    },
  });
  await expect(page.getByText('Tool permission requested')).toHaveCount(0, { timeout: 1200 });
});

test('WP1 regression: unknown remote resolution is not displayed as approval', async ({ page }) => {
  await page.goto('/app/');
  await capture(page);
  await startNewChat(page);
  await sendMessage(page, 'start the permission session');
  const sessionId = await currentSessionId(page);
  await emit(page, 'onStreamPermission', {
    sessionId,
    request: {
      sessionId,
      requestId: 'remote-resolution',
      toolName: 'write_file',
      toolInput: { path: '/data/workspace/result.txt' },
    },
  });
  await expect(page.getByText('Tool permission requested')).toBeVisible();
  await emit(page, 'onStreamPermissionResolved', { sessionId, requestId: 'remote-resolution' });
  await expect(page.getByText('Approved', { exact: true })).toHaveCount(0, { timeout: 1200 });
  await expect(page.getByText('Tool permission requested')).toHaveCount(0, { timeout: 1200 });
});

test('WP1 regression: tool_use is not rendered as an ordinary Assistant answer', async ({ page }) => {
  await page.goto('/app/');
  await capture(page);
  await startNewChat(page);
  await sendMessage(page, 'start the tool session');
  const sessionId = await currentSessionId(page);
  await emit(page, 'onStreamMessage', {
    sessionId,
    message: message('tool-1', 'tool_use', 'RAW_TOOL_EVENT', { toolName: 'bash', toolUseId: 'tool-1' }),
  });
  await expect(page.getByText('RAW_TOOL_EVENT')).toHaveCount(0, { timeout: 1200 });
});

test('WP1 regression: raw thinking is not rendered as an ordinary Assistant answer', async ({ page }) => {
  await page.goto('/app/');
  await capture(page);
  await startNewChat(page);
  await sendMessage(page, 'start the thinking session');
  const sessionId = await currentSessionId(page);
  await emit(page, 'onStreamMessage', {
    sessionId,
    message: message('thinking-1', 'assistant', 'RAW_THINKING', { isThinking: true }),
  });
  await expect(page.getByText('RAW_THINKING')).toHaveCount(0, { timeout: 1200 });
});

test('WP1 regression: AskUserQuestion renders real options, not only JSON allow/deny', async ({ page }) => {
  await page.goto('/app/');
  await capture(page);
  await startNewChat(page);
  await sendMessage(page, 'start the clarification session');
  const sessionId = await currentSessionId(page);
  await emit(page, 'onStreamPermission', {
    sessionId,
    request: {
      sessionId,
      requestId: 'question-1',
      toolName: 'AskUserQuestion',
      toolInput: {
        questions: [
          {
            question: 'Which plan should we use?',
            header: 'Plan',
            options: [
              { label: 'Use plan A', description: 'Shared core' },
              { label: 'Use plan B', description: 'More patches' },
            ],
            multiSelect: false,
          },
        ],
      },
    },
  });
  await expect(page.getByRole('radio', { name: /Use plan A/ })).toBeVisible({ timeout: 1200 });
});

test('WP1 regression: start failure has a visible recovery state', async ({ page }) => {
  await page.goto('/app/');
  await page.evaluate(() => {
    const w = window as unknown as Wp0Window;
    w.electron.cowork.startSession = async () => {
      throw new Error('WP0_START_FAILED');
    };
  });
  await startNewChat(page);
  await sendMessage(page, 'trigger a start failure');
  await expect(page.getByText(/WP0_START_FAILED/)).toBeVisible({ timeout: 1200 });
  await expect(page.getByTestId('chat-action-status')).toBeVisible();
});

test('WP1 regression: first entry creates a Twin greeting when no session can be restored', async ({ page }) => {
  await page.goto('/app/');
  await expect(page.getByRole('heading', { name: 'Welcome' })).toBeVisible();
  await expect(page.getByText('Tell me what you want to accomplish')).toBeVisible();
});
