import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import crypto from 'node:crypto';
import path from 'path';
import { getMockArtifact, mockArtifactFilename } from './src/mobile/bridge/mockArtifacts';

/**
 * Mobile builds (REQ-E-1): two bundles from one config, selected by the
 * MOBILE_BUNDLE env var — `app` (dist-mobile/, served by the tenant at
 * /app/) and `login` (dist-mobile-login/, served by the control plane at /).
 * Dev mode (`vite --config vite.mobile.config.ts --port 5176`) serves both
 * entries at once; 5175 stays reserved for the desktop dev server.
 *
 * No electron plugins here: this config never touches the desktop main or
 * preload bundles.
 */

// Same cliPort/hmr pattern as vite.config.ts: a `--port` CLI override must
// realign the HMR port too, otherwise the HMR client points at whatever else
// listens on the stale port and reloads forever.
const cliPort = process.argv.join(' ').match(/(?:^|\s)--port[= ](\d+)/)?.[1];
const devPort = Number(process.env.IDBOTS_MOBILE_VITE_DEV_PORT || cliPort || 5176);
const mobileBundle = process.env.MOBILE_BUNDLE || 'app';
const isProductionBuild = process.env.NODE_ENV === 'production';

const appHtml = path.resolve(__dirname, 'src/mobile/app/index.html');
const loginHtml = path.resolve(__dirname, 'src/mobile/login/index.html');

/**
 * REQ-E-9 dev proxy: the mobile app bundle always talks to its own origin
 * (`ws(s)://{host}/ws`, `/files/…`, `/upload`); in dev the vite server
 * forwards those to the local gateway. The WS upgrade cannot carry headers
 * from a browser WebSocket, so the proxy injects the gateway secret itself —
 * mirroring src/main/gateway/wiring.ts dev mode, which generates and prints a
 * random secret when IDBOTS_GATEWAY_SECRET is unset (server mode fails fast
 * instead; here we degrade to a generated dev secret with a warning).
 */
const GATEWAY_TARGET_HOST = `127.0.0.1:${process.env.IDBOTS_GATEWAY_PORT || '8790'}`;

function gatewayDevSecret(): string | undefined {
  const fromEnv = process.env.IDBOTS_GATEWAY_SECRET;
  if (fromEnv && fromEnv.trim()) {
    return fromEnv.trim();
  }
  const generated = crypto.randomBytes(32).toString('base64url');
  console.warn(
    `[mobile-dev] IDBOTS_GATEWAY_SECRET is not set; using a generated dev gateway secret: ${generated}\n` +
      '[mobile-dev] set IDBOTS_GATEWAY_SECRET to reuse the desktop dev gateway secret (it prints once at startup).',
  );
  return generated;
}

function mobileDevProxy() {
  // Lazy: only generate/log when the dev server actually starts.
  let secret: string | undefined;
  const secretHeader = () => {
    if (secret === undefined) secret = gatewayDevSecret();
    return { 'X-IDBots-Gateway-Secret': secret as string };
  };

  // Real-environment dev (IDBOTS_DEV_REMOTE=https://staging.idbots.world):
  // forward the tenant surface to a deployed control plane instead of a
  // local stack, so sign-in lands on the real account (same as the PWA).
  // No secret header and no path rewrite: the deployed edge already serves
  // /api, /ws, /files and /upload exactly as the PWA's own origin does.
  const remote = process.env.IDBOTS_DEV_REMOTE?.trim();
  if (remote) {
    const httpTarget = remote.replace(/\/$/, '');
    const wsTarget = httpTarget.replace(/^http/, 'ws');
    // The deployed control plane and ws proxy both enforce an Origin
    // allowlist (non-GET HTTP and the ws handshake), so present the remote
    // origin; the session cookie itself stays on the dev origin.
    const originHeader = { headers: { origin: httpTarget } };
    const cookieRewrite = { cookieDomainRewrite: '' };
    return {
      '/api': { target: httpTarget, changeOrigin: true, secure: true, ...originHeader, ...cookieRewrite },
      '/ws': { target: wsTarget, ws: true, changeOrigin: true, secure: true, ...originHeader, ...cookieRewrite },
      '/files/': { target: httpTarget, changeOrigin: true, secure: true, ...originHeader, ...cookieRewrite },
      '/upload': { target: httpTarget, changeOrigin: true, secure: true, ...originHeader, ...cookieRewrite },
    };
  }

  return {
    // C2 websocket; the client connects to /ws on the page origin.
    '/ws': {
      target: `ws://${GATEWAY_TARGET_HOST}`,
      ws: true,
      changeOrigin: true,
      headers: secretHeader(),
      rewrite: (requestPath: string) => '/gateway/v1/ws' + requestPath.slice('/ws'.length),
    },
    // C2 File Download (signed tokens); /files/<token> → /gateway/v1/files/<token>.
    '/files/': {
      target: `http://${GATEWAY_TARGET_HOST}`,
      changeOrigin: true,
      headers: secretHeader(),
      rewrite: (requestPath: string) => `/gateway/v1${requestPath}`,
    },
    // C2 Upload; /upload?name=… → /gateway/v1/upload?name=… (query preserved).
    '/upload': {
      target: `http://${GATEWAY_TARGET_HOST}`,
      changeOrigin: true,
      headers: secretHeader(),
      rewrite: (requestPath: string) => `/gateway/v1${requestPath}`,
    },
  };
}

/** Dev-only: serve / and /login without leaving the mobile entries. */
function mobileDevEntriesPlugin() {
  return {
    name: 'idbots-mobile-dev-entries',
    configureServer(server: import('vite').ViteDevServer) {
      server.middlewares.use((req, res, next) => {
        if (process.env.VITE_MOBILE_MOCK !== '1' || (req.method !== 'GET' && req.method !== 'HEAD')) {
          next();
          return;
        }
        const url = new URL(req.url ?? '/', 'http://mobile.invalid');
        if (!url.pathname.startsWith('/files/mock/')) {
          next();
          return;
        }
        const filePath = decodeURIComponent(url.pathname.slice('/files/mock/'.length));
        const artifact = getMockArtifact(filePath);
        if (!artifact) {
          res.statusCode = 404;
          res.end('Artifact not found');
          return;
        }
        const bytes = artifact.bytes();
        const disposition = url.searchParams.get('disposition') === 'inline' ? 'inline' : 'attachment';
        res.statusCode = 200;
        res.setHeader('Content-Type', artifact.mime);
        res.setHeader('Content-Length', bytes.byteLength);
        res.setHeader('Content-Disposition', `${disposition}; filename="${mockArtifactFilename(filePath)}"`);
        res.end(req.method === 'HEAD' ? undefined : bytes);
      });
      server.middlewares.use((req, res, next) => {
        const url = req.url?.split('?')[0] ?? '';
        // The login page navigates to /app/ after sign-in; serve the app
        // entry there (and at /app) so the flow works on dev:mobile.
        if (url === '/app' || url === '/app/' || url === '/app/index.html') {
          req.url = '/src/mobile/app/index.html';
        } else if (url === '/' || url === '/index.html') {
          req.url = '/src/mobile/app/index.html';
        } else if (url === '/login' || url === '/login/' || url === '/login/index.html') {
          req.url = '/src/mobile/login/index.html';
        } else if (url === '/manifest.webmanifest' || url === '/app/manifest.webmanifest') {
          // PWA manifest + icons (REQ-E-21): the dev root is the repo, so
          // these resolve from the app bundle's public/ source dir.
          req.url = '/src/mobile/app/public/manifest.webmanifest';
        } else {
          const icon = url.match(/^\/(?:app\/)?(icon-192\.png|icon-512\.png|apple-touch-icon\.png)$/);
          if (icon) {
            req.url = `/src/mobile/app/public/${icon[1]}`;
          }
        }
        next();
      });
    },
    // The entries use a relative script src ("./main.tsx") so production
    // builds (root = the bundle dir) resolve it. In dev the browser URL is
    // "/" or "/login", where the same relative src would resolve to
    // "/main.tsx" and 404 — rewrite it to the absolute entry path instead.
    transformIndexHtml(html: string, ctx: { filename?: string }) {
      const file = ctx.filename ?? '';
      const entry = file.includes(`${path.sep}mobile${path.sep}app${path.sep}`)
        ? '/src/mobile/app/main.tsx'
        : file.includes(`${path.sep}mobile${path.sep}login${path.sep}`)
          ? '/src/mobile/login/main.tsx'
          : null;
      return entry ? html.replace('src="./main.tsx"', `src="${entry}"`) : html;
    },
  };
}

export default defineConfig(({ command }) => {
  // `vite preview` also runs with command === 'serve': it must NOT get the
  // dev-server root/base, otherwise dist-mobile is served at '/' and /app/
  // only answers through the HTML fallback (JS requests then 404). Detect
  // preview explicitly and treat it exactly like a production build.
  const isDevServer = command === 'serve' && !process.argv.includes('preview');
  return {
  // Build and preview: root at the bundle's own directory so index.html lands
  // directly in dist-mobile/ and dist-mobile-login/ (the C2/C3 integration
  // contract: the tenant serves dist-mobile/index.html at /app/, the control
  // plane serves dist-mobile-login/index.html at / and /login). This also
  // stops the desktop public/ folder (IM icons etc.) from being copied into
  // the mobile bundles. Dev keeps the repo root so both entries share one
  // server.
  root: isDevServer ? __dirname : path.resolve(__dirname, 'src/mobile', mobileBundle === 'app' ? 'app' : 'login'),
  plugins: [react(), ...(isDevServer ? [mobileDevEntriesPlugin()] : [])],
  base: isDevServer ? '/' : mobileBundle === 'app' ? '/app/' : '/',
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src/renderer'),
    },
  },
  build: {
    outDir: path.resolve(__dirname, mobileBundle === 'app' ? 'dist-mobile' : 'dist-mobile-login'),
    emptyOutDir: true,
    sourcemap: false,
    // The budget check (scripts/check-mobile-budgets.mjs) computes each
    // entry's initial-asset closure from the manifest (isEntry + imports).
    manifest: true,
    rollupOptions: {
      input:
        isDevServer
          ? { app: appHtml, login: loginHtml }
          : mobileBundle === 'app'
            ? appHtml
            : loginHtml,
      output: {
        manualChunks(id) {
          const modulePath = id.replace(/\\/g, '/');
          if (!modulePath.includes('/node_modules/')) return undefined;
          if (/\/node_modules\/(react|react-dom|scheduler)\//.test(modulePath)) return 'vendor-react';
          return undefined;
        },
      },
    },
  },
  server: {
    port: devPort,
    strictPort: true,
    host: true,
    hmr: {
      port: devPort,
    },
    // Dev only (never `vite preview`): the gateway proxy is harmless
    // alongside the mock bridge and is what dev:mobile:real flips on.
    ...(isDevServer ? { proxy: mobileDevProxy() } : {}),
  },
  clearScreen: false,
  };
});
