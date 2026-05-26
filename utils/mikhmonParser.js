/**
 * Mikhmon On-Login Script Parser (Shared Utility)
 * 
 * Parse metadata harga, validity, dan cost dari on-login script profile hotspot MikroTik.
 * Format yang didukung:
 *   1. Mikhmon standar:  :put (",rem,COST,VALIDITY,PRICE,...");
 *   2. Comma-split lama: ...,rem,COST,VALIDITY,PRICE,...
 * 
 * Digunakan oleh:
 *   - routes/customerPortal.js  (route handler voucher)
 *   - services/voucherCacheWarmer.js (background cache warmer)
 */

'use strict';

/**
 * @param {string} script - Isi field on-login dari hotspot user profile MikroTik
 * @returns {{ validity: string, price: number, cost: number } | null}
 */
function parseMikhmonOnLogin(script) {
  if (!script) return null;
  const s = String(script).trim();

  // Format: :put (",rem,COST,VALIDITY,PRICE,...)
  // Support ROS6 dan ROS7 (script bisa berbeda struktur)

  // Cari pattern :put (",rem, ... , ... , ...
  // Bisa ada di mana saja dalam script
  // Updated regex untuk support format: :put (",rem,4000,2d,5000,,Disable,");
  const putMatch = s.match(/:\s*put\s*\(\s*[",]rem[",]?\s*,\s*([^,]+)\s*,\s*([^,]+)\s*,\s*([^,]+)/i);
  if (putMatch) {
    const cost = String(putMatch[1] || '').trim();
    const validity = String(putMatch[2] || '').trim();
    const priceStr = String(putMatch[3] || '').trim();
    const price = Number(priceStr.replace(/[^\d]/g, '')) || 0;

    if (validity && price > 0) {
      return { validity, price, cost: Number(cost.replace(/[^\d]/g, '')) || 0 };
    }
  }

  // Fallback: split by comma (untuk format lama)
  const parts = s.split(',').map(p => String(p).trim());
  let remIdx = -1;
  for (let i = 0; i < parts.length; i++) {
    const norm = String(parts[i] || '').toLowerCase().replace(/[^a-z]/g, '');
    if (norm === 'rem') {
      remIdx = i;
      break;
    }
  }

  if (remIdx >= 0 && remIdx + 3 < parts.length) {
    const cost = String(parts[remIdx + 1] || '').trim();
    const validity = String(parts[remIdx + 2] || '').trim();
    const priceStr = String(parts[remIdx + 3] || '').trim();
    const price = Number(priceStr.replace(/[^\d]/g, '')) || 0;

    if (validity && price > 0) {
      return { validity, price, cost: Number(cost.replace(/[^\d]/g, '')) || 0 };
    }
  }

  return null;
}

module.exports = { parseMikhmonOnLogin };
