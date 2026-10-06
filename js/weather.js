// Météo pure (ni DOM ni réseau), testée dans tests.html. Codes WMO d'Open-Meteo.

function weatherIcon(code, day = true) {
  if (code >= 95) return '⛈️';
  if (code >= 85) return '🌨️';
  if (code >= 80) return '🌦️';
  if (code >= 71) return '🌨️';
  if (code >= 61) return '🌧️';
  if (code >= 51) return '🌦️';
  if (code >= 45) return '🌫️';
  if (code === 3) return '☁️';
  if (code >= 1) return day ? '⛅' : '☁️';
  return day ? '☀️' : '🌙';
}

// Temps pendant la sortie (de l'arrivée à `stayMin` minutes après), d'après les prévisions horaires `h`.
// → { icon, temp (à l'arrivée), prob (risque max, %), mm (cumul), level: 'dry' | 'maybe' | 'wet' } ou null
function weatherAt(h, arrive, stayMin) {
  if (!h || !h.time) return null;
  const t0 = arrive.getTime() / 1000, t1 = t0 + stayMin * 60;
  const idx = h.time.map((_, k) => k).filter(k => h.time[k] + 3600 > t0 && h.time[k] < t1);
  if (!idx.length) return null;
  const at = idx[0];
  const prob = Math.max(...idx.map(k => h.precipitation_probability[k] ?? 0));
  const mm = idx.reduce((s, k) => s + (h.precipitation[k] || 0), 0);
  const level = prob >= 60 || mm >= 1 ? 'wet' : prob >= 30 || mm >= 0.2 ? 'maybe' : 'dry';
  // Pluie annoncée pendant la sortie : c'est elle qu'on montre, même s'il fait beau à l'arrivée
  const code = level === 'dry' ? h.weather_code[at] : Math.max(...idx.map(k => h.weather_code[k]));
  return { icon: weatherIcon(code, h.is_day ? !!h.is_day[at] : true), temp: h.temperature_2m[at], prob, mm, level };
}

function weatherText(w) {
  const sky = { dry: 'sec', maybe: `risque d'averse (${w.prob} %)`, wet: `pluie probable (${w.prob} %)` }[w.level];
  return `${w.icon} ${Math.round(w.temp)} °C, ${sky}`;
}
