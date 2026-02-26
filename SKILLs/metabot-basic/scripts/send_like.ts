#!/usr/bin/env node

/**
 * Like a pin (paylike protocol). When run from IDBots Cowork with metabot-basic skill,
 * session MetaBot wallet is injected via env (IDBOTS_TWIN_*). Otherwise falls back to account.json.
 * Usage: npx ts-node scripts/send_like.ts <agentName> <pinId>
 */

import { createPin } from './metaid'
import { parseAddressIndexFromPath } from './wallet'
import { readAccountFile, findAccountByKeyword } from './utils'

const DEFAULT_WALLET_PATH = "m/44'/10001'/0'/0/0"

async function main() {
  const args = process.argv.slice(2)
  const agentName = args[0]
  const pinId = args[1]?.trim()

  if (!agentName || !pinId) {
    console.error('❌ 请提供 Agent 名称和要点赞的 pinId')
    console.error('   Usage: npx ts-node scripts/send_like.ts "<agent_name>" <pinId>')
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

  console.log(`👍 使用 ${displayName} 点赞 pin: ${pinId}`)

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
      mnemonic,
      { addressIndex: parseAddressIndexFromPath(pathStr) }
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
