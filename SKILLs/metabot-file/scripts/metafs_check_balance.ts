#!/usr/bin/env node
/**
 * 使用 getMvcBalance/fetchMVCUtxos 检查余额并估算上传费用
 * 输出 JSON 与 upload_with_balance_check.sh 解析格式兼容。
 *
 * 运行: 在 metabot-file 目录下
 *   npx ts-node scripts/metafs_check_balance.ts [--keyword "<agent_name>"] [--account-index 0] [--account-file path] [--file-size-mb 1.5] --json
 */

import * as fs from 'fs'
import * as path from 'path'
import { readAccountFile, findAccountByKeyword } from '../../metabot-basic/scripts/utils'
import { getMvcBalance, fetchMVCUtxos } from '../../metabot-basic/scripts/api'
import { getNet } from '../../metabot-basic/scripts/wallet'

const BASE_FEE_SATOSHIS = 1000
const FEE_RATE_DEFAULT = 1
const BYTES_PER_MB = 1024 * 1024

function parseArgs(): {
  keyword?: string
  accountIndex?: number
  accountFile?: string
  fileSizeMb?: number
  json: boolean
} {
  const args = process.argv.slice(2)
  const out: { keyword?: string; accountIndex?: number; accountFile?: string; fileSizeMb?: number; json: boolean } = { json: false }
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--keyword' && args[i + 1]) out.keyword = args[++i]
    else if (args[i] === '--account-index' && args[i + 1]) out.accountIndex = parseInt(args[++i], 10)
    else if (args[i] === '--account-file' && args[i + 1]) out.accountFile = args[++i]
    else if (args[i] === '--file-size-mb' && args[i + 1]) out.fileSizeMb = parseFloat(args[++i])
    else if (args[i] === '--json') out.json = true
  }
  return out
}

function formatBalance(satoshis: number): string {
  const mvc = satoshis / 100_000_000
  return `${satoshis.toLocaleString()} satoshis (${mvc.toFixed(8)} MVC)`
}

function estimateUploadFee(fileSizeMb: number, feeRate: number = FEE_RATE_DEFAULT): number {
  const fileSizeBytes = Math.floor(fileSizeMb * BYTES_PER_MB)
  if (fileSizeMb <= 5) {
    return BASE_FEE_SATOSHIS + (250 + fileSizeBytes) * feeRate
  }
  const chunkSize = 64 * 1024
  const numChunks = Math.ceil(fileSizeBytes / chunkSize)
  const chunkFee = numChunks * (BASE_FEE_SATOSHIS + chunkSize * feeRate)
  const totalFee = chunkFee + (BASE_FEE_SATOSHIS + 500) + BASE_FEE_SATOSHIS + BASE_FEE_SATOSHIS
  return Math.floor(totalFee * 1.2)
}

async function main(): Promise<void> {
  const { keyword, accountIndex, accountFile, fileSizeMb, json } = parseArgs()

  let accountData: { accountList: any[] }
  if (accountFile) {
    const p = path.isAbsolute(accountFile) ? accountFile : path.join(process.cwd(), accountFile)
    if (!fs.existsSync(p)) {
      console.error(JSON.stringify({ error: `account file not found: ${p}` }))
      process.exit(1)
    }
    accountData = JSON.parse(fs.readFileSync(p, 'utf-8'))
  } else {
    accountData = readAccountFile()
  }

  if (!accountData.accountList || accountData.accountList.length === 0) {
    console.error(JSON.stringify({ error: 'accountList is empty' }))
    process.exit(1)
  }

  let account: any
  if (keyword != null && keyword.trim() !== '') {
    account = findAccountByKeyword(keyword.trim(), accountData as any)
    if (!account) {
      console.error(JSON.stringify({ error: `no account matched keyword: ${keyword}` }))
      process.exit(1)
    }
  } else {
    const idx = accountIndex ?? 0
    if (idx < 0 || idx >= accountData.accountList.length) {
      console.error(JSON.stringify({ error: `invalid account-index: ${idx}` }))
      process.exit(1)
    }
    account = accountData.accountList[idx]
  }

  const address = account.mvcAddress
  if (!address) {
    console.error(JSON.stringify({ error: 'account has no mvcAddress' }))
    process.exit(1)
  }

  const net = getNet()
  const network = net === 'livenet' ? 'mainnet' : 'testnet'

  if (!json) process.stderr.write(`🔍 正在查询地址余额: ${address}\n`)

  let balanceSatoshis: number
  let utxoCount: number
  try {
    balanceSatoshis = await getMvcBalance(address)
    const utxos = await fetchMVCUtxos(address)
    utxoCount = utxos.length
  } catch (e: any) {
    console.error(JSON.stringify({ error: e?.message || String(e) }))
    process.exit(1)
  }

  const info: any = {
    address,
    network,
    balance: {
      satoshis: balanceSatoshis,
      mvc: balanceSatoshis / 100_000_000,
      formatted: formatBalance(balanceSatoshis),
    },
    utxo_count: utxoCount,
    sufficient: balanceSatoshis > 0,
  }

  if (fileSizeMb != null && !isNaN(fileSizeMb)) {
    const estimatedFee = estimateUploadFee(fileSizeMb)
    info.upload_estimate = {
      file_size_mb: fileSizeMb,
      estimated_fee_satoshis: estimatedFee,
      estimated_fee_mvc: estimatedFee / 100_000_000,
      estimated_fee_formatted: formatBalance(estimatedFee),
      sufficient_balance: balanceSatoshis >= estimatedFee,
      remaining_after_upload: balanceSatoshis - estimatedFee,
    }
    if (!info.upload_estimate.sufficient_balance) {
      console.log(JSON.stringify(info))
      process.exit(1)
    }
  } else if (!info.sufficient) {
    console.log(JSON.stringify(info))
    process.exit(1)
  }

  console.log(JSON.stringify(info))
}

main()
