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
  const now = new Date();
  const month = Math.max(1, Math.min(12, parseInt(req.query.month || (now.getMonth() + 1), 10) || (now.getMonth() + 1)));
  const year = parseInt(req.query.year || now.getFullYear(), 10) || now.getFullYear();
  const status = String(req.query.status || 'unpaid').trim() || 'unpaid'; // unpaid, paid, all
  const search = String(req.query.search || '').trim();
  const scope = String(req.query.scope || '').trim(); // today, unpaid, isolir
  const todayDay = now.getDate();

  let q = `
    SELECT i.*,
           c.name as customer_name,
           c.phone as customer_phone,
           c.address as customer_address,
           c.pppoe_username,
           c.genieacs_tag,
           c.connection_type,
           c.static_ip,
           c.status as customer_status,
           c.install_date,
           c.isolate_day,
           c.lat, c.lng,
           p.name as package_name,
           r.name as router_name
    FROM invoices i
    JOIN customers c ON i.customer_id = c.id
    LEFT JOIN packages p ON c.package_id = p.id
    LEFT JOIN routers r ON c.router_id = r.id
    WHERE 1=1
  `;
  const params = [];
  if (scope !== 'multi') {
    q += ' AND i.period_month=? AND i.period_year=?';
    params.push(month, year);
  }
  if (scope === 'today') {
    q += ' AND c.isolate_day = ?';
    params.push(todayDay);
  } else if (scope === 'isolir') {
    q += " AND c.status = 'suspended'";
  } else if (scope === 'multi') {
    q += `
      AND i.status='unpaid'
      AND i.customer_id IN (
        SELECT customer_id FROM invoices
        WHERE status='unpaid'
        GROUP BY customer_id
        HAVING COUNT(1) > 1
      )
    `;
  }
  if (status !== 'all') {
    q += ' AND i.status=?';
    params.push(status);
  }
  if (search) {
    q += ' AND (c.name LIKE ? OR c.phone LIKE ? OR c.genieacs_tag LIKE ? OR c.pppoe_username LIKE ?)';
    const like = `%${search}%`;
    params.push(like, like, like, like);
  }
  q += ' ORDER BY c.name ASC, i.id DESC LIMIT 500';
  const list = db.prepare(q).all(...params);

  const summaryPeriod = db.prepare(`
    SELECT
      SUM(CASE WHEN i.status='unpaid' THEN 1 ELSE 0 END) as unpaid_count,
      SUM(CASE WHEN i.status='unpaid' THEN i.amount ELSE 0 END) as unpaid_total,
      SUM(CASE WHEN i.status='unpaid' AND c.isolate_day=? THEN 1 ELSE 0 END) as today_count,
      SUM(CASE WHEN i.status='unpaid' AND c.isolate_day=? THEN i.amount ELSE 0 END) as today_total,
      SUM(CASE WHEN i.status='unpaid' AND c.status='suspended' THEN 1 ELSE 0 END) as isolir_count,
      SUM(CASE WHEN i.status='unpaid' AND c.status='suspended' THEN i.amount ELSE 0 END) as isolir_total
    FROM invoices i
    JOIN customers c ON i.customer_id = c.id
    WHERE i.period_month=? AND i.period_year=?
  `).get(todayDay, todayDay, month, year) || {};

  const summaryMulti = db.prepare(`
    SELECT
      COUNT(1) as multi_customer_count,
      SUM(x.cnt) as multi_invoice_count,
      SUM(x.total_amount) as multi_total
    FROM (
      SELECT customer_id, COUNT(1) as cnt, SUM(amount) as total_amount
      FROM invoices
      WHERE status='unpaid'
      GROUP BY customer_id
      HAVING COUNT(1) > 1
    ) x
  `).get() || {};

  const summary = { ...summaryPeriod, ...summaryMulti };

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
    month,
    year,
    status,
    search,
    scope,
    todayDay,
    summary,
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
  const qs = new URLSearchParams();
  if (req.body.month) qs.set('month', String(req.body.month));
  if (req.body.year) qs.set('year', String(req.body.year));
  if (req.body.status) qs.set('status', String(req.body.status));
  if (req.body.search) qs.set('search', String(req.body.search));
  const suffix = qs.toString() ? ('?' + qs.toString()) : '';
  res.redirect('/collector' + suffix);
});

module.exports = router;
