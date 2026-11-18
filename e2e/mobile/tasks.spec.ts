import { test, expect, attachScreen } from './fixtures';
import type { Page } from '@playwright/test';

async function openTasks(page: Page): Promise<void> {
  await page.goto('/app/');
  await page.getByRole('button', { name: 'Tasks', exact: true }).click();
  await expect(page.getByTestId('unified-task-lt-mobile-task-center')).toBeVisible();
}

async function createTask(page: Page, name: string) {
  await page.getByRole('tab', { name: 'Scheduled', exact: true }).click();
  await page.locator('.twin-unified-schedule-tools').getByRole('button', { name: 'New task', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'New scheduled task' })).toBeVisible();
  await expect(page.getByText('Runs as: Twin Bot')).toBeVisible();
  await page.getByPlaceholder('Task name').fill(name);
  await page.getByPlaceholder('Task prompt').fill('Produce the background report');
  await page.getByPlaceholder('Interval in minutes').fill('30');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText(name, { exact: true })).toBeVisible();
  const task = await page.evaluate(async (taskName) => {
    const result = await window.electron.scheduledTasks.list();
    return result.tasks.find((candidate: { id: string; name: string }) => candidate.name === taskName);
  }, name);
  expect(task).toBeDefined();
  expect(task.metabotId).toBe(1);
  expect(task.workingDirectory).toBe('/data/workspace');
  return task;
}

async function taskFromApi(page: Page, id: string) {
  const result = await page.evaluate(async (taskId) => window.electron.scheduledTasks.get(taskId), id);
  expect(result.success).toBe(true);
  return result.task;
}

async function successfulRun(page: Page, taskId: string) {
  const run = await page.evaluate(async (id) => {
    const result = await window.electron.scheduledTasks.listRuns(id, 20);
    return result.runs.find((candidate: { id: string; status: string }) => candidate.status === 'success');
  }, taskId);
  expect(run).toBeDefined();
  return run;
}

test.describe('scheduled tasks and background results', () => {
  test('create, edit, toggle, stop, result navigation and delete stay server-confirmed', async ({ page }, testInfo) => {
    await openTasks(page);
    const created = await createTask(page, 'E2E digest');

    await page.getByRole('button', { name: 'Edit · E2E digest', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Edit scheduled task' })).toBeVisible();
    await page.getByPlaceholder('Task name').fill('E2E digest edited');
    await page.getByPlaceholder('Task prompt').fill('Produce an edited report');
    await page.getByPlaceholder('Interval in minutes').fill('45');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    const edited = await taskFromApi(page, created.id);
    expect(edited.name).toBe('E2E digest edited');
    expect(edited.prompt).toBe('Produce an edited report');
    expect(edited.schedule.intervalMs).toBe(45 * 60_000);
    expect(edited.metabotId).toBe(1);
    expect(edited.workingDirectory).toBe('/data/workspace');
    expect(edited.memoryAccess).toBe('none');

    const toggle = page.getByRole('switch', { name: 'Enabled · E2E digest edited' });
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'true');

    await page.getByRole('button', { name: 'Run now · E2E digest edited' }).click();
    const stop = page.getByRole('button', { name: 'Stop run · E2E digest edited' });
    await expect(stop).toBeVisible();
    await page.getByRole('button', { name: 'History · E2E digest edited' }).click();
    const history = page.getByTestId(`task-runs-${created.id}`);
    await expect(history).toContainText('Running');
    await stop.click();
    await expect(history).toContainText('Stopped by user');
    const stopped = await page.evaluate(async (id) => window.electron.scheduledTasks.stop(id), created.id);
    expect(stopped).toEqual({ success: true, result: false });

    await page.getByRole('button', { name: 'Run now · E2E digest edited' }).click();
    await expect(history).toContainText('Success', { timeout: 30_000 });
    const run = await successfulRun(page, created.id);
    await page.getByRole('button', { name: `Open result · ${run.id}`, exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Scheduled run: E2E digest edited', exact: true })).toBeVisible();
    await expect(page.getByText('Mock artifacts ready.', { exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'notes.md', exact: true })).toBeVisible();
    await attachScreen(testInfo, page, 'tasks-scheduled-result');

    await page.getByRole('button', { name: 'Tasks', exact: true }).click();
    await page.getByRole('button', { name: 'History · E2E digest edited' }).click();
    await page.getByRole('button', { name: 'Delete task · E2E digest edited' }).click();
    await expect(page.getByRole('dialog', { name: 'Delete scheduled task?' })).toContainText('E2E digest edited');
    await page.getByRole('button', { name: 'Delete task', exact: true }).click();
    await expect(page.getByTestId(`task-row-${created.id}`)).toHaveCount(0);
    const remainingRuns = await page.evaluate(async (id) => window.electron.scheduledTasks.listRuns(id), created.id);
    expect(remainingRuns.runs).toEqual([]);
    await expect(page.getByText('E2E digest edited', { exact: true })).toHaveCount(0);
  });

  test('unified task progress, owner actions and existing result session stay separate from Twin chat', async ({ page }, testInfo) => {
    await page.goto('/app/');
    await expect(page.getByText('Long-term document result', { exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Tasks', exact: true }).click();
    const active = page.getByTestId('unified-task-lt-mobile-task-center');
    await expect(active).toHaveClass(/twin-unified-card-featured/);
    await expect(active).toContainText('Current step');
    await expect(active).toContainText('Confirm the Native Library and current-step card');
    await attachScreen(testInfo, page, 'tasks-unified-active');

    await page.getByRole('button', { name: /Needs you · 1 decision waiting/ }).click();
    const card = page.getByTestId('unified-task-lt-document');
    await expect(card).toContainText('Twin Bot');
    await expect(card).toContainText('Produce a document');
    await expect(card).toContainText('Owner review required');
    await expect(card).toContainText('1/3 · 33%');
    await expect(card.getByRole('progressbar', { name: 'Task progress' })).toHaveAttribute('value', '33');
    await page.getByTestId('task-details-lt-document').click();
    const detailView = page.getByTestId('task-detail-lt-document');
    await expect(detailView).toContainText('Acceptance criteria');

    await page.evaluate(() => {
      const scheduled = window.electron.longtermTask;
      const original = scheduled.setStage;
      scheduled.setStage = async (...args: unknown[]) => {
        scheduled.setStage = original;
        return { ok: false, error: 'Long-term write rejected by fixture' };
      };
    });
    await page.getByRole('button', { name: 'Pause', exact: true }).click();
    await expect(detailView).toContainText('Long-term write rejected by fixture');
    await page.getByRole('button', { name: 'Pause', exact: true }).click();
    await expect(detailView).toContainText('Paused');
    await page.getByRole('button', { name: 'Resume', exact: true }).click();
    await expect(detailView).toContainText('Needs you');
    await detailView.locator('.twin-unified-detail-footer').getByRole('button', { name: 'Open chat', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Long-term document result', exact: true })).toBeVisible();
    await expect(page.getByText('Mock artifacts ready.', { exact: true })).toBeVisible();
    await expect(page.getByText('Produce a document', { exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'Tasks', exact: true }).click();
    await page.getByRole('button', { name: /Needs you · 1 decision waiting/ }).click();
    await page.getByTestId('task-details-lt-document').click();
    await page.getByRole('button', { name: 'Cancel task', exact: true }).click();
    const confirmation = page.getByRole('dialog', { name: 'Cancel this task?' });
    await expect(confirmation).toBeVisible();
    await confirmation.getByRole('button', { name: 'Cancel task', exact: true }).click();
    await page.getByRole('button', { name: 'Back to tasks', exact: true }).click();
    await expect(page.getByTestId('unified-task-lt-document')).toHaveCount(0);
    const detail = await page.evaluate(async () => window.electron.longtermTask.get({ taskId: 'lt-document' }));
    expect(detail.detail.stage).toBe('cancelled');
    expect(detail.detail.currentSubtaskStatus).toBe('waiting_owner');
    expect(detail.detail.progress.percent).toBe(33);
  });

  test('missing result sessions preserve the current chat and never create a replacement', async ({ page }) => {
    await page.goto('/app/');
    await expect.poll(async () => page.evaluate(async () => {
      const result = await window.electron.cowork.listSessions();
      return result.sessions.filter((session: { sessionType?: string; autoOrigin?: string | null }) => (
        (!session.sessionType || session.sessionType === 'standard') && !session.autoOrigin
      )).length;
    })).toBeGreaterThan(0);
    const previous = await page.evaluate(async () => {
      const result = await window.electron.cowork.listSessions();
      return result.sessions.find((session: { sessionType?: string; autoOrigin?: string | null }) => (
        (!session.sessionType || session.sessionType === 'standard') && !session.autoOrigin
      ));
    });
    await expect(page.getByRole('heading', { name: previous.title, exact: true })).toBeVisible();
    const beforeCount = await page.evaluate(async () => (await window.electron.cowork.listSessions()).sessions.length);
    await page.getByRole('button', { name: 'Tasks', exact: true }).click();
    await page.getByRole('button', { name: /Needs you · 1 decision waiting/ }).click();
    await page.evaluate(async () => {
      const detail = (await window.electron.longtermTask.get({ taskId: 'lt-document' })).detail;
      const current = detail.subtasks.find((subtask: { id: string }) => subtask.id === detail.currentSubtaskId);
      const missingId = current.sessionId ?? detail.definitionSessionId;
      const cowork = window.electron.cowork;
      const original = cowork.getSession;
      cowork.getSession = async (sessionId: string, options?: { messageLimit?: number }) => (
        sessionId === missingId
          ? { success: false, error: 'Fixture missing result session' }
          : original(sessionId, options)
      );
    });
    await page.getByTestId('task-open-chat-lt-document').click();
    await expect(page.getByTestId('work-activity')).toContainText('This bound session is unavailable');
    await expect(page.getByRole('heading', { name: 'Tasks', exact: true, level: 1 })).toBeVisible();
    const afterCount = await page.evaluate(async () => (await window.electron.cowork.listSessions()).sessions.length);
    expect(afterCount).toBe(beforeCount);
    await page.getByRole('button', { name: 'Chat', exact: true }).click();
    await expect(page.getByRole('heading', { name: previous.title, exact: true })).toBeVisible();
  });

  test('failed history refresh preserves loaded runs and rejected deletion stays visible', async ({ page }) => {
    await openTasks(page);
    const created = await createTask(page, 'Failure recovery task');
    await page.getByRole('button', { name: 'Run now · Failure recovery task' }).click();
    await page.getByRole('button', { name: 'History · Failure recovery task' }).click();
    const history = page.getByTestId(`task-runs-${created.id}`);
    await expect(history).toContainText('Success', { timeout: 30_000 });
    const run = await successfulRun(page, created.id);
    await expect(page.getByTestId(`task-run-${run.id}`)).toBeVisible();

    await page.evaluate(() => {
      const scheduled = window.electron.scheduledTasks;
      const original = scheduled.listRuns;
      scheduled.listRuns = async (...args: unknown[]) => {
        scheduled.listRuns = original;
        return { success: false, error: 'History refresh unavailable' };
      };
    });
    await page.getByRole('button', { name: 'Hide · Failure recovery task' }).click();
    await page.getByRole('button', { name: 'History · Failure recovery task' }).click();
    await expect(history).toContainText('History refresh unavailable');
    await expect(page.getByTestId(`task-run-${run.id}`)).toBeVisible();
    await expect(page.getByTestId(`task-run-${run.id}`)).toContainText('Success');
    await history.getByRole('button', { name: 'Retry', exact: true }).click();
    await expect(history).not.toContainText('History refresh unavailable');
    await expect(page.getByTestId(`task-run-${run.id}`)).toBeVisible();

    await page.evaluate(() => {
      const scheduled = window.electron.scheduledTasks;
      const original = scheduled.delete;
      scheduled.delete = async (...args: unknown[]) => {
        scheduled.delete = original;
        return { success: false, error: 'Delete rejected by fixture' };
      };
    });
    await page.getByRole('button', { name: 'Delete task · Failure recovery task' }).click();
    const confirmation = page.getByRole('dialog', { name: 'Delete scheduled task?' });
    await confirmation.getByRole('button', { name: 'Delete task', exact: true }).click();
    await expect(confirmation).toContainText('Delete rejected by fixture');
    await expect(page.getByTestId(`task-row-${created.id}`)).toBeVisible();
  });

  test('new task opens a Twin draft and global scheduled history opens the result', async ({ page }) => {
    await openTasks(page);
    await page.getByTestId('task-center-create').click();
    await expect(page.getByTestId('chat-composer-input')).toHaveValue('I want to create a task: ');

    await page.getByRole('button', { name: 'Tasks', exact: true }).click();
    await page.getByRole('tab', { name: 'Scheduled', exact: true }).click();
    const run = await page.evaluate(async () => {
      const result = await window.electron.scheduledTasks.runManually('mock-task-2');
      return result.run;
    });
    await expect.poll(async () => page.evaluate(async (runId) => {
      const result = await window.electron.scheduledTasks.listRuns('mock-task-2');
      return result.runs.find((candidate: { id: string }) => candidate.id === runId)?.status;
    }, run.id)).toBe('success');
    await page.getByRole('tab', { name: 'History', exact: true }).click();
    await expect(page.getByTestId(`scheduled-history-run-${run.id}`)).toBeVisible();
    await page.getByRole('button', { name: `Open result · ${run.id}`, exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Scheduled run: Weekly wallet report', exact: true })).toBeVisible();
  });

  test('task center follows Chinese copy and explicit light or dark appearances', async ({ page }, testInfo) => {
    await openTasks(page);
    await page.getByRole('button', { name: 'Me', exact: true }).click();
    await page.getByTestId('me-entry-general').click();
    await page.getByRole('button', { name: '中文', exact: true }).click();
    await page.getByRole('button', { name: '浅色', exact: true }).click();
    await page.getByTestId('mobile-tab-tasks').click();
    await expect(page.getByText('当前步骤', { exact: true })).toBeVisible();
    await expect(page.getByTestId('task-open-chat-lt-mobile-task-center')).toHaveText('打开聊天');
    await expect.poll(() => page.evaluate(() => document.documentElement.classList.contains('dark'))).toBe(false);
    await attachScreen(testInfo, page, 'tasks-unified-light-zh');

    await page.getByTestId('mobile-tab-me').click();
    await page.getByTestId('me-entry-general').click();
    await page.getByRole('button', { name: '深色', exact: true }).click();
    await page.getByTestId('mobile-tab-tasks').click();
    await expect.poll(() => page.evaluate(() => document.documentElement.classList.contains('dark'))).toBe(true);
    await expect(page.getByText('当前步骤', { exact: true })).toBeVisible();
    await attachScreen(testInfo, page, 'tasks-unified-dark-zh');
  });
});
