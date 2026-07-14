// Reference PayoutBuilder.
//
// This is the host-side piece that needs the librustzcash / lightwalletd stack
// and a funded testnet wallet. It is intentionally explicit about each
// integration point rather than pretending to broadcast from an environment
// that structurally can't.
//
// The flow it implements:
//   1. groupAddress: derive the shielded address for the match's FROST group
//      (Orchard receiver from the group verifying key).
//   2. watchDeposit: sync compact blocks via lightwalletd, trial-decrypt with
//      the group viewing key, match on memo.
//   3. buildPayout: construct the unsigned Orchard payout to the winner, return
//      the SIGHASH to be threshold-signed.
//   4. finalize: inject the FROST signature via zcash-sign (YWallet tx plan +
//      external signature) and broadcast through lightwalletd SendTransaction.
//
// On a Rust-capable host with the FROST binaries + a funded wallet, this runs
// for real. Here it throws with precise guidance so the contract is unambiguous.

import { PayoutBuilder } from "./FrostEscrowClient.js";
import { IncomingPayment } from "../zcash/ZcashClient.js";

export class ReferencePayoutBuilder implements PayoutBuilder {
  constructor(
    private opts: {
      lightwalletdEndpoint: string;
      zcashSignBin: string; // path to built `zcash-sign`
      network: "testnet" | "mainnet";
    },
  ) {}

  async groupAddress(groupPublicKey: string): Promise<string> {
    void groupPublicKey;
    throw hostStep(
      "groupAddress",
      "Derive an Orchard receiver from the FROST group verifying key.",
    );
  }

  async watchDeposit(opts: {
    groupPublicKey: string;
    memo: string;
    minValueZat: number;
    minConfirmations: number;
    timeoutMs: number;
  }): Promise<IncomingPayment> {
    void opts;
    throw hostStep(
      "watchDeposit",
      "Sync via lightwalletd, trial-decrypt with the group viewing key, match memo.",
    );
  }

  async buildPayout(opts: {
    toAddress: string;
    valueZat: number;
    memo?: string;
    groupPublicKey: string;
  }): Promise<{ sighash: Buffer; finalize: (sig: string) => Promise<{ txid: string }> }> {
    void opts;
    throw hostStep(
      "buildPayout",
      "Build the unsigned Orchard payout and return its sighash; finalize() injects " +
        "the FROST signature via zcash-sign and broadcasts.",
    );
  }

  async getBalanceZat(groupPublicKey: string): Promise<number> {
    void groupPublicKey;
    throw hostStep("getBalanceZat", "Query the group wallet balance via lightwalletd.");
  }
}

function hostStep(method: string, what: string): Error {
  return new Error(
    `ReferencePayoutBuilder.${method} is a host-side step: ${what} ` +
      `Run on a machine with librustzcash + lightwalletd and a funded ${"testnet"} wallet. ` +
      `The FROST threshold signature itself runs via frost-client (see frost-verify/ for a ` +
      `working 2-of-3 proof).`,
  );
}
