#!/usr/bin/env node

/**
 * DOGE transfer: use specified Agent to send DOGE (min 0.01 DOGE).
 * When run from IDBots Cowork with metabot-basic skill, session MetaBot wallet is injected via env (IDBOTS_TWIN_*).
 * Otherwise falls back to account.json by agentName.
 * Usage: npx ts-node scripts/send_doge.ts <agentName> <toAddress> <amountSatoshis> [--confirm]
 */

import * as readline from 'readline'
import { sendDoge, MIN_DOGE_TRANSFER_SATOSHIS } from './transfer'
import { readAccountFile, findAccountByKeyword } from './utils'
import { parseAddressIndexFromPath } from './wallet'

const DEFAULT_WALLET_PATH = "m/44'/10001'/0'/0/0"

async function confirm(question: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close()
      resolve(/^y|yes|Y|YES|是$/i.test(answer?.trim() ?? ''))
    })
  })
}

async function main() {
  const args = process.argv.slice(2)
  const hasConfirmFlag = args.includes('--confirm')
  const rest = args.filter((a) => a !== '--confirm')

  const agentName = rest[0]
  const toAddress = rest[1]
  const amountStr = rest[2]

  if (!agentName || !toAddress || !amountStr) {
    console.error('❌ 用法: npx ts-node scripts/send_doge.ts <agentName> <toAddress> <amountSatoshis> [--confirm]')
    console.error('   最小金额: 0.01 DOGE =', MIN_DOGE_TRANSFER_SATOSHIS, 'satoshis')
    process.exit(1)
  }

  let mnemonic: string
  let pathStr: string
  let displayName: string

  if (process.env.IDBOTS_TWIN_MNEMONIC && process.env.IDBOTS_TWIN_NAME) {
    mnemonic = process.env.IDBOTS_TWIN_MNEMONIC.trim()
    pathStr = (process.env.IDBOTS_TWIN_PATH || DEFAULT_WALLET_PATH).trim()
    displayName = process.env.IDBOTS_TWIN_NAME
  } else {
    const accountData = readAccountFile()
    const account = findAccountByKeyword(agentName, accountData)
    if (!account) {
      console.error(`❌ 未找到账户: ${agentName}`)
      console.error('   在 IDBots 中请启用 metabot-basic 技能后使用；或确保 account.json 中存在该 Agent')
      process.exit(1)
    }
    if (!account.mnemonic) {
      console.error(`❌ 账户 ${agentName} 无 mnemonic`)
      process.exit(1)
    }
    mnemonic = account.mnemonic.trim()
    pathStr = (account.path || DEFAULT_WALLET_PATH).trim()
    displayName = agentName
  }

  const satoshis = parseInt(amountStr, 10)
  if (Number.isNaN(satoshis) || satoshis < MIN_DOGE_TRANSFER_SATOSHIS) {
    console.error('❌ amountSatoshis 须为不小于', MIN_DOGE_TRANSFER_SATOSHIS, '的整数 (0.01 DOGE)')
    process.exit(1)
  }

  console.log('--- DOGE 转账确认 ---')
  console.log('  发起账户:', displayName)
  console.log('  接收地址:', toAddress)
  console.log('  金额:', satoshis, 'satoshis (=', (satoshis / 1e8).toFixed(8), 'DOGE)')
  console.log('---')

  if (!hasConfirmFlag) {
    const ok = await confirm('确认转账? (y/N): ')
    if (!ok) {
      console.log('已取消')
      process.exit(0)
    }
  }

  try {
    const addressIndex = parseAddressIndexFromPath(pathStr)
    const result = await sendDoge(
      { toAddress, satoshis },
      { mnemonic, addressIndex }
    )
    if ('txId' in result) {
      console.log('✅ 转账成功')
      console.log('  TXID:', result.txId)
    } else {
      console.log('✅ 交易已构建 (未广播)')
      console.log('  txHex:', result.txHex.slice(0, 66) + '...')
    }
  } catch (e: any) {
    console.error('❌ 转账失败:', e?.message || e)
    process.exit(1)
  }
}

main()
