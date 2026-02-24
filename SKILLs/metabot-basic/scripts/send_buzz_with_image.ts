#!/usr/bin/env node

/**
 * 发送带图片附件的 Buzz 到 MVC 网络。
 * 支持本地图片（先上链取 pinId）或已有 pinId。
 *
 * Usage:
 *   npx ts-node scripts/send_buzz_with_image.ts <agentName> <content> --image <path>
 *   npx ts-node scripts/send_buzz_with_image.ts <agentName> <content> --pinid <pinid> [--ext .png]
 */

import * as fs from 'fs'
import * as path from 'path'
import { execSync } from 'child_process'
import { createBuzz } from './buzz'
import { parseAddressIndexFromPath } from './wallet'
import { readAccountFile, findAccountByKeyword } from './utils'

const SCRIPT_DIR = __dirname
// 使用 process.cwd() 确保配置文件在用户项目根目录
const ROOT_DIR = process.cwd()
const ACCOUNT_FILE = path.join(ROOT_DIR, 'account.json')
// metabot-file 技能目录相对于当前脚本位置
const METABOT_FILE_DIR = path.join(SCRIPT_DIR, '..', '..', 'metabot-file')

function getContentTypeFromExt(ext: string): string {
  const map: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
  }
  return map[ext.toLowerCase()] || 'application/octet-stream'
}

function parseArgs(): {
  agentName: string
  content: string
  imagePath?: string
  pinid?: string
  ext: string
} {
  const args = process.argv.slice(2)
  const imageIdx = args.indexOf('--image')
  const pinidIdx = args.indexOf('--pinid')
  const extIdx = args.indexOf('--ext')

  if (imageIdx >= 0 && pinidIdx >= 0) {
    console.error('❌ 不能同时指定 --image 和 --pinid')
    process.exit(1)
  }
  if (imageIdx < 0 && pinidIdx < 0) {
    console.error('❌ 请指定 --image <path> 或 --pinid <pinid>')
    printUsage()
    process.exit(1)
  }

  const firstOpt = Math.min(
    imageIdx < 0 ? args.length : imageIdx,
    pinidIdx < 0 ? args.length : pinidIdx
  )
  const agentName = args[0] || ''
  const content = args.slice(1, firstOpt).join(' ').trim()

  if (!agentName || !content) {
    console.error('❌ 请提供 agentName 和 content')
    printUsage()
    process.exit(1)
  }

  let imagePath: string | undefined
  let pinid: string | undefined
  let ext = '.png'

  if (imageIdx >= 0 && args[imageIdx + 1]) {
    imagePath = args[imageIdx + 1]
    const parsed = path.parse(imagePath)
    if (parsed.ext) ext = parsed.ext.startsWith('.') ? parsed.ext : '.' + parsed.ext
  }
  if (pinidIdx >= 0 && args[pinidIdx + 1]) {
    pinid = args[pinidIdx + 1]
    if (extIdx >= 0 && args[extIdx + 1]) ext = args[extIdx + 1]
    if (!ext.startsWith('.')) ext = '.' + ext
  }

  return { agentName, content, imagePath, pinid, ext }
}

function printUsage() {
  console.error('   Usage: npx ts-node scripts/send_buzz_with_image.ts <agentName> <content> --image <path>')
  console.error('   或:    npx ts-node scripts/send_buzz_with_image.ts <agentName> <content> --pinid <pinid> [--ext .png]')
}

async function uploadImageAndGetPinId(agentName: string, imagePath: string): Promise<{ pinId: string; ext: string }> {
  const absPath = path.isAbsolute(imagePath) ? imagePath : path.join(process.cwd(), imagePath)
  if (!fs.existsSync(absPath)) {
    console.error(`❌ 图片不存在: ${absPath}`)
    process.exit(1)
  }
  const ext = path.extname(absPath) || '.png'
  const contentType = getContentTypeFromExt(ext)

  if (!fs.existsSync(METABOT_FILE_DIR) || !fs.existsSync(path.join(METABOT_FILE_DIR, 'scripts', 'metafs_direct_upload.ts'))) {
    console.error('❌ 未找到 metabot-file 脚本目录，无法上传图片')
    process.exit(1)
  }

  const accountFileAbs = path.isAbsolute(ACCOUNT_FILE) ? ACCOUNT_FILE : path.resolve(ROOT_DIR, ACCOUNT_FILE)
  const cmd = `npx ts-node scripts/metafs_direct_upload.ts --account-file "${accountFileAbs}" --keyword "${agentName}" --file "${absPath}" --path /file --content-type ${contentType}`
  let out: string
  try {
    out = execSync(cmd, {
      cwd: METABOT_FILE_DIR,
      encoding: 'utf-8',
      maxBuffer: 2 * 1024 * 1024,
    })
  } catch (err: any) {
    const msg = err?.stderr?.toString() || err?.stdout?.toString() || err?.message || String(err)
    console.error('❌ 图片上链失败:', msg)
    process.exit(1)
  }

  const lines = out.trim().split('\n')
  const lastLine = lines[lines.length - 1]
  let data: { pinId?: string }
  try {
    data = JSON.parse(lastLine)
  } catch {
    console.error('❌ 无法解析上传结果 JSON:', lastLine)
    process.exit(1)
  }
  if (!data.pinId) {
    console.error('❌ 上传结果中无 pinId:', lastLine)
    process.exit(1)
  }
  return { pinId: data.pinId, ext }
}

async function main() {
  const { agentName, content, imagePath, pinid, ext } = parseArgs()

  let pinId: string
  let attachmentExt = ext

  if (imagePath) {
    console.log(`📤 正在上传图片: ${imagePath}`)
    const result = await uploadImageAndGetPinId(agentName, imagePath)
    pinId = result.pinId
    attachmentExt = result.ext
    console.log(`✅ 图片已上链，PinID: ${pinId}`)
  } else if (pinid) {
    pinId = pinid
    console.log(`📌 使用已有 PinID: ${pinId}`)
  } else {
    console.error('❌ 未指定 --image 或 --pinid')
    process.exit(1)
  }

  const attachment = `metafile://${pinId}${attachmentExt.startsWith('.') ? attachmentExt : '.' + attachmentExt}`

  const accountData = readAccountFile()
  const account = findAccountByKeyword(agentName, accountData)
  if (!account) {
    console.error(`❌ 未找到账户: ${agentName}`)
    console.error('   请确保 account.json 中存在该 Agent')
    process.exit(1)
  }
  if (!account.mnemonic) {
    console.error(`❌ 账户 ${agentName} 无 mnemonic`)
    process.exit(1)
  }

  console.log(`📢 使用 ${agentName} 发送带图 Buzz...`)
  console.log(`   内容: ${content}`)
  console.log(`   附件: ${attachment}`)

  try {
    const result = await createBuzz(
      account.mnemonic,
      content,
      1,
      { addressIndex: parseAddressIndexFromPath(account.path) },
      [attachment]
    )
    if (result.txids?.length) {
      console.log(`✅ 带图 Buzz 发送成功!`)
      console.log(`   TXID: ${result.txids[0]}`)
      console.log(`   消耗: ${result.totalCost} satoshis`)
    } else {
      throw new Error('No txids returned')
    }
  } catch (error: any) {
    console.error(`❌ 发送失败: ${error?.message || error}`)
    process.exit(1)
  }
}

main()
