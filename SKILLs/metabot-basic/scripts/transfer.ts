/**
 * MVC 原生/FT 转账 (sendSpace) 与 DOGE 转账 (sendDoge)
 * 使用 account.json 当前操作用户，需配合人机确认使用。
 */

import { API_NET, API_TARGET, FtManager, Wallet, mvc } from 'meta-contract'
import Decimal from 'decimal.js'
import { Chain, getCurrentWallet, getNet, getMnemonicFromAccount } from './wallet'
import { fetchDogeUtxos, fetchDogeFeeRates, broadcastDogeTx, DogeFeeRate } from './api'
import { getDogeWallet } from './wallet'

export type TransferTask = {
  genesis?: string
  codehash?: string
  receivers: Receiver[]
  metaidData?: any
}

export type Receiver = {
  address: string
  amount: string
  decimal?: string
}

export type SendSpaceOptions = {
  addressIndex?: number
  accountIndex?: number
}

type TransferResult = {
  id: number
  txid: string
  txHex: string
  routeCheckTxid?: string
  routeCheckTxHex?: string
}

/**
 * 将 getNet() 转为 meta-contract API_NET
 */
function getApiNet(): API_NET {
  const net = getNet()
  return net === 'livenet' ? API_NET.MAIN : API_NET.TEST
}

/**
 * MVC 转账（原生 SPACE 或 FT）
 * amount 必须以 sats 为单位传入；mnemonic 从 account.json 当前用户读取。
 */
export async function sendSpace(
  params: {
    tasks: TransferTask[]
    broadcast?: boolean
    feeb?: number
    options?: SendSpaceOptions
  }
): Promise<{ res: TransferResult[]; txids: string[]; broadcasted: boolean }> {
  const { tasks, broadcast = true, feeb = 1, options = {} } = params
  const { mnemonic, addressIndex: derivedIndex } = getMnemonicFromAccount({
    accountIndex: options.accountIndex,
  })
  const addressIndex = options.addressIndex ?? derivedIndex

  const network: API_NET = getApiNet()
  const chainWallet = await getCurrentWallet(Chain.MVC, { mnemonic, addressIndex })
  const purse = chainWallet.getPrivateKey()
  const address = chainWallet.getAddress()

  const wallet = new Wallet(purse, network, feeb, API_TARGET.APIMVC)
  const ftManager = new FtManager({
    network,
    apiTarget: API_TARGET.APIMVC,
    purse,
    feeb,
  })

  const results: TransferResult[] = []
  const txids: string[] = []
  let theUtxo:
    | {
        txId: string
        outputIndex: number
        satoshis: number
        address: string
        height: number
        flag: string
        wif: string
      }
    | undefined = undefined

  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i]
    const id = i + 1

    if (task.genesis) {
      const { txHex, routeCheckTxHex, txid, tx, routeCheckTx } = await ftManager.transfer({
        codehash: task.codehash!,
        genesis: task.genesis,
        receivers: task.receivers,
        senderWif: purse,
        noBroadcast: !broadcast,
        utxos: theUtxo ? [{ txId: theUtxo.txId, outputIndex: theUtxo.outputIndex, satoshis: theUtxo.satoshis, address: theUtxo.address, wif: theUtxo.wif }] : undefined,
        opreturnData: task.metaidData ?? undefined,
      })
      const routeCheckTxid = routeCheckTx.id
      results.push({
        id,
        txid,
        txHex,
        routeCheckTxHex,
        routeCheckTxid,
      })
      txids.push(routeCheckTxid)
      txids.push(txid)
      theUtxo = {
        txId: txid,
        outputIndex: tx.outputs.length - 1,
        satoshis: tx.outputs[tx.outputs.length - 1].satoshis,
        address,
        height: -1,
        flag: '',
        wif: purse,
      }
    } else {
      const receiversWithNumericAmount = task.receivers.map((r) => ({
        address: r.address,
        amount: Number(r.amount),
      }))

      const utxos: any = theUtxo
        ? [{ ...theUtxo, flag: theUtxo.flag || '' }]
        : undefined
      const transferRes = await wallet.sendArray(receiversWithNumericAmount, utxos, {
        noBroadcast: !broadcast,
      })
      results.push({
        id,
        txid: transferRes.txId,
        txHex: transferRes.txHex,
      })
      txids.push(transferRes.txId)
      const resTx = new mvc.Transaction(transferRes.txHex)
      theUtxo = {
        txId: transferRes.txId,
        outputIndex: resTx.outputs.length - 1,
        satoshis: resTx.outputs[resTx.outputs.length - 1].satoshis,
        address,
        height: -1,
        flag: '',
        wif: purse,
      }
    }
  }

  return { res: results, txids, broadcasted: broadcast }
}

// --- Space / sats 换算 ---

/** 1 Space = 10^8 sats */
export const SPACE_TO_SATS = new Decimal(10).pow(8)

/**
 * 用户输入为 Space 时转为 sats（如 0.001 space -> 100000 sats）
 */
export function spaceToSats(spaceAmount: string | number): number {
  return new Decimal(spaceAmount).mul(SPACE_TO_SATS).toNumber()
}

/**
 * 用户输入为 sats 时直接使用；若为 space 则先转换。
 * @param amount 数字或字符串
 * @param unit 'space' | 'sats'；为 space 时按 1 space = 10^8 sats 换算
 */
export function toSats(amount: string | number, unit: 'space' | 'sats'): number {
  if (unit === 'space') return spaceToSats(amount)
  return new Decimal(amount).toNumber()
}

// --- DOGE 转账 ---

export interface DogeTransferParams {
  toAddress: string
  satoshis: string | number
  options?: {
    noBroadcast?: boolean
    feeRate?: string | number
  }
}

export type SendDogeOptions = {
  addressIndex?: number
  accountIndex?: number
}

/** 最小转账：0.01 DOGE = 1,000,000 satoshis */
export const MIN_DOGE_TRANSFER_SATOSHIS = 1000000

/**
 * DOGE 转账；mnemonic 从 account.json 当前用户读取。
 */
export async function sendDoge(
  params: DogeTransferParams,
  options: SendDogeOptions = {}
): Promise<{ txId: string } | { txHex: string }> {
  const { mnemonic, addressIndex: derivedIndex } = getMnemonicFromAccount({
    accountIndex: options.accountIndex,
  })
  const addressIndex = options.addressIndex ?? derivedIndex

  const wallet = await getDogeWallet({
    mnemonic,
    addressIndex,
  })
  const address = wallet.getAddress()

  const transferAmount = new Decimal(params.satoshis)
  if (transferAmount.lt(MIN_DOGE_TRANSFER_SATOSHIS)) {
    throw new Error(
      `Minimum transfer amount is 0.01 DOGE (${MIN_DOGE_TRANSFER_SATOSHIS} satoshis)`
    )
  }

  let feeRate: number | undefined
  if (params.options?.feeRate != null) {
    feeRate = Number(params.options.feeRate)
  } else {
    const rates: DogeFeeRate[] = await fetchDogeFeeRates()
    const avgRate = rates.find((item) => item.title === 'Avg')
    feeRate = avgRate?.feeRate ?? 200000
  }

  const utxos = await fetchDogeUtxos(address, true)
  if (!utxos.length) {
    throw new Error('No UTXOs available')
  }

  const { txId, rawTx } = await wallet.signTransaction({
    utxos,
    outputs: [
      {
        address: params.toAddress,
        satoshis: transferAmount.toNumber(),
      },
    ],
    feeRate,
    changeAddress: address,
  })

  if (params.options?.noBroadcast) {
    return { txHex: rawTx }
  }

  const broadcastTxId = await broadcastDogeTx(rawTx)
  return { txId: broadcastTxId }
}
