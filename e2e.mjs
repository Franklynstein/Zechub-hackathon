// Drives two WebSocket clients through a full match against the running server.
import WebSocket from "ws";

const URL = "ws://localhost:3007";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function client() {
  const ws = new WebSocket(URL);
  const inbox = [];
  ws.on("message", (d) => inbox.push(JSON.parse(d.toString())));
  const send = (o) => ws.send(JSON.stringify(o));
  const waitFor = async (pred, timeout = 15000) => {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const hit = inbox.find(pred);
      if (hit) return hit;
      await sleep(50);
    }
    throw new Error("timeout waiting for message");
  };
  const open = new Promise((res) => ws.on("open", res));
  return { ws, send, waitFor, inbox, open };
}

// SHA-256 commitment matching server scheme
import { createHash } from "node:crypto";
function canonical(board) {
  return [...board.placements]
    .sort((a, b) => (a.ship < b.ship ? -1 : 1))
    .map((p) => `${p.ship}:${p.origin.x},${p.origin.y}:${p.orientation}`)
    .join("|");
}
function commit(board, salt) {
  return createHash("sha256").update(canonical(board)).update("|").update(salt).digest("hex");
}

const boardA = {
  placements: [
    { ship: "carrier", origin: { x: 0, y: 0 }, orientation: "horizontal" },
    { ship: "battleship", origin: { x: 0, y: 1 }, orientation: "horizontal" },
    { ship: "cruiser", origin: { x: 0, y: 2 }, orientation: "horizontal" },
    { ship: "submarine", origin: { x: 0, y: 3 }, orientation: "horizontal" },
    { ship: "destroyer", origin: { x: 0, y: 4 }, orientation: "horizontal" },
  ],
};
const boardB = {
  placements: [
    { ship: "carrier", origin: { x: 9, y: 0 }, orientation: "vertical" },
    { ship: "battleship", origin: { x: 8, y: 0 }, orientation: "vertical" },
    { ship: "cruiser", origin: { x: 7, y: 0 }, orientation: "vertical" },
    { ship: "submarine", origin: { x: 6, y: 0 }, orientation: "vertical" },
    { ship: "destroyer", origin: { x: 5, y: 0 }, orientation: "vertical" },
  ],
};
function allCells(board) {
  const sizes = { carrier: 5, battleship: 4, cruiser: 3, submarine: 3, destroyer: 2 };
  const out = [];
  for (const p of board.placements)
    for (let i = 0; i < sizes[p.ship]; i++)
      out.push({ x: p.origin.x + (p.orientation === "horizontal" ? i : 0), y: p.origin.y + (p.orientation === "vertical" ? i : 0) });
  return out;
}

const A = client();
const B = client();
await Promise.all([A.open, B.open]);

A.send({ type: "create", stakeZec: 0.1 });
const created = await A.waitFor((m) => m.type === "created");
const code = created.matchId;
console.log("match created:", code);

A.send({ type: "join", matchId: code, payoutAddress: "u1winnerAAA" });
B.send({ type: "join", matchId: code, payoutAddress: "u1loserBBB" });
await A.waitFor((m) => m.type === "joined");
await B.waitFor((m) => m.type === "joined");
console.log("both joined");

A.send({ type: "i_sent_deposit" });
B.send({ type: "i_sent_deposit" });
// wait for both deposits confirmed -> placing phase
await A.waitFor((m) => m.type === "state" && m.state.phase === "placing");
console.log("both deposits confirmed, placing phase reached");

const saltA = "a".repeat(64);
const saltB = "b".repeat(64);
A.send({ type: "commit", board: boardA, salt: saltA, commitment: commit(boardA, saltA) });
B.send({ type: "commit", board: boardB, salt: saltB, commitment: commit(boardB, saltB) });
await A.waitFor((m) => m.type === "state" && m.state.phase === "in_play");
console.log("in play");

// A fires at all of B's cells, B wastes shots in open water
const targets = allCells(boardB);
for (const t of targets) {
  A.send({ type: "fire", x: t.x, y: t.y });
  await sleep(60);
  const st = [...A.inbox].reverse().find((m) => m.type === "state");
  if (st && st.state.phase !== "in_play") break;
  B.send({ type: "fire", x: 0, y: 9 });
  await sleep(60);
}

const settled = await A.waitFor((m) => m.type === "settled", 8000);
console.log("SETTLED. payout txid:", settled.txid.slice(0, 16) + "…");

const finalA = [...A.inbox].reverse().find((m) => m.type === "state" && m.state.phase === "complete");
console.log("winner:", finalA?.state.winner, "| pot:", finalA?.state.potZec, "ZEC");

A.ws.close();
B.ws.close();
console.log("\n✅ Full match over live server: stake → commit → play → shielded payout");
process.exit(0);
