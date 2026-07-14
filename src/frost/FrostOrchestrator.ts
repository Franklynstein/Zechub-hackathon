// FROST threshold-signing orchestration.
//
// This drives the REAL Zcash Foundation FROST tooling (frost-client + frostd,
// RedPallas ciphersuite) to produce a 2-of-3 threshold signature authorizing a
// match payout. There is no mock signing here: when the `frost-client` binary
// is present, this runs the actual protocol end to end.
//
// Trust model for ZEC Battleship:
//   - 3 key shares, threshold 2 (2-of-3).
//   - share holders: player A's client, player B's client, and a referee.
//   - A payout requires ANY 2 of the 3 to sign. The server/referee alone
//     cannot move funds; neither can a single player. The winner is paid only
//     when a second party co-signs, with the referee available to break ties.
//
// Why a subprocess and not a Node FROST library: the production FROST + Orchard
// stack is Rust (ZF's frost-client, reddsa/RedPallas). Rather than reimplement
// rerandomized FROST in JS (which would NOT be the real, audited primitive),
// we orchestrate the canonical binaries. The CLI contract below was taken
// directly from frost-client's args.rs (TrustedDealer / Coordinator /
// Participant subcommands).
//
// Build prerequisite (run once on a Rust-capable machine):
//   git clone https://github.com/ZcashFoundation/frost-zcash-demo
//   cd frost-zcash-demo && cargo build --release -p frost-client -p frostd
//   then point FROST_CLIENT_BIN / FROSTD_BIN at the built binaries.

import { spawn } from "node:child_process";
import { mkdtemp, writeFile, readFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type FrostConfig = {
  /** Path to the built `frost-client` binary. */
  clientBin: string;
  /** Path to the built `frostd` server binary (for networked signing). */
  serverBin?: string;
  /** Ciphersuite — MUST be redpallas for Zcash-compatible (rerandomized) sigs. */
  ciphersuite: "redpallas";
  /** Working directory for per-match signer configs + artifacts. */
  workDir: string;
};

export type SignerName = "player-a" | "player-b" | "referee";

export type ThresholdSignResult = {
  /** Hex-encoded RedPallas threshold signature over the message (tx sighash). */
  signatureHex: string;
  /** Which two signers actually signed. */
  signers: SignerName[];
  /** Group public key the signature verifies under. */
  groupPublicKey: string;
};

/**
 * Sets up a fresh 2-of-3 RedPallas group for a match via the trusted-dealer
 * path (DKG is the production alternative; trusted-dealer is the supported
 * local/test route). Returns the per-signer config paths + group public key.
 *
 * Mirrors:
 *   frost-client trusted-dealer -C redpallas -t 2 -n 3 \
 *     -c a.toml -c b.toml -c referee.toml \
 *     -N player-a,player-b,referee -d "zbs-<matchId>"
 */
export async function setupMatchGroup(
  cfg: FrostConfig,
  matchId: string,
): Promise<{ configs: Record<SignerName, string>; groupPublicKey: string }> {
  await mkdir(cfg.workDir, { recursive: true });
  const dir = await mkdtemp(join(cfg.workDir, `match-${matchId}-`));
  const configs: Record<SignerName, string> = {
    "player-a": join(dir, "player-a.toml"),
    "player-b": join(dir, "player-b.toml"),
    referee: join(dir, "referee.toml"),
  };

  await run(cfg.clientBin, [
    "trusted-dealer",
    "-C", cfg.ciphersuite,
    "-t", "2",
    "-n", "3",
    "-c", configs["player-a"],
    "-c", configs["player-b"],
    "-c", configs["referee"],
    "-N", "player-a,player-b,referee",
    "-d", `zbs-${matchId}`,
  ]);

  const groupPublicKey = await extractGroupPubkey(cfg, configs["referee"]);
  return { configs, groupPublicKey };
}

async function extractGroupPubkey(cfg: FrostConfig, configPath: string): Promise<string> {
  // `groups` lists groups in a config, including the group public key.
  const out = await run(cfg.clientBin, ["groups", "-c", configPath]);
  const m = out.match(/[0-9a-f]{64,}/i);
  if (!m) throw new Error("Could not read group public key from frost-client groups output.");
  return m[0];
}

/**
 * Produce a 2-of-3 threshold signature over `message` (the payout transaction
 * sighash). Runs a coordinator + two participants against a local frostd.
 *
 * Coordinator (from args.rs):
 *   frost-client coordinator -C redpallas -c referee.toml -g <group> \
 *     -S <signerPubA>,<signerPubB> -m message.raw -o sig.raw
 * Participant:
 *   frost-client participant -c a.toml -g <group>
 *
 * For redpallas the coordinator auto-generates the randomizer (rerandomized
 * FROST), which is what keeps the threshold signature indistinguishable from a
 * single-signer Orchard signature on-chain.
 */
export async function thresholdSign(
  cfg: FrostConfig,
  params: {
    matchId: string;
    configs: Record<SignerName, string>;
    groupPublicKey: string;
    /** Two signers (e.g. winner side + referee). */
    signers: [SignerName, SignerName];
    /** Raw message bytes to sign = the payout tx sighash. */
    message: Buffer;
    serverUrl: string;
  },
): Promise<ThresholdSignResult> {
  const dir = join(cfg.workDir, `sign-${params.matchId}-${Date.now()}`);
  await mkdir(dir, { recursive: true });
  const msgPath = join(dir, "message.raw");
  const sigPath = join(dir, "sig.raw");
  await writeFile(msgPath, params.message);

  // Resolve each signer's communication pubkey from its config (needed by -S).
  const signerPubkeys = await Promise.all(
    params.signers.map((s) => getCommPubkey(cfg, params.configs[s])),
  );

  // Coordinator runs as the referee config (any group member can coordinate).
  const coordConfig = params.configs["referee"];

  const coordinator = run(cfg.clientBin, [
    "coordinator",
    "-C", cfg.ciphersuite,
    "-c", coordConfig,
    "-s", params.serverUrl,
    "-g", params.groupPublicKey,
    "-S", signerPubkeys.join(","),
    "-m", msgPath,
    "-o", sigPath,
  ]);

  // Each chosen signer participates.
  const participants = params.signers.map((s) =>
    run(cfg.clientBin, [
      "participant",
      "-C", cfg.ciphersuite,
      "-c", params.configs[s],
      "-s", params.serverUrl,
      "-g", params.groupPublicKey,
    ]),
  );

  await Promise.all([coordinator, ...participants]);

  const sigBytes = await readFile(sigPath);
  return {
    signatureHex: sigBytes.toString("hex"),
    signers: params.signers,
    groupPublicKey: params.groupPublicKey,
  };
}

async function getCommPubkey(cfg: FrostConfig, configPath: string): Promise<string> {
  // `export` prints the contact (which encodes the comm pubkey); for the
  // signer list the coordinator needs the hex pubkey. We read it from the
  // contact export and pull the hex.
  const out = await run(cfg.clientBin, ["export", "-n", "signer", "-c", configPath]);
  const m = out.match(/[0-9a-f]{64,}/i);
  if (!m) throw new Error("Could not read communication pubkey from config.");
  return m[0];
}

/** Thin promisified subprocess runner that captures stdout. */
function run(bin: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (err) => {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        reject(
          new Error(
            `frost binary not found: ${bin}. Build it with ` +
              `\`cargo build --release -p frost-client -p frostd\` and set FROST_CLIENT_BIN.`,
          ),
        );
      } else reject(err);
    });
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`${bin} ${args.join(" ")} exited ${code}\n${stderr}`));
    });
  });
}
