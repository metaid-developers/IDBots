#!/usr/bin/env node
/**
 * 输出当前账户信息（供 metabot-file 一键脚本使用）
 * 支持 --keyword 或 --account-index，输出 JSON: mvcAddress, userName, path, addressIndex, metaId
 *
 * 运行: 在 metabot-file 目录下
 *   npx ts-node scripts/metafs_account_info.ts [--keyword "<agent_name>"] [--account-index 0] [--account-file /path/to/account.json]
 */

import * as fs from 'fs'
import * as crypto from 'crypto'
import * as path from 'path'
import { readAccountFile, findAccountByKeyword } from '../../metabot-basic/scripts/utils'

function parseAddressIndexFromPath(pathStr: string): number {
  if (!pathStr || typeof pathStr !== 'string') return 0
  const m = pathStr.match(/\/0\/(\d+)$/)
  return m ? parseInt(m[1], 10) : 0
}

function parseArgs(): { keyword?: string; accountIndex?: number; accountFile?: string } {
  const args = process.argv.slice(2)
  const out: { keyword?: string; accountIndex?: number; accountFile?: string } = {}
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--keyword' && args[i + 1]) {
      out.keyword = args[++i]
    } else if (args[i] === '--account-index' && args[i + 1]) {
      out.accountIndex = parseInt(args[++i], 10)
    } else if (args[i] === '--account-file' && args[i + 1]) {
      out.accountFile = args[++i]
    }
  }
  return out
}

function computeMetaId(address: string): string {
  return crypto.createHash('sha256').update(address, 'utf8').digest('hex')
}

function main(): void {
  const { keyword, accountIndex, accountFile } = parseArgs()

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

  const pathStr = account.path || "m/44'/10001'/0'/0/0"
  const addressIndex = parseAddressIndexFromPath(pathStr)
  const metaId = computeMetaId(address)

  console.log(JSON.stringify({ mvcAddress: address, userName: account.userName || '', path: pathStr, addressIndex, metaId }))
}

main()
