/**
 * GovExit Keeper — Avalanche Fuji.
 *
 * The Keeper is the off-chain, permissionless actor that watches queued
 * governance Proposals and calls `GovExit.checkAndExit` when a Protected user's
 * Exit rule trips. It holds gas only and has no authority: `GovExit` is the
 * user's Exit agent and re-verifies every condition. There is no AI and no
 * discretion in this path — see `logic.ts` for the deterministic gate.
 *
 * Run:
 *   npm start                 # uses ../.env if present, else process env
 *   LOG_CHUNK_SIZE=200 npm start
 *
 * Env (all have canonical Fuji defaults except the key):
 *   KEEPER_PRIVATE_KEY   required, gas-only signer
 *   RPC_URL
 *   DEPLOY_BLOCK
 *   GOVEXIT_ADDRESS, GOVERNANCE_ADDRESS
 *   POLL_INTERVAL_MS (default 3000), LOG_CHUNK_SIZE (default 2000)
 *
 * Note: the Keeper deliberately does NOT read the frontend NEXT_PUBLIC_* vars;
 * the canonical deployment addresses are the built-in defaults so a plain
 * `npm start` cannot be pointed at a stale deployment by the browser env.
 */

import { existsSync } from 'node:fs'
import {
  createPublicClient,
  createWalletClient,
  getAddress,
  http,
  parseAbi,
  parseAbiItem,
  type AbiEvent,
  type Address,
  type PublicClient,
  type WalletClient,
} from 'viem'
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts'
import { avalancheFuji } from 'viem/chains'

import {
  actionableCandidates,
  backoffDelayMs,
  decideExit,
  isActionable,
  liveProposals,
  planChunks,
  type ExitCandidate,
  type QueuedProposal,
  type RuleState,
} from './logic.ts'

// --- env loading (never log values) -----------------------------------------
for (const candidate of ['../.env', '.env']) {
  if (existsSync(candidate)) {
    try {
      process.loadEnvFile(candidate)
    } catch {
      // Fall back to whatever is already in process.env.
    }
    break
  }
}

// --- ABI slices the Keeper needs --------------------------------------------
const govExitAbi = parseAbi([
  'function rules(address user) view returns (uint256 minimumThresholdBps, bool active, bool triggered)',
  'function shouldExit(address user, uint256 proposalId) view returns (bool)',
  'function checkAndExit(address user, uint256 proposalId)',
])

const ruleCreatedEvent = parseAbiItem(
  'event RuleCreated(address indexed user, uint256 minimumThresholdBps)',
)
const proposalQueuedEvent = parseAbiItem(
  'event ProposalQueued(uint256 indexed proposalId, uint256 currentThreshold, uint256 newThreshold, uint256 executeAfter)',
)

const FUJI_CHAIN_ID = 43113
const DEFAULT_RPC = 'https://api.avax-test.network/ext/bc/C/rpc'
const DEFAULT_GOVEXIT = '0x90970F046e70B4E11579566aD22F5CFb8AefC390'
const DEFAULT_GOVERNANCE = '0xAb01AFe53C0aFd8348a3117eb9487A82362B95EB'
const DEFAULT_DEPLOY_BLOCK = 58732756n

interface Config {
  keeperKey: `0x${string}`
  rpcUrl: string
  govExit: Address
  governance: Address
  deployBlock: bigint
  pollIntervalMs: number
  logChunkSize: bigint
}

function loadConfig(): Config {
  const keeperKey = process.env.KEEPER_PRIVATE_KEY
  if (!keeperKey || !/^0x[0-9a-fA-F]{64}$/.test(keeperKey)) {
    throw new Error('KEEPER_PRIVATE_KEY is missing or malformed (expected 0x + 64 hex chars)')
  }
  const pollIntervalMs = Number(process.env.POLL_INTERVAL_MS ?? '3000')
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs <= 0) {
    throw new Error('POLL_INTERVAL_MS must be a positive number')
  }
  const logChunkSize = BigInt(process.env.LOG_CHUNK_SIZE ?? '2000')
  if (logChunkSize <= 0n) {
    throw new Error('LOG_CHUNK_SIZE must be a positive number of blocks')
  }
  return {
    keeperKey: keeperKey as `0x${string}`,
    rpcUrl: process.env.RPC_URL ?? DEFAULT_RPC,
    govExit: getAddress(process.env.GOVEXIT_ADDRESS ?? DEFAULT_GOVEXIT),
    governance: getAddress(process.env.GOVERNANCE_ADDRESS ?? DEFAULT_GOVERNANCE),
    deployBlock: BigInt(process.env.DEPLOY_BLOCK ?? DEFAULT_DEPLOY_BLOCK),
    pollIntervalMs,
    logChunkSize,
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

function isRateLimited(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /429|too many requests|rate limit/i.test(message)
}

/** Retry a single `eth_getLogs` call with capped exponential backoff on 429. */
async function withBackoff<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const maxAttempts = 8
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn()
    } catch (error) {
      if (!isRateLimited(error) || attempt >= maxAttempts) {
        throw error
      }
      const delay = backoffDelayMs(attempt)
      log(`${label} rate-limited (429); backing off ${delay}ms`)
      await sleep(delay)
    }
  }
}

function log(message: string): void {
  console.log(`[keeper ${new Date().toISOString()}] ${message}`)
}

/** Load a log range in chunks that respect the RPC's getLogs limits. */
async function getLogsChunked(
  publicClient: PublicClient,
  address: Address,
  event: AbiEvent,
  fromBlock: bigint,
  toBlock: bigint,
  chunkSize: bigint,
): Promise<Array<{ args: Record<string, unknown> }>> {
  const chunks = planChunks(fromBlock, toBlock, chunkSize)
  const results: Array<{ args: Record<string, unknown> }> = []
  for (const chunk of chunks) {
    const logs = await withBackoff(
      `getLogs ${address} ${chunk.fromBlock}-${chunk.toBlock}`,
      () =>
        publicClient.getLogs({
          address,
          event,
          fromBlock: chunk.fromBlock,
          toBlock: chunk.toBlock,
        }),
    )
    results.push(...(logs as unknown as Array<{ args: Record<string, unknown> }>))
  }
  // Quiet on an empty single-chunk scan; surface the split when a large range
  // (e.g. DEPLOY_BLOCK → latest) is involved.
  if (chunks.length > 1 || results.length > 0) {
    log(`getLogs ${address} ${fromBlock}-${toBlock}: ${chunks.length} chunk(s), ${results.length} log(s)`)
  }
  return results
}

class Keeper {
  private readonly account: PrivateKeyAccount
  private readonly publicClient: PublicClient
  private readonly walletClient: WalletClient
  private readonly users = new Set<Address>()
  /** Queued proposals; expired ones are pruned each tick so history stays bounded. */
  private readonly proposals = new Map<bigint, QueuedProposal>()
  private ruleCursor: bigint
  private proposalCursor: bigint
  private readonly handled = new Set<string>()

  constructor(private readonly config: Config) {
    this.account = privateKeyToAccount(config.keeperKey as `0x${string}`)
    const transport = http(config.rpcUrl)
    this.publicClient = createPublicClient({ chain: avalancheFuji, transport })
    this.walletClient = createWalletClient({
      account: this.account,
      chain: avalancheFuji,
      transport,
    })
    // Cursors are inclusive; start one block below so the first scan begins at DEPLOY_BLOCK.
    this.ruleCursor = config.deployBlock - 1n
    this.proposalCursor = config.deployBlock - 1n
  }

  async run(signal: AbortSignal): Promise<void> {
    const chainId = await this.publicClient.getChainId()
    if (chainId !== FUJI_CHAIN_ID) {
      throw new Error(`unexpected chain ${chainId}; expected Fuji ${FUJI_CHAIN_ID}`)
    }
    log(
      `Keeper online. chain=${chainId} govExit=${this.config.govExit} ` +
        `governance=${this.config.governance} keeper=${this.account.address} ` +
        `deployBlock=${this.config.deployBlock} poll=${this.config.pollIntervalMs}ms ` +
        `chunk=${this.config.logChunkSize}`,
    )
    while (!signal.aborted) {
      try {
        await this.tick()
      } catch (error) {
        // A transient failure in one tick must not silently kill the Keeper;
        // log it, back off, and retry so the 60s Timelock window can still be caught.
        log(`tick failed: ${error instanceof Error ? error.message : String(error)}`)
      }
      await sleep(this.config.pollIntervalMs)
    }
  }

  /**
   * One bounded, deadline-aware pass. The working set is pruned to live
   * windows and armed rules before any pair work, and each pair's failure is
   * isolated so one RPC error cannot consume the remaining Timelock budget.
   */
  private async tick(): Promise<void> {
    const block = await this.publicClient.getBlock({ blockTag: 'latest' })
    const latest = block.number
    if (latest === null) return
    const chainNow = block.timestamp
    await this.scanRules(latest)
    await this.scanProposals(latest)

    // Drop proposals whose window has closed: the contract refuses them, and
    // rescanning dead history is what made a fresh 60s window unreachable.
    const live = liveProposals(this.proposals.values(), chainNow)
    if (live.length !== this.proposals.size) {
      this.proposals.clear()
      for (const proposal of live) {
        this.proposals.set(proposal.id, proposal)
      }
    }
    if (this.users.size === 0 || this.proposals.size === 0) {
      return
    }

    // One rule read per user per tick (never per pair), with per-user failure
    // isolation: a failed read keeps the user armed for the next tick.
    const rules = await this.readRulesOnce()
    this.pruneDisarmedUsers(rules)

    // Nearest deadline first, so the most urgent window is acted on before
    // any other pair work can consume it.
    const candidates = actionableCandidates(this.users, rules, this.proposals.values(), chainNow)
    if (candidates.length === 0) {
      return
    }
    log(
      `Actionable pairs: ${candidates.length}; nearest deadline in ` +
        `${Number(candidates[0].executeAfter - chainNow)}s`,
    )
    for (const candidate of candidates) {
      try {
        await this.attemptExit(candidate, rules)
      } catch (error) {
        // Isolated per pair: one failure must not skip the remaining windows.
        log(
          `pair failed: user=${candidate.user} proposalId=${candidate.proposalId}: ` +
            `${error instanceof Error ? error.message.split('\n')[0] : String(error)}`,
        )
      }
    }
  }

  private async scanRules(latest: bigint): Promise<void> {
    if (latest <= this.ruleCursor) return
    const logs = await getLogsChunked(
      this.publicClient,
      this.config.govExit,
      ruleCreatedEvent,
      this.ruleCursor + 1n,
      latest,
      this.config.logChunkSize,
    )
    for (const entry of logs) {
      const user = entry.args.user as Address
      if (user) {
        this.users.add(getAddress(user))
      }
    }
    if (logs.length > 0) {
      log(`Protected users: ${this.users.size}`)
    }
    this.ruleCursor = latest
  }

  private async scanProposals(latest: bigint): Promise<void> {
    if (latest <= this.proposalCursor) return
    const logs = await getLogsChunked(
      this.publicClient,
      this.config.governance,
      proposalQueuedEvent,
      this.proposalCursor + 1n,
      latest,
      this.config.logChunkSize,
    )
    for (const entry of logs) {
      const id = entry.args.proposalId as bigint
      const newThresholdBps = entry.args.newThreshold as bigint
      const executeAfter = entry.args.executeAfter as bigint
      if (id !== undefined) {
        this.proposals.set(id, { id, newThresholdBps, executeAfter })
        log(`Proposal detected: id=${id} newThreshold=${newThresholdBps} executeAfter=${executeAfter}`)
      }
    }
    this.proposalCursor = latest
  }

  /** One rule read per armed user per tick, isolated per user. */
  private async readRulesOnce(): Promise<Map<string, RuleState>> {
    const results = await Promise.allSettled(
      [...this.users].map(async (user) => {
        const rule = await this.readRule(user)
        return [user.toLowerCase(), rule] as const
      }),
    )
    const rules = new Map<string, RuleState>()
    for (const result of results) {
      if (result.status === 'fulfilled') {
        rules.set(result.value[0], result.value[1])
      } else {
        log(
          `rule read failed: ` +
            `${result.reason instanceof Error ? result.reason.message.split('\n')[0] : String(result.reason)}`,
        )
      }
    }
    return rules
  }

  /**
   * Prune users whose rule can no longer act, so the per-tick rule reads stay
   * proportional to armed rules, not to history. Only a *successful* read
   * prunes — a failed read keeps the user armed. A re-arm (RuleCreated) adds
   * the user back on its next scan.
   */
  private pruneDisarmedUsers(rules: ReadonlyMap<string, RuleState>): void {
    for (const user of this.users) {
      const rule = rules.get(user.toLowerCase())
      if (rule !== undefined && !isActionable(rule)) {
        this.users.delete(user)
      }
    }
  }

  private async readRule(user: Address): Promise<RuleState> {
    const [minimumThresholdBps, active, triggered] = await this.publicClient.readContract({
      address: this.config.govExit,
      abi: govExitAbi,
      functionName: 'rules',
      args: [user],
    })
    return { minimumThresholdBps, active, triggered }
  }

  private async attemptExit(
    candidate: ExitCandidate,
    rules: ReadonlyMap<string, RuleState>,
  ): Promise<void> {
    const user = getAddress(candidate.user)
    const dedupeKey = `${user.toLowerCase()}:${candidate.proposalId}`
    if (this.handled.has(dedupeKey)) return
    const rule = rules.get(user.toLowerCase())
    if (rule === undefined) return

    const shouldExitNow = await this.publicClient.readContract({
      address: this.config.govExit,
      abi: govExitAbi,
      functionName: 'shouldExit',
      args: [user, candidate.proposalId],
    })
    if (!decideExit(rule, shouldExitNow)) return

    log(`Rule trips: user=${user} proposalId=${candidate.proposalId} minimum=${rule.minimumThresholdBps}`)
    try {
      // Simulate first so the Keeper never broadcasts a guaranteed revert.
      const { request } = await this.publicClient.simulateContract({
        account: this.account,
        address: this.config.govExit,
        abi: govExitAbi,
        functionName: 'checkAndExit',
        args: [user, candidate.proposalId],
      })
      const hash = await this.walletClient.writeContract(request)
      log(`checkAndExit sent: user=${user} proposalId=${candidate.proposalId} tx=${hash}`)
      const receipt = await this.publicClient.waitForTransactionReceipt({ hash })
      log(`checkAndExit mined: tx=${hash} block=${receipt.blockNumber} status=${receipt.status}`)
      // Mark handled only on a successful receipt: a reverted exit must be
      // retried while its window is still open, not suppressed forever.
      if (receipt.status === 'success') {
        this.handled.add(dedupeKey)
      }
    } catch (error) {
      // The Timelock may have elapsed between shouldExit and send; that is a
      // no-op, not a Keeper failure.
      log(
        `checkAndExit skipped for user=${user} proposalId=${candidate.proposalId}: ` +
          `${error instanceof Error ? error.message.split('\n')[0] : String(error)}`,
      )
    }
  }
}

async function main(): Promise<void> {
  const config = loadConfig()
  const controller = new AbortController()
  const stop = (signal: string) => {
    log(`${signal} received; stopping`)
    controller.abort()
  }
  process.on('SIGINT', () => stop('SIGINT'))
  process.on('SIGTERM', () => stop('SIGTERM'))

  const keeper = new Keeper(config)
  await keeper.run(controller.signal)
}

main().catch((error) => {
  console.error(`[keeper] fatal: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
