# MetaID Protocol

This document describes MetaID registration and node creation operations.

## MetaID Registration Flow

### 1. Check UTXO Balance

Before registering, check if the wallet has UTXOs:

```typescript
import { fetchMVCUtxos } from './api'

const utxos = await fetchMVCUtxos(address)
if (utxos.length === 0) {
  // New user, need to claim gas subsidy
}
```

### 2. Claim Gas Subsidy

New users without UTXOs need to claim the initial gas subsidy:

```typescript
import { getMVCRewards, getMVCInitRewards, sleep } from './api'
import { getCredential } from './wallet'

// Step 1: Claim initial gas subsidy
await getMVCRewards({
  address: mvcAddress,
  gasChain: 'mvc'
})

// Wait for subsidy to be processed
await sleep(5000) // 5 seconds

// Step 2: Get credential for signing（若有 account，可传 addressIndex: parseAddressIndexFromPath(account.path)）
const sigRes = await getCredential({
  mnemonic: mnemonic,
  chain: 'btc',
  message: 'metaso.network',
  addressIndex: 0, // 可选，不传默认 0
})

// Step 3: Claim init rewards with signature
await getMVCInitRewards({
  address: mvcAddress,
  gasChain: 'mvc'
}, {
  'X-Signature': sigRes.signature,
  'X-Public-Key': sigRes.publicKey
})
```

### 3. Create MetaID Node

Create a MetaID node with a username:

```typescript
import { createPin, CreatePinParams } from './metaid'

const params: CreatePinParams = {
  chain: 'mvc',
  dataList: [
    {
      metaidData: {
        operation: 'create',
        path: '/info/name',
        body: 'username',
        contentType: 'text/plain',
      }
    }
  ],
  feeRate: 1,
}

const result = await createPin(params, mnemonic, { addressIndex: 0 })
// 第三个参数可选：{ addressIndex?: number }，不传则使用 0。若有 account，传 { addressIndex: parseAddressIndexFromPath(account.path) }
// Returns: { txids: string[], totalCost: number }
```

### 4. Fetch User Info and Get globalMetaId

After successful MetaID node creation, fetch user information by address to get the globalMetaId:

```typescript
import { getUserInfoByAddressByMs } from './api'

// Fetch user info by address
const userInfo = await getUserInfoByAddressByMs(mvcAddress)

if (userInfo && userInfo.globalMetaId) {
  // Update account with username and globalMetaId
  account.userName = username
  account.globalMetaId = userInfo.globalMetaId
  writeAccountFile(accountData)
}
```

The `getUserInfoByAddressByMs()` function calls the MetaID service API (`https://file.metaid.io/metafile-indexer/api/v1/users/address/{address}`) to retrieve user information including:
- `address`: User's address
- `avatar`: Avatar information
- `avatarPinId`: Avatar PIN ID
- `chatPublicKey`: Chat public key
- `chatPublicKeyId`: Chat public key ID
- `metaId`: MetaID
- `globalMetaId`: Global MetaID (supports multiple chains: MVC/BTC/DOGE)
- `name`: Username
- `namePinId`: Name PIN ID
- `chainName`: Chain name

### 5. Update Account

After successful registration and fetching user info, update the account with the username and globalMetaId:

```typescript
account.userName = username
if (userInfo && userInfo.globalMetaId) {
  account.globalMetaId = userInfo.globalMetaId
}
writeAccountFile(accountData)
```

## MetaID Node Structure

### Operation Types

- `init`: Initialize MetaID
- `create`: Create a new node
- `modify`: Modify an existing node
- `revoke`: Revoke a node

### Common Paths

- `/info/name`: Username node
- `/protocols/simplebuzz`: Buzz message node
- `/info/avatar`: Avatar node
- `/info/bio`: Bio node

### Content Types

- `text/plain`: Plain text
- `text/plain;utf-8`: UTF-8 encoded text
- `application/json`: JSON data
- `image/png`: PNG image
- `image/jpeg`: JPEG image

## PIN Creation Process

### MVC Chain

For MVC chain, the process involves:

1. Build OP_RETURN output with MetaID data
2. Add P2PKH outputs (1 satoshi to self, optional service fee)
3. Select UTXOs to cover fees
4. Sign transaction
5. Broadcast to network

### DOGE Chain

For DOGE chain, the process uses a commit-reveal scheme:

1. Build inscription script with MetaID data
2. Create commit transaction (P2SH output)
3. Create reveal transaction (unlock P2SH, send to reveal address)
4. Sign both transactions
5. Broadcast commit transaction first, then reveal transaction

The DOGE implementation uses the `DogeInscribe` class which handles:
- Inscription script building
- P2SH lock script creation
- Commit and reveal transaction construction
- Fee calculation (DOGE uses satoshis/KB fee rate)

### Transaction Structure

**MVC Chain:**
```
Inputs:
  - UTXOs from wallet address

Outputs:
  - 1 satoshi to self (required)
  - OP_RETURN with MetaID data
  - Service fee (optional)
  - Change output (if needed)
```

**DOGE Chain:**
```
Commit Transaction:
  Inputs:
    - P2PKH UTXOs from wallet
  Outputs:
    - P2SH output (contains inscription)
    - Change output (if needed)

Reveal Transaction:
  Inputs:
    - P2SH output from commit transaction
    - Additional P2PKH UTXOs (for fees)
  Outputs:
    - P2PKH output to reveal address
    - Change output (if needed)
```

## Error Handling

Common errors during MetaID registration:

- **No UTXOs**: User needs to claim gas subsidy first
- **Insufficient balance**: Not enough funds to pay fees
- **Invalid username**: Username already taken or invalid format
- **Network error**: Failed to broadcast transaction

All errors are logged to `log/error.md` with context and stack traces.

## Generic `createPin` Usage

The metabot-basic skill exposes a generic `createPin` API that can be used to create or modify any MetaID protocol node as long as the payload conforms to the MetaID schema.

```typescript
import { createPin, CreatePinParams, MetaidData } from './metaid'

// Example: create a simpleBuzz PIN
const metaidData: MetaidData = {
  operation: 'create',
  path: '/protocols/simplebuzz',
  body: JSON.stringify({
    content: 'This is a Buzz. It supports arbitrary length.',
    contentType: 'text/plain;utf-8',
    attachments: [],
    quotePin: ''
  }),
  contentType: 'application/json',
}

const params: CreatePinParams = {
  chain: 'mvc',
  dataList: [
    {
      metaidData,
    },
  ],
  feeRate: 1,
}

const result = await createPin(params, mnemonic, { addressIndex: 0 })
// 返回: { txids?: string[], totalCost: number, ... }
```

### Modify Existing PINs

To modify an existing PIN, set `operation: 'modify'` and use the `@<pinId>/protocols/...` format in `path`:

```typescript
const modifyPinId = '4b951b446af5ce5ba4c5ca93149440f1197b005dd7ca3e288641b9b51390b610i0'

const metaidDataForModify: MetaidData = {
  operation: 'modify',
  path: `@${modifyPinId}/protocols/simplebuzz`,
  body: JSON.stringify({
    content: 'Updated buzz content',
    contentType: 'text/plain;utf-8',
    attachments: [],
    quotePin: ''
  }),
  contentType: 'application/json',
}

const modifyParams: CreatePinParams = {
  chain: 'mvc',
  dataList: [
    {
      metaidData: metaidDataForModify,
    },
  ],
  feeRate: 1,
}

const modifyResult = await createPin(modifyParams, mnemonic, { addressIndex: 0 })
```

**Important rules（重要规则）**:

- All `metaidData.path` values are normalized to **lowercase** before being written on-chain. If the caller passes uppercase letters, they will be converted automatically.
- When `operation: 'modify'`, the system **requires** the target `pinId` to be specified in `path` in the form `@<pinId>/protocols/{protocolName}`; otherwise, an error will be thrown:
  - `operation "modify" requires target pinId in path, e.g. "@<pinId>/protocols/simplenote"（需要在 path 中传入要修改的 pinId）`

If the current skill flow has not internally defined a protocol, users should provide a complete `metaidData` payload that follows MetaID protocol conventions, and the agent will send it on-chain via `createPin`.

## Common Protocol Examples

These examples show how to construct `metaidData` for several commonly used protocols.

### PayLike (点赞)

```typescript
const payLikeMetaidData: MetaidData = {
  operation: 'create',
  path: '/protocols/paylike',
  body: JSON.stringify({
    isLike: "1",
    // likeTo: target pinId that you want to like
    likeTo: '9f995b4f978b768f4cff0977dd642da3d873283dd1895de8edd0dbd6066a1cc1i0',
  }),
  contentType: 'application/json',
}
```

### SimpleBuzz（发帖 / 发 Buzz）

```typescript
const buzzMetaidData: MetaidData = {
  operation: 'create',
  path: '/protocols/simplebuzz',
  body: JSON.stringify({
    content: 'This is a Buzz. It supports arbitrary length.',
    contentType: 'text/plain;utf-8',
    // Attachments can use metafile://{pinId} format; empty array if none
    attachments: ['metafile://{pinId_1}', 'metafile://{pinId_2}'],
    // quotePin: pinId of the buzz being replied to; empty string if not a reply
    quotePin: '9f995b4f978b768f4cff0977dd642da3d873283dd1895de8edd0dbd6066a1cc1i0',
  }),
  contentType: 'application/json',
}
```

### PayComment（评论）

```typescript
const payCommentMetaidData: MetaidData = {
  operation: 'create',
  path: '/protocols/paycomment',
  body: JSON.stringify({
    content: 'This is a comment on a specific PIN. It supports arbitrary length.',
    contentType: 'text/plain;utf-8',
    // commentTo: pinId of the PIN being commented on（必填）
    commentTo: '9f995b4f978b768f4cff0977dd642da3d873283dd1895de8edd0dbd6066a1cc1i0',
  }),
  contentType: 'application/json',
}
```

### SimpleDonate（打赏）

```typescript
const donateMetaidData: MetaidData = {
  operation: 'create',
  path: '/protocols/simpledonate',
  body: JSON.stringify({
    // createTime: timestamp in ms
    createTime: '1768284841944',
    // to: address to receive the donation
    to: '1PefP7Wo8koYDdWTKCNSKgaN2J9SrVGHW5',
    // coinType: space | btc | doge
    coinType: 'btc',
    // amount: donation amount
    amount: '0.01',
    // toPin: pinId returned by the transfer transaction (required)
    toPin: '9f995b4f978b768f4cff0977dd642da3d873283dd1895de8edd0dbd6066a1cc1i0',
    // message: donation message
    message: 'good job',
  }),
  contentType: 'application/json',
}
```

### Custom Protocol Example（自定义协议示例：SimpleNote）

If the protocol is not built into the current skill, the user can still provide a full MetaID payload and let the agent send it on-chain:

```typescript
const simpleNoteMetaidData: MetaidData = {
  operation: 'create', // 新建笔记
  path: '/protocols/simplenote',
  body: JSON.stringify({
    title: '今天天气',
    subtitle: '',
    coverImg: '',
    contentType: 'text/markdown',
    content: '今天的天气晴朗',
    encryption: '0',
    createTime: Date.now(),
    tags: [],
    attachments: [],
  }),
  contentType: 'application/json',
}
```

- When `operation: 'create'`, the node is created as a new PIN.
- When `operation: 'modify'`, the caller **must** specify the target PIN to modify:
  - `path` should be `@<pinId>/protocols/simplenote`, for example `@{targetPinId}/protocols/simplenote`.
  - If `operation: 'modify'` is used **without** providing a concrete `pinId` (either in `path` or via a correctly formatted `@<pinId>/...` prefix), the system will throw an error asking the user to provide `pinId`.

