// Hacken – Spiellogik. Reine Logik ohne DOM: Oberfläche und Netzwerk hängen sich über `ui` ein.
//   ui.update()                 – Zustand hat sich geändert (neu zeichnen / an Mitspieler senden)
//   ui.ask(kind, data, seat)    – Entscheidung eines menschlichen Spielers (Promise)
//   ui.wait(ms)                 – Pause für Computer-Züge und Animationen

export const SUITS = ['Eichel', 'Rose', 'Schilte', 'Schelle'];
export const RANKS = ['6', '7', '8', '9', 'Banner', 'Under', 'Ober', 'König', 'Ass'];
export const cardName = (c) => `${SUITS[c.s]}-${RANKS[c.r]}`;
export const sameCard = (a, b) => a && b && a.s === b.s && a.r === b.r;
export const round2 = (x) => Math.round(x * 100) / 100;
export const score = (c, lead, trump) => (c.s === trump ? 100 + c.r : c.s === lead ? c.r : -1);

export const DEFAULTS = {
  name: 'Du',
  bots: 3,          // Computer-Gegner im Einzelspiel (2–5 → 3–6 Spieler)
  startChips: 100,
  ante: 1,          // Grundeinsatz pro Spieler – nur wenn Pot und Nebenpot leer sind (Obli-Runde)
  potMax: 20,       // Pot-Obergrenze, Rest geht in den Nebenpot
  speed: 'normal',
  deck: 'agm',
};

export const BOT_NAMES = ['Sepp', 'Vreni', 'Ueli', 'Heidi', 'Köbi'];

// Anteil am Pot: der Käufer zählt doppelt, jeder Mitgeher einfach.
export const WEIGHT = { 'Käufer': 2, 'Mitgeher': 1 };

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export class Hacken {
  /**
   * @param settings  Einstellungen (siehe DEFAULTS)
   * @param ui        Brücke zur Oberfläche
   * @param saved     gespeicherter Punktestand (nur Einzelspiel)
   * @param seats     optional: [{ name, bot }] für Online-Spiele; Platz 0 ist immer die Person an diesem Gerät
   */
  constructor(settings, ui, saved, seats) {
    this.cfg = { ...DEFAULTS, ...settings };
    this.ui = ui;
    seats ??= Array.from({ length: this.cfg.bots + 1 }, (_, i) => ({ name: i === 0 ? this.cfg.name : BOT_NAMES[i - 1], bot: i !== 0 }));
    this.players = seats.map((s, i) => ({
      name: s.name, bot: !!s.bot, offline: false,
      chips: saved?.chips?.[i] ?? this.cfg.startChips,
      hand: [], role: '', won: 0, played: [], looked: false, knocked: null,
    }));
    this.n = this.players.length;
    this.dealer = saved?.dealer ?? this.n - 1;
    this.pot = saved?.pot ?? 0;
    this.side = saved?.side ?? 0;
    this.roundNo = saved?.roundNo ?? 0;
    this.log = [];
    this.reset();
  }

  reset() {
    this.deck = []; this.open = null; this.trump = null; this.trick = []; this.lastTrick = null;
    this.buyer = -1; this.active = []; this.phase = 'idle'; this.msg = ''; this.turn = -1; this.summary = null;
    this.reveals = 0; this.obli = false;
    for (const p of this.players) Object.assign(p, { hand: [], role: '', won: 0, played: [], looked: false, knocked: null });
  }

  snapshot() {
    return { chips: this.players.map((p) => p.chips), dealer: this.dealer, pot: this.pot, side: this.side, roundNo: this.roundNo };
  }

  /** Was Platz `seat` sehen darf – fremde Handkarten bleiben verborgen. */
  viewFor(seat) {
    const me = this.players[seat];
    return {
      seat, n: this.n, dealer: this.dealer, turn: this.turn, phase: this.phase, msg: this.msg,
      pot: this.pot, side: this.side, potMax: this.cfg.potMax, deckCount: this.deck.length,
      open: this.open, trump: this.trump, trick: this.trick, roundNo: this.roundNo, obli: this.obli,
      players: this.players.map((p) => ({
        name: p.name, chips: p.chips, role: p.role, won: p.won, played: p.played,
        handCount: p.hand.length, bot: p.bot, offline: p.offline, knocked: this.knockedCard(p),
      })),
      hand: me.hand, looked: me.looked,
      summary: this.summary, log: this.log.slice(0, 80),
    };
  }

  // ───────── Hilfen ─────────
  seatsFrom(start) { return Array.from({ length: this.n }, (_, k) => (start + k) % this.n); }
  say(msg, logIt = true) { this.msg = msg; if (logIt) this.log.unshift({ round: this.roundNo, msg }); this.ui.update(); }
  addPot(x) {
    this.pot = round2(this.pot + x);
    if (this.pot > this.cfg.potMax) { this.side = round2(this.side + this.pot - this.cfg.potMax); this.pot = this.cfg.potMax; }
  }
  delay(f = 1) { const ms = { slow: 1300, normal: 800, fast: 380 }[this.cfg.speed] ?? 800; return this.ui.wait(ms * f); }
  /** Die geklopfte Trumpfkarte bleibt für alle sichtbar, solange sie in der Hand ist. */
  knockedCard(p) { return p.knocked && p.hand.some((c) => sameCard(c, p.knocked)) ? p.knocked : null; }
  knockedIdx(i) { const p = this.players[i]; return p.knocked ? p.hand.findIndex((c) => sameCard(c, p.knocked)) : -1; }
  // Stall: alle 4 Handkarten tauschen – wer geklopft hat, behält dabei die geklopfte Karte.
  canStall(i) {
    const h = this.players[i].hand.length - (this.knockedIdx(i) >= 0 ? 1 : 0);
    return this.active.length < this.n && this.deck.length >= 5 && h === 4;
  }
  isStall(i, idx) { return idx.length === 4 && !idx.includes(this.knockedIdx(i)) && this.canStall(i); }

  legal(i) {
    const h = this.players[i].hand;
    if (!this.trick.length) return h.slice();
    const lead = this.trick[0].c.s;
    const follow = h.filter((c) => c.s === lead);
    if (follow.length) {
      // Wird Trumpf ausgespielt, muss man höher trumpfen, wenn man kann – sonst einen tieferen Trumpf legen.
      if (lead !== this.trump) return follow;
      const top = Math.max(...this.trick.filter((t) => t.c.s === this.trump).map((t) => t.c.r));
      const higher = follow.filter((c) => c.r > top);
      return higher.length ? higher : follow;
    }
    // Farbe nicht vorhanden: Trumpf legen; liegt schon Trumpf, muss er höher sein, wenn möglich –
    // sonst darf man untertrumpfen. Nur wer gar keinen Trumpf hat, darf frei legen.
    const trumps = h.filter((c) => c.s === this.trump);
    if (!trumps.length) return h.slice();
    const high = Math.max(-1, ...this.trick.filter((t) => t.c.s === this.trump).map((t) => t.c.r));
    const over = trumps.filter((c) => c.r > high);
    return over.length ? over : trumps;
  }
  trickWinner() {
    const lead = this.trick[0].c.s;
    return this.trick.reduce((a, t) => (score(t.c, lead, this.trump) > score(a.c, lead, this.trump) ? t : a)).p;
  }

  // ───────── Entscheidungen ─────────
  /** Fragt den Menschen auf Platz i – oder entscheidet für den Computer. */
  async decide(i, kind, data = {}) {
    const p = this.players[i];
    this.turn = i;
    if (p.bot) {
      this.say(`${p.name} überlegt …`, false);
      await this.delay(kind === 'play' ? 1 : 0.8);
      return this.botAnswer(i, kind, data);
    }
    this.say(`${p.name} ist dran …`, false);
    const v = await this.ui.ask(kind, data, i);
    const ok = this.sanitize(i, kind, data, v);
    return ok ?? this.botAnswer(i, kind, data);
  }

  /** Prüft Antworten (auch die von Mitspielern übers Netz). null = ungültig. */
  sanitize(i, kind, data, v) {
    const hand = this.players[i].hand;
    switch (kind) {
      case 'knock': return v === 'knock' || v === 'look' ? v : null;
      case 'buy': return v === 'buy' || v === 'pass' ? v : null;
      case 'join': return v === 'join' || v === 'pass' || (v === 'last' && data.canLast) ? v : null;
      case 'forced': return 'ok';
      case 'exchange': {
        if (!Array.isArray(v)) return null;
        const idx = [...new Set(v.map(Number))].filter((k) => Number.isInteger(k) && k >= 0 && k < hand.length);
        return idx.length <= data.max ? idx : null;
      }
      case 'discard': { const k = Number(v); return Number.isInteger(k) && k >= 0 && k < hand.length ? k : null; }
      case 'play': {
        const c = this.legal(i).find((x) => sameCard(x, v));
        return c ?? null;
      }
      default: return null;
    }
  }

  // ───────── Computer-Gegner ─────────
  strength(hand) {
    return hand.reduce((a, c) => a + (c.s === this.trump ? 2 + c.r / 4 : c.r === 8 ? 1.2 : c.r === 7 ? 0.6 : 0), 0);
  }
  botKeep(c) { return c.s === this.trump || c.r >= 7; }
  botWeakest(hand) {
    const val = (c) => score(c, c.s, this.trump) - (this.botKeep(c) ? 0 : 50);
    let m = 0;
    hand.forEach((c, k) => { if (val(c) < val(hand[m])) m = k; });
    return m;
  }
  botAnswer(i, kind, data) {
    const p = this.players[i], s = this.strength(p.hand) + Math.random() - 0.5;
    const joiners = this.players.filter((q) => q.role === 'Mitgeher').length;
    switch (kind) {
      case 'knock': return this.open && this.open.r >= 7 && Math.random() < 0.7 ? 'knock' : 'look';
      case 'buy': return s >= 4.3 + 0.3 * (this.n - 4) ? 'buy' : 'pass';
      case 'join': {
        const need = 3.2 + 0.9 * joiners;
        if (s >= need) return 'join';
        if (data.canLast && s >= need - 1.2) return 'last';
        return 'pass';
      }
      case 'forced': return 'ok';
      case 'exchange': {
        const idx = []; p.hand.forEach((c, k) => { if (!this.botKeep(c)) idx.push(k); });
        return idx.slice(0, data.max);
      }
      case 'discard': return this.botWeakest(p.hand);
      case 'play': return this.botPlay(i);
      default: return null;
    }
  }
  botPlay(i) {
    const L = this.legal(i), T = this.trump;
    if (!this.trick.length) {
      const trumps = L.filter((c) => c.s === T).sort((a, b) => b.r - a.r);
      if (trumps.length && trumps[0].r >= 7) return trumps[0];
      const aces = L.filter((c) => c.r === 8);
      if (aces.length) return aces[0];
      return L.slice().sort((a, b) => score(b, b.s, T) - score(a, a.s, T))[0];
    }
    const lead = this.trick[0].c.s;
    const best = Math.max(...this.trick.map((t) => score(t.c, lead, T)));
    const win = L.filter((c) => score(c, lead, T) > best).sort((a, b) => score(a, lead, T) - score(b, lead, T));
    if (win.length) return win[0];
    return L.slice().sort((a, b) => score(a, lead, T) - score(b, lead, T) || a.r - b.r)[0];
  }

  // ───────── Spielablauf ─────────
  async playRound() {
    // Obli-Runde: erste Runde oder Pot und Nebenpot leer
    const obli = this.pot === 0 && this.side === 0;
    this.reset();
    this.obli = obli;
    this.roundNo++;
    this.dealer = (this.dealer + 1) % this.n;
    const D = this.dealer, order = this.seatsFrom(D), dealOrder = this.seatsFrom(D + 1);
    // Einsatz nur, wenn Pot und Nebenpot leer sind – sonst spielt man um die Strafzahlungen im Pot
    if (obli) {
      for (const p of this.players) p.chips = round2(p.chips - this.cfg.ante);
      this.addPot(this.cfg.ante * this.n);
    }

    // Geben: je 2 Karten, Trumpf aufdecken, nochmals je 2 Karten
    this.phase = 'deal';
    this.deck = shuffle(Array.from({ length: 36 }, (_, k) => ({ s: Math.floor(k / 9), r: k % 9 })));
    this.say(`Runde ${this.roundNo}: ${this.players[D].name} gibt.${obli ? ' Obli-Runde – alle spielen mit!' : ''}`);
    for (const i of dealOrder) this.players[i].hand.push(...this.deck.splice(0, 2));
    this.ui.update(); await this.delay(0.7);
    this.open = this.deck.shift(); this.trump = this.open.s;
    this.say(`Aufgedeckt: ${cardName(this.open)} – Trumpf ist ${SUITS[this.trump]}.`);
    await this.delay(0.9);
    for (const i of dealOrder) this.players[i].hand.push(...this.deck.splice(0, 2));
    this.ui.update(); await this.delay(0.6);

    if (obli) {
      // Der Geber bekommt die aufgedeckte Karte und kauft, alle anderen müssen mitgehen.
      for (const p of this.players) p.looked = true;
      const d = this.players[D];
      d.hand.push(this.open); d.knocked = this.open; this.open = null; d.role = 'Käufer'; this.buyer = D;
      for (const i of order.slice(1)) this.players[i].role = 'Mitgeher';
      this.active = order.slice();
      this.say(`Obli-Runde: ${d.name} bekommt die Trumpfkarte und kauft, alle gehen mit.`);
      await this.delay(1.4);
    } else {
      // 1) Klopfen – nur solange man die eigenen Karten noch nicht angeschaut hat
      this.phase = 'knock';
      for (const i of order) {
        const p = this.players[i];
        const a = await this.decide(i, 'knock');
        p.looked = true;
        if (a === 'knock') {
          p.hand.push(this.open); p.knocked = this.open; this.open = null;
          p.role = 'Käufer'; this.buyer = i;
          this.say(`${p.name} klopft, nimmt die Trumpfkarte und kauft.`);
          await this.delay();
          break;
        }
      }
      for (const p of this.players) p.looked = true;

      // 2) Kaufen – bei «alle passen» neue Trumpfkarte, nach 3 Mal neu geben
      this.phase = 'buy';
      while (this.buyer < 0) {
        for (const i of order) {
          const p = this.players[i];
          if ((await this.decide(i, 'buy')) === 'buy') { p.role = 'Käufer'; this.buyer = i; this.say(`${p.name} kauft!`); break; }
          p.role = 'Passe'; this.say(`${p.name} passt.`);
        }
        if (this.buyer >= 0) break;
        this.reveals++;
        if (this.reveals >= 3) {
          this.say('Dreimal haben alle gepasst – die nächste Person mischt und gibt neu.');
          this.phase = 'redeal'; this.turn = -1;
          await this.delay(2);
          return { redeal: true };
        }
        await this.delay();
        this.open = this.deck.shift(); this.trump = this.open.s;
        for (const p of this.players) p.role = '';
        this.say(`Alle passen – neue Karte aufgedeckt. Trumpf ist jetzt ${SUITS[this.trump]}.`);
        await this.delay(1.2);
      }
      await this.delay(0.6);

      // 3) Mitgehen – mit Option «Letzter»; der Letzte muss notfalls mitgehen
      this.phase = 'join';
      const others = this.seatsFrom(this.buyer).slice(1);
      for (const p of this.players) if (p.role === 'Passe') p.role = '';
      let lastSayer = -1;
      for (let k = 0; k < others.length; k++) {
        const i = others[k], p = this.players[i];
        const anyJoin = this.players.some((q) => q.role === 'Mitgeher');
        const isLast = k === others.length - 1;
        const forced = isLast && !anyJoin && lastSayer < 0;
        const canLast = !anyJoin && lastSayer < 0 && !isLast;
        let a;
        if (forced) { if (!p.bot) await this.decide(i, 'forced'); a = 'join'; }
        else a = await this.decide(i, 'join', { canLast, buyer: this.players[this.buyer].name });
        if (a === 'last') {
          lastSayer = i; p.role = 'Letzter';
          this.say(`${p.name} sagt «Letzter»: geht mit, falls danach niemand mitgeht.`);
        } else {
          p.role = a === 'join' ? 'Mitgeher' : 'Passe';
          this.say(`${p.name} ${a === 'join' ? (forced ? 'muss mitgehen' : 'geht mit') : 'passt'}.`);
        }
        await this.delay(0.5);
      }
      if (lastSayer >= 0) {
        const p = this.players[lastSayer];
        if (this.players.some((q) => q.role === 'Mitgeher')) { p.role = 'Passe'; this.say(`${p.name} muss als «Letzter» nicht mitgehen.`); }
        else { p.role = 'Mitgeher'; this.say(`Niemand sonst geht mit – ${p.name} geht als «Letzter» mit.`); }
        await this.delay(0.6);
      }
      this.active = [this.buyer, ...others.filter((i) => this.players[i].role === 'Mitgeher')];
    }

    // 4) Tauschen – zuerst der Käufer, dann die Mitgeher. Stall: alle 4 tauschen → 5 bekommen, auf 4 Karten weglegen.
    //    Wer geklopft hat, tauscht beim Stall die 4 übrigen Karten und behält die geklopfte.
    this.phase = 'exchange';
    for (const i of this.active) {
      const p = this.players[i];
      const max = Math.min(4, this.deck.length);
      const stall = this.canStall(i);
      const idx = await this.decide(i, 'exchange', { max, stall, keep: this.knockedIdx(i) });
      const isStall = this.isStall(i, idx);
      const keep = p.hand.filter((_, k) => !idx.includes(k));
      p.hand = keep.concat(this.deck.splice(0, isStall ? 5 : idx.length));
      this.say(`${p.name} ${isStall ? 'nimmt einen Stall (5 neue Karten)' : `tauscht ${idx.length} ${idx.length === 1 ? 'Karte' : 'Karten'}`}.`);
      while (p.hand.length > 4) {
        const d = await this.decide(i, 'discard', { stall: isStall });
        p.hand.splice(d, 1);
      }
      await this.delay(0.5);
    }

    // 5) Stiche – der Käufer spielt aus
    this.phase = 'play';
    const pot0 = this.pot;
    let leader = this.buyer;
    for (let t = 0; t < 4; t++) {
      const k = this.active.indexOf(leader);
      const seq = this.active.slice(k).concat(this.active.slice(0, k));
      this.trick = [];
      for (const i of seq) {
        const p = this.players[i];
        const c = await this.decide(i, 'play', { legal: this.legal(i), lead: !this.trick.length });
        p.hand.splice(p.hand.indexOf(c), 1);
        p.played.push(c);
        this.trick.push({ p: i, c });
        this.ui.update();
      }
      leader = this.trickWinner();
      this.players[leader].won++;
      this.turn = -1;
      this.say(`${this.players[leader].name} macht den ${t + 1}. Stich.`);
      await this.delay(1.8);
      this.lastTrick = this.trick; this.trick = [];
    }

    // 6) Abrechnung
    this.settle(pot0);
    return { redeal: false };
  }

  /** Pot verteilen: nur wer sein Soll erfüllt, bekommt etwas – der Käufer doppelt so viel wie ein Mitgeher. */
  settle(pot0) {
    const failed = (i) => { const p = this.players[i]; return p.role === 'Käufer' ? p.won < 2 : p.won === 0; };
    const good = this.active.filter((i) => !failed(i));
    const W = good.reduce((a, i) => a + WEIGHT[this.players[i].role], 0) || 1;
    const rest = good.includes(this.buyer) ? this.buyer : good[good.length - 1];
    const rnd = Number.isInteger(pot0) ? Math.round : round2;
    const gain = {};
    let paid = 0;
    for (const i of good) if (i !== rest) { gain[i] = rnd(pot0 * WEIGHT[this.players[i].role] / W); paid += gain[i]; }
    if (rest != null) gain[rest] = round2(pot0 - paid);

    const rows = []; let penalty = 0;
    for (const i of this.active) {
      const p = this.players[i];
      if (failed(i)) {
        const pay = round2((p.role === 'Käufer' ? 2 : 1) * pot0);
        p.chips = round2(p.chips - pay); penalty = round2(penalty + pay);
        rows.push({ i, name: p.name, role: p.role, won: p.won, gain: 0, pay });
      } else {
        p.chips = round2(p.chips + gain[i]);
        rows.push({ i, name: p.name, role: p.role, won: p.won, gain: gain[i], pay: 0 });
      }
    }
    this.pot = 0; this.addPot(penalty);
    let refill = 0;
    const missing = round2(this.cfg.potMax - this.pot);
    if (missing > 0 && this.side > 0) { refill = Math.min(missing, this.side); this.pot = round2(this.pot + refill); this.side = round2(this.side - refill); }
    this.phase = 'end'; this.turn = -1;
    this.summary = { round: this.roundNo, rows, pot0, penalty, refill, pot: this.pot, side: this.side, obli: this.obli };
    const losers = rows.filter((r) => r.pay).map((r) => r.name);
    this.say(losers.length ? `Abrechnung: ${losers.join(' und ')} ${losers.length > 1 ? 'zahlen' : 'zahlt'} in den Pot.` : 'Abrechnung: alle haben ihr Soll erfüllt.');
  }
}
