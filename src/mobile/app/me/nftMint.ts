export interface MobileNftMintRequest {
  botId: number;
  collectionName: string;
  collectionDisplayName?: string;
  createCollection: boolean;
  itemName: string;
  description: string;
  artworkPath?: string;
}

export function validateMobileNftMintRequest(input: MobileNftMintRequest): string | null {
  if (!Number.isInteger(input.botId) || input.botId <= 0) return 'mobile.nfts.mint.botRequired';
  if (!/^[a-z0-9][a-z0-9-]*$/.test(input.collectionName.trim())) return 'mobile.nfts.mint.collectionInvalid';
  if (input.createCollection && !input.collectionDisplayName?.trim()) return 'mobile.nfts.mint.collectionNameRequired';
  if (!input.itemName.trim()) return 'mobile.nfts.mint.itemNameRequired';
  return null;
}

export function buildMobileNftMintPrompt(input: MobileNftMintRequest): string {
  const payload = {
    collection_name: input.collectionName.trim(),
    create_collection: input.createCollection,
    ...(input.createCollection ? { collection_display_name: input.collectionDisplayName?.trim() } : {}),
    item_name: input.itemName.trim(),
    ...(input.description.trim() ? { description: input.description.trim() } : {}),
    ...(input.artworkPath ? { artwork_path: input.artworkPath } : {}),
    network: 'mvc',
  };
  const collectionStep = input.createCollection
    ? 'Create the collection with mrc721_collection_create, wait until it is indexed, then mint one item into it.'
    : 'Confirm with mrc721_collection_list that this Bot owns the collection, then mint exactly one item into it. Do not mint into another issuer\'s collection.';
  return [
    'Prepare one MRC-721 mint from the user-reviewed fields below. Use the MRC-721 tools, not MetaContract wallet_nft_* tools.',
    'Start with mrc721_issue_estimate so I can see the expected chain writes and cost before any broadcast.',
    collectionStep,
    input.artworkPath
      ? 'Upload artwork_path with metabot-upload-file and use the returned metafile URI as the item cover.'
      : 'No artwork was supplied; mint without a cover rather than inventing one.',
    'Use mrc721_mint exactly once for the item, preserving the requested name and description. If the mint pin succeeds but item_desc fails, do not retry the mint; report the original pin and follow the recovery guidance.',
    'Return the collection and item pin links, transaction ids, and the ME/traffic cost reported by the tools.',
    JSON.stringify(payload, null, 2),
  ].join('\n\n');
}
