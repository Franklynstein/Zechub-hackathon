use frost_ed25519 as frost;
use rand::thread_rng;
use std::collections::BTreeMap;

fn main() {
    let mut rng = thread_rng();
    let (shares, pubkey_package) = frost::keys::generate_with_dealer(
        3, 2, frost::keys::IdentifierList::Default, &mut rng,
    ).expect("keygen failed");

    let mut key_packages: BTreeMap<frost::Identifier, frost::keys::KeyPackage> = BTreeMap::new();
    for (id, secret_share) in shares {
        key_packages.insert(id, frost::keys::KeyPackage::try_from(secret_share).expect("bad share"));
    }

    let group_pubkey = pubkey_package.verifying_key();
    println!("group public key: {}", hex::encode(group_pubkey.serialize()));
    println!("3 shares (player-a, player-b, referee), threshold 2-of-3\n");

    let message = b"ZEC Battleship payout: match a1b2c3d4 -> winner, pot 0.2 ZEC";

    let signing_ids: Vec<frost::Identifier> = key_packages.keys().take(2).cloned().collect();
    println!("signing with 2 of 3 participants (winner side + referee)...");

    let mut nonces = BTreeMap::new();
    let mut commitments = BTreeMap::new();
    for id in &signing_ids {
        let (nonce, commitment) = frost::round1::commit(key_packages[id].signing_share(), &mut rng);
        nonces.insert(*id, nonce);
        commitments.insert(*id, commitment);
    }

    let signing_package = frost::SigningPackage::new(commitments.clone(), message);

    let mut sig_shares = BTreeMap::new();
    for id in &signing_ids {
        let share = frost::round2::sign(&signing_package, &nonces[id], &key_packages[id]).expect("sign failed");
        sig_shares.insert(*id, share);
    }

    let group_signature = frost::aggregate(&signing_package, &sig_shares, &pubkey_package).expect("aggregate failed");
    println!("group signature: {}", hex::encode(group_signature.serialize()));

    assert!(pubkey_package.verifying_key().verify(message, &group_signature).is_ok(), "must verify");
    println!("\n[PASS] 2-of-3 signature VERIFIES under group key");

    let tampered = b"ZEC Battleship payout: match a1b2c3d4 -> ATTACKER, pot 0.2 ZEC";
    assert!(pubkey_package.verifying_key().verify(tampered, &group_signature).is_err(), "tampered must fail");
    println!("[PASS] tampered payout REJECTED (attacker cannot redirect the pot)");

    println!("\nThreshold escrow protocol verified.");
    println!("Production swaps ciphersuite -> RedPallas (rerandomized FROST) for Zcash Orchard.");
}
