// Builds site/data/league.json from the Sleeper and FantasyCalc public APIs.
// Run: node scripts/build-data.mjs
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const config = JSON.parse(await readFile(path.join(ROOT, 'config.json'), 'utf8'));
const SLEEPER = 'https://api.sleeper.app/v1/';

async function getJSON(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`${res.status} ${url}`);
      return await res.json();
    } catch (e) {
      if (i === tries - 1) throw e;
      await new Promise(r => setTimeout(r, 800 * (i + 1)));
    }
  }
}
const sl = p => getJSON(SLEEPER + p);

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }));
  return out;
}

// The full NFL player DB is large; cache it for 24h locally.
async function getPlayersDB() {
  const cacheDir = path.join(ROOT, '.cache');
  const file = path.join(cacheDir, 'players.json');
  try {
    const s = await stat(file);
    if (Date.now() - s.mtimeMs < 24 * 3600e3) return JSON.parse(await readFile(file, 'utf8'));
  } catch {}
  const db = await sl('players/nfl');
  await mkdir(cacheDir, { recursive: true });
  await writeFile(file, JSON.stringify(db));
  return db;
}

console.log('Fetching league history…');
const state = await sl('state/nfl');
const leagues = [];
for (let id = config.leagueId; id && id !== '0';) {
  const lg = await sl('league/' + id);
  leagues.push(lg);
  id = lg.previous_league_id;
}
leagues.reverse(); // oldest first
const seasons = leagues.map(l => l.season);
const seasonIdx = Object.fromEntries(seasons.map((s, i) => [s, i]));
const current = leagues[leagues.length - 1];
// Absolute week ordinal used to compare times across seasons.
const ord = (season, week) => (Number(season) - Number(seasons[0])) * 100 + week;

const managers = {};
const rosterOwners = {};
const standings = {};
const transactions = [];
const weekly = {}; // season -> week -> rosterId -> {m:Set, s:Set, p:{}}
const drafts = {};
const draftPicks = {};

for (const lg of leagues) {
  const S = lg.season;
  console.log(`  ${S}: ${lg.name}`);
  const [users, rosters, draftList] = await Promise.all([
    sl(`league/${lg.league_id}/users`), sl(`league/${lg.league_id}/rosters`), sl(`league/${lg.league_id}/drafts`),
  ]);
  for (const u of users) {
    // Later seasons overwrite earlier, so names reflect the most recent season.
    managers[u.user_id] = {
      name: u.display_name,
      team: u.metadata?.team_name || u.display_name,
      avatar: u.avatar ? `https://sleepercdn.com/avatars/thumbs/${u.avatar}` : null,
    };
  }
  rosterOwners[S] = Object.fromEntries(rosters.map(r => [r.roster_id, r.owner_id]));
  standings[S] = Object.fromEntries(rosters.map(r => [r.roster_id, {
    w: r.settings.wins, l: r.settings.losses, t: r.settings.ties,
    pf: r.settings.fpts + (r.settings.fpts_decimal || 0) / 100,
  }]));

  const txWeeks = await pool([...Array(19).keys()], 6, w => sl(`league/${lg.league_id}/transactions/${w}`));
  for (const t of txWeeks.flat()) {
    if (t.status !== 'complete') continue;
    transactions.push({ ...t, season: S });
  }

  const isCurrent = S === state.season;
  const lastWeek = isCurrent ? Math.max(0, state.week - (state.season_type === 'regular' ? 1 : 0)) : 18;
  const weeks = [...Array(lastWeek).keys()].map(i => i + 1);
  const mu = await pool(weeks, 6, w => sl(`league/${lg.league_id}/matchups/${w}`));
  weekly[S] = {};
  weeks.forEach((w, i) => {
    const rows = mu[i] || [];
    if (!rows.length) return;
    weekly[S][w] = {};
    for (const r of rows) {
      weekly[S][w][r.roster_id] = {
        m: new Set(r.players || []),
        s: new Set(r.starters || []),
        p: r.players_points || {},
      };
    }
  });

  for (const d of draftList) {
    const full = await sl('draft/' + d.draft_id);
    const picks = d.status === 'complete' || d.status === 'drafting' ? await sl(`draft/${d.draft_id}/picks`) : [];
    drafts[d.season] = {
      id: d.draft_id, type: d.type, status: d.status, rounds: d.settings.rounds, teams: d.settings.teams,
      startTime: d.start_time, slotToRoster: full.slot_to_roster_id || null,
    };
    const rosterToSlot = Object.fromEntries(Object.entries(full.slot_to_roster_id || {}).map(([s, r]) => [r, Number(s)]));
    for (const p of picks) {
      // Pick identity = season / round / ORIGINAL roster (the slot owner), which is how Sleeper tracks traded picks.
      const origRoster = full.slot_to_roster_id?.[p.draft_slot] ?? p.roster_id;
      const key = `${d.season}-${p.round}-${origRoster}`;
      const inRound = d.type === 'snake' && p.round % 2 === 0 ? d.settings.teams - p.draft_slot + 1 : p.draft_slot;
      draftPicks[key] = {
        season: d.season, round: p.round, origRoster: Number(origRoster), pickNo: p.pick_no,
        label: `${p.round}.${String(inRound).padStart(2, '0')}`,
        playerId: p.player_id, pickedBy: p.roster_id, ts: d.start_time,
      };
    }
    void rosterToSlot;
  }
}

transactions.sort((a, b) => a.created - b.created);
const pickKey = p => `${p.season}-${p.round}-${p.roster_id}`;

// Sleeper doesn't timestamp individual picks, only the draft start. Slow drafts run for days and picks
// get traded mid-draft, so a pick is "used" no earlier than just after its last trade.
let midDraftTrades = 0;
for (const t of transactions) {
  if (t.type !== 'trade') continue;
  for (const p of t.draft_picks || []) {
    const dp = draftPicks[pickKey(p)];
    if (dp && t.created >= dp.ts) { dp.ts = t.created + 1; midDraftTrades++; }
  }
}

// ---------- Trades ----------
const trades = transactions.filter(t => t.type === 'trade').map(t => {
  const sides = t.roster_ids.map(r => {
    const gets = [], gives = [];
    for (const [pid, to] of Object.entries(t.adds || {})) if (to === r) gets.push({ k: 'player', id: pid });
    for (const [pid, from] of Object.entries(t.drops || {})) if (from === r) gives.push({ k: 'player', id: pid });
    for (const p of t.draft_picks || []) {
      if (p.owner_id === r) gets.push({ k: 'pick', id: pickKey(p) });
      if (p.previous_owner_id === r) gives.push({ k: 'pick', id: pickKey(p) });
    }
    for (const f of t.waiver_budget || []) {
      if (f.receiver === r) gets.push({ k: 'faab', amount: f.amount });
      if (f.sender === r) gives.push({ k: 'faab', amount: f.amount });
    }
    return { roster: r, user: rosterOwners[t.season]?.[r] ?? null, gets, gives };
  });
  return { id: t.transaction_id, ts: t.created, season: t.season, week: t.leg, sides };
});

// ---------- Exit lookup + production ----------
function nextExit(playerId, roster, afterTs) {
  for (const t of transactions) {
    if (t.created <= afterTs) continue;
    if (t.drops && t.drops[playerId] === roster && !(t.adds && t.adds[playerId] === roster)) return t;
  }
  return null;
}
function nextPickTrade(key, holder, afterTs) {
  for (const t of transactions) {
    if (t.created <= afterTs || t.type !== 'trade') continue;
    if ((t.draft_picks || []).some(p => pickKey(p) === key && p.previous_owner_id === holder)) return t;
  }
  return null;
}

function production(playerId, roster, startSeason, startWeek, afterTs) {
  const exit = nextExit(playerId, roster, afterTs);
  const from = ord(startSeason, startWeek);
  const to = exit ? ord(exit.season, exit.leg) : Infinity;
  let pts = 0, games = 0, starts = 0, startPts = 0, weeks = 0;
  for (const S of seasons) for (const [w, rows] of Object.entries(weekly[S] || {})) {
    const o = ord(S, Number(w));
    if (o < from || o > to) continue;
    const row = rows[roster];
    if (!row || !row.m.has(playerId)) continue;
    weeks++;
    const p = row.p[playerId] || 0;
    if (p !== 0) { games++; pts += p; }
    if (row.s.has(playerId)) { starts++; startPts += p; }
  }
  return {
    pts: +pts.toFixed(2), games, starts, startPts: +startPts.toFixed(2), weeks,
    exit: exit ? { type: exit.type, ts: exit.created, tradeId: exit.type === 'trade' ? exit.transaction_id : null } : null,
  };
}

// Scored weeks that have elapsed since each trade (used to phase production into the blend).
const scoredWeeks = seasons.flatMap(S => Object.keys(weekly[S] || {}).map(w => ord(S, Number(w))));
for (const tr of trades) tr.weeksSince = scoredWeeks.filter(o => o >= ord(tr.season, tr.week)).length;

// Production for every received asset on every trade side.
for (const tr of trades) {
  for (const side of tr.sides) {
    for (const a of side.gets) {
      if (a.k === 'player') {
        a.prod = production(a.id, side.roster, tr.season, tr.week, tr.ts);
      } else if (a.k === 'pick') {
        const dp = draftPicks[a.id];
        const flipped = nextPickTrade(a.id, side.roster, tr.ts);
        a.flippedIn = flipped && (!dp || flipped.created < dp.ts) ? flipped.transaction_id : null;
        if (dp && !a.flippedIn && dp.pickedBy === side.roster && dp.playerId) {
          a.prod = production(dp.playerId, side.roster, dp.season, 0, dp.ts);
        }
      }
    }
  }
}

// ---------- Trade trees ----------
// Follows what the receiving team did with each asset: kept it, drafted with it, dropped it, or flipped it.
const tradeById = Object.fromEntries(trades.map(t => [t.id, t]));
function tree(asset, holder, afterTs, depth = 0) {
  const node = { a: asset.k === 'faab' ? { k: 'faab', amount: asset.amount } : { k: asset.k, id: asset.id }, holder };
  if (asset.k === 'faab') { node.out = 'faab'; return node; }
  if (depth > 7) { node.out = 'deep'; return node; }
  let exitTx = null;
  if (asset.k === 'pick') {
    const dp = draftPicks[asset.id];
    const flip = nextPickTrade(asset.id, holder, afterTs);
    if (flip && (!dp || flip.created < dp.ts)) exitTx = flip;
    else if (dp) {
      if (dp.pickedBy === holder && dp.playerId) {
        node.out = 'drafted';
        node.kids = [tree({ k: 'player', id: dp.playerId }, holder, dp.ts, depth + 1)];
        return node;
      }
      node.out = 'unknown'; return node;
    } else { node.out = 'holding'; return node; }
  } else {
    exitTx = nextExit(asset.id, holder, afterTs);
    if (!exitTx) { node.out = 'kept'; return node; }
    if (exitTx.type !== 'trade') { node.out = 'dropped'; node.ts = exitTx.created; return node; }
  }
  const tr = tradeById[exitTx.transaction_id];
  const side = tr.sides.find(s => s.roster === holder);
  node.out = 'traded';
  node.tradeId = tr.id;
  node.ts = tr.ts;
  node.with = side.gives.filter(g => !(g.k === asset.k && g.id === asset.id)).map(g => ({ k: g.k, id: g.id, amount: g.amount }));
  node.kids = side.gets.map(g => tree(g, holder, tr.ts, depth + 1));
  return node;
}
for (const tr of trades) for (const side of tr.sides) side.tree = side.gets.map(a => tree(a, side.roster, tr.ts));

// ---------- Asset journeys ----------
// Unlike trees (which follow what a team got BACK), a journey follows the asset itself through every owner:
// pick traded → drafted by whoever held it → player traded / released / picked up → where he is now.
const MAX_STEPS = 14;
function nextPlayerMove(playerId, afterTs) {
  for (const t of transactions) if (t.created > afterTs && (t.adds?.[playerId] != null || t.drops?.[playerId] != null)) return t;
  return null;
}
function journey(asset, holder, afterTs) {
  const steps = [];
  let ts = afterTs;
  let pid = asset.k === 'player' ? asset.id : null;
  if (asset.k === 'pick') {
    const dp = draftPicks[asset.id];
    for (;;) {
      const t = nextPickTrade(asset.id, holder, ts);
      if (!t || (dp && t.created > dp.ts)) break;
      const to = t.draft_picks.find(p => pickKey(p) === asset.id && p.previous_owner_id === holder).owner_id;
      steps.push({ e: 'traded', from: holder, to, ts: t.created, season: t.season, tradeId: t.transaction_id });
      holder = to; ts = t.created;
      if (steps.length >= MAX_STEPS) return { steps, more: true };
    }
    if (!dp || !dp.playerId) { steps.push({ e: 'holding', by: holder }); return { steps }; }
    steps.push({ e: 'drafted', by: dp.pickedBy, season: dp.season, ts: dp.ts, pid: dp.playerId, slot: dp.label, pickNo: dp.pickNo });
    holder = dp.pickedBy; ts = dp.ts; pid = dp.playerId;
  }
  if (asset.k === 'faab') return { steps };
  // Follow the player. holder = null means he's a free agent.
  for (;;) {
    const t = nextPlayerMove(pid, ts);
    if (!t) break;
    ts = t.created;
    const from = t.drops?.[pid] ?? null, to = t.adds?.[pid] ?? null;
    if (t.type === 'trade') steps.push({ e: 'traded', from, to, ts, season: t.season, tradeId: t.transaction_id, pid });
    else if (from != null && to == null) steps.push({ e: 'released', by: from, ts, season: t.season, pid });
    else if (to != null) steps.push({ e: 'added', by: to, from, ts, season: t.season, pid, how: t.type });
    holder = to;
    if (steps.length >= MAX_STEPS) return { steps, more: true };
  }
  steps.push(holder != null ? { e: 'current', by: holder, pid } : { e: 'fa', pid });
  return { steps };
}
for (const tr of trades) for (const side of tr.sides) side.journeys = side.gets.map(a => journey(a, side.roster, tr.ts));

// ---------- Values ----------
console.log('Fetching FantasyCalc dynasty values…');
const fc = config.fantasyCalc;
const fcRows = await getJSON(`https://api.fantasycalc.com/values/current?isDynasty=${fc.isDynasty}&numQbs=${fc.numQbs}&numTeams=${fc.numTeams}&ppr=${fc.ppr}`);
const valueBySleeper = {};
const pickValues = {};
const ordName = { 1: '1st', 2: '2nd', 3: '3rd', 4: '4th' };
for (const r of fcRows) {
  if (r.player.position === 'PICK') {
    const m = r.player.name.match(/^(\d{4}) (\d)(?:st|nd|rd|th)(?: \((Early|Mid|Late)\))?$/);
    if (m) pickValues[`${m[1]}-${m[2]}${m[3] ? '-' + m[3] : ''}`] = r.value;
  } else if (r.player.sleeperId) {
    valueBySleeper[r.player.sleeperId] = { v: r.value, rank: r.overallRank, prank: r.positionRank };
  }
}

// ---------- Players ----------
console.log('Fetching player database…');
const db = await getPlayersDB();
const needed = new Set();
const collect = n => { if (n.a.k === 'player') needed.add(n.a.id); (n.kids || []).forEach(collect); };
for (const tr of trades) for (const s of tr.sides) {
  for (const a of [...s.gets, ...s.gives]) if (a.k === 'player') needed.add(a.id);
  s.tree.forEach(collect);
}
for (const dp of Object.values(draftPicks)) if (dp.playerId) needed.add(dp.playerId);
const players = {};
for (const id of needed) {
  const p = db[id] || {};
  players[id] = {
    n: p.full_name || (p.first_name ? `${p.first_name} ${p.last_name}` : (p.position === 'DEF' ? `${id} D/ST` : id)),
    pos: p.position || '?', team: p.team || 'FA', age: p.age ?? null,
    ...(valueBySleeper[id] ? { v: valueBySleeper[id].v, rank: valueBySleeper[id].rank, prank: valueBySleeper[id].prank } : { v: 0 }),
  };
}

// Only keep draft picks referenced by trades (keeps the file small).
const usedPicks = {};
const collectPick = n => { if (n.a.k === 'pick' && draftPicks[n.a.id]) usedPicks[n.a.id] = draftPicks[n.a.id]; (n.kids || []).forEach(collectPick); };
for (const tr of trades) for (const s of tr.sides) {
  for (const a of [...s.gets, ...s.gives]) if (a.k === 'pick' && draftPicks[a.id]) usedPicks[a.id] = draftPicks[a.id];
  s.tree.forEach(collectPick);
}

const out = {
  generatedAt: new Date().toISOString(),
  league: {
    id: current.league_id, name: current.name, avatar: current.avatar ? `https://sleepercdn.com/avatars/thumbs/${current.avatar}` : null,
    seasons, currentSeason: current.season, nflWeek: state.week, nflSeason: state.season,
    teams: current.total_rosters,
    scoring: { ppr: current.scoring_settings.rec, tePremium: current.scoring_settings.bonus_rec_te || 0, superflex: current.roster_positions.includes('SUPER_FLEX') },
  },
  managers, rosterOwners, standings, drafts, draftPicks: usedPicks, pickValues, players, trades,
};
await mkdir(path.join(ROOT, 'site', 'data'), { recursive: true });
await writeFile(path.join(ROOT, 'site', 'data', 'league.json'), JSON.stringify(out));
console.log(`Picks traded mid-draft: ${midDraftTrades}`);
console.log(`Done: ${trades.length} trades, ${trades.filter(t => t.sides.some(s => s.gets.some(a => a.k === 'pick'))).length} with picks, ${Object.keys(players).length} players.`);
