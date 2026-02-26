#!/usr/bin/env node

/**
 * MVC transfer (Space/sats). When run from IDBots Cowork with metabot-basic skill,
 * session MetaBot wallet is injected via env (IDBOTS_TWIN_*). Otherwise falls back to account.json.
 * Usage:
 *   npx ts-node scripts/send_space.ts <agentName> <toAddress> <amount> <unit>
 *   unit: space | sats; --confirm to skip confirmation
 */

import * as readline from 'readline'
import Decimal from 'decimal.js'
import { sendSpace, toSats, SPACE_TO_SATS } from './transfer'
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
  const unit = (rest[3] ?? 'sats').toLowerCase() as 'space' | 'sats'

  if (!agentName || !toAddress || !amountStr) {
    console.error('❌ 用法: npx ts-node scripts/send_space.ts <agentName> <toAddress> <amount> [space|sats] [--confirm]')
    console.error('   例: npx ts-node scripts/send_space.ts "<agent_name>" "<to_address>" 0.001 space')
    process.exit(1)
  }

  if (unit !== 'space' && unit !== 'sats') {
    console.error('❌ unit 必须为 space 或 sats')
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

  const amountNum = parseFloat(amountStr)
  if (Number.isNaN(amountNum) || amountNum <= 0) {
    console.error('❌ amount 须为正数')
    process.exit(1)
  }

  const sats = toSats(amountStr, unit)
  const feeb = 1

  console.log('--- MVC 转账确认 ---')
  console.log('  发起账户:', displayName)
  console.log('  接收地址:', toAddress)
  if (unit === 'space') {
    console.log('  金额:', amountStr, 'Space (=', sats, 'sats)')
  } else {
    console.log('  金额:', sats, 'sats (=', new Decimal(sats).div(SPACE_TO_SATS).toString(), 'Space)')
  }
  console.log('  feeRate:', feeb, 'sat/byte')
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
    const { res, txids, broadcasted } = await sendSpace({
      tasks: [{ receivers: [{ address: toAddress, amount: String(sats) }] }],
      broadcast: true,
      feeb,
      options: { mnemonic, addressIndex },
    })
    console.log('✅ 转账成功')
    console.log('  TXID:', res[0].txid)
    if (broadcasted) console.log('  已广播')
  } catch (e: any) {
    console.error('❌ 转账失败:', e?.message || e)
    process.exit(1)
  }
}

main()
