// Board rules: validate a placement, expand ships to occupied cells.

import {
  Board,
  Coord,
  ShipName,
  ShipPlacement,
  SHIP_SIZES,
} from "../shared/types.js";

export const GRID = 10;

export function cellsForPlacement(p: ShipPlacement): Coord[] {
  const size = SHIP_SIZES[p.ship];
  const cells: Coord[] = [];
  for (let i = 0; i < size; i++) {
    cells.push({
      x: p.origin.x + (p.orientation === "horizontal" ? i : 0),
      y: p.origin.y + (p.orientation === "vertical" ? i : 0),
    });
  }
  return cells;
}

export function coordKey(c: Coord): string {
  return `${c.x},${c.y}`;
}

const REQUIRED_SHIPS: ShipName[] = [
  "carrier",
  "battleship",
  "cruiser",
  "submarine",
  "destroyer",
];

export function validateBoard(board: Board): { ok: true } | { ok: false; reason: string } {
  if (board.placements.length !== REQUIRED_SHIPS.length) {
    return { ok: false, reason: "Place all five ships." };
  }
  const seenShips = new Set<ShipName>();
  const occupied = new Set<string>();

  for (const p of board.placements) {
    if (seenShips.has(p.ship)) {
      return { ok: false, reason: `Duplicate ship: ${p.ship}.` };
    }
    seenShips.add(p.ship);

    for (const c of cellsForPlacement(p)) {
      if (c.x < 0 || c.y < 0 || c.x >= GRID || c.y >= GRID) {
        return { ok: false, reason: `${p.ship} runs off the board.` };
      }
      const k = coordKey(c);
      if (occupied.has(k)) {
        return { ok: false, reason: `${p.ship} overlaps another ship.` };
      }
      occupied.add(k);
    }
  }

  for (const s of REQUIRED_SHIPS) {
    if (!seenShips.has(s)) return { ok: false, reason: `Missing ship: ${s}.` };
  }

  return { ok: true };
}

/** Map of occupied cell -> the ship occupying it. */
export function occupancyMap(board: Board): Map<string, ShipName> {
  const m = new Map<string, ShipName>();
  for (const p of board.placements) {
    for (const c of cellsForPlacement(p)) {
      m.set(coordKey(c), p.ship);
    }
  }
  return m;
}
