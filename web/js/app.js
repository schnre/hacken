import { Hacken, DEFAULTS, BOT_NAMES, SUITS, cardName, sameCard, score } from './engine.js';
import * as net from './net.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const fmt = (x) => (Number.isInteger(x) ? String(x) : x.toFixed(2).replace(/\.?0+$/, ''));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const KEY = 'hacken.v1';

// ───────── Speicher ─────────
function load() { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; } }
function save(data) { try { localStorage.setItem(KEY, JSON.stringify(data)); } catch { /* privater Modus */ } }
const stored = load();
const settings = { ...DEFAULTS, ...(stored.settings || {}) };
const saveSettings = (snap) => save({ settings, snap: snap ?? load().snap });

// ───────── Zustand der Oberfläche ─────────
let mode = 'menu';          // menu | solo | host | client
let game = null;            // Spiel (Einzelspiel und Gastgeber)
let view = null;            // was gerade gezeigt wird (aus game.viewFor() oder vom Gastgeber)
let ask = null;             // offene Frage an diese Person: { id, kind, data }
let reply = null;           // Funktion, die die Antwort abschickt
let sel = [];               // ausgewählte Karten (Tauschen / Weglegen)
let askSeq = 0;
let online = null;          // { peer, code, conn?, seats?, asks? }
let shownSummary = 0;

// ───────── Brücke zum Spiel (Einzelspiel und Gastgeber) ─────────
const ui = {
  update: () => refresh(),
  wait,
  ask(kind, data, seat) {
    if (seat === 0) {
      return new Promise((resolve) => {
        ask = { id: ++askSeq, kind, data }; sel = [];
        reply = (v) => { ask = null; reply = null; resolve(v); refresh(); };
        refresh();
      });
    }
    return hostAsk(seat, kind, data);
  },
};

function refresh() {
  if (game) view = game.viewFor(0);
  render();
  if (mode === 'host') scheduleBroadcast();
}

// ───────── Bilder ─────────
const cardSrc = (c) => `cards/${settings.deck}/${c.s}${c.r}.webp`;
const cardImg = (c, cls = '') => `<img class="card ${cls}" src="${cardSrc(c)}" alt="${cardName(c)}" draggable="false">`;
const back = (cls = '') => `<span class="card back ${cls}" aria-hidden="true"></span>`;
const symImg = (s) => `<img class="sym" src="cards/${settings.deck}/sym${s}.webp" alt="">`;
function preload() { for (let s = 0; s < 4; s++) for (let r = 0; r < 9; r++) { const im = new Image(); im.src = cardSrc({ s, r }); } }

const ROLE_CLASS = { 'Käufer': 'buyer', 'Mitgeher': 'joiner', 'Passe': 'passed', 'Letzter': 'last' };
const PHASES = [['knock', 'Klopfen'], ['buy', 'Kaufen'], ['join', 'Mitgehen'], ['exchange', 'Tauschen'], ['play', 'Stiche'], ['end', 'Abrechnung']];

const roleBadge = (p) => (p.role ? `<span class="badge ${ROLE_CLASS[p.role] || ''}">${p.role}</span>` : '<span class="badge ghost">–</span>');
function trickDots(p) {
  if (p.role !== 'Käufer' && p.role !== 'Mitgeher') return '';
  const need = p.role === 'Käufer' ? 2 : 1;
  return `<span class="dots" title="${p.won} Stiche, Soll ${need}">${[0, 1, 2, 3].map((k) => `<i class="${k < p.won ? 'on' : ''} ${k < need ? 'need' : ''}"></i>`).join('')}</span>`;
}

function promptText(a, v) {
  switch (a.kind) {
    case 'knock': return 'Klopfen (Trumpfkarte nehmen und kaufen) oder Karten ansehen?';
    case 'buy': return 'Kaufen oder passen?';
    case 'join': return `${esc(a.data.buyer)} kauft. Gehst du mit?${a.data.canLast ? ' Mit «Letzter» gehst du nur mit, wenn nach dir niemand mehr mitgeht.' : ''}`;
    case 'forced': return 'Niemand ist mitgegangen – du musst mitgehen.';
    case 'exchange': return a.data.max
      ? `Wähle bis zu ${a.data.max} Karten zum Tauschen.${a.data.stall ? ' Tauschst du alle 4 (Stall), bekommst du 5 und legst eine weg.' : ''}`
      : 'Der Stapel ist leer – kein Tausch möglich.';
    case 'discard': return `Du hast ${v.hand.length} Karten – leg eine weg.`;
    case 'play': return a.data.lead ? 'Du spielst aus.' : 'Du bist dran – grün markierte Karten sind erlaubt.';
    default: return v.msg;
  }
}

// ───────── Spieltisch zeichnen ─────────
let lastOpen = null, lastTrickKey = '', lastTrickLen = 0;
function render() {
  if (!view) return;
  const v = view, me = v.players[v.seat];

  const pi = PHASES.findIndex(([k]) => k === v.phase);
  $('steps').innerHTML = PHASES.map(([k, l], i) => `<li class="${i === pi ? 'now' : i < pi ? 'done' : ''}">${l}</li>`).join('');
  $('code-chip').hidden = !online;
  if (online) $('code-chip').innerHTML = `Code <b>${online.code}</b>`;

  // Gegner in Sitzreihenfolge ab mir
  const others = Array.from({ length: v.n - 1 }, (_, k) => (v.seat + 1 + k) % v.n);
  $('opponents').style.setProperty('--n', others.length);
  $('opponents').innerHTML = others.map((i) => {
    const p = v.players[i];
    const tag = p.offline ? '<span class="tag off">offline · Computer</span>' : (p.bot && mode !== 'solo' ? '<span class="tag">Computer</span>' : '');
    return `<article class="seat ${v.turn === i ? 'turn' : ''} ${p.role === 'Passe' ? 'out' : ''}">
      <header><span class="avatar" data-i="${(i % 5) + 1}">${esc(p.name[0])}</span>
        <span class="who"><span class="nm"><b>${esc(p.name)}</b>${v.dealer === i ? '<span class="dealer" title="Geber">G</span>' : ''}</span><small>${fmt(p.chips)} Pkt.</small></span></header>
      <div class="seat-row">${roleBadge(p)}${trickDots(p)}${tag}</div>
      <div class="mini-hand">${Array.from({ length: p.handCount }, () => back('xs')).join('')}</div>
      <div class="played" aria-label="Gespielte Karten">${p.played.map((c) => cardImg(c, 'xs')).join('')}</div>
    </article>`;
  }).join('');

  // Mitte
  const lead = v.trick[0]?.c.s;
  const best = v.trick.length ? v.trick.reduce((a, t) => (score(t.c, lead, v.trump) > score(a.c, lead, v.trump) ? t : a)) : null;
  const openKey = v.open ? `${v.open.s}${v.open.r}` : null;
  const animOpen = openKey !== lastOpen; lastOpen = openKey;
  const trickKey = `${v.roundNo}:${v.players.reduce((a, p) => a + p.played.length, 0) - v.trick.length}`;
  const animFrom = trickKey === lastTrickKey ? lastTrickLen : 0;
  lastTrickKey = trickKey; lastTrickLen = v.trick.length;

  const trumpBox = v.trump == null ? '' : `<div class="trump">${symImg(v.trump)}<div><small>Trumpf</small><b>${SUITS[v.trump]}</b></div></div>`;
  const openCard = v.open ? `<figure class="open ${animOpen ? 'anim' : ''}" title="${cardName(v.open)}">${cardImg(v.open, 'side')}<figcaption>${['exchange', 'play', 'end'].includes(v.phase) ? 'Trumpfkarte' : 'Aufgedeckt'}</figcaption></figure>` : '';
  const trick = v.trick.map((t, k) => `<figure class="played-card ${t === best ? 'best' : ''} ${k >= animFrom ? 'anim' : ''}">${cardImg(t.c, 'trk')}<figcaption>${esc(v.players[t.p].name)}</figcaption></figure>`).join('');
  $('center').innerHTML = `
    <div class="info">
      <div class="info-left">${trumpBox}${openCard}${v.obli ? '<span class="obli" title="Erste Runde oder Pot und Nebenpot leer: alle spielen mit">Obli-Runde</span>' : ''}</div>
      <div class="pots">
        <div class="pot"><small>Pot</small><b>${fmt(v.pot)}</b><span class="cap">max ${v.potMax}</span></div>
        <div class="pot side"><small>Nebenpot</small><b>${fmt(v.side)}</b></div>
        <div class="pot stack"><small>Stapel</small><b>${v.deckCount}</b></div>
      </div>
    </div>
    <div class="felt-mid"><div class="trick">${trick}</div></div>`;

  // Ich
  $('me').innerHTML = `<span class="avatar me-av">${esc(me.name[0])}</span>
    <span class="who"><span class="nm"><b>${esc(me.name)}</b>${v.dealer === v.seat ? '<span class="dealer" title="Geber">G</span>' : ''}</span><small>${fmt(me.chips)} Pkt.</small></span>
    ${roleBadge(me)}${trickDots(me)}`;
  $('me').classList.toggle('turn', v.turn === v.seat);
  $('msg').textContent = ask ? '' : v.msg;
  if (ask) $('msg').innerHTML = promptText(ask, v);

  // Hand
  const legal = ask?.kind === 'play' ? ask.data.legal : null;
  const isLegal = (c) => legal.some((x) => sameCard(x, c));
  const picking = ask && (ask.kind === 'exchange' || ask.kind === 'discard');
  const items = v.hand.map((c, i) => ({ c, i })).sort((a, b) => (a.c.s === v.trump) - (b.c.s === v.trump) || a.c.s - b.c.s || a.c.r - b.c.r).reverse();
  $('hand').innerHTML = !v.looked
    ? v.hand.map(() => back('lg')).join('')
    : items.map(({ c, i }) => {
      const cls = [];
      if (picking) { cls.push('pick'); if (sel.includes(i)) cls.push('sel', ask.kind === 'discard' ? 'drop' : 'swap'); }
      if (legal) cls.push(isLegal(c) ? 'ok' : 'no');
      if (c.s === v.trump) cls.push('is-trump');
      return `<button class="hand-card ${cls.join(' ')}" data-card="${i}" ${legal && !isLegal(c) ? 'disabled' : ''} aria-label="${cardName(c)}">${cardImg(c)}</button>`;
    }).join('');

  // Knöpfe
  let a = '';
  if (ask) {
    switch (ask.kind) {
      case 'knock': a = btn('knock', 'Klopfen', 'primary', 'Trumpfkarte nehmen und kaufen') + btn('look', 'Karten ansehen'); break;
      case 'buy': a = btn('buy', 'Kaufen', 'primary') + btn('pass', 'Passen'); break;
      case 'join': a = btn('join', 'Mitgehen', 'primary') + (ask.data.canLast ? btn('last', 'Letzter', '', 'Mitgehen nur, wenn nach dir niemand mehr mitgeht') : '') + btn('pass', 'Passen'); break;
      case 'forced': a = btn('ok', 'Mitgehen (Pflicht)', 'primary'); break;
      case 'exchange': {
        const stall = ask.data.stall && sel.length === 4;
        a = btn('swap', stall ? 'Stall nehmen (5 neue Karten)' : sel.length ? `${sel.length} ${sel.length === 1 ? 'Karte' : 'Karten'} tauschen` : 'Nichts tauschen', 'primary');
        break;
      }
      case 'discard': a = btn('discard', 'Karte weglegen', 'primary', '', sel.length !== 1); break;
      default: a = '';
    }
  }
  $('actions').innerHTML = a;

  // Abrechnung bei Mitspielern automatisch zeigen
  if (mode === 'client' && v.phase === 'end' && v.summary && v.summary.round !== shownSummary) {
    shownSummary = v.summary.round;
    openSummary(v.summary);
  }
  if (mode === 'client' && v.phase === 'deal' && sheet.open && sheet.dataset.kind === 'summary') sheet.close();
}
function btn(action, label, kind = '', title = '', disabled = false) {
  return `<button class="btn ${kind}" data-answer="${action}" ${title ? `title="${title}"` : ''} ${disabled ? 'disabled' : ''}>${label}</button>`;
}

// ───────── Eingaben am Tisch ─────────
document.addEventListener('click', (e) => {
  const t = e.target.closest('[data-answer],[data-card],[data-action]');
  if (!t) return;
  if (t.dataset.action) return openSheet(t.dataset.action);
  if (!ask || !reply) return;
  if (t.dataset.card != null) {
    const i = Number(t.dataset.card), c = view.hand[i];
    if (ask.kind === 'play') { if (ask.data.legal.some((x) => sameCard(x, c))) reply({ s: c.s, r: c.r }); return; }
    if (ask.kind === 'exchange') {
      const k = sel.indexOf(i);
      if (k >= 0) sel.splice(k, 1); else if (sel.length < ask.data.max) sel.push(i);
      return render();
    }
    if (ask.kind === 'discard') { sel = sel[0] === i ? [] : [i]; return render(); }
    return;
  }
  if (ask.kind === 'exchange') return reply(sel.slice());
  if (ask.kind === 'discard') return reply(sel[0]);
  reply(t.dataset.answer);
});

// ───────── Dialoge ─────────
const sheet = $('sheet');
sheet.addEventListener('click', (e) => { if (e.target === sheet || e.target.closest('[data-close]')) sheet.close(); });
function sheetHead(title) {
  return `<header class="sheet-head"><h2>${title}</h2><button class="icon-btn" data-close aria-label="Schliessen">
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg></button></header>`;
}
function showSheet(kind, html) { sheet.dataset.kind = kind; sheet.innerHTML = html; if (!sheet.open) sheet.showModal(); }

function openSummary(s) {
  const weightNote = 'Der Pot geht an alle, die ihr Soll erfüllt haben: der Käufer bekommt doppelt so viel wie ein Mitgeher.';
  showSheet('summary', sheetHead(`Abrechnung Runde ${s.round}`) + `<div class="sheet-body">
    <p class="muted">Pot dieser Runde: <b>${fmt(s.pot0)}</b>${s.obli ? ' · Obli-Runde' : ''}</p>
    <table class="result"><thead><tr><th>Spieler</th><th>Rolle</th><th>Stiche</th><th>Ergebnis</th></tr></thead><tbody>
    ${s.rows.map((r) => `<tr class="${r.pay ? 'lost' : 'won'}"><td>${esc(r.name)}</td><td>${r.role}</td><td>${r.won}</td><td>${r.pay ? `−${fmt(r.pay)}` : `+${fmt(r.gain)}`}</td></tr>`).join('')}
    </tbody></table>
    <p class="muted small">${weightNote} ${s.rows.some((r) => r.pay) ? 'Wer sein Soll nicht erfüllt, bekommt nichts und zahlt in den Pot (Käufer doppelt, Mitgeher einfach). ' : ''}${s.refill ? `Aus dem Nebenpot wurden ${fmt(s.refill)} nachgefüllt. ` : ''}Neuer Pot: <b>${fmt(s.pot)}</b> · Nebenpot: <b>${fmt(s.side)}</b>${s.pot === 0 && s.side === 0 ? ' – die nächste Runde ist eine Obli-Runde.' : ''}</p>
    <div class="form-actions"><button class="btn primary" data-close>${mode === 'client' ? 'Schliessen' : 'Weiter'}</button></div>
  </div>`);
  return new Promise((r) => sheet.addEventListener('close', r, { once: true }));
}

async function openSheet(kind) {
  if (kind === 'rules') {
    showSheet('rules', sheetHead('Spielregeln') + '<div class="sheet-body rules-body"><p class="muted">Lädt …</p></div>');
    try {
      const doc = new DOMParser().parseFromString(await (await fetch('regeln.html')).text(), 'text/html');
      sheet.querySelector('.rules-body').innerHTML = doc.querySelector('.rules').innerHTML;
    } catch {
      sheet.querySelector('.rules-body').innerHTML = '<p>Die Regeln konnten nicht geladen werden. <a href="regeln.html">Regeln öffnen</a></p>';
    }
    return;
  }
  if (kind === 'log') {
    const log = view?.log || [];
    return showSheet('log', sheetHead('Verlauf') + `<div class="sheet-body"><ol class="log">${log.map((l) => `<li><span>R${l.round}</span>${esc(l.msg)}</li>`).join('') || '<li>Noch nichts passiert.</li>'}</ol></div>`);
  }
  if (kind === 'settings') {
    const s = settings;
    const opt = (val, cur, l) => `<option value="${val}" ${String(val) === String(cur) ? 'selected' : ''}>${l}</option>`;
    const soloPart = mode === 'solo' ? `
      <fieldset><legend>Für ein neues Spiel</legend>
        <label>Mitspieler am Tisch<select name="bots">${[2, 3, 4, 5].map((b) => opt(b, s.bots, `${b + 1} Spieler (du + ${b} Computer)`)).join('')}</select></label>
        ${numberFields(s)}
      </fieldset>` : '';
    showSheet('settings', sheetHead('Einstellungen') + `<form class="sheet-body form">
      ${mode === 'solo' ? `<label>Dein Name<input name="name" maxlength="14" value="${esc(s.name)}"></label>` : ''}
      ${mode !== 'client' ? `<label>Tempo der Computer-Gegner<select name="speed">${opt('slow', s.speed, 'Gemütlich')}${opt('normal', s.speed, 'Normal')}${opt('fast', s.speed, 'Schnell')}</select></label>` : ''}
      <label>Kartenset<select name="deck">${opt('agm', s.deck, 'AGMüller (Schaffhauser)')}${opt('jegen', s.deck, 'Elsi Jegen (Frauezogg)')}</select></label>
      ${soloPart}
      <div class="form-actions">
        ${mode === 'solo' ? '' : '<button type="button" class="btn danger" data-save="leave">Spiel verlassen</button>'}
        <button type="button" class="btn ${mode === 'solo' ? '' : 'primary'}" data-save="keep">Speichern</button>
        ${mode === 'solo' ? '<button type="button" class="btn primary" data-save="new">Neues Spiel starten</button>' : ''}
      </div>
      ${mode === 'solo' ? '<p class="muted small">«Speichern» übernimmt Name, Tempo und Kartenset sofort. Die übrigen Werte gelten ab einem neuen Spiel.</p>' : ''}
    </form>`);
    sheet.querySelectorAll('[data-save]').forEach((b) => b.addEventListener('click', () => {
      const f = new FormData(sheet.querySelector('form'));
      if (b.dataset.save === 'leave') { location.href = location.pathname; return; }
      if (f.has('name')) { settings.name = cleanName(f.get('name')); if (game && mode === 'solo') game.players[0].name = settings.name; }
      if (f.has('speed')) { settings.speed = f.get('speed'); if (game) game.cfg.speed = settings.speed; }
      settings.deck = f.get('deck'); preload();
      if (b.dataset.save === 'new') {
        readNumbers(f);
        settings.bots = Math.min(5, Math.max(2, Number(f.get('bots')) || 3));
        save({ settings });
        location.href = location.pathname + '?solo=1';
        return;
      }
      saveSettings(mode === 'solo' && game ? game.snapshot() : undefined);
      sheet.close(); refresh();
    }));
  }
}
function numberFields(s) {
  return `<label>Startguthaben<input name="startChips" type="number" min="10" max="10000" value="${s.startChips}"></label>
    <label>Grundeinsatz (nur in Obli-Runden)<input name="ante" type="number" min="1" max="100" value="${s.ante}"></label>
    <label>Pot-Maximum<input name="potMax" type="number" min="4" max="1000" value="${s.potMax}"></label>`;
}
function readNumbers(f) {
  const num = (k, lo, hi) => Math.min(hi, Math.max(lo, Math.round(Number(f.get(k))) || DEFAULTS[k]));
  Object.assign(settings, { startChips: num('startChips', 10, 10000), ante: num('ante', 1, 100), potMax: num('potMax', 4, 1000) });
}
const cleanName = (x) => (String(x || '').trim().replace(/\s+/g, ' ').slice(0, 14) || 'Gast');

// ───────── Bildschirme ─────────
function showTable() { $('menu').hidden = true; $('table').hidden = false; document.body.classList.remove('in-menu'); }
function showMenu(html) { $('table').hidden = true; $('menu').hidden = false; $('menu').innerHTML = html; document.body.classList.add('in-menu'); }

function menuHome(error = '') {
  mode = 'menu';
  const code = new URLSearchParams(location.search).get('code') || '';
  const snap = load().snap;
  showMenu(`<div class="panel">
    <h1 class="title">Hacken</h1>
    <p class="lede">Das Schweizer Kartenspiel mit Jasskarten – allein gegen den Computer oder online mit Freunden.</p>
    ${error ? `<p class="error" role="alert">${esc(error)}</p>` : ''}
    <label class="field">Dein Name<input id="name" maxlength="14" value="${esc(settings.name === 'Du' ? '' : settings.name)}" placeholder="z. B. Remo" autocomplete="nickname"></label>
    <div class="choices">
      <button class="choice" data-go="solo"><b>Gegen den Computer</b><span>${snap?.roundNo ? `Weiterspielen · Runde ${snap.roundNo + 1}` : 'Mit 2 bis 5 Computer-Gegnern'}</span></button>
      <button class="choice" data-go="host"><b>Online-Spiel erstellen</b><span>Du bekommst einen 4-stelligen Code zum Teilen</span></button>
    </div>
    <form class="join" id="join-form">
      <label class="field">Mit Code beitreten<input id="code" inputmode="numeric" pattern="[0-9]{4}" maxlength="4" value="${esc(code)}" placeholder="1234" autocomplete="off"></label>
      <button class="btn primary" type="submit">Beitreten</button>
    </form>
    <p class="menu-foot"><a href="regeln.html">Spielregeln lesen</a></p>
  </div>`);
  const nameOf = () => { const raw = $('name').value.trim(); if (raw) settings.name = cleanName(raw); saveSettings(); return settings.name; };
  $('menu').querySelectorAll('[data-go]').forEach((b) => b.addEventListener('click', () => {
    if (b.dataset.go === 'solo') { nameOf(); return startSolo(); }
    if (!$('name').value.trim()) { $('name').focus(); $('name').setCustomValidity('Bitte gib einen Namen ein.'); $('name').reportValidity(); return; }
    nameOf(); startHost();
  }));
  $('name').addEventListener('input', () => $('name').setCustomValidity(''));
  $('join-form').addEventListener('submit', (e) => {
    e.preventDefault();
    if (!$('name').value.trim()) { $('name').setCustomValidity('Bitte gib einen Namen ein.'); $('name').reportValidity(); return; }
    const c = $('code').value.trim();
    if (!/^\d{4}$/.test(c)) { $('code').setCustomValidity('Der Code hat 4 Ziffern.'); $('code').reportValidity(); return; }
    nameOf(); startClient(c);
  });
  $('code').addEventListener('input', () => $('code').setCustomValidity(''));
  if (code) $('name').focus();
}

// ───────── Einzelspiel ─────────
async function startSolo() {
  mode = 'solo';
  const snap = load().snap;
  game = new Hacken(settings, ui, snap);
  showTable(); preload(); refresh();
  for (;;) {
    const r = await game.playRound();
    saveSettings(game.snapshot());
    if (r.redeal) continue;
    refresh();
    await wait(400);
    await openSummary(game.summary);
  }
}

// ───────── Online: Gastgeber ─────────
async function startHost() {
  mode = 'host';
  showMenu('<div class="panel"><h1 class="title">Online-Spiel</h1><p class="lede">Spiel wird erstellt …</p></div>');
  try {
    const { peer, code } = await net.host(onConnection);
    online = { peer, code, seats: [{ name: settings.name, kind: 'host' }], asks: {}, started: false };
    window.addEventListener('beforeunload', (e) => { if (online?.started) { e.preventDefault(); e.returnValue = ''; } });
    renderLobby();
  } catch (e) {
    menuHome(e.message);
  }
}

function lobbyInfo() {
  return { t: 'lobby', code: online.code, seats: online.seats.map((s) => ({ name: s.name, kind: s.kind })), cfg: { startChips: settings.startChips, ante: settings.ante, potMax: settings.potMax } };
}
function sendTo(seat, msg) { const c = online.seats[seat]?.conn; if (c?.open) try { c.send(msg); } catch { /* Verbindung weg */ } }
function broadcastLobby() { online.seats.forEach((s, i) => { if (s.kind === 'remote') sendTo(i, lobbyInfo()); }); }

function renderLobby() {
  const L = lobbyInfo(), url = `${location.origin}${location.pathname}?code=${online.code}`;
  const count = L.seats.length;
  showMenu(`<div class="panel">
    <p class="eyebrow">Online-Spiel</p>
    <div class="code-big" aria-label="Spielcode">${[...online.code].map((d) => `<span>${d}</span>`).join('')}</div>
    <p class="lede">Gib diesen Code deinen Mitspielerinnen und Mitspielern oder schick ihnen den Link.</p>
    <div class="share"><input readonly value="${esc(url)}" id="share-url"><button class="btn" id="share-btn">${navigator.share ? 'Teilen' : 'Kopieren'}</button></div>
    <h2 class="sub">Am Tisch (${count}/6)</h2>
    <ul class="seats">${L.seats.map((s, i) => `<li><span class="avatar" data-i="${(i % 5) + 1}">${esc(s.name[0])}</span><b>${esc(s.name)}</b><span class="tag">${s.kind === 'host' ? 'Gastgeber' : s.kind === 'bot' ? 'Computer' : 'online'}</span>${s.kind !== 'host' ? `<button class="icon-btn sm" data-kick="${i}" aria-label="Entfernen">✕</button>` : ''}</li>`).join('')}</ul>
    <button class="btn" id="add-bot" ${count >= 6 ? 'disabled' : ''}>+ Computer-Gegner</button>
    <details class="lobby-settings"><summary>Einstellungen</summary><form class="form" id="lobby-form">${numberFields(settings)}</form></details>
    <div class="form-actions">
      <button class="btn" id="cancel">Abbrechen</button>
      <button class="btn primary" id="start" ${count < 3 ? 'disabled' : ''}>Spiel starten</button>
    </div>
    ${count < 3 ? '<p class="muted-on small">Es braucht mindestens 3 Spieler. Fehlende Plätze kannst du mit Computer-Gegnern füllen.</p>' : ''}
  </div>`);
  $('share-btn').addEventListener('click', async () => {
    try { if (navigator.share) await navigator.share({ title: 'Hacken', text: `Spiel mit! Code ${online.code}`, url }); else { await navigator.clipboard.writeText(url); $('share-btn').textContent = 'Kopiert ✓'; } } catch { $('share-url').select(); }
  });
  $('add-bot').addEventListener('click', () => {
    const used = new Set(online.seats.map((s) => s.name));
    const name = BOT_NAMES.find((n) => !used.has(n)) || `Computer ${online.seats.length}`;
    online.seats.push({ name, kind: 'bot' }); renderLobby(); broadcastLobby();
  });
  $('menu').querySelectorAll('[data-kick]').forEach((b) => b.addEventListener('click', () => {
    const i = Number(b.dataset.kick), s = online.seats[i];
    if (s.kind === 'remote') { sendTo(i, { t: 'reject', reason: 'Der Gastgeber hat dich entfernt.' }); setTimeout(() => s.conn?.close(), 300); }
    online.seats.splice(i, 1); renderLobby(); broadcastLobby();
  }));
  $('lobby-form').addEventListener('change', () => { readNumbers(new FormData($('lobby-form'))); saveSettings(); broadcastLobby(); });
  $('cancel').addEventListener('click', () => { online.seats.forEach((s, i) => s.kind === 'remote' && sendTo(i, { t: 'reject', reason: 'Der Gastgeber hat das Spiel abgebrochen.' })); setTimeout(() => { online.peer.destroy(); location.href = location.pathname; }, 300); });
  $('start').addEventListener('click', startOnlineGame);
}

function onConnection(conn) {
  conn.on('data', (msg) => onHostMessage(conn, msg));
  conn.on('close', () => onHostClose(conn));
  conn.on('error', () => onHostClose(conn));
}

function onHostMessage(conn, msg) {
  if (!msg || typeof msg !== 'object') return;
  if (msg.t === 'hello') {
    const name = cleanName(msg.name), token = String(msg.token || '').slice(0, 64);
    if (online.started) {
      const i = online.seats.findIndex((s) => s.kind === 'remote' && s.token && s.token === token);
      if (i < 0) { conn.send({ t: 'reject', reason: 'Dieses Spiel läuft bereits.' }); return; }
      online.seats[i].conn = conn;
      Object.assign(game.players[i], { bot: false, offline: false });
      game.say(`${game.players[i].name} ist wieder da.`);
      return;
    }
    const again = online.seats.findIndex((s) => s.kind === 'remote' && s.token && s.token === token);
    if (again >= 0) { online.seats[again].conn = conn; }
    else {
      if (online.seats.length >= 6) { conn.send({ t: 'reject', reason: 'Der Tisch ist voll (6 Spieler).' }); return; }
      const used = new Set(online.seats.map((s) => s.name));
      let unique = name, k = 2; while (used.has(unique)) unique = `${name.slice(0, 11)} ${k++}`;
      online.seats.push({ name: unique, kind: 'remote', conn, token });
    }
    renderLobby(); broadcastLobby();
    return;
  }
  if (msg.t === 'answer') {
    const i = online.seats.findIndex((s) => s.conn === conn);
    const q = online.asks[i];
    if (q && q.id === msg.id) { delete online.asks[i]; q.resolve(msg.value); }
  }
}

function onHostClose(conn) {
  const i = online.seats.findIndex((s) => s.conn === conn);
  if (i < 0) return;
  const s = online.seats[i];
  s.conn = null;
  if (!online.started) { online.seats.splice(i, 1); renderLobby(); broadcastLobby(); return; }
  Object.assign(game.players[i], { bot: true, offline: true });
  const q = online.asks[i];
  if (q) { delete online.asks[i]; q.resolve(null); } // ungültige Antwort → der Computer entscheidet
  game.say(`${s.name} hat die Verbindung verloren – der Computer spielt weiter.`);
}

function hostAsk(seat, kind, data) {
  return new Promise((resolve) => {
    online.asks[seat] = { id: ++askSeq, kind, data, resolve };
    scheduleBroadcast();
  });
}

let bcastQueued = false;
function scheduleBroadcast() {
  if (bcastQueued || !online?.started) return;
  bcastQueued = true;
  queueMicrotask(() => {
    bcastQueued = false;
    online.seats.forEach((s, i) => {
      if (s.kind !== 'remote' || !s.conn?.open) return;
      const q = online.asks[i];
      sendTo(i, { t: 'state', view: game.viewFor(i), ask: q ? { id: q.id, kind: q.kind, data: q.data } : null });
    });
  });
}

async function startOnlineGame() {
  readNumbers(new FormData($('lobby-form'))); saveSettings();
  online.started = true;
  const seats = online.seats.map((s) => ({ name: s.name, bot: s.kind === 'bot' }));
  game = new Hacken({ ...settings, name: settings.name }, ui, null, seats);
  showTable(); preload(); refresh();
  for (;;) {
    const r = await game.playRound();
    if (r.redeal) continue;
    refresh();
    await wait(400);
    await openSummary(game.summary);
  }
}

// ───────── Online: Mitspieler ─────────
async function startClient(code) {
  mode = 'client';
  showMenu('<div class="panel"><h1 class="title">Beitreten …</h1><p class="lede">Verbinde mit dem Spiel ' + esc(code) + '.</p></div>');
  const tokenKey = `hacken.token.${code}`;
  let token; try { token = localStorage.getItem(tokenKey); } catch { /* egal */ }
  if (!token) { token = net.randomToken(); try { localStorage.setItem(tokenKey, token); } catch { /* egal */ } }
  try {
    const { peer, conn } = await net.join(code);
    online = { peer, conn, code };
    let rejected = false;
    conn.on('data', (msg) => {
      if (!msg || typeof msg !== 'object') return;
      if (msg.t === 'lobby') return renderClientLobby(msg);
      if (msg.t === 'reject') { rejected = true; peer.destroy(); return menuHome(msg.reason); }
      if (msg.t === 'state') {
        if ($('table').hidden) { showTable(); preload(); }
        view = msg.view;
        if (!msg.ask) { ask = null; reply = null; }
        else if (!ask || ask.id !== msg.ask.id) {
          ask = msg.ask; sel = [];
          const id = ask.id;
          reply = (value) => { if (conn.open) conn.send({ t: 'answer', id, value }); ask = null; reply = null; render(); };
        }
        render();
      }
    });
    conn.on('close', () => { if (!rejected) lostConnection(code); });
    conn.send({ t: 'hello', name: settings.name, token });
  } catch (e) {
    menuHome(e.message);
  }
}

function renderClientLobby(L) {
  showMenu(`<div class="panel">
    <p class="eyebrow">Online-Spiel</p>
    <div class="code-big">${[...L.code].map((d) => `<span>${d}</span>`).join('')}</div>
    <h2 class="sub">Am Tisch (${L.seats.length}/6)</h2>
    <ul class="seats">${L.seats.map((s, i) => `<li><span class="avatar" data-i="${(i % 5) + 1}">${esc(s.name[0])}</span><b>${esc(s.name)}</b><span class="tag">${s.kind === 'host' ? 'Gastgeber' : s.kind === 'bot' ? 'Computer' : 'online'}</span></li>`).join('')}</ul>
    <p class="lede">Startguthaben ${L.cfg.startChips} · Grundeinsatz ${L.cfg.ante} · Pot max. ${L.cfg.potMax}</p>
    <p class="waiting"><span class="spinner" aria-hidden="true"></span>Warten, bis der Gastgeber das Spiel startet …</p>
    <div class="form-actions"><button class="btn" id="leave">Verlassen</button></div>
  </div>`);
  $('leave').addEventListener('click', () => { online.peer.destroy(); location.href = location.pathname; });
}

function lostConnection(code) {
  ask = null; reply = null;
  showSheet('lost', sheetHead('Verbindung unterbrochen') + `<div class="sheet-body">
    <p>Die Verbindung zum Gastgeber ist abgebrochen. Vielleicht hat er das Spiel geschlossen oder das Netz ist kurz weg.</p>
    <div class="form-actions"><button class="btn" id="to-menu">Zum Start</button><button class="btn primary" id="rejoin">Erneut verbinden</button></div>
  </div>`);
  $('rejoin').addEventListener('click', () => { sheet.close(); online?.peer?.destroy(); startClient(code); });
  $('to-menu').addEventListener('click', () => { location.href = location.pathname; });
}

// ───────── Start ─────────
const params = new URLSearchParams(location.search);
if (params.get('solo')) startSolo(); else menuHome();

if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
