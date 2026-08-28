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
// sets its "ID матча в API-Football" field. Once API-Football reports a
// terminal status (finished, in any way), the match is flagged fdDone and
// this script stops spending API quota on it.

import admin from "firebase-admin";

const STAGES = ["league", "europe"];
const TERMINAL_STATUSES = new Set(["FT", "AET", "PEN", "CANC", "ABD", "AWD", "WO"]);
const MAX_IDS_PER_REQUEST = 20; // API-Football's documented batch limit for ?ids=

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required environment variable: ${name}`);
    process.exit(1);
  }
  return value;
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
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

  // 1. Collect every match that has an fdId and isn't already marked done.
  const tracked = [];
  for (const stage of STAGES) {
    const snap = await db.ref(`predictions/${stage}`).get();
    const matches = snap.val() || {};
    for (const [matchId, m] of Object.entries(matches)) {
      if (m && m.fdId && !m.fdDone) {
        tracked.push({ stage, matchId, fdId: String(m.fdId) });
      }
    }
  }

  if (tracked.length === 0) {
    console.log("No tracked matches pending — nothing to do.");
    return;
  }
  console.log(`Tracking ${tracked.length} match(es):`, tracked.map((t) => `${t.stage}/${t.matchId}#${t.fdId}`).join(", "));

  // 2. Fetch all of them in as few requests as possible.
  const fixturesById = new Map();
  for (const ids of chunk(tracked.map((t) => t.fdId), MAX_IDS_PER_REQUEST)) {
    const url = `https://v3.football.api-sports.io/fixtures?ids=${ids.join("-")}`;
    const res = await fetch(url, { headers: { "x-apisports-key": apiKey } });
    if (!res.ok) {
      console.error(`API-Football request failed: ${res.status} ${res.statusText}`);
      continue;
    }
    const json = await res.json();
    if (json.errors && Object.keys(json.errors).length) {
      console.error("API-Football returned errors:", json.errors);
    }
    for (const item of json.response || []) {
      fixturesById.set(String(item.fixture.id), item);
    }
  }

  // 3. Map each fixture onto our schema and write only what changed.
  for (const t of tracked) {
    const fx = fixturesById.get(t.fdId);
    if (!fx) {
      console.warn(`No data returned for ${t.stage}/${t.matchId} (fdId ${t.fdId})`);
      continue;
    }

    const status = fx.fixture.status.short;
    const patch = {};

    if (fx.goals.home !== null && fx.goals.home !== undefined) patch.aH = String(fx.goals.home);
    if (fx.goals.away !== null && fx.goals.away !== undefined) patch.aA = String(fx.goals.away);

    if (t.stage === "europe") {
      if (fx.score.penalty && fx.score.penalty.home !== null) patch.time = "pen";
      else if (fx.score.extratime && fx.score.extratime.home !== null) patch.time = "et";
      else if (TERMINAL_STATUSES.has(status)) patch.time = "reg";
    }

    if (TERMINAL_STATUSES.has(status)) patch.fdDone = true;

    if (Object.keys(patch).length === 0) {
      console.log(`${t.stage}/${t.matchId}: status ${status}, nothing to update yet.`);
      continue;
    }

    await db.ref(`predictions/${t.stage}/${t.matchId}`).update(patch);
    console.log(`${t.stage}/${t.matchId}: updated`, patch);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("sync-scores failed:", err);
    process.exit(1);
  });
