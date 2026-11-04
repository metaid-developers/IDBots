/**
 * Immutable configuration for the MetaBot Avatar swap pilot (PRD v1.2 §2/§4).
 * Every value here was owner-ratified or chain-verified on 2026-11-04/05;
 * do not edit without an owner ruling (PRD conflict rule).
 */

export const ISSUER_CONFIG = Object.freeze({
  /** Legacy album identity (PRD §2, wallet-api measured 2026-11-04). */
  genesis: '005d69cba8c80e6978157e146f998c21288a9d49',
  codeHash: 'e205939ad9956673ce7da9fbd40514b30f66dc35',
  sensibleId: '4e7a7d3e3e748c09f1eff46fe504c5fdc389014eab3e316685004d770225ea53 00000000',
  tokenSupply: 9560,

  /** Issuer identity — restored, never re-generated (PRD §4). */
  issuerAddress: '176C9RPWDggnvdVcWG3wrZEJcm1bHTcKM5',
  issuerPath: "m/44'/236'/0'/0/0",
  /** GlobalMetaId of the issuer address (sha256-based, verified against the
   *  on-chain profile probe 2026-11-05). Restore guard constant. */
  expectedGlobalMetaId: 'idq1gtxzx45ktj8s738s6wjak0ha27d98g8h2n059n',
  /** On-chain registered chat pubkey of the identity (public profile data,
   *  file.metaid.io probe 2026-11-05) — third identity cross-check. */
  expectedChatPubKey:
    '047a0ca1a83f2962d53921237219e1b13067d03d7582fcea50bf720052ff8dca0cbbe1f1814fd95288bf280bac04368af9eee422f727eec08a62348ea6f6cef54e',

  /** Vault subaddress = fixed derivation index under the same issuer account
   *  (owner ruling 2026-11-05: index 1). Polling filters by THIS address only. */
  vaultPath: "m/44'/236'/0'/0/1",

  /** New MRC-721 collection (owner naming ruling 2026-11-05). */
  collectionName: 'metabot-avatar',
  botDisplayName: 'Avatar 兑换站',

  /** One-way burn sink (owner ruling 2026-11-04, balance re-verified 2026-11-05). */
  burnAddress: '1111111111111111111114oLvT2',

  net: 'livenet',
  /** Fee budget ceiling per swapped token in sats (COST-BUDGET-m0-pre-v1.md). */
  perSwapFeeCeilingSats: 5000,
});

/** ECDH peer pubkey used by MetaID chat key derivation (metabotWalletService). */
export const MAN_PUB_KEY =
  '048add0a6298f10a97785f7dd069eedb83d279a6f03e73deec0549e7d6fcaac4eef2c279cf7608be907a73c89eb44c28db084c27b588f1bd869321a6f104ec642d';

/** Message signed by the 236 issuer key to prove same-origin binding
 *  (PRD §8 M0: collection_desc metadata carries this signature). */
export function issuerBindingMessage(address) {
  return `issuer-address-binding:v1:${address}`;
}
