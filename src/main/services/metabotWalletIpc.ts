import type { MetabotStore } from '../metabotStore';
import type { MetabotWalletAssets } from './metabotWalletAssetService';
import type {
  TokenTransferDraftInput,
  TokenTransferPreview,
} from './metabotTokenTransferService';

interface IpcMainLike {
  handle: (channel: string, listener: (_event: unknown, input: any) => Promise<any>) => void;
}

interface RegisterMetabotWalletIpcHandlersDeps {
  ipcMain: IpcMainLike;
  getMetabotStore: () => MetabotStore;
  getMetabotWalletAssets: (store: MetabotStore, input: { metabotId: number }) => Promise<MetabotWalletAssets>;
  getTokenTransferFeeSummary: (kind: 'mrc20' | 'mvc-ft') => Promise<{ list: Array<{ title: string; desc: string; feeRate: number }>; defaultFeeRate: number }>;
  buildTokenTransferPreview: (input: TokenTransferDraftInput) => Promise<TokenTransferPreview> | TokenTransferPreview;
  executeTokenTransfer: (store: MetabotStore, input: TokenTransferDraftInput) => Promise<{
    txId: string;
    commitTxId?: string;
    revealTxId?: string;
    rawTx?: string;
  }>;
}

function getErrorMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'message' in error && typeof (error as Error).message === 'string') {
    return (error as Error).message;
  }
  return String(error);
}

export function registerMetabotWalletIpcHandlers(deps: RegisterMetabotWalletIpcHandlersDeps): void {
  deps.ipcMain.handle('idbots:getMetabotWalletAssets', async (_event, input: { metabotId: number }) => {
    try {
      const assets = await deps.getMetabotWalletAssets(deps.getMetabotStore(), input);
      return { success: true, assets };
    } catch (error) {
      return { success: false, error: getErrorMessage(error) };
    }
  });

  deps.ipcMain.handle('idbots:getTokenTransferFeeSummary', async (_event, input: { kind: 'mrc20' | 'mvc-ft' }) => {
    try {
      const summary = await deps.getTokenTransferFeeSummary(input.kind);
      return { success: true, ...summary };
    } catch (error) {
      return { success: false, error: getErrorMessage(error) };
    }
  });

  deps.ipcMain.handle('idbots:buildTokenTransferPreview', async (_event, input: TokenTransferDraftInput) => {
    try {
      const preview = await deps.buildTokenTransferPreview(input);
      return { success: true, preview };
    } catch (error) {
      return { success: false, error: getErrorMessage(error) };
    }
  });

  deps.ipcMain.handle('idbots:executeTokenTransfer', async (_event, input: TokenTransferDraftInput) => {
    try {
      const result = await deps.executeTokenTransfer(deps.getMetabotStore(), input);
      return { success: true, result };
    } catch (error) {
      return { success: false, error: getErrorMessage(error) };
    }
  });
}
