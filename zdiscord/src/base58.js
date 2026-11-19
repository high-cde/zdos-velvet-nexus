'use strict';
// Base58 (alfabeto Bitcoin/Solana), senza dipendenze.
const A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const MAP = new Map([...A].map((c, i) => [c, BigInt(i)]));
function decode(s) {
  s = String(s || '');
  if (!s || !/^[1-9A-HJ-NP-Za-km-z]+$/.test(s)) throw new Error('base58 non valido');
  let n = 0n;
  for (const c of s) n = n * 58n + MAP.get(c);
  const bytes = [];
  while (n > 0n) { bytes.unshift(Number(n & 0xffn)); n >>= 8n; }
  for (const c of s) { if (c === '1') bytes.unshift(0); else break; }
  return Buffer.from(bytes);
}
function encode(buf) {
  buf = Buffer.from(buf);
  let n = BigInt('0x' + (buf.toString('hex') || '0'));
  let s = '';
  while (n > 0n) { s = A[Number(n % 58n)] + s; n /= 58n; }
  for (const b of buf) { if (b === 0) s = '1' + s; else break; }
  return s;
}
module.exports = { decode, encode };
