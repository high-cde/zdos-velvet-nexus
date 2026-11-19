const crypto = require("crypto");

const OV_MINT = "2EN6Y1zM4yyt41gE2muzdJSAgRCAZiXqnmkgpbrspump";
const DSN_MINT = "35w74RT77BPSYNpmzpvxmR9wu2ihpgzubKy4bkGHR3F4";
const TREASURY_WALLET = "6C61wDacAtx3QHQYVw17fnm5GEaEAnc1XienNJKn2bsD";
const SOLANA_RPC = "https://api.mainnet-beta.solana.com";

function isValidSolanaPubkey(addr) {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(String(addr || "").trim());
}

function deriveFourCharCode(seed) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const digest = crypto.createHash("sha256").update(String(seed)).digest();
  let code = "";
  for (let i = 0; i < 4; i++) {
    code += alphabet[digest[i] % alphabet.length];
  }
  return code;
}

async function checkSolanaAttestation(wallet, txSignature = null) {
  const result = {
    rpcReachable: false,
    ovBalance: 0,
    dsnBalance: 0,
    txVerified: false,
    tier: "SOVEREIGN_CITIZEN"
  };

  if (!isValidSolanaPubkey(wallet)) return result;

  try {
    // 1. Verifica token accounts per $OV e $DSN
    const resp = await fetch(SOLANA_RPC, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getTokenAccountsByOwner",
        params: [
          wallet,
          { programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" },
          { encoding: "jsonParsed" }
        ]
      })
    });
    const json = await resp.json();
    if (json && json.result && Array.isArray(json.result.value)) {
      result.rpcReachable = true;
      for (const acc of json.result.value) {
        const info = acc?.account?.data?.parsed?.info;
        if (!info) continue;
        const amt = Number(info?.tokenAmount?.uiAmount || 0);
        if (info.mint === OV_MINT) result.ovBalance += amt;
        if (info.mint === DSN_MINT) result.dsnBalance += amt;
      }
    }

    // 2. Verifica eventuale firma transazione o ultime transazioni verso la tesoreria
    if (txSignature && String(txSignature).trim().length >= 64) {
      const txResp = await fetch(SOLANA_RPC, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "getSignatureStatuses",
          params: [[String(txSignature).trim()], { searchTransactionHistory: true }]
        })
      });
      const txJson = await txResp.json();
      const st = txJson?.result?.value?.[0];
      if (st && !st.err) {
        result.txVerified = true;
      }
    }

    if (result.ovBalance > 0 || result.dsnBalance > 0 || result.txVerified) {
      result.tier = "ONCHAIN_VERIFIED_HOLDER";
    }
  } catch (e) {
    result.rpcError = e.message;
  }

  return result;
}

async function issueGlobalRealId(db, params = {}) {
  if (!db.users || typeof db.users !== "object") db.users = {};
  if (!db.handleLinks || typeof db.handleLinks !== "object") db.handleLinks = {};

  const wallet = String(params.wallet || "").trim();
  const xHandle = params.xHandle ? "@" + String(params.xHandle).trim().replace(/^@+/, "") : null;
  const waPhone = params.waPhone ? String(params.waPhone).trim().replace(/[^0-9+]/g, "") : null;
  const tgUser = params.tgUser ? "@" + String(params.tgUser).trim().replace(/^@+/, "") : null;
  const role = String(params.role || "Citizen 18+").trim().slice(0, 40);
  const txSignature = params.txSignature ? String(params.txSignature).trim() : null;
  const consent18Plus = params.consent18Plus !== false;

  if (!consent18Plus) {
    return { ok: false, error: "Consenso esplicito 18+ obbligatorio per emettere l'ID Globale Reale." };
  }

  if (!wallet && !waPhone && !xHandle && !tgUser) {
    return { ok: false, error: "Inserisci almeno il Wallet Solana (consigliato) o un handle reale (WhatsApp / X / Telegram)." };
  }

  if (wallet && !isValidSolanaPubkey(wallet)) {
    return { ok: false, error: "Indirizzo Wallet Solana non valido." };
  }

  // Cerca se esiste già un record collegato a wallet, waPhone, xHandle o tgUser
  let userKey = params.senderKey || null;
  if (!userKey || !db.users[userKey]) {
    for (const [k, u] of Object.entries(db.users)) {
      if (!u) continue;
      const ch = u.channels || {};
      if (
        (wallet && u.wallet === wallet) ||
        (waPhone && (k.includes(waPhone.replace("+", "")) || ch.waPhone === waPhone)) ||
        (xHandle && ch.xHandle && ch.xHandle.toLowerCase() === xHandle.toLowerCase()) ||
        (tgUser && ch.tgUser && ch.tgUser.toLowerCase() === tgUser.toLowerCase())
      ) {
        userKey = k;
        break;
      }
    }
  }

  if (!userKey) {
    userKey = wallet
      ? `sol:${wallet}`
      : waPhone
      ? `${waPhone.replace(/[^0-9]/g, "")}@s.whatsapp.net`
      : xHandle
      ? `x:${xHandle.toLowerCase()}`
      : `tg:${tgUser.toLowerCase()}`;
  }

  const existing = db.users[userKey] || {};
  const seed = `${wallet || ""}|${waPhone || ""}|${xHandle || ""}|${tgUser || ""}|ZDOS_VELVET_SOVEREIGN`;

  let ovId = existing.ovId;
  if (!ovId) {
    let candidate = "OV-" + deriveFourCharCode(seed) + "-VELVET";
    let nonce = 1;
    const usedIds = new Set(Object.values(db.users).map(u => u && u.ovId).filter(Boolean));
    while (usedIds.has(candidate)) {
      candidate = "OV-" + deriveFourCharCode(seed + ":" + nonce) + "-VELVET";
      nonce++;
    }
    ovId = candidate;
  }

  const attestation = await checkSolanaAttestation(wallet, txSignature);
  const passportHash = crypto
    .createHash("sha256")
    .update(`${ovId}:${wallet}:${waPhone || ""}:${xHandle || ""}:${tgUser || ""}`)
    .digest("hex");

  const now = new Date().toISOString();
  const record = {
    ...existing,
    ovId,
    passportHash,
    status: attestation.tier === "ONCHAIN_VERIFIED_HOLDER" ? "ONCHAIN_VERIFIED" : "REAL_VERIFIED",
    rank: attestation.tier === "ONCHAIN_VERIFIED_HOLDER" ? "VIP Velvet ($OV)" : (existing.rank || "Citizen 18+"),
    meatRole: role || existing.meatRole || "Citizen 18+",
    wallet: wallet || existing.wallet || null,
    txSignature: txSignature || existing.txSignature || null,
    attestation,
    devotion: Math.max(Number(existing.devotion || 0), attestation.tier === "ONCHAIN_VERIFIED_HOLDER" ? 50 : 15),
    consent18Plus: true,
    channels: {
      ...(existing.channels || {}),
      xHandle: xHandle || existing.channels?.xHandle || null,
      waPhone: waPhone || existing.channels?.waPhone || null,
      tgUser: tgUser || existing.channels?.tgUser || null,
      updatedAt: now
    },
    issuedAt: existing.issuedAt || now,
    updatedAt: now
  };

  db.users[userKey] = record;
  db.handleLinks[ovId.toUpperCase()] = userKey;
  if (wallet) db.handleLinks[wallet] = userKey;
  if (xHandle) db.handleLinks[xHandle.toLowerCase()] = userKey;
  if (waPhone) db.handleLinks[waPhone] = userKey;
  if (tgUser) db.handleLinks[tgUser.toLowerCase()] = userKey;

  return {
    ok: true,
    userKey,
    ovId: record.ovId,
    passportHash: record.passportHash,
    status: record.status,
    rank: record.rank,
    wallet: record.wallet,
    attestation: record.attestation,
    channels: record.channels,
    lodgeCardUrl: `https://velvet.x-zdos.it/lodge-card.html?ov=${encodeURIComponent(record.ovId)}`
  };
}

module.exports = {
  OV_MINT,
  DSN_MINT,
  TREASURY_WALLET,
  isValidSolanaPubkey,
  issueGlobalRealId
};
