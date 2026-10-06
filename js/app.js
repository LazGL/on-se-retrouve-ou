// Orchestration : recherche en deux temps (zone équitable, puis lieux), filtres, trajets sur la carte.

// État de la dernière recherche. Les jetons écartent les réponses d'une recherche, d'un classement ou d'un clic dépassés.
// `link` : lieu choisi reçu dans un lien partagé (comparé et ouvert tant que la recherche est celle du lien) ;
// `selDi` : destination ouverte dans le panneau.
const S = { runToken: 0, rankToken: 0, selToken: 0, ctrl: null, pool: null, link: null, linked: null, selDi: 0 };

// Vélib' vers chaque destination : station avec des vélos la plus proche de la personne, station avec des places
// la plus proche de la destination, et un seul calcul vélo entre les deux par personne.
// → par personne : étapes (velibParts) ou null par destination ; null si le calcul vélo n'a pas répondu
async function velibTable(riders, dests, stations, signal) {
  if (!stations) return riders.map(() => null);
  const ends = dests.map(d => nearestStation(stations, d, canReturn));
  const targets = [...new Set(ends.filter(Boolean))];
  return Promise.all(riders.map(async p => {
    const start = nearestStation(stations, p, canRent);
    if (!start || !targets.length) return dests.map(() => null);
    const bike = await streetTable('bike', [start], targets, signal);
    if (!bike) return null;
    return dests.map((d, k) => velibParts(p, start, ends[k], d, ends[k] ? bike[0][targets.indexOf(ends[k])] : null));
  }));
}

// Vélib' au retour, de chaque destination vers « Après » : station avec des vélos la plus proche de la destination,
// station avec des places la plus proche de « Après ». → étapes ou null par destination ; null si le calcul n'a pas répondu
async function velibBackRow(p, dests, stations, signal) {
  if (!stations) return null;
  const end = nearestStation(stations, p.after, canReturn);
  const starts = dests.map(d => nearestStation(stations, d, canRent));
  const uniq = [...new Set(starts.filter(Boolean))];
  if (!end || !uniq.length) return dests.map(() => null);
  const bike = await streetToOne('bike', end, uniq, signal);
  if (!bike) return null;
  return dests.map((d, k) => velibParts(d, starts[k], end, p.after, starts[k] ? bike[uniq.indexOf(starts[k])] : null));
}

// Retour d'une personne depuis chaque destination vers « Après », au départ de p.backAt → durées par mode
async function backTimes(p, dests, modes, stations, signal) {
  const [walk, bike, velib, transit] = await Promise.all([
    modes.includes('walk') ? streetToOne('walk', p.after, dests, signal) : null,
    modes.includes('bike') ? streetToOne('bike', p.after, dests, signal) : null,
    modes.includes('velib') ? velibBackRow(p, dests, stations, signal) : null,
    modes.includes('transit') ? transitMatrix(p.after, dests, p.backAt.toISOString(), signal, false, p.wheelchair) : null,
  ]);
  return { walk, bike, velib, transit };
}

// Durées vers `dests` pour chaque personne selon ses modes (`modesOf`), retour vers « Après » compris.
// `wet` : pluie probable (le vélo compte plus pour ceux en mode Auto). Un service en panne n'arrête pas la recherche.
// → { legs: legs[destination][personne], notes: ce qui n'a pas pu être calculé }
async function computeTimes(people, dests, arrive, signal, modesOf = p => p.modes, stations = null, wet = false) {
  const backers = people.filter(p => p.after);
  const backJob = Promise.all(backers.map(p => backTimes(p, dests, p.backModes, stations, signal)));
  const by = m => people.filter(p => modesOf(p).includes(m));
  const walkers = by('walk'), bikers = by('bike'), velibers = by('velib'), riders = by('transit');
  const iso = arrive.toISOString();
  const [W, B, V, T] = await Promise.all([
    walkers.length ? streetTable('walk', walkers, dests, signal) : [],
    bikers.length ? streetTable('bike', bikers, dests, signal) : [],
    velibTable(velibers, dests, stations, signal),
    Promise.all(riders.map(p => transitMatrix(p, dests, iso, signal, true, p.wheelchair))), // la file de Transitous limite le nombre en parallèle
  ]);
  const times = { walk: [], bike: [], velib: [], transit: [] }, notes = [];
  if (W) walkers.forEach((p, k) => { times.walk[p.i] = W[k]; }); else notes.push('marche indisponible (serveurs saturés)');
  if (B) bikers.forEach((p, k) => { times.bike[p.i] = B[k]; }); else notes.push('vélo indisponible (serveurs saturés)');
  velibers.forEach((p, k) => {
    if (!V[k]) return notes.push(stations ? "Vélib' indisponible (calcul vélo saturé)" : "Vélib' indisponible (stations non chargées)");
    times.velib[p.i] = V[k];
    if (V[k].every(v => v == null)) notes.push(`Vélib' impossible pour ${label(p)} (pas de station avec vélos ou places à moins de ${VELIB_MAX_WALK} m)`);
  });
  riders.forEach((p, k) => {
    times.transit[p.i] = T[k];
    if (T[k].every(t => t == null)) notes.push(`transports indisponibles pour ${label(p)} (Transitous ne répond pas)`);
  });
  const wetOf = pi => wet && isAuto(people[pi].mode);
  const legs = combine(people.length, dests.length, times, wetOf);

  // Retours : un leg retour par destination, puis le trajet complet (aller + retour, trajet max) de chaque personne
  const back = { walk: [], bike: [], velib: [], transit: [] };
  (await backJob).forEach((rows, k) => { for (const m in rows) if (rows[m]) back[m][backers[k].i] = rows[m]; });
  const backLegs = combine(people.length, dests.length, back, wetOf);
  const noBack = new Set(backers.filter(p => !backLegs.some(ls => ls[p.i].via)).map(p => p.i));
  noBack.forEach(i => notes.push(`retour de ${label(people[i])} impossible à calculer, compté sans`));
  legs.forEach((ls, di) => ls.forEach((l, pi) => {
    const p = people[pi];
    Object.assign(l, tripOf(p, l, p.after && !noBack.has(pi) ? backLegs[di][pi] : null));
  }));
  return { legs, notes };
}

async function run() {
  const people = readPeople();
  if (people.some(p => !p.q)) return status('Remplis toutes les adresses.', true);
  const kind = $('kind').value, arrive = new Date($('when').value);
  if (isNaN(arrive)) return status("Choisis une heure d'arrivée.", true);

  if (S.ctrl) S.ctrl.abort(); // une nouvelle recherche annule la précédente
  const ctrl = S.ctrl = new AbortController(), signal = ctrl.signal, token = ++S.runToken;
  S.rankToken++; S.selToken++; S.selDi = 0;
  setBusy(true);
  $('results').innerHTML = '';
  $('refining').hidden = true;
  showWeather(null);
  try {
    const toFind = people.filter(p => p.lat == null);
    const afterToFind = people.filter(p => p.after && p.after.lat == null);
    if (toFind.length + afterToFind.length) status('Recherche des adresses…');
    await Promise.all([
      ...toFind.map(async p => {
        const g = await geocode(p.q, signal, biasPoint(p.row));
        Object.assign(p, { lat: g.lat, lon: g.lon });
        setCoords(p.row, g, p.q);
        p.row.querySelector('.resolved').textContent = g.label;
      }),
      ...afterToFind.map(async p => {
        const g = await geocode(p.after.q, signal, biasPoint(p.row));
        Object.assign(p.after, { lat: g.lat, lon: g.lon });
        setCoords(p.row.querySelector('.after-wrap'), g, p.after.q);
      }),
    ]);
    people.forEach(p => { if (p.after) p.backAt = backDate(arrive, p.backTime, kind); });

    // 1. Grille : où le plus long trajet est-il le plus court ? Elle couvre les départs et, pour qui repart ailleurs,
    // le milieu du chemin vers « Après » (le bon endroit est souvent entre les deux).
    const centroid = list => ({ lat: list.reduce((s, p) => s + p.lat, 0) / list.length, lon: list.reduce((s, p) => s + p.lon, 0) / list.length });
    const mid = centroid(people); // milieu des départs : sert aux seuils du mode Auto
    const stay = PLACES[kind].stay, wxJob = forecast(mid, arrive, new Date(arrive.getTime() + stay * 60e3), signal);
    wxJob.catch(() => {}); // attendue plus loin : pas d'erreur « non gérée » si la recherche est annulée avant
    const pts = [...people, ...people.filter(p => p.after).map(p => centroid([p, p.after]))];
    const gridCenter = centroid(pts);
    save(people, mid);
    saveRecent(kind, people);
    const spread = Math.max(...pts.map(p => dist(p, gridCenter)));
    const grid = makeGrid(gridCenter, Math.max(GRID_SPREAD * spread, GRID_MIN_HALF));
    people.forEach(p => {
      p.modes = modesFor(p, mid);
      if (!p.after) return;
      // Au retour, les seuils de distance se jugent depuis « Après » ; vélo perso à l'aller = vélo perso au retour
      p.backModes = modesFor({ ...p.after, mode: p.mode, wheelchair: p.wheelchair }, mid);
      if (p.modes.includes('bike') && !p.backModes.includes('bike')) p.backModes.push('bike');
    });
    // Stations Vélib' de toute la zone, chargées une fois (remplissage actuel)
    const velibUsed = people.some(p => p.modes.includes('velib') || (p.backModes || []).includes('velib'));
    const afters = people.filter(p => p.after).map(p => p.after);
    // La météo est attendue ici (3 s au plus, en même temps que les stations) : par pluie probable, le vélo compte plus
    const [stations, wxEarly] = await Promise.all([
      velibUsed ? velibStations(bbox([...people, ...afters, ...grid.points], VELIB_MAX_WALK + 200), signal) : null,
      Promise.race([wxJob, sleep(3000).then(() => null)]).catch(() => null),
    ]);
    const wet = !!wxEarly && (weatherAt(wxEarly, arrive, stay) || {}).level === 'wet';
    status(`Calcul de la zone équitable (temps de trajet vers ${grid.points.length} points)…`);
    const g = await computeTimes(people, grid.points, arrive, signal, p => p.modes, stations, wet);
    const maxes = g.legs.map(l => scoreOf(l).max);
    const zone = fairZone(maxes);
    if (!isFinite(zone.best)) {
      const strict = people.filter(p => p.maxMin != null), need = neededMax(g.legs, people);
      throw new Error(strict.length
        ? `Aucun endroit ne respecte les trajets max (${strict.map(p => `${label(p)} ${p.maxMin} min`).join(', ')}) : `
          + (need.length ? `au point le plus équitable, il faudrait ${need.map(({ p, min }) => `${min} min pour ${label(p)}`).join(', ')}.` : 'augmente-les un peu.')
        : 'Aucun trajet trouvé : les services de calcul ne répondent pas, réessaie dans un instant.');
    }
    ensureMap();
    drawZone(grid, maxes, zone);
    fitTo(L.latLngBounds(grid.points.map(pt => [pt.lat, pt.lon])), { padding: [10, 10] });

    // 2. Lieux au cœur de la zone équitable. Le « point équitable » (vue par défaut) est le meilleur point de la grille.
    const bestK = maxes.indexOf(zone.best), bestPt = grid.points[bestK];
    const center = { id: 'center', name: 'Point le plus équitable', lat: bestPt.lat, lon: bestPt.lon };
    const core = fairZone(maxes, CORE_MARGIN);
    let box = bbox(grid.points.filter((_, k) => core.mask[k]), grid.stepM / 2 + 100);
    if (boxHalf(box) > BOX_MAX_HALF) box = boxAround(bestPt, BOX_MAX_HALF);
    status('Recherche de lieux dans la zone équitable…');
    const fallback = () => status('Overpass ne répond pas, recherche des lieux via Nominatim…');
    let places = await placesInBox(kind, box, signal, fallback);
    if (places.length < MIN_PLACES) places = await placesInBox(kind, growBox(box, 1.6), signal, fallback);
    if (!places.length) throw new Error('Aucun lieu trouvé dans la zone.');
    places = dropTinyParks(dedupeByName(places));
    // Lieu d'un lien partagé (même recherche que le lien) : retrouvé parmi les lieux trouvés, sinon ajouté sans ses détails OSM
    const link = linkApplies(S.link, kind, people) ? S.link : null;
    let linked = link && findPlace(places, link);
    if (link && !linked) places.push(linked = { id: link.id, name: link.name, lat: link.lat, lon: link.lon, tags: {} });
    // Modes recalculés pour le classement final. L'estimation transports compte l'attente sur place : marge plus large.
    people.forEach(p => {
      p.rankModes = usefulModes(p, g.legs, zone.mask, m => m === 'transit' ? 2 * FAIR_MARGIN : FAIR_MARGIN);
    });
    for (const pl of places) {
      pl.est = interpolate(grid, maxes, pl);
      pl.hours = hoursAt(pl.tags.opening_hours, arrive, pl);
      pl.q = quality(pl);
    }

    const notes = [];
    people.forEach(p => {
      if (p.maxMin != null) notes.push(`${label(p)} : ${p.maxMin} min de trajet max`);
      if (p.slack) notes.push(`${label(p)} veut bien faire ${p.slack} min de plus`);
      if (p.after) notes.push(`retour de ${label(p)} compté (départ vers ${hhmm(p.backAt)})`);
      // Ses trajets accessibles sont souvent les plus longs : la zone se rapproche d'elle, on le dit
      if (p.wheelchair) notes.push(`${label(p)} en fauteuil : transports sans métro, itinéraires accessibles seulement (ses trajets sont souvent plus longs, la zone se rapproche d'elle)`);
    });
    people.filter(p => isAuto(p.mode)).forEach(p => {
      if (!p.modes.includes('walk')) notes.push(`marche non calculée pour ${label(p)} (trop loin)`);
      if (!p.modes.includes('transit')) notes.push(`transports non calculés pour ${label(p)} (trop près)`);
    });
    people.forEach(p => p.modes.filter(m => !p.rankModes.includes(m)).forEach(m =>
      notes.push(`pas de ${MODE_NAMES[m]} pour ${label(p)} au classement final (jamais compétitif dans la zone)`)));
    if (wet && people.some(p => isAuto(p.mode))) notes.push(`pluie probable : en mode Auto, une minute à vélo compte pour ${String(RAIN_BIKE_FACTOR).replace('.', ',')}`);
    notes.push(...g.notes);
    if (!hoursLibReady()) notes.push('horaires non vérifiés (bibliothèque non chargée)');

    const weather = weatherAt(await wxJob, arrive, stay);
    Object.assign(S, { people, center, grid, maxes, zone, arrive, kind, stations, weather, wet, pool: places, notes, centerLegs: g.legs[bestK], linked: linked || null });
    showWeather(weather, arrive, kind);
    // Quelqu'un en fauteuil : lieux accessibles seulement s'il y en a assez (la case reste décochable).
    // Cochée d'office pour une recherche, elle est décochée à la suivante s'il n'y a plus personne en fauteuil.
    const wcBox = $('f-wheelchair');
    if (people.some(p => p.wheelchair)) {
      const n = places.filter(p => p.tags.wheelchair === 'yes').length;
      if (enoughAccessible(places)) { if (!wcBox.checked) wcBox.checked = S.wcAuto = true; }
      else if (!wcBox.checked) {
        const all = places.length, few = n === 0 ? `aucun des ${all} lieux n'est noté ♿ accessible`
          : n === 1 ? `seul 1 lieu sur ${all} est noté ♿ accessible` : `seuls ${n} lieux sur ${all} sont notés ♿ accessibles`;
        notes.push(`${few} dans OpenStreetMap : ${n ? `coche « ♿ Accessible » pour ne garder ${n > 1 ? 'qu\'eux' : 'que lui'}` : 'vérifie l\'accès avant de choisir'} (ceux notés non accessibles sont écartés)`);
      }
    } else if (S.wcAuto) wcBox.checked = S.wcAuto = false;
    buildFilters(places, kind, rerank);
    await rerank();
  } catch (e) {
    if (token === S.runToken && !signal.aborted) status(e.message || String(e), true);
  } finally {
    if (token === S.runToken) setBusy(false);
  }
}

// 3. Filtres → 15 candidats variés → temps exacts → top 5. Relancé seul quand un filtre change (la grille est gardée).
async function rerank() {
  if (!S.pool) return;
  const token = ++S.rankToken, signal = S.ctrl.signal;
  $('refining').hidden = true;
  const f = readFilters();
  const eligible = S.pool.filter(p => passesFilters(p, f)).sort((a, b) => a.est - b.est || b.q - a.q);
  if (!eligible.length) {
    $('results').innerHTML = '';
    if (routeLayer) routeLayer.clearLayers();
    return status(f.openOnly
      ? 'Aucun lieu ne correspond dans la zone : retire un filtre, ou décoche « Ouvert seulement ».'
      : 'Aucun lieu ne correspond aux filtres dans la zone.', true);
  }
  const sameCuisine = f.cuisines.size ? Infinity : undefined;
  const cands = pickDiverse(eligible, N_CANDIDATES, { minGap: MIN_GAP, maxSame: sameCuisine ?? MAX_SAME_CUISINE.candidates });
  // Le lieu du lien partagé est toujours comparé, même si un filtre l'écarte
  if (S.linked && !cands.includes(S.linked)) cands.push(S.linked);
  setBusy(true);
  status(`Calcul des temps exacts vers ${cands.length} lieux…`);
  try {
    const { legs, notes } = await computeTimes(S.people, cands, S.arrive, signal, p => p.rankModes, S.stations, S.wet);
    if (token !== S.rankToken) return;
    const allNotes = [...new Set([...S.notes, ...notes])];
    // Écartés : lieux hors trajet max de quelqu'un, ou sans trajet possible (retour de nuit sans transports…)
    const ranked = cands.map((c, k) => ({ di: k + 1, c, score: scoreOf(legs[k]), q: c.q })).filter(r => isFinite(r.score.max)).sort(compareRanked);
    if (!ranked.length) {
      $('results').innerHTML = '';
      const need = neededMax(legs, S.people); // comme pour la grille : combien il faudrait au meilleur des lieux comparés
      return status('Aucun des lieux comparés ne respecte les contraintes (trajet max, retour possible) : '
        + (need.length ? `au meilleur d'entre eux, il faudrait ${need.map(({ p, min }) => `${min} min pour ${label(p)}`).join(', ')}.` : 'assouplis-les ou retire un filtre.'), true);
    }
    const top = pickDiverse(ranked, N_SHOWN, { maxSame: sameCuisine ?? MAX_SAME_CUISINE.shown, place: r => r.c });
    // Le lieu du lien partagé reste dans la liste (à la place du dernier s'il le faut)
    const linkedR = S.linked && ranked.find(r => r.c === S.linked);
    if (linkedR && !top.includes(linkedR)) top.splice(N_SHOWN - 1, 1, linkedR);
    top.sort(compareRanked);
    Object.assign(S, { dests: [S.center, ...cands], legs: [S.centerLegs, ...legs], top });
    renderResults(select);
    drawPins(S, select);
    const flex = S.people.some(p => p.slack) ? ' (minutes « veut bien faire » déduites)' : '';
    status(`Zone équitable (en vert) : au mieux, personne n'a plus de ${fmt(S.zone.best)} de trajet${flex} ; la zone va jusqu'à ${fmt(S.zone.limit)}. `
      + `${S.pool.length} lieux au cœur de la zone, ${eligible.length} après filtres, ${cands.length} comparés en détail`
      + (ranked.length < cands.length ? ` (${cands.length - ranked.length} écartés par les contraintes)` : '') + `, les ${top.length} meilleurs ci-dessous.`
      + (allNotes.length ? ` ${allNotes.join(' · ')}.` : '')
      + (S.linked && !linkedR ? ` Le lieu du lien (${S.linked.name}) ne respecte pas les contraintes : ses trajets sont sur la carte, pas dans la liste.` : ''));
    select(S.linked ? cands.indexOf(S.linked) + 1 : 0);
    refineTransit(token);
  } catch (e) {
    if (token === S.rankToken && !signal.aborted) status(e.message || String(e), true);
  } finally {
    if (token === S.rankToken) setBusy(false);
  }
}

// Retour exact en transports : départ à p.backAt ; `exact` compte l'attente jusqu'au départ (c'est l'heure d'arrivée qui importe).
// Plus aucun transport à cette heure : `none`.
async function backPlan(p, l, dest) {
  const b = l.back;
  if (!b || b.via !== 'transit' || b.exact != null || b.none) return b && b.itin;
  const it = await transitPlan(dest, p.after, p.backAt.toISOString(), false, p.wheelchair);
  if (it === null) b.none = true;
  else if (it) Object.assign(b, { itin: it, exact: (new Date(it.endTime) - p.backAt) / 1000, transfers: it.transfers || 0 });
  return it;
}

// Remplace en tâche de fond les estimations transports des fiches par l'itinéraire exact (ordre : voir refineOrder) :
// allers des 5 fiches, puis retours de la 1re ; les retours des autres fiches se calculent quand on ouvre la fiche.
// Une ligne sous l'état le signale jusqu'à la fin, pour qu'on ne copie pas le récap trop tôt.
async function refineTransit(token) {
  const iso = S.arrive.toISOString(), dests = new Map(S.top.map(r => [r.di, r.c]));
  const jobs = refineOrder(S.top, S.people, S.legs).map(({ di, pi, back }) => async () => {
    if (token !== S.rankToken) return;
    const p = S.people[pi], l = S.legs[di][pi], dest = dests.get(di);
    if (back) await backPlan(p, l, dest);
    else {
      const it = await transitPlan(p, dest, iso, true, p.wheelchair);
      if (it && token === S.rankToken) Object.assign(l, { itin: it, exact: it.duration, transfers: it.transfers || 0 });
    }
    if (token === S.rankToken) updateCard(di);
  });
  const el = $('refining'), t0 = Date.now();
  let done = 0;
  // Gros groupe avec retours : des dizaines d'itinéraires (2 à la fois, pour ménager Transitous) ; on dit combien de temps encore
  const progress = () => {
    const left = remainingText(done, jobs.length, Date.now() - t0);
    el.textContent = `⏳ Affinage des temps en transports (itinéraires exacts) : ${done}/${jobs.length}${left ? `, encore ${left}` : ''}… attends la fin pour copier le récap.`;
    el.hidden = false;
  };
  if (jobs.length) progress();
  await pool(jobs.map(job => async () => {
    try { await job(); } catch { /* un itinéraire manquant garde son estimation */ }
    done++;
    if (token === S.rankToken) progress();
  }), 2);
  if (token === S.rankToken) el.hidden = true;
}

// Trajets de chaque personne vers la destination `di` (0 = point central), sur la carte et dans le panneau
async function select(di) {
  const token = ++S.selToken;
  S.selDi = di;
  const { people, dests, legs, arrive } = S, dest = dests[di];
  document.querySelectorAll('.res').forEach(el => el.classList.toggle('sel', +el.dataset.di === di));
  // Le récap attend les itinéraires : son bouton n'apparaît qu'une fois le panneau rempli
  const head = ready => `<div class="head"><span>Trajets vers <b>${esc(dest.name)}</b></span><span class="acts">`
    + (ready ? `<button id="recap" type="button" title="Texte prêt à coller dans la conversation du groupe">📋 ${di ? 'Copier le rendez-vous' : 'Copier les choix'}</button>` : '')
    + (ready && di ? '<button id="ics" type="button" title="Ajouter le rendez-vous à ton agenda (fichier .ics)">📅 Agenda</button>'
      + '<button id="sellink" type="button" title="Lien qui ouvre ce lieu, avec les trajets de chacun">🔗 Lien</button>' : '')
    + `${di ? '<button id="back" type="button">✛ Point le plus équitable</button>' : ''}</span></div>`;
  const panel = $('route');
  panel.style.display = 'block';
  panel.innerHTML = `${head(false)}<div class="alt">Calcul des itinéraires…</div>`;

  // Point le plus équitable (di = 0) : pas d'itinéraire exact en transports, on n'y va pas vraiment ; les estimations
  // suffisent, et Transitous garde sa cadence (un itinéraire toutes les 3 s environ) pour les fiches
  const iso = arrive.toISOString();
  const itins = await Promise.all(people.map(p => {
    const l = legs[di][p.i];
    return l.via === 'transit' ? (l.itin || (di ? transitPlan(p, dest, iso, true, p.wheelchair) : null)) : null;
  }));
  people.forEach(p => { if (itins[p.i]) Object.assign(legs[di][p.i], { itin: itins[p.i], exact: itins[p.i].duration, transfers: itins[p.i].transfers || 0 }); });
  if (di) await Promise.all(people.map(p => backPlan(p, legs[di][p.i], dest)));
  if (di) updateCard(di);
  const segs = (await Promise.all(people.map(p => routePoints(p, legs[di][p.i], dest, itins[p.i])))).flat();
  if (token !== S.selToken) return; // un autre lieu a été choisi entre-temps

  panel.innerHTML = head(true) + people.map(p => `<div class="step">${routeText(p, legs[di][p.i], dest, arrive, itins[p.i])}${backText(p, legs[di][p.i], dest)}</div>`).join('');
  if (di) $('back').onclick = () => select(0);
  // Une fois l'app en ligne, les récaps portent le lien de la recherche (avec ce lieu) : chacun y voit son trajet détaillé
  const placeRecap = () => recapPlace({ kind: S.kind, arrive, place: dest, people, legs: legs[di], weather: S.weather, link: searchLink(dest) });
  $('recap').onclick = () => shareRecap(di ? placeRecap()
    : recapChoices({ kind: S.kind, arrive, top: S.top, people, legs, weather: S.weather, link: searchLink(null) }));
  if (di) $('ics').onclick = () => downloadIcs(icsEvent({ kind: S.kind, arrive, place: dest, description: placeRecap() }));
  if (di) $('sellink').onclick = copyShareLink;
  drawRoutes(segs, [...people.map(p => [p.lat, p.lon]), [dest.lat, dest.lon], ...(di ? [] : S.top.map(r => [r.c.lat, r.c.lon]))]);
  if (di) $('map').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function init() {
  $('add').onclick = () => addPerson();
  $('go').onclick = () => run();
  $('share').onclick = copyShareLink;
  $('recent').onchange = () => { const k = $('recent').value; $('recent').value = ''; if (k !== '') useRecent(+k); };
  drawRecent();
  // L'heure suit le type de lieu (12:30 resto, 19:00 bar…) tant qu'on ne l'a pas choisie soi-même
  $('kind').onchange = () => {
    if (!$('when').dataset.chosen) $('when').value = defaultWhen($('kind').value);
    refreshOptions();
  };
  $('when').addEventListener('input', () => { $('when').dataset.chosen = '1'; refreshOptions(); });
  ['f-open', 'f-terrace', 'f-veggie', 'f-wheelchair'].forEach(id => { $(id).onchange = rerank; });

  // Un lien partagé a priorité sur la mémoire du navigateur, et lance la recherche
  const shared = decodeShare(location.hash);
  if (shared && shared.sel) S.link = { ...shared.sel, key: groupKey(shared.kind, shared.people) };
  const saved = shared ? shared.people : loadSaved();
  (saved && saved.length >= 2 ? saved : [{}, {}]).forEach(p => addPerson(p));
  $('kind').value = shared ? shared.kind : (new Date().getHours() < 16 ? 'resto' : 'bar');
  const sharedWhen = shared && shared.when && new Date(shared.when) > Date.now() - 3600e3 ? shared.when : null;
  $('when').value = sharedWhen || defaultWhen($('kind').value);
  if (sharedWhen) $('when').dataset.chosen = '1';
  refreshOptions();
  if (shared && shared.people.every(p => p.q)) run();
}

init();
