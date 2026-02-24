#!/usr/bin/env node

/**
 * 同步指定 Agent 的 metaid 信息到 account.json 和 userInfo.json
 * Usage: npx ts-node scripts/sync_agent_metaid.ts <userName|mvcAddress|metaid>
 */

import { getUserInfoByAddressByMs } from './api'
import {
  readAccountFile,
  writeAccountFile,
  readUserInfoFile,
  writeUserInfoFile,
  findAccountByKeyword,
} from './utils'

async function main() {
  const keyword = process.argv.slice(2).join(' ').trim()
  if (!keyword) {
    console.error(
      'Usage: npx ts-node scripts/sync_agent_metaid.ts <userName|mvcAddress|metaid>'
    )
    process.exit(1)
  }

  const accountData = readAccountFile()
  const account = findAccountByKeyword(keyword, accountData)
  if (!account) {
    console.error(`❌ 未找到账户: ${keyword}`)
    process.exit(1)
  }

  console.log(`📋 获取 ${account.userName || account.mvcAddress} 的用户信息...`)
  const userInfo = await getUserInfoByAddressByMs(account.mvcAddress)

  if (!userInfo) {
    console.error('❌ 无法获取用户信息')
    process.exit(1)
  }

  const accIdx = accountData.accountList.findIndex(
    (a) => a.mvcAddress === account.mvcAddress
  )
  if (accIdx === -1) {
    console.error('❌ 账户不在 accountList 中')
    process.exit(1)
  }

  let updated = false
  if (userInfo.metaId) {
    accountData.accountList[accIdx].metaid = userInfo.metaId
    updated = true
    console.log(`   metaid: ${userInfo.metaId}`)
  }
  if (userInfo.globalMetaId) {
    accountData.accountList[accIdx].globalMetaId = userInfo.globalMetaId
    updated = true
    console.log(`   globalMetaId: ${userInfo.globalMetaId}`)
  }

  if (updated) {
    writeAccountFile(accountData)
  }

  // 同步到 userInfo.json
  const userInfoData = readUserInfoFile()
  const userIdx = userInfoData.userList.findIndex(
    (u) => u.address === account.mvcAddress
  )
  if (userIdx !== -1) {
    if (userInfo.metaId) {
      userInfoData.userList[userIdx].metaid = userInfo.metaId
    }
    if (userInfo.globalMetaId) {
      userInfoData.userList[userIdx].globalmetaid = userInfo.globalMetaId
    }
    writeUserInfoFile(userInfoData)
  }

  if (updated) {
    console.log(`✅ metaid 信息已同步到 account.json`)
  } else {
    console.log(`ℹ️  未获取到新的 metaid 信息`)
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
