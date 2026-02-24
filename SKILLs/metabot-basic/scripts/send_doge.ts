#!/usr/bin/env node

/**
 * DOGE 转账：使用指定 Agent 向地址转 DOGE（最小 0.01 DOGE）。
 * Usage: npx ts-node scripts/send_doge.ts <agentName> <toAddress> <amountSatoshis> [--confirm]
 * 例: npx ts-node scripts/send_doge.ts "<agent_name>" "<to_address>" 1000000
 */

import * as readline from 'readline'
import { sendDoge, MIN_DOGE_TRANSFER_SATOSHIS } from './transfer'
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

  if (!agentName || !toAddress || !amountStr) {
    console.error('❌ 用法: npx ts-node scripts/send_doge.ts <agentName> <toAddress> <amountSatoshis> [--confirm]')
    console.error('   最小金额: 0.01 DOGE =', MIN_DOGE_TRANSFER_SATOSHIS, 'satoshis')
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

  const satoshis = parseInt(amountStr, 10)
  if (Number.isNaN(satoshis) || satoshis < MIN_DOGE_TRANSFER_SATOSHIS) {
    console.error('❌ amountSatoshis 须为不小于', MIN_DOGE_TRANSFER_SATOSHIS, '的整数 (0.01 DOGE)')
    process.exit(1)
  }

  console.log('--- DOGE 转账确认 ---')
  console.log('  发起账户:', agentName)
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
    const accountIndex = accountData.accountList.indexOf(account)
    const result = await sendDoge(
      {
        toAddress,
        satoshis,
      },
      {
        accountIndex: accountIndex >= 0 ? accountIndex : 0,
        addressIndex: parseAddressIndexFromPath(account.path),
      }
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
