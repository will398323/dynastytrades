// Grading engine: turns resolved trade data into Production / Dynasty Value / Blended grades.

// Replacement-level PPG for a superflex, 8-team league. Production only counts PPG above this.
export const REPLACEMENT = { QB: 12, RB: 8, WR: 8, TE: 6, K: 6, DEF: 5 };
export const MIN_GAMES = 6;       // fewer games than this is discounted proportionally
export const VALUE_POWER = 1.4;   // stars > a pile of depth when summing dynasty value
export const MIN_WEEKS = 3;       // production grade is "too early" before this many scored weeks
export const FULL_SEASON = 17;    // production reaches its full blended weight after a season

const ORD = { 1: '1st', 2: '2nd', 3: '3rd', 4: '4th' };

export function createGrader(data) {
  const { players: P, draftPicks: DP, pickValues: PV, managers: M, rosterOwners: RO, standings: ST, league } = data;

  function managerOf(roster, season) {
    const uid = RO[season]?.[roster] ?? RO[league.currentSeason]?.[roster];
    return uid && M[uid] ? { id: uid, ...M[uid] } : { id: `r${roster}`, name: `Team ${roster}`, team: `Team ${roster}`, avatar: null };
  }

  // ---- Future pick values ----
  // FantasyCalc's pick values are effectively 12-team values (they barely change with numTeams).
  // So we value a pick by its OVERALL number: in this 8-team league, 2.08 is #16 overall = a 12-team 2.04.
  // We build a value-by-overall-pick curve from FantasyCalc's Early/Mid/Late tiers and interpolate.
  const TEAMS = league.teams;
  const FC_TEAMS = 12;
  const TIER_POS = { Early: 2.5, Mid: 6.5, Late: 10.5 }; // average slot within a 12-team round
  const tierSeasons = [...new Set(Object.keys(PV).filter(k => k.split('-').length === 3).map(k => k.split('-')[0]))].sort();
  const genericSeasons = [...new Set(Object.keys(PV).map(k => k.split('-')[0]))].sort();
  const curveCache = {};
  function curveFor(season) {
    if (curveCache[season]) return curveCache[season];
    const base = tierSeasons[0];
    // Seasons past FantasyCalc's horizon reuse the furthest season it publishes.
    const s = genericSeasons.includes(String(season)) ? String(season) : genericSeasons[genericSeasons.length - 1];
    const pts = [];
    for (let r = 1; r <= 4; r++) {
      // Years without tiers: base-year tier shape, scaled by that year's round value.
      const scale = s === base || !PV[`${base}-${r}`] ? 1 : (PV[`${s}-${r}`] ?? PV[`${base}-${r}`]) / PV[`${base}-${r}`];
      for (const [tier, pos] of Object.entries(TIER_POS)) {
        const v = PV[`${s}-${r}-${tier}`] ?? (PV[`${base}-${r}-${tier}`] ?? 0) * scale;
        if (v) pts.push([(r - 1) * FC_TEAMS + pos, v]);
      }
    }
    pts.sort((a, b) => a[0] - b[0]);
    return (curveCache[season] = pts);
  }
  function valueAtOverall(season, overall) {
    const pts = curveFor(season);
    if (!pts.length) return 500;
    if (overall <= pts[0][0]) return pts[0][1];
    for (let i = 1; i < pts.length; i++) {
      if (overall <= pts[i][0]) {
        const [x0, y0] = pts[i - 1], [x1, y1] = pts[i];
        return y0 + (y1 - y0) * (overall - x0) / (x1 - x0);
      }
    }
    return pts[pts.length - 1][1];
  }
  const overallOf = (round, slot) => (round - 1) * TEAMS + slot;
  const slotLabel = (round, slot) => `${round}.${String(slot).padStart(2, '0')}`;

  // Projected draft slot for next year's picks from current standings (worst record picks 1st).
  function projectedSlot(season, origRoster) {
    if (Number(season) !== Number(league.currentSeason) + 1) return null;
    const st = ST[league.currentSeason];
    if (!st) return null;
    const pct = r => { const s = st[r]; const g = s.w + s.l + s.t; return g ? (s.w + s.t / 2) / g + s.pf / 1e6 : 0; };
    const order = Object.keys(st).sort((a, b) => pct(a) - pct(b));
    const idx = order.indexOf(String(origRoster));
    return idx < 0 ? null : idx + 1;
  }
  // How much to trust the standings: none in week 1, fully by the end of the regular season.
  const weeksPlayed = league.nflSeason === league.currentSeason ? Math.max(0, league.nflWeek - 1) : 0;
  const standingsConfidence = Number(league.nflSeason) > Number(league.currentSeason) ? 1 : Math.min(1, weeksPlayed / 15);

  function futurePickValue(season, round, origRoster) {
    round = Number(round);
    // Unknown slot: average over every slot the pick could land in.
    let expected = 0;
    for (let s = 1; s <= TEAMS; s++) expected += valueAtOverall(season, overallOf(round, s));
    expected /= TEAMS;
    const slot = projectedSlot(season, origRoster);
    if (!slot) return { v: expected, proj: null, overallRange: [overallOf(round, 1), overallOf(round, TEAMS)] };
    const projV = valueAtOverall(season, overallOf(round, slot));
    return {
      v: standingsConfidence * projV + (1 - standingsConfidence) * expected,
      proj: { slot, label: slotLabel(round, slot), overall: overallOf(round, slot) },
    };
  }

  function prodScore(pid, prod) {
    if (!prod || !prod.games) return 0;
    const pos = P[pid]?.pos;
    const ppg = prod.pts / prod.games;
    return Math.max(0, ppg - (REPLACEMENT[pos] ?? 8)) * Math.min(1, prod.games / MIN_GAMES);
  }

  // Describe one received/sent asset with everything the UI needs.
  function asset(a) {
    if (a.k === 'faab') return { kind: 'faab', label: `$${a.amount} FAAB`, value: 0, prod: 0, raw: a };
    if (a.k === 'player') {
      const p = P[a.id] || { n: a.id, pos: '?', v: 0 };
      return {
        kind: 'player', pid: a.id, player: p, label: p.n, value: p.v || 0,
        prod: prodScore(a.id, a.prod), stats: a.prod || null, raw: a,
      };
    }
    // Pick
    const [season, round, orig] = a.id.split('-');
    const dp = DP[a.id];
    const origMgr = managerOf(Number(orig), season);
    const base = {
      kind: 'pick', season, round: Number(round), origRoster: Number(orig), origMgr, raw: a,
      label: `${season} ${ORD[round] || round + 'th'}`,
    };
    if (dp && dp.playerId) {
      const p = P[dp.playerId] || { n: dp.playerId, pos: '?', v: 0 };
      return {
        ...base, resolved: true, slot: dp.label, pickNo: dp.pickNo, pid: dp.playerId, player: p,
        value: p.v || 0, prod: prodScore(dp.playerId, a.prod), stats: a.prod || null, flipped: a.flippedIn || null,
      };
    }
    const drafted = data.drafts[season]?.status === 'complete';
    if (drafted) return { ...base, resolved: false, missing: true, value: 0, prod: 0 };
    const fv = futurePickValue(season, round, orig);
    return { ...base, resolved: false, future: true, proj: fv.proj, overallRange: fv.overallRange, value: Math.round(fv.v), prod: 0 };
  }

  const shareOf = (xs) => { const t = xs.reduce((s, x) => s + x, 0); return t > 0 ? xs.map(x => x / t) : xs.map(() => 1 / xs.length); };

  // Grade one trade under all three metrics. weight = production share in Blended (0..1).
  function gradeTrade(tr, weight = 0.5) {
    const sides = tr.sides.map(s => {
      const gets = s.gets.map(asset);
      const gives = s.gives.map(asset);
      return {
        ...s, mgr: managerOf(s.roster, tr.season), getsA: gets, givesA: gives,
        prodTotal: gets.reduce((x, a) => x + a.prod, 0),
        valueTotal: gets.reduce((x, a) => x + a.value, 0),
        valuePow: gets.reduce((x, a) => x + Math.pow(a.value, VALUE_POWER), 0),
        hasPicks: s.gets.some(a => a.k === 'pick'),
      };
    });
    const n = sides.length;
    const prodShare = shareOf(sides.map(s => s.prodTotal));
    const valShare = shareOf(sides.map(s => s.valuePow));
    // Production needs time: hidden for brand-new trades, and phased into the blend over one season.
    const weeksSince = tr.weeksSince ?? FULL_SEASON;
    const prodAvailable = weeksSince >= MIN_WEEKS && sides.some(s => s.prodTotal > 0);
    const maturity = Math.min(1, weeksSince / FULL_SEASON);
    const w = prodAvailable ? weight * maturity : 0;
    sides.forEach((s, i) => {
      s.share = {
        production: prodShare[i],
        value: valShare[i],
        blended: w * prodShare[i] + (1 - w) * valShare[i],
      };
      // Relative score where 0.5 = fair regardless of number of teams.
      s.rel = Object.fromEntries(Object.entries(s.share).map(([k, v]) => [k, Math.min(1, v * n / 2)]));
      s.grade = Object.fromEntries(Object.entries(s.rel).map(([k, v]) => [k, letter(v)]));
    });
    return {
      ...tr, sides, prodAvailable, prodWeight: w, hasPicks: sides.some(s => s.hasPicks),
      stakeValue: sides.reduce((x, s) => x + s.valueTotal, 0),
      stakeProd: sides.reduce((x, s) => x + s.prodTotal, 0),
    };
  }

  // Current value of everything a tree branch still holds, attributing shared returns by value.
  function treeValue(node) {
    if (node.out === 'kept') return asset(node.a).value;
    if (node.out === 'holding') return asset(node.a).value;
    if (node.out === 'drafted') return (node.kids || []).reduce((s, k) => s + treeValue(k), 0);
    if (node.out === 'traded') {
      const mine = asset(node.a).value;
      const pkg = mine + (node.with || []).reduce((s, w) => s + asset(w).value, 0);
      const frac = pkg > 0 ? mine / pkg : 1 / (1 + (node.with || []).length);
      return frac * (node.kids || []).reduce((s, k) => s + treeValue(k), 0);
    }
    return 0;
  }

  return { asset, gradeTrade, managerOf, treeValue, prodScore, valueAtOverall, standingsConfidence };
}

export function letter(rel) {
  const bands = [[0.80, 'A+'], [0.70, 'A'], [0.64, 'A-'], [0.58, 'B+'], [0.54, 'B'], [0.50, 'B-'],
    [0.46, 'C+'], [0.42, 'C'], [0.36, 'C-'], [0.30, 'D'], [0.20, 'D-']];
  for (const [t, l] of bands) if (rel >= t - 1e-9) return l;
  return 'F';
}

export function gradeColor(l) {
  if (l.startsWith('A')) return 'g-a';
  if (l.startsWith('B')) return 'g-b';
  if (l.startsWith('C')) return 'g-c';
  if (l.startsWith('D')) return 'g-d';
  return 'g-f';
}
