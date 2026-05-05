const express = require('express');
const router = express.Router();
const { getSetting } = require('../config/settingsManager');
const { logger } = require('../config/logger');
const db = require('../config/database');
const billingSvc = require('../services/billingService');
const customerSvc = require('../services/customerService');
const adminSvc = require('../services/adminService');

function requireCollectorSession(req, res, next) {
  if (req.session && req.session.isCollector && req.session.collectorId) return next();
  return res.redirect('/collector/login');
}

function company() {
  return getSetting('company_header', 'ISP App');
}

function flashMsg(req) {
  const m = req.session._msg;
  delete req.session._msg;
  return m || null;
}

router.get('/login', (req, res) => {
  if (req.session && req.session.isCollector) return res.redirect('/collector');
  res.render('collector/login', { title: 'Login Kolektor', company: company(), error: null });
});

router.post('/login', express.urlencoded({ extended: true }), (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  const collector = adminSvc.authenticateCollector(username, password);
  if (collector) {
    req.session.isCollector = true;
    req.session.collectorId = collector.id;
    req.session.collectorName = collector.name;
    req.session.collectorUsername = collector.username;
    return res.redirect('/collector');
  }
  return res.render('collector/login', { title: 'Login Kolektor', company: company(), error: 'Username atau password salah!' });
});

router.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/collector/login');
});

router.get('/', requireCollectorSession, (req, res) => {
  const q = String(req.query.q || '').trim();
  const invoices = q ? billingSvc.getInvoicesByAny(q) : [];
  const list = Array.isArray(invoices) ? invoices : [];

  const invoiceIds = list.map(i => Number(i?.id || 0)).filter(n => Number.isFinite(n) && n > 0);
  const pendingMap = new Map();
  if (invoiceIds.length > 0) {
    const placeholders = invoiceIds.map(() => '?').join(',');
    const rows = db.prepare(`
      SELECT r.*
      FROM collector_payment_requests r
      WHERE r.invoice_id IN (${placeholders})
      ORDER BY r.id DESC
    `).all(...invoiceIds);
    for (const r of rows) {
      const invId = Number(r.invoice_id || 0);
      if (!pendingMap.has(invId)) pendingMap.set(invId, r);
    }
  }

  const collectorId = Number(req.session.collectorId || 0);
  const myReqs = db.prepare(`
    SELECT r.*, i.period_month, i.period_year, i.amount as invoice_amount, c.name as customer_name, c.phone as customer_phone
    FROM collector_payment_requests r
    JOIN invoices i ON i.id = r.invoice_id
    JOIN customers c ON c.id = r.customer_id
    WHERE r.collector_id = ?
    ORDER BY r.id DESC
    LIMIT 60
  `).all(collectorId);

  res.render('collector/dashboard', {
    title: 'Dashboard Kolektor',
    company: company(),
    q,
    invoices: list,
    pendingMap,
    myReqs,
    msg: flashMsg(req)
  });
});

router.post('/payment-request', requireCollectorSession, express.urlencoded({ extended: true }), (req, res) => {
  try {
    const invoiceId = Number(req.body.invoice_id || 0);
    if (!Number.isFinite(invoiceId) || invoiceId <= 0) throw new Error('Invoice ID tidak valid');
    const note = String(req.body.note || '').trim();

    const inv = billingSvc.getInvoiceById(invoiceId);
    if (!inv) throw new Error('Tagihan tidak ditemukan');
    if (String(inv.status || '').toLowerCase() === 'paid') throw new Error('Tagihan sudah lunas');

    const existingPending = db.prepare(`
      SELECT id FROM collector_payment_requests
      WHERE invoice_id = ? AND status = 'pending'
      ORDER BY id DESC LIMIT 1
    `).get(invoiceId);
    if (existingPending) throw new Error('Tagihan ini sudah pernah diajukan dan masih menunggu approval');

    const collectorId = Number(req.session.collectorId || 0);
    const amount = Math.max(0, Number(inv.amount || 0) || 0);
    if (amount <= 0) throw new Error('Nominal tagihan tidak valid');

    db.prepare(`
      INSERT INTO collector_payment_requests (collector_id, invoice_id, customer_id, amount, note, status)
      VALUES (?, ?, ?, ?, ?, 'pending')
    `).run(collectorId, invoiceId, Number(inv.customer_id || 0), amount, note);

    req.session._msg = { type: 'success', text: 'Berhasil. Status pembayaran menunggu approval Admin/Kasir.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal: ' + (e.message || String(e)) };
  }
  res.redirect('/collector' + (req.body.q ? ('?q=' + encodeURIComponent(String(req.body.q))) : ''));
});

module.exports = router;

