// Selects which ZcashClient implementation to use, from env.
//
//   ZEC_BACKEND=simulator   -> SimulatedZcashClient (default; reproducible demo)
//   ZEC_BACKEND=lightwalletd -> LightwalletdZcashClient (testnet or mainnet)
//   ZEC_NETWORK=testnet|mainnet
//
// This is the ONLY place that knows which concrete client exists.

import { ZcashClient, Network } from "./ZcashClient.js";
import { SimulatedZcashClient } from "./SimulatedZcashClient.js";
import { LightwalletdZcashClient } from "./LightwalletdZcashClient.js";

const TESTNET_ENDPOINT = "https://lightwalletd.testnet.electriccoin.co:9067";
const MAINNET_ENDPOINT = "https://mainnet.lightwalletd.com:9067";

export function createZcashClient(): ZcashClient {
  const backend = (process.env.ZEC_BACKEND ?? "simulator").toLowerCase();
  const network = ((process.env.ZEC_NETWORK ?? "testnet").toLowerCase() as Network);

  if (backend === "simulator") {
    return new SimulatedZcashClient(network);
  }

  if (backend === "lightwalletd") {
    return new LightwalletdZcashClient({
      network,
      endpoint: network === "mainnet" ? MAINNET_ENDPOINT : TESTNET_ENDPOINT,
      walletSecretEnvVar: "ZEC_WALLET_SECRET",
    });
  }

  throw new Error(`Unknown ZEC_BACKEND "${backend}". Use "simulator" or "lightwalletd".`);
}
