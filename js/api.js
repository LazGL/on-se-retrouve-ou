// Accès réseau. Tout passe par getJSON : délai max, nouvelle tentative si le serveur limite le débit (429), annulation.

function withTimeout(signal, ms) {
  const t = AbortSignal.timeout(ms);
  return signal && AbortSignal.any ? AbortSignal.any([signal, t]) : t;
}

async function getJSON(url, { ms = 20000, signal, ...init } = {}) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const r = await fetch(url, { ...init, signal: withTimeout(signal, ms) });
    if (r.status === 429 && attempt < 3) {
      const retry = +r.headers.get('Retry-After');
      await sleep(retry ? retry * 1000 : 1500 * attempt);
      continue;
    }
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  }
}

// File d'attente par service : un appel à la fois, au moins `gap` ms après la fin du précédent.
// Nominatim et le serveur OSRM de FOSSGIS refusent (429) les rafales venant d'une même adresse IP.
const queues = new Map();
function throttled(key, gap, fn) {
  const q = queues.get(key) || { chain: Promise.resolve(), last: 0 };
  queues.set(key, q);
  const run = q.chain.then(async () => {
    const wait = q.last + gap - Date.now();
    if (wait > 0) await sleep(wait);
    try { return await fn(); } finally { q.last = Date.now(); }
  });
  q.chain = run.catch(() => {});
  return run;
}

// Une erreur due à une nouvelle recherche lancée entre-temps doit remonter, pas être masquée par un repli
const rethrowIfAborted = (e, signal) => { if (signal && signal.aborted) throw e; };

async function pool(tasks, n) {
  const out = []; let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < tasks.length) { const k = i++; out[k] = await tasks[k](); } }));
  return out;
}

// ---------- Adresses ----------
// Nominatim : 1 requête / seconde max
function nominatim(params, signal) {
  return throttled('nominatim', 1100, () =>
    getJSON(`${URLS.nominatim}/search?${new URLSearchParams({ format: 'jsonv2', 'accept-language': 'fr', ...params })}`, { signal }));
}

// Adresse tapée à la main : Photon (sans limite de débit, donc plusieurs à la fois), Nominatim en secours
const geoCache = new Map();
async function geocode(q, signal, bias) {
  if (geoCache.has(q)) return geoCache.get(q);
  let res = null;
  try {
    const [hit] = await photonSearch(q, bias, signal);
    if (hit) res = hit;
  } catch (e) { rethrowIfAborted(e, signal); }
  if (!res) {
    const [hit] = await nominatim({ q, limit: 1 }, signal);
    if (hit) res = { lat: +hit.lat, lon: +hit.lon, label: hit.display_name };
  }
  if (!res) throw new Error(`Adresse introuvable : « ${q} »`);
  geoCache.set(q, res);
  return res;
}

// Photon (komoot) pour l'autocomplétion : rapide, sans clé
function photonLabel(f) {
  const p = f.properties;
  const street = [p.housenumber, p.street].filter(Boolean).join(' ');
  const main = [...new Set([p.name, street].filter(Boolean))];
  const town = [p.postcode, p.city || p.county].filter(Boolean).join(' ');
  return [...main, town].filter(Boolean).join(', ');
}
async function photonSearch(q, bias, signal) {
  const params = new URLSearchParams({ q, limit: 6, lang: 'fr' });
  if (bias) { params.set('lat', bias.lat.toFixed(4)); params.set('lon', bias.lon.toFixed(4)); }
  const d = await getJSON(`${URLS.photon}/api/?${params}`, { signal, ms: 8000 });
  const seen = new Set();
  return d.features.map(f => ({ label: photonLabel(f), lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0] }))
    .filter(it => it.label && !seen.has(it.label) && seen.add(it.label));
}
async function photonReverse(lat, lon) {
  const d = await getJSON(`${URLS.photon}/reverse?lat=${lat}&lon=${lon}&lang=fr&limit=1`, { ms: 8000 });
  return d.features && d.features[0] ? photonLabel(d.features[0]) : null;
}

// ---------- Lieux ----------
// Overpass (plus complet) et Nominatim lancés ensemble : Overpass sature souvent, on n'attend pas qu'il échoue.
// Si Nominatim répond d'abord, Overpass a encore 2 s pour arriver.
async function placesInBox(kind, box, signal, onFallback) {
  const op = overpassPlaces(kind, box, signal);
  const nm = nominatimPlaces(kind, box, signal).catch(e => { rethrowIfAborted(e, signal); return null; });
  op.catch(() => {}); // évite une erreur « non gérée » si on ne l'attend plus
  const first = await Promise.race([op.then(r => ({ op: r }), () => ({})), nm.then(r => ({ nm: r }))]);
  if (first.op) return first.op;
  const late = await Promise.race([op.catch(() => null), sleep(2000).then(() => null)]);
  if (late) return late;
  if (signal && signal.aborted) throw new DOMException('Recherche annulée', 'AbortError');
  if (onFallback) onFallback();
  const n = await nm;
  if (n && n.length) return n;
  throw new Error('La recherche de lieux ne répond pas pour le moment (Overpass et Nominatim), réessaie dans une minute.');
}

async function overpassPlaces(kind, b, signal) {
  // « bb » plutôt que « center » : le centre s'en déduit, et la taille aussi (utile pour les parcs)
  const q = `[out:json][timeout:6];nwr${PLACES[kind].filter}["name"](${b.s},${b.w},${b.n},${b.e});out bb tags ${MAX_PLACES};`;
  // Tous les serveurs en parallèle, le premier qui répond gagne
  const d = await Promise.any(URLS.overpass.map(url =>
    getJSON(url, { method: 'POST', body: new URLSearchParams({ data: q }), ms: 6000, signal })));
  return d.elements.filter(e => e.lat != null || e.bounds).map(e => {
    const bx = e.bounds && { s: e.bounds.minlat, w: e.bounds.minlon, n: e.bounds.maxlat, e: e.bounds.maxlon };
    return {
      id: `${e.type}/${e.id}`, name: e.tags.name, tags: e.tags,
      lat: e.lat ?? (bx.s + bx.n) / 2, lon: e.lon ?? (bx.w + bx.e) / 2, area: bx ? boxArea(bx) : null,
    };
  });
}

async function nominatimPlaces(kind, b, signal) {
  const viewbox = [b.w, b.n, b.e, b.s].map(v => v.toFixed(5)).join(',');
  const seen = new Map();
  for (const q of PLACES[kind].words) {
    let hits;
    try { hits = await nominatim({ q, viewbox, bounded: 1, limit: 40, extratags: 1, addressdetails: 1 }, signal); }
    catch (e) { rethrowIfAborted(e, signal); continue; }
    for (const h of hits) {
      if (h.category !== PLACES[kind].cat || !PLACES[kind].types.includes(h.type) || !h.name) continue;
      const a = h.address || {};
      seen.set(`${h.osm_type}/${h.osm_id}`, {
        id: `${h.osm_type}/${h.osm_id}`, name: h.name, lat: +h.lat, lon: +h.lon,
        area: h.osm_type !== 'node' && h.boundingbox ? boxArea({ s: +h.boundingbox[0], n: +h.boundingbox[1], w: +h.boundingbox[2], e: +h.boundingbox[3] }) : null,
        tags: { ...h.extratags, [h.category]: h.type, 'addr:housenumber': a.house_number, 'addr:street': a.road, 'addr:postcode': a.postcode, 'addr:city': a.city || a.town || a.village },
      });
    }
  }
  return [...seen.values()];
}

// ---------- Trajets ----------
// Transitous sert tout : transports, et aussi marche et vélo (même moteur, donc comparaisons cohérentes en Auto).
// Il refuse (429) ou fait patienter au-delà de quelques requêtes simultanées : 3 à la fois au plus.
const sems = new Map();
function limited(key, max, fn) {
  const s = sems.get(key) || { active: 0, waiting: [] };
  sems.set(key, s);
  return new Promise((resolve, reject) => {
    const start = () => {
      s.active++;
      fn().then(resolve, reject).finally(() => { s.active--; const next = s.waiting.shift(); if (next) next(); });
    };
    if (s.active < max) start(); else s.waiting.push(start);
  });
}
const transitous = (path, opts) => limited('transitous', 3, () => getJSON(`${URLS.transitous}${path}`, opts));
const ll = p => `${p.lat.toFixed(6)};${p.lon.toFixed(6)}`;
const STREET_MODE = { walk: 'WALK', bike: 'BIKE' };

// Marche / vélo : durées [source][destination] (s). Transitous, puis OSRM (FOSSGIS) en secours ; null si aucun ne répond.
async function streetTable(profile, sources, dests, signal) {
  const rows = await Promise.all(sources.map(async from => {
    try {
      const d = await transitous(`/v1/one-to-many?one=${ll(from)}&many=${dests.map(ll).join(',')}&mode=${STREET_MODE[profile]}&max=7200&maxMatchingDistance=250&arriveBy=false`, { signal, ms: 15000 });
      return d.map(x => x.duration ?? null);
    } catch (e) { rethrowIfAborted(e, signal); return null; }
  }));
  if (rows.every(Boolean)) return rows;
  const osrm = await osrmTable(profile, sources, dests, signal);
  if (osrm) return osrm;
  return rows.some(Boolean) ? rows.map(r => r || dests.map(() => null)) : null;
}

// Marche / vélo depuis plusieurs points vers un seul (le retour vers « Après ») : durées (s) par point, null si rien ne répond
async function streetToOne(profile, one, many, signal) {
  try {
    const d = await transitous(`/v1/one-to-many?one=${ll(one)}&many=${many.map(ll).join(',')}&mode=${STREET_MODE[profile]}&max=7200&maxMatchingDistance=250&arriveBy=true`, { signal, ms: 15000 });
    return d.map(x => x.duration ?? null);
  } catch (e) { rethrowIfAborted(e, signal); }
  const osrm = await osrmTable(profile, many, [one], signal);
  return osrm ? osrm.map(r => r[0]) : null;
}

// Secours marche / vélo : serveur OSRM de FOSSGIS. Il refuse (429) les rafales : un appel par seconde.
async function osrmTable(profile, sources, dests, signal) {
  const coords = [...sources, ...dests].map(p => `${p.lon.toFixed(6)},${p.lat.toFixed(6)}`).join(';');
  const src = sources.map((_, i) => i).join(';');
  const dst = dests.map((_, i) => i + sources.length).join(';');
  try {
    const d = await throttled('osrm', 1000, () =>
      getJSON(`${URLS.osrm[profile]}/table/v1/driving/${coords}?sources=${src}&destinations=${dst}&annotations=duration`, { signal, ms: 10000 }));
    return d.code === 'Ok' ? d.durations : null;
  } catch (e) {
    rethrowIfAborted(e, signal);
    return null;
  }
}

// Tracé marche / vélo, demandé seulement quand on affiche le trajet : Transitous, puis OSRM, sinon ligne droite
const routeCache = new Map();
function streetRoute(profile, a, b) {
  const key = `${profile}|${a.lat},${a.lon}|${b.lat},${b.lon}`;
  if (!routeCache.has(key)) {
    routeCache.set(key, transitous(`/v1/plan?fromPlace=${a.lat},${a.lon}&toPlace=${b.lat},${b.lon}&directModes=${STREET_MODE[profile]}&transitModes=&maxDirectTime=7200`)
      .then(d => {
        const it = (d.direct || [])[0];
        if (!it) throw new Error('pas de trajet direct');
        return it.legs.flatMap(l => decodePolyline(l.legGeometry.points, l.legGeometry.precision));
      })
      .catch(() => throttled('osrm', 1000, () =>
        getJSON(`${URLS.osrm[profile]}/route/v1/driving/${a.lon},${a.lat};${b.lon},${b.lat}?overview=full&geometries=geojson`, { ms: 10000 }))
        .then(d => d.routes[0].geometry.coordinates.map(([x, y]) => [y, x])))
      .catch(() => { routeCache.delete(key); return [[a.lat, a.lon], [b.lat, b.lon]]; }));
  }
  return routeCache.get(key);
}

// Stations Vélib' et leur remplissage en temps réel (open data de la Ville de Paris) dans un rectangle ; null si indisponible
async function velibStations(b, signal) {
  const where = `in_bbox(coordonnees_geo,${b.s.toFixed(5)},${b.w.toFixed(5)},${b.n.toFixed(5)},${b.e.toFixed(5)})`;
  const select = 'name,stationcode,coordonnees_geo,numbikesavailable,numdocksavailable,ebike,is_renting,is_returning';
  try {
    const d = await getJSON(`${URLS.velib}/exports/json?${new URLSearchParams({ where, select })}`, { signal, ms: 10000 });
    return d.filter(s => s.coordonnees_geo).map(s => ({
      id: s.stationcode, name: s.name, lat: s.coordonnees_geo.lat, lon: s.coordonnees_geo.lon,
      bikes: s.numbikesavailable, docks: s.numdocksavailable, ebike: s.ebike,
      renting: s.is_renting === 'OUI', returning: s.is_returning === 'OUI',
    }));
  } catch (e) {
    rethrowIfAborted(e, signal);
    return null;
  }
}

// En fauteuil : cheminements accessibles (correspondances comprises) et pas de métro. Transitous ne sait pas écarter
// les trajets non accessibles dans ses matrices : sans le métro, l'estimation est proche ; l'itinéraire exact les écarte.
const wheelchairParams = wc => wc ? `&pedestrianProfile=WHEELCHAIR&useRoutedTransfers=true&transitModes=${WHEELCHAIR_TRANSIT}` : '';

// Transports, pour la grille et le classement : une seule requête par personne vers toutes les destinations.
// L'API ne sait faire que « plusieurs → un » à heure d'arrivée, ou « un → plusieurs » à heure de départ :
// - aller (arriveBy) : on calcule destinations → personne pour une arrivée à l'heure dite. Sens inverse, mais les temps
//   en transports sont quasi symétriques ; la durée va du départ au plus tard jusqu'à l'heure dite (attente comprise).
//   L'itinéraire exact (transitPlan), lui, est dans le bon sens.
// - retour (depart) : « Après » → destinations, au départ de l'heure dite. Même approximation, vérifiée au clic.
// → durées (s) ou null par destination ; que des null si le service ne répond pas.
// `wc` : personne en fauteuil (voir wheelchairParams). Au-delà de TRANSIT_MAX_MIN : null (bien plus rapide à calculer).
async function transitMatrix(one, dests, timeISO, signal, arriveBy = true, wc = false) {
  try {
    const d = await transitous(`/experimental/one-to-many-intermodal?one=${ll(one)}&many=${dests.map(ll).join(',')}&time=${encodeURIComponent(timeISO)}&arriveBy=${arriveBy}&maxTravelTime=${TRANSIT_MAX_MIN}${wheelchairParams(wc)}`, { ms: 30000, signal });
    // Plusieurs compromis durée / correspondances : on garde le meilleur en temps ressenti
    return d.transit_durations.map(opts => opts.length
      ? opts.map(o => ({ sec: o.duration, transfers: o.transfers || 0 })).reduce((a, b) => perceived(b) < perceived(a) ? b : a)
      : null);
  } catch (e) {
    rethrowIfAborted(e, signal);
    return dests.map(() => null);
  }
}

// Itinéraire détaillé (lignes + tracé), mis en cache.
// arriveBy : arriver à l'heure en partant le plus tard possible ; sinon (retour) arriver au plus tôt en partant à l'heure.
// Chaque correspondance compte pour TRANSFER_PENALTY : un trajet direct à peine plus long est préféré.
// `wc` : en fauteuil, seulement les itinéraires sans trajet marqué non accessible.
// → itinéraire, null s'il n'y en a aucun (plus de transports à cette heure), undefined si le service n'a pas répondu
const planCache = new Map();
function transitPlan(from, to, timeISO, arriveBy = true, wc = false) {
  const key = `${from.lat},${from.lon}|${to.lat},${to.lon}|${timeISO}|${arriveBy}|${wc}`;
  if (!planCache.has(key)) {
    planCache.set(key, transitous(`/v1/plan?fromPlace=${from.lat},${from.lon}&toPlace=${to.lat},${to.lon}&time=${encodeURIComponent(timeISO)}&arriveBy=${arriveBy}${wheelchairParams(wc)}`)
      .then(d => {
        const t = new Date(timeISO).getTime();
        const cost = it => (arriveBy ? t - new Date(it.startTime) : new Date(it.endTime) - t) / 1000 + TRANSFER_PENALTY * (it.transfers || 0);
        return (d.itineraries || []).filter(it => !wc || accessibleItin(it)).reduce((a, b) => !a || cost(b) < cost(a) ? b : a, null);
      })
      .catch(() => { planCache.delete(key); return undefined; }));
  }
  return planCache.get(key);
}

// ---------- Météo ----------
// Prévisions heure par heure d'Open-Meteo (sans clé), de l'arrivée jusqu'au départ du lieu ; null au-delà de 16 jours ou en panne
async function forecast(p, from, to, signal) {
  const hour = d => new Date(d).toISOString().slice(0, 13) + ':00';
  const params = new URLSearchParams({
    latitude: p.lat.toFixed(3), longitude: p.lon.toFixed(3), timezone: 'UTC', timeformat: 'unixtime',
    hourly: 'weather_code,precipitation_probability,precipitation,temperature_2m,is_day',
    start_hour: hour(from), end_hour: hour(to),
  });
  try {
    return (await getJSON(`${URLS.meteo}?${params}`, { signal, ms: 8000 })).hourly || null;
  } catch (e) {
    rethrowIfAborted(e, signal);
    return null;
  }
}
