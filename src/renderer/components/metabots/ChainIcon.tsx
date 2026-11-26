import React, { useId, useState } from 'react';
import { metafileToSourceUrls } from './metabotNftPresentation.js';

export type NativeChainKey = 'btc' | 'mvc' | 'doge';

export interface ChainIconProps {
  chain: NativeChainKey;
  size?: number;
  className?: string;
}

/**
 * Official vector icons for BTC, MVC (SPACE), and DOGE.
 * Uses unique SVG gradient IDs per instance so multiple MVC icons never collide.
 */
export const ChainIcon: React.FC<ChainIconProps> = ({ chain, size = 28, className = '' }) => {
  const rawId = useId();
  const gradId = `mvc-space-grad-${rawId.replace(/[^a-zA-Z0-9_-]/g, '')}`;

  if (chain === 'btc') {
    return (
      <svg
        xmlns="http://www.w3.org/2000/svg"
        fill="none"
        viewBox="0 0 28 28"
        width={size}
        height={size}
        className={`shrink-0 ${className}`}
        aria-hidden
      >
        <circle cx="14" cy="14" fill="#F7931A" r="13" />
        <path
          d="M19.451 12.11c.24-1.597-.977-2.456-2.64-3.028l.54-2.164-1.317-.328-.525 2.107a54.491 54.491 0 0 0-1.055-.249l.529-2.12L13.667 6l-.54 2.162c-.286-.065-.567-.13-.84-.197l.001-.007-1.816-.453-.35 1.406s.977.224.956.238c.534.133.63.486.614.766l-.614 2.464c.036.01.084.023.137.044l-.039-.01a9.61 9.61 0 0 0-.1-.024l-.862 3.452c-.065.162-.23.405-.603.313.013.019-.957-.24-.957-.24L8 17.423l1.714.427c.187.047.373.096.556.143l.382.1-.544 2.188 1.315.328.54-2.165c.359.097.707.187 1.049.272l-.538 2.155 1.317.328.545-2.184c2.245.425 3.934.254 4.644-1.777.573-1.636-.028-2.579-1.21-3.194.86-.198 1.509-.764 1.682-1.933Zm-3.008 4.218c-.374 1.5-2.722.88-3.796.597a12.07 12.07 0 0 0-.257-.067l.723-2.899c.09.023.2.047.324.075 1.111.25 3.388.76 3.006 2.294ZM13.66 12.69c.895.239 2.85.76 3.19-.603.347-1.395-1.552-1.815-2.48-2.02a11.317 11.317 0 0 1-.27-.063l-.656 2.63a9.4 9.4 0 0 1 .216.056Z"
          fillRule="evenodd"
          fill="#FFF"
        />
      </svg>
    );
  }

  if (chain === 'doge') {
    return (
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 28 28"
        fill="none"
        width={size}
        height={size}
        className={`shrink-0 ${className}`}
        aria-hidden
      >
        <circle cx="14" cy="14" r="13" fill="#C2A633" />
        <path
          fill="#FFF"
          d="M10.5 8h4.7c1.9 0 3.4.5 4.5 1.3 1.1.9 1.9 2 2.3 3.5.5 1.5.5 3 0 4.5-.5 1.5-1.3 2.7-2.3 3.5-1.1.9-2.6 1.3-4.5 1.3H10.5V8zm2.8 2.2v8.8h1.8c1 0 1.9-.2 2.5-.8.6-.6 1-1.3 1.3-2.1.2-.9.2-1.9 0-2.7-.2-.9-.7-1.6-1.3-2.1-.6-.6-1.5-.8-2.5-.8h-1.8z"
        />
        <path fill="#FFF" d="M6.5 12.8h8.8v2.7H6.5z" />
      </svg>
    );
  }

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 44 44"
      width={size}
      height={size}
      className={`shrink-0 ${className}`}
      aria-hidden
    >
      <defs>
        <linearGradient x1="0" y1="1" x2="1" y2=".214" id={gradId}>
          <stop offset="0%" stopColor="#49FEFF" />
          <stop offset="100%" stopColor="#0314FF" />
        </linearGradient>
      </defs>
      <circle cx="22" cy="22" fill="#E6F4FE" r="21" />
      <path
        d="M22.138 14.094c2.104 0 4.161.848 5.623 2.4.211.224 1.124.272 1.864.272.55 0 1.003-.026 1.003-.026s-1.412 1.959-1.252 2.425c1.121 3.268-.233 6.959-3.422 8.748a7.753 7.753 0 0 1-3.801.993c-2.117 0-4.187-.858-5.65-2.43-.191-.204-.99-.252-1.693-.252-.61 0-1.146.036-1.146.036s1.378-2.03 1.214-2.536c-1.053-3.24.307-6.868 3.459-8.637a7.754 7.754 0 0 1 3.801-.993Zm0-3.094v3.094V11c-1.887 0-3.752.487-5.393 1.408-2.142 1.202-3.807 3.1-4.688 5.343a10.276 10.276 0 0 0-.487 5.89c-.16.285-.373.634-.565.917l-3.528 5.216 6.406-.427c.002 0 .443-.029.927-.029h.125A11.01 11.01 0 0 0 22.153 32c1.887 0 3.752-.487 5.393-1.408 2.168-1.216 3.843-3.14 4.717-5.417.722-1.878.872-3.924.447-5.868.156-.254.351-.55.526-.794L37 13.273l-6.562.378a16.303 16.303 0 0 1-1.096.018A11.018 11.018 0 0 0 22.14 11Z"
        fill={`url(#${gradId})`}
      />
      <ellipse cx="8.959" cy="15.199" rx="1.959" ry="1.904" fill="#0EA5E9" />
    </svg>
  );
};

function resolveTokenIconCandidates(icon?: string): string[] {
  const raw = typeof icon === 'string' ? icon.trim() : '';
  if (!raw) return [];
  if (/^https?:\/\//i.test(raw) || raw.startsWith('data:image/')) return [raw];
  return metafileToSourceUrls(raw);
}

export interface TokenAvatarProps {
  symbol: string;
  icon?: string;
  chain: 'btc' | 'mvc';
  size?: number;
}

export const TokenAvatar: React.FC<TokenAvatarProps> = ({ symbol, icon, chain, size = 34 }) => {
  const candidates = resolveTokenIconCandidates(icon);
  const [srcIndex, setSrcIndex] = useState(0);
  const activeSrc = candidates[srcIndex] ?? null;
  const monogram = (symbol || 'TK').trim().slice(0, 3).toUpperCase();

  return (
    <div
      className="relative shrink-0 inline-flex items-center justify-center rounded-full border border-slate-900/[0.08] dark:border-white/[0.10] bg-[#f1f5f9] dark:bg-[#1e2d44] text-[11px] font-bold tracking-tight text-[#181d25] dark:text-[#f3f5f8]"
      style={{ width: size, height: size }}
    >
      {activeSrc ? (
        <img
          src={activeSrc}
          alt={symbol}
          className="h-full w-full rounded-full object-cover"
          onError={() => setSrcIndex((idx) => idx + 1)}
        />
      ) : (
        <span>{monogram}</span>
      )}
      <span className="absolute -bottom-0.5 -right-0.5 rounded-full bg-white dark:bg-[#141e2e] p-[1px] shadow-sm">
        <ChainIcon chain={chain} size={13} />
      </span>
    </div>
  );
};

export default ChainIcon;
