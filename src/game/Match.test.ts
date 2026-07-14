import { test } from "node:test";
import assert from "node:assert/strict";
import { Match } from "./Match.js";
import { SimulatedZcashClient } from "../zcash/SimulatedZcashClient.js";
import { commitBoard, makeSalt } from "./commitment.js";
import { Board, Coord } from "../shared/types.js";
import { zecToZat } from "../zcash/ZcashClient.js";

// Two simple, valid, non-overlapping boards.
function boardA(): Board {
  return {
    placements: [
      { ship: "carrier", origin: { x: 0, y: 0 }, orientation: "horizontal" },
      { ship: "battleship", origin: { x: 0, y: 1 }, orientation: "horizontal" },
      { ship: "cruiser", origin: { x: 0, y: 2 }, orientation: "horizontal" },
      { ship: "submarine", origin: { x: 0, y: 3 }, orientation: "horizontal" },
      { ship: "destroyer", origin: { x: 0, y: 4 }, orientation: "horizontal" },
    ],
  };
}
function boardB(): Board {
  return {
    placements: [
      { ship: "carrier", origin: { x: 9, y: 0 }, orientation: "vertical" },
      { ship: "battleship", origin: { x: 8, y: 0 }, orientation: "vertical" },
      { ship: "cruiser", origin: { x: 7, y: 0 }, orientation: "vertical" },
      { ship: "submarine", origin: { x: 6, y: 0 }, orientation: "vertical" },
      { ship: "destroyer", origin: { x: 5, y: 0 }, orientation: "vertical" },
    ],
  };
}

// All cells occupied by board B, so A can sink everything.
function allCellsOf(board: Board): Coord[] {
  const cells: Coord[] = [];
  for (const p of board.placements) {
    const size = { carrier: 5, battleship: 4, cruiser: 3, submarine: 3, destroyer: 2 }[p.ship];
    for (let i = 0; i < size; i++) {
      cells.push({
        x: p.origin.x + (p.orientation === "horizontal" ? i : 0),
        y: p.origin.y + (p.orientation === "vertical" ? i : 0),
      });
    }
  }
  return cells;
}

test("full match: stake, play, winner takes pot", async () => {
  const zcash = new SimulatedZcashClient("testnet");
  const stake = 0.1;
  const match = new Match("test01", stake, zcash);
  await match.ensureDepositAddress();

  // Join
  const slotA = match.join("utest1winnerAddressAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
  const slotB = match.join("utest1loserAddressBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB");
  assert.equal(slotA, "a");
  assert.equal(slotB, "b");
  assert.equal(match.currentPhase, "awaiting_deposits");

  // Deposits (simulate both players sending stake with their memo)
  for (const slot of ["a", "b"] as const) {
    const memo = match.memoFor(slot);
    zcash.simulateIncoming(memo, zecToZat(stake));
    const pay = await zcash.waitForPayment({
      memo,
      minValueZat: zecToZat(stake),
      minConfirmations: 1,
      timeoutMs: 30_000,
    });
    match.markDepositConfirmed(slot, pay.txid);
  }
  assert.equal(match.currentPhase, "placing");

  // Commit + place boards
  const bA = boardA();
  const saltA = makeSalt();
  match.commitAndPlace("a", bA, saltA, commitBoard(bA, saltA));
  const bB = boardB();
  const saltB = makeSalt();
  match.commitAndPlace("b", bB, saltB, commitBoard(bB, saltB));
  assert.equal(match.currentPhase, "in_play");

  // Player A sinks every B ship. B never effectively retaliates enough.
  const targets = allCellsOf(bB);
  let won = false;
  for (const cell of targets) {
    const shot = match.fire("a", cell);
    if (shot.result === "win") {
      won = true;
      break;
    }
    // B fires a harmless shot into open water to pass the turn back.
    if (match.currentPhase === "in_play") {
      match.fire("b", { x: 0, y: 9 });
    }
  }
  assert.ok(won, "Player A should have won");
  assert.equal(match.currentPhase, "settling");

  // Settle: winner gets the pot (2 * stake minus network fee)
  const result = await match.settle();
  assert.ok("txid" in result, "settlement should produce a payout txid");
  assert.equal(match.currentPhase, "complete");

  const view = match.viewFor("a");
  assert.equal(view.winner, "a");
  assert.ok(view.payoutTxid);
});

test("commitment mismatch voids settlement", async () => {
  const zcash = new SimulatedZcashClient("testnet");
  const match = new Match("test02", 0.1, zcash);
  const b = boardA();
  const salt = makeSalt();
  const wrongCommitment = commitBoard(boardB(), salt); // commit to a different board
  assert.throws(() => {
    // commitAndPlace verifies board matches commitment up front.
    match.join("addr1");
    match.join("addr2");
    match.markDepositConfirmed("a", "tx1");
    match.markDepositConfirmed("b", "tx2");
    match.commitAndPlace("a", b, salt, wrongCommitment);
  });
});
