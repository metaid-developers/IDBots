import { toBrowserFileUrl } from '../../../renderer/services/localFileUrl';
import { MOCK_LOGIN_API } from '../../buildFlags';
import { uploadFile } from '../../bridge/upload';
import { getMobileElectron } from '../appBridge';

export interface MobilePreviewFile {
  name: string;
  data: Uint8Array;
  mime: string;
}

export async function publishMobilePreviewFile(file: MobilePreviewFile): Promise<string> {
  const bytes = file.data.buffer.slice(file.data.byteOffset, file.data.byteOffset + file.data.byteLength) as ArrayBuffer;
  if (MOCK_LOGIN_API) {
    const url = `/__mobile_preview__/${encodeURIComponent(file.name)}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': file.mime },
      body: bytes,
    });
    if (!response.ok) throw new Error(`MetaApp preview publish failed with HTTP ${response.status}.`);
    const result = await response.json() as { url?: string };
    if (!result.url) throw new Error('MetaApp preview publish returned no URL.');
    return result.url;
  }
  const uploaded = await uploadFile(new Blob([bytes], { type: file.mime }), { name: file.name });
  const signed = await getMobileElectron().gateway.fileSign({ path: uploaded.path, disposition: 'inline' });
  if (!('url' in signed) || typeof signed.url !== 'string' || !signed.url) {
    throw new Error(('error' in signed && signed.error) || 'MetaApp preview URL could not be created.');
  }
  return toBrowserFileUrl(signed.url);
}
