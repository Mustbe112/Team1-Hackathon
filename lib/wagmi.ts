import { createConfig, http } from "wagmi";
import { avalancheFuji } from "wagmi/chains";
import { injected } from "wagmi/connectors";

import { env } from "@/lib/env";

/**
 * The one place chain + provider details live. Panels (issues 13-15) import
 * hooks from wagmi; they never touch `window.ethereum` or `process.env`.
 *
 * `multiInjectedProviderDiscovery` enables EIP-6963 discovery, so every wallet
 * extension that announces itself (Core included) appears as its own connector
 * instead of the last extension to win `window.ethereum`.
 */
export const wagmiConfig = createConfig({
  chains: [avalancheFuji],
  connectors: [injected()],
  multiInjectedProviderDiscovery: true,
  ssr: true,
  transports: {
    [avalancheFuji.id]: http(env.rpcUrl),
  },
});

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}
