// Official Native Chain Vector Icons (sourced from metalet-extension-next/src/assets/icons-v3)
window.CHAIN_SVGS = {
  btc: `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 28 28"><circle cx="14" cy="14" fill="#F7931A" r="13"/><path d="M19.451 12.11c.24-1.597-.977-2.456-2.64-3.028l.54-2.164-1.317-.328-.525 2.107a54.491 54.491 0 0 0-1.055-.249l.529-2.12L13.667 6l-.54 2.162c-.286-.065-.567-.13-.84-.197l.001-.007-1.816-.453-.35 1.406s.977.224.956.238c.534.133.63.486.614.766l-.614 2.464c.036.01.084.023.137.044l-.039-.01a9.61 9.61 0 0 0-.1-.024l-.862 3.452c-.065.162-.23.405-.603.313.013.019-.957-.24-.957-.24L8 17.423l1.714.427c.187.047.373.096.556.143l.382.1-.544 2.188 1.315.328.54-2.165c.359.097.707.187 1.049.272l-.538 2.155 1.317.328.545-2.184c2.245.425 3.934.254 4.644-1.777.573-1.636-.028-2.579-1.21-3.194.86-.198 1.509-.764 1.682-1.933Zm-3.008 4.218c-.374 1.5-2.722.88-3.796.597a12.07 12.07 0 0 0-.257-.067l.723-2.899c.09.023.2.047.324.075 1.111.25 3.388.76 3.006 2.294ZM13.66 12.69c.895.239 2.85.76 3.19-.603.347-1.395-1.552-1.815-2.48-2.02a11.317 11.317 0 0 1-.27-.063l-.656 2.63a9.4 9.4 0 0 1 .216.056Z" fill-rule="evenodd" fill="#FFF"/></svg>`,
  mvc: `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 44 44"><defs><linearGradient x1="0" y1="1" x2="1" y2=".214" id="mvcSpaceGrad"><stop offset="0%" stop-color="#49FEFF"/><stop offset="100%" stop-color="#0314FF"/></linearGradient></defs><circle cx="22" cy="22" fill="#E6F4FE" r="21"/><path d="M22.138 14.094c2.104 0 4.161.848 5.623 2.4.211.224 1.124.272 1.864.272.55 0 1.003-.026 1.003-.026s-1.412 1.959-1.252 2.425c1.121 3.268-.233 6.959-3.422 8.748a7.753 7.753 0 0 1-3.801.993c-2.117 0-4.187-.858-5.65-2.43-.191-.204-.99-.252-1.693-.252-.61 0-1.146.036-1.146.036s1.378-2.03 1.214-2.536c-1.053-3.24.307-6.868 3.459-8.637a7.754 7.754 0 0 1 3.801-.993Zm0-3.094v3.094V11c-1.887 0-3.752.487-5.393 1.408-2.142 1.202-3.807 3.1-4.688 5.343a10.276 10.276 0 0 0-.487 5.89c-.16.285-.373.634-.565.917l-3.528 5.216 6.406-.427c.002 0 .443-.029.927-.029h.125A11.01 11.01 0 0 0 22.153 32c1.887 0 3.752-.487 5.393-1.408 2.168-1.216 3.843-3.14 4.717-5.417.722-1.878.872-3.924.447-5.868.156-.254.351-.55.526-.794L37 13.273l-6.562.378a16.303 16.303 0 0 1-1.096.018A11.018 11.018 0 0 0 22.14 11Z" fill="url(#mvcSpaceGrad)"/><ellipse cx="8.959" cy="15.199" rx="1.959" ry="1.904" fill="#0EA5E9"/></svg>`,
  doge: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 28 28" fill="none"><circle cx="14" cy="14" r="13" fill="#C2A633"/><path fill="#fff" d="M10.5 8h4.7c1.9 0 3.4.5 4.5 1.3 1.1.9 1.9 2 2.3 3.5.5 1.5.5 3 0 4.5-.5 1.5-1.3 2.7-2.3 3.5-1.1.9-2.6 1.3-4.5 1.3H10.5V8zm2.8 2.2v8.8h1.8c1 0 1.9-.2 2.5-.8.6-.6 1-1.3 1.3-2.1.2-.9.2-1.9 0-2.7-.2-.9-.7-1.6-1.3-2.1-.6-.6-1.5-.8-2.5-.8h-1.8z"/><path fill="#fff" d="M6.5 12.8h8.8v2.7H6.5z"/></svg>`
};

// Crisp Procedural SVG Artwork Generator for NFT Albums & Built-in Robot Avatars
window.makeNftArtSvg = function makeNftArtSvg(palette, seedLabel, motif = 'bot') {
  const [bg1, bg2, accent, ink] = palette;
  if (motif === 'pass') {
    return `<svg viewBox="0 0 160 160" xmlns="http://www.w3.org/2000/svg">
      <defs><linearGradient id="g${seedLabel}" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="${bg1}"/><stop offset="100%" stop-color="${bg2}"/></linearGradient></defs>
      <rect width="160" height="160" fill="url(#g${seedLabel})"/>
      <rect x="20" y="34" width="120" height="92" rx="12" fill="none" stroke="${accent}" stroke-width="2.5" opacity="0.85"/>
      <circle cx="52" cy="72" r="14" fill="${accent}" opacity="0.9"/>
      <rect x="76" y="60" width="46" height="8" rx="4" fill="${ink}" opacity="0.9"/>
      <rect x="76" y="76" width="32" height="6" rx="3" fill="${ink}" opacity="0.55"/>
      <text x="32" y="112" fill="${accent}" font-family="monospace" font-size="13" font-weight="700">${seedLabel}</text>
    </svg>`;
  }
  if (motif === 'planet') {
    return `<svg viewBox="0 0 160 160" xmlns="http://www.w3.org/2000/svg">
      <rect width="160" height="160" fill="${bg1}"/>
      <circle cx="122" cy="36" r="6" fill="${accent}" opacity="0.8"/>
      <circle cx="80" cy="82" r="38" fill="${bg2}"/>
      <ellipse cx="80" cy="84" rx="62" ry="16" fill="none" stroke="${accent}" stroke-width="5" transform="rotate(-18 80 84)"/>
      <text x="16" y="144" fill="${ink}" font-family="monospace" font-size="12" font-weight="700" opacity="0.85">${seedLabel}</text>
    </svg>`;
  }
  return `<svg viewBox="0 0 160 160" xmlns="http://www.w3.org/2000/svg">
    <rect width="160" height="160" fill="${bg1}"/>
    <circle cx="80" cy="82" r="56" fill="${bg2}" opacity="0.65"/>
    <rect x="44" y="46" width="72" height="62" rx="18" fill="${ink}"/>
    <rect x="54" y="60" width="52" height="24" rx="8" fill="${bg1}"/>
    <circle cx="68" cy="72" r="6" fill="${accent}"/>
    <circle cx="92" cy="72" r="6" fill="${accent}"/>
    <rect x="76" y="28" width="8" height="18" rx="4" fill="${accent}"/>
    <rect x="56" y="114" width="48" height="22" rx="9" fill="${accent}" opacity="0.9"/>
    <text x="80" y="150" text-anchor="middle" fill="${ink}" font-family="monospace" font-size="11" font-weight="700" opacity="0.75">${seedLabel}</text>
  </svg>`;
};

window.MOCK_BOT = {
  id: 7,
  name: 'Nova-7',
  role: '数字分身 · 链上交易与研发助手',
  isTwin: true,
  globalMetaId: 'idq1nova7x9m8k2w3p4r5s6t7u8v9w0z4a9f2c',
  derivationPath: "m/44'/10001'/0'/0/0",
  btcAddress: 'bc1q8c7v9k2m4n6p8r0s2t4u6v8w0x2y4z6a9k3f7',
  mvcAddress: '1Nova7Mvc9K2x8P4w6R7s9T1u3V5x7Z9b2C4',
  dogeAddress: 'DNova7Doge8M3p5R7t9V2x4Z6b8D1f3H5j7',
  mnemonic: ['orbit', 'canvas', 'velvet', 'quantum', 'harbor', 'meadow', 'cipher', 'lantern', 'glacier', 'pioneer', 'amber', 'zenith'],
};

window.MOCK_WALLET = {
  native: [
    {
      chain: 'mvc',
      name: 'MicroVisionChain',
      symbol: 'SPACE',
      badgeClass: 'bdg-mvc',
      address: window.MOCK_BOT.mvcAddress,
      balance: '128.45200000',
      usdEst: '≈ $68.08',
      feeHint: '1 sat/vB · 极低 Gas',
      transferSupported: true,
      degradedNote: 'MVC 主索引节点响应延迟，当前余额由备用节点校验返回。',
    },
    {
      chain: 'btc',
      name: 'Bitcoin',
      symbol: 'BTC',
      badgeClass: 'bdg-btc',
      address: window.MOCK_BOT.btcAddress,
      balance: '0.01485200',
      usdEst: '≈ $1,396.09',
      feeHint: '4 sat/vB · Taproot / Native SegWit',
      transferSupported: true,
    },
    {
      chain: 'doge',
      name: 'Dogecoin',
      symbol: 'DOGE',
      badgeClass: 'bdg-doge',
      address: window.MOCK_BOT.dogeAddress,
      balance: '640.00000000',
      usdEst: '≈ $115.20',
      feeHint: '0.05 DOGE/kB · 快速确认',
      transferSupported: true,
    }
  ],
  mrc20: [
    {
      id: 'tick-idcoin',
      symbol: 'IDCOIN',
      tokenName: 'IDBots Ecosystem Coin',
      mrc20Id: 'a94d8f12e3b0...82c1i0',
      verified: true,
      decimal: 8,
      confirmed: '12,500.00',
      pendingIn: '+320.00',
      pendingOut: '0',
      display: '12,820.00',
      color: '#f7931a',
    },
    {
      id: 'tick-metaid',
      symbol: 'METAID',
      tokenName: 'MetaID Protocol Token',
      mrc20Id: 'c9cc28a481e9...f417i0',
      verified: true,
      decimal: 8,
      confirmed: '4,280.50',
      pendingIn: '0',
      pendingOut: '0',
      display: '4,280.50',
      color: '#0ea5e9',
    },
    {
      id: 'tick-pinx',
      symbol: 'PINX',
      tokenName: 'Pin Indexer Utility',
      mrc20Id: '7f1b09d4c2a8...19e3i0',
      verified: false,
      decimal: 8,
      confirmed: '89,000.00',
      pendingIn: '0',
      pendingOut: '-1,000.00',
      display: '88,000.00',
      color: '#64748b',
    },
    {
      id: 'tick-ordi',
      symbol: 'M-DOG',
      tokenName: 'Meta Doge Rune',
      mrc20Id: '3e8c51f0a6d2...77b0i0',
      verified: false,
      decimal: 8,
      confirmed: '250,000.00',
      pendingIn: '0',
      pendingOut: '0',
      display: '250,000.00',
      color: '#eab308',
    }
  ],
  mvcFt: [
    {
      id: 'ft-mc',
      symbol: 'MC',
      tokenName: 'MetaContract Governance',
      genesis: '9b4e71a2...c804f1',
      codeHash: 'a2421f1e...9081b2',
      verified: true,
      decimal: 8,
      confirmed: '1,850.2500',
      unconfirmed: '0',
      display: '1,850.2500',
      color: '#0284c7',
    },
    {
      id: 'ft-metaid-mvc',
      symbol: 'METAID',
      tokenName: 'METAID (MVC Bridge 1:1)',
      genesis: 'c9cc28a4...81f417',
      codeHash: 'a2421f1e...9081b2',
      verified: true,
      bridged: true,
      decimal: 8,
      confirmed: '960.0000',
      unconfirmed: '+40.0000',
      display: '1,000.0000',
      color: '#10b981',
    },
    {
      id: 'ft-show',
      symbol: 'SHOW',
      tokenName: 'ShowPay Social Token',
      genesis: '4d91e8c3...51a09d',
      codeHash: 'a2421f1e...9081b2',
      verified: false,
      decimal: 8,
      confirmed: '52,400.00',
      unconfirmed: '0',
      display: '52,400.00',
      color: '#8b5cf6',
    }
  ]
};

// Generate rich multi-album NFT data (so Album Directory + Pagination both work with real multi-page items)
(function initMockNfts() {
  const mrc721Albums = [
    {
      albumId: 'col-metabot-genesis',
      collectionName: 'MetaBot Genesis Avatars',
      collectionPinId: '8f31c9a0e4b2...71d0i0',
      verified: true,
      supply: 3333,
      count: 15,
      motif: 'bot',
      palettes: [
        ['#1e293b', '#334155', '#ffdc51', '#f8fafc'],
        ['#0f172a', '#1e3a8a', '#38bdf8', '#f1f5f9'],
        ['#18181b', '#3f3f46', '#34d399', '#fafafa'],
      ],
      prefix: 'Genesis Bot',
    },
    {
      albumId: 'col-metaid-pass',
      collectionName: 'MetaID Founder Pass',
      collectionPinId: '2a79d4e1c8f0...09b3i0',
      verified: true,
      supply: 1000,
      count: 6,
      motif: 'pass',
      palettes: [
        ['#1c1917', '#44403c', '#ffdc51', '#fafaf9'],
        ['#172554', '#1e40af', '#60a5fa', '#eff6ff'],
      ],
      prefix: 'Founder Pass',
    },
    {
      albumId: 'col-space-voyager',
      collectionName: 'Orden of Space Voyagers',
      collectionPinId: '6c12f8b7a3d9...44e1i0',
      verified: true,
      supply: 5000,
      count: 9,
      motif: 'planet',
      palettes: [
        ['#0c4a6e', '#0369a1', '#38bdf8', '#f0f9ff'],
        ['#1e1b4b', '#312e81', '#a78bfa', '#eef2ff'],
      ],
      prefix: 'Voyager',
    },
    {
      albumId: 'col-cyber-pins',
      collectionName: 'CyberPin Experimental',
      collectionPinId: '9e04a1c5d7b2...88f2i0',
      verified: false,
      supply: 999,
      count: 4,
      motif: 'bot',
      palettes: [
        ['#27272a', '#52525b', '#fb923c', '#f4f4f5'],
      ],
      prefix: 'CyberPin',
    }
  ];

  const mrc721Items = [];
  mrc721Albums.forEach((alb, aIdx) => {
    for (let i = 1; i <= alb.count; i++) {
      const serial = 100 + aIdx * 210 + i * 7;
      const pal = alb.palettes[(i - 1) % alb.palettes.length];
      const key = `${alb.albumId}-pin-${serial}i0`;
      mrc721Items.push({
        kind: 'mrc721',
        key,
        pinId: `${serial}9a8b7c6d5e4f3a2b1c0d9e8f...${serial}i0`,
        albumId: alb.albumId,
        collectionName: alb.collectionName,
        collectionPinId: alb.collectionPinId,
        verified: alb.verified,
        supply: alb.supply,
        name: `${alb.prefix} #${serial}`,
        number: i === 2 && aIdx === 0 ? -1 : serial,
        satoshi: 546,
        chain: 'BTC / MVC Pin',
        createTime: `2026-03-${String(28 - (i % 20)).padStart(2, '0')} 14:20`,
        svg: window.makeNftArtSvg(pal, `#${serial}`, alb.motif),
      });
    }
  });

  const mcAlbums = [
    {
      albumId: 'mc-meta-relics',
      collectionName: 'MetaID OG Relics (MCP01)',
      genesis: '4b89e1f2c0d3...91a7',
      verified: true,
      supply: 2000,
      count: 11,
      motif: 'planet',
      palettes: [['#0f172a', '#0f766e', '#2dd4bf', '#f0fdfa']],
      prefix: 'OG Relic',
    },
    {
      albumId: 'mc-bot-badges',
      collectionName: 'Skill Commendation Badges',
      genesis: '7d12a9c4e8b1...33f0',
      verified: true,
      supply: 500,
      count: 5,
      motif: 'pass',
      palettes: [['#1e293b', '#475569', '#fbbf24', '#f8fafc']],
      prefix: 'Skill Badge',
    }
  ];

  const mcItems = [];
  mcAlbums.forEach((alb, aIdx) => {
    for (let i = 1; i <= alb.count; i++) {
      const tokenIdx = 12 + aIdx * 80 + i;
      const pal = alb.palettes[0];
      mcItems.push({
        kind: 'metacontract',
        key: `${alb.genesis}:${tokenIdx}`,
        pinId: `${alb.genesis}:${tokenIdx}`,
        albumId: alb.albumId,
        collectionName: alb.collectionName,
        genesis: alb.genesis,
        verified: alb.verified,
        supply: alb.supply,
        name: `${alb.prefix} #${tokenIdx}`,
        tokenIndex: String(tokenIdx),
        number: tokenIdx,
        satoshi: 1000,
        chain: 'MVC · MetaContract',
        createTime: `区块高度 #94,${210 + i}`,
        svg: window.makeNftArtSvg(pal, `#${tokenIdx}`, alb.motif),
      });
    }
  });

  window.MOCK_NFTS = {
    mrc721Albums,
    mrc721Items,
    mcAlbums,
    mcItems,
    myListings: [
      { id: 'ord-1', itemName: 'Genesis Bot #114', pinShort: '1149a8b7...114i0', buyerShort: 'bc1q9f2...8k1m', price: '0.0025 BTC (250,000 sats)', status: 'valid', expires: '22 小时后到期' },
      { id: 'ord-2', itemName: 'Founder Pass #317', pinShort: '3179a8b7...317i0', buyerShort: '任意买家 (公开原子单)', price: '0.0080 BTC (800,000 sats)', status: 'valid', expires: '6 天后到期' },
      { id: 'ord-3', itemName: 'Voyager #527', pinShort: '5279a8b7...527i0', buyerShort: 'bc1q4a1...2p9x', price: '0.0012 BTC (120,000 sats)', status: 'expired', expires: '已过期' },
    ]
  };

  window.MOCK_BUILTIN_AVATARS = [
    { code: 'R01', name: 'Nova Core', svg: window.makeNftArtSvg(['#1e293b', '#334155', '#ffdc51', '#f8fafc'], 'NOVA', 'bot') },
    { code: 'R02', name: 'Sky Sentinel', svg: window.makeNftArtSvg(['#0c4a6e', '#0284c7', '#38bdf8', '#f0f9ff'], 'SKY', 'bot') },
    { code: 'R03', name: 'Emerald Unit', svg: window.makeNftArtSvg(['#064e3b', '#059669', '#34d399', '#ecfdf5'], 'MINT', 'bot') },
    { code: 'R04', name: 'Amber Forge', svg: window.makeNftArtSvg(['#451a03', '#b45309', '#fbbf24', '#fffbeb'], 'FORGE', 'bot') },
    { code: 'R05', name: 'Slate Prime', svg: window.makeNftArtSvg(['#18181b', '#3f3f46', '#a1a1aa', '#fafafa'], 'PRIME', 'bot') },
    { code: 'R06', name: 'Crimson Pulse', svg: window.makeNftArtSvg(['#4c0519', '#be123c', '#fb7185', '#fff1f2'], 'PULSE', 'bot') },
    { code: 'R07', name: 'Cobalt Spark', svg: window.makeNftArtSvg(['#172554', '#1d4ed8', '#60a5fa', '#eff6ff'], 'SPARK', 'bot') },
    { code: 'R08', name: 'Sand Rover', svg: window.makeNftArtSvg(['#292524', '#57534e', '#fcd34d', '#fafaf9'], 'ROVER', 'bot') },
    { code: 'R09', name: 'Teal Orbit', svg: window.makeNftArtSvg(['#134e4a', '#0d9488', '#5eead4', '#f0fdfa'], 'ORBIT', 'bot') },
    { code: 'R10', name: 'Obsidian Zero', svg: window.makeNftArtSvg(['#09090b', '#27272a', '#ffdc51', '#f4f4f5'], 'ZERO', 'bot') },
  ];
})();
