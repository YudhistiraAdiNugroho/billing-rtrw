/**
 * Routes: Customer Mobile REST API
 * Menyediakan endpoint JSON untuk aplikasi Android Native pelanggan
 */
const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const db = require('../config/database');
const { getSetting, getSettingsWithCache } = require('../config/settingsManager');
const { logger } = require('../config/logger');
const customerSvc = require('../services/customerService');
const customerDevice = require('../services/customerDeviceService');
const billingSvc = require('../services/billingService');
const paymentSvc = require('../services/paymentService');
const ticketSvc = require('../services/ticketService');
const voucherPaymentSvc = require('../services/voucherPaymentService');
const qrisUtil = require('../utils/qrisUtil');

// Helper Token JWT / HMAC
function b64urlEncode(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(String(input), 'utf8');
  return buf.toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function b64urlDecodeToString(input) {
  const s = String(input || '').replace(/-/g, '+').replace(/_/g, '/');
  const padLen = (4 - (s.length % 4)) % 4;
  const padded = s + '='.repeat(padLen);
  return Buffer.from(padded, 'base64').toString('utf8');
}

function getApiSecret() {
  const settings = getSettingsWithCache();
  return settings.session_secret || 'rahasia-api-pelanggan-alijaya-default';
}

function generateCustomerToken(customer) {
  const secret = getApiSecret();
  const payload = {
    customerId: customer.id,
    phone: customer.phone,
    name: customer.name,
    username: customer.pppoe_username || customer.id,
    exp: Date.now() + 30 * 24 * 60 * 60 * 1000 // 30 hari
  };
  const body = b64urlEncode(JSON.stringify(payload));
  const sig = b64urlEncode(crypto.createHmac('sha256', secret).update(body).digest());
  return `${body}.${sig}`;
}

function verifyCustomerToken(token) {
  if (!token) return null;
  const secret = getApiSecret();
  const raw = String(token || '').replace(/^Bearer\s+/i, '').trim();
  const parts = raw.split('.');
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  if (!body || !sig) return null;
  const expected = b64urlEncode(crypto.createHmac('sha256', secret).update(body).digest());
  if (expected.length !== sig.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig))) return null;
  try {
    const payload = JSON.parse(b64urlDecodeToString(body));
    if (!payload || typeof payload !== 'object') return null;
    if (!payload.exp || Date.now() > Number(payload.exp)) return null;
    return payload;
  } catch {
    return null;
  }
}

// Middleware Autentikasi API
function requireCustomerApiAuth(req, res, next) {
  const authHeader = req.headers.authorization || req.headers['x-access-token'] || req.query.token;
  const payload = verifyCustomerToken(authHeader);
  if (!payload || !payload.customerId) {
    return res.status(401).json({
      success: false,
      message: 'Sesi tidak valid atau telah kedaluwarsa. Silakan login kembali.'
    });
  }
  const customer = customerSvc.getCustomerById(payload.customerId);
  if (!customer) {
    return res.status(401).json({
      success: false,
      message: 'Akun pelanggan tidak ditemukan.'
    });
  }
  req.customer = customer;
  req.tokenPayload = payload;
  next();
}

// ─── 1. INFO SERVER & KONFIGURASI ISP (PUBLIC) ────────────────────────────────
router.get('/config', (req, res) => {
  const settings = getSettingsWithCache();
  res.json({
    success: true,
    data: {
      appName: settings.company_header || 'ISP Billing',
      companyHeader: settings.company_header || 'ALIJAYA NET',
      companyPhone: settings.company_phone || '',
      companyEmail: settings.company_email || '',
      companyAddress: settings.company_address || '',
      operationalHours: settings.operational_hours || '08.00 - 22.00 WIB',
      timezone: settings.timezone || 'Asia/Jakarta',
      gateways: {
        tripay: Boolean(settings.tripay_enabled && settings.tripay_api_key),
        midtrans: Boolean(settings.midtrans_enabled && settings.midtrans_server_key),
        xendit: Boolean(settings.xendit_enabled && settings.xendit_api_key),
        duitku: Boolean(settings.duitku_enabled && settings.duitku_api_key),
        qrisStatic: Boolean(settings.qris_static_enabled)
      }
    }
  });
});

// ─── 2. AUTENTIKASI PELANGGAN (LOGIN) ─────────────────────────────────────────
router.post('/auth/login', (req, res) => {
  const { loginId, password } = req.body;
  if (!loginId || !String(loginId).trim()) {
    return res.status(400).json({ success: false, message: 'Nomor WhatsApp atau ID Pelanggan harus diisi.' });
  }

  const rawInput = String(loginId).trim();
  const cleanDigits = rawInput.replace(/\D/g, '');

  const allCustomers = customerSvc.getAllCustomers();
  const customer = allCustomers.find((c) => {
    const cleanPhone = String(c.phone || '').replace(/\D/g, '');
    return (
      (cleanDigits && cleanPhone && cleanPhone.endsWith(cleanDigits.slice(-8))) ||
      c.phone === rawInput ||
      c.genieacs_tag === rawInput ||
      c.pppoe_username === rawInput ||
      String(c.id) === rawInput
    );
  });

  if (!customer) {
    return res.status(404).json({
      success: false,
      message: 'Nomor WhatsApp atau ID Pelanggan tidak terdaftar di sistem.'
    });
  }

  if (password && customer.pppoe_password) {
    if (String(password).trim() !== String(customer.pppoe_password).trim()) {
      const phoneDigits = String(customer.phone || '').slice(-4);
      if (String(password).trim() !== phoneDigits) {
        return res.status(401).json({ success: false, message: 'Password / PIN yang dimasukkan salah.' });
      }
    }
  }

  const token = generateCustomerToken(customer);

  res.json({
    success: true,
    message: 'Login berhasil.',
    token,
    customer: {
      id: customer.id,
      name: customer.name,
      phone: customer.phone,
      pppoeUsername: customer.pppoe_username || '',
      address: customer.address || '',
      status: customer.status || 'active',
      installDate: customer.install_date || null
    }
  });
});

// ─── 3. BERANDA & PROFIL PELANGGAN (DASHBOARD) ────────────────────────────────
router.get('/dashboard', requireCustomerApiAuth, async (req, res) => {
  const customer = req.customer;
  const pkg = customer.package_id ? db.prepare('SELECT * FROM packages WHERE id = ?').get(customer.package_id) : null;
  const settings = getSettingsWithCache();

  const unpaidInvoices = db.prepare(`
    SELECT * FROM invoices 
    WHERE customer_id = ? AND (status = 'unpaid' OR status IS NULL)
    ORDER BY period_year DESC, period_month DESC
  `).all(customer.id) || [];

  const totalUnpaidAmount = unpaidInvoices.reduce((acc, inv) => acc + (Number(inv.amount) || 0), 0);

  let ontInfo = { available: false };
  try {
    const tokens = [customer.genieacs_tag, customer.pppoe_username, customer.phone].filter(Boolean);
    if (tokens.length > 0) {
      const liveDevice = await customerDevice.getCustomerDeviceData(tokens);
      if (liveDevice) {
        ontInfo = {
          available: true,
          online: liveDevice.online || false,
          model: liveDevice.model || liveDevice.productClass || '',
          rxPower: liveDevice.rxPower || liveDevice.opticalPower || null,
          ssid: liveDevice.ssid || '',
          uptime: liveDevice.uptime || ''
        };
      }
    }
  } catch (e) {
    logger.warn(`[CustomerAPI] ONT status fetch failed for ${customer.id}: ${e.message}`);
  }

  res.json({
    success: true,
    data: {
      profile: {
        id: customer.id,
        name: customer.name,
        phone: customer.phone,
        email: customer.email || '',
        address: customer.address || '',
        pppoeUsername: customer.pppoe_username || '',
        status: customer.status || 'active',
        isolateDay: customer.isolate_day || 10,
        installDate: customer.install_date || null,
        expiredAt: customer.expired_at || null,
        balance: Number(customer.balance || 0)
      },
      package: pkg ? {
        id: pkg.id,
        name: pkg.name,
        price: Number(pkg.price || 0),
        speed: pkg.speed || '',
        billingType: pkg.billing_type || 'postpaid'
      } : null,
      billing: {
        unpaidCount: unpaidInvoices.length,
        totalUnpaidAmount,
        latestUnpaidInvoice: unpaidInvoices[0] || null
      },
      ont: ontInfo
    }
  });
});

// ─── 4. TAGIHAN & PEMBAYARAN (INVOICES) ────────────────────────────────────────
router.get('/invoices', requireCustomerApiAuth, (req, res) => {
  const customerId = req.customer.id;
  const invoices = db.prepare(`
    SELECT i.*, p.name as package_name 
    FROM invoices i
    LEFT JOIN packages p ON p.id = (SELECT package_id FROM customers WHERE id = i.customer_id)
    WHERE i.customer_id = ?
    ORDER BY i.period_year DESC, i.period_month DESC, i.id DESC
  `).all(customerId) || [];

  res.json({
    success: true,
    data: invoices.map(inv => ({
      id: inv.id,
      invoiceNo: `#INV-${inv.id}`,
      periodMonth: inv.period_month,
      periodYear: inv.period_year,
      amount: Number(inv.amount || 0),
      status: inv.status || 'unpaid',
      paidAt: inv.paid_at,
      paymentGateway: inv.payment_gateway,
      notes: inv.notes || '',
      createdAt: inv.created_at
    }))
  });
});

router.get('/invoices/:id', requireCustomerApiAuth, async (req, res) => {
  const invId = Number(req.params.id);
  const inv = billingSvc.getInvoiceById(invId);

  if (!inv || Number(inv.customer_id) !== Number(req.customer.id)) {
    return res.status(404).json({ success: false, message: 'Tagihan tidak ditemukan.' });
  }

  res.json({
    success: true,
    data: {
      id: inv.id,
      invoiceNo: `#INV-${inv.id}`,
      customerName: inv.customer_name,
      customerPhone: inv.customer_phone,
      packageName: inv.package_name || '-',
      periodMonth: inv.period_month,
      periodYear: inv.period_year,
      amount: Number(inv.amount || 0),
      status: inv.status || 'unpaid',
      paidAt: inv.paid_at,
      paymentGateway: inv.payment_gateway,
      paymentOrderId: inv.payment_order_id,
      paymentLink: inv.payment_link
    }
  });
});

// Request Pembayaran Gateway (Tripay, Midtrans, Duitku, Xendit, QRIS Dinamis)
router.post('/invoices/:id/pay', requireCustomerApiAuth, async (req, res) => {
  const invId = Number(req.params.id);
  const { gateway = 'tripay', method = 'QRIS' } = req.body;
  const settings = getSettingsWithCache();
  const customer = req.customer;

  const inv = billingSvc.getInvoiceById(invId);
  if (!inv || Number(inv.customer_id) !== Number(customer.id)) {
    return res.status(404).json({ success: false, message: 'Tagihan tidak ditemukan.' });
  }
  if (inv.status === 'paid') {
    return res.json({ success: true, message: 'Tagihan ini sudah lunas.', status: 'paid' });
  }

  const appUrl = (settings.public_base_url || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
  const returnPath = `/customer/invoice/${invId}`;
  const opts = { orderPrefix: 'INV', returnPath, callbackPath: '/customer/payment/callback' };

  try {
    let result;
    const selectedGateway = String(gateway).toLowerCase();

    if (selectedGateway === 'midtrans') {
      result = await paymentSvc.createMidtransTransaction(inv, customer, method === 'SNAP' ? 'snap' : method, appUrl, opts);
    } else if (selectedGateway === 'xendit') {
      result = await paymentSvc.createXenditTransaction(inv, customer, method, appUrl, opts);
    } else if (selectedGateway === 'duitku') {
      result = await paymentSvc.createDuitkuTransaction(inv, customer, method, appUrl, opts);
    } else {
      result = await paymentSvc.createTripayTransaction(inv, customer, method || 'QRIS', appUrl, opts);
    }

    if (!result || !result.success) {
      return res.status(400).json({ success: false, message: result?.message || 'Gagal membuat transaksi pembayaran.' });
    }

    res.json({
      success: true,
      data: {
        invoiceId: inv.id,
        gateway: selectedGateway,
        method: method || 'QRIS',
        orderId: result.order_id,
        paymentLink: result.link || result.payment_url || null,
        qrUrl: result.qr_url || result.qr_image || null,
        payload: result.payload || null
      }
    });
  } catch (error) {
    logger.error(`[CustomerAPI] Payment creation error: ${error.message}`);
    res.status(500).json({ success: false, message: `Error membuat pembayaran: ${error.message}` });
  }
});

// Cek Status Pembayaran Real-time
router.get('/invoices/:id/check-status', requireCustomerApiAuth, (req, res) => {
  const invId = Number(req.params.id);
  const inv = db.prepare('SELECT id, status, paid_at, payment_gateway FROM invoices WHERE id = ? AND customer_id = ?').get(invId, req.customer.id);
  if (!inv) return res.status(404).json({ success: false, message: 'Tagihan tidak ditemukan.' });

  res.json({
    success: true,
    data: {
      invoiceId: inv.id,
      status: inv.status || 'unpaid',
      isPaid: inv.status === 'paid',
      paidAt: inv.paid_at,
      paymentGateway: inv.payment_gateway
    }
  });
});

// ─── 5. KONTROL WIFI & MODEM ONT (TR-069) ─────────────────────────────────────
router.get('/wifi', requireCustomerApiAuth, async (req, res) => {
  const customer = req.customer;
  const tokens = [customer.genieacs_tag, customer.pppoe_username, customer.phone].filter(Boolean);
  try {
    const liveDevice = await customerDevice.getCustomerDeviceData(tokens);
    if (!liveDevice) {
      return res.json({ success: true, available: false, message: 'Modem tidak terdeteksi atau offline di TR-069.' });
    }
    res.json({
      success: true,
      available: true,
      data: {
        online: liveDevice.online || false,
        model: liveDevice.model || '',
        ssid: liveDevice.ssid || '',
        rxPower: liveDevice.rxPower || null,
        uptime: liveDevice.uptime || ''
      }
    });
  } catch (e) {
    res.json({ success: true, available: false, message: e.message });
  }
});

router.post('/wifi/change-password', requireCustomerApiAuth, async (req, res) => {
  const { ssid, newPassword } = req.body;
  if (!newPassword || String(newPassword).length < 8) {
    return res.status(400).json({ success: false, message: 'Password WiFi minimal 8 karakter.' });
  }
  const customer = req.customer;
  const tokens = [customer.genieacs_tag, customer.pppoe_username, customer.phone].filter(Boolean);

  try {
    const token = tokens[0];
    let result;
    if (newPassword) {
      result = await customerDevice.updatePassword(token, newPassword);
    }
    if (ssid) {
      await customerDevice.updateSSID(token, ssid);
    }
    if (result && (result.ok || result.success)) {
      res.json({ success: true, message: 'Pengaturan WiFi berhasil diperbarui.' });
    } else {
      res.status(400).json({ success: false, message: result?.message || 'Gagal mengubah pengaturan WiFi pada modem.' });
    }
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

router.post('/wifi/reboot', requireCustomerApiAuth, async (req, res) => {
  const customer = req.customer;
  const tokens = [customer.genieacs_tag, customer.pppoe_username, customer.phone].filter(Boolean);
  try {
    const token = tokens[0];
    const result = await customerDevice.requestReboot(token);
    if (result && (result.ok || result.success)) {
      res.json({ success: true, message: 'Perintah restart modem telah dikirim. Modem akan menyala ulang dalam 1-2 menit.' });
    } else {
      res.status(400).json({ success: false, message: result?.message || 'Gagal merestart modem.' });
    }
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ─── 6. VOUCHER HOTSPOT ONLINE ────────────────────────────────────────────────
router.get('/vouchers', (req, res) => {
  const packages = db.prepare(`
    SELECT * FROM voucher_packages 
    WHERE is_active = 1 OR is_active IS NULL
    ORDER BY price ASC
  `).all() || [];

  res.json({
    success: true,
    data: packages.map(pkg => ({
      id: pkg.id,
      name: pkg.name || pkg.profile_name,
      profileName: pkg.profile_name,
      price: Number(pkg.price || 0),
      validity: pkg.validity || '-',
      description: pkg.description || ''
    }))
  });
});

// ─── 7. TIKET BANTUAN & LAPOR GANGGUAN ─────────────────────────────────────────
router.get('/tickets', requireCustomerApiAuth, (req, res) => {
  const customerId = req.customer.id;
  const tickets = db.prepare(`
    SELECT * FROM tickets 
    WHERE customer_id = ? 
    ORDER BY created_at DESC
  `).all(customerId) || [];

  res.json({
    success: true,
    data: tickets.map(t => ({
      id: t.id,
      ticketNo: `#TCK-${t.id}`,
      title: t.title || t.subject || 'Gangguan Layanan',
      description: t.description || '',
      status: t.status || 'open',
      priority: t.priority || 'medium',
      createdAt: t.created_at,
      updatedAt: t.updated_at
    }))
  });
});

router.post('/tickets/create', requireCustomerApiAuth, (req, res) => {
  const { title, description, priority = 'medium' } = req.body;
  if (!title || !description) {
    return res.status(400).json({ success: false, message: 'Judul dan rincian kendala harus diisi.' });
  }
  const customer = req.customer;

  try {
    const info = db.prepare(`
      INSERT INTO tickets (customer_id, title, description, priority, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'open', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `).run(customer.id, title.trim(), description.trim(), priority);

    res.json({
      success: true,
      message: 'Laporan gangguan Anda telah berhasil diajukan. Tim teknisi akan segera menindaklanjuti.',
      ticketId: info.lastInsertRowid
    });
  } catch (e) {
    res.status(500).json({ success: false, message: `Gagal membuat tiket: ${e.message}` });
  }
});

module.exports = router;
