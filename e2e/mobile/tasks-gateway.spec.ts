import { test, expect, attachScreen } from './fixtures';
import type { Page } from '@playwright/test';

const isGatewayRun = Boolean(process.env.E2E_GATEWAY);

test.describe('gateway background work', () => {
  test.skip(!isGatewayRun, 'requires the gateway harness');

  test('scheduled task edit, stop, toggle and delete use real C2 @gateway', async ({ page }, testInfo) => {
    await page.goto('/app/');
    await page.getByRole('button', { name: 'Tasks', exact: true }).click();
    await page.getByRole('tab', { name: 'Scheduled', exact: true }).click();

    await page.getByRole('button', { name: 'Edit · Gateway weekly job' }).click();
    await expect(page.getByRole('dialog', { name: 'Edit scheduled task' })).toBeVisible();
    await page.getByRole('textbox', { name: 'Cron expression' }).fill('0 10 * * 1');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    const seed = await page.evaluate(async () => (await window.electron.scheduledTasks.get('gw-task-2')).task);
    expect(seed.schedule).toEqual({ type: 'cron', expression: '0 10 * * 1' });
    expect(seed.metabotId).toBe(1);
    expect(seed.memoryAccess).toBe('read-write');
    expect(seed.targetSessionId).toBe('gw-preserved-target');
    expect(seed.coworkSessionId).toBe('gw-preserved-cowork');

    await page.locator('.twin-unified-schedule-tools').getByRole('button', { name: 'New task', exact: true }).click();
    await expect(page.getByText('Runs as: Gateway Twin')).toBeVisible();
    await page.getByPlaceholder('Task name').fill('Gateway lifecycle task');
    await page.getByPlaceholder('Task prompt').fill('Exercise the lifecycle');
    await page.getByPlaceholder('Interval in minutes').fill('30');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'New scheduled task' })).toHaveCount(0);
    const task = await page.evaluate(async () => {
      const result = await window.electron.scheduledTasks.list();
      return result.tasks.find((candidate: { id: string; name: string }) => candidate.name === 'Gateway lifecycle task');
    });
    expect(task.metabotId).toBe(1);
    const config = await page.evaluate(async () => window.electron.cowork.getConfig());
    expect(task.workingDirectory).toBe(config.config.workingDirectory);

    const toggle = page.getByRole('switch', { name: 'Enabled · Gateway lifecycle task' });
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await page.getByRole('button', { name: 'Run now · Gateway lifecycle task' }).click();
    const stop = page.getByRole('button', { name: 'Stop run · Gateway lifecycle task' });
    await expect(stop).toBeVisible();
    await page.getByRole('button', { name: 'History · Gateway lifecycle task' }).click();
    const history = page.getByTestId(`task-runs-${task.id}`);
    await expect(history).toContainText('Running');
    await stop.click();
    await expect(history).toContainText('Stopped by user');
    const duplicateStop = await page.evaluate(async (id) => window.electron.scheduledTasks.stop(id), task.id);
    expect(duplicateStop).toEqual({ success: true, result: false });
    await attachScreen(testInfo, page, 'gateway-task-stopped');

    await page.getByRole('button', { name: 'Delete task · Gateway lifecycle task' }).click();
    await page.getByRole('button', { name: 'Delete task', exact: true }).click();
    await expect(page.getByTestId(`task-row-${task.id}`)).toHaveCount(0);
    expect((await page.evaluate(async (id) => window.electron.scheduledTasks.listRuns(id), task.id)).runs).toEqual([]);
  });

  test('closed browser reopens the completed scheduled result through real C2 @gateway', async ({ page, context }, testInfo) => {
    await page.goto('/app/');
    await expect(page.getByText('Gateway scheduled result.', { exact: true })).toHaveCount(0);
    await expect(page.getByText('Gateway long-term result.', { exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Tasks', exact: true }).click();
    await page.getByRole('tab', { name: 'Scheduled', exact: true }).click();
    await page.locator('.twin-unified-schedule-tools').getByRole('button', { name: 'New task', exact: true }).click();
    await page.getByPlaceholder('Task name').fill('Gateway closed-phone job');
    await page.getByPlaceholder('Task prompt').fill('Report while the phone is closed');
    await page.getByPlaceholder('Interval in minutes').fill('30');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'New scheduled task' })).toHaveCount(0);
    const task = await page.evaluate(async () => {
      const result = await window.electron.scheduledTasks.list();
      return result.tasks.find((candidate: { id: string; name: string }) => candidate.name === 'Gateway closed-phone job');
    });
    await page.getByRole('button', { name: 'Run now · Gateway closed-phone job' }).click();
    await expect(page.getByRole('button', { name: 'Stop run · Gateway closed-phone job' })).toBeVisible();
    await page.close();

    const reopened = await context.newPage();
    await reopened.goto('/app/');
    await expect(reopened.getByText('Gateway scheduled result.', { exact: true })).toHaveCount(0);
    await reopened.getByRole('button', { name: 'Tasks', exact: true }).click();
    await reopened.getByRole('tab', { name: 'Scheduled', exact: true }).click();
    await reopened.getByRole('button', { name: 'History · Gateway closed-phone job' }).click();
    const history = reopened.getByTestId(`task-runs-${task.id}`);
    await expect(history).toContainText('Success', { timeout: 30_000 });
    const run = await reopened.evaluate(async (id) => {
      const result = await window.electron.scheduledTasks.listRuns(id);
      return result.runs.find((candidate: { id: string; status: string }) => candidate.status === 'success');
    }, task.id);
    expect(run.sessionId).toBeTruthy();
    await reopened.getByRole('button', { name: `Open result · ${run.id}`, exact: true }).click();
    await expect(reopened.getByRole('heading', { name: 'Scheduled run: Gateway closed-phone job', exact: true })).toBeVisible();
    await expect(reopened.getByText('Gateway scheduled result.', { exact: true })).toBeVisible();
    await expect(reopened.getByRole('link', { name: 'gateway-e2e-notes.md', exact: true })).toBeVisible();
    const result = await reopened.evaluate(async (id) => {
      const response = await window.electron.cowork.getSession(id);
      return { id: response.session?.id, autoOrigin: response.session?.autoOrigin };
    }, run.sessionId);
    expect(result).toEqual({ id: run.sessionId, autoOrigin: 'schedule' });
    await attachScreen(testInfo, reopened, 'gateway-closed-phone-result');
  });

  test('unified task owner actions and existing result navigation use real C2 @gateway', async ({ page }, testInfo) => {
    await page.goto('/app/');
    await expect(page.getByText('Gateway long-term result.', { exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Tasks', exact: true }).click();
    await page.getByRole('button', { name: /Needs you · 1 decision waiting/ }).click();
    const card = page.getByTestId('unified-task-lt-document');
    await expect(card).toContainText('Gateway Twin');
    await expect(card).toContainText('Owner review required');
    await expect(card).toContainText('1/3 · 33%');
    await page.getByTestId('task-details-lt-document').click();
    const detailView = page.getByTestId('task-detail-lt-document');
    await page.getByRole('button', { name: 'Pause', exact: true }).click();
    await expect(detailView).toContainText('Paused');
    await page.getByRole('button', { name: 'Resume', exact: true }).click();
    await expect(detailView).toContainText('Needs you');
    await detailView.locator('.twin-unified-detail-footer').getByRole('button', { name: 'Open chat', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Gateway long-term result', exact: true })).toBeVisible();
    await expect(page.getByText('Gateway long-term result.', { exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'gateway-e2e-notes.md', exact: true })).toBeVisible();
    const session = await page.evaluate(async () => window.electron.cowork.getSession('gw-longterm-session-1'));
    expect(session.session.sessionType).toBe('longterm');
    await attachScreen(testInfo, page, 'gateway-longterm-result');

    await page.getByRole('button', { name: 'Tasks', exact: true }).click();
    await page.getByRole('button', { name: /Needs you · 1 decision waiting/ }).click();
    await page.getByTestId('task-details-lt-document').click();
    await page.getByRole('button', { name: 'Cancel task', exact: true }).click();
    await page.getByRole('dialog', { name: 'Cancel this task?' }).getByRole('button', { name: 'Cancel task', exact: true }).click();
    await page.getByRole('button', { name: 'Back to tasks', exact: true }).click();
    await expect(page.getByTestId('unified-task-lt-document')).toHaveCount(0);
    const detail = await page.evaluate(async () => window.electron.longtermTask.get({ taskId: 'lt-document' }));
    expect(detail.detail.stage).toBe('cancelled');
    expect(detail.detail.currentSubtaskStatus).toBe('waiting_owner');
    expect(detail.detail.progress.percent).toBe(33);
  });
});
