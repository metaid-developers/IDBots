#!/usr/bin/env node

/**
 * Send Buzz to MVC network.
 * When run from IDBots Cowork with metabot-basic skill, session MetaBot wallet is injected via env (IDBOTS_TWIN_*).
 * Otherwise falls back to account.json by agent name for standalone CLI use.
 *
 * Usage:
 *   npx ts-node scripts/send_buzz.ts <agentName> <content>
 *   npx ts-node scripts/send_buzz.ts <agentName> @<filepath>   # read content from file
 */

import * as fs from 'fs'
import * as path from 'path'
import { createBuzz } from './buzz'
import { parseAddressIndexFromPath } from './wallet'
import { readAccountFile, findAccountByKeyword } from './utils'

const DEFAULT_WALLET_PATH = "m/44'/10001'/0'/0/0"

async function main() {
  const args = process.argv.slice(2)
  const agentName = args[0]
  if (!agentName) {
    console.error('❌ 请提供 Agent 名称和 Buzz 内容')
    console.error('   Usage: npx ts-node scripts/send_buzz.ts "<agent_name>" "内容"')
    console.error('   或:    npx ts-node scripts/send_buzz.ts "<agent_name>" @./content.txt')
    process.exit(1)
  }

  let content: string
  if (args[1]?.startsWith('@')) {
    const filePath = args[1].slice(1)
    const fullPath = path.isAbsolute(filePath) ? filePath : path.join(process.cwd(), filePath)
    if (!fs.existsSync(fullPath)) {
      console.error(`❌ 文件不存在: ${fullPath}`)
      process.exit(1)
    }
    content = fs.readFileSync(fullPath, 'utf-8')
  } else {
    content = args.slice(1).join(' ').trim()
  }

  if (!content) {
    console.error('❌ 请提供 Buzz 内容')
    console.error('   Usage: npx ts-node scripts/send_buzz.ts "<agent_name>" "内容"')
    console.error('   或:    npx ts-node scripts/send_buzz.ts "<agent_name>" @./content.txt')
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
    try {
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
    } catch {
      console.error('❌ 未找到钱包数据。在 IDBots 中请启用 metabot-basic 技能后使用；或配置 account.json')
      process.exit(1)
    }
  }

  const addressIndex = parseAddressIndexFromPath(pathStr)

  console.log(`📢 使用 ${displayName} 发送 Buzz 到 MVC 网络...`)
  console.log(`   内容长度: ${content.length} 字符`)

  try {
    const result = await createBuzz(mnemonic, content, 1, { addressIndex })
    if (result.txids?.length) {
      console.log(`✅ Buzz 发送成功!`)
      console.log(`   TXID: ${result.txids[0]}`)
      console.log(`   消耗: ${result.totalCost} satoshis`)
    } else {
      throw new Error('No txids returned')
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`❌ 发送失败: ${message}`)
    process.exit(1)
  }
}

main()
