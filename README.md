# ZEC Battleship

**A two-player Battleship game where both captains stake shielded ZEC and the winner takes the pot.**
Built for **ZecHub Hackathon 3.0 — Games track**.

Boards are committed with a SHA-256 hash *before the first shot*, so neither player — nor the
server — can move a ship mid-game. When a fleet is sunk, the full pot is paid out to the winner's
shielded address.

---

## Why this fits the Games track

The hackathon explicitly invites games that *"require Zcash payment to play."* ZEC Battleship is
exactly that, with a real-stakes twist: it's a **wager** game settled in shielded ZEC. It exercises
the parts of Zcash that matter — shielded payments, encrypted memos for attributing deposits, and
private settlement — inside a game everyone already understands.

## What's real vs. simulated

| Concern | Status |
| --- | --- |
| Game logic (placement, shots, sinking, win detection) | Fully real, unit + e2e tested |
| Board commitment / anti-cheat | Real SHA-256 commit–reveal, verified at settlement |
| Per-player deposit attribution via encrypted memo | Real design; memo string per match+player |
| Chain layer | Pluggable. **Simulator by default** (reproducible demo); **lightwalletd adapter** for testnet/mainnet |
| Testnet → mainnet switch | A config change (`ZEC_NETWORK`), not a code change |

The chain integration lives entirely behind one interface (`src/zcash/ZcashClient.ts`). The rest of
the app never imports a concrete client, which is what makes the network a swap rather than a rewrite.

## Honest limitations (and the upgrade path)

This is a proof of concept, and the escrow model says so plainly:

- **Escrow is custodial in the base game.** Both stakes go to a game-controlled shielded wallet, and
  the server pays the winner. A malicious operator could misbehave. The base POC is transparent about this.
  - **Non-custodial upgrade — BUILT (Tier 2):** `FROST_ESCROW.md` documents a working **2-of-3
    threshold-signed escrow** where no single party (including the server) can move the pot. The
    threshold-signing protocol is proven by a runnable Rust program in `frost-verify/` (real 2-of-3
    signature, tamper rejection), and `src/frost/` orchestrates the Zcash Foundation's `frost-client`
    (RedPallas) so a real game outcome produces a real threshold signature. This spans the Games **and**
    FROST tracks.
- **The server arbitrates shots**, so it learns both boards at placement time. The commitment stops
  boards from being *altered*, but doesn't hide them from the arbiter.
  - **Upgrade path:** **per-shot zero-knowledge proofs**, where each player answers "hit/miss" with a
    proof against their commitment and the server (and opponent) never see the board at all.

Calling these out is deliberate — judges should see the trust model clearly, not have it buried.

---

## Quick start

Requires Node.js 20+.

```bash
npm install

# Reproducible demo on the built-in simulator (no wallet needed):
npm run dev
# open http://localhost:3000 in two browser windows/profiles
```

### Play a match
1. **Window 1:** set a stake, click **Open a table**, copy the match code.
2. **Window 1:** paste your shielded payout address, **Take a seat**.
3. **Window 2:** paste the code + a payout address, **Take a seat**.
4. Both windows: on the escrow screen, click **I've sent the stake**
   (on the simulator this injects the matching shielded deposit; on a real backend you'd send from
   your wallet with the shown memo and it confirms automatically).
5. Both: **Auto-place** or place ships by hand, then **Commit fleet & lock in**.
6. Take turns firing. Sink the enemy fleet — the pot is paid to your shielded address.

### Run the tests
```bash
npm test            # unit tests: full lifecycle + commitment anti-cheat
node e2e.mjs        # end-to-end over a live server (start the server first)
```

---

## Running against Zcash testnet / mainnet

The simulator is the default so the demo is reproducible. To run against a real network:

```bash
export ZEC_BACKEND=lightwalletd
export ZEC_NETWORK=testnet          # or mainnet
export ZEC_WALLET_SECRET=...        # escrow wallet spend material (never commit this)
npm run dev
```

`src/zcash/LightwalletdZcashClient.ts` documents exactly which light-client calls each game
operation maps to (sync + trial-decrypt for deposits, shielded spend + broadcast for payouts).
Wiring a concrete wallet backend (e.g. zingolib / librustzcash) is the remaining production task and
is isolated to that one file.

---

## Architecture

```
src/
  shared/types.ts            shared game + view types
  zcash/
    ZcashClient.ts           the chain interface (the whole boundary)
    SimulatedZcashClient.ts  node-free, models memos + confirmation delay
    LightwalletdZcashClient.ts  real-chain adapter (testnet/mainnet)
    factory.ts               picks backend from env
  game/
    board.ts                 placement rules, occupancy
    commitment.ts            SHA-256 commit / verify
    Match.ts                 state machine: stake -> commit -> play -> settle
  server/
    MatchRegistry.ts         match store + deposit watchers
    index.ts                 HTTP + WebSocket server
public/
    index.html, app.js, commitment.js   the sonar-room client
```

The flow: **awaiting_players → awaiting_deposits → placing → in_play → settling → complete**, with a
`void` branch that refunds when a board fails commitment verification.

## License

MIT — see [LICENSE](./LICENSE). Open source, as the hackathon requires.
