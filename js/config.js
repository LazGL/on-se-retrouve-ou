// Constantes et petits utilitaires partagés.
// Scripts classiques (les modules ES ne se chargent pas en file://) : les const de haut niveau sont visibles des autres fichiers.

const MODES = {
  auto:      { label: '⚡ Auto',                icon: '⚡' },
  autovelib: { label: "⚡ Auto avec Vélib'",    icon: '⚡' },
  nobike:    { label: '⚡ Auto sans vélo',      icon: '⚡' },
  walk:      { label: '🚶 Marche',              icon: '🚶', gmaps: 'walking' },
  bike:      { label: '🚲 Vélo perso',          icon: '🚲', gmaps: 'bicycling' },
  velib:     { label: "🚲 Vélib'",              icon: "Vélib'", gmaps: 'bicycling' },
  transit:   { label: '🚇 Transports',          icon: '🚇', gmaps: 'transit' },
};
// Menu « moyen de transport » : Auto choisit le plus rapide parmi les modes de la variante
const MODE_GROUPS = [['Le plus rapide', ['auto', 'autovelib', 'nobike']], ['Un seul mode', ['walk', 'bike', 'velib', 'transit']]];
const DEFAULT_MODE = 'autovelib'; // mode d'une nouvelle personne
const MODE_NAMES = { walk: 'marche', bike: 'vélo', velib: "Vélib'", transit: 'transports' };
const LEG_ICONS = { BUS: '🚌', COACH: '🚌', TRAM: '🚊', RAIL: '🚆', REGIONAL_RAIL: '🚆', SUBURBAN: '🚆', HIGHSPEED_RAIL: '🚄', LONG_DISTANCE: '🚄', FERRY: '⛴️', CABLE_CAR: '🚡', FUNICULAR: '🚞' };
const PLACES = {
  // hour : heure d'arrivée proposée ; stay : minutes sur place avant de repartir (heure de retour par défaut).
  // cat / types : catégorie et types Nominatim (secours d'Overpass) ; food : filtres terrasse et végétarien utiles.
  resto:   { icon: '🍽️', filter: '["amenity"="restaurant"]', cat: 'amenity', types: ['restaurant'], words: ['restaurant'], hour: [12, 30], stay: 75, food: true },
  bar:     { icon: '🍺', filter: '["amenity"~"^(bar|pub|biergarten)$"]', cat: 'amenity', types: ['bar', 'pub', 'biergarten'], words: ['bar', 'pub'], hour: [19, 0], stay: 120, food: true },
  cafe:    { icon: '☕', filter: '["amenity"="cafe"]', cat: 'amenity', types: ['cafe'], words: ['café'], hour: [16, 0], stay: 60, food: true },
  park:    { icon: '🌳', filter: '["leisure"="park"]', cat: 'leisure', types: ['park'], words: ['parc', 'jardin', 'square'], hour: [15, 0], stay: 90 },
  // Juste se retrouver (avant d'aller ailleurs ensemble) : gares, stations de métro et de RER
  station: { icon: '🚉', filter: '["railway"~"^(station|halt)$"]', cat: 'railway', types: ['station', 'halt'], words: ['gare', 'station'], hour: [18, 30], stay: 15 },
};
const COLORS = ['#2563eb', '#d97706', '#7c3aed', '#0d9488', '#db2777', '#65a30d'];
const URLS = {
  nominatim: 'https://nominatim.openstreetmap.org',
  photon: 'https://photon.komoot.io',
  overpass: ['https://overpass-api.de/api/interpreter', 'https://maps.mail.ru/osm/tools/overpass/api/interpreter'],
  osrm: { walk: 'https://routing.openstreetmap.de/routed-foot', bike: 'https://routing.openstreetmap.de/routed-bike' },
  transitous: 'https://api.transitous.org/api',
  velib: 'https://opendata.paris.fr/api/explore/v2.1/catalog/datasets/velib-disponibilite-en-temps-reel',
  meteo: 'https://api.open-meteo.com/v1/forecast',
};

// Mode Auto : seuils à vol d'oiseau entre la personne et le point central
const WALK_MAX = 3000;   // au-delà, la marche n'est jamais la plus rapide
const TRANSIT_MIN = 800; // en deçà, marche ou vélo gagnent toujours
// Une correspondance « coûte » 5 min de plus que sa durée réelle : pour choisir les lignes, comparer les modes et classer
const TRANSFER_PENALTY = 5 * 60;
// Pluie probable, mode Auto : une minute à vélo (ou en Vélib') compte pour 1,5 pour choisir le mode et classer
const RAIN_BIKE_FACTOR = 1.5;
// En fauteuil : transports sans métro (presque aucune station accessible à Paris, la 14 exceptée) ; bus et tram le sont
const WHEELCHAIR_TRANSIT = 'TRAM,BUS,FERRY,SUBURBAN,REGIONAL_RAIL';
// min : trajet en transports le plus long cherché par les matrices (attente comprise), comme les 2 h de la marche et du vélo.
// Sans plafond, Transitous met 5 à 7 s par matrice ; avec, 0,5 s, pour les mêmes durées (mesuré le 28/09).
const TRANSIT_MAX_MIN = 120;

// Vélib' : marche jusqu'à une station avec des vélos, vélo, marche depuis une station avec des places
const VELIB_MAX_WALK = 600;     // m : station la plus loin qu'on accepte de rejoindre à pied, au départ comme à l'arrivée
const VELIB_MIN_BIKES = 2, VELIB_MIN_DOCKS = 4; // marge : un vélo peut être en panne, les places partent vite
const VELIB_OVERHEAD = 2 * 60;  // s : prendre le vélo à la borne, puis le reposer
const WALK_STRAIGHT_SPEED = 1.0; // m/s à vol d'oiseau (≈ 4,3 km/h avec les détours), pour ces petites marches

// Zone équitable
const GRID_N = 7;            // grille GRID_N × GRID_N ; impair, donc le point du milieu est le point central
const GRID_SPREAD = 0.7;     // demi-côté de la grille = GRID_SPREAD × distance max au point central
const GRID_MIN_HALF = 600;   // m
const FAIR_MARGIN = 5 * 60;  // s : la zone équitable (affichée) va du meilleur point jusqu'à +5 min
const CORE_MARGIN = 2 * 60;  // s : on cherche les lieux au cœur de la zone (+2 min), élargi s'il y en a trop peu
const BOX_MAX_HALF = 1200;   // m : taille max de la zone où l'on cherche des lieux
const MAX_PLACES = 1000;     // plafond Overpass : au-delà il renvoie les premiers par numéro, pas les mieux placés
const MIN_PLACES = 8;        // en dessous, on élargit la recherche une fois
const PARK_TINY = 2000;      // m² (rectangle englobant) : en dessous, un « parc » n'est qu'un square minuscule

// Sélection
const STAY_MIN = 60;         // min : le lieu doit rester ouvert au moins ça après l'arrivée
const N_CANDIDATES = 15, N_SHOWN = 5;
const MIN_GAP = 120;         // m minimum entre deux candidats
const MAX_SAME_CUISINE = { candidates: 5, shown: 2 };

const CUISINES = {
  french: 'française', italian: 'italienne', pizza: 'pizza', japanese: 'japonaise', sushi: 'sushi', ramen: 'ramen',
  chinese: 'chinoise', asian: 'asiatique', thai: 'thaï', vietnamese: 'vietnamienne', korean: 'coréenne', indian: 'indienne',
  lebanese: 'libanaise', mediterranean: 'méditerranéenne', greek: 'grecque', spanish: 'espagnole', tapas: 'tapas',
  mexican: 'mexicaine', burger: 'burgers', american: 'américaine', african: 'africaine', moroccan: 'marocaine',
  couscous: 'couscous', turkish: 'turque', kebab: 'kebab', seafood: 'fruits de mer', vegetarian: 'végétarienne',
  vegan: 'vegan', regional: 'régionale', crepe: 'crêpes', breton: 'bretonne', brasserie: 'brasserie', bistro: 'bistrot',
  steak_house: 'grill', peruvian: 'péruvienne', ethiopian: 'éthiopienne', portuguese: 'portugaise', georgian: 'géorgienne',
  israeli: 'israélienne', middle_eastern: 'orientale', coffee_shop: 'coffee shop', cake: 'pâtisserie', ice_cream: 'glaces',
  sandwich: 'sandwichs', bagel: 'bagels', noodle: 'nouilles', dumpling: 'raviolis', cocktails: 'cocktails', wine: 'vin',
  beer: 'bière', salad: 'salades', poke: 'poké', fish: 'poisson', international: 'internationale', fusion: 'fusion',
  traditional: 'traditionnelle', fine_dining: 'gastronomique', local: 'locale', brunch: 'brunch', breakfast: 'petit-déj',
  tea: 'thé', coffee: 'café', bubble_tea: 'bubble tea', caribbean: 'antillaise', brazilian: 'brésilienne',
  argentinian: 'argentine', hawaiian: 'hawaïenne', pakistani: 'pakistanaise', nepalese: 'népalaise', tibetan: 'tibétaine',
  cambodian: 'cambodgienne', laotian: 'laotienne', taiwanese: 'taïwanaise', cantonese: 'cantonaise', sichuan: 'sichuanaise',
  chicken: 'poulet', fried_chicken: 'poulet frit', savoyard: 'savoyarde', alsatian: 'alsacienne', basque: 'basque',
  corsican: 'corse', provencal: 'provençale', kurdish: 'kurde', polish: 'polonaise', russian: 'russe', ukrainian: 'ukrainienne',
  uyghur: 'ouïghoure', hot_pot: 'fondue chinoise', '火鍋': 'fondue chinoise', dim_sum: 'dim sum', crêpe: 'crêpes',
  senegalese: 'sénégalaise', algerian: 'algérienne', tunisian: 'tunisienne', syrian: 'syrienne', iranian: 'iranienne', persian: 'persane',
};

const $ = id => document.getElementById(id);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const letter = i => String.fromCharCode(65 + i);
const color = i => COLORS[i % COLORS.length];
const fmt = s => s == null || !isFinite(s) ? '—' : `${Math.round(s / 60)} min`;
// Temps restant d'une tâche en cours, au rythme observé jusqu'ici : « environ 40 s », « environ 2 min » ; '' trop tôt pour le dire
function remainingText(done, total, elapsedMs) {
  if (done < 2 || done >= total) return '';
  const s = elapsedMs / 1000 / done * (total - done);
  return s < 15 ? 'quelques secondes' : s < 50 ? `environ ${Math.round(s / 10) * 10} s` : `environ ${Math.round(s / 60)} min`;
}
const hhmm = t => new Date(t).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const label = p => p.name || letter(p.i);
// Icône d'un mode pour une personne (en fauteuil, « à pied » se dit « en fauteuil ») et mot du trajet sans transports
const modeIcon = (p, m) => m === 'walk' && p.wheelchair ? '♿' : MODES[m].icon;
const onFoot = (p, m = 'walk') => m === 'bike' ? 'à vélo' : p.wheelchair ? 'en fauteuil' : 'à pied';
const lineName = l => l.routeShortName || l.displayName || l.mode;
const addressOf = t => [t['addr:housenumber'], t['addr:street'], t['addr:postcode'], t['addr:city']].filter(Boolean).join(' ');
// Recherche Google Maps du lieu : fiche, avis, itinéraire sur le téléphone de chacun.
// Parenthèses et apostrophes encodées aussi : dans un message, certains détecteurs de liens s'y arrêtent.
const urlPart = s => encodeURIComponent(s).replace(/[()'!*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const placeSearchUrl = c => `https://www.google.com/maps/search/?api=1&query=${urlPart(`${c.name} ${addressOf(c.tags) || `${c.lat},${c.lon}`}`)}`;
