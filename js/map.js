// Carte Leaflet : zone équitable, épingles, tracés.

let map, zoneLayer, routeLayer, pinLayer, zoneShown = true, lastFit = null;

function ensureMap() {
  $('map').style.display = 'block';
  if (map) return map;
  map = L.map('map');
  // Molette seule : la page défile (on lit les résultats). Ctrl/⌘ + molette ou pincer le pavé tactile : la carte zoome.
  const hint = L.DomUtil.create('div', 'wheel-hint', $('map'));
  hint.textContent = matchMedia('(pointer: coarse)').matches ? 'Pincer pour zoomer' : 'Ctrl + molette (ou pincer) pour zoomer';
  let hintTimer;
  $('map').addEventListener('wheel', e => {
    if (e.ctrlKey || e.metaKey) return;
    e.stopPropagation(); // phase de capture : Leaflet ne la voit pas
    hint.classList.add('on');
    clearTimeout(hintTimer);
    hintTimer = setTimeout(() => hint.classList.remove('on'), 1200);
  }, { capture: true });
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(map);
  zoneLayer = L.layerGroup().addTo(map);
  routeLayer = L.layerGroup().addTo(map);
  pinLayer = L.layerGroup().addTo(map);
  const legend = L.control({ position: 'bottomleft' });
  legend.onAdd = () => {
    const div = L.DomUtil.create('div', 'legend');
    div.id = 'legend';
    L.DomEvent.disableClickPropagation(div);
    return div;
  };
  legend.addTo(map);
  // Carte cachée au moment du cadrage (onglet en arrière-plan, panneau replié) : on recadre quand elle réapparaît
  let lastWidth = $('map').clientWidth;
  new ResizeObserver(() => {
    const w = $('map').clientWidth;
    map.invalidateSize();
    if (!lastWidth && w && lastFit) map.fitBounds(...lastFit);
    lastWidth = w;
  }).observe($('map'));
  return map;
}

function fitTo(bounds, opts) {
  lastFit = [bounds, opts];
  map.invalidateSize();
  if (map.getSize().x) map.fitBounds(bounds, opts);
}

// 0 = meilleur point (vert) → 1 = 15 min de plus (rouge)
const zoneColor = t => `hsl(${Math.round(130 * (1 - Math.min(Math.max(t, 0), 1)))} 70% 42%)`;

function drawZone(grid, maxes, zone) {
  zoneLayer.clearLayers();
  grid.points.forEach((pt, k) => {
    const m = maxes[k], fair = zone.mask[k];
    const bounds = [[pt.lat - grid.stepLat / 2, pt.lon - grid.stepLon / 2], [pt.lat + grid.stepLat / 2, pt.lon + grid.stepLon / 2]];
    L.rectangle(bounds, {
      stroke: false,
      fillColor: isFinite(m) ? zoneColor((m - zone.best) / (3 * FAIR_MARGIN)) : '#78716c',
      fillOpacity: fair ? 0.5 : 0.1,
    }).bindTooltip(isFinite(m) ? `D'ici, le plus long trajet : ${fmt(m)}` : 'Pas de trajet trouvé', { sticky: true }).addTo(zoneLayer);
  });
  $('legend').innerHTML = `<label><input type="checkbox" id="zone-toggle" ${zoneShown ? 'checked' : ''}> <b>Zone équitable</b></label>
    <div class="grad"></div>
    <div class="grad-labels"><span>${fmt(zone.best)}</span><span>+15 min</span></div>
    <div class="alt">plus long trajet depuis chaque carré</div>`;
  $('zone-toggle').onchange = e => {
    zoneShown = e.target.checked;
    if (zoneShown) zoneLayer.addTo(map); else zoneLayer.remove();
  };
  if (zoneShown && !map.hasLayer(zoneLayer)) zoneLayer.addTo(map);
}

function pinIcon(text, bg, size = 24) {
  return L.divIcon({ className: '', html: `<div class="pin" style="background:${bg};width:${size}px;height:${size}px;line-height:${size - 4}px">${text}</div>`, iconSize: [size, size], iconAnchor: [size / 2, size / 2] });
}

// people, dests (dests[0] = point central), top = [{ di, c }], onPick(di)
function drawPins({ people, dests, top }, onPick) {
  pinLayer.clearLayers();
  const topDi = new Map(top.map((r, i) => [r.di, i]));
  dests.forEach((d, di) => {
    if (di === 0 || topDi.has(di)) return;
    L.circleMarker([d.lat, d.lon], { radius: 5, color: '#57534e', weight: 1, fillColor: '#a8a29e', fillOpacity: .9 })
      .bindTooltip(esc(d.name)).on('click', () => onPick(di)).addTo(pinLayer);
  });
  L.marker([dests[0].lat, dests[0].lon], { icon: pinIcon('✛', '#57534e', 22) }).bindTooltip('Point le plus équitable').on('click', () => onPick(0)).addTo(pinLayer);
  top.forEach((r, i) => L.marker([r.c.lat, r.c.lon], { icon: pinIcon(i + 1, '#e11d48'), zIndexOffset: 500 - i })
    .bindTooltip(esc(r.c.name)).on('click', () => onPick(r.di)).addTo(pinLayer));
  people.forEach(p => L.marker([p.lat, p.lon], { icon: pinIcon(esc(initial(p)), color(p.i)), zIndexOffset: 1000 })
    .bindTooltip(esc(label(p))).addTo(pinLayer));
  people.filter(p => p.after && p.after.lat != null).forEach(p => L.marker([p.after.lat, p.after.lon], { icon: pinIcon('↩︎', color(p.i), 22), zIndexOffset: 900 })
    .bindTooltip(esc(`${label(p)} va ensuite à ${p.after.q}`)).addTo(pinLayer));
}

// segs = [{ pts, style, tip, casing }]
function drawRoutes(segs, extraPoints) {
  routeLayer.clearLayers();
  for (const s of segs) {
    if (s.station) {
      L.circleMarker([s.station.lat, s.station.lon], { radius: 6, color: '#fff', weight: 2, fillColor: '#16a34a', fillOpacity: 1 })
        .bindTooltip(esc(s.tip)).addTo(routeLayer);
      continue;
    }
    if (s.casing) L.polyline(s.pts, { color: '#fff', weight: 10, opacity: .9 }).addTo(routeLayer);
    L.polyline(s.pts, { opacity: .95, ...s.style }).bindTooltip(esc(s.tip), { sticky: true }).addTo(routeLayer);
  }
  const pts = [...segs.flatMap(s => s.pts || []), ...extraPoints];
  if (pts.length) fitTo(L.latLngBounds(pts), { padding: [30, 30], maxZoom: 16 });
}
