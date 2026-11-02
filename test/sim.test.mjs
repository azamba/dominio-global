// Simula partidas completas entre bots e verifica invariantes das regras.
//   node test/sim.test.mjs
import { readFileSync } from 'node:fs';
import { createGame, applyAction, fortifyTargets } from '../js/game.js';
import { botAction } from '../js/bot.js';

const world = JSON.parse(readFileSync(new URL('../data/world.json', import.meta.url)));
let fail = 0;

// o grafo de fronteiras deve ser simétrico e conexo
world.territories.forEach((t, i) => t.nb.forEach((j) => {
  if (!world.territories[j].nb.includes(i)) { console.error('vizinhança assimétrica', i, j); fail++; }
}));
const seen = new Set([0]); const st = [0];
while (st.length) for (const j of world.territories[st.pop()].nb) if (!seen.has(j)) { seen.add(j); st.push(j); }
if (seen.size !== world.territories.length) { console.error('mapa desconexo'); fail++; }

for (const np of [2, 3, 4, 6]) {
  const s = createGame(world, Array.from({ length: np }, (_, i) => ({ id: `p${i}`, name: `Bot${i}` })), { goal: 0.6 });
  let n = 0;
  while (s.phase === 'playing' && n++ < 200000) {
    const r = applyAction(s, world, s.turn, botAction(s, world, s.turn));
    if (!r.ok) { console.error('ação inválida do bot:', r.error); fail++; break; }
    s.terr.forEach((t, i) => {
      if (t.o < 0 || (t.a < 1 && s.pending?.to !== i)) { console.error('território inválido', i, t); fail++; }
    });
    if (fail) break;
  }
  if (s.phase !== 'ended') { console.error(`${np} jogadores: partida não terminou`); fail++; }
  else console.log(`ok · ${np} jogadores · vencedor ${s.players[s.winner].name} na rodada ${s.round}`);
}
// remanejamento: por rota exige corrente de países próprios; livre não; vários por turno
{
  const W = world.territories;
  const id = (n) => W.findIndex((t) => t.name === n);
  const [bra, arg, chi, fra, aus] = ['Brasil', 'Argentina', 'Chile', 'Alemanha', 'Austrália'].map(id);
  const check = (cond, msg) => { if (!cond) { console.error('remanejamento:', msg); fail++; } };
  for (const mode of ['path', 'free']) {
    const s = createGame(world, [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], { fortify: mode });
    s.terr.forEach((t) => { t.o = 1; t.a = 1; });
    for (const i of [bra, arg, chi, fra, aus]) s.terr[i].o = 0;
    s.terr[bra].a = 10;
    Object.assign(s, { turn: 0, step: 'fortify', reserve: 0, pending: null });
    const t = fortifyTargets(s, world, bra);
    check(t.has(arg) && t.has(chi), `${mode}: Brasil deveria alcançar Chile via Argentina`);
    check(mode === 'free' ? t.has(fra) : !t.has(fra), `${mode}: Alemanha ${mode === 'free' ? 'deveria' : 'não deveria'} ser alcançável`);
    check(applyAction(s, world, 0, { type: 'fortify', from: bra, to: chi, n: 3 }).ok, `${mode}: Brasil→Chile`);
    check(applyAction(s, world, 0, { type: 'fortify', from: bra, to: arg, n: 2 }).ok, `${mode}: segunda transferência`);
    check(applyAction(s, world, 0, { type: 'fortify', from: chi, to: arg, n: 3 }).ok, `${mode}: tropas recém-chegadas podem seguir`);
    check(applyAction(s, world, 0, { type: 'fortify', from: bra, to: aus, n: 1 }).ok === (mode === 'free'), `${mode}: Brasil→Austrália`);
    check(!applyAction(s, world, 0, { type: 'fortify', from: chi, to: arg, n: 5 }).ok, `${mode}: não pode esvaziar a origem`);
    check(s.terr[bra].a + s.terr[arg].a + s.terr[chi].a + s.terr[aus].a === 13, `${mode}: exércitos devem se conservar`);
  }
  if (!fail) console.log('ok · remanejamento por rota e livre');
}

process.exit(fail ? 1 : 0);
