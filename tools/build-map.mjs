// Gera data/world.json (territórios, vizinhanças e continentes) a partir de
// data/countries-110m.json (world-atlas). Só precisa rodar se mudar as regras do mapa.
//
//   cd tools && npm i topojson-client@3.1.0 d3-geo@3.1.1 i18n-iso-countries@7.11.3
//   node build-map.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const topojson = require('topojson-client');
import * as d3 from 'd3-geo';
const iso = require('i18n-iso-countries');

const root = new URL('..', import.meta.url).pathname;
const topo = JSON.parse(readFileSync(root + 'data/countries-110m.json', 'utf8'));
const geoms = topo.objects.countries.geometries;
const landNb = topojson.neighbors(geoms);
const features = topojson.feature(topo, topo.objects.countries).features;

const EXCLUDE = new Set(['Antarctica', 'Fr. S. Antarctic Lands']);
const EXTRA_NAMES = { 'N. Cyprus': 'Chipre do Norte', Somaliland: 'Somalilândia', Kosovo: 'Kosovo' };
const pt = new Intl.DisplayNames(['pt-BR'], { type: 'region' });

function largestPolygon(f) {
  const g = f.geometry;
  if (g.type === 'Polygon') return g;
  let best = null, bestA = -1;
  for (const coords of g.coordinates) {
    const p = { type: 'Polygon', coordinates: coords };
    const a = d3.geoArea(p);
    if (a > bestA) { bestA = a; best = p; }
  }
  return best;
}

function continentOf([lon, lat]) {
  if (lon < -30) return lat > 8 ? 'NA' : 'SA';
  if (lon > 125 && lat < 0) return 'OC';
  if (lat < 35 && lon > -20 && lon < 52) {
    if (lat > 28 && lon > 33) return 'AS';
    if (lon > 41 && lat > 12) return 'AS';
    return 'AF';
  }
  if (lat >= 35 && lon > -30 && lon < 50) {
    if (lon > 33 && lat < 37) return 'AS';
    return 'EU';
  }
  return 'AS';
}

// Índices mantidos, ordenados por id original para estabilidade.
const keep = [];
features.forEach((f, i) => { if (!EXCLUDE.has(f.properties.name)) keep.push(i); });
const newIdx = new Map(keep.map((orig, k) => [orig, k]));

const terr = keep.map((orig) => {
  const f = features[orig];
  const raw = f.properties.name;
  let name = EXTRA_NAMES[raw];
  if (!name) {
    const a2 = iso.numericToAlpha2(f.id);
    name = a2 ? pt.of(a2) : raw;
    if (!name || name === a2) name = raw;
  }
  const main = largestPolygon(f);
  const c = d3.geoCentroid(main);
  // pontos de contorno (amostrados) para medir distância por mar
  const pts = [];
  const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
  for (const poly of polys) for (const p of poly[0]) pts.push(p);
  const step = Math.max(1, Math.floor(pts.length / 80));
  const sample = pts.filter((_, i) => i % step === 0);
  return { orig, name, en: raw, cont: continentOf(c), c, sample, nb: new Set() };
});

terr.forEach((t, k) => {
  for (const o of landNb[t.orig]) if (newIdx.has(o)) t.nb.add(newIdx.get(o));
});

function dist(a, b) {
  let best = Infinity;
  for (const p of a.sample) for (const q of b.sample) {
    let dl = Math.abs(p[0] - q[0]); if (dl > 180) dl = 360 - dl;
    const dx = dl * Math.cos(((p[1] + q[1]) / 2) * Math.PI / 180);
    const dy = p[1] - q[1];
    const d = dx * dx + dy * dy;
    if (d < best) best = d;
  }
  return Math.sqrt(best);
}

const sea = new Set();
const link = (a, b) => {
  if (a === b || terr[a].nb.has(b)) return;
  terr[a].nb.add(b); terr[b].nb.add(a);
  sea.add(a < b ? `${a}-${b}` : `${b}-${a}`);
};

// Ligações marítimas: ilhas e países com uma única fronteira ganham vizinhos próximos.
const NO_SEA = new Set(['Lesotho', 'Gambia', 'eSwatini']);
terr.forEach((t, a) => {
  const land = t.nb.size;
  if (land >= 2 || NO_SEA.has(t.en)) return;
  const cand = terr.map((u, b) => [b, b === a ? Infinity : dist(t, u)]).sort((x, y) => x[1] - y[1]);
  let added = 0;
  for (const [b, d] of cand) {
    if (t.nb.has(b)) continue;
    if ((d < 2.5 && added < 3) || t.nb.size < 2) { link(a, b); added++; } else break;
  }
});

// Ligações manuais de rotas clássicas.
const byEn = (n) => terr.findIndex((t) => t.en === n);
for (const [x, y] of [
  ['Brazil', 'Senegal'], ['Russia', 'United States of America'], ['Egypt', 'Saudi Arabia'],
  ['Spain', 'Morocco'], ['Italy', 'Tunisia'], ['France', 'United Kingdom'], ['Yemen', 'Djibouti'],
  ['Indonesia', 'Australia'], ['Greece', 'Italy'], ['Iran', 'United Arab Emirates'],
]) {
  const a = byEn(x), b = byEn(y);
  if (a >= 0 && b >= 0) link(a, b);
}

// Garante grafo conexo.
function components() {
  const comp = new Array(terr.length).fill(-1); let n = 0;
  for (let s = 0; s < terr.length; s++) {
    if (comp[s] >= 0) continue;
    const st = [s]; comp[s] = n;
    while (st.length) { const v = st.pop(); for (const w of terr[v].nb) if (comp[w] < 0) { comp[w] = n; st.push(w); } }
    n++;
  }
  return { comp, n };
}
for (let it = 0; it < 50; it++) {
  const { comp, n } = components();
  if (n === 1) break;
  let best = [Infinity, -1, -1];
  for (let a = 0; a < terr.length; a++) if (comp[a] === 0)
    for (let b = 0; b < terr.length; b++) if (comp[b] !== 0) {
      const d = dist(terr[a], terr[b]); if (d < best[0]) best = [d, a, b];
    }
  link(best[1], best[2]);
}

const CONT = { NA: 'América do Norte', SA: 'América do Sul', EU: 'Europa', AF: 'África', AS: 'Ásia', OC: 'Oceania' };
const continents = {};
for (const k of Object.keys(CONT)) {
  const members = terr.map((t, i) => (t.cont === k ? i : -1)).filter((i) => i >= 0);
  continents[k] = { name: CONT[k], bonus: Math.max(2, Math.round(members.length / 5)), members };
}

const out = {
  continents,
  sea: [...sea].map((s) => s.split('-').map(Number)),
  territories: terr.map((t) => ({
    geo: t.orig,
    name: t.name,
    cont: t.cont,
    c: t.c.map((v) => +v.toFixed(2)),
    nb: [...t.nb].sort((a, b) => a - b),
  })),
};
writeFileSync(root + 'data/world.json', JSON.stringify(out));
console.log('territórios:', terr.length, 'ligações marítimas:', sea.size);
for (const [k, c] of Object.entries(continents)) console.log(k, c.members.length, 'bônus', c.bonus);
