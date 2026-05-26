const express = require('express');
const path = require('path');
const dns = require('dns');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const crypto = require('crypto');
const multer = require('multer');
const { logger } = require('./config/logger');
const db = require('./config/database');
const customerSvc = require('./services/customerService');
const mikrotikService = require('./services/mikrotikService');
const { errorHandler, notFoundHandler } = require('./middleware/errorHandler');
const { scheduleAutoBackup } = require('./services/backupService');

// Prefer IPv4 to avoid AggregateError (IPv6 timeouts) on some servers
if (dns.setDefaultResultOrder) {
  dns.setDefaultResultOrder('ipv4first');
}

// Handle unhandled promise rejections to prevent silent crashes
process.on('unhandledRejection', (reason, promise) => {
  const errorMsg = reason instanceof Error ? reason.stack : JSON.stringify(reason);
  logger.error(`Unhandled Rejection: ${errorMsg}`);
});

// Handle uncaught exceptions to prevent server crashes from external service failures
// (e.g. ros-client throws uncaught errors when MikroTik router is unreachable)
process.on('uncaughtException', (err) => {
  const errorMsg = err instanceof Error ? err.stack : String(err);
  logger.error(`uncaughtException: ${errorMsg}`);
  // Don't exit process — keep server running despite transient connection errors
});

// Settings Management
const session = require('express-session');
const { getSetting, getSettingsWithCache } = require('./config/settingsManager');
const { SUPPORTED_LANGS, FALLBACK_LANG, normalizeLang, t } = require('./config/i18n');

// Inisialisasi aplikasi Express
const app = express();

const isProduction = process.env.NODE_ENV === 'production';
const cookieSecure = getSetting('cookie_secure', isProduction);
const trustProxy = getSetting('trust_proxy', false);
if (trustProxy) {
  app.set('trust proxy', 1);
}

// Middleware dasar
app.use(express.json({
  limit: '1mb',
  verify: (req, res, buf) => {
    req.rawBody = buf?.toString('utf8') || '';
  }
}));
app.use(express.urlencoded({
  extended: true,
  limit: '1mb',
  verify: (req, res, buf) => {
    req.rawBody = buf?.toString('utf8') || '';
  }
}));
app.use(express.text({
  type: (req) => {
    const contentType = req.headers['content-type'] || '';
    if (contentType.includes('multipart/form-data')) return false;
    if (contentType.includes('application/x-www-form-urlencoded')) return false;
    if (contentType.includes('application/json')) return false;
    return true;
  },
  limit: '1mb',
  verify: (req, res, buf) => {
    req.rawBody = buf?.toString('utf8') || '';
  }
}));
app.use(session({
  secret: getSetting('session_secret', 'rahasia-portal-pelanggan-default-ganti-ini'),
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: Boolean(cookieSecure),
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 24 * 60 * 60 * 1000,
    path: '/'
  },
  name: 'customer.sid'
}));

// i18n middleware (aman: hanya teks UI, tidak mengubah logic fitur)
app.use((req, res, next) => {
  if (req.query && typeof req.query.lang === 'string') {
    const requested = normalizeLang(req.query.lang);
    req.session.lang = requested;
  }
  const saved = req.session?.lang || getSetting('default_lang', FALLBACK_LANG);
  const lang = normalizeLang(saved);
  res.locals.lang = lang;
  res.locals.availableLangs = Array.from(SUPPORTED_LANGS);
  res.locals.t = (key, fallback = '') => t(lang, key, fallback);
  next();
});

app.get('/lang/:lang', (req, res) => {
  const targetLang = normalizeLang(req.params.lang);
  req.session.lang = targetLang;
  const referer = req.get('referer');
  if (referer) return res.redirect(referer);
  return res.redirect('/');
});

// Konstanta
const VERSION = '2.0.0';

const insertWebhookPaymentNotif = db.prepare(`
  INSERT INTO webhook_payment_notifs (service, content, parsed_amount, parsed_ok, ip, user_agent)
  VALUES (?, ?, ?, ?, ?, ?)
`);

const updateWebhookPaymentNotifMatchInvoice = db.prepare(`
  UPDATE webhook_payment_notifs
  SET matched_invoice_id = ?
  WHERE id = ?
`);

const updateWebhookPaymentNotifMatchVoucher = db.prepare(`
  UPDATE webhook_payment_notifs
  SET matched_voucher_order_id = ?
  WHERE id = ?
`);

const selectInvoiceByUniqueAmount = db.prepare(`
  SELECT i.id, i.customer_id, i.status, i.amount, i.qris_amount_unique, i.qris_unique_code, i.notes,
         c.status as customer_status
  FROM invoices i
  JOIN customers c ON c.id = i.customer_id
  WHERE i.status = 'unpaid' AND i.qris_amount_unique = ?
  ORDER BY i.id DESC
  LIMIT 2
`);

const selectVoucherOrderByUniqueAmount = db.prepare(`
  SELECT id, status, profile_name, validity, buyer_phone
  FROM public_voucher_orders
  WHERE status = 'pending' AND qris_amount_unique = ?
  ORDER BY id DESC
  LIMIT 2
`);

const markVoucherPaid = db.prepare(`
  UPDATE public_voucher_orders
  SET status='paid',
      paid_at=NOW_LOCAL(),
      qris_paid_notif_id=?,
      updated_at=NOW_LOCAL()
  WHERE id=?
`);

const selectVoucherOrderById = db.prepare(`SELECT * FROM public_voucher_orders WHERE id = ?`);
const markVoucherFulfilled = db.prepare(`
  UPDATE public_voucher_orders
  SET status='fulfilled',
      fulfilled_at=NOW_LOCAL(),
      voucher_code=?,
      voucher_password=?,
      voucher_comment=?,
      updated_at=NOW_LOCAL()
  WHERE id=?
`);
const markVoucherWaSentOk = db.prepare(`
  UPDATE public_voucher_orders
  SET wa_sent=1, wa_sent_at=NOW_LOCAL(), wa_error='', updated_at=NOW_LOCAL()
  WHERE id=?
`);
const markVoucherWaSentErr = db.prepare(`
  UPDATE public_voucher_orders
  SET wa_sent=0, wa_error=?, updated_at=NOW_LOCAL()
  WHERE id=?
`);

const markInvoicePaidAppendNote = db.prepare(`
  UPDATE invoices
  SET status='paid',
      paid_at=NOW_LOCAL(),
      paid_by_name=?,
      notes=CASE
        WHEN notes IS NULL OR TRIM(notes) = '' THEN ?
        ELSE notes || '\n' || ?
      END,
      qris_paid_notif_id=?
  WHERE id=?
`);

const countUnpaidInvoicesForCustomer = db.prepare(`SELECT COUNT(1) as c FROM invoices WHERE customer_id=? AND status='unpaid'`);

const insertDigiflazzWebhookLog = db.prepare(`
  INSERT INTO digiflazz_webhook_logs (ref_id, status, signature, signature_ok, matched_agent_tx_id, ip, payload)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);

const selectAgentPulsaTxByRefId = db.prepare(`
  SELECT id, agent_id, amount_buy, amount_sell, digi_refunded, digi_status
  FROM agent_transactions
  WHERE type = 'pulsa' AND digi_ref_id = ?
  ORDER BY id DESC
  LIMIT 1
`);

const updateAgentPulsaTxFromWebhook = db.prepare(`
  UPDATE agent_transactions
  SET digi_status = ?,
      digi_trx_id = ?,
      digi_sn = ?,
      digi_message = ?,
      digi_price = ?
  WHERE id = ?
`);

const markAgentPulsaRefunded = db.prepare(`UPDATE agent_transactions SET digi_refunded = 1 WHERE id = ?`);

const getAgentByIdForWebhook = db.prepare(`SELECT id, balance FROM agents WHERE id = ?`);
const updateAgentBalanceForWebhook = db.prepare(`UPDATE agents SET balance = ? WHERE id = ?`);
const insertAgentTxRefund = db.prepare(`
  INSERT INTO agent_transactions (
    agent_id, type, amount_buy, amount_sell, fee, balance_before, balance_after, note
  ) VALUES (?, 'topup', ?, ?, 0, ?, ?, ?)
`);

function normalizeDigiflazzStatus(status) {
  const s = String(status || '').toLowerCase();
  if (s === 'sukses' || s === 'success') return 'success';
  if (s === 'gagal' || s === 'failed') return 'failed';
  if (s === 'pending' || s === 'process' || s === 'processing') return 'pending';
  return 'pending';
}

function getIp(req) {
  return String((req.headers['x-forwarded-for'] || '').toString().split(',')[0].trim() || req.ip || '');
}

function parseRupiahAmountFromNotification(content) {
  const text = String(content || '').replace(/\u00A0/g, ' ').trim();
  if (!text) return null;

  const lower = text.toLowerCase();
  const incomingHints = [
    'menerima', 'diterima', 'masuk', 'saldo masuk', 'saldo bertambah',
    'pembayaran masuk', 'pembayaran diterima', 'received', 'incoming',
    'qris berhasil', 'qris sukses', 'qr berhasil', 'qr sukses'
  ];
  const outgoingHints = [
    'mengirim', 'terkirim', 'transfer ke', 'bayar ke', 'pembayaran berhasil',
    'berhasil bayar', 'pembelian', 'belanja', 'purchase'
  ];
  const hasIncomingHint = incomingHints.some((hint) => lower.includes(hint));
  const hasOutgoingHint = outgoingHints.some((hint) => lower.includes(hint));
  if (hasOutgoingHint && !hasIncomingHint) return null;

  const candidates = [
    /(?:\bRp\.?\s*|IDR\s*)([0-9][0-9\.\,\s]*)/i,
    /(?:sebesar|senilai|nominal|masuk|transfer|top\s*up|topup|saldo\s+masuk)\s*(?:saldo\s*)?(?:\bRp\.?\s*)?([0-9][0-9\.\,\s]*)/i,
  ];

  let raw = null;
  for (const re of candidates) {
    const m = text.match(re);
    if (m && m[1]) {
      raw = String(m[1]);
      break;
    }
  }
  if (!raw) return null;

  let num = raw.replace(/\s+/g, '');
  if (num.includes(',')) num = num.split(',')[0];
  num = num.replace(/\./g, '');
  num = num.replace(/[^\d]/g, '');
  if (!num) return null;

  const amount = Number.parseInt(num, 10);
  return Number.isFinite(amount) ? amount : null;
}

function genRandomCode(len = 6) {
  const n = Math.max(1, Math.min(16, Number(len) || 6));
  let out = '';
  for (let i = 0; i < n; i++) {
    out += String(Math.floor(Math.random() * 10));
  }
  return out;
}

async function trySendWaToBuyer(settings, phone, message, orderId) {
  if (!settings || !settings.whatsapp_enabled) return;
  const p = String(phone || '').trim();
  if (!p) return;
  try {
    const { sendWA, whatsappStatus } = await import('./services/whatsappBot.mjs');
    if (whatsappStatus.connection !== 'open') throw new Error('Bot WhatsApp belum terhubung');
    await sendWA(p, message);
    markVoucherWaSentOk.run(orderId);
  } catch (e) {
    markVoucherWaSentErr.run(String(e?.message || e || ''), orderId);
  }
}

async function fulfillVoucherOrder(settings, orderId) {
  const ord = selectVoucherOrderById.get(orderId);
  if (!ord) throw new Error('Order tidak ditemukan');
  if (String(ord.status) === 'fulfilled' && ord.voucher_code) return { ok: true, already: true };
  if (String(ord.status) !== 'paid') return { ok: false, reason: 'not_paid' };

  let created = null;
  let attempt = 0;
  while (attempt < 10) {
    attempt++;
    const code = genRandomCode(6);
    const pass = code;
    const comment = `vc-online-${orderId}-${code}-${ord.profile_name}`;
    const userData = {
      server: 'all',
      name: code,
      password: pass,
      profile: ord.profile_name,
      comment
    };
    if (ord.validity) userData['limit-uptime'] = ord.validity;

    try {
      await mikrotikService.addHotspotUser(userData, ord.router_id ?? null);
      created = { code, pass, comment };
      break;
    } catch (e) {
      const msg = String(e?.message || e || '').toLowerCase();
      const isDup = msg.includes('already') || msg.includes('exist') || msg.includes('duplicate');
      if (isDup) continue;
      throw e;
    }
  }
  if (!created) throw new Error('Gagal membuat voucher (kode duplikat terlalu sering)');

  markVoucherFulfilled.run(created.code, created.pass, created.comment, orderId);

  const msg =
    `🎫 *VOUCHER HOTSPOT*\n\n` +
    `✅ Pembayaran diterima via *QRIS Statis*\n` +
    `📦 Paket: *${ord.profile_name}* (${ord.validity || '-'})\n` +
    `💰 Harga: Rp ${Number(ord.price || 0).toLocaleString('id-ID')}\n\n` +
    `👤 User: *${created.code}*\n` +
    `🔑 Pass: *${created.pass}*\n\n` +
    `Terima kasih.`;

  await trySendWaToBuyer(settings, ord.buyer_phone, msg, orderId);
  return { ok: true, created };
}

app.post('/api/webhook/v1/payment-notif', multer().any(), async (req, res) => {
  let body = req.body || {};
  try {
    if (typeof body === 'string') {
      try {
        body = JSON.parse(body);
      } catch {
        body = { content: body };
      }
    } else if ((!body || (typeof body === 'object' && Object.keys(body).length === 0)) && req.rawBody) {
      try {
        body = JSON.parse(String(req.rawBody || ''));
      } catch {
        body = { content: String(req.rawBody || '') };
      }
    }
  } catch {}

  const service =
    (typeof body === 'object' && body ? (body.service || body.app || body.packageName) : '') ||
    req.query?.service ||
    req.query?.app ||
    req.query?.packageName ||
    req.headers['x-webhook-service'] ||
    '';

  const secret_key =
    (typeof body === 'object' && body ? (body.secret_key ?? body.secretKey ?? body.secret) : null) ??
    req.query?.secret_key ??
    req.query?.secretKey ??
    req.query?.secret ??
    req.get('x-webhook-token') ??
    req.get('x-webhook-secret') ??
    req.get('x-webhook-key');
  const expected = process.env.MY_WEBHOOK_SECRET;
  const expectedTrim = typeof expected === 'string' ? expected.trim() : '';
  const gotTrim = String(secret_key || '').trim();

  if (!expectedTrim || expectedTrim.length < 8) {
    logger.error('[WEBHOOK][payment-notif] MY_WEBHOOK_SECRET belum diset (minimal 8 karakter). Request ditolak.');
    return res.status(403).json({ ok: false, error: 'Forbidden', reason: 'server_secret_not_configured' });
  }

  if (gotTrim !== expectedTrim) {
    logger.warn(`[WEBHOOK][payment-notif] Forbidden: secret_key mismatch. service=${String(service || '-')}`);
    return res.status(403).json({ ok: false, error: 'Forbidden', reason: 'secret_key_mismatch' });
  }

  // Safe debugging: log incoming request parameters (secrets masked)
  const sanitizeForLog = (obj) => {
    if (!obj || typeof obj !== 'object') return {};
    const clean = {};
    for (const key of Object.keys(obj)) {
      const kLc = key.toLowerCase();
      if (['secret', 'token', 'key', 'password', 'pass', 'authorization', 'cookie'].some(k => kLc.includes(k))) {
        clean[key] = '***';
      } else {
        clean[key] = obj[key];
      }
    }
    return clean;
  };
  logger.info(`[WEBHOOK][payment-notif] Debug params: query=${JSON.stringify(sanitizeForLog(req.query))} body=${JSON.stringify(sanitizeForLog(body))} headers=${JSON.stringify(sanitizeForLog(req.headers))}`);

  // Collect all potential text from request
  const extractedTexts = [];
  if (typeof body === 'string') {
    extractedTexts.push(body);
  } else if (body && typeof body === 'object') {
    for (const key of Object.keys(body)) {
      const val = body[key];
      if (typeof val === 'string' || typeof val === 'number') {
        const kLc = key.toLowerCase();
        if (['secret', 'token', 'key', 'password', 'pass'].some(k => kLc.includes(k))) continue;
        if (['service', 'app', 'packagename'].includes(kLc)) continue;
        extractedTexts.push(String(val));
      }
    }
  }
  if (req.query && typeof req.query === 'object') {
    for (const key of Object.keys(req.query)) {
      const val = req.query[key];
      if (typeof val === 'string' || typeof val === 'number') {
        const kLc = key.toLowerCase();
        if (['secret', 'token', 'key', 'password', 'pass'].some(k => kLc.includes(k))) continue;
        if (['service', 'app', 'packagename'].includes(kLc)) continue;
        extractedTexts.push(String(val));
      }
    }
  }
  if (req.rawBody && typeof req.rawBody === 'string') {
    const trimmedRaw = req.rawBody.trim();
    if (!trimmedRaw.startsWith('{') && !trimmedRaw.startsWith('[')) {
      extractedTexts.push(trimmedRaw);
    }
  }

  const rawText = Array.from(new Set(extractedTexts))
    .map((v) => String(v || '').trim())
    .filter(Boolean)
    .join(' ');

  logger.info(`[WEBHOOK][payment-notif] IN service=${String(service || '-')} content="${rawText.replace(/\r?\n/g, ' ').slice(0, 500)}"`);

  try {
    const amount = parseRupiahAmountFromNotification(rawText);
    const ip = String((req.headers['x-forwarded-for'] || '').toString().split(',')[0].trim() || req.ip || '');
    const ua = String(req.get('user-agent') || '');
    let notifId = null;
    try {
      const r = insertWebhookPaymentNotif.run(
        String(service || ''),
        rawText,
        amount != null ? amount : null,
        amount != null ? 1 : 0,
        ip,
        ua
      );
      notifId = Number(r?.lastInsertRowid || 0) || null;
    } catch (e) {
      logger.error(`[WEBHOOK][payment-notif] DB log insert failed: ${e && e.message ? e.message : String(e)}`);
    }

    let matchedInvoiceId = null;
    let matchedVoucherOrderId = null;
    if (amount != null) {
      try {
        const invCandidates = selectInvoiceByUniqueAmount.all(amount);
        const vCandidates = selectVoucherOrderByUniqueAmount.all(amount);
        const totalCandidates = (Array.isArray(invCandidates) ? invCandidates.length : 0) + (Array.isArray(vCandidates) ? vCandidates.length : 0);

        if (totalCandidates === 1) {
          if (Array.isArray(invCandidates) && invCandidates.length === 1) {
            const inv = invCandidates[0];
          const invId = Number(inv.id || 0);
          const custId = Number(inv.customer_id || 0);
          if (invId > 0) {
            const noteLine = `AUTO-QRIS: cocok nominal unik Rp ${amount} (service=${String(service || '-')}, notif=${notifId || '-'})`;
            markInvoicePaidAppendNote.run('QRIS', noteLine, noteLine, notifId || null, invId);
            matchedInvoiceId = invId;

            if (notifId) {
              try { updateWebhookPaymentNotifMatchInvoice.run(invId, notifId); } catch {}
            }

            if (custId > 0 && String(inv.customer_status || '') === 'suspended') {
              const cnt = countUnpaidInvoicesForCustomer.get(custId);
              const unpaid = Number(cnt?.c || 0);
              if (unpaid === 0) {
                try { await customerSvc.activateCustomer(custId); } catch (e) {
                  logger.error(`[WEBHOOK][payment-notif] Activate customer failed: ${e && e.message ? e.message : String(e)}`);
                }
              }
            }

            logger.info(`[WEBHOOK][payment-notif] MATCH invoice=${invId} amount=${amount}`);
          }
          } else if (Array.isArray(vCandidates) && vCandidates.length === 1) {
            const ord = vCandidates[0];
            const ordId = Number(ord.id || 0);
            if (ordId > 0) {
              markVoucherPaid.run(notifId || null, ordId);
              matchedVoucherOrderId = ordId;
              logger.info(`[WEBHOOK][payment-notif] MATCH voucher_order=${ordId} amount=${amount}`);
              if (notifId) {
                try { updateWebhookPaymentNotifMatchVoucher.run(ordId, notifId); } catch {}
              }
              try {
                await fulfillVoucherOrder(getSettingsWithCache(), ordId);
              } catch (e) {
                logger.error(`[WEBHOOK][payment-notif] Voucher fulfill error: ${e?.message || e}`);
              }
            }
          }
        } else if (totalCandidates > 1) {
          const invIds = Array.isArray(invCandidates) ? invCandidates.map(x => x.id).join(',') : '';
          const vIds = Array.isArray(vCandidates) ? vCandidates.map(x => x.id).join(',') : '';
          logger.error(`[WEBHOOK][payment-notif] MATCH ambiguous: amount=${amount} invoices=[${invIds}] vouchers=[${vIds}]`);
        }
      } catch (e) {
        logger.error(`[WEBHOOK][payment-notif] MATCH error: ${e && e.message ? e.message : String(e)}`);
      }
    }

    if (amount != null) {
      logger.info(`[WEBHOOK][payment-notif] PARSED service=${String(service || '-')} amount=${amount}`);
      return res.status(200).json({ status: 'processed', parsed: true, amount, matched_invoice_id: matchedInvoiceId, matched_voucher_order_id: matchedVoucherOrderId });
    }

    logger.error(`[WEBHOOK][payment-notif] FAILED parse: "${rawText.replace(/\r?\n/g, ' ').slice(0, 500)}"`);
    return res.status(200).json({ status: 'processed', parsed: false, amount: null });
  } catch (err) {
    logger.error(`[WEBHOOK][payment-notif] ERROR ${err && err.stack ? err.stack : String(err)}`);
    return res.status(200).json({ status: 'processed', parsed: false, amount: null });
  }
});

app.get('/webhook/digiflazz', (req, res) => {
  res.json({ success: true, message: 'OK. Use POST for Digiflazz webhook.' });
});
app.head('/webhook/digiflazz', (req, res) => res.status(200).end());
app.post('/webhook/digiflazz', async (req, res) => {
  const payload = req.body || {};
  const signature = req.headers['x-hub-signature'] || req.headers['x-digiflazz-delivery'];
  const eventName = String(req.headers['x-digiflazz-event'] || '').trim();
  const userAgent = String(req.headers['user-agent'] || '').trim();
  const secret = String(getSetting('digiflazz_webhook_secret', '') || '').trim();
  const expectedHookId = String(getSetting('digiflazz_webhook_id', '') || '').trim();

  if (!secret) return res.status(503).send('Webhook secret belum dikonfigurasi');
  if (!signature || typeof signature !== 'string') return res.status(401).send('Unauthorized');

  const raw = req.rawBody || JSON.stringify(payload);
  const selfSignature = 'sha1=' + crypto.createHmac('sha1', secret).update(raw).digest('hex');

  let sigOk = 0;
  try {
    const a = Buffer.from(String(signature));
    const b = Buffer.from(String(selfSignature));
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) sigOk = 1;
  } catch (e) {
    sigOk = 0;
  }

  const data = payload?.data || {};
  const refId = String(data?.ref_id || '').trim();
  const vendorStatus = String(data?.status || '').trim();
  const vendorMessage = String(data?.message || '').trim();
  const vendorSn = String(data?.sn || '').trim();
  const vendorTrxId = String(data?.trx_id || '').trim();
  const vendorPrice = Math.max(0, Math.floor(Number(data?.price || 0) || 0));

  const ip = getIp(req);

  const pingHookId = String(payload?.hook_id || '').trim();
  if (!refId && payload && payload.sed && pingHookId) {
    try { insertDigiflazzWebhookLog.run('', eventName || 'ping', String(signature || ''), sigOk, null, ip, raw); } catch {}
    if (!sigOk) return res.status(401).send('Unauthorized');
    const hookIdOk = !expectedHookId || expectedHookId === pingHookId;
    logger.info(`[WEBHOOK][digiflazz] ping hook_id=${pingHookId} expected=${expectedHookId || '-'} ok=${hookIdOk ? 1 : 0} event=${eventName || '-'} ua=${userAgent || '-'} ip=${ip}`);
    return res.json({ success: true, type: 'ping', hook_id: pingHookId, hook_id_ok: hookIdOk });
  }

  if (!refId) {
    try { insertDigiflazzWebhookLog.run('', vendorStatus, String(signature || ''), sigOk, null, ip, raw); } catch {}
    return res.status(400).send('Invalid payload');
  }

  if (!sigOk) {
    try { insertDigiflazzWebhookLog.run(refId, vendorStatus, String(signature || ''), sigOk, null, ip, raw); } catch {}
    return res.status(401).send('Unauthorized');
  }

  let matchedTxId = null;
  try {
    const tx = selectAgentPulsaTxByRefId.get(refId);
    matchedTxId = tx?.id || null;

    const nextStatus = normalizeDigiflazzStatus(vendorStatus);
    if (tx && tx.id) {
      updateAgentPulsaTxFromWebhook.run(
        nextStatus,
        vendorTrxId,
        vendorSn,
        vendorMessage,
        vendorPrice,
        tx.id
      );

      if (nextStatus === 'failed' && Number(tx.digi_refunded || 0) !== 1) {
        const runRefund = db.transaction(() => {
          const fresh = selectAgentPulsaTxByRefId.get(refId);
          if (!fresh || !fresh.id) return;
          if (Number(fresh.digi_refunded || 0) === 1) return;

          const agent = getAgentByIdForWebhook.get(fresh.agent_id);
          if (!agent) return;

          const amount = Math.max(0, Math.floor(Number(fresh.amount_sell || 0) || 0));
          const before = Number(agent.balance || 0);
          const after = before + amount;
          updateAgentBalanceForWebhook.run(after, fresh.agent_id);
          insertAgentTxRefund.run(
            fresh.agent_id,
            amount,
            amount,
            before,
            after,
            `REFUND Digiflazz webhook (tx#${fresh.id} ref=${refId})`
          );
          markAgentPulsaRefunded.run(fresh.id);
        });
        runRefund();
      }
    }
  } catch (e) {
    try { insertDigiflazzWebhookLog.run(refId, vendorStatus, String(signature || ''), sigOk, matchedTxId, ip, raw); } catch {}
    return res.status(500).send('Internal Server Error');
  }

  try { insertDigiflazzWebhookLog.run(refId, vendorStatus, String(signature || ''), sigOk, matchedTxId, ip, raw); } catch {}
  logger.info(`[WEBHOOK][digiflazz] event=${eventName || '-'} ua=${userAgent || '-'} ref=${refId} status=${vendorStatus} ok=${sigOk} match=${matchedTxId || '-'}`);
  return res.json({ success: true, ref_id: refId, matched_agent_tx_id: matchedTxId });
});

// Inisialisasi database billing
try {
  require('./config/database');
  logger.info('[DB] Billing database ready');
} catch (e) {
  logger.error('[DB] Database init failed:', e.message);
}

// Variabel global untuk modul lain yang masih membaca konfigurasi (mis. skrip utilitas)
global.appSettings = {
  port: getSetting('server_port', 4555),
  host: getSetting('server_host', 'localhost'),
  genieacsUrl: getSetting('genieacs_url', 'http://localhost:7557'),
  genieacsUsername: getSetting('genieacs_username', ''),
  genieacsPassword: getSetting('genieacs_password', ''),
  companyHeader: getSetting('company_header', 'ISP Monitor'),
  footerInfo: getSetting('footer_info', ''),
};

// Route untuk health check
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        version: VERSION
    });
});

// Redirect root ke portal pelanggan
app.get('/', (req, res) => {
  res.redirect('/customer/login');
});

// Alias singkat: /login → /customer/login
app.get('/login', (req, res) => {
  res.redirect('/customer/login');
});

// Halaman Isolir (Akses langsung dari redirect MikroTik)
app.get('/isolated', (req, res) => {
  const { getSettingsWithCache } = require('./config/settingsManager');
  const settings = getSettingsWithCache();
  res.render('isolated', {
    company: settings.company_header || 'My ISP',
    adminPhone: settings.company_phone || '',
    address: settings.company_address || ''
  });
});

// Tambahkan view engine dan static
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.get('/manifest.webmanifest', (req, res) => {
  res.type('application/manifest+json');
  res.sendFile(path.join(__dirname, 'public', 'manifest.webmanifest'));
});
app.get('/admin/manifest.webmanifest', (req, res) => {
  res.type('application/manifest+json');
  res.send({
    name: 'Admin Billing',
    short_name: 'Admin',
    start_url: '/admin/settings?source=pwa',
    scope: '/admin/',
    display: 'standalone',
    orientation: 'portrait',
    background_color: '#0f172a',
    theme_color: '#0f172a',
    icons: [
      { src: '/img/pwa-icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' },
      { src: '/img/logo.png', sizes: '2000x545', type: 'image/png', purpose: 'any' }
    ]
  });
});
app.use(express.static(path.join(__dirname, 'public')));

app.get('/broadcast', (req, res) => {
  res.redirect('/admin/whatsapp/broadcast');
});
// Mount customer portal
const customerPortal = require('./routes/customerPortal');
app.use('/customer', customerPortal);

// Mount admin portal
const adminPortal = require('./routes/adminPortal');
app.use('/admin', adminPortal);

// Mount tech portal
const techPortal = require('./routes/techPortal');
app.use('/tech', techPortal);

// Mount agent portal
const agentPortal = require('./routes/agentPortal');
app.use('/agent', agentPortal);

// Mount collector portal
const collectorPortal = require('./routes/collectorPortal');
app.use('/collector', collectorPortal);

// Fungsi untuk memulai server dengan penanganan port yang sudah digunakan
function startServer(portToUse) {
    logger.info(`Mencoba memulai server pada port ${portToUse}...`);
    
    // Coba port alternatif jika port utama tidak tersedia
    try {
        const server = app.listen(portToUse, () => {
            logger.info(`Server berhasil berjalan pada port ${portToUse}`);
            logger.info(`Environment: ${process.env.NODE_ENV || 'development'}`);
            // Update global.appSettings.port dengan port yang berhasil digunakan
            global.appSettings.port = portToUse.toString();
            
            // Start voucher cache warmer untuk pre-load profiles dari MikroTik
            const voucherCacheWarmer = require('./services/voucherCacheWarmer');
            voucherCacheWarmer.startCacheWarming();
        }).on('error', (err) => {
            if (err.code === 'EADDRINUSE') {
                logger.warn(`PERINGATAN: Port ${portToUse} sudah digunakan, mencoba port alternatif...`);
                // Coba port alternatif (port + 1000)
                const alternativePort = portToUse + 1000;
                logger.info(`Mencoba port alternatif: ${alternativePort}`);
                
                // Buat server baru dengan port alternatif
                const alternativeServer = app.listen(alternativePort, () => {
                    logger.info(`Server berhasil berjalan pada port alternatif ${alternativePort}`);
                    logger.info(`Environment: ${process.env.NODE_ENV || 'development'}`);
                    // Update global.appSettings.port dengan port yang berhasil digunakan
                    global.appSettings.port = alternativePort.toString();
                    
                    // Start voucher cache warmer untuk pre-load profiles dari MikroTik
                    const voucherCacheWarmer = require('./services/voucherCacheWarmer');
                    voucherCacheWarmer.startCacheWarming();
                }).on('error', (altErr) => {
                    logger.error(`ERROR: Gagal memulai server pada port alternatif ${alternativePort}:`, altErr.message);
                    process.exit(1);
                });
            } else {
                logger.error('Error starting server:', err);
                process.exit(1);
            }
        });
    } catch (error) {
        logger.error(`Terjadi kesalahan saat memulai server:`, error);
        process.exit(1);
    }
}

// Mulai server dengan port dari settings.json
const port = global.appSettings.port;
logger.info(`Attempting to start server on configured port: ${port}`);

// Mulai server dengan port dari konfigurasi
startServer(port);

if (getSetting('whatsapp_enabled', false)) {
  import('./services/whatsappBot.mjs')
    .then((mod) => mod.startWhatsAppBot())
    .catch((err) => logger.error('Gagal memulai WhatsApp bot:', err));
}

if (getSetting('telegram_enabled', false)) {
  const { initTelegram } = require('./services/telegramBot');
  initTelegram();
}

// Mulai cron jobs (generate tagihan otomatis, dll)
const { startCronJobs } = require('./services/cronService');
startCronJobs();

// Mulai auto backup
scheduleAutoBackup();

// Error handling middleware (harus di akhir setelah semua routes)
app.use(notFoundHandler);
app.use(errorHandler);

// Export app untuk testing
module.exports = app;
