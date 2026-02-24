const express = require("express");
const crypto = require("crypto");

const app = express();
app.use(express.json());

// ─── Redis via Upstash REST API ───────────────────────────────────────────────
const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const USE_REDIS = !!(REDIS_URL && REDIS_TOKEN);

let memState = null;

async function redis(...args) {
  const res = await fetch(REDIS_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${REDIS_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(args),
  });
  if (!res.ok) throw new Error(`Redis ${res.status}`);
  return (await res.json()).result;
}

const KEY = "gcc:state";
const ROLE_TTL = 45000;

function freshState() {
  return {
    phase: "waiting",
    mode: "buzzer",
    choices: [],
    winner: null,
    winnerRole: null,
    winnerAnswer: null,
    buzzTime: null,
    judged: null,
    judgedTime: null,
    scores: { player1: 0, player2: 0 },
    round: 0,
    roles: { admin: null, player1: null, player2: null },
    seen: { admin: 0, player1: 0, player2: 0 },
    sessionEnd: null,
    ts: Date.now(),
  };
}

async function load() {
  if (!USE_REDIS) {
    if (!memState) memState = freshState();
    return memState;
  }
  const raw = await redis("GET", KEY);
  if (!raw) return freshState();
  try {
    return JSON.parse(raw);
  } catch {
    return freshState();
  }
}

async function save(s) {
  s.ts = Date.now();
  if (!USE_REDIS) {
    memState = s;
    return;
  }
  await redis("SET", KEY, JSON.stringify(s));
}

function tokenRole(s, token) {
  if (!token) return null;
  for (const [r, t] of Object.entries(s.roles)) {
    if (t === token) return r;
  }
  return null;
}

function expireStale(s) {
  const now = Date.now();
  let changed = false;
  for (const r of ["admin", "player1", "player2"]) {
    if (s.roles[r] && now - s.seen[r] > ROLE_TTL) {
      s.roles[r] = null;
      s.seen[r] = 0;
      changed = true;
    }
  }
  return changed;
}

// ─── Routes ───────────────────────────────────────────────────────────────────

// GET /api/state
app.get("/api/state", async (req, res) => {
  try {
    const s = await load();
    const role = tokenRole(s, req.query.token);
    res.json({
      phase: s.phase,
      mode: s.mode,
      choices: s.choices,
      winner: s.winner,
      winnerRole: s.winnerRole,
      winnerAnswer: s.winnerAnswer,
      buzzTime: s.buzzTime,
      judged: s.judged,
      judgedTime: s.judgedTime,
      scores: s.scores,
      round: s.round,
      ts: s.ts,
      role,
      sessionEnd: s.sessionEnd,
      serverTime: Date.now(),
    });
  } catch (e) {
    res.status(500).json({ error: "State read failed" });
  }
});

// POST /api/heartbeat
app.post("/api/heartbeat", async (req, res) => {
  try {
    const s = await load();
    const role = tokenRole(s, req.body.token);
    if (role) {
      s.seen[role] = Date.now();
      await save(s);
    }
    res.json({ ok: true, role });
  } catch (e) {
    res.status(500).json({ error: "Heartbeat failed" });
  }
});

// POST /api/register
app.post("/api/register", async (req, res) => {
  try {
    const { role, force } = req.body;
    if (!["admin", "player1", "player2"].includes(role)) {
      return res.status(400).json({ error: "Invalid role" });
    }
    const s = await load();
    expireStale(s);

    if (s.roles[role]) {
      if (force) {
        /* allow reclaim */
      } else {
        return res
          .status(409)
          .json({ error: `${role} is already taken! Choose another role.` });
      }
    }

    const token = crypto.randomBytes(16).toString("hex");
    s.roles[role] = token;
    s.seen[role] = Date.now();
    await save(s);
    res.json({ token, role });
  } catch (e) {
    res.status(500).json({ error: "Register failed" });
  }
});

// POST /api/release-role
app.post("/api/release-role", async (req, res) => {
  try {
    const s = await load();
    const role = tokenRole(s, req.body.token);
    if (role) {
      s.roles[role] = null;
      s.seen[role] = 0;
      await save(s);
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: "Release failed" });
  }
});

// POST /api/start-round — accepts { mode: "buzzer"|"choice", choices?: [] }
app.post("/api/start-round", async (req, res) => {
  try {
    const s = await load();
    if (tokenRole(s, req.body.token) !== "admin") {
      return res.status(403).json({ error: "Not admin" });
    }
    const mode = req.body.mode === "choice" ? "choice" : "buzzer";
    let choices = [];
    if (mode === "choice") {
      choices = (req.body.choices || [])
        .map((c) => String(c).trim())
        .filter(Boolean);
      if (choices.length < 2) {
        return res.status(400).json({ error: "Need at least 2 choices" });
      }
    }
    s.phase = "active";
    s.mode = mode;
    s.choices = choices;
    s.winner = null;
    s.winnerRole = null;
    s.winnerAnswer = null;
    s.buzzTime = null;
    s.judged = null;
    s.judgedTime = null;
    s.round += 1;
    s.sessionEnd = null;
    await save(s);
    res.json({ ok: true, round: s.round });
  } catch (e) {
    res.status(500).json({ error: "Start failed" });
  }
});

// POST /api/buzz — player buzzes (buzzer mode only)
app.post("/api/buzz", async (req, res) => {
  try {
    const s = await load();
    const role = tokenRole(s, req.body.token);
    if (role !== "player1" && role !== "player2") {
      return res.status(403).json({ error: "Not a player" });
    }
    if (s.phase !== "active" || s.mode !== "buzzer") {
      return res.json({ ok: false, locked: true });
    }
    const playerName = role === "player1" ? "Player 1" : "Player 2";
    s.phase = "answered";
    s.winner = playerName;
    s.winnerRole = role;
    s.buzzTime = Date.now();
    await save(s);
    res.json({ ok: true, winner: playerName });
  } catch (e) {
    res.status(500).json({ error: "Buzz failed" });
  }
});

// POST /api/submit-answer — player answers (choice mode, NO auto-score)
app.post("/api/submit-answer", async (req, res) => {
  try {
    const s = await load();
    const role = tokenRole(s, req.body.token);
    if (role !== "player1" && role !== "player2") {
      return res.status(403).json({ error: "Not a player" });
    }
    if (s.phase !== "active" || s.mode !== "choice") {
      return res.json({ ok: false, locked: true });
    }
    const playerName = role === "player1" ? "Player 1" : "Player 2";
    s.phase = "answered";
    s.winner = playerName;
    s.winnerRole = role;
    s.winnerAnswer = req.body.answer;
    await save(s);
    res.json({ ok: true, winner: playerName });
  } catch (e) {
    res.status(500).json({ error: "Submit failed" });
  }
});

// POST /api/judge — admin marks correct or incorrect
app.post("/api/judge", async (req, res) => {
  try {
    const s = await load();
    if (tokenRole(s, req.body.token) !== "admin") {
      return res.status(403).json({ error: "Not admin" });
    }
    if (s.phase !== "answered" || !s.winnerRole) {
      return res.status(400).json({ error: "Nothing to judge" });
    }
    const correct = !!req.body.correct;
    s.judged = correct ? "correct" : "incorrect";
    s.judgedTime = Date.now();
    if (correct) {
      s.scores[s.winnerRole] += 1;
    }
    await save(s);
    res.json({ ok: true, judged: s.judged, scores: { ...s.scores } });
  } catch (e) {
    res.status(500).json({ error: "Judge failed" });
  }
});

// POST /api/set-score — admin sets exact score for a player
app.post("/api/set-score", async (req, res) => {
  try {
    const s = await load();
    if (tokenRole(s, req.body.token) !== "admin") {
      return res.status(403).json({ error: "Not admin" });
    }
    const { player, score } = req.body;
    if (player !== "player1" && player !== "player2") {
      return res.status(400).json({ error: "Invalid player" });
    }
    const val = Math.max(0, Math.floor(Number(score) || 0));
    s.scores[player] = val;
    await save(s);
    res.json({ ok: true, scores: { ...s.scores } });
  } catch (e) {
    res.status(500).json({ error: "Set score failed" });
  }
});

// POST /api/reset-round
app.post("/api/reset-round", async (req, res) => {
  try {
    const s = await load();
    if (tokenRole(s, req.body.token) !== "admin") {
      return res.status(403).json({ error: "Not admin" });
    }
    s.phase = "waiting";
    s.choices = [];
    s.winner = null;
    s.winnerRole = null;
    s.winnerAnswer = null;
    s.buzzTime = null;
    s.judged = null;
    s.judgedTime = null;
    s.sessionEnd = null;
    await save(s);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: "Reset failed" });
  }
});

// POST /api/end-session
app.post("/api/end-session", async (req, res) => {
  try {
    const s = await load();
    if (tokenRole(s, req.body.token) !== "admin") {
      return res.status(403).json({ error: "Not admin" });
    }
    const sessionEnd = {
      finalScores: { ...s.scores },
      totalRounds: s.round,
    };
    s.phase = "waiting";
    s.mode = "buzzer";
    s.choices = [];
    s.winner = null;
    s.winnerRole = null;
    s.winnerAnswer = null;
    s.buzzTime = null;
    s.judged = null;
    s.judgedTime = null;
    s.scores = { player1: 0, player2: 0 };
    s.round = 0;
    s.sessionEnd = sessionEnd;
    await save(s);
    res.json({ ok: true, ...sessionEnd });
  } catch (e) {
    res.status(500).json({ error: "End session failed" });
  }
});

module.exports = app;
