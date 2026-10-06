// Géométrie pure (ni DOM ni réseau), testée dans tests.html.

// Distance en mètres (approximation équirectangulaire, suffisante à l'échelle d'une ville)
function dist(a, b) {
  const k = Math.PI / 180, x = (b.lon - a.lon) * k * Math.cos((a.lat + b.lat) / 2 * k), y = (b.lat - a.lat) * k;
  return Math.hypot(x, y) * 6371000;
}

function metersToDeg(lat, m) {
  const dLat = m / 111320;
  return { dLat, dLon: dLat / Math.cos(lat * Math.PI / 180) };
}

// Grille n × n centrée sur `center`, de demi-côté `half` mètres.
// Points rangés ligne par ligne, du sud au nord puis d'ouest en est : points[r * n + c].
function makeGrid(center, half, n = GRID_N) {
  const { dLat, dLon } = metersToDeg(center.lat, half);
  const stepLat = 2 * dLat / (n - 1), stepLon = 2 * dLon / (n - 1);
  const lat0 = center.lat - dLat, lon0 = center.lon - dLon;
  const points = [];
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) points.push({ lat: lat0 + r * stepLat, lon: lon0 + c * stepLon });
  return { n, lat0, lon0, stepLat, stepLon, stepM: 2 * half / (n - 1), points };
}

// Valeur en `p` interpolée (bilinéaire) depuis les valeurs aux points de la grille.
// Les coins sans valeur (null / Infinity) sont ignorés ; hors de la grille, on prend le bord.
function interpolate(grid, values, p) {
  const { n, lat0, lon0, stepLat, stepLon } = grid;
  const y = Math.min(Math.max((p.lat - lat0) / stepLat, 0), n - 1);
  const x = Math.min(Math.max((p.lon - lon0) / stepLon, 0), n - 1);
  const r0 = Math.min(Math.floor(y), n - 2), c0 = Math.min(Math.floor(x), n - 2);
  const fy = y - r0, fx = x - c0;
  let sum = 0, wsum = 0;
  const known = [];
  for (const [r, c, w] of [[r0, c0, (1 - fy) * (1 - fx)], [r0, c0 + 1, (1 - fy) * fx], [r0 + 1, c0, fy * (1 - fx)], [r0 + 1, c0 + 1, fy * fx]]) {
    const v = values[r * n + c];
    if (v == null || !isFinite(v)) continue;
    known.push(v);
    sum += v * w;
    wsum += w;
  }
  if (wsum > 0) return sum / wsum;
  // Pile sur un point sans valeur : moyenne des voisins connus
  return known.length ? known.reduce((a, b) => a + b, 0) / known.length : Infinity;
}

// Rectangles { s, w, n, e } (degrés)
function bbox(points, margin = 0) {
  const lats = points.map(p => p.lat), lons = points.map(p => p.lon);
  const s = Math.min(...lats), n = Math.max(...lats), w = Math.min(...lons), e = Math.max(...lons);
  const { dLat, dLon } = metersToDeg((s + n) / 2, margin);
  return { s: s - dLat, w: w - dLon, n: n + dLat, e: e + dLon };
}
function boxAround(p, half) {
  const { dLat, dLon } = metersToDeg(p.lat, half);
  return { s: p.lat - dLat, w: p.lon - dLon, n: p.lat + dLat, e: p.lon + dLon };
}
// Demi-côté du plus grand côté, en mètres
function boxHalf(b) {
  return Math.max(dist({ lat: b.s, lon: b.w }, { lat: b.n, lon: b.w }), dist({ lat: b.s, lon: b.w }, { lat: b.s, lon: b.e })) / 2;
}
// Surface d'un rectangle en m² (sert d'ordre de grandeur pour la taille d'un parc)
function boxArea(b) {
  return dist({ lat: b.s, lon: b.w }, { lat: b.n, lon: b.w }) * dist({ lat: b.s, lon: b.w }, { lat: b.s, lon: b.e });
}
function growBox(b, f) {
  const cl = (b.s + b.n) / 2, cw = (b.w + b.e) / 2;
  return { s: cl - (cl - b.s) * f, n: cl + (b.n - cl) * f, w: cw - (cw - b.w) * f, e: cw + (b.e - cw) * f };
}

// Polyline encodée (format Google) ; précision 6 ou 7 chez Transitous. Pas d'opérations bit à bit : ça déborde en précision 7.
function decodePolyline(str, precision = 5) {
  const f = 10 ** precision, out = [];
  let i = 0, lat = 0, lon = 0;
  while (i < str.length) {
    for (const k of [0, 1]) {
      let result = 0, shift = 0, b;
      do { b = str.charCodeAt(i++) - 63; result += (b % 32) * 2 ** shift; shift += 5; } while (b >= 32);
      const d = result % 2 ? -(result + 1) / 2 : result / 2;
      if (k === 0) lat += d; else lon += d;
    }
    out.push([lat / f, lon / f]);
  }
  return out;
}
