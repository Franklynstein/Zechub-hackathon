// The Zcash integration boundary.
//
// Everything the game needs from the chain goes through this interface:
//   - derive a per-match shielded receive address
//   - watch for an incoming shielded payment carrying a specific memo
//   - send a shielded payout to a winner
//
// Two implementations live alongside this file:
//   - SimulatedZcashClient: deterministic, no node required. Used for local dev
//     and for a reproducible demo. It models confirmation delay and memos.
//   - LightwalletdZcashClient: talks to a real lightwalletd + wallet over the
//     Zcash light-client protocol. Swapping testnet -> mainnet is a config
//     change (lightwalletd endpoint + funded wallet seed), not a code change.
//
// The rest of the app NEVER imports a concrete client; it only depends on this
// interface, which is what keeps the chain layer replaceable.

export type Network = "testnet" | "mainnet";

export type IncomingPayment = {
  txid: string;
  /** Value in zatoshis (1 ZEC = 1e8 zat). */
  valueZat: number;
  /** Decrypted memo string, if any. We use this to attribute a deposit to a match+player. */
  memo: string | null;
  confirmations: number;
};

export type SendResult = {
  txid: string;
};

export interface ZcashClient {
  readonly network: Network;

  /**
   * A shielded unified/sapling address this wallet can receive to. For a POC we
   * can reuse one wallet address per match and disambiguate deposits by memo;
   * a production build would derive a fresh diversified address per match.
   */
  getReceiveAddress(): Promise<string>;

  /**
   * Resolve once a payment matching `memo` has reached `minConfirmations`.
   * Returns the matching payment. Implementations may poll the chain.
   */
  waitForPayment(opts: {
    memo: string;
    minValueZat: number;
    minConfirmations: number;
    timeoutMs: number;
  }): Promise<IncomingPayment>;

  /**
   * Send a shielded payment. `memo` is optional and rides in the encrypted
   * memo field (<=512 bytes), e.g. "ZEC Battleship payout — match abcd1234".
   */
  sendShielded(opts: {
    toAddress: string;
    valueZat: number;
    memo?: string;
  }): Promise<SendResult>;

  /** Current spendable balance in zatoshis (for the escrow wallet). */
  getBalanceZat(): Promise<number>;
}

export const ZAT_PER_ZEC = 100_000_000;

export function zecToZat(zec: number): number {
  return Math.round(zec * ZAT_PER_ZEC);
}

export function zatToZec(zat: number): number {
  return zat / ZAT_PER_ZEC;
}
