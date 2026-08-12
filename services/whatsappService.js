const { logger } = require('../config/logger');
const { getSetting } = require('../config/settingsManager');
const db = require('../config/database');
const metaWAService = require('./metaWhatsappService');

/**
 * Unified WhatsApp Gateway Service
 * Menangani routing pengiriman pesan baik via Baileys (Unofficial Web) maupun Meta Cloud API (Official Meta).
 */

/**
 * Kirim pesan WhatsApp universal
 * @param {string} toPhone Nomor HP tujuan
 * @param {string} messageText Teks pesan
 * @param {object} options Opsi tambahan: { templateName, parameters, langCode }
 */
async function sendWhatsAppMessage(toPhone, messageText, options = {}) {
  const gatewayType = getSetting('wa_gateway_type', 'baileys'); // 'baileys' or 'meta'

  if (gatewayType === 'meta') {
    // Mode META API RESMI
    if (options.templateName) {
      // Kirim via Meta Template Message
      return await metaWAService.sendMetaTemplateMessage(
        toPhone,
        options.templateName,
        options.langCode || 'id',
        options.parameters || []
      );
    } else {
      // Kirim via Meta Direct Text Message
      return await metaWAService.sendMetaTextMessage(toPhone, messageText);
    }
  } else {
    // Mode BAILEYS WEB (Default Existing)
    const { sendWA, whatsappStatus } = await import('./whatsappBot.mjs');

    if (!whatsappStatus || whatsappStatus.connection !== 'open') {
      throw new Error('Bot WhatsApp (Baileys) belum terhubung / offline. Silakan scan QR Code di menu /admin/whatsapp.');
    }

    const ok = await sendWA(toPhone, messageText, options);

    if (!ok) {
      throw new Error('Gagal mengirim pesan via Baileys. Pastikan nomor HP tujuan terdaftar di WhatsApp.');
    }

    // Logging ke wa_chat_messages untuk Inbox / Live Chat
    try {
      const phone = metaWAService.normalizePhone(toPhone);
      let custName = 'Pelanggan';
      let custId = null;
      const cust = db.prepare('SELECT id, name FROM customers WHERE phone LIKE ? OR phone LIKE ?').get(`%${phone.slice(-8)}%`, `%${phone}%`);
      if (cust) {
        custName = cust.name;
        custId = cust.id;
      }

      db.prepare(`
        INSERT INTO wa_chat_messages 
        (direction, gateway, sender_phone, recipient_phone, customer_id, customer_name, message_text, status)
        VALUES ('outbound', 'baileys', 'baileys_bot', ?, ?, ?, ?, 'sent')
      `).run(phone, custId, custName, messageText);
    } catch (e) {}

    return ok;
  }
}

/**
 * Ambil riwayat chat / percakapan dengan nomor tertentu untuk Live Chat
 */
function getChatHistory(phone, limit = 50) {
  const normalized = metaWAService.normalizePhone(phone);
  if (!normalized) return [];

  const rows = db.prepare(`
    SELECT * FROM wa_chat_messages
    WHERE sender_phone LIKE ? OR recipient_phone LIKE ? OR sender_phone LIKE ? OR recipient_phone LIKE ?
    ORDER BY id ASC
    LIMIT ?
  `).all(`%${normalized.slice(-8)}%`, `%${normalized.slice(-8)}%`, `%${normalized}%`, `%${normalized}%`, Number(limit) || 50);

  return rows || [];
}

/**
 * Ambil daftar percakapan terbaru (Inbox Live Chat)
 */
function getRecentConversations(limit = 30) {
  const rows = db.prepare(`
    SELECT 
      m.id,
      m.direction,
      m.gateway,
      CASE WHEN m.direction = 'inbound' THEN m.sender_phone ELSE m.recipient_phone END as phone,
      m.customer_id,
      m.customer_name,
      m.message_text,
      m.status,
      m.created_at
    FROM wa_chat_messages m
    INNER JOIN (
      SELECT MAX(id) as max_id
      FROM wa_chat_messages
      GROUP BY CASE WHEN direction = 'inbound' THEN sender_phone ELSE recipient_phone END
    ) latest ON m.id = latest.max_id
    ORDER BY m.id DESC
    LIMIT ?
  `).all(Number(limit) || 30);

  return rows || [];
}

module.exports = {
  sendWhatsAppMessage,
  sendWA: sendWhatsAppMessage, // Alias untuk kompatibilitas fungsi lama
  getChatHistory,
  getRecentConversations
};
