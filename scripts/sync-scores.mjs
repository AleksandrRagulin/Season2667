// Pulls live/final scores from API-Football for every tracked match and
// writes them into Firebase Realtime Database, bypassing the app's normal
// per-player Security Rules via a service account (trusted server context).
//
// Run by .github/workflows/sync-scores.yml on a schedule. Requires env vars:
//   FIREBASE_SERVICE_ACCOUNT  — full JSON key of a Firebase service account
//   FIREBASE_DATABASE_URL     — e.g. https://<project>-default-rtdb.<region>.firebasedatabase.app
//   API_FOOTBALL_KEY          — key from dashboard.api-football.com
//
// A match is "tracked" once someone (only Александр Р. can, via the site)
// sets its "ID матча в API-Football" field.
//
// The free API-Football plan has no batch (?ids=) endpoint — every fixture
// costs its own request, against a 100/day quota — so this script is careful
// to only spend a request on a match that's actually close to kickoff or
// already playing, learned once via fdKickoff (cached after the first
// look-up) rather than polling blindly from the moment fdId is set. Once a
// match reaches a final status it's flagged fdDone and never polled again.

import admin from "firebase-admin";

const STAGES = ["league", "europe"];
const TERMINAL_STATUSES = new Set(["FT", "AET", "PEN", "CANC", "ABD", "AWD", "WO"]);

// How close to kickoff we start spending requests, and how long after
// kickoff we keep trying before giving up (covers delays/ET/penalties).
const WINDOW_BEFORE_MS = 20 * 60 * 1000;
const WINDOW_AFTER_MS = 3.5 * 60 * 60 * 1000;

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required environment variable: ${name}`);
    process.exit(1);
  }
  return value;
}

async function fetchFixture(fdId, apiKey) {
  const res = await fetch(`https://v3.football.api-sports.io/fixtures?id=${fdId}`, {
    headers: { "x-apisports-key": apiKey },
  });
  if (!res.ok) {
    console.error(`API-Football request failed for id ${fdId}: ${res.status} ${res.statusText}`);
    return null;
  }
  const json = await res.json();
  if (json.errors && Object.keys(json.errors).length) {
    console.error(`API-Football error for id ${fdId}:`, json.errors);
    return null;
  }
  return json.response && json.response[0] ? json.response[0] : null;
}

function fixtureToPatch(fx, stage, learnNames) {
  const status = fx.fixture.status.short;
  const patch = { fdKickoff: fx.fixture.date };

  // Team names only need to be written once, the first time we see this
  // fixture (learnNames) — otherwise a re-fetch could stomp a name someone
  // deliberately edited by hand on the site afterwards.
  if (learnNames) {
    if (fx.teams.home && fx.teams.home.name) patch.home = fx.teams.home.name;
    if (fx.teams.away && fx.teams.away.name) patch.away = fx.teams.away.name;
  }

  if (fx.goals.home !== null && fx.goals.home !== undefined) patch.aH = String(fx.goals.home);
  if (fx.goals.away !== null && fx.goals.away !== undefined) patch.aA = String(fx.goals.away);

  if (stage === "europe") {
    if (fx.score.penalty && fx.score.penalty.home !== null) patch.time = "pen";
    else if (fx.score.extratime && fx.score.extratime.home !== null) patch.time = "et";
    else if (TERMINAL_STATUSES.has(status)) patch.time = "reg";
  }

  if (TERMINAL_STATUSES.has(status)) patch.fdDone = true;
  return patch;
}

async function main() {
  const serviceAccountJson = requireEnv("FIREBASE_SERVICE_ACCOUNT");
  const databaseURL = requireEnv("FIREBASE_DATABASE_URL");
  const apiKey = requireEnv("API_FOOTBALL_KEY");

  const serviceAccount = JSON.parse(serviceAccountJson);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL,
  });
  const db = admin.database();
  const now = Date.now();

  let requestsSpent = 0;

  for (const stage of STAGES) {
    const snap = await db.ref(`predictions/${stage}`).get();
    const matches = snap.val() || {};

    for (const [matchId, m] of Object.entries(matches)) {
      if (!m || !m.fdId || m.fdDone) continue;
      const path = `${stage}/${matchId}`;

      const learnNames = !m.fdKickoff; // first time we see this fixture

      if (m.fdKickoff) {
        const kickoff = new Date(m.fdKickoff).getTime();
        if (now < kickoff - WINDOW_BEFORE_MS) {
          console.log(`${path}: kickoff not close yet (${m.fdKickoff}) — skipping.`);
          continue;
        }
        if (now > kickoff + WINDOW_AFTER_MS) {
          console.log(`${path}: well past kickoff window (${m.fdKickoff}) and still not finished — skipping this run.`);
          continue;
        }
      }
      // No cached kickoff yet — worth one request to learn it (and the
      // team names) even if kickoff turns out to be far in the future
      // (only happens once per match).

      const fx = await fetchFixture(m.fdId, apiKey);
      requestsSpent += 1;
      if (!fx) continue;

      const patch = fixtureToPatch(fx, stage, learnNames);
      await db.ref(`predictions/${path}`).update(patch);
      console.log(`${path}: updated`, patch);
    }
  }

  console.log(`Done. API requests spent this run: ${requestsSpent}.`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("sync-scores failed:", err);
    process.exit(1);
  });
