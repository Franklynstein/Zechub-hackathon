// A single match: the state machine that ties Battleship gameplay to the
// shielded-ZEC escrow lifecycle.
//
// Lifecycle:
//   awaiting_players -> awaiting_deposits -> placing -> in_play -> settling -> complete
// with a `void` branch for refunds (commitment mismatch, timeout, etc).
//
// The Match owns: the secret boards, the per-player commitments, the shot
// history, whose turn it is, and the winner. It talks to the chain only through
// the injected ZcashClient, so it has no idea whether it's on the simulator,
// testnet, or mainnet.

import {
  Board,
  MatchPhase,
  PlayerSlot,
  Shot,
  Coord,
  ShotResult,
  ShipName,
  MatchStateForClient,
  PlayerView,
} from "../shared/types.js";
import { validateBoard, occupancyMap, coordKey } from "./board.js";
import { verifyCommitment } from "./commitment.js";
import { ZcashClient, zecToZat as toZat } from "../zcash/ZcashClient.js";

type PlayerState = {
  slot: PlayerSlot;
  joined: boolean;
  payoutAddress?: string;
  depositConfirmed: boolean;
  depositTxid?: string;
  depositMemo: string;
  commitment?: string;
  // The server learns the board at placement time to arbitrate shots. The
  // commitment (made before deposits are even confirmed in spirit) ensures it
  // can't be changed mid-game. Salt is kept for end-of-game verification.
  board?: Board;
  salt?: string;
  hitsAgainst: Set<string>; // cells of THIS player's ships that have been hit
};

const FEE_BPS = 0; // POC takes no rake; pot pays out in full minus network fee.
const ZCASH_NETWORK_FEE_ZAT = 10_000; // ~0.0001 ZEC, illustrative.

export class Match {
  readonly id: string;
  readonly stakeZec: number;
  private phase: MatchPhase = "awaiting_players";
  private players: Record<PlayerSlot, PlayerState>;
  private turn: PlayerSlot = "a";
  private shots: Shot[] = [];
  private winner: PlayerSlot | null = null;
  private payoutTxid: string | null = null;
  private depositAddress: string | null = null;

  constructor(
    id: string,
    stakeZec: number,
    private zcash: ZcashClient,
  ) {
    this.id = id;
    this.stakeZec = stakeZec;
    this.players = {
      a: this.freshPlayer("a"),
      b: this.freshPlayer("b"),
    };
  }

  private freshPlayer(slot: PlayerSlot): PlayerState {
    return {
      slot,
      joined: false,
      depositConfirmed: false,
      depositMemo: `zbs-${this.id}-${slot}`,
      hitsAgainst: new Set(),
    };
  }

  get currentPhase(): MatchPhase {
    return this.phase;
  }

  async ensureDepositAddress(): Promise<string> {
    if (!this.depositAddress) {
      this.depositAddress = await this.zcash.getReceiveAddress();
    }
    return this.depositAddress;
  }

  join(payoutAddress: string): PlayerSlot {
    const slot: PlayerSlot | null = !this.players.a.joined
      ? "a"
      : !this.players.b.joined
        ? "b"
        : null;
    if (!slot) throw new Error("Match is full.");
    this.players[slot].joined = true;
    this.players[slot].payoutAddress = payoutAddress;
    if (this.players.a.joined && this.players.b.joined) {
      this.phase = "awaiting_deposits";
    }
    return slot;
  }

  /** Record a confirmed deposit for a slot. Advances to `placing` when both are in. */
  markDepositConfirmed(slot: PlayerSlot, txid: string): void {
    this.players[slot].depositConfirmed = true;
    this.players[slot].depositTxid = txid;
    if (this.players.a.depositConfirmed && this.players.b.depositConfirmed) {
      this.phase = "placing";
    }
  }

  memoFor(slot: PlayerSlot): string {
    return this.players[slot].depositMemo;
  }

  /** Player commits their board hash and reveals the board to the server arbiter. */
  commitAndPlace(slot: PlayerSlot, board: Board, salt: string, commitment: string): void {
    if (this.phase !== "placing") throw new Error("Not in placing phase.");
    const v = validateBoard(board);
    if (!v.ok) throw new Error(v.reason);
    if (!verifyCommitment(board, salt, commitment)) {
      throw new Error("Board does not match its commitment.");
    }
    const p = this.players[slot];
    p.board = board;
    p.salt = salt;
    p.commitment = commitment;

    if (this.players.a.board && this.players.b.board) {
      this.phase = "in_play";
      this.turn = "a";
    }
  }

  private opponentOf(slot: PlayerSlot): PlayerSlot {
    return slot === "a" ? "b" : "a";
  }

  /** Fire a shot. Returns the result; advances turn unless the game is won. */
  fire(slot: PlayerSlot, at: Coord): Shot {
    if (this.phase !== "in_play") throw new Error("Match is not in play.");
    if (this.turn !== slot) throw new Error("Not your turn.");

    const opp = this.players[this.opponentOf(slot)];
    if (!opp.board) throw new Error("Opponent board missing.");

    const occ = occupancyMap(opp.board);
    const key = coordKey(at);
    const ship = occ.get(key);

    let result: ShotResult;
    let sunkShip: ShipName | undefined;

    if (!ship) {
      result = "miss";
    } else {
      opp.hitsAgainst.add(key);
      const sunk = this.isShipSunk(opp, ship);
      if (sunk && this.allShipsSunk(opp)) {
        result = "win";
        this.winner = slot;
        this.phase = "settling";
      } else if (sunk) {
        result = "sunk";
        sunkShip = ship;
      } else {
        result = "hit";
      }
    }

    const shot: Shot = { by: slot, at, result, sunkShip };
    this.shots.push(shot);
    if (result === "miss" || result === "hit" || result === "sunk") {
      this.turn = this.opponentOf(slot);
    }
    return shot;
  }

  private isShipSunk(p: PlayerState, ship: ShipName): boolean {
    if (!p.board) return false;
    const occ = occupancyMap(p.board);
    for (const [cell, s] of occ) {
      if (s === ship && !p.hitsAgainst.has(cell)) return false;
    }
    return true;
  }

  private allShipsSunk(p: PlayerState): boolean {
    if (!p.board) return false;
    const occ = occupancyMap(p.board);
    for (const cell of occ.keys()) {
      if (!p.hitsAgainst.has(cell)) return false;
    }
    return true;
  }

  /**
   * Settle: verify both boards against their commitments, then pay the pot to
   * the winner's address. A commitment mismatch voids the match.
   */
  async settle(): Promise<{ txid: string } | { voided: string }> {
    if (this.phase !== "settling" || !this.winner) {
      throw new Error("Match is not ready to settle.");
    }
    for (const slot of ["a", "b"] as PlayerSlot[]) {
      const p = this.players[slot];
      if (!p.board || !p.salt || !p.commitment || !verifyCommitment(p.board, p.salt, p.commitment)) {
        this.phase = "void";
        return { voided: `Board verification failed for player ${slot}.` };
      }
    }

    const winner = this.players[this.winner];
    if (!winner.payoutAddress) {
      this.phase = "void";
      return { voided: "Winner has no payout address." };
    }

    const potZat = toZat(this.stakeZec) * 2 - ZCASH_NETWORK_FEE_ZAT;
    const res = await this.zcash.sendShielded({
      toAddress: winner.payoutAddress,
      valueZat: potZat,
      memo: `ZEC Battleship — match ${this.id} payout to winner ${this.winner}`,
    });
    this.payoutTxid = res.txid;
    this.phase = "complete";
    return { txid: res.txid };
  }

  /** Build the view for one client, hiding the opponent's board. */
  viewFor(slot: PlayerSlot | null): MatchStateForClient {
    const toView = (p: PlayerState): PlayerView => ({
      slot: p.slot,
      joined: p.joined,
      depositConfirmed: p.depositConfirmed,
      boardCommitted: !!p.commitment,
      payoutAddress: p.payoutAddress,
    });

    const yourShots = slot ? this.shots.filter((s) => s.by === slot) : [];
    const shotsAgainstYou = slot ? this.shots.filter((s) => s.by !== slot) : [];

    return {
      matchId: this.id,
      phase: this.phase,
      you: slot,
      stakeZec: this.stakeZec,
      potZec: this.stakeZec * 2,
      depositAddress: this.depositAddress,
      depositMemo: slot ? this.players[slot].depositMemo : null,
      turn: this.phase === "in_play" ? this.turn : null,
      players: { a: toView(this.players.a), b: toView(this.players.b) },
      yourShots,
      shotsAgainstYou,
      winner: this.winner,
      payoutTxid: this.payoutTxid,
      network: this.zcash.network,
    };
  }
}
