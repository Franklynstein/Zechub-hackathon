// Holds all active matches and orchestrates the deposit-watching side effects.
// Single-process, in-memory store — appropriate for a POC.

import { Match } from "../game/Match.js";
import { ZcashClient, zecToZat } from "../zcash/ZcashClient.js";
import { PlayerSlot } from "../shared/types.js";
import { randomBytes } from "node:crypto";

export type DepositWatcher = (matchId: string, slot: PlayerSlot, txid: string) => void;

export class MatchRegistry {
  private matches = new Map<string, Match>();

  constructor(private zcash: ZcashClient) {}

  async create(stakeZec: number): Promise<Match> {
    const id = randomBytes(4).toString("hex");
    const match = new Match(id, stakeZec, this.zcash);
    await match.ensureDepositAddress();
    this.matches.set(id, match);
    return match;
  }

  get(id: string): Match | undefined {
    return this.matches.get(id);
  }

  list(): Match[] {
    return [...this.matches.values()];
  }

  /**
   * Begin watching the chain for a player's stake. When it confirms, mark the
   * deposit and invoke the callback so the server can push an update.
   * On the simulator, the matching `simulateIncoming` is triggered by the
   * client pressing "I've sent it" (the demo stand-in for a real wallet send).
   */
  watchDeposit(match: Match, slot: PlayerSlot, onConfirmed: DepositWatcher): void {
    const memo = match.memoFor(slot);
    this.zcash
      .waitForPayment({
        memo,
        minValueZat: zecToZat(match.stakeZec),
        minConfirmations: 1,
        timeoutMs: 10 * 60_000,
      })
      .then((pay) => {
        match.markDepositConfirmed(slot, pay.txid);
        onConfirmed(match.id, slot, pay.txid);
      })
      .catch((err) => {
        console.error(`Deposit watch failed for ${match.id}/${slot}:`, err.message);
      });
  }
}
