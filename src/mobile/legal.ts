export type MobileLegalDocument = 'terms' | 'privacy' | 'custody' | 'support';

export function mobileLegalUrl(document: MobileLegalDocument, hostname?: string): string {
  const current = hostname ?? (typeof window !== 'undefined' ? window.location.hostname : '');
  const domain = current === 'app.idbots.world' ? 'app.idbots.world' : 'staging.idbots.world';
  return `https://${domain}/${document}`;
}
