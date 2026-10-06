// Partage : l'état du formulaire dans le #fragment de l'URL (jamais envoyé à un serveur), et récaps en texte brut.

// `sel` (facultatif) : le lieu choisi, ouvert directement chez celui qui reçoit le lien
function encodeShare({ kind, when, people, sel }) {
  const round = v => v == null ? undefined : Math.round(v * 1e5) / 1e5;
  const data = {
    k: kind, t: when,
    s: sel ? { id: sel.id, n: sel.name, la: round(sel.lat), lo: round(sel.lon) } : undefined,
    p: people.map(p => ({
      n: p.name || undefined, q: p.q, m: p.mode, la: round(p.lat), lo: round(p.lon),
      mx: p.maxMin || undefined, sl: p.slack || undefined, bt: p.backTime || undefined, wc: p.wheelchair ? 1 : undefined,
      a: p.after ? { q: p.after.q, la: round(p.after.lat), lo: round(p.after.lon) } : undefined,
    })),
  };
  return '#s=' + urlPart(JSON.stringify(data));
}

function decodeShare(hash) {
  const m = /^#s=(.+)$/.exec(hash || '');
  if (!m) return null;
  try {
    const d = JSON.parse(decodeURIComponent(m[1]));
    if (!Array.isArray(d.p) || d.p.length < 2) return null;
    const num = v => typeof v === 'number' && isFinite(v) ? v : null;
    // Identifiant OSM seulement (il sert à construire un lien vers openstreetmap.org)
    const s = d.s && /^(node|way|relation)\/\d+$/.test(d.s.id) && num(d.s.la) != null && num(d.s.lo) != null ? d.s : null;
    return {
      kind: PLACES[d.k] ? d.k : 'resto',
      when: typeof d.t === 'string' ? d.t : null,
      sel: s ? { id: s.id, name: String(s.n || 'Lieu choisi').slice(0, 80), lat: s.la, lon: s.lo } : null,
      people: d.p.slice(0, 8).map(p => ({
        name: String(p.n || '').slice(0, 20), q: String(p.q || ''), mode: MODES[p.m] ? p.m : DEFAULT_MODE,
        lat: num(p.la), lon: num(p.lo),
        maxMin: num(p.mx) && p.mx > 0 ? Math.round(p.mx) : null,
        slack: num(p.sl) && p.sl > 0 ? Math.min(Math.round(p.sl), 60) : 0,
        after: p.a && p.a.q ? { q: String(p.a.q), lat: num(p.a.la), lon: num(p.a.lo) } : null,
        backTime: /^\d\d:\d\d$/.test(p.bt || '') ? p.bt : '',
        wheelchair: p.wc === 1,
      })),
    };
  } catch { return null; }
}

// « La même recherche » : même type de lieu, mêmes adresses et mêmes modes (les options peuvent changer)
const groupKey = (kind, people) => JSON.stringify([kind, people.map(p => [String(p.q || '').trim(), p.mode])]);

// Le lieu d'un lien partagé ne vaut que pour la recherche du lien : groupe ou type de lieu changé (ou recherche 🕘
// reprise), il n'est plus imposé. `link.key` : groupKey de la recherche du lien.
const linkApplies = (link, kind, people) => !!link && link.key === groupKey(kind, people);

// ---------- Recherches récentes (mémoire locale) ----------
// Même recherche : une seule entrée, remontée en tête (avec ses options du moment)
const recentKey = e => groupKey(e.kind, e.people);
function pushRecent(list, entry, max = 5) {
  const k = recentKey(entry);
  return [entry, ...(Array.isArray(list) ? list : []).filter(e => e && Array.isArray(e.people) && recentKey(e) !== k)].slice(0, max);
}
// « 🍺 Alice, Zoé, Place de la Bastille » : le prénom, sinon le début de l'adresse
function recentLabel(e) {
  const who = e.people.map(p => p.name || String(p.q || '?').split(',')[0]).join(', ');
  return `${(PLACES[e.kind] || PLACES.resto).icon} ${who.length > 60 ? `${who.slice(0, 59)}…` : who}`;
}

// ---------- Récaps à coller dans la conversation du groupe (texte brut, sans HTML) ----------
const dayAt = d => `${new Date(d).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' })} à ${hhmm(d)}`;

// « métro 14 », « RER A », « bus 91 » : un numéro seul ne parle pas dans un message
const LINE_KINDS = { SUBWAY: 'métro', METRO: 'métro', BUS: 'bus', COACH: 'car', TRAM: 'tram', FERRY: 'bateau' };
function lineLabel(l) {
  const n = lineName(l);
  if (LINE_KINDS[l.mode]) return `${LINE_KINDS[l.mode]} ${n}`;
  if (/RAIL|SUBURBAN/.test(l.mode)) return /^[A-E]$/.test(n) ? `RER ${n}` : `train ${n}`;
  return n;
}

// Une ligne par personne : heure de départ, mode, durée, lignes, retour. `l` : leg aller (voir tripOf).
function recapLine(p, l, arrive) {
  if (l.sec == null) return `• ${label(p)} : pas de trajet trouvé`;
  const sec = l.exact ?? l.sec;
  const depart = l.itin ? l.itin.startTime : arrive - sec * 1000;
  let how;
  if (l.via === 'transit') {
    const lines = l.itin ? [...new Set(l.itin.legs.filter(x => x.mode !== 'WALK').map(lineLabel))] : [];
    how = `🚇 ${fmt(sec)}${lines.length ? ` (${lines.join(', ')})` : ''}`;
  } else if (l.via === 'velib') how = `Vélib' ${fmt(sec)} (station ${l.opts.velib.start.name})`;
  else how = `${modeIcon(p, l.via)} ${fmt(sec)} ${onFoot(p, l.via)}`;
  const b = l.back;
  const back = !b ? '' : b.none ? ' · ⚠️ plus de transports pour rentrer' : ` · retour ${modeIcon(p, b.via)} ${fmt(b.exact ?? b.sec)}`;
  return `• ${label(p)} : départ ${hhmm(depart)} · ${how}${back}`;
}

// Rendez-vous fixé : lieu, heure, et comment chacun y va
const weatherLine = w => w ? [`Météo prévue : ${weatherText(w)}`] : [];

// `link` (facultatif) : lien de l'app qui rouvre la recherche et ce lieu, pour que chacun voie son trajet détaillé
function recapPlace({ kind, arrive, place, people, legs, weather, link }) {
  const addr = addressOf(place.tags);
  return [
    `${PLACES[kind].icon} Rendez-vous ${dayAt(arrive)} : ${place.name}${addr ? `, ${addr}` : ''}`,
    placeSearchUrl(place),
    ...weatherLine(weather),
    ...people.map(p => recapLine(p, legs[p.i], arrive)),
    ...(link ? [`Le trajet détaillé de chacun : ${link}`] : []),
  ].join('\n');
}

// Les meilleurs choix, numérotés : chacun répond avec un numéro. `top` : [{ di, c }], legs[di][personne].
// `link` (facultatif) : lien de l'app qui rouvre la recherche (carte, trajets de chacun)
function recapChoices({ kind, arrive, top, people, legs, weather, link }) {
  const lines = top.map((r, k) => {
    const secs = legs[r.di].map(shownCost), max = Math.max(...secs), who = people[secs.indexOf(max)];
    const cuisine = cuisinesOf(r.c.tags).slice(0, 2).map(cuisineLabel).join(', ');
    const worst = isFinite(max) ? `au plus ${fmt(max)} de trajet (${label(who)}${legs[r.di][who.i].back ? ', aller + retour' : ''})` : 'trajet incomplet';
    return `${k + 1}. ${r.c.name}${cuisine ? ` (${cuisine})` : ''} : ${worst}\n   ${placeSearchUrl(r.c)}`;
  });
  return [`${PLACES[kind].icon} On se retrouve où, ${dayAt(arrive)} ? Répondez avec un numéro :`, ...weatherLine(weather), ...lines,
    ...(link ? [`Sur la carte, avec le trajet de chacun : ${link}`] : [])].join('\n');
}

// ---------- Agenda (.ics, RFC 5545) ----------
const icsDate = d => new Date(d).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const icsText = s => String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');

// Lignes repliées à 75 octets au plus, sans couper un caractère UTF-8 (les emoji comptent 4 octets)
function icsFold(line) {
  const enc = new TextEncoder(), out = [];
  let cur = '', bytes = 0;
  for (const ch of line) {
    const n = enc.encode(ch).length;
    if (bytes + n > 75) { out.push(cur); cur = ' '; bytes = 1; }
    cur += ch; bytes += n;
  }
  out.push(cur);
  return out.join('\r\n');
}

// Rendez-vous : du moment de l'arrivée à la fin du temps habituel sur place ; `description` : le récap (texte brut)
function icsEvent({ kind, arrive, place, description, now = new Date() }) {
  const end = new Date(arrive.getTime() + PLACES[kind].stay * 60e3), addr = addressOf(place.tags);
  return [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//On se retrouve ou//FR', 'METHOD:PUBLISH', 'BEGIN:VEVENT',
    `UID:${icsDate(arrive)}-${String(place.id || 'lieu').replace(/\W/g, '-')}@on-se-retrouve-ou`,
    `DTSTAMP:${icsDate(now)}`, `DTSTART:${icsDate(arrive)}`, `DTEND:${icsDate(end)}`,
    `SUMMARY:${icsText(`${PLACES[kind].icon} ${place.name}`)}`,
    `LOCATION:${icsText(addr ? `${place.name}, ${addr}` : `${place.lat.toFixed(5)}, ${place.lon.toFixed(5)}`)}`,
    `GEO:${place.lat.toFixed(6)};${place.lon.toFixed(6)}`,
    `URL:${placeSearchUrl(place)}`,
    ...(description ? [`DESCRIPTION:${icsText(description)}`] : []),
    'END:VEVENT', 'END:VCALENDAR',
  ].map(icsFold).join('\r\n') + '\r\n';
}

