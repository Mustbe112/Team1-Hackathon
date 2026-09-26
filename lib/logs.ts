/**
 * Incremental log scanner for the Governance panel (issue 14).
 *
 * The Fuji public RPC has no `eth_newFilter`, so events are discovered with
 * chunked `eth_getLogs` (the Keeper's `planChunks`), and the panel polls. To
 * avoid re-reading the whole `DEPLOY_BLOCK → latest` range on every poll, each
 * `key` keeps a cursor and an append-only log set in module memory; subsequent
 * calls only scan blocks newer than the cursor. Keys are per address+event+user,
 * so a scan never mixes contexts.
 */

import type { AbiEvent, Address, PublicClient } from "viem";

import { planChunks } from "@/keeper/logic";

/** The subset of a viem log the panel reads. */
export interface ChainLog {
  blockNumber: bigint | null;
  logIndex: number | null;
  transactionHash: `0x${string}` | null;
  args: Record<string, unknown>;
}

interface ScanCache {
  cursor: bigint;
  logs: ChainLog[];
}

const caches = new Map<string, ScanCache>();

export interface ScanLogsParams {
  /** Stable identity of this scan: address + event + any indexed filter. */
  key: string;
  publicClient: PublicClient;
  address: Address;
  event: AbiEvent;
  args?: Record<string, unknown>;
  fromBlock: bigint;
  chunkSize?: bigint;
}

/** Return every matching log from `fromBlock` to latest, scanning only new blocks. */
export async function scanLogsIncremental(params: ScanLogsParams): Promise<ChainLog[]> {
  const { key, publicClient, address, event, args, fromBlock, chunkSize = 2000n } = params;
  const latest = await publicClient.getBlockNumber();

  let cache = caches.get(key);
  if (!cache) {
    cache = { cursor: fromBlock - 1n, logs: [] };
    caches.set(key, cache);
  }

  if (latest > cache.cursor) {
    const found: ChainLog[] = [];
    for (const chunk of planChunks(cache.cursor + 1n, latest, chunkSize)) {
      const logs = await publicClient.getLogs({
        address,
        event,
        args,
        fromBlock: chunk.fromBlock,
        toBlock: chunk.toBlock,
      });
      for (const log of logs) {
        found.push(log as unknown as ChainLog);
      }
    }
    // Only advance after every chunk succeeds, so a 429 mid-scan is retried.
    cache.logs.push(...found);
    cache.cursor = latest;
  }

  return cache.logs;
}
