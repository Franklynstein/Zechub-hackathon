// Board commitment scheme.
//
// The problem: in a wagered game, neither player should be able to (a) see the
// opponent's board, nor (b) move their own ships after play starts to dodge a
// loss. A hash commitment solves both.
//
// Protocol:
//   1. Before play, each player builds their board locally and a random 32-byte
//      salt. They compute commitment = SHA256(canonical(board) || salt) and
//      send ONLY the commitment to the server. The board stays hidden.
//   2. During play, the server arbitrates hits/misses. (In this POC the server
//      holds the revealed board to answer shots; the commitment guarantees it
//      can't have been altered. A fully trustless version answers each shot
//      with a per-cell proof — noted as the upgrade path.)
//   3. At settlement, each board is checked against its commitment. A mismatch
//      voids the match and triggers refunds — cheating cannot pay.
//
// This is deliberately simple and standard (hash commitment); it's the right
// amount of crypto for a hackathon POC while telling an honest fairness story.

import { Board, ShipPlacement } from "../shared/types.js";
import { createHash, randomBytes } from "node:crypto";

/** Deterministic, canonical serialization so the same board always hashes the same. */
export function canonicalizeBoard(board: Board): string {
  const sorted = [...board.placements].sort((a, b) =>
    a.ship < b.ship ? -1 : a.ship > b.ship ? 1 : 0,
  );
  const parts = sorted.map(
    (p: ShipPlacement) => `${p.ship}:${p.origin.x},${p.origin.y}:${p.orientation}`,
  );
  return parts.join("|");
}

export function makeSalt(): string {
  return randomBytes(32).toString("hex");
}

export function commitBoard(board: Board, salt: string): string {
  return createHash("sha256")
    .update(canonicalizeBoard(board))
    .update("|")
    .update(salt)
    .digest("hex");
}

export function verifyCommitment(board: Board, salt: string, commitment: string): boolean {
  return commitBoard(board, salt) === commitment;
}
