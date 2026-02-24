#!/usr/bin/env node

/**
 * 使用指定 Agent 对目标 pin 点赞（paylike 协议）
 * Usage: npx ts-node scripts/send_like.ts <agentName> <pinId>
 */

import { createPin } from './metaid'
import { parseAddressIndexFromPath } from './wallet'
import { readAccountFile, findAccountByKeyword } from './utils'

async function main() {
  const args = process.argv.slice(2)
  const agentName = args[0]
  const pinId = args[1]?.trim()

  if (!agentName || !pinId) {
    console.error('❌ 请提供 Agent 名称和要点赞的 pinId')
    console.error('   Usage: npx ts-node scripts/send_like.ts "<agent_name>" <pinId>')
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

  console.log(`👍 使用 ${agentName} 点赞 pin: ${pinId}`)

  try {
    const result = await createPin(
      {
        chain: 'mvc',
        dataList: [
          {
            metaidData: {
              operation: 'create',
              path: '/protocols/paylike',
              body: JSON.stringify({
                isLike: '1',
                likeTo: pinId,
              }),
              contentType: 'application/json',
            },
          },
        ],
        feeRate: 1,
      },
      account.mnemonic,
      { addressIndex: parseAddressIndexFromPath(account.path) }
    )
    if (result.txids?.length) {
      console.log(`✅ 点赞成功!`)
      console.log(`   TXID: ${result.txids[0]}`)
      console.log(`   消耗: ${result.totalCost} satoshis`)
    } else {
      throw new Error('No txids returned')
    }
  } catch (error: any) {
    console.error(`❌ 点赞失败: ${error?.message || error}`)
    process.exit(1)
  }
}

main()
