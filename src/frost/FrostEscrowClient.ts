// A ZcashClient whose payout path is a 2-of-3 FROST threshold signature instead
// of a single custodial key. Drop-in for the game: Match.ts calls sendShielded
// exactly as before, but here that means "build the payout, threshold-sign its
// sighash with the real FROST tooling, then broadcast."
//
// What's real vs. local:
//   - The 2-of-3 group setup and the threshold signature are REAL (frost-client,
//     RedPallas) when the binaries are built.
//   - Building the Orchard payout transaction + broadcasting it is the final
//     step that needs the librustzcash/lightwalletd stack and a funded testnet
//     wallet; it runs on your machine. The sighash to be signed is produced
//     there and handed to thresholdSign; the returned signature is injected via
//     zcash-sign to assemble the broadcastable transaction.
//
// This keeps the game code untouched while making escrow genuinely non-custodial
// at the signing layer.

import { ZcashClient, IncomingPayment, SendResult, Network } from "../zcash/ZcashClient.js";
import {
  FrostConfig,
  SignerName,
  setupMatchGroup,
  thresholdSign,
} from "./FrostOrchestrator.js";

export interface PayoutBuilder {
  /**
   * Build the unsigned payout transaction and return the sighash bytes to be
   * threshold-signed, plus a finalize() that injects the signature (via
   * zcash-sign) and broadcasts. Implemented against librustzcash/lightwalletd
   * on the host; stubbed clearly otherwise.
   */
  buildPayout(opts: {
    toAddress: string;
    valueZat: number;
    memo?: string;
    groupPublicKey: string;
  }): Promise<{ sighash: Buffer; finalize: (signatureHex: string) => Promise<{ txid: string }> }>;

  /** Watch the FROST group address for an incoming shielded deposit. */
  watchDeposit(opts: {
    groupPublicKey: string;
    memo: string;
    minValueZat: number;
    minConfirmations: number;
    timeoutMs: number;
  }): Promise<IncomingPayment>;

  /** The shielded receive address for the match's FROST group. */
  groupAddress(groupPublicKey: string): Promise<string>;

  getBalanceZat(groupPublicKey: string): Promise<number>;
}

export class FrostEscrowClient implements ZcashClient {
  readonly network: Network;
  private group?: { configs: Record<SignerName, string>; groupPublicKey: string };

  constructor(
    network: Network,
    private matchId: string,
    private frost: FrostConfig,
    private payout: PayoutBuilder,
    private serverUrl: string,
    /** Which two parties co-sign this payout. Default: winner-side + referee. */
    private signers: [SignerName, SignerName] = ["referee", "player-a"],
  ) {
    this.network = network;
  }

  /** Lazily create the 2-of-3 group and return its shielded address. */
  async getReceiveAddress(): Promise<string> {
    const g = await this.ensureGroup();
    return this.payout.groupAddress(g.groupPublicKey);
  }

  private async ensureGroup() {
    if (!this.group) {
      this.group = await setupMatchGroup(this.frost, this.matchId);
    }
    return this.group;
  }

  async waitForPayment(opts: {
    memo: string;
    minValueZat: number;
    minConfirmations: number;
    timeoutMs: number;
  }): Promise<IncomingPayment> {
    const g = await this.ensureGroup();
    return this.payout.watchDeposit({ groupPublicKey: g.groupPublicKey, ...opts });
  }

  /**
   * The payout. This is where escrow becomes non-custodial: the transaction is
   * authorized by a 2-of-3 threshold signature, not a single server key.
   */
  async sendShielded(opts: {
    toAddress: string;
    valueZat: number;
    memo?: string;
  }): Promise<SendResult> {
    const g = await this.ensureGroup();

    // 1. Build the unsigned payout; get the sighash to sign.
    const built = await this.payout.buildPayout({
      ...opts,
      groupPublicKey: g.groupPublicKey,
    });

    // 2. Produce the REAL 2-of-3 RedPallas threshold signature over the sighash.
    const sig = await thresholdSign(this.frost, {
      matchId: this.matchId,
      configs: g.configs,
      groupPublicKey: g.groupPublicKey,
      signers: this.signers,
      message: built.sighash,
      serverUrl: this.serverUrl,
    });

    // 3. Inject the signature, assemble, and broadcast.
    const { txid } = await built.finalize(sig.signatureHex);
    return { txid };
  }

  async getBalanceZat(): Promise<number> {
    const g = await this.ensureGroup();
    return this.payout.getBalanceZat(g.groupPublicKey);
  }
}
