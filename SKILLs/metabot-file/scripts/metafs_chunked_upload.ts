#!/usr/bin/env node
/**
 * 大文件分块上链（仅 MVC）：OSS 分片上传 → estimate(storageKey) → 构建并签名 merge 交易（不广播）→ 签 chunk/index 预交易 → 提交 chunked-upload-task(storageKey)。
 * 运行: 在 metabot-file 目录下
 *   npx ts-node scripts/metafs_chunked_upload.ts --account-file ../../../account.json --file /path/to/large.png [--path /file] [--content-type "image/png"] [--fee-rate 1]
 */

import * as fs from 'fs'
import * as path from 'path'
import { mvc } from 'meta-contract'
import { readAccountFile, findAccountByKeyword } from '../../metabot-basic/scripts/utils'
import { fetchMVCUtxos } from '../../metabot-basic/scripts/api'
import { signTransaction } from '../../metabot-basic/scripts/wallet'

const API_BASE = 'https://file.metaid.io/metafile-uploader'
const MULTIPART_CHUNK_SIZE = 1 * 1024 * 1024 // 1MB, 与 Web 一致
const SIGHASH_SIGNNULL = 0x2 | 0x40 // SIGHASH_NONE | SIGHASH_ANYONECANPAY
const PRE_TX_BASE = 200
const PRE_TX_INPUT = 150
const MERGE_TX_BASE = 200
const MERGE_TX_INPUT = 150
const MERGE_TX_OUTPUT = 34
const AMOUNT_TOLERANCE = 1000

function parseArgs(): {
  accountFile?: string
  keyword?: string
  accountIndex?: number
  filePath: string
  metaPath: string
  contentType: string
  feeRate: number
} {
  const args = process.argv.slice(2)
  let filePath = ''
  let metaPath = '/file'
  let contentType = 'application/octet-stream'
  let feeRate = 1
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
    } else if (args[i] === '--fee-rate' && args[i + 1]) {
      feeRate = parseInt(args[++i], 10) || 1
    }
  }
  return { ...out, filePath, metaPath, contentType, feeRate }
}

function getAccount(
  accountFile?: string,
  keyword?: string,
  accountIndex?: number
): { account: any; accountIndex: number } {
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

async function ossMultipartUpload(
  filePath: string,
  fileName: string,
  fileSize: number,
  metaId: string,
  address: string
): Promise<string> {
  const initRes = await fetch(`${API_BASE}/api/v1/files/multipart/initiate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fileName, fileSize, metaId, address }),
  })
  if (!initRes.ok) throw new Error(`initiate failed: HTTP ${initRes.status}`)
  const initData = await initRes.json()
  if (initData.code !== 0) throw new Error(initData.message || 'initiate failed')
  const { uploadId, key } = initData.data

  const totalParts = Math.ceil(fileSize / MULTIPART_CHUNK_SIZE)
  const parts: { partNumber: number; etag: string; size: number }[] = []
  const fd = fs.openSync(filePath, 'r')
  const buf = Buffer.alloc(MULTIPART_CHUNK_SIZE)
  let offset = 0

  for (let partNumber = 1; partNumber <= totalParts; partNumber++) {
    const toRead = Math.min(MULTIPART_CHUNK_SIZE, fileSize - offset)
    const bytesRead = fs.readSync(fd, buf, 0, toRead, offset)
    const content = buf.slice(0, bytesRead).toString('base64')
    const partRes = await fetch(`${API_BASE}/api/v1/files/multipart/upload-part`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uploadId, key, partNumber, content }),
    })
    if (!partRes.ok) throw new Error(`upload-part ${partNumber} failed: HTTP ${partRes.status}`)
    const partData = await partRes.json()
    if (partData.code !== 0) throw new Error(partData.message || `upload-part ${partNumber} failed`)
    parts.push({ partNumber, etag: partData.data.etag, size: bytesRead })
    offset += bytesRead
  }
  fs.closeSync(fd)

  const completeRes = await fetch(`${API_BASE}/api/v1/files/multipart/complete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ uploadId, key, parts }),
  })
  if (!completeRes.ok) throw new Error(`complete failed: HTTP ${completeRes.status}`)
  const completeData = await completeRes.json()
  if (completeData.code !== 0) throw new Error(completeData.message || 'complete failed')
  return completeData.data.key
}

async function estimateChunked(storageKey: string, fileName: string, path: string, contentType: string, feeRate: number) {
  const res = await fetch(`${API_BASE}/api/v1/files/estimate-chunked-upload`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      fileName,
      path,
      contentType: contentType.includes(';binary') ? contentType : contentType + ';binary',
      chain: 'mvc',
      feeRate,
      storageKey,
    }),
  })
  if (!res.ok) throw new Error(`estimate failed: HTTP ${res.status}`)
  const data = await res.json()
  if (data.code !== 0) throw new Error(data.message || 'estimate failed')
  return data.data
}

function buildMergeTxAndSign(
  address: string,
  utxos: { txid: string; outIndex: number; value: number }[],
  chunkPreTxOutputAmount: number,
  indexPreTxOutputAmount: number,
  mergeTxFee: number,
  feeRate: number,
  accountIndex: number
): Promise<string> {
  const totalOut = chunkPreTxOutputAmount + indexPreTxOutputAmount + mergeTxFee
  let totalIn = 0
  const selected: typeof utxos = []
  for (const u of utxos.sort((a, b) => (b.value || 0) - (a.value || 0))) {
    selected.push(u)
    totalIn += u.value || 0
    if (totalIn >= totalOut) break
  }
  if (totalIn < totalOut) throw new Error(`insufficient balance: need ${totalOut} satoshis, have ${totalIn}`)

  const scriptHex = mvc.Script.buildPublicKeyHashOut(address).toHex()
  const tx = new mvc.Transaction()
  tx.version = 10
  for (const u of selected) {
    tx.from({
      txId: u.txid,
      outputIndex: u.outIndex,
      script: scriptHex,
      satoshis: u.value,
    } as any)
  }
  tx.to(address, chunkPreTxOutputAmount)
  tx.to(address, indexPreTxOutputAmount)
  const change = totalIn - chunkPreTxOutputAmount - indexPreTxOutputAmount - mergeTxFee
  if (change > 600) tx.to(address, change)

  return signMergeTx(tx, selected, scriptHex, accountIndex)
}

async function signMergeTx(
  tx: any,
  utxos: { value: number }[],
  scriptHex: string,
  accountIndex: number
): Promise<string> {
  const sigtype = mvc.crypto.Signature.SIGHASH_ALL | mvc.crypto.Signature.SIGHASH_FORKID
  for (let i = 0; i < utxos.length; i++) {
    const res = await signTransaction(
      {
        transaction: {
          txHex: tx.toString(),
          scriptHex,
          inputIndex: i,
          satoshis: utxos[i].value,
          sigtype,
        },
      },
      true,
      { accountIndex }
    )
    const signedTxHex = 'txHex' in res ? res.txHex : (res as any).txHex
    const signedTx = new mvc.Transaction(signedTxHex)
    tx.inputs[i].setScript(signedTx.inputs[i].script)
  }
  return tx.toString()
}

function parseMergeOutputs(
  signedMergeTxHex: string,
  address: string,
  chunkPreTxOutputAmount: number,
  indexPreTxOutputAmount: number
): { mergeTxId: string; chunkPreTxOutputIndex: number; indexPreTxOutputIndex: number; chunkScript: string; indexScript: string } {
  const tx = new mvc.Transaction(signedMergeTxHex)
  const mergeTxId = tx.id
  let chunkPreTxOutputIndex = -1
  let indexPreTxOutputIndex = -1
  let chunkScript = ''
  let indexScript = ''
  const network = 'livenet' as string
  for (let i = 0; i < tx.outputs.length; i++) {
    const out = tx.outputs[i]
    try {
      const addr = out.script?.toAddress?.(network as any)
      if (addr && addr.toString() === address) {
        const amt = out.satoshis
        if (chunkPreTxOutputIndex === -1 && Math.abs(amt - chunkPreTxOutputAmount) <= AMOUNT_TOLERANCE) {
          chunkPreTxOutputIndex = i
          chunkScript = out.script.toHex()
        } else if (indexPreTxOutputIndex === -1 && Math.abs(amt - indexPreTxOutputAmount) <= AMOUNT_TOLERANCE) {
          indexPreTxOutputIndex = i
          indexScript = out.script.toHex()
        }
      }
    } catch (_) {}
  }
  if (chunkPreTxOutputIndex === -1 || indexPreTxOutputIndex === -1) {
    const toSelf: { index: number; script: string; satoshis: number }[] = []
    for (let i = 0; i < tx.outputs.length; i++) {
      try {
        const addr = tx.outputs[i].script?.toAddress?.(network as any)
        if (addr && addr.toString() === address)
          toSelf.push({ index: i, script: tx.outputs[i].script.toHex(), satoshis: tx.outputs[i].satoshis })
      } catch (_) {}
    }
    if (toSelf.length >= 2) {
      chunkPreTxOutputIndex = toSelf[0].index
      chunkScript = toSelf[0].script
      indexPreTxOutputIndex = toSelf[1].index
      indexScript = toSelf[1].script
    } else throw new Error('merge tx does not have two outputs to our address')
  }
  return { mergeTxId, chunkPreTxOutputIndex, indexPreTxOutputIndex, chunkScript, indexScript }
}

async function buildPreTxAndSign(
  mergeTxId: string,
  outputIndex: number,
  scriptHex: string,
  satoshis: number,
  accountIndex: number
): Promise<string> {
  const tx = new mvc.Transaction()
  tx.version = 10
  tx.from({
    txId: mergeTxId,
    outputIndex,
    script: scriptHex,
    satoshis,
  } as any)
  const res = await signTransaction(
    {
      transaction: {
        txHex: tx.toString(),
        scriptHex,
        inputIndex: 0,
        satoshis,
        sigtype: SIGHASH_SIGNNULL,
      },
    },
    true,
    { accountIndex }
  )
  const signedTxHex = 'txHex' in res ? res.txHex : (res as any).txHex
  const signedTx = new mvc.Transaction(signedTxHex)
  tx.inputs[0].setScript(signedTx.inputs[0].script)
  return tx.toString()
}

async function createChunkedUploadTask(params: {
  metaId: string
  address: string
  fileName: string
  path: string
  contentType: string
  storageKey: string
  chunkPreTxHex: string
  indexPreTxHex: string
  mergeTxHex: string
  feeRate: number
}) {
  const res = await fetch(`${API_BASE}/api/v1/files/chunked-upload-task`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      metaId: params.metaId,
      address: params.address,
      fileName: params.fileName,
      path: params.path,
      operation: 'create',
      contentType: params.contentType.includes(';binary') ? params.contentType : params.contentType + ';binary',
      chain: 'mvc',
      feeRate: params.feeRate,
      chunkPreTxHex: params.chunkPreTxHex,
      indexPreTxHex: params.indexPreTxHex,
      mergeTxHex: params.mergeTxHex,
      storageKey: params.storageKey,
    }),
  })
  if (!res.ok) throw new Error(`chunked-upload-task failed: HTTP ${res.status}`)
  const data = await res.json()
  if (data.code !== 0) throw new Error(data.message || 'chunked-upload-task failed')
  return data.data
}

async function main(): Promise<void> {
  const { accountFile, keyword, accountIndex, filePath, metaPath, contentType, feeRate } = parseArgs()
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
  const fileName = path.basename(filePath)
  const fileSize = fs.statSync(filePath).size

  const storageKey = await ossMultipartUpload(filePath, fileName, fileSize, metaId, address)
  const estimate = await estimateChunked(storageKey, fileName, metaPath, contentType, feeRate)

  const chunkPreTxBuildFee = Math.ceil((PRE_TX_BASE + PRE_TX_INPUT) * feeRate)
  const indexPreTxBuildFee = Math.ceil((PRE_TX_BASE + PRE_TX_INPUT) * feeRate)
  const chunkPreTxOutputAmount = Number(estimate.chunkPreTxFee) + chunkPreTxBuildFee
  const indexPreTxOutputAmount = Number(estimate.indexPreTxFee) + indexPreTxBuildFee
  const mergeTxSize = MERGE_TX_BASE + MERGE_TX_INPUT * 2 + MERGE_TX_OUTPUT * 2
  const mergeTxFee = Math.ceil(mergeTxSize * feeRate)
  const totalRequired = chunkPreTxOutputAmount + indexPreTxOutputAmount + mergeTxFee

  const utxos = await fetchMVCUtxos(address)
  const signedMergeTxHex = await buildMergeTxAndSign(
    address,
    utxos,
    chunkPreTxOutputAmount,
    indexPreTxOutputAmount,
    mergeTxFee,
    feeRate,
    resolvedAccountIndex
  )

  const { mergeTxId, chunkPreTxOutputIndex, indexPreTxOutputIndex, chunkScript, indexScript } = parseMergeOutputs(
    signedMergeTxHex,
    address,
    chunkPreTxOutputAmount,
    indexPreTxOutputAmount
  )

  const chunkPreTxHex = await buildPreTxAndSign(
    mergeTxId,
    chunkPreTxOutputIndex,
    chunkScript,
    chunkPreTxOutputAmount,
    resolvedAccountIndex
  )
  const indexPreTxHex = await buildPreTxAndSign(
    mergeTxId,
    indexPreTxOutputIndex,
    indexScript,
    indexPreTxOutputAmount,
    resolvedAccountIndex
  )

  const taskData = await createChunkedUploadTask({
    metaId,
    address,
    fileName,
    path: metaPath,
    contentType,
    storageKey,
    chunkPreTxHex,
    indexPreTxHex,
    mergeTxHex: signedMergeTxHex,
    feeRate,
  })

  console.log(
    JSON.stringify({
      taskId: taskData.taskId,
      status: taskData.status,
      message: taskData.message,
    })
  )
}

main().catch((e) => {
  console.error(JSON.stringify({ error: e?.message || String(e) }))
  process.exit(1)
})
