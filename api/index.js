const express = require("express");
const crypto = require("crypto");

const app = express();
app.use(express.json());

// ─── Game State (in-memory, shared across routes in same function instance) ───
let gameState = {
  phase: "waiting", // 'waiting' | 'active' | 'answered'
  choices: [],
  winner: null, // 'Player 1' or 'Player 2'
  winnerAnswer: null,
  scores: { player1: 0, player2: 0 },
  round: 0,
  lastUpdate: Date.now(),
};

// Role tokens: each role maps to a unique token when claimed
let roleTokens = { admin: null, player1: null, player2: null };

// Track when each role last polled (for auto-expiry)
let roleLastSeen = { admin: 0, player1: 0, player2: 0 };

// How long before a role is considered abandoned (ms)
const ROLE_EXPIRY_MS = 15000;

// Stored session-end results (shown until next round starts)
let sessionEndData = null;

// ─── Helpers ──────────────────────────────────────────────────────────────────
function genToken() {
  return crypto.randomBytes(16).toString("hex");
}

function roleOf(token) {
  if (!token) return null;
  for (const [role, t] of Object.entries(roleTokens)) {
    if (t === token) return role;
  }
  return null;
}

// Auto-expire roles that haven't polled recently
function expireStaleRoles() {
  const now = Date.now();
  for (const role of ["admin", "player1", "player2"]) {
    if (roleTokens[role] && now - roleLastSeen[role] > ROLE_EXPIRY_MS) {
      console.log(`Auto-expiring stale role: ${role}`);
      roleTokens[role] = null;
      roleLastSeen[role] = 0;
    }
  }
}

function touch() {
  gameState.lastUpdate = Date.now();
}

// ─── Routes ───────────────────────────────────────────────────────────────────

// GET /api/state — polled by every client ~350ms
app.get("/api/state", (req, res) => {
  expireStaleRoles();
  const role = roleOf(req.query.token);
  // Update last-seen timestamp for this role
  if (role) roleLastSeen[role] = Date.now();
  res.json({
    phase: gameState.phase,
    choices: gameState.choices,
    winner: gameState.winner,
    winnerAnswer: gameState.winnerAnswer,
    scores: { ...gameState.scores },
    round: gameState.round,
    lastUpdate: gameState.lastUpdate,
    role,
    sessionEndData,
  });
});

// POST /api/register — claim a role
app.post("/api/register", (req, res) => {
  const { role, force } = req.body;
  if (!["admin", "player1", "player2"].includes(role)) {
    return res.status(400).json({ error: "Invalid role" });
  }
  // Expire stale roles before checking
  expireStaleRoles();
  if (roleTokens[role]) {
    // If force=true, allow reclaiming (client lost connection, same user)
    if (force) {
      console.log(`Force-reclaiming role: ${role}`);
    } else {
      return res
        .status(409)
        .json({ error: `${role} is already taken! Choose another role.` });
    }
  }
  const token = genToken();
  roleTokens[role] = token;
  roleLastSeen[role] = Date.now();
  res.json({ token, role });
});

// POST /api/release-role — free a role (leave / page close)
app.post("/api/release-role", (req, res) => {
  const role = roleOf(req.body.token);
  if (role) {
    roleTokens[role] = null;
    roleLastSeen[role] = 0;
  }
  res.json({ ok: true });
});

// POST /api/start-round — admin starts a new round
app.post("/api/start-round", (req, res) => {
  if (roleOf(req.body.token) !== "admin") {
    return res.status(403).json({ error: "Not admin" });
  }
  const choices = (req.body.choices || [])
    .map((c) => String(c).trim())
    .filter(Boolean);
  if (choices.length < 2) {
    return res.status(400).json({ error: "Need at least 2 choices" });
  }

  gameState.phase = "active";
  gameState.choices = choices;
  gameState.winner = null;
  gameState.winnerAnswer = null;
  gameState.round += 1;
  sessionEndData = null;
  touch();

  res.json({ ok: true, round: gameState.round });
});

// POST /api/submit-answer — player buzzes in (first POST wins)
app.post("/api/submit-answer", (req, res) => {
  const role = roleOf(req.body.token);
  if (role !== "player1" && role !== "player2") {
    return res.status(403).json({ error: "Not a player" });
  }
  if (gameState.phase !== "active") {
    return res.json({ ok: false, locked: true });
  }

  const playerName = role === "player1" ? "Player 1" : "Player 2";

  // Lockout — first valid answer wins
  gameState.phase = "answered";
  gameState.winner = playerName;
  gameState.winnerAnswer = req.body.answer;
  gameState.scores[role] += 1;
  touch();

  res.json({ ok: true, winner: playerName });
});

// POST /api/reset-round — admin resets (keeps scores)
app.post("/api/reset-round", (req, res) => {
  if (roleOf(req.body.token) !== "admin") {
    return res.status(403).json({ error: "Not admin" });
  }

  gameState.phase = "waiting";
  gameState.choices = [];
  gameState.winner = null;
  gameState.winnerAnswer = null;
  sessionEndData = null;
  touch();

  res.json({ ok: true });
});

// POST /api/end-session — admin ends session, wipes scores
app.post("/api/end-session", (req, res) => {
  if (roleOf(req.body.token) !== "admin") {
    return res.status(403).json({ error: "Not admin" });
  }

  sessionEndData = {
    finalScores: { ...gameState.scores },
    totalRounds: gameState.round,
  };

  gameState = {
    phase: "waiting",
    choices: [],
    winner: null,
    winnerAnswer: null,
    scores: { player1: 0, player2: 0 },
    round: 0,
    lastUpdate: Date.now(),
  };

  res.json({ ok: true, ...sessionEndData });
});

// POST /api/award-point — admin manually adds a point
app.post("/api/award-point", (req, res) => {
  if (roleOf(req.body.token) !== "admin") {
    return res.status(403).json({ error: "Not admin" });
  }
  const { player } = req.body;
  if (player !== "player1" && player !== "player2") {
    return res.status(400).json({ error: "Invalid player" });
  }
  gameState.scores[player] += 1;
  touch();
  res.json({ ok: true, scores: { ...gameState.scores } });
});

// POST /api/deduct-point — admin manually removes a point
app.post("/api/deduct-point", (req, res) => {
  if (roleOf(req.body.token) !== "admin") {
    return res.status(403).json({ error: "Not admin" });
  }
  const { player } = req.body;
  if (player !== "player1" && player !== "player2") {
    return res.status(400).json({ error: "Invalid player" });
  }
  gameState.scores[player] = Math.max(0, gameState.scores[player] - 1);
  touch();
  res.json({ ok: true, scores: { ...gameState.scores } });
});

module.exports = app;
