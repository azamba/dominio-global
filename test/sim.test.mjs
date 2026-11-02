// Simula partidas completas entre bots e verifica invariantes das regras.
//   node test/sim.test.mjs
import { readFileSync } from 'node:fs';
import { createGame, applyAction } from '../js/game.js';
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
process.exit(fail ? 1 : 0);
