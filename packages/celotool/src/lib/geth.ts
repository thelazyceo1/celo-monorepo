/* tslint:disable: no-console */
import { CeloContract, ContractKit, newKit } from '@celo/contractkit'
import { TransactionResult } from '@celo/contractkit/lib/utils/tx-result'
import {
  convertToContractDecimals,
  GoldToken,
  sendTransaction,
  StableToken,
  unlockAccount,
} from '@celo/walletkit'
import { GoldToken as GoldTokenType } from '@celo/walletkit/types/GoldToken'
import { StableToken as StableTokenType } from '@celo/walletkit/types/StableToken'
import BigNumber from 'bignumber.js'
import fs from 'fs'
import { range } from 'lodash'
import fetch from 'node-fetch'
import path from 'path'
import Web3Type from 'web3'
import { TransactionReceipt } from 'web3/types'
import { envVar, fetchEnv, isVmBased } from './env-utils'
import {
  AccountType,
  generatePrivateKey,
  privateKeyToAddress,
  privateKeyToPublicKey,
} from './generate_utils'
import { retrieveIPAddress } from './helm_deploy'
import { execCmd, execCmdWithExitOnFailure } from './utils'
import { getTestnetOutputs } from './vm-testnet-utils'

type HandleErrorCallback = (isError: boolean, data: { location: string; error: string }) => void

const Web3 = require('web3')

const DEFAULT_TRANSFER_AMOUNT = new BigNumber('0.00000000000001')
const LOAD_TEST_TRANSFER_WEI = new BigNumber(100)

const GETH_IPC = 'geth.ipc'
const DISCOVERY_PORT = 30303

const BLOCKSCOUT_TIMEOUT = 12000 // ~ 12 seconds needed to see the transaction in the blockscout

const getTxNodeName = (namespace: string, id: number) => {
  return `${namespace}-gethtx${id}`
}

export const getEnodeAddress = (nodeId: string, ipAddress: string, port: number) => {
  return `enode://${nodeId}@${ipAddress}:${port}`
}

const getOGEnodesAddresses = async (namespace: string) => {
  const txNodesIds = [
    fetchEnv(envVar.GETHTX1_NODE_ID),
    fetchEnv(envVar.GETHTX2_NODE_ID),
    fetchEnv(envVar.GETHTX3_NODE_ID),
    fetchEnv(envVar.GETHTX4_NODE_ID),
  ]

  const enodes = []
  for (let id = 0; id < txNodesIds.length; id++) {
    const [ipAddress] = await execCmdWithExitOnFailure(
      `kubectl get service/${getTxNodeName(
        namespace,
        id + 1
      )} --namespace ${namespace} -o jsonpath='{.status.loadBalancer.ingress[0].ip}'`
    )

    enodes.push(getEnodeAddress(txNodesIds[id], ipAddress, DISCOVERY_PORT))
  }

  return enodes
}

const getClusterNativeEnodes = async (namespace: string) => {
  return getEnodesWithIpAddresses(namespace, false)
}

const getExternalEnodeAddresses = async (namespace: string) => {
  // const usingStaticIps = fetchEnv(envVar.STATIC_IPS_FOR_GETH_NODES)
  // if (usingStaticIps === 'true') {
  //   return getBootnodeEnode(namespace)
  // }
  return getEnodesWithIpAddresses(namespace, true)
}

export const getBootnodeEnode = async (namespace: string) => {
  const ip = await retrieveIPAddress(`${namespace}-bootnode`)
  // We couldn't use our updated docker image, so for now the bootnodes id is based upon the load_testing account
  const privateKey = generatePrivateKey(
    fetchEnv(envVar.MNEMONIC),
    AccountType.LOAD_TESTING_ACCOUNT,
    0
  )
  const nodeId = privateKeyToPublicKey(privateKey)
  return [getEnodeAddress(nodeId, ip, DISCOVERY_PORT)]
}

const retrieveTxNodeAddresses = async (namespace: string, txNodesNum: number) => {
  if (isVmBased()) {
    const outputs = await getTestnetOutputs(namespace)
    return outputs.tx_node_ip_addresses.value
  } else {
    const txNodesRange = range(0, txNodesNum)
    return Promise.all(txNodesRange.map((i) => retrieveIPAddress(`${namespace}-tx-nodes-${i}`)))
  }
}

const getEnodesWithIpAddresses = async (namespace: string, getExternalIP: boolean) => {
  const txNodesNum = parseInt(fetchEnv(envVar.TX_NODES), 10)
  const txAddresses = await retrieveTxNodeAddresses(namespace, txNodesNum)
  const txNodesRange = range(0, txNodesNum)
  const enodes = Promise.all(
    txNodesRange.map(async (index) => {
      const privateKey = generatePrivateKey(fetchEnv(envVar.MNEMONIC), AccountType.TX_NODE, index)
      const nodeId = privateKeyToPublicKey(privateKey)
      let address: string
      if (getExternalIP) {
        address = txAddresses[index]
      } else {
        address = (await execCmd(
          `kubectl get service/${namespace}-service-${index} --namespace ${namespace} -o jsonpath='{.spec.clusterIP}'`
        ))[0]
        if (address.length === 0) {
          console.error('IP address is empty for transaction node')
          throw new Error('IP address is empty for transaction node')
        }
      }
      return getEnodeAddress(nodeId, address, DISCOVERY_PORT)
    })
  )
  return enodes
}

export const getEnodesAddresses = async (namespace: string) => {
  const txNodes = fetchEnv(envVar.TX_NODES)
  if (txNodes === 'og') {
    return getOGEnodesAddresses(namespace)
  } else {
    return getClusterNativeEnodes(namespace)
  }
}

export const getEnodesWithExternalIPAddresses = async (namespace: string) => {
  const txNodes = fetchEnv(envVar.TX_NODES)
  if (txNodes === 'og') {
    return getOGEnodesAddresses(namespace)
  } else {
    return getExternalEnodeAddresses(namespace)
  }
}

export const fetchPassword = (passwordFile: string) => {
  if (!fs.existsSync(passwordFile)) {
    console.error(`Password file at ${passwordFile} does not exists!`)
    process.exit(1)
  }
  return fs.readFileSync(passwordFile).toString()
}

export const writeStaticNodes = (
  enodes: string[],
  outputDirPath: string,
  outputFileName: string,
  spacing: number = 2
) => {
  const encodedJSON = JSON.stringify(enodes, null, spacing)

  fs.writeFile(path.join(outputDirPath, outputFileName), encodedJSON, (err) => {
    if (err) {
      console.error(err)
      process.exit(1)
    }
  })
}

export const checkGethStarted = (dataDir: string) => {
  if (!fs.existsSync(path.resolve(dataDir, GETH_IPC))) {
    console.error(`Looks like there are no local geth nodes running in ${dataDir}`)
    console.info(
      `Please, make sure you specified correct data directory, you could also run the geth node by "celotooljs geth run"`
    )
    process.exit(1)
  }
}

export const getWeb3AndTokensContracts = async () => {
  const web3Instance = new Web3('http://localhost:8545')
  const [goldTokenContact, stableTokenContact] = await Promise.all([
    GoldToken(web3Instance),
    StableToken(web3Instance),
  ])

  return {
    web3: web3Instance,
    goldToken: goldTokenContact,
    stableToken: stableTokenContact,
  }
}

export const getRandomInt = (from: number, to: number) => {
  return Math.floor(Math.random() * (to - from)) + from
}

const getRandomToken = (goldToken: GoldTokenType, stableToken: StableTokenType) => {
  const tokenType = getRandomInt(0, 2)
  if (tokenType === 0) {
    return goldToken
  } else {
    return stableToken
  }
}

const validateGethRPC = async (
  web3: Web3Type,
  txHash: string,
  from: string,
  handleError: HandleErrorCallback
) => {
  const transaction = await web3.eth.getTransaction(txHash)
  const txFrom = transaction.from.toLowerCase()
  const expectedFrom = from.toLowerCase()
  handleError(!transaction.from || expectedFrom !== txFrom, {
    location: '[GethRPC]',
    error: `Expected "from" to equal ${expectedFrom}, but found ${txFrom}`,
  })
}

const checkBlockscoutResponse = (
  json: any /* response */,
  txHash: string,
  from: string,
  handleError: HandleErrorCallback
) => {
  const location = '[Blockscout]'

  handleError(json.status !== '1', { location, error: `Invalid status: expected '1', received` })
  handleError(!json.result, { location, error: `No result found: receive ${json.status.result}` })
  const resultFrom = json.result.from.toLowerCase()
  const expectedFrom = from.toLowerCase()
  handleError(resultFrom !== expectedFrom, {
    location,
    error: `Expected "from" to equal ${expectedFrom}, but found ${resultFrom}`,
  })
  handleError(json.result.hash !== txHash, {
    location,
    error: `Expected "hash" to equal ${txHash}, but found ${json.result.hash}`,
  })
}

const fetchBlockscoutTxInfo = async (url: string, txHash: string) => {
  const response = await fetch(`${url}/api?module=transaction&action=gettxinfo&txhash=${txHash}`)
  return response.json()
}

const validateBlockscout = async (
  url: string,
  txHash: string,
  from: string,
  handleError: HandleErrorCallback
) => {
  const json = await fetchBlockscoutTxInfo(url, txHash)

  checkBlockscoutResponse(json, txHash, from, handleError)
}

// Maximal time given for blockscout to provide info about tx
// If the transaction does not appear in blockscout within 15 seconds,
// blockscout is considered to be not working in a timely manner
const MAXIMAL_BLOCKSCOUT_TIMEOUT = 15000

// Try to fetch info about transaction every 150 ms
const BLOCKSCOUT_FETCH_RETRY_TIME = 150

// within MAXIMAL_BLOCKSCOUT_TIMEOUT ms
const getFirstValidBlockscoutResponse = async (url: string, txHash: string) => {
  const attempts = MAXIMAL_BLOCKSCOUT_TIMEOUT / BLOCKSCOUT_FETCH_RETRY_TIME
  for (let attemptId = 0; attemptId < attempts; attemptId++) {
    const json = await fetchBlockscoutTxInfo(url, txHash)
    if (json.status !== '1') {
      await sleep(BLOCKSCOUT_FETCH_RETRY_TIME)
    } else {
      return [json, Date.now()]
    }
  }
  return [null, null]
}

const validateTransactionAndReceipt = (
  from: string,
  txReceipt: any,
  handleError: HandleErrorCallback
) => {
  const location = '[TX & Receipt]'

  handleError(!txReceipt, { location, error: 'No transaction receipt received!' })
  handleError(txReceipt.status !== true, {
    location,
    error: `Transaction receipt status (${txReceipt.status}) is not true!`,
  })
  handleError(txReceipt.from.toLowerCase() !== from.toLowerCase(), {
    location,
    error: `Transaction receipt from (${txReceipt.from}) is not equal to sender address (${from}).`,
  })
}

const tracerLog = (logMessage: any) => {
  console.log(JSON.stringify(logMessage))
}

const exitTracerTool = (logMessage: any) => {
  tracerLog(logMessage)
  process.exit(1)
}

export const sleep = (ms: number) => {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

const transferAndTrace = async (
  web3: Web3Type,
  goldToken: GoldTokenType,
  stableToken: StableTokenType,
  from: string,
  to: string,
  password: string,
  blockscoutUrl: string
) => {
  console.info('Transfer')

  const token = getRandomToken(goldToken, stableToken)
  const gasCurrencyToken = getRandomToken(goldToken, stableToken)

  const [tokenName, gasCurrencySymbol] = await Promise.all([
    token.methods.symbol().call(),
    gasCurrencyToken.methods.symbol().call(),
  ])

  const logMessage: any = {
    severity: 'CRITICAL',
    senderAddress: from,
    receiverAddress: to,
    blockscout: blockscoutUrl,
    token: tokenName,
    error: '',
    location: '',
    txHash: '',
  }

  const txParams: any = {}
  // Fill txParams below
  if (getRandomInt(0, 2) === 3) {
    txParams.gasCurrency = gasCurrencyToken._address
    logMessage.gasCurrency = gasCurrencySymbol
  }

  const transferToken = new Promise(async (resolve) => {
    await transferERC20Token(
      web3,
      token,
      from,
      to,
      DEFAULT_TRANSFER_AMOUNT,
      password,
      txParams,
      undefined,
      (receipt: any) => {
        resolve(receipt)
      },
      undefined,
      (error: any) => {
        logMessage.error = error
        exitTracerTool(logMessage)
      }
    )
  })

  const txReceipt: any = await transferToken
  const txHash = txReceipt ? txReceipt.transactionHash : ''

  // Need to wait for a bit to make sure that blockscout had enough time
  // to see the transaction and display it
  await sleep(BLOCKSCOUT_TIMEOUT)

  logMessage.txHash = txHash

  const handleError = (isError: boolean, data: { location: string; error: string }) => {
    if (isError) {
      exitTracerTool({ ...logMessage, ...data })
    }
  }

  validateTransactionAndReceipt(from, txReceipt!, handleError)
  await validateBlockscout(blockscoutUrl, txHash, from, handleError)
  await validateGethRPC(web3, txHash, from, handleError)
}

export const traceTransactions = async (
  web3: Web3Type,
  goldToken: GoldTokenType,
  stableToken: StableTokenType,
  addresses: string[],
  blockscoutUrl: string
) => {
  console.info('Starting simulation')

  await transferAndTrace(
    web3,
    goldToken,
    stableToken,
    addresses[0],
    addresses[1],
    '',
    blockscoutUrl
  )

  await transferAndTrace(
    web3,
    goldToken,
    stableToken,
    addresses[1],
    addresses[0],
    '',
    blockscoutUrl
  )

  console.info('Simulation finished successully!')
}

// for log messages which show time needed to receive the receipt after
// the transaction has been sent
export const LOG_TAG_TX_TIME_MEASUREMENT = 'tx_time_measurement'
// for log messages which show time (+- 150-200ms) needed for blockscout to
// fetch and publish information about transaction
export const LOG_TAG_BLOCKSCOUT_TIME_MEASUREMENT = 'blockscout_time_measurement'
// for log messages which show the error occurred when the transaction has
// been sent
export const LOG_TAG_TRANSACTION_ERROR = 'transaction_error'
// for log messages which show the error about validating transaction receipt
export const LOG_TAG_TRANSACTION_VALIDATION_ERROR = 'validate_transaction_error'
// for log messages which indicate that blockscout where not able to provide
// information about transaction in a "timely" (15s for now) manner
export const LOG_TAG_BLOCKSCOUT_TIMEOUT = 'blockscout_timeout'
// for log messages which show the error about validating transaction receipt
export const LOG_TAG_BLOCKSCOUT_VALIDATION_ERROR = 'validate_blockscout_error'
// for log messages which show the error while validating geth rpc response
export const LOG_TAG_GETH_RPC_ERROR = 'geth_rpc_error'
// message indicating that the tx hash has been received in callback within sendTransaction
export const LOG_TAG_TRANSACTION_HASH_RECEIVED = 'tx_hash_received'

const measureBlockscout = async (
  blockscoutUrl: string,
  txHash: string,
  from: string,
  obtainReceiptTime: number,
  baseLogMessage: any
) => {
  const [json, receivedTime] = await getFirstValidBlockscoutResponse(blockscoutUrl, txHash)
  if (receivedTime === null) {
    tracerLog({
      tag: LOG_TAG_BLOCKSCOUT_TIMEOUT,
      ...baseLogMessage,
    })
  } else {
    tracerLog({
      tag: LOG_TAG_BLOCKSCOUT_TIME_MEASUREMENT,
      p_time: receivedTime - obtainReceiptTime,
      ...baseLogMessage,
    })
    checkBlockscoutResponse(json, txHash, from, (isError, data) => {
      if (isError) {
        tracerLog({
          tag: LOG_TAG_BLOCKSCOUT_VALIDATION_ERROR,
          ...data,
          ...baseLogMessage,
        })
      }
    })
  }
}

export const transferCeloGold = async (
  kit: ContractKit,
  fromAddress: string,
  toAddress: string,
  amount: BigNumber,
  txOptions: {
    gas?: number
    gasPrice?: string
    gasCurrency?: string
    gasFeeRecipient?: string
  } = {}
) => {
  const kitGoldToken = await kit.contracts.getGoldToken()
  return kitGoldToken.transfer(toAddress, amount.toString()).send({
    from: fromAddress,
    ...txOptions,
  })
}

export const transferCeloDollars = async (
  kit: ContractKit,
  fromAddress: string,
  toAddress: string,
  amount: BigNumber,
  txOptions: {
    gas?: number
    gasPrice?: string
    gasCurrency?: string
    gasFeeRecipient?: string
  } = {}
) => {
  const kitStableToken = await kit.contracts.getStableToken()
  return kitStableToken.transfer(toAddress, amount.toString()).send({
    from: fromAddress,
    ...txOptions,
  })
}

export const simulateClient = async (
  senderPrivateKey: string,
  recipientAddress: string,
  gasFeeRecipientAddress: string,
  txPeriodMs: number, // time between new transactions in ms
  blockscoutUrl: string,
  blockscoutMeasurePercent: number, // percent of time in range [0, 100] to measure blockscout for a tx
  index: number
) => {
  // Assume the node is accessible via localhost
  const kit = newKit('http://localhost:8545')

  kit.addAccount(senderPrivateKey)
  const senderAddress = privateKeyToAddress(senderPrivateKey)
  const baseLogMessage: any = {
    loadTestID: index,
    sender: senderAddress,
    recipient: recipientAddress,
    gasCurrency: '',
    gasFeeRecipient: gasFeeRecipientAddress,
    txHash: '',
  }

  while (true) {
    const sendTransactionTime = Date.now()

    const transferGold = Boolean(Math.round(Math.random()))
    const transferFn = transferGold ? transferCeloGold : transferCeloDollars
    // randomly choose which gas currency to use
    const gasCurrencyGold = Boolean(Math.round(Math.random()))
    const gasCurrency = gasCurrencyGold
      ? undefined
      : await kit.registry.addressFor(CeloContract.StableToken)
    baseLogMessage.gasCurrency = gasCurrency || ''
    // Contractkit does not yet fully estimate non-Gold currencies
    let gasPrice: string | undefined = undefined
    if (gasCurrency) {
      const gasPriceMultiplier = new BigNumber(10)

      const gasPriceMinimum = await kit.contracts.getGasPriceMinimum()
      const gasPriceNum = (await gasPriceMinimum.getGasPriceMinimum(gasCurrency)).times(
        gasPriceMultiplier
      )
      gasPrice = kit.web3.utils.toHex(gasPriceNum.toString())
    }

    transferFn(kit, senderAddress, recipientAddress, LOAD_TEST_TRANSFER_WEI, {
      gasCurrency,
      gasFeeRecipient: gasFeeRecipientAddress,
      gasPrice,
    })
      .then(async (txResult: TransactionResult) => {
        await onLoadTestTxResult(
          kit,
          senderAddress,
          txResult,
          sendTransactionTime,
          baseLogMessage,
          transferGold ? 'cGLD' : 'cUSD',
          blockscoutUrl,
          blockscoutMeasurePercent
        )
      })
      .catch((error: any) => {
        console.error('Load test transaction failed with error:', JSON.stringify(error))
      })
    await sleep(txPeriodMs)
  }
}

export const onLoadTestTxResult = async (
  kit: ContractKit,
  senderAddress: string,
  txResult: TransactionResult,
  sendTransactionTime: number,
  baseLogMessage: any,
  tokenSymbol: string,
  blockscoutUrl: string,
  blockscoutMeasurePercent: number
) => {
  baseLogMessage.token = tokenSymbol

  const txReceipt = await txResult.waitReceipt()
  const txHash = txReceipt.transactionHash
  baseLogMessage.txHash = txHash

  const receiptTime = Date.now()

  tracerLog({
    txHash,
    tag: LOG_TAG_TRANSACTION_HASH_RECEIVED,
    ...baseLogMessage,
  })

  try {
    tracerLog({
      tag: LOG_TAG_TX_TIME_MEASUREMENT,
      p_time: receiptTime - sendTransactionTime,
      ...baseLogMessage,
    })

    // Continuing only with receipt received
    validateTransactionAndReceipt(senderAddress, txReceipt, (isError, data) => {
      if (isError) {
        tracerLog({
          tag: LOG_TAG_TRANSACTION_VALIDATION_ERROR,
          ...baseLogMessage,
          ...data,
        })
      }
    })

    if (Math.random() * 10 < blockscoutMeasurePercent) {
      await measureBlockscout(
        blockscoutUrl,
        txReceipt.transactionHash,
        senderAddress,
        receiptTime,
        baseLogMessage
      )
    }

    await validateGethRPC(kit.web3, txHash, senderAddress, (isError, data) => {
      if (isError) {
        tracerLog({
          tag: LOG_TAG_GETH_RPC_ERROR,
          ...data,
          ...baseLogMessage,
        })
      }
    })
  } catch (error) {
    tracerLog({
      tag: LOG_TAG_TRANSACTION_ERROR,
      error: error.toString(),
      ...baseLogMessage,
    })
  }
}

export const transferERC20Token = async (
  web3: Web3Type,
  token: GoldTokenType | StableTokenType,
  from: string,
  to: string,
  amount: BigNumber,
  password: string,
  txParams: any = {},
  onTransactionHash?: (hash: string) => void,
  onReceipt?: (receipt: TransactionReceipt) => void,
  onConfirmation?: (confirmationNumber: number, receipt: TransactionReceipt) => void,
  onError?: (error: any) => void
) => {
  txParams.from = from
  await unlockAccount(web3, 0, password, from)

  const [convertedAmount, symbol] = await Promise.all([
    convertToContractDecimals(amount, token),
    token.methods.symbol().call(),
  ])

  await sendTransaction(
    `celotool/transfer-${symbol}`,
    `transfer ${symbol}`,
    token.methods.transfer(to, convertedAmount.toString()),
    txParams,
    onTransactionHash,
    onReceipt,
    onConfirmation,
    onError
  )
}
