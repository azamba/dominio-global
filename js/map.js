// Desenho do mapa-múndi (d3 + topojson) com zoom/arraste e marcadores de exércitos.
/* global d3, topojson */

export async function loadWorld() {
  const [topo, world] = await Promise.all([
    fetch('data/countries-110m.json').then((r) => r.json()),
    fetch('data/world.json').then((r) => r.json()),
  ]);
  const feats = topojson.feature(topo, topo.objects.countries).features;
  world.territories.forEach((t) => { t.feature = feats[t.geo]; });
  return world;
}

export class WorldMap {
  constructor(svgEl, world, onTap) {
    this.world = world;
    this.onTap = onTap;
    this.svg = d3.select(svgEl);
    this.svg.selectAll('*').remove();
    const W = 1000, H = 520;
    this.svg.attr('viewBox', `0 0 ${W} ${H}`).attr('preserveAspectRatio', 'xMidYMid meet');

    const proj = d3.geoNaturalEarth1().fitExtent([[6, 6], [W - 6, H - 6]], {
      type: 'FeatureCollection', features: world.territories.map((t) => t.feature),
    });
    this.proj = proj;
    const path = d3.geoPath(proj);
    this.root = this.svg.append('g');

    this.root.append('path').attr('class', 'sphere').attr('d', path({ type: 'Sphere' }));
    this.root.append('path').attr('class', 'graticule').attr('d', path(d3.geoGraticule10()));

    // rotas marítimas tracejadas (ignora as que cruzam a borda do mapa)
    const pt = (i) => proj(world.territories[i].c);
    this.root.append('g').attr('class', 'sea-links').selectAll('line')
      .data(world.sea.filter(([a, b]) => Math.abs(world.territories[a].c[0] - world.territories[b].c[0]) < 150))
      .join('line')
      .attr('x1', ([a]) => pt(a)[0]).attr('y1', ([a]) => pt(a)[1])
      .attr('x2', ([, b]) => pt(b)[0]).attr('y2', ([, b]) => pt(b)[1]);

    this.paths = this.root.append('g').attr('class', 'countries').selectAll('path')
      .data(world.territories)
      .join('path')
      .attr('d', (t) => path(t.feature))
      .on('click', (ev, t) => { ev.stopPropagation(); this.onTap(world.territories.indexOf(t)); });

    this.battleLayer = this.root.append('g').attr('class', 'battle-layer');

    this.labels = this.root.append('g').attr('class', 'labels').selectAll('g')
      .data(world.territories)
      .join('g')
      .attr('class', 'lbl')
      .attr('transform', (t) => `translate(${proj(t.c)})`)
      .on('click', (ev, t) => { ev.stopPropagation(); this.onTap(world.territories.indexOf(t)); });
    this.labels.append('circle');
    this.labels.append('text').attr('dy', '0.35em');

    this.k = 1;
    this.zoom = d3.zoom().scaleExtent([1, 14])
      .translateExtent([[0, 0], [W, H]])
      .on('zoom', (ev) => {
        this.root.attr('transform', ev.transform);
        if (Math.abs(ev.transform.k - this.k) > 0.01) { this.k = ev.transform.k; this.sizeLabels(); }
      });
    this.svg.call(this.zoom).on('dblclick.zoom', null);
    this.svg.on('click', () => this.onTap(-1));
    this.sizeLabels();
  }

  sizeLabels() {
    const k = this.k;
    const r = Math.max(2.2, 7 / Math.sqrt(k));
    this.labels.select('circle').attr('r', r);
    this.labels.select('text').attr('font-size', r * 1.15);
  }

  /** No celular em pé, começa com zoom para o mapa ocupar a altura da tela. */
  fitInitial() {
    const { width: w, height: h } = this.svg.node().getBoundingClientRect();
    if (!w || !h) return;
    this.fitted = true;
    const k = Math.min(4, h / (w * 0.52));
    if (k <= 1.1) return;
    this.svg.call(this.zoom.transform, d3.zoomIdentity.translate(500, 260).scale(k).translate(-520, -250));
  }

  zoomBy(f) { this.svg.transition().duration(250).call(this.zoom.scaleBy, f); }
  resetZoom() { this.svg.transition().duration(350).call(this.zoom.transform, d3.zoomIdentity); }

  focus(i) {
    const [x, y] = this.proj(this.world.territories[i].c);
    const k = Math.max(this.k, 3);
    this.svg.transition().duration(450).call(this.zoom.transform, d3.zoomIdentity.translate(500, 260).scale(k).translate(-x, -y));
  }

  /** hl: {sel, target, targets:Set, dim:boolean} */
  render(state, hl = {}) {
    const P = state.players, T = state.terr;
    const color = (i) => (T[i].o >= 0 ? P[T[i].o].color : '#555');
    this.paths
      .attr('fill', (_, i) => color(i))
      .classed('sel', (_, i) => i === hl.sel)
      .classed('target', (_, i) => i === hl.target)
      .classed('can', (_, i) => !!hl.targets?.has(i))
      .classed('dim', (_, i) => hl.dim && i !== hl.sel && i !== hl.target && !hl.targets?.has(i));
    this.labels.select('circle').attr('fill', (_, i) => color(i));
    this.labels.select('text').text((_, i) => T[i].a);
    this.labels.classed('dim', (_, i) => hl.dim && i !== hl.sel && i !== hl.target && !hl.targets?.has(i));
    // traz selecionados para frente para o contorno aparecer inteiro
    this.paths.filter('.can, .sel, .target').raise();
  }

  flashBattle(b) {
    const W = this.world.territories;
    const [x1, y1] = this.proj(W[b.from].c), [x2, y2] = this.proj(W[b.to].c);
    const k = this.k;
    const line = this.battleLayer.append('line')
      .attr('class', 'battle-arrow')
      .attr('x1', x1).attr('y1', y1).attr('x2', x1).attr('y2', y1);
    line.transition().duration(300).attr('x2', x2).attr('y2', y2)
      .transition().delay(700).duration(400).style('opacity', 0).remove();
    const boom = this.battleLayer.append('circle').attr('class', 'boom')
      .attr('cx', x2).attr('cy', y2).attr('r', 2 / k);
    boom.transition().delay(250).duration(700).attr('r', 22 / k).style('opacity', 0).remove();
  }
}
