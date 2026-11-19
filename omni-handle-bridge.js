const crypto = require("crypto");

function normalizeHandle(h) {
  if (!h) return null;
  const clean = String(h).trim().replace(/^@+/, "").replace(/[^a-zA-Z0-9_.-]/g, "");
  return clean ? "@" + clean : null;
}

function normalizeOv(ov) {
  if (!ov) return null;
  let v = String(ov).trim().toUpperCase().replace(/[^A-Z0-9-]/g, "");
  if (/^[A-Z0-9]{4}$/.test(v)) v = "OV-" + v + "-VELVET";
  return v || null;
}

function ensureBridgeStore(db) {
  if (!db.users || typeof db.users !== "object") db.users = {};
  if (!db.handleLinks || typeof db.handleLinks !== "object") db.handleLinks = {};
  if (!db.bridgeQueue || typeof db.bridgeQueue !== "object") {
    db.bridgeQueue = { xOutbox: [], history: [] };
  }
  if (!Array.isArray(db.bridgeQueue.xOutbox)) db.bridgeQueue.xOutbox = [];
  if (!Array.isArray(db.bridgeQueue.history)) db.bridgeQueue.history = [];
}

function findOrCreateIdentity(db, { ovId, xHandle, waPhone, waJid, tgUser, tgChatId }) {
  ensureBridgeStore(db);
  const normOv = normalizeOv(ovId);
  const normX = normalizeHandle(xHandle);
  const normTg = normalizeHandle(tgUser);
  const cleanWa = waPhone ? String(waPhone).replace(/[^0-9+]/g, "") : null;

  let matchedKey = null;

  for (const [k, u] of Object.entries(db.users)) {
    if (!u || typeof u !== "object") continue;
    const ch = u.channels || {};
    if (
      (normOv && u.ovId && String(u.ovId).toUpperCase() === normOv) ||
      (normX && ch.xHandle && String(ch.xHandle).toLowerCase() === normX.toLowerCase()) ||
      (cleanWa && ch.waPhone && ch.waPhone === cleanWa) ||
      (waJid && ch.waJid && ch.waJid === waJid) ||
      (normTg && ch.tgUser && String(ch.tgUser).toLowerCase() === normTg.toLowerCase()) ||
      (tgChatId && ch.tgChatId && String(ch.tgChatId) === String(tgChatId))
    ) {
      matchedKey = k;
      break;
    }
  }

  if (!matchedKey) {
    matchedKey = waJid || (normX ? `x:${normX.toLowerCase()}` : (normTg ? `tg:${normTg.toLowerCase()}` : `ov:${normOv || crypto.randomBytes(3).toString("hex")}`));
  }

  if (!db.users[matchedKey]) {
    db.users[matchedKey] = {
      ovId: normOv || ("OV-" + crypto.randomBytes(2).toString("hex").toUpperCase() + "-VELVET"),
      status: "VERIFIED",
      rank: "Citizen 18+",
      devotion: 10,
      createdAt: new Date().toISOString()
    };
  }

  const user = db.users[matchedKey];
  if (normOv) user.ovId = normOv;

  user.channels = Object.assign({}, user.channels || {}, {
    xHandle: normX || user.channels?.xHandle || null,
    waPhone: cleanWa || user.channels?.waPhone || null,
    waJid: waJid || user.channels?.waJid || null,
    tgUser: normTg || user.channels?.tgUser || null,
    tgChatId: tgChatId ? String(tgChatId) : (user.channels?.tgChatId || null),
    updatedAt: new Date().toISOString()
  });

  const linkToken = "BRG-" + crypto.createHash("sha256").update(matchedKey + ":" + user.ovId).digest("hex").slice(0, 8).toUpperCase();
  user.bridgeToken = linkToken;

  if (normX) db.handleLinks[normX.toLowerCase()] = matchedKey;
  if (normTg) db.handleLinks[normTg.toLowerCase()] = matchedKey;
  if (cleanWa) db.handleLinks[cleanWa] = matchedKey;
  if (user.ovId) db.handleLinks[user.ovId.toUpperCase()] = matchedKey;

  return { ok: true, userKey: matchedKey, user };
}

function resolveUserByAnyId(db, idOrHandle) {
  ensureBridgeStore(db);
  if (!idOrHandle) return null;
  const raw = String(idOrHandle).trim();
  const candidates = [
    raw,
    raw.toLowerCase(),
    raw.toUpperCase(),
    normalizeHandle(raw)?.toLowerCase(),
    normalizeOv(raw)
  ].filter(Boolean);

  for (const c of candidates) {
    if (db.handleLinks[c] && db.users[db.handleLinks[c]]) {
      return { userKey: db.handleLinks[c], user: db.users[db.handleLinks[c]] };
    }
  }

  for (const [k, u] of Object.entries(db.users)) {
    if (!u) continue;
    const ch = u.channels || {};
    const vals = [u.ovId, ch.xHandle, ch.waPhone, ch.waJid, ch.tgUser, ch.tgChatId].filter(Boolean).map(v => String(v).toLowerCase());
    if (candidates.some(c => vals.includes(String(c).toLowerCase()))) {
      return { userKey: k, user: u };
    }
  }
  return null;
}

async function dispatchUnifiedMessage(db, { sock, tg, fromId, toId, targets = ["whatsapp", "telegram", "x"], message }) {
  ensureBridgeStore(db);
  const text = String(message || "").trim();
  if (!text) return { ok: false, error: "Messaggio vuoto." };

  const senderObj = fromId ? resolveUserByAnyId(db, fromId) : null;
  const targetObj = toId ? resolveUserByAnyId(db, toId) : null;
  const headerPrefix = senderObj
    ? `[BRIDGE ${senderObj.user.ovId}${senderObj.user.channels?.xHandle ? " · " + senderObj.user.channels.xHandle : ""}] `
    : "";
  const payloadText = headerPrefix + text;

  const delivery = {
    id: "MSG-" + crypto.randomBytes(3).toString("hex").toUpperCase(),
    from: senderObj?.user?.ovId || fromId || "NEXUS",
    to: targetObj?.user?.ovId || toId || "BROADCAST",
    targets,
    results: {},
    timestamp: new Date().toISOString()
  };

  if (targets.includes("whatsapp")) {
    const waDest = targetObj?.user?.channels?.waJid || (targetObj?.user?.channels?.waPhone ? targetObj.user.channels.waPhone.replace(/[^0-9]/g, "") + "@s.whatsapp.net" : null);
    if (sock && waDest) {
      try {
        await sock.sendMessage(waDest, { text: payloadText });
        delivery.results.whatsapp = "sent:" + waDest;
      } catch (e) {
        delivery.results.whatsapp = "error:" + e.message;
      }
    } else {
      delivery.results.whatsapp = sock ? "no_target_wa" : "wa_socket_offline";
    }
  }

  if (targets.includes("telegram")) {
    const tgDest = targetObj?.user?.channels?.tgChatId || process.env.TELEGRAM_CHANNEL || null;
    if (tg && tgDest) {
      try {
        await tg.sendMessage(tgDest, payloadText);
        delivery.results.telegram = "sent:" + tgDest;
      } catch (e) {
        delivery.results.telegram = "error:" + e.message;
      }
    } else {
      delivery.results.telegram = tg ? "no_target_tg" : "tg_bot_offline";
    }
  }

  if (targets.includes("x")) {
    const xItem = {
      id: delivery.id,
      handle: targetObj?.user?.channels?.xHandle || senderObj?.user?.channels?.xHandle || null,
      text: payloadText.slice(0, 275),
      createdAt: delivery.timestamp,
      status: "queued_for_x"
    };
    db.bridgeQueue.xOutbox.push(xItem);
    if (db.bridgeQueue.xOutbox.length > 200) db.bridgeQueue.xOutbox.shift();
    delivery.results.x = "queued:" + xItem.id;
  }

  db.bridgeQueue.history.push(delivery);
  if (db.bridgeQueue.history.length > 300) db.bridgeQueue.history.shift();

  return { ok: true, delivery };
}

function getBridgeSnapshot(db) {
  ensureBridgeStore(db);
  const linkedProfiles = Object.entries(db.users)
    .filter(([, u]) => u && u.channels && (u.channels.xHandle || u.channels.waPhone || u.channels.tgUser))
    .map(([key, u]) => ({
      userKey: key,
      ovId: u.ovId,
      rank: u.rank || "Citizen 18+",
      xHandle: u.channels.xHandle || null,
      waPhone: u.channels.waPhone || null,
      tgUser: u.channels.tgUser || null,
      bridgeToken: u.bridgeToken || null
    }));

  return {
    ok: true,
    bridge: "OMNI_HANDLE_BRIDGE_X_WA_TG",
    linkedCount: linkedProfiles.length,
    xOutboxCount: db.bridgeQueue.xOutbox.length,
    profiles: linkedProfiles,
    pendingXPosts: db.bridgeQueue.xOutbox.slice(-10)
  };
}

module.exports = {
  normalizeHandle,
  normalizeOv,
  findOrCreateIdentity,
  resolveUserByAnyId,
  dispatchUnifiedMessage,
  getBridgeSnapshot
};
