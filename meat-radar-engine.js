const crypto = require("crypto");

const RADIUS_KM = 30;
const OV_MINT = "2EN6Y1zM4yyt41gE2muzdJSAgRCAZiXqnmkgpbrspump";
const DSN_MINT = "35w74RT77BPSYNpmzpvxmR9wu2ihpgzubKy4bkGHR3F4";

function toRad(deg) {
  return (deg * Math.PI) / 180;
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  return R * (2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

function ensureDB(db) {
  if (!db.users || typeof db.users !== "object") db.users = {};
  if (!db.meatSignals || typeof db.meatSignals !== "object") db.meatSignals = {};
}

function registerMeatPulse(db, userKey, payload = {}) {
  ensureDB(db);
  const user = db.users[userKey];
  if (!user || !user.ovId) {
    return { ok: false, error: "Identità $OV assente. Forgia prima con !forge." };
  }

  const lat = Number(payload.lat);
  const lon = Number(payload.lon);
  if (Number.isNaN(lat) || Number.isNaN(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    return { ok: false, error: "Coordinate non valide. Usa !pulse <lat> <lon> [ruolo] [modalita]." };
  }

  const role = String(payload.role || user.meatRole || "Sottomesso / Sub").slice(0, 40);
  const mode = String(payload.mode || "WA-LIVE + IRL-30KM").slice(0, 40);

  user.optOutProximity = false;
  user.meatRole = role;
  user.location = {
    lat: Number(lat.toFixed(2)),
    lon: Number(lon.toFixed(2)),
    sessionMode: mode,
    radiusKm: RADIUS_KM,
    updatedAt: new Date().toISOString()
  };

  return {
    ok: true,
    ovId: user.ovId,
    role,
    mode,
    location: user.location
  };
}

function scanMeatRadar(db, requesterKey, radiusKm = RADIUS_KM) {
  ensureDB(db);
  const reqUser = db.users[requesterKey];
  if (!reqUser || !reqUser.location) {
    return { ok: false, error: "Segnale carne non attivo. Invia !pulse <lat> <lon> [ruolo]." };
  }

  const targets = [];
  for (const [key, u] of Object.entries(db.users)) {
    if (key === requesterKey) continue;
    if (!u || !u.ovId || !u.location || u.optOutProximity === true) continue;

    const dist = haversineKm(
      reqUser.location.lat,
      reqUser.location.lon,
      u.location.lat,
      u.location.lon
    );

    if (dist <= radiusKm) {
      targets.push({
        userKey: key,
        ovId: u.ovId,
        role: u.meatRole || u.rank || "Citizen 18+",
        mode: u.location.sessionMode || "WA-LIVE + IRL-30KM",
        devotion: Number(u.devotion || 0),
        distanceKm: Number(dist.toFixed(1)),
        verified: Boolean(u.verified || u.status === "VERIFIED"),
        lastPulse: u.location.updatedAt || null
      });
    }
  }

  targets.sort((a, b) => a.distanceKm - b.distanceKm || b.devotion - a.devotion);
  return { ok: true, radiusKm, count: targets.length, targets };
}

function scanByOvId(db, ovId, radiusKm = RADIUS_KM) {
  ensureDB(db);
  const entry = Object.entries(db.users).find(
    ([, u]) => u && String(u.ovId).toUpperCase() === String(ovId || "").trim().toUpperCase()
  );
  if (!entry) return { ok: false, error: "Sigillo $OV non registrato nel Nexus." };
  return scanMeatRadar(db, entry[0], radiusKm);
}

function lockMeatSignal(db, hostKey, targetOvId, protocol = "Sottomissione Diretta WA / 30km") {
  ensureDB(db);
  const host = db.users[hostKey];
  if (!host || !host.ovId || !host.location) {
    return { ok: false, error: "Attiva prima il tuo segnale con !pulse <lat> <lon>." };
  }

  const targetEntry = Object.entries(db.users).find(
    ([k, u]) => k !== hostKey && u && String(u.ovId).toUpperCase() === String(targetOvId || "").trim().toUpperCase()
  );
  if (!targetEntry) {
    return { ok: false, error: `Target ${targetOvId} non trovato.` };
  }

  const [targetKey, target] = targetEntry;
  if (!target.location) {
    return { ok: false, error: `Target ${target.ovId} non ha un segnale radar attivo.` };
  }

  const dist = haversineKm(
    host.location.lat,
    host.location.lon,
    target.location.lat,
    target.location.lon
  );
  if (dist > RADIUS_KM) {
    return { ok: false, error: `Target fuori raggio (${dist.toFixed(1)} km > ${RADIUS_KM} km).` };
  }

  const signalId = "MEAT-" + crypto.randomBytes(3).toString("hex").toUpperCase();
  const record = {
    id: signalId,
    hostKey,
    hostOvId: host.ovId,
    hostRole: host.meatRole || "Sovereign",
    targetKey,
    targetOvId: target.ovId,
    targetRole: target.meatRole || "Sub",
    distanceKm: Number(dist.toFixed(1)),
    protocol: String(protocol).slice(0, 90),
    status: "awaiting_consent",
    consent18Plus: true,
    createdAt: new Date().toISOString()
  };

  db.meatSignals[signalId] = record;
  return { ok: true, signal: record };
}

function confirmMeatSignal(db, respondentKey, signalId, accept = true) {
  ensureDB(db);
  const sig = db.meatSignals[String(signalId || "").trim().toUpperCase()];
  if (!sig) return { ok: false, error: "Segnale non trovato." };
  if (sig.targetKey !== respondentKey && sig.hostKey !== respondentKey) {
    return { ok: false, error: "Non autorizzato su questo segnale." };
  }
  if (sig.status !== "awaiting_consent") {
    return { ok: false, error: `Segnale già chiuso (${sig.status}).` };
  }

  sig.status = accept ? "locked_live" : "aborted";
  sig.updatedAt = new Date().toISOString();
  return { ok: true, signal: sig };
}

function getRadarTelemetry(db) {
  ensureDB(db);
  const allUsers = Object.values(db.users);
  const activeNodes = allUsers.filter(u => u && u.ovId && u.location && !u.optOutProximity);
  const activeSignals = Object.values(db.meatSignals).filter(s => s && s.status === "locked_live");
  return {
    ok: true,
    engine: "MEAT_RADAR_V2_SOVEREIGN",
    radiusKm: RADIUS_KM,
    tokens: { OV: OV_MINT, DSN: DSN_MINT },
    totalIdentities: allUsers.length,
    activeRadarNodes: activeNodes.length,
    liveLockedConnections: activeSignals.length
  };
}

module.exports = {
  RADIUS_KM,
  OV_MINT,
  DSN_MINT,
  registerMeatPulse,
  scanMeatRadar,
  scanByOvId,
  lockMeatSignal,
  confirmMeatSignal,
  getRadarTelemetry
};
