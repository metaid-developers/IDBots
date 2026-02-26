#!/usr/bin/env node
/**
 * 小文件直接上链：构建并签名基础交易(SIGHASH_SINGLE|ANYONECANPAY)，再调用 DirectUpload API。
 * 运行: 在 metabot-file 目录下
 *   npx ts-node scripts/metafs_direct_upload.ts --account-file ../../../account.json --file /path/to/file.txt [--path /file] [--keyword "<agent_name>"]
 */

import * as fs from 'fs'
import * as path from 'path'
import { mvc } from 'meta-contract'
import { readAccountFile, findAccountByKeyword } from '../../metabot-basic/scripts/utils'
import { fetchMVCUtxos } from '../../metabot-basic/scripts/api'
import { signTransaction } from '../../metabot-basic/scripts/wallet'

const API_BASE = 'https://file.metaid.io/metafile-uploader'
const MIN_UTXO_SATOSHIS = 5000
const SIGHASH_SINGLE_ANYONECANPAY = 0x3 | 0x80 | 0x40

function parseArgs(): {
  accountFile?: string
  keyword?: string
  accountIndex?: number
  filePath: string
  metaPath: string
  contentType: string
} {
  const args = process.argv.slice(2)
  let filePath = ''
  let metaPath = '/file'
  let contentType = 'application/octet-stream'
  const out: { accountFile?: string; keyword?: string; accountIndex?: number } = {}
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--account-file' && args[i + 1]) {
      out.accountFile = args[++i]
    } else if (args[i] === '--keyword' && args[i + 1]) {
      out.keyword = args[++i]
    } else if (args[i] === '--account-index' && args[i + 1]) {
      out.accountIndex = parseInt(args[++i], 10)
    } else if (args[i] === '--file' && args[i + 1]) {
      filePath = args[++i]
    } else if (args[i] === '--path' && args[i + 1]) {
      metaPath = args[++i]
    } else if (args[i] === '--content-type' && args[i + 1]) {
      contentType = args[++i]
    }
  }
  return { ...out, filePath, metaPath, contentType }
}

function getAccountFromEnv(keyword: string): any {
  if (process.env.IDBOTS_TWIN_MNEMONIC && process.env.IDBOTS_TWIN_NAME &&
      process.env.IDBOTS_TWIN_NAME === keyword) {
    const mnemonic = process.env.IDBOTS_TWIN_MNEMONIC.trim()
    const pathStr = process.env.IDBOTS_TWIN_PATH || "m/44'/10001'/0'/0/0"
    const network = 'livenet'
    const mneObj = mvc.Mnemonic.fromString(mnemonic)
    const hdpk = mneObj.toHDPrivateKey('', network as any)
    const privateKey = hdpk.deriveChild(pathStr).privateKey
    const publicKey = privateKey.toPublicKey()
    const address = mvc.Address.fromPublicKey(publicKey, network).toString()
    return {
      mnemonic,
      path: pathStr,
      mvcAddress: address,
      btcAddress: address,
      userName: keyword,
      _fromEnv: true,
    }
  }
  return null
}

function getAccount(
  accountFile?: string,
  keyword?: string,
  accountIndex?: number
): { account: any; accountIndex: number } {
  // 首先尝试从环境变量获取
  if (keyword != null && keyword.trim() !== '') {
    const envAccount = getAccountFromEnv(keyword.trim())
    if (envAccount) {
      return { account: envAccount, accountIndex: 0 }
    }
  }

  let accountData: { accountList: any[] }
  if (accountFile) {
    const p = path.isAbsolute(accountFile) ? accountFile : path.join(process.cwd(), accountFile)
    if (!fs.existsSync(p)) throw new Error(`account file not found: ${p}`)
    accountData = JSON.parse(fs.readFileSync(p, 'utf-8'))
  } else {
    accountData = readAccountFile()
  }
  if (!accountData.accountList?.length) throw new Error('accountList is empty')
  if (keyword != null && keyword.trim() !== '') {
    const acc = findAccountByKeyword(keyword.trim(), accountData as any)
    if (!acc) throw new Error(`no account matched keyword: ${keyword}`)
    const idx = accountData.accountList.indexOf(acc)
    return { account: acc, accountIndex: idx >= 0 ? idx : 0 }
  }
  const idx = accountIndex ?? 0
  if (idx < 0 || idx >= accountData.accountList.length) throw new Error(`invalid account-index: ${idx}`)
  return { account: accountData.accountList[idx], accountIndex: idx }
}

function computeMetaId(address: string): string {
  const crypto = require('crypto')
  return crypto.createHash('sha256').update(address, 'utf8').digest('hex')
}

async function main(): Promise<void> {
  const { accountFile, keyword, accountIndex, filePath, metaPath, contentType } = parseArgs()
  if (!filePath || !fs.existsSync(filePath)) {
    console.error(JSON.stringify({ error: '--file path is required and must exist' }))
    process.exit(1)
  }

  const { account, accountIndex: resolvedAccountIndex } = getAccount(accountFile, keyword, accountIndex)
  const address = account.mvcAddress
  if (!address) {
    console.error(JSON.stringify({ error: 'account has no mvcAddress' }))
    process.exit(1)
  }
  const metaId = computeMetaId(address)
  const fileBuffer = fs.readFileSync(filePath)
  const fileName = path.basename(filePath)
  const contentLength = fileBuffer.length

  const utxos = await fetchMVCUtxos(address)
  const sorted = utxos.filter((u) => (u.value || 0) >= MIN_UTXO_SATOSHIS).sort((a, b) => (b.value || 0) - (a.value || 0))
  if (sorted.length === 0) {
    console.error(JSON.stringify({ error: 'no UTXO with sufficient balance', needAtLeast: MIN_UTXO_SATOSHIS }))
    process.exit(1)
  }
  const utxo = sorted[0]
  const totalInputAmount = utxo.value || 0

  const script = mvc.Script.buildPublicKeyHashOut(address)
  const scriptHex = script.toHex()

  const tx = new mvc.Transaction()
  tx.from({
    txId: utxo.txid,
    outputIndex: utxo.outIndex,
    script: scriptHex,
    satoshis: totalInputAmount,
  } as any)
  tx.to(address, 1)

  const txHex = tx.toString()
  let signedTxHex: string
  if (account._fromEnv) {
    // 直接使用环境变量中的助记词签名
    const mnemonic = account.mnemonic
    const pathStr = account.path
    const network = 'livenet'
    const sigtype = SIGHASH_SINGLE_ANYONECANPAY

    const mneObj = mvc.Mnemonic.fromString(mnemonic)
    const hdpk = mneObj.toHDPrivateKey('', network as any)
    const privateKey = hdpk.deriveChild(pathStr).privateKey
    const publicKey = privateKey.toPublicKey()

    const BN = mvc.crypto.BN
    const tx = new mvc.Transaction(txHex)
    const sighash = mvc.Transaction.Sighash.sighash(
      tx,
      sigtype,
      0,
      new mvc.Script(scriptHex),
      new BN(totalInputAmount)
    ).toString('hex')
    const sig = mvc.crypto.ECDSA.sign(Buffer.from(sighash, 'hex'), privateKey, 'little')

    const signedScript = mvc.Script.buildPublicKeyHashIn(publicKey, sig, sigtype)
    tx.inputs[0].setScript(signedScript)
    signedTxHex = tx.toString()
  } else {
    const res = await signTransaction(
      {
        transaction: {
          txHex,
          scriptHex,
          inputIndex: 0,
          satoshis: totalInputAmount,
          sigtype: SIGHASH_SINGLE_ANYONECANPAY,
        },
      },
      true,
      { accountIndex: resolvedAccountIndex }
    )
    signedTxHex = 'txHex' in res ? res.txHex : (res as any).txHex
  }

  const form = new FormData()
  form.append('file', new Blob([fileBuffer]), fileName)
  form.append('path', metaPath)
  form.append('preTxHex', signedTxHex)
  form.append('operation', 'create')
  form.append('contentType', contentType.includes(';binary') ? contentType : contentType + ';binary')
  form.append('metaId', metaId)
  form.append('address', address)
  form.append('changeAddress', address)
  form.append('feeRate', '1')
  form.append('totalInputAmount', String(totalInputAmount))

  const response = await fetch(`${API_BASE}/api/v1/files/direct-upload`, {
    method: 'POST',
    body: form,
  })
  const result = await response.json()
  if (result.code !== 0) {
    console.error(JSON.stringify({ error: result.message || 'direct-upload failed', code: result.code }))
    process.exit(1)
  }
  const pinId = result.data.pinId
  const indexerBase = 'https://file.metaid.io/metafile-indexer'
  console.log(
    JSON.stringify({
      txId: result.data.txId,
      pinId,
      status: result.data.status,
      fileSize: contentLength,
      contentUrl: `${indexerBase}/api/v1/files/content/${pinId}`,
      accelerateUrl: `${indexerBase}/api/v1/files/accelerate/content/${pinId}`,
    })
  )
}

main().catch((e) => {
  console.error(JSON.stringify({ error: e?.message || String(e) }))
  process.exit(1)
})
