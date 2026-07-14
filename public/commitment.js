// Client-side commitment — must match src/game/commitment.ts exactly.
// The player computes commitment locally so the salt never leaves their browser
// until reveal. Uses Web Crypto SHA-256.

export function canonicalizeBoard(board) {
  const sorted = [...board.placements].sort((a, b) =>
    a.ship < b.ship ? -1 : a.ship > b.ship ? 1 : 0,
  );
  return sorted
    .map((p) => `${p.ship}:${p.origin.x},${p.origin.y}:${p.orientation}`)
    .join("|");
}

export function makeSalt() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function commitBoard(board, salt) {
  const enc = new TextEncoder();
  const data = enc.encode(canonicalizeBoard(board) + "|" + salt);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
