#!/usr/bin/env node

/**
 * 查询指定 Agent 的 MVC（SPACE）余额
 * Usage: npx ts-node scripts/query_balance.ts <agentName>
 */

import Decimal from 'decimal.js'
import { getMvcBalance } from './api'
import { readAccountFile, findAccountByKeyword } from './utils'
import { SPACE_TO_SATS } from './transfer'

async function main() {
  const agentName = process.argv[2]?.trim()
  if (!agentName) {
    console.error('❌ 用法: npx ts-node scripts/query_balance.ts <agentName>')
    process.exit(1)
  }

  const accountData = readAccountFile()
  const account = findAccountByKeyword(agentName, accountData)
  if (!account) {
    console.error(`❌ 未找到账户: ${agentName}`)
    process.exit(1)
  }

  console.log(`📋 Agent: ${account.userName || agentName}`)
  console.log(`   MVC 地址: ${account.mvcAddress}`)
  console.log('   查询中...')

  try {
    const sats = await getMvcBalance(account.mvcAddress)
    const space = new Decimal(sats).div(SPACE_TO_SATS).toFixed(8)
    console.log('')
    console.log('💰 SPACE 余额')
    console.log(`   ${space} SPACE`)
    console.log(`   ${sats} satoshis`)
  } catch (error: any) {
    console.error(`❌ 查询失败: ${error?.message || error}`)
    process.exit(1)
  }
}

main()
