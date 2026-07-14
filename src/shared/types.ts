// Shared types across the whole app.

export type Coord = { x: number; y: number }; // 0..9 on a 10x10 grid

export type ShipName =
  | "carrier" // 5
  | "battleship" // 4
  | "cruiser" // 3
  | "submarine" // 3
  | "destroyer"; // 2

export const SHIP_SIZES: Record<ShipName, number> = {
  carrier: 5,
  battleship: 4,
  cruiser: 3,
  submarine: 3,
  destroyer: 2,
};

export type Orientation = "horizontal" | "vertical";

export type ShipPlacement = {
  ship: ShipName;
  origin: Coord; // top-left-most cell
  orientation: Orientation;
};

// A fully placed board: 5 ships. Kept secret on the server; never sent to the opponent.
export type Board = {
  placements: ShipPlacement[];
};

export type ShotResult = "hit" | "miss" | "sunk" | "win";

export type Shot = {
  by: PlayerSlot;
  at: Coord;
  result: ShotResult;
  sunkShip?: ShipName;
};

export type PlayerSlot = "a" | "b";

export type MatchPhase =
  | "awaiting_players" // waiting for both to join
  | "awaiting_deposits" // waiting for both stakes to confirm
  | "placing" // players placing ships
  | "in_play" // alternating shots
  | "settling" // verifying boards + paying out
  | "complete"
  | "void"; // refunded / cancelled

export type PlayerView = {
  slot: PlayerSlot;
  joined: boolean;
  depositConfirmed: boolean;
  boardCommitted: boolean;
  payoutAddress?: string;
};

// What we send to a single client. Never includes the opponent's board.
export type MatchStateForClient = {
  matchId: string;
  phase: MatchPhase;
  you: PlayerSlot | null;
  stakeZec: number;
  potZec: number;
  depositAddress: string | null; // shielded address to send the stake to
  depositMemo: string | null; // unique memo so the deposit is attributable
  turn: PlayerSlot | null;
  players: { a: PlayerView; b: PlayerView };
  // Your own shots (results visible to you), and the opponent's shots against you.
  yourShots: Shot[];
  shotsAgainstYou: Shot[];
  winner: PlayerSlot | null;
  payoutTxid: string | null;
  network: "testnet" | "mainnet";
};
