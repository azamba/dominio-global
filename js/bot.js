// IA simples: decide UMA ação por vez para o anfitrião animar a jogada.
import { findSet } from './game.js';

export function botAction(s, world, p) {
  const T = s.terr, W = world.territories;
  const mine = T.map((t, i) => (t.o === p ? i : -1)).filter((i) => i >= 0);
  const enemyNb = (i) => W[i].nb.filter((j) => T[j].o !== p);

  if (s.pending) {
    const { from, max, min } = s.pending;
    const stillBorder = enemyNb(from).length > 0;
    return { type: 'move', n: stillBorder ? Math.max(min, Math.ceil(max / 2)) : max };
  }

  if (s.step === 'reinforce') {
    if (findSet(s.players[p].cards) && s.players[p].cards.length >= 3) return { type: 'trade' };
    if (s.reserve > 0) {
      // reforça a fronteira com a melhor oportunidade de ataque
      let best = mine[0], bestScore = -Infinity;
      for (const i of mine) {
        const en = enemyNb(i);
        if (!en.length) continue;
        const weakest = Math.min(...en.map((j) => T[j].a));
        const score = T[i].a - weakest + Math.random() * 2;
        if (score > bestScore) { bestScore = score; best = i; }
      }
      return { type: 'place', t: best, n: s.reserve };
    }
    return { type: 'end' };
  }

  if (s.step === 'attack') {
    let best = null, bestScore = 0;
    for (const i of mine) {
      if (T[i].a < 3) continue;
      for (const j of enemyNb(i)) {
        const ratio = (T[i].a - 1) / T[j].a;
        if (ratio >= 1.6 && ratio > bestScore) { bestScore = ratio; best = { from: i, to: j }; }
      }
    }
    if (best) return { type: 'attack', ...best, blitz: true };
    return { type: 'end' };
  }

  if (s.step === 'fortify') {
    // move tropas de um território interior para um vizinho na fronteira
    for (const i of mine) {
      const free = T[i].a - 1 - (s.moved[i] || 0);
      if (free < 1 || enemyNb(i).length) continue;
      const to = W[i].nb.find((j) => T[j].o === p && enemyNb(j).length);
      if (to !== undefined) return { type: 'fortify', from: i, to, n: free };
    }
    return { type: 'end' };
  }
  return { type: 'end' };
}
