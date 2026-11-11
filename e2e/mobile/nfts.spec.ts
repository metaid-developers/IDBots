import { test, expect, attachScreen } from './fixtures';

test.describe('NFT assets and mint handoff', () => {
  test('both NFT protocols render holdings and item details', async ({ page }, testInfo) => {
    await page.goto('/app/');
    await page.getByRole('button', { name: 'Me', exact: true }).click();
    await page.getByTestId('me-entry-nfts').click();
    await expect(page.getByTestId('me-page-nfts')).toBeVisible();
    await expect(page.getByTestId('nft-grid')).toBeVisible();
    await expect(page.getByText('Genesis Seed')).toBeVisible();
    await expect(page.getByText('Agent Passport')).toBeVisible();
    await attachScreen(testInfo, page, 'nft-mrc721-grid');

    await page.getByText('Genesis Seed').click();
    await expect(page.getByTestId('nft-detail')).toContainText('IDBots Founders');
    await expect(page.getByTestId('nft-detail')).toContainText('Asset pin ID');
    await page.getByRole('button', { name: '✕', exact: true }).click();

    await page.getByTestId('nft-kind-metacontract').click();
    await expect(page.getByText('Meta Contract Badge')).toBeVisible();
    await attachScreen(testInfo, page, 'nft-metacontract-grid');
  });

  test('mint form prepares a reviewable Bot request without broadcasting', async ({ page }, testInfo) => {
    await page.goto('/app/');
    await page.getByRole('button', { name: 'Me', exact: true }).click();
    await page.getByTestId('me-entry-nfts').click();
    await page.getByTestId('nft-mint-open').click();
    await expect(page.getByTestId('nft-mint-form')).toBeVisible();
    await page.getByTestId('nft-mint-collection').fill('founder-pass');
    await page.getByLabel('Create a new collection too').check();
    await page.getByTestId('nft-mint-collection-name').fill('Founder Pass');
    await page.getByTestId('nft-mint-item-name').fill('Founder #1');
    await attachScreen(testInfo, page, 'nft-mint-form');

    await page.getByTestId('nft-mint-review').click();
    const composer = page.getByPlaceholder('Type a message…');
    await expect(composer).toBeVisible();
    const prompt = await composer.inputValue();
    expect(prompt).toContain('mrc721_issue_estimate');
    expect(prompt).toContain('mrc721_collection_create');
    expect(prompt).toContain('"collection_name": "founder-pass"');
    await expect(page.getByTestId('chat-user-message')).toHaveCount(0);
    await attachScreen(testInfo, page, 'nft-mint-review-in-chat');
  });
});
