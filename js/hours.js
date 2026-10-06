// Horaires d'ouverture OSM, lus par la bibliothèque opening_hours (chargée depuis jsdelivr, suncalc avant elle).

const hoursLibReady = () => typeof opening_hours === 'function';

// Le lieu est-il ouvert à l'arrivée et encore `stay` minutes après ?
// → { status: 'open' | 'closed' | 'unknown', closes?: Date, early?: true (ouvert, mais ferme trop tôt) }
function hoursAt(value, arrive, where, stay = STAY_MIN) {
  if (!value || !hoursLibReady()) return { status: 'unknown' };
  try {
    // Sans pays ni région, les « PH off » (jours fériés) font échouer la lecture
    const oh = new opening_hours(value, {
      lat: where ? where.lat : 48.86, lon: where ? where.lon : 2.35,
      address: { country_code: 'fr', state: 'Île-de-France' },
    }, { mode: 0 });
    if (oh.getUnknown(arrive)) return { status: 'unknown' };
    if (!oh.getState(arrive)) return { status: 'closed' };
    const next = oh.getNextChange(arrive, new Date(arrive.getTime() + 7 * 864e5)) || null;
    if (next && next - arrive < stay * 60e3) return { status: 'closed', closes: next, early: true };
    return { status: 'open', closes: next };
  } catch {
    return { status: 'unknown' };
  }
}
