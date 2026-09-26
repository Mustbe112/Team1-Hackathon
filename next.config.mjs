/** @type {import('next').NextConfig} */
const nextConfig = {
  webpack: (config) => {
    // wagmi/connectors re-exports the (unused) Base Account connector, which
    // pulls in @base-org/account -> @coinbase/cdp-sdk -> optional @x402/* packages
    // that are not installed. The dashboard only uses `injected`, so stub the
    // optional @x402 namespace out of the bundle.
    config.resolve.alias = {
      ...config.resolve.alias,
      "@x402": false,
      // Optional peers of the MetaMask SDK / WalletConnect connectors, which
      // this dashboard does not use.
      "@react-native-async-storage/async-storage": false,
      "pino-pretty": false,
    };
    return config;
  },
};

export default nextConfig;
