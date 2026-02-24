#!/usr/bin/env node

/**
 * MVC 转账（Space/sats）：使用指定 Agent 向地址转 SPACE，执行前人机确认。
 * Usage:
 *   npx ts-node scripts/send_space.ts <agentName> <toAddress> <amount> <unit>
 *   unit: space | sats  （space 会按 1 space = 10^8 sats 换算）
 * 可选: --confirm 跳过交互确认
 * 例: npx ts-node scripts/send_space.ts "<agent_name>" "<to_address>" 0.001 space
 *     npx ts-node scripts/send_space.ts "<agent_name>" "<to_address>" 100000 sats --confirm
 */

import * as readline from 'readline'
import Decimal from 'decimal.js'
import { sendSpace, toSats, SPACE_TO_SATS } from './transfer'
import { readAccountFile, findAccountByKeyword } from './utils'
import { parseAddressIndexFromPath } from './wallet'

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

  const accountData = readAccountFile()
  const account = findAccountByKeyword(agentName, accountData)
  if (!account) {
    console.error(`❌ 未找到账户: ${agentName}`)
    process.exit(1)
  }
  if (!account.mnemonic) {
    console.error(`❌ 账户 ${agentName} 无 mnemonic`)
    process.exit(1)
  }

  const amountNum = parseFloat(amountStr)
  if (Number.isNaN(amountNum) || amountNum <= 0) {
    console.error('❌ amount 须为正数')
    process.exit(1)
  }

  const sats = toSats(amountStr, unit)
  const feeb = 1

  console.log('--- MVC 转账确认 ---')
  console.log('  发起账户:', agentName)
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
    const accountIndex = accountData.accountList.indexOf(account)
    const { res, txids, broadcasted } = await sendSpace({
      tasks: [
        {
          receivers: [{ address: toAddress, amount: String(sats) }],
        },
      ],
      broadcast: true,
      feeb,
      options: {
        accountIndex: accountIndex >= 0 ? accountIndex : 0,
        addressIndex: parseAddressIndexFromPath(account.path),
      },
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
