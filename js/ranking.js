// Classement pur (ni DOM ni réseau), testé dans tests.html.

const isAuto = mode => MODE_GROUPS[0][1].includes(mode);

// Temps « ressenti » d'une option : durée + pénalité par correspondance (transports) + pénalité pluie (vélo, voir combine)
const perceived = o => o == null || o.sec == null ? Infinity : o.sec + TRANSFER_PENALTY * (o.transfers || 0) + (o.rain || 0);

// Modes à calculer pour une personne. En transports, la marche sert de repli si elle est plus rapide.
// En Auto, on écarte ce qui ne peut pas gagner d'après la distance au point central.
// En fauteuil : ni vélo ni Vélib' ; transports accessibles, et le trottoir (compté comme la marche) en repli.
function modesFor(p, center) {
  if (p.wheelchair) return p.mode === 'walk' ? ['walk'] : ['transit', 'walk'];
  if (p.mode === 'walk') return ['walk'];
  if (p.mode === 'bike') return ['bike'];
  if (p.mode === 'transit') return ['transit', 'walk'];
  if (p.mode === 'velib') return ['velib', 'walk'];
  const d = dist(p, center);
  const cycle = { auto: ['bike'], autovelib: ['velib'], nobike: [] }[p.mode];
  return [...(d <= WALK_MAX ? ['walk'] : []), ...cycle, ...(d >= TRANSIT_MIN ? ['transit'] : [])];
}

// times[mode][personne] = durées (s) vers chaque destination, absent si le mode n'a pas été calculé pour elle.
// Une durée peut aussi être un objet { sec, … } (Vélib' : stations et étapes), recopié tel quel.
// `wet(personne)` : pluie probable et choix du mode laissé à l'app (Auto) ; chaque minute à vélo compte alors
// RAIN_BIKE_FACTOR fois (champ `rain`, en secondes, ajouté au temps ressenti ; le temps affiché ne change pas).
// → legs[destination][personne] = { opts: { mode: { sec, … } }, via: mode le plus rapide, sec }
function combine(nPeople, nDest, times, wet = () => false) {
  return Array.from({ length: nDest }, (_, di) => Array.from({ length: nPeople }, (_, pi) => {
    const opts = {};
    for (const m of ['walk', 'bike', 'velib', 'transit']) {
      const row = times[m] && times[m][pi];
      if (!row) continue;
      const v = row[di];
      opts[m] = v != null && typeof v === 'object' ? { ...v } : { sec: v ?? null };
      const bikeSec = m === 'bike' ? opts[m].sec : m === 'velib' ? opts[m].bike : null;
      if (bikeSec != null && wet(pi)) opts[m].rain = Math.round((RAIN_BIKE_FACTOR - 1) * bikeSec);
    }
    const best = Object.entries(opts).filter(([, o]) => o.sec != null).sort((a, b) => perceived(a[1]) - perceived(b[1]))[0];
    const leg = { opts, via: best ? best[0] : undefined, sec: best ? best[1].sec : null, transfers: best ? best[1].transfers || 0 : 0 };
    if (best && best[1].rain) leg.rain = best[1].rain;
    return leg;
  }));
}

// Modes utiles pour le classement final : ceux qui, quelque part dans la zone, arrivent à moins de `marginOf(mode)` du plus rapide.
// Sert à ne pas recalculer un mode qui ne gagne nulle part (ex. la marche pour quelqu'un qui habite loin).
function usefulModes(p, gridLegs, mask, marginOf = () => FAIR_MARGIN) {
  const useful = p.modes.filter(m => gridLegs.some((legs, k) => {
    const l = legs[p.i], o = l.opts[m];
    return mask[k] && o && o.sec != null && perceived(o) - perceived(l) <= marginOf(m);
  }));
  return useful.length ? useful : p.modes;
}

// Itinéraire faisable en fauteuil : aucun trajet marqué non accessible (Transitous, d'après les données des réseaux)
const accessibleItin = it => it.legs.every(l => l.wheelchairAccessible !== 'NOT_ACCESSIBLE');

// ---------- Vélib' ----------
// Par prudence : au moins 2 vélos au départ (il y en a souvent un en panne), 2 places à l'arrivée
const canRent = s => s.renting && s.bikes >= VELIB_MIN_BIKES;
const canReturn = s => s.returning && s.docks >= VELIB_MIN_DOCKS;
function nearestStation(stations, p, ok, maxDist = VELIB_MAX_WALK) {
  let best = null, bd = maxDist;
  for (const s of stations) {
    if (!ok(s)) continue;
    const d = dist(p, s);
    if (d <= bd) { bd = d; best = s; }
  }
  return best;
}
// Trajet Vélib' : marche → station de départ → vélo → station d'arrivée → marche, plus prendre et reposer le vélo
function velibParts(p, start, end, dest, bikeSec) {
  if (!start || !end || start === end || bikeSec == null) return null;
  const walkIn = dist(p, start) / WALK_STRAIGHT_SPEED, walkOut = dist(end, dest) / WALK_STRAIGHT_SPEED;
  return { sec: walkIn + VELIB_OVERHEAD + bikeSec + walkOut, walkIn, bike: bikeSec, walkOut, start, end };
}

// Trajet complet d'une personne vers une destination : l'aller, plus le retour vers « Après » si elle en a un.
// Avec son vélo perso, elle repart forcément à vélo ; sinon on prend le plus rapide de chaque côté, sans vélo perso.
// `back` : le leg retour (même forme qu'un leg aller) ou null. `maxMin` : trajet aller max de la personne ;
// `slack` : minutes de plus qu'elle accepte de faire par rapport aux autres.
// → { via, sec (aller), transfers, rain, back: { via, sec, … } | null, total (réel), cost (ressenti, pour classer), over: trajet max dépassé, slack (s) }
function tripOf(p, leg, back) {
  const best = (opts, ok) => Object.entries(opts).filter(([m, o]) => ok(m) && o.sec != null).sort((a, b) => perceived(a[1]) - perceived(b[1]))[0];
  let via = leg.via, sec = leg.sec, transfers = leg.transfers || 0, rain = leg.rain || 0, ret = null, total = leg.sec, cost = perceived(leg);
  if (back) {
    const combos = [];
    if (leg.opts.bike && leg.opts.bike.sec != null && back.opts.bike && back.opts.bike.sec != null)
      combos.push({ a: ['bike', leg.opts.bike], r: ['bike', back.opts.bike] });
    const a = best(leg.opts, m => m !== 'bike'), r = best(back.opts, m => m !== 'bike');
    if (a && r) combos.push({ a, r });
    const c = combos.sort((x, y) => (perceived(x.a[1]) + perceived(x.r[1])) - (perceived(y.a[1]) + perceived(y.r[1])))[0];
    if (c) {
      via = c.a[0]; sec = c.a[1].sec; transfers = c.a[1].transfers || 0; rain = c.a[1].rain || 0;
      ret = { via: c.r[0], ...c.r[1] };
      total = sec + ret.sec; cost = perceived(c.a[1]) + perceived(ret);
    } else ({ via, sec, transfers, rain, ret, total, cost } = { via: undefined, sec: null, transfers: 0, rain: 0, ret: null, total: null, cost: Infinity });
  }
  const over = p.maxMin != null && sec != null && sec > p.maxMin * 60;
  return { via, sec, transfers, rain, back: ret, total, cost, over, slack: (p.slack || 0) * 60 };
}

// Heure de départ du lieu : « HH:MM » saisi le jour de l'arrivée (le lendemain si c'est avant l'arrivée),
// sinon l'arrivée + le temps sur place habituel pour ce type de lieu
function backDate(arrive, hm, kind) {
  if (!/^\d\d:\d\d$/.test(hm || '')) return new Date(arrive.getTime() + PLACES[kind].stay * 60e3);
  const d = new Date(arrive);
  d.setHours(+hm.slice(0, 2), +hm.slice(3), 0, 0);
  if (d <= arrive) d.setDate(d.getDate() + 1);
  return d;
}

// Itinéraires exacts à demander en tâche de fond (Transitous n'en sert qu'un toutes les 3 s environ passé les 10 premiers) :
// les allers en transports encore estimés des fiches, dans l'ordre des fiches, puis les retours de la 1re fiche.
// Les retours des autres fiches sont calculés quand on ouvre la fiche. `top` : [{ di }], legs[di][personne].
// → [{ di, pi, back }]
function refineOrder(top, people, legs) {
  const go = [], back = [];
  top.forEach((r, k) => people.forEach(p => {
    const l = legs[r.di][p.i], b = l.back;
    if (l.via === 'transit' && l.exact == null) go.push({ di: r.di, pi: p.i, back: false });
    if (k === 0 && b && b.via === 'transit' && b.exact == null && !b.none) back.push({ di: r.di, pi: p.i, back: true });
  }));
  return [...go, ...back];
}

// Temps qui compte pour une personne : aller (+ retour) ressenti, moins ce qu'elle accepte de faire en plus,
// infini si impossible ou au-delà de son trajet max
const costOf = l => l.over ? Infinity : (l.cost ?? l.total ?? l.sec ?? Infinity) - (l.slack || 0);

// Temps affiché d'une personne : aller (+ retour), en prenant les durées exactes quand on les a
const shownCost = l => l.sec == null ? Infinity : (l.exact ?? l.sec) + (l.back ? (l.back.none ? Infinity : l.back.exact ?? l.back.sec) : 0);

// Score d'une destination : le trajet le plus long (équité), puis la somme. `min` sert à afficher l'écart.
function scoreOf(legsAtDest) {
  const secs = legsAtDest.map(costOf);
  return { max: Math.max(...secs), min: Math.min(...secs), sum: secs.reduce((a, b) => a + b, 0) };
}

// Trajets max impossibles à tenir partout : au point le plus équitable sans ces limites, le temps de ceux qui la dépassent.
// → [{ p, min }] (minutes, arrondies aux 5 du dessus) ; vide si, même sans limite, aucun point n'est joignable par tous
function neededMax(gridLegs, people) {
  const free = gridLegs.map(ls => Math.max(...ls.map(l => costOf({ ...l, over: false }))));
  const best = Math.min(...free);
  if (!isFinite(best)) return [];
  const ls = gridLegs[free.indexOf(best)];
  return people.filter(p => ls[p.i].over).map(p => ({ p, min: Math.ceil(ls[p.i].sec / 300) * 5 }));
}

// Zone équitable : les points dont le trajet le plus long dépasse le meilleur de `margin` au plus
function fairZone(maxes, margin = FAIR_MARGIN) {
  const best = Math.min(...maxes), limit = best + margin;
  return { best, limit, mask: maxes.map(m => isFinite(m) && m <= limit) };
}

// « cuisine=yes » (fréquent dans OSM) ne dit rien : ignoré
const cuisinesOf = tags => (tags.cuisine || '').split(';').map(s => s.trim().toLowerCase()).filter(c => c && c !== 'yes' && c !== 'no');
const cuisineLabel = c => CUISINES[c] || c.replaceAll('_', ' ');

// Départage à score égal : fiche bien renseignée en plus, chaîne en moins ; pour un parc, la taille. Ce n'est pas une note.
function quality(place) {
  const t = place.tags, a = place.area;
  const size = t.leisure !== 'park' || a == null ? 0 : a < PARK_TINY ? -1 : a >= 5e4 ? 2 : a >= 1e4 ? 1 : 0;
  return (t.website || t['contact:website'] ? 1 : 0) + (t.cuisine ? 1 : 0) + (place.hours && place.hours.status === 'open' ? 1 : 0) - (t.brand ? 1 : 0) + size;
}

// Parcs : les squares minuscules (un banc, trois arbres) sont écartés s'il reste assez d'autres parcs
function dropTinyParks(places, min = MIN_PLACES) {
  const big = places.filter(p => !(p.tags.leisure === 'park' && p.area != null && p.area < PARK_TINY));
  return big.length >= min ? big : places;
}

// Quelqu'un en fauteuil : « ♿ Accessible » n'est coché d'office que s'il laisse assez de choix
// (peu de lieux sont renseignés dans OSM) ; sinon on écarte seulement ceux notés non accessibles
const enoughAccessible = (places, n = N_SHOWN) => places.filter(p => p.tags.wheelchair === 'yes').length >= n;

// f = { openOnly, terrace, veggie, wheelchair, noInaccessible, cuisines: Set }
function passesFilters(place, f) {
  const t = place.tags;
  if (f.noInaccessible && t.wheelchair === 'no') return false;
  if (f.openOnly && place.hours && place.hours.status === 'closed') return false;
  if (f.terrace && t.outdoor_seating !== 'yes') return false;
  if (f.veggie && !['yes', 'only'].includes(t['diet:vegetarian']) && !['yes', 'only'].includes(t['diet:vegan'])) return false;
  if (f.wheelchair && t.wheelchair !== 'yes') return false; // « limited » : marche ou porte étroite, on ne promet rien
  if (f.cuisines && f.cuisines.size && !cuisinesOf(t).some(c => f.cuisines.has(c))) return false;
  return true;
}

// Même lieu en double dans OSM (un point et un contour, ou une station par ligne de métro) : même nom à moins de `radius` m.
// On garde le premier.
function dedupeByName(places, radius = 300) {
  const kept = [];
  for (const p of places) {
    const name = p.name.trim().toLowerCase();
    if (!kept.some(q => q.name.trim().toLowerCase() === name && dist(p, q) < radius)) kept.push(p);
  }
  return kept;
}

// Le lieu d'un lien partagé parmi ceux trouvés : même identifiant OSM, ou même nom tout près
// (le dédoublonnage a pu garder le contour plutôt que le point)
function findPlace(places, want, radius = 300) {
  const name = want.name.trim().toLowerCase();
  return places.find(p => p.id === want.id) || places.find(p => p.name.trim().toLowerCase() === name && dist(p, want) < radius);
}

// Sélection gloutonne dans une liste déjà triée : écart minimal entre lieux et plafond par cuisine principale,
// puis on complète sans contrainte s'il en manque. `place` donne le lieu d'un élément.
function pickDiverse(sorted, n, { minGap = 0, maxSame = Infinity, place = x => x } = {}) {
  const picked = [], count = new Map();
  for (const it of sorted) {
    if (picked.length >= n) break;
    const p = place(it), c = cuisinesOf(p.tags)[0];
    if (c && (count.get(c) || 0) >= maxSame) continue;
    if (picked.some(q => dist(place(q), p) < minGap)) continue;
    picked.push(it);
    if (c) count.set(c, (count.get(c) || 0) + 1);
  }
  for (const it of sorted) {
    if (picked.length >= n) break;
    if (!picked.includes(it)) picked.push(it);
  }
  return picked;
}

// Classement final : trajet le plus long (à la minute près), puis fiche la mieux renseignée, puis somme des trajets
function compareRanked(a, b) {
  const d = Math.round(a.score.max / 60) - Math.round(b.score.max / 60);
  return (isNaN(d) ? 0 : d) || b.q - a.q || a.score.sum - b.score.sum;
}
