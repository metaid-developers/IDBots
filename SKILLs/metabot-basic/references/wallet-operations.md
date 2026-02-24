# Wallet Operations

This document describes wallet creation and management operations for metabot-basic.

## Wallet Creation

### Generate Mnemonic

The wallet creation process starts with generating a BIP39 mnemonic phrase:

```typescript
import { generateMnemonic } from './wallet'

const mnemonic = await generateMnemonic()
// Returns: "word1 word2 ... word12"
```

### Derive Addresses

From a mnemonic, we can derive addresses for different chains:

- **MVC Address**: Main chain for MetaID operations
- **BTC Address**: Bitcoin address (same derivation path as MVC)
- **DOGE Address**: Dogecoin address

```typescript
import { getAllAddress } from './wallet'

const addresses = await getAllAddress(mnemonic)
// Returns: { mvcAddress, btcAddress, dogeAddress }
```

### Get Public Key

The public key is derived using the MVC derivation path:

```typescript
import { getPublicKey } from './wallet'

const publicKey = await getPublicKey('mvc', mnemonic)
// Returns: hex-encoded public key
```

## Account Storage

Wallet information is stored in `account.json` at the **project root** with the following structure:

```json
{
  "accountList": [
    {
      "mnemonic": "word1 word2 ... word12",
      "mvcAddress": "MVC address",
      "btcAddress": "BTC address",
      "dogeAddress": "DOGE address",
      "publicKey": "hex public key",
      "userName": "username or empty string",
      "path": "m/44'/10001'/0'/0/0",
      "globalMetaId": "optional",
      "llm": [
        {
          "provider": "deepseek",
          "apiKey": "",
          "baseUrl": "https://api.deepseek.com",
          "model": "DeepSeek-V3.2",
          "temperature": 0.8,
          "maxTokens": 500
        }
      ]
    }
  ]
}
```

**llm 为数组**：`llm[0]` 默认来自 .env；未指定时使用 `llm[0]`；可用 `getAccountLLM(account, index)` 获取。

### Account Selection Logic

1. **New Wallet Creation**: Triggered by keywords like "创建", "新建", "create"
2. **Existing Wallet Selection**:
   - Match by username or address from user prompt
   - If no match, use `accountList[0]` as default
   - New wallets are added to the front of the array (`unshift`)

## Wallet Operations

### addressIndex 兼容说明

所有涉及「当前账户」的接口均支持通过 **addressIndex** 指定推导路径中的地址索引（BIP44 path 最后一节，如 `m/44'/10001'/0'/0/3` 中的 `3`）。不传时默认为 `0`。

- **从 account.path 解析**：使用 `parseAddressIndexFromPath(account.path)`（由 `wallet.ts` 导出）。
- **新建 agent/钱包**：使用默认 path 时 addressIndex 为 `0`，可传 `{ addressIndex: 0 }` 或省略。

以下接口均支持在 options 或参数中传入 `addressIndex`（不传则使用 0）：

| 接口 | 说明 |
|------|------|
| `getCurrentWallet(chain, { mnemonic, addressIndex? })` | 获取当前链钱包 |
| `getAddress(chain, mnemonic, { addressIndex? })` | 获取指定链地址 |
| `getAllAddress(mnemonic, { addressIndex? })` | 获取 MVC/BTC/DOGE 地址 |
| `getPublicKey(chain, mnemonic, { addressIndex? })` | 获取公钥 |
| `getCredential({ mnemonic, chain?, message?, encoding?, addressIndex? })` | 签名凭证 |
| `getUtxos(chain, mnemonic, { addressIndex? })` | 获取 UTXOs |
| `createPin(params, mnemonic, { addressIndex? })`（metaid.ts） | 创建 Pin |
| `payTransactions(mnemonic, ..., feeb?, { addressIndex? })` | 支付交易 |
| `getEcdhPublickey(mnemonic, pubkey?, { addressIndex? })`（chatpubkey.ts） | ECDH 公钥 |
| `createBuzz(mnemonic, content, feeRate?, { addressIndex? })`（buzz.ts） | 发送 Buzz |

业务侧在拥有 `account` 时，应传入 `addressIndex: parseAddressIndexFromPath(account.path)`，以与 account.json 中该账户的 path 一致。

### Get Current Wallet

`getCurrentWallet` 支持在 options 中传入可选属性 `addressIndex`，不传则使用 `0`。

```typescript
import { getCurrentWallet, Chain, parseAddressIndexFromPath } from './wallet'

// 使用默认 addressIndex 0
const wallet = await getCurrentWallet(Chain.MVC, { mnemonic })

// 指定 addressIndex（例如从 account.path 解析）
const addressIndex = parseAddressIndexFromPath(account.path)
const wallet2 = await getCurrentWallet(Chain.MVC, { mnemonic, addressIndex })

const address = wallet.getAddress()
const privateKey = wallet.getPrivateKey()
```

### Sign Messages

```typescript
import { getCredential } from './wallet'

const credential = await getCredential({
  mnemonic,
  chain: 'mvc',
  message: 'metalet.space'
})
// Returns: { address, publicKey, signature }
```

## Derivation Paths 与 getPath

- **默认 Path**：`DEFAULT_PATH = m/44'/10001'/0'/0/0`（新建 agent 或无 account 时的回退值）
- **MVC Root Path**：`m/44'/10001'/0'/0`（`getMvcRootPath()`）
- **Address Index**：`getCurrentWallet` 的 options 中可选 `addressIndex`，不传则使用 0

### getPath(options?)

Path 优先从根目录 `account.json` 的 **要操作的** `accountList` 项中读取 `path` 字段。

```typescript
import { getPath, DEFAULT_PATH } from './wallet'

// 使用当前要操作的 account（默认 accountList[0]）的 path
const path0 = getPath()

// 指定 accountList 下标
const path1 = getPath({ accountIndex: 1 })

// 新建 agent 时使用默认 path（不依赖 account.json）
const pathNew = getPath({ defaultPath: DEFAULT_PATH })
```

- 不传参或只传 `accountIndex`：从 `readAccountFile()` 的 `accountList[accountIndex ?? 0]` 取 `path`，若无则返回 `DEFAULT_PATH`。
- 传 `defaultPath`：直接返回该值（用于 createAgent / 新建钱包等场景）。

## Built-in methods (account-based)

以下方法从 **account.json** 的当前操作用户读取 mnemonic，无需调用方传入；适用于脚本或上层逻辑「用当前账户」签名的场景。

| 方法 | 模块 | 说明 |
|------|------|------|
| `getMnemonicFromAccount(options?: { accountIndex? })` | wallet.ts | 返回 `{ mnemonic, addressIndex }`，accountIndex 默认 0 |
| `getNetwork()` | wallet.ts | 异步返回当前网络（与 `getNet()` 一致） |
| `signTransaction(params, returnsTransaction?, options?)` | wallet.ts | 对 MVC 交易指定输入签名；options 支持 `addressIndex`、`accountIndex` |
| `pay(toPayTransactions, hasMetaid?, feeb?, options?)` | metaid.ts | 为 TxComposer 列表支付并签名；options 支持 `addressIndex`、`accountIndex` |

- **signTransaction**：`params.transaction` 类型为 `ToSignTransaction`（txHex, scriptHex, inputIndex, satoshis, sigtype?, path? 等）；`returnsTransaction === true` 时返回 `{ txHex, txid }`，否则返回 `{ publicKey, r, s, sig, sigtype, txid }`。
- **pay**：内部调用 `payTransactions`，仅 mnemonic 改为从 `getMnemonicFromAccount` 获取。

## MVC 转账 (sendSpace) 与 DOGE 转账 (sendDoge)

- **sendSpace**（`transfer.ts`）：MVC 原生或 FT 转账，使用 account 当前用户。参数 `{ tasks: TransferTask[], broadcast?, feeb?, options?: { addressIndex?, accountIndex? } }`。`tasks[].receivers` 为 `{ address, amount }`，**amount 必须以 sats 为单位**。Space 换算：`toSats(amount, 'space')` 或 `spaceToSats(amount)`，1 Space = 10^8 sats。
- **sendDoge**（`transfer.ts`）：DOGE 转账，最小 0.01 DOGE（1,000,000 satoshis）。参数 `(params: { toAddress, satoshis, options?: { noBroadcast?, feeRate? } }, options?: { addressIndex?, accountIndex? })`，返回 `{ txId }` 或 `{ txHex }`。
- **人机确认**：业务层在调用 sendSpace 前应展示接收地址与金额，待用户确认后再执行。CLI `send_space.ts`、`send_doge.ts` 支持交互确认或 `--confirm` 跳过。

## Local DOGE wallet (doge-wallet-local.ts)

不依赖 `@metalet/utxo-wallet-service` 的本地 DOGE 实现，适用于纯脚本或离线场景：

- **LocalDogeWallet**：构造函数 `{ mnemonic, network?: 'livenet'|'testnet', addressIndex? }`；方法 `getAddress()`、`getPublicKey()`、`getPublicKeyHex()`、`getPrivateKeyWIF()`、`getNetwork()`、`getSigner()`、`signTransaction(options)`、`signMessage(message)`。
- **getDogeNetwork(network?)**：返回 bitcoinjs-lib `Network`（mainnet/testnet）。
- **getDogeDerivationPath(addressIndex?)**：返回 DOGE BIP44 路径（coin type 3）。
- **deriveDogeAddress(mnemonic, network?, addressIndex?)**、**deriveDogePublicKey(...)**、**isValidDogeAddress(address, network?)**。

## Network Configuration

Currently configured for `livenet` (mainnet). The network is set via `getNet()` function. Async variant: `getNetwork()`.
