class MetaAppService {
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
