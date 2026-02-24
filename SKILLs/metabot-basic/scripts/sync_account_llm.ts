#!/usr/bin/env node

/**
 * 为 account.json 中缺少 llm 的账户同步 llm[0]（来自 .env）
 * Usage: npx ts-node scripts/sync_account_llm.ts
 */

import { readAccountFile, writeAccountFile } from './utils'
import { getLLMConfigFromEnv } from './env-config'

async function main() {
  const llmFromEnv = getLLMConfigFromEnv()
  const data = readAccountFile()
  let updated = false

  const defaultLlm = {
    provider: llmFromEnv.provider,
    apiKey: llmFromEnv.apiKey,
    baseUrl: llmFromEnv.baseUrl,
    model: llmFromEnv.model,
    temperature: llmFromEnv.temperature,
    maxTokens: llmFromEnv.maxTokens,
  }

  for (const acc of data.accountList) {
    const arr = acc.llm
    const needSync =
      !arr ||
      !Array.isArray(arr) ||
      arr.length === 0 ||
      (arr[0] && !arr[0].provider && !arr[0].model && !arr[0].apiKey)

    if (needSync) {
      if (!acc.llm || !Array.isArray(acc.llm)) {
        ;(acc as any).llm = []
      }
      ;(acc as any).llm[0] = { ...defaultLlm }
      updated = true
      console.log(`   ✅ 已同步 llm[0] → ${acc.userName || acc.mvcAddress}`)
    }
  }

  if (updated) {
    writeAccountFile(data)
    console.log('\n✅ account.json 已更新')
  } else {
    console.log('ℹ️  所有账户已有 llm 配置，无需更新')
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
