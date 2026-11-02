// Regras do jogo. Puro (sem DOM/rede) — o anfitrião é a única fonte da verdade.

export const COLORS = ['#e4572e', '#3b82f6', '#22c55e', '#eab308', '#a855f7', '#ec4899'];
export const COLOR_NAMES = ['Vermelho', 'Azul', 'Verde', 'Amarelo', 'Roxo', 'Rosa'];
export const MAX_PLAYERS = 6;
export const CARD_SYMBOLS = ['▲', '■', '●', '★']; // ★ = curinga
const TRADE_VALUES = [4, 6, 8, 10, 12, 15];

export function tradeValue(n) {
  return n < TRADE_VALUES.length ? TRADE_VALUES[n] : 15 + 5 * (n - TRADE_VALUES.length + 1);
}

const rnd = (rng, n) => Math.floor(rng() * n);
const roll = (rng, n) => Array.from({ length: n }, () => 1 + rnd(rng, 6)).sort((a, b) => b - a);

function shuffle(arr, rng) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = rnd(rng, i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

export function createGame(world, players, settings, rng = Math.random) {
  const n = world.territories.length;
  const order = shuffle([...Array(n).keys()], rng);
  const pl = shuffle(players.map((p) => ({ ...p })), rng).map((p, i) => ({
    ...p, color: COLORS[i], colorName: COLOR_NAMES[i], alive: true, cards: [],
  }));
  const terr = Array.from({ length: n }, () => ({ o: -1, a: 1 }));
  order.forEach((t, i) => { terr[t].o = i % pl.length; });
  // exércitos iniciais extras distribuídos aleatoriamente
  const extra = settings.startArmies ?? 15;
  pl.forEach((_, p) => {
    const mine = terr.map((t, i) => (t.o === p ? i : -1)).filter((i) => i >= 0);
    for (let k = 0; k < extra; k++) terr[mine[rnd(rng, mine.length)]].a++;
  });
  const s = {
    phase: 'playing',
    players: pl,
    settings: { goal: settings.goal ?? 0.6 },
    terr,
    turn: 0,
    round: 1,
    step: 'reinforce',
    reserve: 0,
    conquered: false,
    pending: null,
    moved: {},
    trades: 0,
    log: [],
    battle: null,
    winner: null,
    seq: 0,
  };
  startTurn(s, world);
  return s;
}

export function ownedCount(s, p) {
  let c = 0;
  for (const t of s.terr) if (t.o === p) c++;
  return c;
}

export function goalCount(s) {
  return Math.ceil(s.settings.goal * s.terr.length);
}

export function continentsOwned(s, world, p) {
  return Object.entries(world.continents)
    .filter(([, c]) => c.members.every((i) => s.terr[i].o === p))
    .map(([k]) => k);
}

export function reinforcementsFor(s, world, p) {
  const base = Math.max(3, Math.floor(ownedCount(s, p) / 3));
  const bonus = continentsOwned(s, world, p).reduce((a, k) => a + world.continents[k].bonus, 0);
  return { base, bonus, total: base + bonus };
}

export function findSet(cards) {
  const idx = (sym) => cards.map((c, i) => (c === sym ? i : -1)).filter((i) => i >= 0);
  const wild = idx(3);
  for (const sym of [0, 1, 2]) {
    const same = idx(sym);
    if (same.length + wild.length >= 3) return [...same, ...wild].slice(0, 3);
  }
  const one = [0, 1, 2].map((sym) => idx(sym)[0]).filter((i) => i !== undefined);
  if (one.length + wild.length >= 3) return [...one, ...wild].slice(0, 3);
  return null;
}

function log(s, msg) {
  s.log.push(msg);
  if (s.log.length > 40) s.log.shift();
}

function doTrade(s, p) {
  const pl = s.players[p];
  const set = findSet(pl.cards);
  if (!set) return false;
  const v = tradeValue(s.trades++);
  pl.cards = pl.cards.filter((_, i) => !set.includes(i));
  s.reserve += v;
  log(s, `${pl.name} trocou cartas por ${v} exércitos`);
  return true;
}

function startTurn(s, world) {
  const p = s.turn;
  const r = reinforcementsFor(s, world, p);
  s.step = 'reinforce';
  s.reserve = r.total;
  s.conquered = false;
  s.pending = null;
  s.moved = {};
  s.battle = null;
  while (s.players[p].cards.length >= 5 && doTrade(s, p));
}

function nextTurn(s, world, rng) {
  const cur = s.players[s.turn];
  if (s.conquered) {
    cur.cards.push(rng() < 0.08 ? 3 : rnd(rng, 3));
  }
  let n = s.turn;
  do {
    n = (n + 1) % s.players.length;
    if (n === 0) s.round++;
  } while (!s.players[n].alive);
  s.turn = n;
  startTurn(s, world);
  log(s, `Vez de ${s.players[n].name}`);
}

function checkWinner(s) {
  const alive = s.players.filter((p) => p.alive);
  const p = s.turn;
  if (alive.length === 1 || ownedCount(s, p) >= goalCount(s)) {
    s.phase = 'ended';
    s.winner = p;
    log(s, `🏆 ${s.players[p].name} dominou o mundo!`);
  }
}

const err = (error) => ({ ok: false, error });
const OK = { ok: true };

function attackDice(s, from, to, dice, rng) {
  const A = s.terr[from], D = s.terr[to];
  const na = Math.min(3, A.a - 1, dice || 3);
  const nd = Math.min(2, D.a);
  const ad = roll(rng, na), dd = roll(rng, nd);
  let al = 0, dl = 0;
  for (let i = 0; i < Math.min(na, nd); i++) {
    if (ad[i] > dd[i]) dl++; else al++;
  }
  A.a -= al; D.a -= dl;
  return { ad, dd, al, dl, na };
}

/**
 * Aplica uma ação do jogador `p`. Muta `s`. Retorna {ok} ou {ok:false, error}.
 */
export function applyAction(s, world, p, act, rng = Math.random) {
  if (s.phase !== 'playing') return err('Partida não está em andamento');
  if (p !== s.turn) return err('Não é a sua vez');
  const T = s.terr, W = world.territories;
  const pl = s.players[p];
  const adj = (a, b) => W[a].nb.includes(b);
  const valid = (i) => Number.isInteger(i) && i >= 0 && i < T.length;

  if (s.pending && act.type !== 'move') return err('Mova os exércitos para o território conquistado');

  switch (act.type) {
    case 'trade': {
      if (s.step !== 'reinforce') return err('Troque cartas na fase de reforço');
      if (!doTrade(s, p)) return err('Você não tem uma combinação válida');
      break;
    }
    case 'place': {
      if (s.step !== 'reinforce') return err('Não é fase de reforço');
      const n = Math.min(act.n | 0, s.reserve);
      if (!valid(act.t) || T[act.t].o !== p) return err('Escolha um território seu');
      if (n <= 0) return err('Sem exércitos para posicionar');
      T[act.t].a += n;
      s.reserve -= n;
      break;
    }
    case 'attack': {
      if (s.step !== 'attack') return err('Não é fase de ataque');
      const { from, to } = act;
      if (!valid(from) || !valid(to)) return err('Território inválido');
      if (T[from].o !== p) return err('Ataque a partir de um território seu');
      if (T[to].o === p) return err('Esse território já é seu');
      if (!adj(from, to)) return err('Os territórios não fazem fronteira');
      if (T[from].a < 2) return err('Precisa de pelo menos 2 exércitos para atacar');
      const def = T[to].o;
      let r, rounds = 0, tl = { al: 0, dl: 0 };
      do {
        r = attackDice(s, from, to, act.dice, rng);
        tl.al += r.al; tl.dl += r.dl; rounds++;
      } while (act.blitz && T[to].a > 0 && T[from].a > 1);
      const conquered = T[to].a === 0;
      s.battle = { from, to, ad: r.ad, dd: r.dd, al: tl.al, dl: tl.dl, rounds, conquered, by: p, seq: ++s.seq };
      if (conquered) {
        T[to].o = p;
        s.conquered = true;
        const min = Math.min(r.na, T[from].a - 1);
        s.pending = { from, to, min: Math.max(1, min), max: T[from].a - 1 };
        log(s, `${pl.name} conquistou ${W[to].name} de ${s.players[def].name}`);
        if (ownedCount(s, def) === 0) {
          s.players[def].alive = false;
          pl.cards.push(...s.players[def].cards);
          s.players[def].cards = [];
          log(s, `☠ ${s.players[def].name} foi eliminado por ${pl.name}`);
        }
        checkWinner(s);
        if (s.phase === 'ended') {
          // move automaticamente para deixar o mapa consistente
          T[to].a = s.pending.min; T[from].a -= s.pending.min; s.pending = null;
        }
      }
      break;
    }
    case 'move': {
      if (!s.pending) return err('Nada para mover');
      const { from, to, min, max } = s.pending;
      const n = Math.max(min, Math.min(max, act.n | 0));
      T[to].a = n;
      T[from].a -= n;
      s.pending = null;
      break;
    }
    case 'fortify': {
      if (s.step !== 'fortify') return err('Não é fase de remanejamento');
      const { from, to } = act;
      if (!valid(from) || !valid(to) || T[from].o !== p || T[to].o !== p) return err('Escolha dois territórios seus');
      if (!adj(from, to)) return err('Os territórios não fazem fronteira');
      const free = T[from].a - 1 - (s.moved[from] || 0);
      const n = Math.min(act.n | 0, free);
      if (n <= 0) return err('Sem exércitos livres para mover aqui');
      T[from].a -= n;
      T[to].a += n;
      s.moved[to] = (s.moved[to] || 0) + n;
      break;
    }
    case 'end': {
      if (s.step === 'reinforce') {
        if (s.reserve > 0) return err('Posicione todos os exércitos antes');
        s.step = 'attack';
      } else if (s.step === 'attack') {
        s.step = 'fortify';
      } else {
        nextTurn(s, world, rng);
      }
      break;
    }
    default:
      return err('Ação desconhecida');
  }
  return OK;
}

/** Usado pelo anfitrião quando um jogador sai: pula a vez dele sem jogar. */
export function forceEndTurn(s, world, rng = Math.random) {
  if (s.phase !== 'playing') return;
  if (s.pending) applyAction(s, world, s.turn, { type: 'move', n: s.pending.min }, rng);
  if (s.reserve > 0) {
    const mine = s.terr.map((t, i) => (t.o === s.turn ? i : -1)).filter((i) => i >= 0);
    s.terr[mine[0]].a += s.reserve;
    s.reserve = 0;
  }
  nextTurn(s, world, rng);
}
