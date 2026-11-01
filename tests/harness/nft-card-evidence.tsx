/**
 * S3 evidence harness — the three real chat surfaces rendering the SAME
 * `nft-card` fence, mounted with REAL mainnet data (Metabot Gen 2 #5028
 * 小明, wallet-api v4 utxo-list fields, probed live 2026-11-02).
 *
 * Surfaces are the REAL components, not mocks:
 *   1. CoWork  — the assistant narration bubble wrapper from
 *      CoworkSessionDetail (exact classes) with MarkdownContent, plus a
 *      plain markdown image bubble right below for the visual-contrast shot.
 *   2. A2A     — A2AMessageItem, incoming peer message.
 *   3. Group   — GroupTaskMessageItem, group-task transcript broadcast.
 *
 * Served by vite dev from the worktree root:
 *   http://localhost:<port>/tests/harness/nft-card-evidence.html
 * Captured by tests/harness/capture-nft-card-evidence.mjs (playwright).
 */

import React from 'react';
import { createRoot } from 'react-dom/client';
import '../../src/renderer/index.css';
import MarkdownContent from '../../src/renderer/components/MarkdownContent';
import A2AMessageItem from '../../src/renderer/components/cowork/A2AMessageItem';
import GroupTaskMessageItem from '../../src/renderer/components/groupTasks/GroupTaskMessageItem';
import { serializeNftCardFence } from '../../src/renderer/components/chat/nftCardSyntax';

// Real mainnet NFTs, fields verbatim from GET wallet-api/v4/mvc/address/
// contract/nft/utxo-list (2026-11-02 live probe):
//   - #6734 MetaBot Avatar - Legs 14 — held by 1AxUdSkV… (Builder阿码),
//     the S2 market's first real trade (tx 813c8c54…, height 196652). Its
//     imgUrl is a servable PNG (probed: 200 image/png 13935B).
//   - The LISTED variant keeps the historical seller AI_Sunny as owner.
const BASE = {
  genesis: '005d69cba8c80e6978157e146f998c21288a9d49',
  codehash: 'e205939ad9956673ce7da9fbd40514b30f66dc35',
  tokenIndex: '6734',
  name: 'MetaBot Avatar - Legs 14',
  series: 'MetaBot Avatar',
  imgUrl: 'https://metalet.space/metafile/compress/3c9f97491b3b50c2a8d413877163020fb12dd13dbc7326e898d834bfdbe10a10.png',
  icon: 'metafile://3c9f97491b3b50c2a8d413877163020fb12dd13dbc7326e898d834bfdbe10a10.png',
};
const SOLD_CARD = {
  ...BASE,
  owner: '1AxUdSkVdDyDreYSYVoDRFeyS1pvQdvcJx',
  ownerLabel: 'Builder阿码',
  priceSats: 100000,
  action: 'sold',
};
const LISTED_CARD = {
  ...BASE,
  owner: '1GrqX7K9jdnUor8hAoAfDx99uFH2tT75Za',
  ownerLabel: 'AI_Sunny',
  priceSats: 100000,
  action: 'listed',
};
const SOLD_FENCE = serializeNftCardFence(SOLD_CARD);
const LISTED_FENCE = serializeNftCardFence(LISTED_CARD);
const PLAIN_IMAGE = BASE.imgUrl;

const Section: React.FC<{ id: string; title: string; children: React.ReactNode }> = ({ id, title, children }) => (
  <section id={id} className="mx-auto mb-10 max-w-[760px] px-4">
    <h2 className="mb-2 text-sm font-bold uppercase tracking-wide text-claude-accent">{title}</h2>
    <div className="rounded-2xl border border-claude-border bg-white p-3 dark:border-claude-darkBorder dark:bg-[#2b2b2e]">
      {children}
    </div>
  </section>
);

const App: React.FC = () => (
  <main className="py-6">
    <h1 className="mx-auto mb-6 max-w-[760px] px-4 text-lg font-bold text-claude-text dark:text-claude-darkText">
      NFT chat card — three surfaces, one fence (evidence page)
    </h1>

    <Section id="cowork" title="1 · CoWork conversation (assistant bubble)">
      {/* Exact assistant-bubble wrapper from CoworkSessionDetail. */}
      <div className="relative w-fit max-w-[min(720px,82%)]">
        <div className="assistant-bubble rounded-[22px] px-[16px] py-[10px] dark:text-claude-darkText text-claude-text shadow-subtle">
          <MarkdownContent
            content={`成交播报：S2 市场首笔真实成交——MetaBot Avatar #6734（Legs 14）以 100,000 sats 易主：\n\n${SOLD_FENCE}`}
            emojiImages
            className="prose dark:prose-invert max-w-none"
          />
        </div>
      </div>
      {/* Plain markdown image bubble for the visual-contrast shot. */}
      <div className="relative mt-3 w-fit max-w-[min(720px,82%)]">
        <div className="assistant-bubble rounded-[22px] px-[16px] py-[10px] dark:text-claude-darkText text-claude-text shadow-subtle">
          <MarkdownContent content={`普通图片气泡（对照组，应为裸图，非卡片）：\n\n![Legs 14 原图](${PLAIN_IMAGE})`} emojiImages className="prose dark:prose-invert max-w-none" />
        </div>
      </div>
    </Section>

    <Section id="a2a" title="2 · A2A private chat (peer bubble)">
      <A2AMessageItem
        message={{
          id: 'evidence-a2a-1',
          type: 'assistant',
          content: `担保收到，转入保管。你可以随时核验：\n\n${SOLD_FENCE}`,
          timestamp: Date.now(),
          metadata: { direction: 'incoming', txid: 'd4b3d1de5050aa822f14ae0146c607d254db1657c96dfa75f960bdba615a0cba' },
        }}
        peerName="AI_Sunny"
        metabotName="Builder阿码"
      />
    </Section>

    <Section id="group" title="3 · Group chat / group-task transcript (broadcast)">
      <GroupTaskMessageItem
        message={{
          id: 'evidence-group-1',
          content: `NFT_LISTED 播报：MetaBot Avatar #6734（Legs 14）已上架 @100,000 sats。\n\n${LISTED_FENCE}`,
          senderName: 'AI_Sunny',
          senderGlobalMetaId: 'idq1d5m392ahkhp79wsy9ur79e3vhak7tg729dwdr5',
          chainTimestamp: Date.now(),
        } as never}
        isChairSender
        isOwnerSender={false}
      />
    </Section>
  </main>
);

createRoot(document.getElementById('root')!).render(<App />);
