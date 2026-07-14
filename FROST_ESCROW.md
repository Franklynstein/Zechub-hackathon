# Tier 2 — Non-custodial escrow via FROST threshold signing

This document covers the FROST escrow that upgrades ZEC Battleship from a
custodial POC to a **non-custodial 2-of-3 threshold-signed** payout. It spans
two ZecHub Hackathon tracks at once: **Games** and **FROST**.

## The trust upgrade

| | Tier 1 (custodial) | Tier 2 (FROST) |
| --- | --- | --- |
| Who can move the pot | the server alone | **any 2 of 3** signers |
| Signers | one server key | player-a · player-b · referee |
| Server steals funds? | possible | **no** — needs a second signer |
| Player redirects pot? | no | **no** — sig is over the exact payout |
| On-chain footprint | normal shielded tx | **identical** (rerandomized FROST) |

The 2-of-3 group holds the escrow. A payout is authorized when the winner side
and the referee co-sign (the referee is the swing signer for disputes). No
single party — including the operator — can move the funds.

## What is real vs. host-side

**Real and proven in this repo:**
- The 2-of-3 threshold-signing protocol. `frost-verify/` is a runnable Rust
  program that generates a 3-share / threshold-2 group, signs a payout message
  with 2 signers, verifies it under the group key, and proves a tampered payout
  is rejected. Run it:
  ```bash
  cd frost-verify && cargo run
  ```
  It uses the Ed25519 ciphersuite for portability. **The only change for Zcash
  is the ciphersuite flag** (`-C redpallas`), which gives rerandomized FROST so
  the threshold signature is indistinguishable from a single-signer Orchard
  signature on-chain. Same protocol, same rounds, same threshold logic.

- The full orchestration that drives the real ZF tooling: `src/frost/
  FrostOrchestrator.ts` issues the exact `frost-client` commands
  (`trusted-dealer`, `coordinator`, `participant`) taken from the tool's own
  `args.rs`. `src/frost/FrostEscrowClient.ts` implements the game's
  `ZcashClient` interface, so settlement flows through threshold signing with
  **no change to `Match.ts`**.

**Host-side (needs a Rust toolchain + funded testnet wallet):**
- Building the Orchard payout transaction and broadcasting it. That's the
  `librustzcash` / `lightwalletd` stack plus `zcash-sign` to inject the FROST
  signature. `src/frost/ReferencePayoutBuilder.ts` marks each integration point
  precisely. The signature handed to `zcash-sign` is the real one from
  `frost-client`.

This split is deliberate and honest: the cryptography is real, and the one part
that requires a funded wallet + current Rust is a documented local step, not
something faked.

## End-to-end flow

```
match ends ─▶ Match.settle() ─▶ FrostEscrowClient.sendShielded()
                                      │
        ┌─────────────────────────────┼─────────────────────────────┐
        ▼                             ▼                             ▼
 PayoutBuilder.buildPayout      thresholdSign (REAL)        finalize + broadcast
 → unsigned Orchard tx          → frost-client coordinator   → zcash-sign injects
 → returns sighash                + 2 participants (redpallas)  the sig, lightwalletd
                                 → 2-of-3 group signature       SendTransaction
```

## Running the real FROST signing (on a Rust-capable host)

```bash
# 1. Build the ZF FROST tooling
git clone https://github.com/ZcashFoundation/frost-zcash-demo
cd frost-zcash-demo && cargo build --release -p frost-client -p frostd

# 2. Point the game at the binaries
export FROST_CLIENT_BIN=/path/to/frost-client
export FROSTD_BIN=/path/to/frostd

# 3. Create a 2-of-3 RedPallas group for a match (what FrostOrchestrator runs):
frost-client trusted-dealer -C redpallas -t 2 -n 3 \
  -c a.toml -c b.toml -c referee.toml \
  -N player-a,player-b,referee -d "zbs-<matchId>"

# 4. Threshold-sign the payout sighash (coordinator + 2 participants via frostd).
#    For redpallas the coordinator auto-generates the randomizer.
```

## Why subprocess orchestration, not a JS FROST library

Reimplementing rerandomized FROST + Orchard in JavaScript would not be the
real, audited primitive — it would be a look-alike. The Zcash Foundation's
`frost-client` (built on `reddsa`/RedPallas) is the canonical implementation, so
the game drives it directly. The signature that authorizes a payout is produced
by the same code institutions would use for shielded multi-party custody.

## Honest limitations

- The ZF FROST demos are explicitly **not for production**; this is a POC.
- Trusted-dealer key generation is used for the demo path. The production
  upgrade is **DKG** (distributed key generation), so no party ever holds the
  full key — `frost-client dkg` supports this and `FrostOrchestrator` is
  structured to swap it in.
- The randomizer/coordinator role is run by the referee here; a hardened design
  distributes coordination too.
