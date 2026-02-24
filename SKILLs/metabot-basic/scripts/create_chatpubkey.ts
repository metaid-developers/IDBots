#!/usr/bin/env node

/**
 * 为指定 Agent 创建 chatpubkey 节点
 * Usage: npx ts-node scripts/create_chatpubkey.ts <userName|mvcAddress|metaid>
 */

import { readAccountFile, writeAccountFile, findAccountByKeyword } from './utils'
import { getUserInfoByAddressByMs } from './api'
import { createPin, CreatePinParams } from './metaid'
import { getEcdhPublickey } from './chatpubkey'
import { parseAddressIndexFromPath } from './wallet'

async function main() {
  const keyword = process.argv.slice(2).join(' ').trim()
  if (!keyword) {
    console.error('Usage: npx ts-node scripts/create_chatpubkey.ts <userName|mvcAddress|metaid>')
    process.exit(1)
  }

  const accountData = readAccountFile()
  const account = findAccountByKeyword(keyword, accountData)
  if (!account) {
    console.error(`❌ 未找到账户: ${keyword}`)
    process.exit(1)
  }

  const userInfo = await getUserInfoByAddressByMs(account.mvcAddress)
  if (userInfo?.chatPublicKey) {
    console.log(`ℹ️  ${account.userName || account.mvcAddress} 已有 chatPublicKey，无需创建`)
    process.exit(0)
  }

  if (account.chatPublicKey) {
    console.log(`ℹ️  ${account.userName || account.mvcAddress} 已有 chatPublicKey（本地），无需创建`)
    process.exit(0)
  }

  const ecdh = await getEcdhPublickey(account.mnemonic, undefined, {
    addressIndex: parseAddressIndexFromPath(account.path),
  })
  if (!ecdh?.ecdhPubKey) {
    console.error('❌ 生成 ECDH 公钥失败')
    process.exit(1)
  }

  console.log('🔑 创建 chatpubkey 节点...')
  const chatPubkeyPinParams: CreatePinParams = {
    chain: 'mvc',
    dataList: [
      {
        metaidData: {
          operation: 'create',
          path: '/info/chatpubkey',
          body: ecdh.ecdhPubKey,
          encoding: 'utf-8',
          contentType: 'text/plain',
        },
      },
    ],
    feeRate: 1,
  }

  const chatPubkeyPinRes = await createPin(chatPubkeyPinParams, account.mnemonic, {
    addressIndex: parseAddressIndexFromPath(account.path),
  })
  if (chatPubkeyPinRes.txids && chatPubkeyPinRes.txids.length > 0) {
    const chatPublicKeyPinId = chatPubkeyPinRes.txids[0] + 'i0'
    const accData = readAccountFile()
    const accIdx = accData.accountList.findIndex((a) => a.mvcAddress === account.mvcAddress)
    if (accIdx !== -1) {
      accData.accountList[accIdx].chatPublicKey = ecdh.ecdhPubKey
      accData.accountList[accIdx].chatPublicKeyPinId = chatPublicKeyPinId
      writeAccountFile(accData)
      console.log(`✅ chatpubkey 创建成功!`)
      console.log(`   chatPublicKeyPinId: ${chatPublicKeyPinId}`)
    }
  } else {
    console.error('❌ 创建 chatpubkey 交易失败')
    process.exit(1)
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
