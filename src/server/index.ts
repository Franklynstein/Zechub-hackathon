// HTTP + WebSocket server.
//
// HTTP serves the static client. WebSocket carries the live game protocol:
// each connection is one player in one match. Messages are small JSON commands;
// the server replies with per-player state views (never leaking the opponent's
// board).

import express from "express";
import { WebSocketServer, WebSocket } from "ws";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createZcashClient } from "../zcash/factory.js";
import { MatchRegistry } from "./MatchRegistry.js";
import { Match } from "../game/Match.js";
import { PlayerSlot, Board } from "../shared/types.js";
import { SimulatedZcashClient } from "../zcash/SimulatedZcashClient.js";
import { zecToZat } from "../zcash/ZcashClient.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 3000);

const zcash = createZcashClient();
const registry = new MatchRegistry(zcash);

const app = express();
app.use(express.json());
app.use(express.static(join(__dirname, "../../public")));

const httpServer = createServer(app);
const wss = new WebSocketServer({ server: httpServer });

// Track sockets per match so we can broadcast tailored views.
type Conn = { ws: WebSocket; matchId: string; slot: PlayerSlot };
const conns = new Map<WebSocket, Conn>();

function broadcast(match: Match): void {
  for (const [ws, c] of conns) {
    if (c.matchId !== match.id) continue;
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "state", state: match.viewFor(c.slot) }));
    }
  }
}

function send(ws: WebSocket, msg: unknown): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function err(ws: WebSocket, message: string): void {
  send(ws, { type: "error", message });
}

wss.on("connection", (ws) => {
  ws.on("message", async (raw) => {
    let msg: any;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return err(ws, "Bad JSON.");
    }

    try {
      switch (msg.type) {
        case "create": {
          const stake = Number(msg.stakeZec);
          if (!(stake > 0)) return err(ws, "Stake must be positive.");
          const match = await registry.create(stake);
          send(ws, { type: "created", matchId: match.id });
          break;
        }

        case "join": {
          const match = registry.get(msg.matchId);
          if (!match) return err(ws, "No such match.");
          const slot = match.join(String(msg.payoutAddress ?? ""));
          conns.set(ws, { ws, matchId: match.id, slot });
          // Start watching this player's deposit.
          registry.watchDeposit(match, slot, (mid) => {
            const m = registry.get(mid);
            if (m) broadcast(m);
          });
          send(ws, { type: "joined", slot, matchId: match.id });
          broadcast(match);
          break;
        }

        case "i_sent_deposit": {
          // Demo affordance: on the simulator this injects the matching
          // incoming payment. On a real backend this is a no-op (the chain
          // tells us), so it's guarded by an instanceof check.
          const c = conns.get(ws);
          if (!c) return err(ws, "Join a match first.");
          const match = registry.get(c.matchId);
          if (!match) return err(ws, "No such match.");
          if (zcash instanceof SimulatedZcashClient) {
            zcash.simulateIncoming(match.memoFor(c.slot), zecToZat(match.stakeZec));
            send(ws, { type: "info", message: "Deposit broadcast — waiting for confirmation…" });
          } else {
            send(ws, {
              type: "info",
              message: "Send the stake from your wallet with the shown memo; confirmation is automatic.",
            });
          }
          break;
        }

        case "commit": {
          const c = conns.get(ws);
          if (!c) return err(ws, "Join a match first.");
          const match = registry.get(c.matchId);
          if (!match) return err(ws, "No such match.");
          const board = msg.board as Board;
          match.commitAndPlace(c.slot, board, String(msg.salt), String(msg.commitment));
          broadcast(match);
          break;
        }

        case "fire": {
          const c = conns.get(ws);
          if (!c) return err(ws, "Join a match first.");
          const match = registry.get(c.matchId);
          if (!match) return err(ws, "No such match.");
          const shot = match.fire(c.slot, { x: Number(msg.x), y: Number(msg.y) });
          broadcast(match);
          if (shot.result === "win") {
            const res = await match.settle();
            if ("txid" in res) {
              broadcast(match);
              for (const [w, cc] of conns) {
                if (cc.matchId === match.id) {
                  send(w, { type: "settled", txid: res.txid });
                }
              }
            } else {
              for (const [w, cc] of conns) {
                if (cc.matchId === match.id) {
                  send(w, { type: "voided", reason: res.voided });
                }
              }
            }
          }
          break;
        }

        default:
          err(ws, `Unknown command: ${msg.type}`);
      }
    } catch (e: any) {
      err(ws, e.message ?? "Server error.");
    }
  });

  ws.on("close", () => conns.delete(ws));
});

httpServer.listen(PORT, () => {
  console.log(`ZEC Battleship on http://localhost:${PORT}`);
  console.log(`Backend: ${process.env.ZEC_BACKEND ?? "simulator"} | Network: ${zcash.network}`);
});
