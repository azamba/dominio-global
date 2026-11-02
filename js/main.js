/* global QRCode */
import {
  createGame, applyAction, forceEndTurn, reinforcementsFor, ownedCount, goalCount,
  findSet, tradeValue, continentsOwned, CARD_SYMBOLS, MAX_PLAYERS,
} from './game.js';
import { botAction } from './bot.js';
import { loadWorld, WorldMap } from './map.js';
import { HostTransport, ClientTransport, randomCode, normalizeCode } from './net.js';

const $ = (s) => document.querySelector(s);
const STEP_NAMES = { reinforce: 'Reforço', attack: 'Ataque', fortify: 'Remanejar' };
const AWAY_GRACE_MS = 15000; // depois disso, um bot joga pelo ausente
const BOT_NAMES = ['Gen. Ferro', 'Alm. Bruma', 'Cel. Areia', 'Mar. Gelo', 'Gen. Brasa', 'Cap. Neblina'];

const store = {
  get(k, d = null) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* sem armazenamento */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* idem */ } },
};

const myToken = store.get('dominio-token') || (() => {
  const t = crypto.getRandomValues(new Uint32Array(4)).join('-');
  store.set('dominio-token', t);
  return t;
})();

let world = null;     // dados estáticos do mapa
let map = null;       // WorldMap
let room = null;      // estado da sala recebido/mantido
let host = null;      // HostTransport, se eu sou o anfitrião
let client = null;    // ClientTransport, se eu sou convidado
let botTimer = null;
let lastBattleSeq = 0;
let lastTurnKey = '';
const ui = { sel: null, target: null, qty: '1', n: 1 };

// ---------------------------------------------------------------- utilidades
function show(id) {
  document.querySelectorAll('.screen').forEach((s) => s.classList.toggle('active', s.id === id));
}

let toastT;
function toast(msg, kind = 'error') {
  const t = $('#toast');
  t.textContent = msg;
  t.className = `toast show ${kind === 'info' ? 'info' : ''}`;
  clearTimeout(toastT);
  toastT = setTimeout(() => t.classList.remove('show'), 2600);
}

function confirmBox(text) {
  return new Promise((res) => {
    $('#modal-text').textContent = text;
    $('#modal').classList.remove('hidden');
    const done = (v) => { $('#modal').classList.add('hidden'); res(v); };
    $('#modal-yes').onclick = () => done(true);
    $('#modal-no').onclick = () => done(false);
  });
}

function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k === 'style') e.style.cssText = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) e.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) e.append(k.nodeType ? k : String(k));
  return e;
}

const inviteUrl = (code) => `${location.origin}${location.pathname}?sala=${code}`;
const myName = () => ($('#name').value.trim() || 'Jogador').slice(0, 16);
const game = () => room?.game;
const meIdx = () => (game() ? game().players.findIndex((p) => p.id === myToken) : -1);
const isMyTurn = () => game()?.phase === 'playing' && game().turn === meIdx();

// ---------------------------------------------------------------- ANFITRIÃO
function hostCreate(resume) {
  const code = resume?.code || randomCode();
  room = resume?.room || {
    code,
    phase: 'lobby',
    hostId: myToken,
    lobby: {
      players: [{ id: myToken, name: myName(), bot: false, connected: true }],
      settings: { goal: 0.6, startArmies: 15 },
    },
    game: null,
  };
  // ao retomar, todos os outros começam desconectados até voltarem
  const markAway = (p) => { if (!p.bot && p.id !== myToken) { p.connected = false; p.awaySince = Date.now(); } };
  room.lobby.players.forEach(markAway);
  room.game?.players.forEach(markAway);

  document.body.classList.add('is-host');
  setStatus('connecting');
  host = new HostTransport(code, {
    onOpen: () => { setStatus('online'); },
    onMessage: hostOnMessage,
    onLeave: (conn) => {
      if (!conn.token || [...host.conns].some((c) => c.token === conn.token)) return;
      setConnected(conn.token, false);
      hostCommit();
    },
    onError: (e) => { setStatus('offline'); toast(`Erro de rede: ${e.type || e.message}`); },
  });
  botTimer = setInterval(hostDriveBots, 750);
  hostCommit();
}

function setConnected(id, on) {
  for (const list of [room.lobby.players, room.game?.players || []]) {
    const p = list.find((x) => x.id === id);
    if (p) { p.connected = on; p.awaySince = on ? null : Date.now(); }
  }
}

function hostOnMessage(conn, msg) {
  if (!msg || typeof msg !== 'object') return;
  if (msg.t === 'hello') {
    const id = String(msg.token || '').slice(0, 64);
    const name = String(msg.name || 'Jogador').slice(0, 16);
    if (!id) return;
    const known = room.lobby.players.find((p) => p.id === id);
    if (!known) {
      if (room.phase !== 'lobby') return host.send(conn, { t: 'reject', msg: 'A partida já começou.' });
      if (room.lobby.players.length >= MAX_PLAYERS) return host.send(conn, { t: 'reject', msg: 'A sala está cheia.' });
      room.lobby.players.push({ id, name, bot: false, connected: true });
    } else if (room.phase === 'lobby') {
      known.name = name;
    }
    conn.token = id;
    setConnected(id, true);
    hostCommit();
    return;
  }
  if (!conn.token) return;
  if (msg.t === 'act') hostHandle(conn.token, msg.a, conn);
  if (msg.t === 'leave' && room.phase === 'lobby') {
    room.lobby.players = room.lobby.players.filter((p) => p.id !== conn.token);
    hostCommit();
  }
}

function hostHandle(id, act, conn) {
  const g = room.game;
  if (!g || !act) return;
  const idx = g.players.findIndex((p) => p.id === id);
  const r = applyAction(g, world, idx, act);
  if (!r.ok) {
    if (conn) host.send(conn, { t: 'error', msg: r.error });
    else toast(r.error);
    return;
  }
  if (g.phase === 'ended') room.phase = 'ended';
  hostCommit();
}

function hostDriveBots() {
  const g = room?.game;
  if (!g || g.phase !== 'playing') return;
  const p = g.players[g.turn];
  const away = !p.bot && p.id !== myToken && !p.connected && Date.now() - (p.awaySince || 0) > AWAY_GRACE_MS;
  if (!p.bot && !away) return;
  const act = botAction(g, world, g.turn);
  const r = applyAction(g, world, g.turn, act);
  if (!r.ok) forceEndTurn(g, world);
  if (g.phase === 'ended') room.phase = 'ended';
  hostCommit();
}

function hostCommit() {
  store.set('dominio-host', { code: room.code, room });
  host?.broadcast((conn) => ({ t: 'room', room }));
  render();
}

function hostStart() {
  const ps = room.lobby.players;
  if (ps.length < 2) return toast('Precisa de pelo menos 2 jogadores (adicione um bot).');
  room.lobby.settings.goal = Number($('#set-goal').value);
  room.lobby.settings.startArmies = Number($('#set-armies').value);
  room.game = createGame(world, ps.map((p) => ({ id: p.id, name: p.name, bot: p.bot, connected: p.connected })), room.lobby.settings);
  room.phase = 'playing';
  lastBattleSeq = 0;
  hostCommit();
}

function hostBackToLobby() {
  room.phase = 'lobby';
  room.game = null;
  hostCommit();
}

// ---------------------------------------------------------------- CONVIDADO
function clientJoin(code) {
  store.set('dominio-name', myName());
  document.body.classList.remove('is-host');
  room = null;
  show('lobby');
  $('#room-code').textContent = code;
  drawQR(code);
  $('#lobby-players').replaceChildren(el('li', {}, 'Conectando à sala…'));
  client = new ClientTransport(code, {
    onOpen: () => client.send({ t: 'hello', token: myToken, name: myName() }),
    onMessage: (msg) => {
      if (msg.t === 'room') { room = msg.room; render(); }
      else if (msg.t === 'error') toast(msg.msg);
      else if (msg.t === 'reject') { toast(msg.msg); leave(true); }
      else if (msg.t === 'closed') { toast('O anfitrião encerrou a sala.'); leave(true); }
    },
    onStatus: (st) => {
      setStatus(st);
      if (st === 'notfound' && !room) $('#lobby-players').replaceChildren(el('li', {}, `Sala ${code} não encontrada. Tentando de novo…`));
      if (st === 'offline' && room) toast('Conexão perdida. Reconectando…', 'info');
    },
  });
}

// ---------------------------------------------------------------- ações locais
function act(a) {
  if (host) hostHandle(myToken, a, null);
  else if (!client?.send({ t: 'act', a })) toast('Sem conexão com a sala');
}

async function leave(silent) {
  if (!silent) {
    const msg = host ? 'Encerrar a sala para todos?' : 'Sair da sala?';
    if (!(await confirmBox(msg))) return;
  }
  if (host) {
    host.broadcast(() => ({ t: 'closed' }));
    store.del('dominio-host');
    setTimeout(() => host?.destroy(), 300);
    clearInterval(botTimer);
  } else if (client) {
    client.send({ t: 'leave' });
    setTimeout(() => client?.destroy(), 300);
  }
  host = null; client = null; room = null;
  history.replaceState(null, '', location.pathname);
  $('#drawer').classList.remove('open');
  $('#winner').classList.add('hidden');
  homeRefresh();
  show('home');
}

function setStatus(st) {
  const d = $('#lobby-status');
  const label = { online: 'Online', connecting: 'Conectando…', offline: 'Desconectado', notfound: 'Procurando sala…', error: 'Erro de rede' };
  d.textContent = label[st] || st;
  d.className = `status-dot ${st === 'online' ? 'online' : st === 'offline' || st === 'error' ? 'offline' : ''}`;
}

// ---------------------------------------------------------------- renderização
function render() {
  if (!room) return;
  if (room.phase === 'lobby') { renderLobby(); show('lobby'); return; }
  show('game');
  if (map && !map.fitted) map.fitInitial();
  renderGame();
}

let qrFor = null;
function drawQR(code) {
  if (qrFor === code) return;
  qrFor = code;
  const box = $('#qr');
  box.replaceChildren();
  new QRCode(box, { text: inviteUrl(code), width: 180, height: 180, colorDark: '#0a0f1a', colorLight: '#ffffff', correctLevel: QRCode.CorrectLevel.M });
}

function renderLobby() {
  $('#room-code').textContent = room.code;
  drawQR(room.code);
  const ps = room.lobby.players;
  $('#pcount').textContent = `(${ps.length}/${MAX_PLAYERS})`;
  $('#lobby-players').replaceChildren(...ps.map((p) => el('li', {},
    el('span', { class: 'swatch' }),
    el('span', { class: 'pname' }, p.name, p.id === myToken ? ' (você)' : ''),
    p.id === room.hostId ? el('span', { class: 'tag host' }, 'anfitrião') : null,
    p.bot ? el('span', { class: 'tag' }, 'bot') : null,
    !p.bot && !p.connected ? el('span', { class: 'tag off' }, 'offline') : null,
    host && p.id !== myToken ? el('button', { class: 'x', title: 'Remover', onclick: () => {
      room.lobby.players = room.lobby.players.filter((x) => x.id !== p.id);
      hostCommit();
    } }, '✕') : null,
  )));
  $('#btn-bot').disabled = ps.length >= MAX_PLAYERS;
  $('#btn-start').disabled = ps.length < 2;
  const st = room.lobby.settings;
  $('#set-goal').value = String(st.goal);
  $('#set-armies').value = String(st.startArmies);
  $('#settings-ro').textContent = `Objetivo: dominar ${Math.round(st.goal * 100)}% do mundo`;
}

function highlight() {
  const g = game();
  const me = meIdx();
  const hl = { sel: ui.sel, target: ui.target, targets: new Set(), dim: false };
  if (!isMyTurn() || ui.sel == null) return hl;
  const W = world.territories, T = g.terr;
  if (g.step === 'attack') {
    W[ui.sel].nb.forEach((j) => { if (T[j].o !== me) hl.targets.add(j); });
    hl.dim = true;
  } else if (g.step === 'fortify') {
    W[ui.sel].nb.forEach((j) => { if (T[j].o === me) hl.targets.add(j); });
    hl.dim = true;
  }
  return hl;
}

function renderGame() {
  const g = game();
  if (!map) return;
  const me = meIdx();
  const cur = g.players[g.turn];

  // limpa seleção quando muda o turno/fase
  const key = `${g.turn}|${g.step}|${g.round}`;
  if (key !== lastTurnKey) {
    const wasMine = lastTurnKey && lastTurnKey.split('|')[0] === String(me);
    lastTurnKey = key;
    ui.sel = ui.target = null;
    if (g.turn === me && g.step === 'reinforce' && !wasMine && g.phase === 'playing') {
      toast('Sua vez! Posicione seus reforços.', 'info');
      navigator.vibrate?.(120);
    }
  }
  if (ui.sel != null && g.terr[ui.sel].o !== me) ui.sel = ui.target = null;
  if (g.step === 'fortify' && ui.target != null && g.terr[ui.target].o !== me) ui.target = null;
  if (g.step === 'attack' && ui.target != null && g.terr[ui.target].o === me && !g.pending) ui.target = null;
  if (g.step === 'attack' && ui.sel != null && g.terr[ui.sel].a < 2 && !g.pending) ui.sel = ui.target = null;

  map.render(g, highlight());

  // HUD
  $('#turn-chip').replaceChildren(
    el('span', { class: 'swatch', style: `background:${cur.color}` }),
    el('span', {}, g.turn === me ? 'Sua vez' : cur.name),
  );
  document.querySelectorAll('#steps span').forEach((s) => s.classList.toggle('on', s.dataset.step === g.step));
  const mine = me >= 0 ? g.players[me].cards : [];
  $('#my-cards').replaceChildren(...mine.map((c) => el('span', {}, CARD_SYMBOLS[c])));

  renderPanel();
  renderDrawer();
  renderBattle();
  renderWinner();
}

function renderPanel() {
  const g = game();
  const me = meIdx();
  const T = g.terr, W = world.territories;
  const panel = $('#panel');
  const kids = [];
  const info = (title, sub) => el('div', { class: 'info' }, el('b', {}, title), sub ? el('div', { class: 'sub' }, sub) : null);
  const btn = (label, onclick, cls = '', disabled = false) => el('button', { class: `btn ${cls}`, onclick, disabled }, label);
  const range = (min, max, val, onset) => {
    const out = el('output', {}, val);
    const inp = el('input', { type: 'range', min, max, value: val, oninput: (e) => { out.textContent = e.target.value; onset(+e.target.value); } });
    return el('div', { class: 'range' }, inp, out);
  };

  if (g.phase !== 'playing') {
    kids.push(info('Partida encerrada'));
  } else if (!isMyTurn()) {
    const cur = g.players[g.turn];
    const sel = ui.sel != null ? `${W[ui.sel].name} · ${T[ui.sel].a} exércitos · ${g.players[T[ui.sel].o].name}` : null;
    kids.push(info(`Aguardando ${cur.name}${cur.bot ? ' (bot)' : ''}…`, sel || `${STEP_NAMES[g.step]} · rodada ${g.round}`));
  } else if (g.pending) {
    const { from, to, min, max } = g.pending;
    if (ui.pendKey !== g.battle?.seq) { ui.pendKey = g.battle?.seq; ui.n = max; }
    ui.n = Math.min(Math.max(ui.n, min), max);
    kids.push(info(`Conquistou ${W[to].name}!`, `Quantos exércitos mover de ${W[from].name}?`));
    kids.push(el('div', { class: 'acts' },
      max > min ? range(min, max, ui.n, (v) => { ui.n = v; }) : null,
      btn('Mover', () => act({ type: 'move', n: ui.n }), 'primary'),
    ));
  } else if (g.step === 'reinforce') {
    const r = reinforcementsFor(g, world, me);
    const set = findSet(g.players[me].cards);
    const sub = g.reserve > 0
      ? `Toque nos seus territórios. Base ${r.base}${r.bonus ? ` + continentes ${r.bonus}` : ''}`
      : 'Reforços posicionados. Hora de atacar!';
    kids.push(info(el('span', {}, 'Reforços: ', el('span', { class: 'big-num' }, g.reserve)), sub));
    const seg = el('div', { class: 'seg' }, ...[['1', '+1'], ['5', '+5'], ['all', 'Todos']].map(([v, l]) =>
      el('button', { class: ui.qty === v ? 'on' : '', onclick: () => { ui.qty = v; renderPanel(); } }, l)));
    kids.push(el('div', { class: 'acts' },
      g.reserve > 0 ? seg : null,
      set ? btn(`Trocar cartas (+${tradeValue(g.trades)})`, () => act({ type: 'trade' })) : null,
      btn('Atacar ▶', () => act({ type: 'end' }), 'primary', g.reserve > 0),
    ));
  } else if (g.step === 'attack') {
    let title = 'Ataque', sub = 'Escolha um território seu com 2+ exércitos.';
    const acts = [];
    if (ui.sel != null && ui.target == null) {
      title = W[ui.sel].name; sub = `${T[ui.sel].a} exércitos · escolha um vizinho inimigo (destacado).`;
    } else if (ui.sel != null && ui.target != null) {
      const a = T[ui.sel].a, d = T[ui.target].a;
      title = `${W[ui.sel].name} (${a}) ⚔ ${W[ui.target].name} (${d})`;
      sub = `Defensor: ${g.players[T[ui.target].o].name}`;
      const can = a > 1;
      acts.push(btn(`Atacar (${Math.min(3, a - 1)} dados)`, () => act({ type: 'attack', from: ui.sel, to: ui.target }), 'danger', !can));
      acts.push(btn('Até o fim', () => act({ type: 'attack', from: ui.sel, to: ui.target, blitz: true }), '', !can));
    }
    kids.push(info(title, sub));
    kids.push(el('div', { class: 'acts' }, ...acts, btn('Remanejar ▶', () => act({ type: 'end' }), 'primary')));
  } else if (g.step === 'fortify') {
    let title = 'Remanejar tropas', sub = 'Mova exércitos entre territórios seus vizinhos. Cada exército só se move uma vez.';
    const acts = [];
    if (ui.sel != null) {
      const free = T[ui.sel].a - 1 - (g.moved[ui.sel] || 0);
      if (ui.target == null) {
        title = W[ui.sel].name; sub = `${free} exército(s) livre(s) · escolha um vizinho seu.`;
      } else {
        title = `${W[ui.sel].name} → ${W[ui.target].name}`;
        sub = `${free} exército(s) livre(s)`;
        ui.n = Math.min(Math.max(1, ui.n), Math.max(1, free));
        if (free > 0) {
          if (free > 1) acts.push(range(1, free, ui.n, (v) => { ui.n = v; }));
          acts.push(btn('Mover', () => act({ type: 'fortify', from: ui.sel, to: ui.target, n: ui.n })));
        }
      }
    }
    kids.push(info(title, sub));
    kids.push(el('div', { class: 'acts' }, ...acts, btn('Encerrar turno ✓', () => act({ type: 'end' }), 'primary')));
  }
  panel.replaceChildren(...kids);
}

function renderDrawer() {
  const g = game();
  $('#drawer-code').textContent = room.code;
  const goal = goalCount(g);
  $('#goal-info').textContent = `Objetivo: dominar ${goal} de ${g.terr.length} países (${Math.round(g.settings.goal * 100)}%). Rodada ${g.round}.`;
  $('#game-players').replaceChildren(...g.players.map((p, i) => {
    const n = ownedCount(g, i);
    const armies = g.terr.reduce((a, t) => a + (t.o === i ? t.a : 0), 0);
    return el('li', { class: `${i === g.turn ? 'current' : ''} ${p.alive ? '' : 'dead'}` },
      el('span', { class: 'swatch', style: `background:${p.color}` }),
      el('div', { style: 'flex:1;min-width:0' },
        el('div', { class: 'pname' }, p.name, p.id === myToken ? ' (você)' : ''),
        el('div', { class: 'meta' }, `${n} países · ${armies} exércitos · ${p.cards.length} cartas`),
        el('div', { class: 'bar' }, el('i', { style: `width:${Math.min(100, (n / goal) * 100)}%;background:${p.color}` })),
      ),
      p.bot ? el('span', { class: 'tag' }, 'bot') : null,
      !p.bot && !p.connected ? el('span', { class: 'tag off' }, 'offline') : null,
    );
  }));
  $('#continents').replaceChildren(...Object.entries(world.continents).map(([k, c]) => {
    const owner = g.players.findIndex((_, i) => continentsOwned(g, world, i).includes(k));
    return el('li', {},
      el('span', {}, el('b', {}, c.name), ` · ${c.members.length} países`),
      el('span', { style: owner >= 0 ? `color:${g.players[owner].color}` : '' }, `+${c.bonus}`));
  }));
  $('#log').replaceChildren(...g.log.map((l) => el('li', {}, l)));
}

let battleT;
function renderBattle() {
  const g = game();
  const b = g.battle;
  if (!b || b.seq === lastBattleSeq) return;
  lastBattleSeq = b.seq;
  const W = world.territories;
  const ac = g.players[b.by].color;
  const dc = b.conquered ? '#666' : g.players[g.terr[b.to].o].color;
  const die = (v, c) => el('span', { class: 'die', style: `background:${c}` }, v);
  const box = $('#battle');
  box.replaceChildren(
    el('div', { class: 'vs' }, `${W[b.from].name} ⚔ ${W[b.to].name}`),
    el('div', { class: 'dice-row' }, ...b.ad.map((v) => die(v, ac))),
    el('div', { class: 'dice-row' }, ...b.dd.map((v) => die(v, dc))),
    el('div', { class: 'res' }, `Ataque −${b.al} · Defesa −${b.dl}${b.rounds > 1 ? ` · ${b.rounds} rodadas` : ''}`),
    b.conquered ? el('div', { class: 'won' }, `${W[b.to].name} conquistado!`) : null,
  );
  box.classList.add('show');
  clearTimeout(battleT);
  battleT = setTimeout(() => box.classList.remove('show'), 2600);
  map.flashBattle(b);
}

function renderWinner() {
  const g = game();
  const ov = $('#winner');
  if (g.phase !== 'ended') { ov.classList.add('hidden'); return; }
  const w = g.players[g.winner];
  ov.replaceChildren(el('div', { class: 'win' },
    el('div', { class: 'trophy' }, '🏆'),
    el('h2', { style: `color:${w.color}` }, w.id === myToken ? 'Vitória!' : `${w.name} venceu`),
    el('p', {}, `Dominou ${ownedCount(g, g.winner)} países na rodada ${g.round}.`),
    host ? el('button', { class: 'btn primary', onclick: hostBackToLobby }, 'Nova partida')
      : el('p', { class: 'fine' }, 'Aguardando o anfitrião iniciar outra partida…'),
    el('button', { class: 'btn ghost', onclick: () => ov.classList.add('hidden') }, 'Ver o mapa'),
  ));
  if (!ov.dataset.shown || ov.dataset.shown !== String(g.seq)) {
    ov.dataset.shown = String(g.seq);
    ov.classList.remove('hidden');
  }
}

// ---------------------------------------------------------------- toque no mapa
function onTap(i) {
  const g = game();
  if (!g) return;
  if (i < 0) { ui.sel = ui.target = null; renderGame(); return; }
  const me = meIdx();
  const T = g.terr, W = world.territories;
  if (!isMyTurn() || g.pending) { ui.sel = i; ui.target = null; renderGame(); return; }
  const mine = T[i].o === me;

  if (g.step === 'reinforce') {
    if (!mine) { toast(`${W[i].name} não é seu`); return; }
    if (g.reserve <= 0) { toast('Sem reforços. Avance para o ataque.', 'info'); return; }
    act({ type: 'place', t: i, n: ui.qty === 'all' ? g.reserve : Number(ui.qty) });
    return;
  }
  if (g.step === 'attack') {
    if (mine) {
      if (T[i].a < 2) toast('Precisa de 2+ exércitos para atacar daqui', 'info');
      ui.sel = T[i].a >= 2 ? i : null; ui.target = null;
    } else if (ui.sel != null && W[ui.sel].nb.includes(i)) {
      ui.target = i;
    } else if (ui.sel != null) {
      toast(`${W[i].name} não faz fronteira com ${W[ui.sel].name}`);
    } else {
      toast('Primeiro escolha um território seu');
    }
    renderGame();
    return;
  }
  if (g.step === 'fortify') {
    if (!mine) { toast('Escolha territórios seus'); return; }
    if (ui.sel != null && ui.sel !== i && W[ui.sel].nb.includes(i)) { ui.target = i; ui.n = 999; }
    else { ui.sel = i; ui.target = null; }
    renderGame();
  }
}

// ---------------------------------------------------------------- início
function homeRefresh() {
  const saved = store.get('dominio-host');
  const b = $('#btn-resume');
  if (saved?.code && saved.room) {
    b.textContent = `Retomar minha sala ${saved.code}`;
    b.classList.remove('hidden');
  } else b.classList.add('hidden');
}

async function boot() {
  $('#name').value = store.get('dominio-name', '');
  const params = new URLSearchParams(location.search);
  const urlCode = normalizeCode(params.get('sala'));
  if (urlCode) {
    $('#code').value = urlCode;
    $('#btn-create').classList.replace('primary', 'ghost');
    $('#btn-join').classList.add('primary');
  }
  homeRefresh();

  const loading = loadWorld().then((w) => {
    world = w;
    map = new WorldMap($('#map'), world, onTap);
  }).catch((e) => toast(`Falha ao carregar o mapa: ${e.message}`));

  const need = () => {
    if (typeof Peer === 'undefined') { toast('Não foi possível carregar a biblioteca de rede.'); return false; }
    if (!$('#name').value.trim()) { $('#name').focus(); toast('Digite seu nome'); return false; }
    store.set('dominio-name', myName());
    return true;
  };

  $('#btn-create').onclick = async () => {
    if (!need()) return;
    store.del('dominio-host');
    await loading;
    hostCreate(null);
  };
  $('#btn-join').onclick = async () => {
    const code = normalizeCode($('#code').value);
    if (code.length < 4) { $('#code').focus(); toast('Digite o código da sala'); return; }
    if (!need()) return;
    await loading;
    history.replaceState(null, '', `?sala=${code}`);
    clientJoin(code);
  };
  $('#code').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#btn-join').click(); });
  $('#btn-resume').onclick = async () => {
    await loading;
    const saved = store.get('dominio-host');
    if (saved) hostCreate(saved);
  };

  document.querySelectorAll('[data-leave]').forEach((b) => { b.onclick = () => leave(false); });
  $('#btn-copy').onclick = async () => {
    const url = inviteUrl(room?.code || $('#room-code').textContent);
    try { await navigator.clipboard.writeText(url); toast('Link copiado!', 'info'); } catch { toast(url, 'info'); }
  };
  $('#btn-share').onclick = async () => {
    const code = room?.code || $('#room-code').textContent;
    const data = { title: 'Domínio Global', text: `Entre na minha sala do Domínio Global: ${code}`, url: inviteUrl(code) };
    if (navigator.share) { try { await navigator.share(data); } catch { /* cancelado */ } } else $('#btn-copy').click();
  };
  $('#btn-bot').onclick = () => {
    const ps = room.lobby.players;
    if (ps.length >= MAX_PLAYERS) return;
    const used = new Set(ps.map((p) => p.name));
    const name = BOT_NAMES.find((n) => !used.has(n)) || `Bot ${ps.length}`;
    ps.push({ id: `bot-${randomCode(6)}`, name, bot: true, connected: true });
    hostCommit();
  };
  $('#btn-start').onclick = hostStart;
  for (const id of ['#set-goal', '#set-armies']) {
    $(id).onchange = () => {
      room.lobby.settings.goal = Number($('#set-goal').value);
      room.lobby.settings.startArmies = Number($('#set-armies').value);
      hostCommit();
    };
  }
  $('#btn-players').onclick = () => $('#drawer').classList.toggle('open');
  $('#btn-close-drawer').onclick = () => $('#drawer').classList.remove('open');
  document.querySelectorAll('[data-zoom]').forEach((b) => {
    b.onclick = () => { const f = +b.dataset.zoom; if (f) map.zoomBy(f); else map.resetZoom(); };
  });
}

boot();
