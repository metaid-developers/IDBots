/**
 * CheckBtcAddressSameAsMvcCommand - Check if BTC address matches MVC address
 * 
 * Command Pattern implementation following IDFramework architecture.
 * 
 * This command:
 * 1. Gets MVC address from wallet
 * 2. Gets BTC address from wallet
 * 3. Compares them and throws error if different
 * 
 * @class CheckBtcAddressSameAsMvcCommand
 */
export default class CheckBtcAddressSameAsMvcCommand {
  /**
   * Execute the command
   * 
   * @param {Object} params - Command parameters
   * @param {Object} params.stores - Alpine stores object
   *   - wallet: {Object} - Wallet store (address, isConnected, etc.)
   * @returns {Promise<void>}
   * @throws {Error} If BTC address and MVC address don't match
   */
  async execute({ stores }) {
    const walletStore = stores.wallet;
    if (!walletStore) {
      throw new Error('CheckBtcAddressSameAsMvcCommand: Wallet store not found');
    }

    if (!window.metaidwallet) {
      throw new Error('Metalet wallet is not available');
    }

    try {
      const mvcAddress = await window.metaidwallet.getAddress();
      const btcAddress = await window.metaidwallet.btc.getAddress();

      if (mvcAddress && btcAddress && mvcAddress !== btcAddress) {
        throw new Error('BTC 地址与 MVC 地址不一致，请确保使用相同的钱包地址');
      }
    } catch (error) {
      console.error('CheckBtcAddressSameAsMvcCommand error:', error);
      throw error;
    }
  }
}
