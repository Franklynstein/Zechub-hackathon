# frost-verify — real 2-of-3 threshold signing

A runnable proof of the threshold-signing protocol behind ZEC Battleship's
non-custodial escrow. It:

1. generates a 3-share group with threshold 2 (player-a, player-b, referee),
2. signs a payout message with 2 of the 3 signers,
3. verifies the aggregate signature under the group public key, and
4. proves a **tampered** payout is rejected (an attacker can't redirect the pot).

```bash
cargo run
```

Expected output ends with:
```
[PASS] 2-of-3 signature VERIFIES under group key
[PASS] tampered payout REJECTED (attacker cannot redirect the pot)
```

## Ciphersuite note

This harness uses `frost-ed25519` so it builds on a stock Rust toolchain. The
production game uses the **RedPallas** ciphersuite (`-C redpallas` in
`frost-client`), which is Zcash-compatible and rerandomized — making the
threshold signature indistinguishable from a single-signer Orchard signature
on-chain. The protocol, rounds, and threshold logic are identical; only the
ciphersuite changes.

## Toolchain note

The committed `Cargo.lock` pins `zeroize_derive`/`zeroize` to versions that
build on older Rust. If you're on current stable Rust (recommended), you can
delete `Cargo.lock` and rebuild fresh — and you can also build the full ZF
tooling (`frost-client`, `frostd`) which needs Rust 1.81+ and is what the game
orchestrates for real RedPallas signing. See `../FROST_ESCROW.md`.
