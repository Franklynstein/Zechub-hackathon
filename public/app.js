import { commitBoard, makeSalt } from "/commitment.js";

const SHIP_SIZES = { carrier: 5, battleship: 4, cruiser: 3, submarine: 3, destroyer: 2 };
const SHIP_ORDER = ["carrier", "battleship", "cruiser", "submarine", "destroyer"];
const GRID = 10;

const $ = (id) => document.getElementById(id);
const show = (id) => $(id).classList.remove("hidden");
const hide = (id) => $(id).classList.add("hidden");

let ws;
let mySlot = null;
let matchId = null;
let myBoard = { placements: [] };
let mySalt = null;
let orientation = "horizontal";
let activeShip = SHIP_ORDER[0];
let lastState = null;
let committed = false;

// ---- WebSocket ----
function connect() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}`);
  ws.onmessage = (ev) => handle(JSON.parse(ev.data));
  ws.onclose = () => toast("Connection closed. Reload to play again.", true);
}
function sendWs(obj) {
  ws.send(JSON.stringify(obj));
}

function handle(msg) {
  switch (msg.type) {
    case "created":
      $("joinCode").value = msg.matchId;
      toast(`Table opened. Share code: ${msg.matchId}`);
      break;
    case "joined":
      mySlot = msg.slot;
      matchId = msg.matchId;
      break;
    case "state":
      lastState = msg.state;
      render(msg.state);
      break;
    case "settled":
      toast(`Pot paid out · tx ${short(msg.txid)}`);
      break;
    case "voided":
      toast(`Match voided: ${msg.reason}`, true);
      break;
    case "info":
      toast(msg.message);
      break;
    case "error":
      toast(msg.message, true);
      break;
  }
}

// ---- Lobby ----
$("createBtn").onclick = () => {
  const stake = parseFloat($("stakeInput").value);
  sendWs({ type: "create", stakeZec: stake });
};
$("joinBtn").onclick = () => {
  const code = $("joinCode").value.trim();
  const addr = $("payoutAddr").value.trim();
  if (!code) return toast("Enter a match code.", true);
  if (!addr) return toast("Enter your shielded payout address.", true);
  sendWs({ type: "join", matchId: code, payoutAddress: addr });
};

// ---- Deposit ----
$("sentBtn").onclick = () => sendWs({ type: "i_sent_deposit" });

// ---- Render dispatcher ----
function render(s) {
  $("netBadge").textContent = s.network;
  if (s.you) mySlot = s.you;

  if (s.phase === "awaiting_players" || s.phase === "awaiting_deposits") {
    routeTo("deposit");
    renderDeposit(s);
  } else if (s.phase === "placing") {
    routeTo("placement");
    renderPlacement(s);
  } else if (s.phase === "in_play") {
    routeTo("battle");
    renderBattle(s);
  } else if (s.phase === "settling" || s.phase === "complete") {
    if (s.phase === "complete") {
      routeTo("result");
      renderResult(s);
    } else {
      renderBattle(s);
    }
  } else if (s.phase === "void") {
    routeTo("result");
    renderResult(s);
  }
}

const SECTIONS = ["lobby", "deposit", "placement", "battle", "result"];
function routeTo(id) {
  for (const sec of SECTIONS) (sec === id ? show : hide)(sec);
}

// ---- Deposit view ----
function renderDeposit(s) {
  $("potAmt").textContent = `${s.potZec} ZEC`;
  $("depAddr").textContent = s.depositAddress ?? "—";
  $("depMemo").textContent = s.depositMemo ?? "—";
  const me = s.you ? s.players[s.you] : null;
  const them = s.you ? s.players[s.you === "a" ? "b" : "a"] : null;
  if (me?.depositConfirmed) {
    $("depStatus").textContent = "Your stake is confirmed ✓";
    $("sentBtn").disabled = true;
  }
  const themJoined = them?.joined ? "opponent seated" : "waiting for opponent to join";
  const themPaid = them?.depositConfirmed ? "opponent funded ✓" : "opponent not funded yet";
  $("depPlayers").textContent = `${themJoined} · ${themPaid}`;
}

// ---- Placement view ----
function buildGrid(container, opts = {}) {
  container.innerHTML = "";
  for (let y = 0; y < GRID; y++) {
    for (let x = 0; x < GRID; x++) {
      const cell = document.createElement("div");
      cell.className = "cell";
      cell.dataset.x = x;
      cell.dataset.y = y;
      if (opts.onClick) cell.onclick = () => opts.onClick(x, y);
      if (opts.onHover) {
        cell.onmouseenter = () => opts.onHover(x, y, true);
        cell.onmouseleave = () => opts.onHover(x, y, false);
      }
      container.appendChild(cell);
    }
  }
}

function cellsForPlacement(p) {
  const size = SHIP_SIZES[p.ship];
  const cells = [];
  for (let i = 0; i < size; i++) {
    cells.push({
      x: p.origin.x + (p.orientation === "horizontal" ? i : 0),
      y: p.origin.y + (p.orientation === "vertical" ? i : 0),
    });
  }
  return cells;
}

function placementValid(p) {
  const occupied = new Set();
  for (const other of myBoard.placements) {
    if (other.ship === p.ship) continue;
    for (const c of cellsForPlacement(other)) occupied.add(`${c.x},${c.y}`);
  }
  for (const c of cellsForPlacement(p)) {
    if (c.x < 0 || c.y < 0 || c.x >= GRID || c.y >= GRID) return false;
    if (occupied.has(`${c.x},${c.y}`)) return false;
  }
  return true;
}

let placementInit = false;
function renderPlacement() {
  if (!placementInit) {
    buildGrid($("placeGrid"), {
      onClick: (x, y) => tryPlace(x, y),
      onHover: (x, y, on) => previewHover(x, y, on),
    });
    placementInit = true;
  }
  renderFleetChips();
  paintOwnPlacement();
}

function renderFleetChips() {
  const fleet = $("fleet");
  fleet.innerHTML = "";
  for (const ship of SHIP_ORDER) {
    const chip = document.createElement("div");
    const placed = myBoard.placements.some((p) => p.ship === ship);
    chip.className = "ship-chip" + (placed ? " placed" : "") + (ship === activeShip ? " active" : "");
    chip.textContent = `${ship} (${SHIP_SIZES[ship]})`;
    chip.onclick = () => {
      activeShip = ship;
      renderFleetChips();
    };
    fleet.appendChild(chip);
  }
  const allPlaced = myBoard.placements.length === SHIP_ORDER.length;
  $("commitBtn").disabled = !allPlaced || committed;
}

function tryPlace(x, y) {
  if (committed) return;
  const p = { ship: activeShip, origin: { x, y }, orientation };
  if (!placementValid(p)) return toast("Can't place there.", true);
  myBoard.placements = myBoard.placements.filter((q) => q.ship !== activeShip);
  myBoard.placements.push(p);
  const next = SHIP_ORDER.find((s) => !myBoard.placements.some((q) => q.ship === s));
  if (next) activeShip = next;
  renderFleetChips();
  paintOwnPlacement();
}

function paintOwnPlacement() {
  const cells = $("placeGrid").querySelectorAll(".cell");
  cells.forEach((c) => (c.className = "cell"));
  for (const p of myBoard.placements) {
    for (const c of cellsForPlacement(p)) {
      const el = $("placeGrid").querySelector(`[data-x="${c.x}"][data-y="${c.y}"]`);
      if (el) el.classList.add("ship");
    }
  }
}

function previewHover(x, y, on) {
  if (committed) return;
  const p = { ship: activeShip, origin: { x, y }, orientation };
  const valid = placementValid(p);
  for (const c of cellsForPlacement(p)) {
    const el = $("placeGrid").querySelector(`[data-x="${c.x}"][data-y="${c.y}"]`);
    if (!el) continue;
    if (on) el.style.background = valid ? "rgba(56,225,196,0.22)" : "rgba(255,84,112,0.22)";
    else el.style.background = "";
  }
}

$("rotateBtn").onclick = () => {
  orientation = orientation === "horizontal" ? "vertical" : "horizontal";
  $("rotateBtn").textContent = `Rotate (now: ${orientation})`;
};
$("clearBtn").onclick = () => {
  myBoard = { placements: [] };
  activeShip = SHIP_ORDER[0];
  renderFleetChips();
  paintOwnPlacement();
};
$("randomBtn").onclick = () => {
  myBoard = { placements: [] };
  for (const ship of SHIP_ORDER) {
    let placed = false;
    while (!placed) {
      const o = Math.random() < 0.5 ? "horizontal" : "vertical";
      const x = Math.floor(Math.random() * GRID);
      const y = Math.floor(Math.random() * GRID);
      const p = { ship, origin: { x, y }, orientation: o };
      if (placementValid(p)) {
        myBoard.placements.push(p);
        placed = true;
      }
    }
  }
  renderFleetChips();
  paintOwnPlacement();
};

$("commitBtn").onclick = async () => {
  if (myBoard.placements.length !== SHIP_ORDER.length) return;
  mySalt = makeSalt();
  const commitment = await commitBoard(myBoard, mySalt);
  sendWs({ type: "commit", board: myBoard, salt: mySalt, commitment });
  committed = true;
  $("commitBtn").disabled = true;
  $("commitBtn").textContent = "Fleet locked ✓";
  toast("Fleet committed. Waiting for opponent…");
};

// ---- Battle view ----
let battleInit = false;
function renderBattle(s) {
  if (!battleInit) {
    buildGrid($("enemyGrid"), { onClick: (x, y) => fire(x, y) });
    buildGrid($("ownGrid"));
    battleInit = true;
  }
  $("battlePot").textContent = `${s.potZec} ZEC`;
  const myTurn = s.turn === s.you;
  $("turnPill").className = "turn-pill " + (myTurn ? "you" : "them");
  $("turnPill").textContent = myTurn ? "your shot" : "their move";
  $("enemyGrid").classList.toggle("targetable", myTurn);

  paintEnemy(s);
  paintOwn(s);
  paintLog(s);
}

function paintEnemy(s) {
  const cells = $("enemyGrid").querySelectorAll(".cell");
  cells.forEach((c) => (c.className = "cell"));
  for (const shot of s.yourShots) {
    const el = $("enemyGrid").querySelector(`[data-x="${shot.at.x}"][data-y="${shot.at.y}"]`);
    if (!el) continue;
    el.classList.add(shot.result === "miss" ? "miss" : shot.result === "sunk" ? "sunk" : "hit");
  }
  const last = s.yourShots[s.yourShots.length - 1];
  $("fireStatus").textContent = last
    ? `last shot ${coord(last.at)} → ${last.result.toUpperCase()}${last.sunkShip ? " (" + last.sunkShip + ")" : ""}`
    : "select a target";
}

function paintOwn(s) {
  const cells = $("ownGrid").querySelectorAll(".cell");
  cells.forEach((c) => (c.className = "cell"));
  // Show my own ships.
  for (const p of myBoard.placements) {
    for (const c of cellsForPlacement(p)) {
      const el = $("ownGrid").querySelector(`[data-x="${c.x}"][data-y="${c.y}"]`);
      if (el) el.classList.add("ship");
    }
  }
  // Overlay enemy shots against me.
  for (const shot of s.shotsAgainstYou) {
    const el = $("ownGrid").querySelector(`[data-x="${shot.at.x}"][data-y="${shot.at.y}"]`);
    if (!el) continue;
    el.classList.add(shot.result === "miss" ? "miss" : shot.result === "sunk" ? "sunk" : "hit");
  }
  const last = s.shotsAgainstYou[s.shotsAgainstYou.length - 1];
  $("incomingStatus").textContent = last ? `incoming ${coord(last.at)} → ${last.result.toUpperCase()}` : "";
}

function paintLog(s) {
  const all = [...s.yourShots.map((x) => ({ ...x, mine: true })), ...s.shotsAgainstYou.map((x) => ({ ...x, mine: false }))];
  // We can't perfectly interleave without timestamps; show yours then theirs grouped recent-first.
  const lines = all.slice(-12).reverse().map((shot) => {
    const who = shot.mine ? `<span class="you">you</span>` : `<span class="them">them</span>`;
    return `${who} → ${coord(shot.at)} · ${shot.result}${shot.sunkShip ? " " + shot.sunkShip : ""}`;
  });
  $("log").innerHTML = lines.join("<br/>");
}

function fire(x, y) {
  if (!lastState || lastState.turn !== lastState.you) return toast("Not your turn.", true);
  const already = lastState.yourShots.some((s) => s.at.x === x && s.at.y === y);
  if (already) return toast("Already fired there.", true);
  sendWs({ type: "fire", x, y });
}

// ---- Result ----
function renderResult(s) {
  if (s.phase === "void") {
    $("resultBig").textContent = "Match voided";
    $("resultBig").className = "big lost";
    $("resultSub").textContent = "A board failed verification. Stakes are refunded.";
    return;
  }
  const won = s.winner === s.you;
  $("resultBig").textContent = won ? "Victory — pot is yours" : "Defeat";
  $("resultBig").className = "big " + (won ? "won" : "lost");
  $("resultSub").textContent = won
    ? `${s.potZec} ZEC sent to your shielded address.`
    : `${s.potZec} ZEC went to the winner.`;
  $("resultTxid").textContent = s.payoutTxid ? `payout tx: ${s.payoutTxid}` : "";
}

// ---- helpers ----
function coord(c) {
  return `${String.fromCharCode(65 + c.x)}${c.y + 1}`;
}
function short(t) {
  return t.slice(0, 8) + "…" + t.slice(-6);
}
let toastTimer;
function toast(msg, isErr = false) {
  let el = document.querySelector(".toast");
  if (!el) {
    el = document.createElement("div");
    document.body.appendChild(el);
  }
  el.className = "toast" + (isErr ? " err" : "");
  el.textContent = msg;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.remove(), 4000);
}

connect();
