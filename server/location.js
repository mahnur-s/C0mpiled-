// Where the senior's phone is: stored every sync (when they allowed location), compared with "home".
// Home comes from geocoding their address with OpenStreetMap Nominatim, or from the phone's position.
const MIN = 60000;
const STALE_MS = 60 * MIN;
const KEEP_DAYS = 30;

function distanceM(aLat, aLng, bLat, bLng) {
  const r = (x) => (x * Math.PI) / 180;
  const h = Math.sin(r(bLat - aLat) / 2) ** 2 + Math.cos(r(aLat)) * Math.cos(r(bLat)) * Math.sin(r(bLng - aLng) / 2) ** 2;
  return Math.round(2 * 6371000 * Math.asin(Math.sqrt(h)));
}

function recordLocation(db, seniorId, loc, now) {
  if (!loc || typeof loc !== 'object') return null;
  const { lat, lng } = loc;
  const at = Number.isFinite(loc.at) ? Math.min(loc.at, now) : now;
  const accuracy = Number.isFinite(loc.accuracy) ? Math.max(0, loc.accuracy) : null;
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  if (at < now - 2 * 3600000 || (accuracy !== null && accuracy > 5000)) return null;
  db.prepare('INSERT OR REPLACE INTO locations (senior_id, at, lat, lng, accuracy) VALUES (?, ?, ?, ?, ?)')
    .run(seniorId, at, Math.round(lat * 1e5) / 1e5, Math.round(lng * 1e5) / 1e5, accuracy);
  return at;
}

const isHome = (s, p) => s.home_lat != null
  && distanceM(s.home_lat, s.home_lng, p.lat, p.lng) <= Math.max(s.home_radius_m, Math.min(p.accuracy || 0, 400));

/** Latest position and whether that's home. null when the phone has never shared a location. */
function locationStatus(db, s, now) {
  const p = db.prepare('SELECT * FROM locations WHERE senior_id = ? ORDER BY at DESC LIMIT 1').get(s.id);
  if (!p) return null;
  const out = { lat: p.lat, lng: p.lng, accuracy: p.accuracy, at: p.at, stale: now - p.at > STALE_MS, homeSet: s.home_lat != null };
  if (!out.homeSet) return out;
  out.home = { lat: s.home_lat, lng: s.home_lng, radius: s.home_radius_m };
  out.distanceM = distanceM(s.home_lat, s.home_lng, p.lat, p.lng);
  out.atHome = isHome(s, p);
  // Since when: walk back to the last point with the other state.
  const flip = db.prepare('SELECT at, lat, lng, accuracy FROM locations WHERE senior_id = ? AND at > ? ORDER BY at DESC').all(s.id, now - 3 * 86400000)
    .find((q) => isHome(s, q) !== out.atHome);
  const firstSame = flip
    ? db.prepare('SELECT MIN(at) AS at FROM locations WHERE senior_id = ? AND at > ?').get(s.id, flip.at).at
    : null;
  out.since = firstSame;
  return out;
}

/** Per local day: minutes away from home and number of outings (each point ~ one 15-minute sync). */
function awayByDay(db, s, fromMs, dayOf) {
  if (s.home_lat == null) return {};
  const out = {};
  let wasAway = false;
  let prevAt = null;
  for (const p of db.prepare('SELECT * FROM locations WHERE senior_id = ? AND at >= ? ORDER BY at').all(s.id, fromMs)) {
    const day = dayOf(p.at);
    const d = (out[day] ||= { awayMinutes: 0, outings: 0, points: 0 });
    d.points += 1;
    const away = !isHome(s, p);
    if (away && prevAt !== null && wasAway) d.awayMinutes += Math.min(30, Math.round((p.at - prevAt) / MIN));
    if (away && !wasAway) d.outings += 1;
    wasAway = away;
    prevAt = p.at;
  }
  return out;
}

// OpenStreetMap Nominatim (free, 1 request/second, needs a real User-Agent). Returns {lat, lng} or null.
async function geocode(address, fetchImpl = fetch) {
  if (!address || !address.trim()) return null;
  try {
    const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(address)}`;
    const r = await fetchImpl(url, { headers: { 'User-Agent': 'Haru-elder-safety/2.0 (self-hosted pilot)' }, signal: AbortSignal.timeout(10000) });
    if (!r.ok) return null;
    const [hit] = await r.json();
    return hit ? { lat: Number(hit.lat), lng: Number(hit.lon) } : null;
  } catch (e) {
    console.warn('Geocoding failed:', e.message);
    return null;
  }
}

const mapLink = (lat, lng) => `https://www.google.com/maps?q=${lat},${lng}`;

function purgeLocations(db, now) {
  db.prepare('DELETE FROM locations WHERE at < ?').run(now - KEEP_DAYS * 86400000);
}

module.exports = { distanceM, recordLocation, locationStatus, awayByDay, geocode, mapLink, purgeLocations };
