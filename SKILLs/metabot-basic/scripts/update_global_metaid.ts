#!/usr/bin/env node

import { getUserInfoByAddressByMs } from './api'
import { readAccountFile, writeAccountFile } from './utils'

async function updateGlobalMetaId() {
  const addresses = [
    '1LfaZ64Y3JKdNNBP4d2mpeMU8oQa9mryt7',
    '19vUPMweuiFeX9ipFPVYw1SApAZB9wHxoo'
  ]

  const accountData = readAccountFile()
  
  for (const address of addresses) {
    try {
      console.log(`📋 Fetching user info for address: ${address}...`)
      const userInfo = await getUserInfoByAddressByMs(address)
      
      if (userInfo && userInfo.globalMetaId) {
        // Find account by mvcAddress
        const accountIndex = accountData.accountList.findIndex(
          acc => acc.mvcAddress === address
        )
        
        if (accountIndex >= 0) {
          accountData.accountList[accountIndex].globalMetaId = userInfo.globalMetaId
          console.log(`✅ Updated globalMetaId for ${address}: ${userInfo.globalMetaId}`)
        } else {
          console.log(`⚠️  Account not found for address: ${address}`)
        }
      } else {
        console.log(`⚠️  globalMetaId not found for address: ${address}`)
      }
    } catch (error: any) {
      console.error(`❌ Failed to fetch user info for ${address}: ${error.message}`)
    }
  }
  
  // Write updated account data
  writeAccountFile(accountData)
  console.log('\n✅ Account file updated successfully!')
}

updateGlobalMetaId().catch((error) => {
  console.error('Fatal error:', error)
  process.exit(1)
})
