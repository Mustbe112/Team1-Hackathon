/**
 * Single accessor for every `NEXT_PUBLIC_*` value the dashboard reads.
 *
 * Next.js inlines `process.env.NEXT_PUBLIC_*` references at build time, so each
 * variable must be referenced by its full literal name (not looked up
 * dynamically). Contract addresses are intentionally optional here so the shell
 * still renders on a fresh checkout; panels land in issues 13-15.
 */

const rpcUrl = process.env.NEXT_PUBLIC_RPC_URL;

if (!rpcUrl) {
  throw new Error(
    "NEXT_PUBLIC_RPC_URL is not set. Copy .env.example to .env and fill in the Fuji RPC.",
  );
}

function asAddress(value: string | undefined): `0x${string}` | undefined {
  return value && /^0x[0-9a-fA-F]{40}$/.test(value) ? (value as `0x${string}`) : undefined;
}

/** The canonical Fuji deployment block; log scans start here. */
const DEFAULT_DEPLOY_BLOCK = 58722211n;

function asBlockNumber(value: string | undefined): bigint {
  return value && /^\d+$/.test(value) ? BigInt(value) : DEFAULT_DEPLOY_BLOCK;
}

export const env = {
  chainId: Number(process.env.NEXT_PUBLIC_CHAIN_ID ?? 43113),
  rpcUrl,
  deployBlock: asBlockNumber(process.env.NEXT_PUBLIC_DEPLOY_BLOCK),
  addresses: {
    govExit: asAddress(process.env.NEXT_PUBLIC_GOVEXIT_ADDRESS),
    governance: asAddress(process.env.NEXT_PUBLIC_GOVERNANCE_ADDRESS),
    lendingPool: asAddress(process.env.NEXT_PUBLIC_LENDING_POOL_ADDRESS),
    mockUsdc: asAddress(process.env.NEXT_PUBLIC_MOCK_USDC_ADDRESS),
  },
} as const;
