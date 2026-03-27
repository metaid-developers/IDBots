import type {
  CommunityMetaAppInstallResult,
  CommunityMetaAppListResult,
  MetaAppRecord,
  MetaAppUrlResult,
} from '../types/metaApp';

class MetaAppService {
  async listMetaApps(): Promise<MetaAppRecord[]> {
    try {
      const result = await window.electron.metaapps.list();
      if (result.success && result.apps) {
        return result.apps;
      }
      return [];
    } catch (error) {
      console.error('Failed to list MetaApps:', error);
      return [];
    }
  }

  async listCommunityMetaApps(): Promise<CommunityMetaAppListResult> {
    try {
      return await window.electron.metaapps.listCommunity();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to list community MetaApps';
      console.error('Failed to list community MetaApps:', error);
      return { success: false, error: message };
    }
  }

  async installCommunityMetaApp(sourcePinId: string): Promise<CommunityMetaAppInstallResult> {
    try {
      return await window.electron.metaapps.installCommunity({ sourcePinId });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to install community MetaApp';
      console.error('Failed to install community MetaApp:', error);
      return { success: false, error: message };
    }
  }

  async openMetaApp(appId: string, targetPath?: string): Promise<MetaAppUrlResult> {
    try {
      return await window.electron.metaapps.open({ appId, targetPath });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to open MetaApp';
      console.error('Failed to open MetaApp:', error);
      return { success: false, error: message };
    }
  }

  async resolveMetaAppUrl(appId: string, targetPath?: string): Promise<MetaAppUrlResult> {
    try {
      return await window.electron.metaapps.resolveUrl({ appId, targetPath });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to resolve MetaApp URL';
      console.error('Failed to resolve MetaApp URL:', error);
      return { success: false, error: message };
    }
  }

  onMetaAppsChanged(callback: () => void): () => void {
    return window.electron.metaapps.onChanged(callback);
  }

  async getAutoRoutingPrompt(): Promise<string | null> {
    try {
      const result = await window.electron.metaapps.autoRoutingPrompt();
      return result.success ? (result.prompt || null) : null;
    } catch (error) {
      console.error('Failed to get MetaApp auto-routing prompt:', error);
      return null;
    }
  }
}

export const metaAppService = new MetaAppService();
