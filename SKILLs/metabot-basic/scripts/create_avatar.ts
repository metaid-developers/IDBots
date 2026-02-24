#!/usr/bin/env node

/**
 * 为指定 Agent 创建头像节点
 * 支持：用户拖入对话框的图片路径、static/avatar 下的文件名
 * Usage: npx ts-node scripts/create_avatar.ts <userName|mvcAddress|metaid> [图片路径或文件名] [--force]
 * 示例: npx ts-node scripts/create_avatar.ts "肥猪王" /Users/xxx/Downloads/avatar.png
 * 示例: npx ts-node scripts/create_avatar.ts "肥猪王" "images (2).jpeg"
 */

import * as path from 'path'
import {
  readAccountFile,
  writeAccountFile,
  findAccountByKeyword,
  getAvatarUrl,
} from './utils'
import { createPin, CreatePinParams } from './metaid'
import { parseAddressIndexFromPath } from './wallet'
import {
  hasAvatarFile,
  loadAvatarAsBase64,
  loadAvatarFromFilePath,
  isValidAvatarFilePath,
  AVATAR_SIZE_EXCEEDED_MSG,
} from './avatar'

async function main() {
  const args = process.argv.slice(2)
  const force = args.includes('--force') || args.includes('-f')
  const filtered = args.filter((a) => a !== '--force' && a !== '-f')
  const keyword = filtered[0]?.trim()
  const avatarInput = filtered[1]?.trim() // 可选：完整路径（用户拖入）或 static/avatar 下的文件名
  if (!keyword) {
    console.error(
      'Usage: npx ts-node scripts/create_avatar.ts <userName|mvcAddress|metaid> [图片路径或文件名] [--force]'
    )
    process.exit(1)
  }

  // 优先使用用户提供的文件路径（拖入对话框）；否则从 static/avatar 查找
  const useFilePath =
    avatarInput &&
    (path.isAbsolute(avatarInput) || isValidAvatarFilePath(path.resolve(avatarInput)))
  const useStaticAvatar = !useFilePath && (avatarInput ? hasAvatarFile(avatarInput) : hasAvatarFile())

  if (!useFilePath && !useStaticAvatar) {
    console.error(
      avatarInput
        ? `❌ 未找到有效图片: ${avatarInput}（支持 jpg/png/gif/webp/avif，可为完整路径或 static/avatar 下文件名）`
        : '❌ 请提供图片路径，或将图片放入 static/avatar 下'
    )
    process.exit(1)
  }

  const accountData = readAccountFile()
  const account = findAccountByKeyword(keyword, accountData)
  if (!account) {
    console.error(`❌ 未找到账户: ${keyword}`)
    process.exit(1)
  }

  if (account.avatarPinId && !force) {
    console.log(`ℹ️  ${account.userName || account.mvcAddress} 已有头像，avatarPinId: ${account.avatarPinId}`)
    console.log('   使用 --force 可覆盖更新')
    process.exit(0)
  }

  let avatarData: { avatar: string; contentType: string } | null = null
  try {
    avatarData = useFilePath
      ? await loadAvatarFromFilePath(avatarInput!)
      : await loadAvatarAsBase64(avatarInput || undefined)
  } catch (e: any) {
    if (e?.message === AVATAR_SIZE_EXCEEDED_MSG) {
      console.error(`❌ ${AVATAR_SIZE_EXCEEDED_MSG}`)
    } else {
      throw e
    }
    process.exit(1)
  }

  if (!avatarData) {
    console.error('❌ 无法加载头像数据')
    process.exit(1)
  }

  console.log('🖼️  创建头像节点...')
  const avatarPinParams: CreatePinParams = {
    chain: 'mvc',
    dataList: [
      {
        metaidData: {
          operation: 'create',
          path: '/info/avatar',
          body: avatarData.avatar,
          encoding: 'base64',
          contentType: avatarData.contentType,
        },
      },
    ],
    feeRate: 1,
  }

  const avatarPinRes = await createPin(avatarPinParams, account.mnemonic, {
    addressIndex: parseAddressIndexFromPath(account.path),
  })
  if (avatarPinRes.txids && avatarPinRes.txids.length > 0) {
    const avatarPinId = avatarPinRes.txids[0] + 'i0'
    const accData = readAccountFile()
    const accIdx = accData.accountList.findIndex(
      (a) => a.mvcAddress === account.mvcAddress
    )
    if (accIdx !== -1) {
      accData.accountList[accIdx].avatarPinId = avatarPinId
      accData.accountList[accIdx].avatar = getAvatarUrl(avatarPinId)
      writeAccountFile(accData)
      console.log(`✅ 头像创建成功!`)
      console.log(`   avatarPinId: ${avatarPinId}`)
    }
  } else {
    console.error('❌ 创建头像交易失败')
    process.exit(1)
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
