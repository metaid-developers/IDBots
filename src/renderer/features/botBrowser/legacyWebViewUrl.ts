const COMPATIBILITY_MARKER = '__idbotsLegacyWebViewUrlCompatibility';

export function installLegacyWebViewUrlCompatibility(
  scope: { URL: typeof URL } = globalThis,
): void {
  const markedScope = scope as typeof scope & { __idbotsLegacyWebViewUrlCompatibility?: typeof URL };
  if (markedScope.__idbotsLegacyWebViewUrlCompatibility === scope.URL) return;
  const NativeURL = scope.URL;
  const probeId = `${'a'.repeat(64)}i0`;
  const probe = new NativeURL(`pin://${probeId}`);
  if (probe.hostname === probeId) return;

  const supportedSchemes = new Set([
    'map',
    'metaapp',
    'metafile',
    'metaid',
    'pin',
    'preview-file',
    'preview-metaapp',
  ]);

  const CompatibleURL = new Proxy(NativeURL, {
    construct(target, args, newTarget) {
      const parsed = Reflect.construct(target, args, newTarget) as URL;
      const input = String(args[0] ?? '').trim();
      const match = input.match(/^([a-z][a-z0-9+.-]*):\/\/(.*)$/i);
      if (!match || !supportedSchemes.has(match[1].toLowerCase())) return parsed;
      if (parsed.hostname || !parsed.pathname.startsWith('//')) return parsed;

      const rest = match[2];
      const authority = rest.match(/^([^/?#]+)/)?.[1] ?? '';
      if (!authority) return parsed;
      const remainder = rest.slice(authority.length);
      const pathEnd = remainder.search(/[?#]/);
      const pathname = remainder.startsWith('/')
        ? remainder.slice(0, pathEnd === -1 ? remainder.length : pathEnd)
        : '';
      const userinfoEnd = authority.lastIndexOf('@');
      const userinfo = userinfoEnd === -1 ? '' : authority.slice(0, userinfoEnd);
      const hostPort = userinfoEnd === -1 ? authority : authority.slice(userinfoEnd + 1);
      const passwordStart = userinfo.indexOf(':');
      const username = passwordStart === -1 ? userinfo : userinfo.slice(0, passwordStart);
      const password = passwordStart === -1 ? '' : userinfo.slice(passwordStart + 1);
      let hostname = hostPort;
      let port = '';
      if (hostPort.startsWith('[')) {
        const bracketEnd = hostPort.indexOf(']');
        if (bracketEnd !== -1) {
          hostname = hostPort.slice(0, bracketEnd + 1);
          port = hostPort.slice(bracketEnd + 1).startsWith(':')
            ? hostPort.slice(bracketEnd + 2)
            : '';
        }
      } else {
        const portStart = hostPort.lastIndexOf(':');
        if (portStart !== -1) {
          hostname = hostPort.slice(0, portStart);
          port = hostPort.slice(portStart + 1);
        }
      }

      const values = {
        host: hostPort.toLowerCase(),
        hostname: hostname.toLowerCase(),
        password,
        pathname,
        port,
        username,
      };
      for (const [name, value] of Object.entries(values)) {
        Object.defineProperty(parsed, name, {
          configurable: true,
          enumerable: true,
          value,
          writable: true,
        });
      }
      return parsed;
    },
  });
  Object.defineProperty(markedScope, '__idbotsLegacyWebViewUrlCompatibility', {
    configurable: true,
    value: CompatibleURL,
  });
  scope.URL = CompatibleURL;
}

export function buildLegacyWebViewUrlCompatibilityScript(): string {
  return `(${installLegacyWebViewUrlCompatibility.toString()})(globalThis);`;
}

export function injectLegacyWebViewUrlCompatibilityHtml(html: string): string {
  if (html.includes(COMPATIBILITY_MARKER)) return html;
  const script = `<script>${buildLegacyWebViewUrlCompatibilityScript()}</script>`;
  if (/<head(?:\s[^>]*)?>/iu.test(html)) {
    return html.replace(/<head(?:\s[^>]*)?>/iu, (head) => `${head}${script}`);
  }
  return `${script}${html}`;
}
