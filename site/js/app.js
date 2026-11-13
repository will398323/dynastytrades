import { createGrader, letter, gradeColor, REPLACEMENT, MIN_GAMES } from './grade.js';

const $ = s => document.querySelector(s);
const app = $('#app');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = n => Math.round(n).toLocaleString();
const fmtDate = ts => new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
const store = {
  get(k, d) { try { const v = localStorage.getItem('stt:' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('stt:' + k, JSON.stringify(v)); } catch {} },
};

const METRICS = { production: 'Production', value: 'Dynasty Value', blended: 'Blended' };
const state = {
  metric: store.get('metric', 'blended'),
  weight: store.get('weight', 50),
  filters: { season: 'all', mgr: 'all', picks: true, sort: 'new', q: '', shown: 30, ...store.get('filters', {}) },
};
state.filters.shown = 30;

let DATA, G, TRADES = [], BY_ID = {};

// ---------- Boot ----------
init();
async function init() {
  try {
    const res = await fetch('data/league.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error(res.status);
    DATA = await res.json();
  } catch (e) {
    app.innerHTML = `<div class="empty">Couldn't load league data. Run <code>npm run build-data</code> first.</div>`;
    return;
  }
  G = createGrader(DATA);
  const L = DATA.league;
  document.title = `${L.name} · Trade Tracker`;
  $('#league-name').textContent = `${L.name} Trade Tracker`;
  $('#league-sub').textContent = `${L.teams} teams · ${L.scoring.superflex ? 'Superflex · ' : ''}${L.scoring.ppr} PPR · ${L.seasons[0]}–${L.currentSeason}`;
  if (L.avatar) { const img = $('#league-avatar'); img.src = L.avatar; img.hidden = false; }
  $('#foot').innerHTML = `Data from Sleeper &amp; FantasyCalc · refreshed ${fmtDate(DATA.generatedAt)} ${new Date(DATA.generatedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;

  $('#metric').addEventListener('click', e => {
    const m = e.target.closest('button')?.dataset.m; if (!m) return;
    state.metric = m; store.set('metric', m); syncMetricUI(); render();
  });
  $('#weight').addEventListener('input', e => {
    state.weight = Number(e.target.value); store.set('weight', state.weight);
    $('#weight-label').textContent = state.weight + '%';
    regrade(); render();
  });
  $('#modal-x').addEventListener('click', closeModal);
  $('#modal').addEventListener('click', e => { if (e.target.id === 'modal') closeModal(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });
  window.addEventListener('hashchange', () => { render(); window.scrollTo(0, 0); });

  syncMetricUI();
  regrade();
  render();
  maybeShowAnniversaryPopup();
}

function syncMetricUI() {
  document.querySelectorAll('#metric button').forEach(b => b.classList.toggle('on', b.dataset.m === state.metric));
  $('#weight-wrap').hidden = state.metric !== 'blended';
  $('#weight').value = state.weight;
  $('#weight-label').textContent = state.weight + '%';
}

let MAX_STAKE = { v: 1, p: 1 };
function regrade() {
  TRADES = DATA.trades.map(t => G.gradeTrade(t, state.weight / 100)).sort((a, b) => b.ts - a.ts);
  BY_ID = Object.fromEntries(TRADES.map(t => [t.id, t]));
  MAX_STAKE = { v: Math.max(1, ...TRADES.map(t => t.stakeValue)), p: Math.max(1, ...TRADES.map(t => t.stakeProd)) };
}
// How much was on the table (0..1) under the current metric, so tiny deals don't top the fleece charts.
function stake(t) {
  const w = m() === 'production' ? 1 : m() === 'value' ? 0 : t.prodWeight;
  return w * t.stakeProd / MAX_STAKE.p + (1 - w) * t.stakeValue / MAX_STAKE.v;
}
const isMinor = t => t.stakeValue < 2500 && t.stakeProd < 3;
// Lopsidedness that accounts for stakes: share gap × sqrt(stake).
function fleeceScore(t) {
  const r = t.sides.map(s => s.rel[m()]);
  return (Math.max(...r) - Math.min(...r)) * Math.sqrt(stake(t));
}

function render() {
  const [, route = 'trades', arg] = location.hash.split('/');
  document.querySelectorAll('#tabs a').forEach(a => a.classList.toggle('on',
    a.dataset.tab === route || (route === 'trade' && a.dataset.tab === 'trades') || (route === 'manager' && a.dataset.tab === 'managers')));
  const views = { trades: viewTrades, trade: viewTrade, awards: viewAwards, managers: viewManagers, manager: viewManager, anniversaries: viewAnniversaries, how: viewHow };
  (views[route] || viewTrades)(arg && decodeURIComponent(arg));
}

// ---------- Shared bits ----------
const m = () => state.metric;
function avatar(mgr, size = '') {
  if (mgr.avatar) return `<img class="avatar ${size}" src="${esc(mgr.avatar)}" alt="" loading="lazy" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'avatar ${size}',textContent:'${esc((mgr.name || '?')[0].toUpperCase())}'}))">`;
  return `<div class="avatar ${size}">${esc((mgr.name || '?')[0].toUpperCase())}</div>`;
}
function headshot(pid, pos) {
  const src = pos === 'DEF' ? `https://sleepercdn.com/images/team_logos/nfl/${String(pid).toLowerCase()}.png` : `https://sleepercdn.com/content/nfl/players/thumb/${pid}.jpg`;
  return `<img class="head" src="${src}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">`;
}
const gradeBadge = (l, size = '') => `<span class="grade ${size} ${gradeColor(l)}">${l}</span>`;
const mgrLink = mgr => mgr.id.startsWith('r') ? esc(mgr.name) : `<a href="#/manager/${encodeURIComponent(mgr.id)}">${esc(mgr.name)}</a>`;

function statFor(a) {
  const st = a.stats;
  const prodTxt = st && st.games ? `<b>${(st.pts / st.games).toFixed(1)}</b>PPG · ${st.games}g` : (a.kind === 'pick' && a.flipped ? '<b>—</b>flipped' : '<b>—</b>no games');
  const valTxt = `<b>${a.value ? fmt(a.value) : '—'}</b>value`;
  if (a.kind === 'faab') return '';
  if (m() === 'production') return prodTxt;
  if (m() === 'value') return valTxt;
  return `${st && st.games ? `<b>${(st.pts / st.games).toFixed(1)} PPG</b>` : '<b>— PPG</b>'}${a.value ? fmt(a.value) : '—'} value`;
}

function assetRow(a) {
  if (a.kind === 'faab') return `<div class="asset"><div class="pick-tile">$</div><div class="info"><div class="name">${esc(a.label)}</div><div class="meta">Waiver budget</div></div></div>`;
  if (a.kind === 'player') {
    const p = a.player;
    return `<div class="asset">${headshot(a.pid, p.pos)}<div class="info"><div class="name">${esc(p.n)}</div>
      <div class="meta"><span class="pos-${esc(p.pos)}">${esc(p.pos)}</span> · ${esc(p.team)}${p.prank ? ` · ${esc(p.pos)}${p.prank}` : ''}</div></div>
      <div class="stat">${statFor(a)}</div></div>`;
  }
  const via = `via ${esc(a.origMgr.name)}`;
  let line;
  if (a.resolved) {
    line = `<div class="pick-line meta"><span class="arrow">→</span><span class="slot">${esc(a.slot)}</span><span class="muted">#${a.pickNo}</span>
      <span>${esc(a.player.n)} <span class="pos-${esc(a.player.pos)}">${esc(a.player.pos)}</span></span></div>`;
  } else if (a.future) {
    line = `<div class="meta">${futureTxt(a)}</div>`;
  } else {
    line = `<div class="meta">Pick not found in draft results</div>`;
  }
  return `<div class="asset">${a.resolved ? headshot(a.pid, a.player.pos) : `<div class="pick-tile">R${a.round}</div>`}
    <div class="info"><div class="name">${esc(a.label)} <span class="muted small">${via}</span></div>${line}</div>
    <div class="stat">${statFor(a)}</div></div>`;
}

function futureTxt(a) {
  if (a.proj) return `Not drafted yet · projects <span class="slot">${a.proj.label}</span> (#${a.proj.overall})`;
  return `Not drafted yet · #${a.overallRange[0]}–${a.overallRange[1]} overall`;
}

function verdict(t) {
  const sorted = [...t.sides].sort((a, b) => b.rel[m()] - a.rel[m()]);
  const top = sorted[0], r = top.rel[m()];
  if (m() === 'production' && !t.prodAvailable) return { txt: 'Too early', cls: '' };
  if (isMinor(t)) return r >= 0.58 ? { txt: `${top.mgr.name} won (small stakes)`, cls: '', winner: top } : { txt: 'Fair trade', cls: '' };
  if (r >= 0.80) return { txt: `🚨 ${top.mgr.name} robbed them`, cls: 'big', winner: top };
  if (r >= 0.70) return { txt: `${top.mgr.name} fleeced`, cls: 'big', winner: top };
  if (r >= 0.58) return { txt: `${top.mgr.name} won`, cls: 'win', winner: top };
  return { txt: 'Fair trade', cls: '' };
}

function shareBar(t) {
  const segs = t.sides.map((s, i) => `<span class="c${i % 4}" style="width:${(s.share[m()] * 100).toFixed(1)}%"></span>`).join('');
  const labels = t.sides.map(s => `<span>${esc(s.mgr.name)} ${(s.share[m()] * 100).toFixed(0)}%</span>`).join('');
  return `<div class="sharebar">${segs}</div><div class="sharelabels">${labels}</div>`;
}

function tradeCard(t, extraHead = '') {
  const v = verdict(t);
  const sides = t.sides.map(s => `
    <div class="side">
      <div class="side-head">${avatar(s.mgr)}<div class="who"><div class="who-name">${mgrLink(s.mgr)}</div><div class="who-sub">${esc(s.mgr.team)}</div></div>
        ${m() === 'production' && !t.prodAvailable ? '<span class="grade g-c" title="No games played yet">?</span>' : gradeBadge(s.grade[m()])}</div>
      <div class="recv">Receives</div>
      ${s.getsA.map((a, i) => assetWithHistory(a, s.journeys?.[i], s)).join('') || '<div class="muted small">Nothing</div>'}
    </div>`).join('');
  return `<article class="trade">
    <div class="trade-head"><a href="#/trade/${t.id}">${fmtDate(t.ts)} · ${t.season} wk ${t.week} ›</a>${extraHead}<span class="verdict ${v.cls}">${esc(v.txt)}</span></div>
    <div class="sides">${sides}</div>
    <div class="trade-foot">${shareBar(t)}</div>
  </article>`;
}

// ---------- Trades list ----------
function allManagers() {
  const ids = new Set();
  for (const t of TRADES) for (const s of t.sides) ids.add(s.mgr.id);
  return [...ids].map(id => TRADES.flatMap(t => t.sides).find(s => s.mgr.id === id).mgr).sort((a, b) => a.name.localeCompare(b.name));
}

function filteredTrades() {
  const f = state.filters, q = f.q.trim().toLowerCase();
  let list = TRADES.filter(t =>
    (f.season === 'all' || t.season === f.season) &&
    (f.mgr === 'all' || t.sides.some(s => s.mgr.id === f.mgr)) &&
    (!f.picks || t.hasPicks) &&
    (!q || t.sides.some(s => s.mgr.name.toLowerCase().includes(q) || s.getsA.some(a =>
      (a.player?.n || '').toLowerCase().includes(q) || (a.label || '').toLowerCase().includes(q)))));
  const gap = t => { const r = t.sides.map(s => s.rel[m()]); return Math.max(...r) - Math.min(...r); };
  if (f.sort === 'old') list = [...list].sort((a, b) => a.ts - b.ts);
  if (f.sort === 'lop') list = [...list].sort((a, b) => fleeceScore(b) - fleeceScore(a));
  if (f.sort === 'fair') list = [...list].sort((a, b) => (gap(a) - gap(b)) || (stake(b) - stake(a)));
  return list;
}

function viewTrades() {
  const f = state.filters;
  const seasons = [...DATA.league.seasons].reverse();
  const list = filteredTrades();
  const mgrs = allManagers();
  app.innerHTML = `
    <div class="filters">
      <input type="search" id="f-q" placeholder="Search player or manager…" value="${esc(f.q)}">
      <select id="f-season"><option value="all">All seasons</option>${seasons.map(s => `<option ${f.season === s ? 'selected' : ''}>${s}</option>`).join('')}</select>
      <select id="f-mgr"><option value="all">All managers</option>${mgrs.map(x => `<option value="${esc(x.id)}" ${f.mgr === x.id ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select>
      <select id="f-sort">
        <option value="new" ${f.sort === 'new' ? 'selected' : ''}>Newest</option>
        <option value="old" ${f.sort === 'old' ? 'selected' : ''}>Oldest</option>
        <option value="lop" ${f.sort === 'lop' ? 'selected' : ''}>Most lopsided</option>
        <option value="fair" ${f.sort === 'fair' ? 'selected' : ''}>Most even</option>
      </select>
      <label class="chip-toggle"><input type="checkbox" id="f-picks" ${f.picks ? 'checked' : ''}> Has draft picks</label>
      <span class="count">${list.length} trade${list.length === 1 ? '' : 's'}</span>
    </div>
    <div id="list">${list.slice(0, f.shown).map(t => tradeCard(t)).join('') || '<div class="empty">No trades match.</div>'}</div>
    ${list.length > f.shown ? `<div class="more"><button class="btn" id="more">Show more (${list.length - f.shown} left)</button></div>` : ''}`;
  const upd = (k, v) => { f[k] = v; if (k !== 'shown') f.shown = 30; store.set('filters', { ...f, shown: undefined }); viewTrades(); };
  $('#f-season').onchange = e => upd('season', e.target.value);
  $('#f-mgr').onchange = e => upd('mgr', e.target.value);
  $('#f-sort').onchange = e => upd('sort', e.target.value);
  $('#f-picks').onchange = e => upd('picks', e.target.checked);
  let timer;
  $('#f-q').oninput = e => { clearTimeout(timer); timer = setTimeout(() => { upd('q', e.target.value); const el = $('#f-q'); el.focus(); el.setSelectionRange(el.value.length, el.value.length); }, 250); };
  if ($('#more')) $('#more').onclick = () => upd('shown', f.shown + 30);
}

// ---------- Trade detail ----------
function viewTrade(id) {
  const t = BY_ID[id];
  if (!t) { app.innerHTML = '<div class="empty">Trade not found.</div>'; return; }
  const rows = t.sides.map(s => `<tr>
    <td>${avatar(s.mgr, 'sm')}</td><td><b>${mgrLink(s.mgr)}</b></td>
    ${['production', 'value', 'blended'].map(k => `<td class="${m() === k ? 'on' : ''}">${k === 'production' && !t.prodAvailable ? '<span class="muted">n/a</span>' : gradeBadge(s.grade[k], 'sm')} <span class="muted small">${(s.share[k] * 100).toFixed(0)}%</span></td>`).join('')}
  </tr>`).join('');
  const assetTable = s => `<div class="table-wrap"><table class="grade-table">
      <tr><th>Asset</th><th class="num">Games</th><th class="num">PPG</th><th class="num">Pts</th><th class="num">Starts</th><th class="num">Value</th></tr>
      ${s.getsA.map(a => {
        const st = a.stats;
        const nm = a.kind === 'pick' ? `${esc(a.label)} <span class="muted small">via ${esc(a.origMgr.name)}</span>${a.resolved ? ` → <span class="slot">${a.slot}</span> <span class="muted small">#${a.pickNo}</span> ${esc(a.player.n)}` : a.future ? ` <span class="muted small">${futureTxt(a)}</span>` : ''}` : esc(a.label);
        return `<tr><td>${nm}</td><td class="num">${st ? st.games : '—'}</td><td class="num">${st && st.games ? (st.pts / st.games).toFixed(1) : '—'}</td>
          <td class="num">${st ? st.pts.toFixed(0) : '—'}</td><td class="num">${st ? st.starts : '—'}</td><td class="num">${a.value ? fmt(a.value) : '—'}</td></tr>`;
      }).join('')}
    </table></div>`;

  app.innerHTML = `
    <a class="back" href="#/trades">‹ All trades</a>
    <h1>${t.sides.map(s => esc(s.mgr.name)).join(' ⇄ ')}</h1>
    <p class="lede">${fmtDate(t.ts)} · ${t.season} season, week ${t.week} · ${ageText(t.ts)}</p>
    ${tradeCard(t)}
    <div class="panel"><h2 style="margin-top:0">Grades, all three ways</h2>
      <div class="table-wrap"><table class="grade-table">
        <tr><th></th><th>Manager</th><th>Production</th><th>Dynasty value</th><th>Blended (${Math.round(t.prodWeight * 100)}% prod)</th></tr>${rows}
      </table></div>
      <p class="muted small" style="margin-bottom:0">Percent = share of the trade's total under that metric.
        ${!t.prodAvailable ? 'Too early for production to mean anything, so Blended uses value only.'
          : t.prodWeight < state.weight / 100 - 1e-9 ? `Only ${t.weeksSince} weeks have been played since this trade, so production is phased in at ${Math.round(t.prodWeight * 100)}% instead of ${state.weight}%.` : ''}</p>
    </div>
    ${t.sides.map(s => `
      <div class="panel">
        <h2 style="margin-top:0">What ${esc(s.mgr.name)} got</h2>
        ${assetTable(s)}
        <h2>Trade tree <span class="muted small">— what ${esc(s.mgr.name)} did with it next</span></h2>
        <ul class="tree">${s.tree.map(n => treeNode(n)).join('')}</ul>
        <p class="small muted">Branch value still on ${esc(s.mgr.name)}'s roster today: <b>${fmt(s.tree.reduce((x, n) => x + G.treeValue(n), 0))}</b>
          vs <b>${fmt(s.valueTotal)}</b> for the original assets.</p>
      </div>`).join('')}`;
}

function ageText(ts) {
  const days = Math.floor((Date.now() - ts) / 864e5);
  if (days < 60) return `${days} days ago`;
  const months = Math.round(days / 30.4);
  if (months < 24) return `${months} months ago`;
  return `${(days / 365.25).toFixed(1)} years ago`;
}

function nodeChip(a) {
  const x = G.asset(a);
  if (x.kind === 'faab') return `<span class="pick-tile">$</span><b>${esc(x.label)}</b>`;
  if (x.kind === 'player') return `${headshot(x.pid, x.player.pos)}<b>${esc(x.player.n)}</b><span class="muted small">${esc(x.player.pos)}${x.value ? ' · ' + fmt(x.value) : ''}</span>`;
  return `<span class="pick-tile">R${x.round}</span><b>${esc(x.label)}</b><span class="muted small">via ${esc(x.origMgr.name)}${x.future ? ' · ' + fmt(x.value) : ''}</span>`;
}

const tradedTo = n => BY_ID[n.tradeId]?.sides.filter(s => s.roster !== n.holder).map(s => s.mgr.name).join(', ') || '?';
function outText(n) {
  switch (n.out) {
    case 'kept': return '<span class="out kept">✓ still on roster</span>';
    case 'holding': return '<span class="out kept">✓ still holding pick</span>';
    case 'drafted': return `<span class="out">drafted at <span class="slot">${esc(DATA.draftPicks[n.a.id]?.label)}</span> (#${DATA.draftPicks[n.a.id]?.pickNo})</span>`;
    case 'dropped': return `<span class="out dropped">✗ released ${fmtDate(n.ts)}</span>`;
    case 'traded': {
      const w = (n.with || []).length ? ` with ${n.with.map(x => esc(G.asset(x).player?.n || G.asset(x).label)).join(', ')}` : '';
      return `<span class="out">↪ <a href="#/trade/${n.tradeId}">traded to ${esc(tradedTo(n))} ${fmtDate(n.ts)}</a>${w}</span>`;
    }
    case 'faab': return '';
    default: return '<span class="out">?</span>';
  }
}
function treeNode(n) {
  const kids = (n.kids || []).length ? `<ul>${n.kids.map(treeNode).join('')}</ul>` : '';
  return `<li><div class="node">${nodeChip(n.a)}${outText(n)}</div>${kids}</li>`;
}

// ---------- Asset journeys (dropdowns in trade cards) ----------
// Follows the asset itself through every owner, so it's clear who drafted, cut, or flipped it.
const who = (roster, season) => roster == null ? 'free agency' : G.managerOf(roster, season || DATA.league.currentSeason).name;
const pname = pid => DATA.players[pid]?.n || pid;

function journeySteps(j, trade, side) {
  const items = [];
  const step = (icon, cls, date, html) => items.push(`<li class="j-${cls}"><span class="j-dot">${icon}</span><div class="j-txt">${date ? `<span class="j-date">${date}</span>` : ''}${html}</div></li>`);
  for (const s of j.steps) {
    const d = s.ts ? fmtDate(s.ts) : '';
    switch (s.e) {
      case 'traded': {
        const what = s.pid ? `<b>${esc(pname(s.pid))}</b>` : 'the pick';
        step('⇄', 'trade', d, `<b>${esc(who(s.from, s.season))}</b> traded ${what} to <b>${esc(who(s.to, s.season))}</b> <a href="#/trade/${s.tradeId}">view trade ›</a>
          ${gotBack(s.tradeId, s.from, s.season)}`);
        break;
      }
      case 'drafted':
        step('🎯', 'draft', d, `<b>${esc(who(s.by, s.season))}</b> used it at <span class="slot">${esc(s.slot)}</span> (#${s.pickNo}) on <b>${esc(pname(s.pid))}</b> ${esc(DATA.players[s.pid]?.pos || '')}`);
        break;
      case 'released':
        step('✗', 'cut', d, `<b>${esc(who(s.by, s.season))}</b> released <b>${esc(pname(s.pid))}</b>`);
        break;
      case 'added':
        step('＋', 'add', d, `<b>${esc(who(s.by, s.season))}</b> picked up <b>${esc(pname(s.pid))}</b> ${s.how === 'waiver' ? 'off waivers' : s.how === 'commissioner' ? '(commissioner move)' : 'in free agency'}`);
        break;
      case 'holding':
        step('⏳', 'now', 'Now', `<b>${esc(who(s.by))}</b> still holds the pick`);
        break;
      case 'current': {
        const v = DATA.players[s.pid]?.v;
        step('✓', 'now', 'Now', `<b>${esc(pname(s.pid))}</b> is on <b>${esc(who(s.by))}</b>'s roster${v ? ` · ${fmt(v)} value` : ''}`);
        break;
      }
      case 'fa':
        step('·', 'gone', 'Now', `<b>${esc(pname(s.pid))}</b> is a free agent`);
        break;
    }
  }
  if (j.more) step('…', 'gone', '', '<span class="muted">more moves not shown</span>');
  return `<ol class="journey">${items.join('')}</ol>`;
}

// What a team received in a later trade. Each item can be opened to show its own timeline,
// rendered lazily on first open so deep chains don't bloat the page.
const assetShort = a => a.kind === 'pick' && a.resolved ? `${a.label} (${a.player.n})` : a.player?.n || a.label;
function gotBack(tradeId, roster, season) {
  const side = BY_ID[tradeId]?.sides.find(x => x.roster === roster);
  if (!side || !side.getsA.length) return '';
  const items = side.getsA.map((a, i) => {
    const j = side.journeys?.[i];
    const moved = j && a.kind !== 'faab' && j.steps.some(s => ['traded', 'released', 'added'].includes(s.e));
    if (!moved) {
      const last = j?.steps[j.steps.length - 1];
      const tail = last?.e === 'current' ? ` <span class="pos">· on ${esc(who(last.by))} now</span>` : last?.e === 'holding' ? ' <span class="pos">· still held</span>' : '';
      return `<div class="gb-item"><span class="gb-name">${esc(assetShort(a))}</span>${tail}</div>`;
    }
    return `<details class="gb-item gb-open" data-trade="${tradeId}" data-roster="${roster}" data-idx="${i}">
      <summary><span class="gb-name">${esc(assetShort(a))}</span> ${journeySummary(j, side)} <span class="chev" aria-hidden="true">▾</span></summary>
      <div class="gb-body"></div></details>`;
  });
  return `<div class="j-sub">${esc(who(roster, season))} got back:</div><div class="gb">${items.join('')}</div>`;
}
document.addEventListener('toggle', e => {
  const el = e.target;
  if (!(el instanceof HTMLDetailsElement) || !el.matches('.gb-open') || !el.open) return;
  const body = el.querySelector(':scope > .gb-body');
  if (body.childElementCount) return;
  const side = BY_ID[el.dataset.trade]?.sides.find(x => x.roster === Number(el.dataset.roster));
  const j = side?.journeys?.[Number(el.dataset.idx)];
  if (j) body.innerHTML = journeySteps(j);
}, true);

// Short "where did it end up" line under the asset row.
function journeySummary(j, side) {
  const parts = [];
  for (const s of j.steps) {
    if (s.e === 'traded') parts.push(`→ ${esc(who(s.to, s.season))}`);
    else if (s.e === 'drafted') parts.push(`${s.by === side.roster && !parts.length ? '' : esc(who(s.by, s.season)) + ' '}drafted ${esc(pname(s.pid))}`);
    else if (s.e === 'released') parts.push(`<span class="neg">cut</span>`);
    else if (s.e === 'added') parts.push(`→ ${esc(who(s.by, s.season))} (FA)`);
    else if (s.e === 'current') parts.push(`<span class="pos">on ${esc(who(s.by))} now</span>`);
    else if (s.e === 'holding') parts.push(`<span class="pos">${esc(who(s.by))} holds it</span>`);
    else if (s.e === 'fa') parts.push('free agent');
  }
  const shown = parts.length > 5 ? [...parts.slice(0, 2), '…', ...parts.slice(-2)] : parts;
  return `<span class="out">${shown.join(' <span class="muted">·</span> ')}</span>`;
}

// A trade-card asset that expands to show where it went afterward.
function assetWithHistory(a, j, side) {
  const row = assetRow(a);
  if (!j || a.kind === 'faab') return row;
  // Nothing to tell if it's still sitting on the receiving roster (or drafted and kept there).
  const moved = j.steps.some(s => ['traded', 'released', 'added'].includes(s.e));
  if (!moved) return row;
  return `<details class="hist"><summary>${row}<div class="hist-line">${journeySummary(j, side)}<span class="chev" aria-hidden="true">▾</span></div></summary>
    <div class="hist-body">${journeySteps(j)}</div></details>`;
}

// ---------- Per-manager aggregation ----------
function managerStats() {
  const mm = {};
  const W = 0.58, L = 0.42;
  for (const t of TRADES) {
    for (const s of t.sides) {
      const id = s.mgr.id;
      const r = mm[id] ||= { mgr: s.mgr, trades: [], w: 0, l: 0, e: 0, rels: [], netValue: 0, netProd: 0, picksIn: 0, picksOut: 0, partners: {} };
      const rel = s.rel[m()];
      const counts = !(m() === 'production' && !t.prodAvailable);
      r.trades.push({ t, s });
      if (counts) {
        r.rels.push(rel);
        if (rel >= W) r.w++; else if (rel <= L) r.l++; else r.e++;
      }
      r.netValue += s.getsA.reduce((x, a) => x + a.value, 0) - s.givesA.reduce((x, a) => x + a.value, 0);
      r.netProd += s.getsA.reduce((x, a) => x + (a.stats?.pts || 0), 0);
      r.picksIn += s.gets.filter(a => a.k === 'pick').length;
      r.picksOut += s.gives.filter(a => a.k === 'pick').length;
      for (const o of t.sides) if (o !== s) {
        const p = r.partners[o.mgr.id] ||= { mgr: o.mgr, n: 0, w: 0, l: 0 };
        p.n++; if (counts && rel >= W) p.w++; if (counts && rel <= L) p.l++;
      }
    }
  }
  // Points given away = points the other side's received assets scored for them.
  for (const r of Object.values(mm)) {
    r.avg = r.rels.length ? r.rels.reduce((a, b) => a + b, 0) / r.rels.length : 0.5;
    r.letter = letter(r.avg);
    let ptsOut = 0;
    for (const { t, s } of r.trades) for (const o of t.sides) if (o !== s) ptsOut += o.getsA.reduce((x, a) => x + (a.stats?.pts || 0), 0);
    r.netProd -= ptsOut;
    const scored = r.trades.filter(x => !(m() === 'production' && !x.t.prodAvailable));
    r.best = scored.length ? scored.reduce((a, b) => b.s.rel[m()] > a.s.rel[m()] ? b : a) : null;
    r.worst = scored.length ? scored.reduce((a, b) => b.s.rel[m()] < a.s.rel[m()] ? b : a) : null;
    r.fav = Object.values(r.partners).sort((a, b) => b.n - a.n)[0] || null;
  }
  return Object.values(mm).sort((a, b) => b.avg - a.avg);
}

// ---------- Awards ----------
function viewAwards() {
  const scored = TRADES.filter(t => !(m() === 'production' && !t.prodAvailable) && t.sides.length >= 2);
  const lop = t => { const s = [...t.sides].sort((a, b) => b.rel[m()] - a.rel[m()]); return { t, win: s[0], lose: s[s.length - 1], r: fleeceScore(t) }; };
  const ranked = scored.map(lop).filter(x => x.win.rel[m()] >= 0.58).sort((a, b) => b.r - a.r);
  const stats = managerStats();
  const qualified = stats.filter(s => s.rels.length >= 3);

  // Asset-level score under the current metric (blended normalizes both scales).
  const all = TRADES.flatMap(t => t.sides.flatMap(s => s.getsA));
  const maxP = Math.max(1, ...all.map(a => a.prod)), maxV = Math.max(1, ...all.map(a => a.value));
  const w = state.weight / 100;
  const aScore = a => m() === 'production' ? a.prod : m() === 'value' ? a.value : w * a.prod / maxP + (1 - w) * a.value / maxV;

  const pickRecv = TRADES.flatMap(t => t.sides.flatMap(s => s.getsA.filter(a => a.kind === 'pick' && a.resolved).map(a => ({ t, s, a }))));
  const bestPick = pickRecv.filter(x => !x.a.flipped).sort((x, y) => aScore(y.a) - aScore(x.a))[0];
  const lottery = pickRecv.filter(x => !x.a.flipped && x.a.round >= 3).sort((x, y) => aScore(y.a) - aScore(x.a))[0];
  // Should've kept it: the pick a manager sent away that became the best player.
  const pickSent = TRADES.flatMap(t => t.sides.flatMap(s => s.givesA.filter(a => a.kind === 'pick' && a.resolved).map(a => ({ t, s, a }))));
  const regret = pickSent.sort((x, y) => aScore(y.a) - aScore(x.a))[0];
  const hoarder = [...stats].sort((a, b) => (b.picksIn - b.picksOut) - (a.picksIn - a.picksOut))[0];
  const seller = [...stats].sort((a, b) => (b.picksOut - b.picksIn) - (a.picksOut - a.picksIn))[0];
  const active = [...stats].sort((a, b) => b.trades.length - a.trades.length)[0];
  const sharp = [...qualified].sort((a, b) => b.avg - a.avg)[0];
  const generous = [...qualified].sort((a, b) => a.avg - b.avg)[0];
  const pairs = {};
  for (const t of TRADES) if (t.sides.length === 2) {
    const [a, b] = [...t.sides].sort((x, y) => x.mgr.id.localeCompare(y.mgr.id));
    (pairs[a.mgr.id + '|' + b.mgr.id] ||= { a: a.mgr, b: b.mgr, n: 0 }).n++;
  }
  const rivalry = Object.values(pairs).sort((x, y) => y.n - x.n)[0];
  const blockbuster = [...TRADES].sort((x, y) => y.sides.reduce((s, z) => s + z.gets.length, 0) - x.sides.reduce((s, z) => s + z.gets.length, 0))[0];

  const assetName = a => a.kind === 'pick' ? `${a.label} (${a.slot}) → ${a.player.n}` : a.label;
  const scoreTxt = a => m() === 'production' ? (a.stats?.games ? `${(a.stats.pts / a.stats.games).toFixed(1)} PPG over ${a.stats.games} games` : 'no games') : m() === 'value' ? `${fmt(a.value)} dynasty value` : `${a.stats?.games ? (a.stats.pts / a.stats.games).toFixed(1) + ' PPG · ' : ''}${fmt(a.value)} value`;

  const card = (emoji, title, desc, mgr, detail, link) => !mgr ? '' : `<div class="award">
      <div class="emoji">${emoji}</div><div class="title">${title}</div><div class="desc">${desc}</div>
      <div class="winner">${avatar(mgr)}<div><div class="nm">${esc(mgr.name)}</div><div class="detail">${detail}</div></div></div>
      ${link ? `<a class="link" href="${link}">${link.startsWith('#/manager') ? 'View report card' : 'View trade'} ›</a>` : ''}</div>`;

  const f = ranked[0];
  const seasonsF = [...DATA.league.seasons].reverse().map(S => ranked.find(x => x.t.season === S)).filter(Boolean);

  app.innerHTML = `
    <h1>Awards</h1>
    <p class="lede">Judged by <b>${METRICS[m()]}</b>. Switch the metric up top and the trophies move.</p>
    <div class="awards">
      ${f ? card('🏆', 'Biggest Fleece', 'The most lopsided trade in league history.', f.win.mgr, `got ${(f.win.share[m()] * 100).toFixed(0)}% of the value from ${esc(f.lose.mgr.name)}`, `#/trade/${f.t.id}`) : ''}
      ${sharp ? card('🧠', 'Sharpest Trader', 'Best average trade grade (3+ trades).', sharp.mgr, `${sharp.letter} average · ${sharp.w}-${sharp.l}-${sharp.e} W-L-Even`, `#/manager/${encodeURIComponent(sharp.mgr.id)}`) : ''}
      ${generous ? card('🎁', 'Most Generous', 'Lowest average trade grade. Thanks for your service.', generous.mgr, `${generous.letter} average · ${generous.w}-${generous.l}-${generous.e}`, `#/manager/${encodeURIComponent(generous.mgr.id)}`) : ''}
      ${bestPick ? card('🔮', 'Best Pick Acquired', 'Traded for a pick, turned it into this.', bestPick.s.mgr, `${esc(assetName(bestPick.a))} · ${scoreTxt(bestPick.a)}`, `#/trade/${bestPick.t.id}`) : ''}
      ${regret ? card('😭', "Should've Kept It", 'Traded away a pick that became a star.', regret.s.mgr, `sent ${esc(assetName(regret.a))} · ${scoreTxt(regret.a)}`, `#/trade/${regret.t.id}`) : ''}
      ${lottery ? card('🎰', 'Lottery Ticket', 'Best player from a 3rd round or later pick acquired by trade.', lottery.s.mgr, `${esc(assetName(lottery.a))} · ${scoreTxt(lottery.a)}`, `#/trade/${lottery.t.id}`) : ''}
      ${hoarder ? card('🐿️', 'Pick Hoarder', 'Most draft picks acquired, net.', hoarder.mgr, `+${hoarder.picksIn - hoarder.picksOut} net (${hoarder.picksIn} in, ${hoarder.picksOut} out)`) : ''}
      ${seller ? card('🔥', 'Win-Now Mode', 'Most draft picks shipped out, net. Future? Never heard of it.', seller.mgr, `−${seller.picksOut - seller.picksIn} net (${seller.picksOut} out, ${seller.picksIn} in)`) : ''}
      ${active ? card('📞', 'Most Active Trader', 'Never met a trade offer they did not answer.', active.mgr, `${active.trades.length} trades`) : ''}
      ${rivalry ? `<div class="award"><div class="emoji">🤝</div><div class="title">Favorite Trade Partners</div><div class="desc">The pair that keeps calling each other.</div>
        <div class="winner">${avatar(rivalry.a)}${avatar(rivalry.b)}<div><div class="nm">${esc(rivalry.a.name)} & ${esc(rivalry.b.name)}</div><div class="detail">${rivalry.n} trades together</div></div></div></div>` : ''}
      ${blockbuster ? card('💥', 'Blockbuster', 'Most total assets moved in one trade.', blockbuster.sides[0].mgr, `${blockbuster.sides.reduce((s, z) => s + z.gets.length, 0)} assets with ${esc(blockbuster.sides.slice(1).map(s => s.mgr.name).join(', '))}`, `#/trade/${blockbuster.id}`) : ''}
    </div>
    <h2>Fleece of the Year</h2>
    <div class="awards">${seasonsF.map(x => card('📅', `${x.t.season} Fleece of the Year`, `${fmtDate(x.t.ts)}`, x.win.mgr, `over ${esc(x.lose.mgr.name)} · ${gradeBadge(x.win.grade[m()], 'sm')} vs ${gradeBadge(x.lose.grade[m()], 'sm')}`, `#/trade/${x.t.id}`)).join('')}</div>
    <h2>💀 Hall of Shame</h2>
    <p class="lede">The worst sides of a trade, ranked by how lopsided it was <i>and</i> how much was at stake.</p>
    <ol class="shame">${ranked.slice(0, 10).map(x => `<li>${avatar(x.lose.mgr)}<div class="txt"><b>${esc(x.lose.mgr.name)}</b> ${gradeBadge(x.lose.grade[m()], 'sm')} gave
      ${esc(x.lose.givesA.map(a => a.kind === 'pick' && a.resolved ? `${a.label} (${a.player.n})` : a.player?.n || a.label).join(', ') || 'nothing')}
      to <b>${esc(x.win.mgr.name)}</b> for ${esc(x.lose.getsA.map(a => a.kind === 'pick' && a.resolved ? `${a.label} (${a.player.n})` : a.player?.n || a.label).join(', ') || 'nothing')}
      <div class="muted small">${fmtDate(x.t.ts)}</div></div><a href="#/trade/${x.t.id}">View ›</a></li>`).join('')}</ol>`;
}

// ---------- Report cards ----------
function viewManagers() {
  const stats = managerStats();
  const sign = n => `<span class="${n >= 0 ? 'pos' : 'neg'}">${n >= 0 ? '+' : '−'}${fmt(Math.abs(n))}</span>`;
  app.innerHTML = `
    <h1>Report Cards</h1>
    <p class="lede">Trader grades by <b>${METRICS[m()]}</b>. A win is a side scoring B+ or better; a loss is C or worse.</p>
    <div class="cards">${stats.map(r => `
      <a class="rc" href="#/manager/${encodeURIComponent(r.mgr.id)}">
        <div class="rc-top">${avatar(r.mgr, 'lg')}<div class="who"><div class="rc-name">${esc(r.mgr.name)}</div><div class="muted small">${esc(r.mgr.team)}</div></div>${gradeBadge(r.letter, 'xl')}</div>
        <div class="stats">
          <div class="stat-box"><div class="k">Record</div><div class="v">${r.w}-${r.l}-${r.e}</div></div>
          <div class="stat-box"><div class="k">Trades</div><div class="v">${r.trades.length}</div></div>
          <div class="stat-box"><div class="k">Picks in/out</div><div class="v">${r.picksIn}/${r.picksOut}</div></div>
          <div class="stat-box"><div class="k">Net value</div><div class="v">${sign(r.netValue)}</div></div>
          <div class="stat-box"><div class="k">Net points</div><div class="v">${sign(r.netProd)}</div></div>
          <div class="stat-box"><div class="k">Avg share</div><div class="v">${(r.avg * 100).toFixed(0)}%</div></div>
        </div>
        <div class="rc-lines">
          ${r.fav ? `<div><span class="k">Favorite partner:</span> ${esc(r.fav.mgr.name)} (${r.fav.n} trades, ${r.fav.w}-${r.fav.l})</div>` : ''}
          ${r.best ? `<div><span class="k">Best trade:</span> ${gradeBadge(r.best.s.grade[m()], 'sm')} ${fmtDate(r.best.t.ts)} with ${esc(r.best.t.sides.filter(x => x !== r.best.s).map(x => x.mgr.name).join(', '))}</div>` : ''}
          ${r.worst ? `<div><span class="k">Worst trade:</span> ${gradeBadge(r.worst.s.grade[m()], 'sm')} ${fmtDate(r.worst.t.ts)} with ${esc(r.worst.t.sides.filter(x => x !== r.worst.s).map(x => x.mgr.name).join(', '))}</div>` : ''}
        </div>
      </a>`).join('')}</div>
    <p class="muted small">Net value = dynasty value received minus sent (today's values). Net points = points scored by what they got for their team, minus points scored by what they gave up for the other team.</p>`;
}

function viewManager(id) {
  const r = managerStats().find(x => x.mgr.id === id);
  if (!r) { app.innerHTML = '<div class="empty">Manager not found.</div>'; return; }
  const sentPicks = r.trades.flatMap(({ t, s }) => s.givesA.filter(a => a.kind === 'pick').map(a => ({ t, a })));
  const gotPicks = r.trades.flatMap(({ t, s }) => s.getsA.filter(a => a.kind === 'pick').map(a => ({ t, a })));
  const pickLi = ({ t, a }) => `<div class="asset"><div class="pick-tile">R${a.round}</div><div class="info"><div class="name">${esc(a.label)} <span class="muted small">via ${esc(a.origMgr.name)}</span></div>
    <div class="meta">${a.resolved ? `→ <span class="slot">${a.slot}</span> #${a.pickNo} ${esc(a.player.n)} ${esc(a.player.pos)} · ${fmt(a.value)} value` : a.future ? `${futureTxt(a)} · ${fmt(a.value)} value` : '—'}</div></div><a class="small" href="#/trade/${t.id}">trade ›</a></div>`;
  app.innerHTML = `
    <a class="back" href="#/managers">‹ All report cards</a>
    <div class="rc-top">${avatar(r.mgr, 'lg')}<div class="who"><h1>${esc(r.mgr.name)}</h1><div class="muted">${esc(r.mgr.team)} · ${r.trades.length} trades · ${r.w}-${r.l}-${r.e}</div></div>${gradeBadge(r.letter, 'xl')}</div>
    <div class="sides" style="gap:12px;margin:14px 0">
      <div class="panel"><h2 style="margin-top:0">Picks acquired (${gotPicks.length})</h2>${gotPicks.map(pickLi).join('') || '<div class="muted">None</div>'}</div>
      <div class="panel"><h2 style="margin-top:0">Picks traded away (${sentPicks.length})</h2>${sentPicks.map(pickLi).join('') || '<div class="muted">None</div>'}</div>
    </div>
    <h2>Every trade</h2>
    ${r.trades.map(({ t }) => tradeCard(t)).join('')}`;
}

// ---------- Anniversaries ----------
const ANNIV_YEARS = [2, 3, 4, 5];
function anniversaries(windowBefore, windowAfter) {
  const now = new Date(); now.setHours(0, 0, 0, 0);
  const out = [];
  for (const t of TRADES) {
    const d = new Date(t.ts);
    for (const y of ANNIV_YEARS) {
      const ann = new Date(d.getFullYear() + y, d.getMonth(), d.getDate());
      const diff = Math.round((ann - now) / 864e5); // + = upcoming
      if (diff >= -windowBefore && diff <= windowAfter) out.push({ t, years: y, diff, ann });
    }
  }
  return out.sort((a, b) => a.diff - b.diff);
}
const annLabel = x => x.diff === 0 ? `🎂 ${x.years} years ago today` : x.diff < 0 ? `🎂 ${x.years} years · ${-x.diff}d ago` : `🎂 ${x.years} years in ${x.diff}d`;

function hindsight(t) {
  const v = verdict(t);
  const lines = t.sides.map(s => `${avatar(s.mgr, 'sm')}<b>${esc(s.mgr.name)}</b>
    <span class="small muted">Prod</span> ${t.prodAvailable ? gradeBadge(s.grade.production, 'sm') : '<span class="muted small">n/a</span>'}
    <span class="small muted">Value</span> ${gradeBadge(s.grade.value, 'sm')}
    <span class="small muted">Blended</span> ${gradeBadge(s.grade.blended, 'sm')}`);
  return `<div class="hindsight"><b>Hindsight verdict:</b> ${esc(v.txt)}${lines.map(l => `<div class="row">${l}</div>`).join('')}</div>`;
}

function viewAnniversaries() {
  const list = anniversaries(30, 60);
  app.innerHTML = `
    <h1>Trade Anniversaries</h1>
    <p class="lede">Trades turning 2, 3, 4 or 5 years old in the last 30 or next 60 days, re-graded with hindsight. Anniversaries this week pop up when you open the site.</p>
    ${list.length ? list.map(x => tradeCard(x.t, `<span class="anniv-badge">${annLabel(x)}</span>`) + hindsight(x.t)).join('') : '<div class="empty">No anniversaries in this window. Check back soon.</div>'}`;
}

function maybeShowAnniversaryPopup() {
  const list = anniversaries(3, 3);
  if (!list.length) return;
  const key = 'anniv-seen-' + new Date().toISOString().slice(0, 10);
  if (store.get(key, false) || location.hash.startsWith('#/anniversaries')) return;
  store.set(key, true);
  $('#modal-body').innerHTML = `
    <div class="cake">🎂</div>
    <h1>Happy Trade-iversary!</h1>
    <p class="lede">${list.length === 1 ? 'A trade' : `${list.length} trades`} hit a milestone this week. Let's see how they aged.</p>
    ${list.map(x => tradeCard(x.t, `<span class="anniv-badge">${annLabel(x)}</span>`) + hindsight(x.t)).join('')}
    <div class="more"><a class="btn primary" href="#/anniversaries" id="anniv-all">See all anniversaries</a></div>`;
  $('#modal').hidden = false;
  $('#anniv-all').addEventListener('click', closeModal);
  $('#modal-body').addEventListener('click', e => { if (e.target.closest('a[href^="#/trade/"]')) closeModal(); });
}
function closeModal() { $('#modal').hidden = true; }

// ---------- How it works ----------
function viewHow() {
  app.innerHTML = `<div class="prose">
    <h1>How grading works</h1>
    <p>Every side of every trade is graded on what it <b>received</b>. Traded picks are followed to the actual draft slot and the player selected; that player then counts as the asset.</p>
    <h2>⚡ Production</h2>
    <p>Points per game the assets scored <i>for the team that received them</i>, only while on that roster. We subtract a replacement level (${Object.entries(REPLACEMENT).map(([k, v]) => `${k} ${v}`).join(', ')} PPG), so a waiver-wire body counts for nothing. Assets with fewer than ${MIN_GAMES} games are discounted proportionally. A pick that gets flipped before the draft produces nothing for the team that flipped it (its trade tree shows what it turned into).</p>
    <h2>💎 Dynasty Value</h2>
    <p>What the assets are worth <i>today</i> in FantasyCalc's dynasty market for this league's format (${DATA.league.scoring.superflex ? 'superflex' : '1QB'}, ${DATA.league.teams} teams, ${DATA.league.scoring.ppr} PPR). Already-used picks are worth whatever the drafted player is worth today, not the slot.
    Future picks are valued by <b>overall pick number</b>: FantasyCalc prices picks for a 12-team league, so in this ${DATA.league.teams}-team league a 2.08 (#${DATA.league.teams + 8} overall) is valued like a 12-team ${Math.ceil((DATA.league.teams + 8) / 12)}.${String(((DATA.league.teams + 8 - 1) % 12) + 1).padStart(2, '0')}, and a 4th rounder like a 12-team 3rd.
    When the slot is unknown, the pick is worth the average of every slot it could land in. Next year's picks get a projected slot from current standings, trusted more as the season goes on (currently ${Math.round(G.standingsConfidence * 100)}%). Values are summed with a slight star premium (value<sup>1.4</sup>) so one stud beats a pile of depth.</p>
    <h2>⚖️ Blended</h2>
    <p>A weighted mix of the two shares. Use the slider (currently ${state.weight}% production) to set the weight. Production phases in over the first season after a trade: a trade from 5 weeks ago uses 5/17ths of the slider's production weight, so a pick-for-player deal isn't judged on a handful of games before the pick has even been used. Trades under 3 weeks old are judged on value alone.</p>
    <h2>Letter grades</h2>
    <p>Each side's share of the trade becomes a letter: 50% is a B-, 58%+ is a B+ (a win), 70%+ an A (a fleece), 80%+ an A+ (robbery). Three-team trades are scaled so a fair one-third share also grades B-.</p>
    <h2>Trade trees</h2>
    <p>Open any trade to see what each team did with what they got: kept it, drafted with it, released it, or flipped it into something else, all the way down. "Branch value" is the current value still on that roster from the branch, splitting packaged deals by value.</p>
  </div>`;
}
