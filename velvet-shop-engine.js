const crypto = require("crypto");

const TREASURY_WALLET = "6C61wDacAtx3QHQYVw17fnm5GEaEAnc1XienNJKn2bsD";
const OV_MINT = "2EN6Y1zM4yyt41gE2muzdJSAgRCAZiXqnmkgpbrspump";
const DSN_MINT = "35w74RT77BPSYNpmzpvxmR9wu2ihpgzubKy4bkGHR3F4";
const SOLANA_RPCS = [
  "https://api.mainnet-beta.solana.com",
  "https://solana-rpc.publicnode.com"
];

const CATALOG = {
  "PHOTO-VIDEO-PACK": {
    id: "PHOTO-VIDEO-PACK",
    category: "media_18",
    title: "Pack Foto & Video Riservati 18+",
    priceSol: 0.12,
    note: "Accesso immediato al pacchetto media privato dopo verifica tx."
  },
  "INTIMO-WORN-DROP": {
    id: "INTIMO-WORN-DROP",
    category: "intimate_item",
    title: "Intimo Esclusivo & Sigillo",
    priceSol: 0.35,
    note: "Indicare indirizzo/punto ritiro privato sul ponte WhatsApp dopo il pagamento."
  },
  "SLAVE-TRIBUTE-BASE": {
    id: "SLAVE-TRIBUTE-BASE",
    category: "slave_money",
    title: "Tributo Slave Money · Obbedienza",
    priceSol: 0.10,
    note: "Tributo volontario consensuale 18+ registrato nel registro Devotion."
  },
  "SLAVE-TRIBUTE-SUPREMO": {
    id: "SLAVE-TRIBUTE-SUPREMO",
    category: "slave_money",
    title: "Tributo Slave Money · Supremo",
    priceSol: 0.50,
    note: "Tributo maggiore + priorità diretta sulla Loggia e Meat Radar 30km."
  }
};

function ensureShopDB(db) {
  if (!db.shopOrders || typeof db.shopOrders !== "object") db.shopOrders = {};
  if (!db.users || typeof db.users !== "object") db.users = {};
}

async function fetchSolanaTx(signature) {
  const sig = String(signature || "").trim();
  if (sig.length < 64) return null;

  for (const rpc of SOLANA_RPCS) {
    try {
      const resp = await fetch(rpc, {
        method: "POST",
        headers: { "Content-Type": "application/json", "User-Agent": "ZDOS-Velvet-Shop/1.0" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "getTransaction",
          params: [sig, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }]
        })
      });
      if (!resp.ok) continue;
      const json = await resp.json();
      if (json && json.result) return json.result;
    } catch (e) {}
  }
  return null;
}

async function verifyAndRecordOrder(db, payload = {}) {
  ensureShopDB(db);
  const sig = String(payload.txSignature || "").trim();
  const ovId = String(payload.ovId || "").trim().toUpperCase();
  const itemCode = String(payload.itemCode || "SLAVE-TRIBUTE-BASE").trim().toUpperCase();
  const currency = String(payload.currency || "SOL").trim().toUpperCase();
  const declaredAmount = Number(payload.amount || 0);
  const deliveryContact = String(payload.contact || "").trim().slice(0, 80);

  if (!sig || sig.length < 64) {
    return { ok: false, error: "Inserisci una firma transazione Solana (Tx Signature) valida." };
  }

  // Controlla se la signature è già stata usata
  const duplicate = Object.values(db.shopOrders).find(o => o && o.txSignature === sig);
  if (duplicate) {
    return { ok: true, alreadyRecorded: true, order: duplicate };
  }

  const txData = await fetchSolanaTx(sig);
  if (!txData) {
    return { ok: false, error: "Transazione non ancora confermata su Solana Mainnet. Attendi 5 secondi e riprova." };
  }
  if (txData.meta && txData.meta.err) {
    return { ok: false, error: "La transazione su Solana risulta fallita (meta.err)." };
  }

  const accountKeys = (txData.transaction?.message?.accountKeys || []).map(k =>
    typeof k === "string" ? k : k.pubkey
  );
  const touchesTreasury = accountKeys.includes(TREASURY_WALLET);
  if (!touchesTreasury) {
    return { ok: false, error: `La transazione non coinvolge il wallet tesoreria ${TREASURY_WALLET.slice(0, 6)}...` };
  }

  // Calcola delta SOL ricevuto dal treasury se presente
  let receivedSol = 0;
  const idx = accountKeys.indexOf(TREASURY_WALLET);
  if (idx >= 0 && Array.isArray(txData.meta?.preBalances) && Array.isArray(txData.meta?.postBalances)) {
    const diffLamports = Number(txData.meta.postBalances[idx]) - Number(txData.meta.preBalances[idx]);
    if (diffLamports > 0) receivedSol = Number((diffLamports / 1e9).toFixed(6));
  }

  const orderId = "ORD-" + crypto.randomBytes(3).toString("hex").toUpperCase();
  const itemInfo = CATALOG[itemCode] || { id: itemCode, category: "custom", title: itemCode };

  const order = {
    id: orderId,
    ovId: ovId || null,
    itemCode: itemInfo.id,
    itemTitle: itemInfo.title,
    category: itemInfo.category,
    currency,
    declaredAmount,
    verifiedSolReceived: receivedSol,
    txSignature: sig,
    deliveryContact: deliveryContact || null,
    status: "PAID_VERIFIED",
    createdAt: new Date().toISOString()
  };

  db.shopOrders[orderId] = order;

  // Aggiorna devotion dell'utente $OV se collegato
  if (ovId) {
    const userEntry = Object.values(db.users).find(
      u => u && String(u.ovId).toUpperCase() === ovId
    );
    if (userEntry) {
      const bonus = Math.max(20, Math.round((receivedSol || declaredAmount || 0.1) * 100));
      userEntry.devotion = Number(userEntry.devotion || 0) + bonus;
      userEntry.lastOrderId = orderId;
    }
  }

  return { ok: true, order };
}

function getShopSnapshot(db) {
  ensureShopDB(db);
  const orders = Object.values(db.shopOrders);
  return {
    ok: true,
    treasury: TREASURY_WALLET,
    tokens: { OV: OV_MINT, DSN: DSN_MINT },
    catalog: Object.values(CATALOG),
    totalOrders: orders.length,
    recentOrders: orders.slice(-10).map(o => ({
      id: o.id,
      itemTitle: o.itemTitle,
      currency: o.currency,
      verifiedSolReceived: o.verifiedSolReceived,
      status: o.status,
      createdAt: o.createdAt
    }))
  };
}

module.exports = {
  TREASURY_WALLET,
  OV_MINT,
  DSN_MINT,
  CATALOG,
  verifyAndRecordOrder,
  getShopSnapshot
};
