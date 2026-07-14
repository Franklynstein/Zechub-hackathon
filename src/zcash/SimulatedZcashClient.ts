// A deterministic, node-free implementation of ZcashClient.
//
// It faithfully models the parts of Zcash the game depends on:
//   - shielded addresses
//   - memo-attributed incoming payments
//   - confirmation delay (a deposit isn't "confirmed" instantly)
//   - shielded sends that return a txid
//
// This is what runs in the demo by default so the full game loop — stake,
// play, payout — is reproducible without a funded wallet. The interface it
// implements is identical to the real one, so the game code can't tell the
// difference.

import {
  ZcashClient,
  IncomingPayment,
  SendResult,
  Network,
  ZAT_PER_ZEC,
} from "./ZcashClient.js";
import { randomBytes, createHash } from "node:crypto";

type PendingDeposit = {
  memo: string;
  valueZat: number;
  createdAt: number;
  txid: string;
};

/** Block time on Zcash is ~75s; we compress it for the demo but keep it real-feeling. */
const SIMULATED_BLOCK_MS = 4_000;

export class SimulatedZcashClient implements ZcashClient {
  readonly network: Network;
  private address: string;
  private balanceZat = 0;
  private deposits: PendingDeposit[] = [];

  constructor(network: Network = "testnet") {
    this.network = network;
    // A plausible-looking shielded address. Real ones are bech32m; this is a
    // stand-in used only by the simulator.
    const tag = network === "mainnet" ? "u1" : "utest1";
    this.address = tag + createHash("sha256").update(randomBytes(32)).digest("hex").slice(0, 60);
  }

  async getReceiveAddress(): Promise<string> {
    return this.address;
  }

  /**
   * Called by the demo harness (or a test) to simulate a player actually
   * sending their stake with a given memo. In a real deployment this event
   * comes from the chain, not from us.
   */
  simulateIncoming(memo: string, valueZat: number): string {
    const txid = createHash("sha256")
      .update(randomBytes(32))
      .digest("hex");
    this.deposits.push({ memo, valueZat, createdAt: Date.now(), txid });
    return txid;
  }

  async waitForPayment(opts: {
    memo: string;
    minValueZat: number;
    minConfirmations: number;
    timeoutMs: number;
  }): Promise<IncomingPayment> {
    const deadline = Date.now() + opts.timeoutMs;
    // Poll our in-memory mempool until a matching, sufficiently-confirmed deposit appears.
    while (Date.now() < deadline) {
      const match = this.deposits.find(
        (d) => d.memo === opts.memo && d.valueZat >= opts.minValueZat,
      );
      if (match) {
        const elapsed = Date.now() - match.createdAt;
        const confirmations = Math.floor(elapsed / SIMULATED_BLOCK_MS);
        if (confirmations >= opts.minConfirmations) {
          this.balanceZat += match.valueZat;
          return {
            txid: match.txid,
            valueZat: match.valueZat,
            memo: match.memo,
            confirmations,
          };
        }
      }
      await sleep(300);
    }
    throw new Error(`Timed out waiting for payment with memo "${opts.memo}"`);
  }

  async sendShielded(opts: {
    toAddress: string;
    valueZat: number;
    memo?: string;
  }): Promise<SendResult> {
    if (opts.valueZat > this.balanceZat) {
      throw new Error(
        `Insufficient escrow balance: have ${this.balanceZat} zat, need ${opts.valueZat} zat`,
      );
    }
    this.balanceZat -= opts.valueZat;
    const txid = createHash("sha256")
      .update(randomBytes(32))
      .update(opts.toAddress)
      .update(String(opts.valueZat))
      .digest("hex");
    return { txid };
  }

  async getBalanceZat(): Promise<number> {
    return this.balanceZat;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
