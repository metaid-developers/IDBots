import { test, expect, attachScreen, expectAppShell, startNewChatViaPicker } from './fixtures';

/**
 * Voice input e2e (@voice) — voice P0, subtask #10.
 *
 * Proves the FULL frontend pipeline with the stub gateway
 * (scripts/voice-stub-gateway.mjs, started by run-mobile-e2e-voice.mjs):
 *   tap mic → capture start → PCM frames → WebSocket draft-v0 → streaming
 *   partials → LIVE draft backfill → tap stop → final replaces the partial.
 *
 * Mic seam (honest scope note): the sandbox cannot grant a real microphone
 * (Chromium fake-media flags hang on this host — probe matrix in the
 * evidence dir), so the specs run with the mock-build + ?voiceMockMic=1
 * gated synthetic mic (src/mobile/app/voice/mockMic.ts): a deterministic
 * sine feeds the REAL chunker → wire encoder → WebSocket → stub → backfill.
 * Real-mic verification is manual (交付说明), NOT RUN in this slice.
 *
 * Gate: VOICE_E2E=1 only (set by the voice runner) so regular suites are
 * untouched. Chromium-only: the runner targets the pixel7 project.
 */
// Durable screenshots for the delivery evidence (test-results is wiped
// between runs): VOICE_SHOT_DIR is set by run-mobile-e2e-voice.mjs.
const shotDir = process.env.VOICE_SHOT_DIR || 'test-results/voice-shots';
const shot = (name: string) => `${shotDir}/${name}`;

test.use({
  launchOptions: {
    args: ['--autoplay-policy=no-user-gesture-required'],
  },
});

test.describe('voice input @voice', () => {
  test.skip(({ browserName }) => browserName !== 'chromium', 'voice e2e targets the pixel7 chromium project');
  test.skip(() => process.env.VOICE_E2E !== '1', 'requires the voice stub runner (VOICE_E2E=1)');

  test('speech streams into the composer and the final replaces the partial', async ({ page }, testInfo) => {
    await page.goto('/app/?voiceMockMic=1');
    await expectAppShell(page);

    // In-run gate probe (diagnosis for the mic seam; kept as a guard).
    const gate = await page.evaluate(async () => {
      const mod = await import('/src/mobile/app/voice/mockMic.ts');
      return { gate: mod.shouldUseMockMic(), search: location.search };
    });
    if (!gate.gate) throw new Error(`mock mic gate closed in-run: ${JSON.stringify(gate)}`);

    await startNewChatViaPicker(page);

    const textarea = page.locator('textarea');
    await expect(textarea).toBeVisible();
    await expect(textarea).toHaveValue('');

    // Tap to start — button walks idle → requestingMic/connecting → recording.
    const micIdle = page.getByTestId('voice-btn-idle');
    await micIdle.click();
    const recording = page.getByTestId('voice-btn-recording');
    await expect(recording).toBeVisible({ timeout: 20_000 });

    // Streaming partials backfill the composer LIVE (豆包式): the value grows
    // while "speech" (mock sine frames) flows to the stub gateway.
    await expect(textarea).toHaveValue(/今天/, { timeout: 10_000 });
    await expect(textarea).toHaveValue(/今天天气不错，适合/, { timeout: 10_000 });
    await attachScreen(testInfo, page, 'voice-recording-partial-backfill');
    await page.screenshot({ path: shot('voice-recording-partial-backfill.png'), fullPage: false });

    // Tap again to stop — final replaces the trailing partial in the draft.
    await recording.click();
    await expect(page.getByTestId('voice-btn-idle')).toBeVisible({ timeout: 15_000 });
    await expect(textarea).toHaveValue('今天天气不错，适合出门走走。', { timeout: 15_000 });
    await attachScreen(testInfo, page, 'voice-final-in-composer');
    await page.screenshot({ path: shot('voice-final-in-composer.png'), fullPage: false });

    // Session bookkeeping: error banner stays hidden on the happy path.
    await expect(page.getByTestId('voice-error')).toHaveCount(0);
  });

  test('second session appends at the caret with CJK glue (no space)', async ({ page }) => {
    await page.goto('/app/?voiceMockMic=1');
    await expectAppShell(page);
    await startNewChatViaPicker(page);

    const textarea = page.locator('textarea');
    // Pre-seed a draft via the real input path.
    await textarea.click();
    await textarea.fill('帮我记录：');
    await expect(textarea).toHaveValue('帮我记录：');

    const micIdle = page.getByTestId('voice-btn-idle');
    await micIdle.click();
    const recording = page.getByTestId('voice-btn-recording');
    await expect(recording).toBeVisible({ timeout: 20_000 });

    // Partials land mid-draft, then tap stop for the final swap.
    await expect(textarea).toHaveValue(/帮我记录：今天天气不错，适合/, { timeout: 20_000 });
    await recording.click();
    await expect(page.getByTestId('voice-btn-idle')).toBeVisible({ timeout: 15_000 });

    // Voice text joins the CJK base with NO space (glue rule) and the final
    // lands after the existing draft.
    await expect(textarea).toHaveValue(/帮我记录：今天天气不错，适合出门走走。/, { timeout: 20_000 });
    await expect(page.getByTestId('voice-error')).toHaveCount(0);
  });
});
