// Interface : formulaire (prénoms, autocomplétion, position), lien de partage, filtres, fiches, panneau des trajets.

const initial = p => p.name ? p.name[0].toUpperCase() : letter(p.i);
const tagHtml = p => `<b style="color:${color(p.i)}">${esc(label(p))}</b>`;

function status(msg, err = false) { $('status').textContent = msg; $('status').className = err ? 'err' : ''; }
function setBusy(on) { $('go').disabled = on; $('go').textContent = on ? 'Recherche…' : 'Trouver'; }

// ---------- Personnes ----------
function addPerson({ name = '', q = '', mode = DEFAULT_MODE, lat = null, lon = null, maxMin = null, slack = 0, after = null, backTime = '', wheelchair = false } = {}) {
  const row = document.createElement('div');
  row.className = 'person';
  row.innerHTML = `<span class="tag"></span>
    <input class="name" placeholder="Prénom" maxlength="20" aria-label="Prénom">
    <div class="addr-wrap">
      <input class="addr" placeholder="Adresse, gare, lieu…" autocomplete="off" aria-label="Adresse">
      <button class="loc" type="button" title="Utiliser ma position">📍</button>
      <ul class="sugg" hidden></ul>
    </div>
    <select class="mode" aria-label="Moyen de transport">${MODE_GROUPS.map(([g, keys]) =>
      `<optgroup label="${g}">${keys.map(k => `<option value="${k}">${MODES[k].label}</option>`).join('')}</optgroup>`).join('')}</select>
    <button class="opt" type="button" title="Options : trajet max, où aller après" aria-expanded="false">⚙︎</button>
    <button class="rm" type="button" title="Retirer">×</button>
    <div class="resolved"></div>
    <button class="optsum" type="button" title="Modifier les options" hidden></button>
    <div class="opts" hidden>
      <label title="Les lieux plus loin que ça pour cette personne sont écartés">⏱ Trajet max
        <input class="max" type="number" min="5" max="180" step="5" placeholder="—" aria-label="Trajet max en minutes"> min</label>
      <label title="Pour que les autres aient moins de trajet, elle accepte d'en faire un peu plus">🙋 Veut bien faire
        <select class="slack" aria-label="Minutes de trajet en plus acceptées"><option value="">—</option>${[5, 10, 15, 20, 30].map(m => `<option value="${m}">+${m}</option>`).join('')}</select> min de plus</label>
      <label title="Transports accessibles (bus, tram, RER ; pas de métro), ni vélo ni Vélib', lieux accessibles"><input class="wc" type="checkbox"> ♿ En fauteuil</label>
      <div class="after-line">
        <span>↩︎ Après, va à</span>
        <div class="addr-wrap after-wrap">
          <input class="after" placeholder="nulle part (vide)" autocomplete="off" aria-label="Adresse où aller après">
          <button class="home" type="button" title="Revenir au point de départ">↺</button>
          <ul class="sugg" hidden></ul>
        </div>
        <label>vers <input class="backat" type="time" aria-label="Heure de départ du lieu"></label>
        <span class="backhint alt"></span>
      </div>
    </div>`;
  row.querySelector('.name').value = name;
  row.querySelector('.addr').value = q;
  row.querySelector('.mode').value = MODES[mode] ? mode : DEFAULT_MODE;
  if (q && lat != null && lon != null) setCoords(row, { lat, lon }, q);
  const afterWrap = row.querySelector('.after-wrap');
  if (maxMin != null) row.querySelector('.max').value = maxMin;
  if (slack) row.querySelector('.slack').value = String(slack);
  row.querySelector('.wc').checked = !!wheelchair;
  if (after && after.q) {
    row.querySelector('.after').value = after.q;
    if (after.lat != null && after.lon != null) setCoords(afterWrap, after, after.q);
  }
  row.querySelector('.backat').value = backTime || '';
  row.querySelector('.name').addEventListener('input', relabel);
  row.querySelector('.name').addEventListener('keydown', e => { if (e.key === 'Enter') run(); }); // comme dans l'adresse
  row.querySelector('.rm').onclick = () => { if ($('people').children.length > 2) { row.remove(); relabel(); } };
  row.querySelector('.loc').onclick = () => locate(row);
  const toggleOpts = () => {
    const box = row.querySelector('.opts');
    box.hidden = !box.hidden;
    row.querySelector('.opt').setAttribute('aria-expanded', String(!box.hidden));
    markOptions(row);
  };
  row.querySelector('.opt').onclick = toggleOpts;
  row.querySelector('.optsum').onclick = toggleOpts;
  // ↺ : revenir au point de départ (typiquement le bureau, le midi)
  row.querySelector('.home').onclick = () => {
    const input = row.querySelector('.after');
    input.value = row.querySelector('.addr').value;
    if (row.dataset.lat != null) setCoords(afterWrap, { lat: row.dataset.lat, lon: row.dataset.lon }, input.value.trim());
    markOptions(row);
  };
  ['.max', '.slack', '.after', '.backat', '.wc'].forEach(sel => row.querySelector(sel).addEventListener('input', () => markOptions(row)));
  attachAutocomplete(row.querySelector('.addr'), row);
  attachAutocomplete(row.querySelector('.after'), afterWrap);
  $('people').append(row);
  if (maxMin != null || slack || wheelchair || (after && after.q)) row.querySelector('.opts').hidden = false;
  markOptions(row);
  relabel();
}

// Options remplies : bouton ⚙︎ en évidence, et résumé visible même panneau fermé (un « Après » resté en mémoire
// d'une recherche précédente ne doit pas fausser la suivante en silence). Sans heure saisie, on montre celle qui sera prise.
function markOptions(row) {
  const max = row.querySelector('.max').value, slack = row.querySelector('.slack').value;
  const after = row.querySelector('.after').value.trim(), at = row.querySelector('.backat').value, wc = row.querySelector('.wc').checked;
  row.querySelector('.opt').classList.toggle('on', !!(max || slack || after || wc));
  const arrive = new Date($('when').value);
  const auto = after && !at && !isNaN(arrive) ? hhmm(backDate(arrive, '', $('kind').value)) : '';
  row.querySelector('.backhint').textContent = auto ? `vide : départ à ${auto} (temps habituel sur place)` : '';
  const parts = [wc && '♿ en fauteuil', max && `⏱ ${max} min max`, slack && `🙋 +${slack} min OK`, after && `↩︎ repart vers ${after.split(',')[0]} à ${at || auto || '?'}`].filter(Boolean);
  const sum = row.querySelector('.optsum');
  sum.textContent = parts.join(' · ');
  sum.hidden = !parts.length || !row.querySelector('.opts').hidden;
}
const refreshOptions = () => [...$('people').children].forEach(markOptions);

function relabel() {
  [...$('people').children].forEach((row, i) => {
    const t = row.querySelector('.tag'), name = row.querySelector('.name').value.trim();
    t.textContent = name ? name[0].toUpperCase() : letter(i);
    t.style.background = color(i);
  });
}

// Coordonnées connues d'une adresse (suggestion choisie, position, lien partagé), rangées sur son conteneur `holder`
// (la ligne pour l'adresse de départ, le bloc « Après » sinon) : valables tant que le texte `q` n'a pas changé
function setCoords(holder, { lat, lon }, q) {
  Object.assign(holder.dataset, { lat, lon, q });
}
function clearCoords(holder) {
  delete holder.dataset.lat; delete holder.dataset.lon; delete holder.dataset.q;
  const resolved = holder.querySelector(':scope > .resolved');
  if (resolved) resolved.textContent = '';
}
function readCoords(holder, q) {
  return holder.dataset.q === q && holder.dataset.lat != null ? { lat: +holder.dataset.lat, lon: +holder.dataset.lon } : { lat: null, lon: null };
}

function readPeople() {
  return [...$('people').children].map((row, i) => {
    const q = row.querySelector('.addr').value.trim(), afterQ = row.querySelector('.after').value.trim();
    const max = parseInt(row.querySelector('.max').value, 10);
    return {
      i, row, q, name: row.querySelector('.name').value.trim(), mode: row.querySelector('.mode').value, ...readCoords(row, q),
      maxMin: max > 0 ? max : null, slack: parseInt(row.querySelector('.slack').value, 10) || 0,
      after: afterQ ? { q: afterQ, ...readCoords(row.querySelector('.after-wrap'), afterQ) } : null,
      backTime: row.querySelector('.backat').value, wheelchair: row.querySelector('.wc').checked,
    };
  });
}

// Autocomplétion Photon, orientée vers les autres personnes (ou la dernière recherche)
function biasPoint(row) {
  const others = readPeople().filter(p => p.row !== row && p.lat != null);
  if (others.length) return { lat: others.reduce((s, p) => s + p.lat, 0) / others.length, lon: others.reduce((s, p) => s + p.lon, 0) / others.length };
  try { return JSON.parse(localStorage.getItem('trajet.center')); } catch { return null; }
}

// `holder` garde les coordonnées de la suggestion choisie (voir setCoords)
function attachAutocomplete(input, holder) {
  const list = input.parentElement.querySelector('.sugg'), row = input.closest('.person');
  let timer, ctrl, items = [], active = -1;
  const close = () => { list.hidden = true; items = []; active = -1; };
  const draw = () => {
    list.innerHTML = items.map((it, k) => `<li class="${k === active ? 'on' : ''}" data-k="${k}">${esc(it.label)}</li>`).join('');
    list.hidden = !items.length;
  };
  const choose = it => { input.value = it.label; setCoords(holder, it, it.label); close(); };

  input.addEventListener('input', () => {
    clearCoords(holder);
    clearTimeout(timer);
    if (ctrl) ctrl.abort();
    const q = input.value.trim();
    if (q.length < 3) return close();
    timer = setTimeout(async () => {
      ctrl = new AbortController();
      try { items = await photonSearch(q, biasPoint(row), ctrl.signal); } catch { return; }
      active = -1;
      draw();
    }, 300);
  });
  input.addEventListener('keydown', e => {
    if (!list.hidden && items.length) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        active = (active + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
        draw(); e.preventDefault(); return;
      }
      if (e.key === 'Enter' && active >= 0) { choose(items[active]); e.preventDefault(); return; }
      if (e.key === 'Escape') { close(); return; }
    }
    if (e.key === 'Enter') { close(); run(); }
  });
  input.addEventListener('blur', () => setTimeout(close, 150));
  list.addEventListener('mousedown', e => {
    const li = e.target.closest('li');
    if (li) { e.preventDefault(); choose(items[+li.dataset.k]); }
  });
}

function locate(row) {
  if (!navigator.geolocation) return status('La géolocalisation n\'est pas disponible dans ce navigateur.', true);
  status('Recherche de ta position…');
  navigator.geolocation.getCurrentPosition(async pos => {
    const { latitude: lat, longitude: lon } = pos.coords;
    let text = 'Ma position';
    try { text = (await photonReverse(lat, lon)) || text; } catch { /* on garde « Ma position » */ }
    row.querySelector('.addr').value = text;
    setCoords(row, { lat, lon }, text);
    status('');
  }, err => status(`Position indisponible (${err.message}).`, true), { enableHighAccuracy: true, timeout: 10000 });
}

// ---------- Heure, mémoire, lien de partage ----------
function toLocalInput(d) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
// Aujourd'hui à l'heure type ; si elle vient de passer : dans 30 min ; si elle est loin derrière : demain.
function defaultWhen(kind) {
  const now = new Date(), t = new Date(now);
  t.setHours(...PLACES[kind].hour, 0, 0);
  if (t < now) {
    if (now - t < 2 * 3600e3) { t.setTime(now.getTime() + 30 * 60e3); t.setMinutes(Math.ceil(t.getMinutes() / 5) * 5, 0, 0); }
    else t.setDate(t.getDate() + 1);
  }
  return toLocalInput(t);
}

const STORE = 'trajet.people.v2', RECENT = 'trajet.recent.v1';
const stored = people => people.map(({ name, q, mode, lat, lon, maxMin, slack, after, backTime, wheelchair }) => ({ name, q, mode, lat, lon, maxMin, slack, after, backTime, wheelchair }));
function loadSaved() {
  try { return JSON.parse(localStorage.getItem(STORE)) || null; } catch { return null; }
}
function save(people, center) {
  try {
    localStorage.setItem(STORE, JSON.stringify(stored(people)));
    if (center) localStorage.setItem('trajet.center', JSON.stringify({ lat: center.lat, lon: center.lon }));
  } catch { /* stockage indisponible : tant pis */ }
}

// Recherches récentes : les 5 dernières (groupe + type de lieu), à reprendre depuis le menu 🕘
function loadRecent() {
  try { const l = JSON.parse(localStorage.getItem(RECENT)); return Array.isArray(l) ? l : []; } catch { return []; }
}
function saveRecent(kind, people) {
  try { localStorage.setItem(RECENT, JSON.stringify(pushRecent(loadRecent(), { kind, people: stored(people) }))); } catch { /* tant pis */ }
  drawRecent();
}
function drawRecent() {
  const list = loadRecent().filter(e => e && Array.isArray(e.people) && e.people.length >= 2);
  $('recent').hidden = !list.length;
  $('recent').innerHTML = '<option value="">🕘 Récentes</option>' + list.map((e, k) => `<option value="${k}">${esc(recentLabel(e))}</option>`).join('');
}
// Reprend le groupe et le type de lieu ; l'heure suit le type, sauf si on l'a choisie soi-même
function useRecent(k) {
  const e = loadRecent().filter(e => e && Array.isArray(e.people) && e.people.length >= 2)[k];
  if (!e) return;
  $('people').innerHTML = '';
  e.people.forEach(p => addPerson(p));
  $('kind').value = PLACES[e.kind] ? e.kind : 'resto';
  if (!$('when').dataset.chosen) $('when').value = defaultWhen($('kind').value);
  refreshOptions();
  status('Recherche reprise : vérifie l\'heure, puis « Trouver ».');
}

// App ouverte en local (fichier, serveur de dev) : ses liens ne marchent pas chez les autres
const isLocal = () => location.protocol === 'file:' || ['localhost', '127.0.0.1'].includes(location.hostname);

// Lien de la recherche affichée (et du lieu `sel`), pour les récaps ; null en local, il ne servirait à personne
function searchLink(sel) {
  if (isLocal()) return null;
  return location.origin + location.pathname + encodeShare({ kind: S.kind, when: toLocalInput(S.arrive), people: S.people, sel });
}

async function copyShareLink() {
  const people = readPeople(), kind = $('kind').value;
  // Le lieu ouvert dans le panneau des trajets (de la recherche affichée) : le lien l'ouvrira aussi
  const sel = S.selDi && S.dests && S.kind === kind ? S.dests[S.selDi] : null;
  history.replaceState(null, '', encodeShare({ kind, when: $('when').value, people, sel }));
  const note = isLocal() ? ' (il ne marchera chez tes potes qu\'une fois l\'app en ligne)' : '';
  copyText(location.href, `Lien copié : il préremplit cette recherche${sel ? ` et ouvre « ${sel.name} »` : ''}${note}.`, note);
}

// Presse-papiers ; s'il est refusé, on affiche le texte déjà sélectionné
async function copyText(text, done, note = '') {
  try {
    await navigator.clipboard.writeText(text);
    status(done);
  } catch {
    const multi = text.includes('\n');
    $('status').className = '';
    $('status').innerHTML = `Copie ce ${multi ? 'texte' : 'lien'}${esc(note)} : `
      + (multi ? `<textarea class="share-url" rows="${Math.min(text.split('\n').length, 10)}" readonly></textarea>` : '<input class="share-url" readonly>');
    const box = $('status').querySelector('.share-url');
    box.value = text;
    box.select();
  }
}

// Récap pour le groupe : feuille de partage sur téléphone (WhatsApp, SMS…), presse-papiers ailleurs
async function shareRecap(text) {
  if (navigator.share && matchMedia('(pointer: coarse)').matches) {
    try { return await navigator.share({ text }); } catch (e) { if (e.name === 'AbortError') return; }
  }
  const early = !$('refining').hidden;
  copyText(text, `Récap copié : colle-le dans la conversation du groupe.${early ? ' Les temps en transports sont encore en cours d\'affinage : recopie-le dans un instant pour les temps exacts.' : ''}`,
    early ? ' (temps en transports encore en cours d\'affinage)' : '');
}

// Fichier .ics généré dans le navigateur : sur téléphone, il s'ouvre dans l'agenda
function downloadIcs(text, name = 'rendez-vous.ics') {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/calendar;charset=utf-8' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

// ---------- Filtres ----------
function buildFilters(pool, kind, onChange) {
  const counts = new Map();
  pool.forEach(p => cuisinesOf(p.tags).forEach(c => counts.set(c, (counts.get(c) || 0) + 1)));
  const top = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 12);
  $('chips').innerHTML = top.map(([c, n]) => `<button type="button" class="chip" data-c="${esc(c)}">${esc(cuisineLabel(c))} <span class="alt">${n}</span></button>`).join('');
  $('chips').querySelectorAll('.chip').forEach(b => b.onclick = () => { b.classList.toggle('on'); onChange(); });
  // Terrasse et végétarien n'ont de sens que pour manger ou boire
  ['f-terrace', 'f-veggie'].forEach(id => { $(id).closest('label').hidden = !PLACES[kind].food; });
  $('filters').hidden = false;
}
function readFilters() {
  const food = PLACES[S.kind].food;
  return {
    // Cases cachées pour un parc ou une station : cochées avant, elles ne doivent pas tout filtrer
    openOnly: $('f-open').checked, wheelchair: $('f-wheelchair').checked, noInaccessible: S.people.some(p => p.wheelchair),
    terrace: food && $('f-terrace').checked, veggie: food && $('f-veggie').checked,
    cuisines: new Set([...document.querySelectorAll('#chips .chip.on')].map(b => b.dataset.c)),
  };
}

// Météo pendant la sortie (null : on cache) ; pluie probable : terrasse et vélo déconseillés
function showWeather(w, arrive, kind) {
  const el = $('weather');
  el.hidden = !w;
  if (!w) return;
  const avoid = PLACES[kind].food ? 'terrasse et vélo déconseillés' : kind === 'park' ? 'parc et vélo déconseillés' : 'vélo déconseillé';
  const advice = { wet: ` <span class="warn">· ${avoid}</span>`, maybe: ' · prévois un parapluie', dry: '' }[w.level];
  el.innerHTML = `Météo vers ${hhmm(arrive)} : ${esc(weatherText(w))}${advice}`;
}

// ---------- Fiches ----------
// Temps de chaque personne vers la destination `di`. « ~ » : estimation transports pas encore remplacée par l'itinéraire exact.
function timesHtml(di) {
  return S.legs[di].map((l, pi) => {
    const p = S.people[pi];
    let note = '';
    if (isAuto(p.mode)) {
      const others = Object.entries(l.opts).filter(([m, o]) => m !== l.via && o.sec != null)
        .map(([m, o]) => `${modeIcon(p, m)} ${m === 'transit' ? '~' : ''}${fmt(o.sec)}${o.rain ? ' ☔' : ''}`);
      if (others.length) note = ` <span class="alt">(${others.join(' · ')})</span>`;
    } else if ((p.mode === 'transit' || p.mode === 'velib') && l.via === 'walk') {
      // Le mode choisi reste visible : on veut pouvoir comparer
      const own = l.opts[p.mode], has = own && own.sec != null;
      const ownTxt = has ? ` ; ${MODES[p.mode].icon} ${p.mode === 'transit' ? '~' : ''}${fmt(own.sec)}${own.transfers ? ` · ${own.transfers} corresp.` : ''}` : '';
      // La marche peut l'emporter à temps égal (ou un peu plus long) grâce aux correspondances évitées : on le dit
      const nochange = own && own.transfers ? ', sans correspondance' : '';
      const foot = onFoot(p);
      const why = !has || l.sec <= own.sec - 60 ? `plus rapide ${foot}` : l.sec <= own.sec + 60 ? `aussi rapide ${foot}${nochange}` : `${foot} : un peu plus long${nochange}`;
      note = ` <span class="alt">(${why}${ownTxt})</span>`;
    }
    const approx = l.via === 'transit' && l.exact == null ? '~' : '';
    return `<span>${tagHtml(p)} ${l.via ? modeIcon(p, l.via) : ''} <b>${approx}${fmt(l.exact ?? l.sec)}</b>${changes(l)}${note}${backHtml(p, l.back)}</span>`;
  }).join('');
}

// Retour vers « Après », à la suite du temps aller
function backHtml(p, b) {
  if (!b) return '';
  if (b.none) return ' <span class="back warn">↩︎ ⚠️ plus de transports</span>';
  const approx = b.via === 'transit' && b.exact == null ? '~' : '';
  // Retour encore estimé : l'itinéraire exact vient en ouvrant la fiche (voir refineOrder)
  return ` <span class="back"${approx ? ' title="Retour estimé : ouvre la fiche pour l\'itinéraire exact"' : ''}>↩︎ ${modeIcon(p, b.via)} ${approx}${fmt(b.exact ?? b.sec)}${changes(b)}</span>`;
}

// « · 2 corresp. » pour un trajet en transports avec correspondances
const changes = o => o.via === 'transit' && o.transfers ? ` <span class="alt">· ${o.transfers} corresp.</span>` : '';

// « Pourquoi celui-là » : qui a le plus long trajet, et l'écart avec le plus court
function whyHtml(di) {
  const secs = S.legs[di].map(shownCost);
  const max = Math.max(...secs), min = Math.min(...secs);
  const blocked = S.people.filter(p => S.legs[di][p.i].back && S.legs[di][p.i].back.none);
  if (blocked.length) return `⚠️ ${blocked.map(p => esc(label(p))).join(', ')} ne pourra pas rentrer en transports à cette heure`;
  if (!isFinite(max)) return 'Pas de trajet trouvé pour tout le monde';
  const who = S.people[secs.indexOf(max)];
  const why = [S.legs[di][who.i].back && 'aller + retour', who.slack && `🙋 +${who.slack} min acceptées`].filter(Boolean).join(', ');
  return `Le plus long : ${esc(label(who))} ${fmt(max)}${why ? ` (${why})` : ''} · écart ${fmt(max - min)}`;
}

function badgesHtml(c) {
  const h = c.hours, t = c.tags, out = [];
  if (h.status === 'open') out.push(h.closes && h.closes - S.arrive < 864e5 ? `🕒 ouvert jusqu'à ${hhmm(h.closes)}` : '🕒 ouvert');
  else if (h.status === 'closed') out.push(h.early ? `⛔ ferme à ${hhmm(h.closes)}` : '⛔ fermé à cette heure');
  else if (PLACES[S.kind].food) out.push('<span class="alt">🕒 horaires non renseignés</span>');
  if (t.outdoor_seating === 'yes') out.push(S.weather && S.weather.level === 'wet' ? '☔ terrasse (pluie prévue)' : '☀️ terrasse');
  if (['yes', 'only'].includes(t['diet:vegetarian']) || ['yes', 'only'].includes(t['diet:vegan'])) out.push('🥗 végé');
  if (t.wheelchair === 'yes') out.push('♿ accessible');
  else if (t.wheelchair === 'limited') out.push('♿ accès limité');
  return out.map(b => `<span class="badge">${b}</span>`).join('');
}

function cardHtml(r, i) {
  const t = r.c.tags;
  const meta = [cuisinesOf(t).map(cuisineLabel).join(', '), addressOf(t)].filter(Boolean).map(esc).join(' · ');
  const site = /^https?:\/\//i.test(t.website || '') ? t.website : null; // donnée OSM : pas de lien javascript:
  return `<div class="card res" data-di="${r.di}" tabindex="0" title="Voir les trajets de chacun vers ce lieu">
    <h3>${i + 1}. ${esc(r.c.name)} ${i === 0 ? '<span class="best">· meilleur compromis</span>' : ''}${r.c === S.linked ? ' <span class="best">· 📌 lieu du lien</span>' : ''}</h3>
    ${meta ? `<div class="meta">${meta}</div>` : ''}
    <div class="badges">${badgesHtml(r.c)}</div>
    <div class="times">${timesHtml(r.di)}</div>
    <div class="why">${whyHtml(r.di)}</div>
    <div class="links"><a target="_blank" rel="noopener" href="${esc(placeSearchUrl(r.c))}">Avis Google</a><a target="_blank" rel="noopener" href="https://www.openstreetmap.org/${r.c.id}">OSM</a>${site ? `<a target="_blank" rel="noopener" href="${esc(site)}">Site</a>` : ''}</div>
  </div>`;
}

// Une fiche se choisit au clic, ou au clavier (Tab jusqu'à elle, puis Entrée ou Espace)
function renderResults(onPick) {
  $('results').innerHTML = S.top.map(cardHtml).join('');
  $('results').querySelectorAll('.res').forEach(el => {
    el.addEventListener('click', e => { if (!e.target.closest('a')) onPick(+el.dataset.di); });
    el.addEventListener('keydown', e => {
      if (e.target !== el || (e.key !== 'Enter' && e.key !== ' ')) return;
      e.preventDefault(); // Espace ferait défiler la page
      onPick(+el.dataset.di);
    });
  });
}

function updateCard(di) {
  const el = $('results').querySelector(`.res[data-di="${di}"]`);
  if (!el) return;
  el.querySelector('.times').innerHTML = timesHtml(di);
  el.querySelector('.why').innerHTML = whyHtml(di);
}

// ---------- Panneau des trajets ----------
// Transports sans itinéraire exact : estimation au point le plus équitable (voulu, voir select), sinon service muet
const noItin = dest => dest.id === 'center' ? 'estimation (itinéraire détaillé : choisis un lieu)' : 'itinéraire détaillé indisponible';

// Segments à dessiner : [{ pts, style, tip, casing }]
async function routePoints(p, leg, dest, itin) {
  if (!leg.via) return [];
  const c = color(p.i);
  if (leg.via === 'transit') {
    if (!itin) return [{ pts: [[p.lat, p.lon], [dest.lat, dest.lon]], style: { color: c, weight: 3, dashArray: '6 6' }, tip: `${label(p)} · ${noItin(dest)}` }];
    return itin.legs.map(l => {
      const walk = l.mode === 'WALK';
      return {
        pts: decodePolyline(l.legGeometry.points, l.legGeometry.precision), casing: !walk,
        style: walk ? { color: c, weight: 4, dashArray: '2 8' } : { color: l.routeColor ? `#${l.routeColor}` : c, weight: 6 },
        tip: walk ? `${label(p)} · à pied ${fmt(l.duration)}` : `${label(p)} · ${lineName(l)} → ${l.headsign || l.to.name}`,
      };
    }).filter(s => s.pts.length > 1);
  }
  if (leg.via === 'velib') {
    const { start, end } = leg.opts.velib;
    const [w1, ride, w2] = await Promise.all([streetRoute('walk', p, start), streetRoute('bike', start, end), streetRoute('walk', end, dest)]);
    const walk = { color: c, weight: 4, dashArray: '2 8' };
    return [
      { pts: w1, style: walk, tip: `${label(p)} · à pied jusqu'à la station ${start.name}` },
      { pts: ride, style: { color: c, weight: 5 }, casing: true, tip: `${label(p)} · Vélib' ${start.name} → ${end.name}` },
      { pts: w2, style: walk, tip: `${label(p)} · à pied depuis la station ${end.name}` },
      { station: start, tip: `Station ${start.name} : ${start.bikes} vélos${start.ebike ? ` (dont ${start.ebike} électriques)` : ''}` },
      { station: end, tip: `Station ${end.name} : ${end.docks} places libres` },
    ];
  }
  const pts = await streetRoute(leg.via, p, dest);
  return [{ pts, style: leg.via === 'walk' ? { color: c, weight: 4, dashArray: '2 8' } : { color: c, weight: 5 }, tip: `${label(p)} · ${MODES[leg.via].label}` }];
}

function routeText(p, leg, dest, arrive, itin) {
  if (leg.sec == null) return `${tagHtml(p)} pas de trajet trouvé`;
  const gmaps = `<a target="_blank" rel="noopener" href="https://www.google.com/maps/dir/?api=1&origin=${p.lat},${p.lon}&destination=${dest.lat},${dest.lon}&travelmode=${MODES[leg.via].gmaps}">Google Maps</a>`;
  if (leg.via === 'transit') {
    if (!itin) return `${tagHtml(p)} 🚇 <b>~${fmt(leg.sec)}</b> · départ <b>${hhmm(arrive - leg.sec * 1000)}</b> · ${noItin(dest)} · ${gmaps}`;
    return `${tagHtml(p)} 🚇 départ <b>${hhmm(itin.startTime)}</b> → arrivée ${hhmm(itin.endTime)} (${fmt(itin.duration)}) — ${legsText(itin)} · ${gmaps}`;
  }
  if (leg.via === 'velib') {
    const v = leg.opts.velib;
    const ebike = v.start.ebike ? `, dont ${v.start.ebike} élec.` : '';
    const short = s => s < 60 ? '< 1 min' : fmt(s);
    return `${tagHtml(p)} Vélib' <b>${fmt(v.sec)}</b> · départ <b>${hhmm(arrive - v.sec * 1000)}</b> — 🚶 ${short(v.walkIn)} → station <b>${esc(v.start.name)}</b> (${v.start.bikes} vélos${ebike})`
      + ` · 🚲 ${fmt(v.bike)} → station <b>${esc(v.end.name)}</b> (${v.end.docks} places) · 🚶 ${short(v.walkOut)}`
      + ` <span class="alt">(stations : remplissage actuel ; +${fmt(VELIB_OVERHEAD)} pour prendre et reposer le vélo)</span> · ${gmaps}`;
  }
  return `${tagHtml(p)} ${modeIcon(p, leg.via)} <b>${fmt(leg.sec)}</b> ${onFoot(p, leg.via)} · départ <b>${hhmm(arrive - leg.sec * 1000)}</b> · ${gmaps}`;
}

// Étapes d'un itinéraire en transports : « 🚶 4 min · 🚇 14 Gare de Lyon → Châtelet · … »
function legsText(itin) {
  return itin.legs.filter(l => l.mode !== 'WALK' || l.duration >= 60).map(l => l.mode === 'WALK'
    ? `🚶 ${fmt(l.duration)}`
    : `${LEG_ICONS[l.mode] || '🚇'} <b>${esc(lineName(l))}</b> ${esc(l.from.name)} → ${esc(l.to.name)}`).join(' · ');
}

// Retour vers « Après » dans le panneau des trajets
function backText(p, leg, dest) {
  const b = leg.back;
  if (!b || !p.after) return '';
  const head = `↩︎ Retour vers <b>${esc(p.after.q)}</b>`, at = hhmm(p.backAt);
  const arrival = sec => hhmm(p.backAt.getTime() + sec * 1000);
  let body;
  if (b.none) body = `à ${at} : ⚠️ plus de transports à cette heure`;
  else if (b.via === 'transit') body = b.itin
    ? `: 🚇 départ <b>${hhmm(b.itin.startTime)}</b> → arrivée <b>${hhmm(b.itin.endTime)}</b> — ${legsText(b.itin)}`
    : `: 🚇 ~${fmt(b.sec)} (départ ${at}) · ${noItin(dest)}`;
  else if (b.via === 'velib') body = `: Vélib' ${fmt(b.sec)} (départ ${at}, arrivée vers ${arrival(b.sec)}) — station <b>${esc(b.start.name)}</b> (${b.start.bikes} vélos) → station <b>${esc(b.end.name)}</b> (${b.end.docks} places)`;
  else body = `: ${modeIcon(p, b.via)} ${fmt(b.sec)} ${onFoot(p, b.via)} (départ ${at}, arrivée vers ${arrival(b.sec)})`;
  return `<div class="back-step">${head} ${body}</div>`;
}
