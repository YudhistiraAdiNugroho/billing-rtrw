/**
 * Route Admin Dashboard — termasuk Billing System
 */
const express = require('express');
const router = express.Router();
const { getSetting, getSettings, saveSettings } = require('../config/settingsManager');
const { logger } = require('../config/logger');
const db = require('../config/database');
const customerDevice = require('../services/customerDeviceService');
const customerSvc = require('../services/customerService');
const billingSvc = require('../services/billingService');
const mikrotikService = require('../services/mikrotikService');
const adminSvc = require('../services/adminService');
const agentSvc = require('../services/agentService');
const oltSvc = require('../services/oltService');
const odpSvc = require('../services/odpService');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const XLSX = require('xlsx');
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage() });
const backupSvc = require('../services/backupService');
const monitoringSvc = require('../services/monitoringService');
const inventorySvc = require('../services/inventoryService');
const auditSvc = require('../services/auditTrailService');
const diagnosticsSvc = require('../services/diagnosticsService');
const attendanceSvc = require('../services/attendanceService');
const payrollSvc = require('../services/payrollService');
const axios = require('axios');
const crypto = require('crypto');

const DIGIFLAZZ_URL = 'https://api.digiflazz.com/v1';
const digiflazzApi = axios.create({
  baseURL: DIGIFLAZZ_URL,
  timeout: 30000,
  headers: { 'Content-Type': 'application/json' }
});

function digiflazzCreds() {
  const username = String(getSetting('digiflazz_username', '') || '').trim();
  const apiKey = String(getSetting('digiflazz_api_key', '') || '').trim();
  return { username, apiKey };
}

function digiflazzConfigured() {
  const { username, apiKey } = digiflazzCreds();
  return Boolean(username && apiKey);
}

function digiflazzSign(refId) {
  const { username, apiKey } = digiflazzCreds();
  if (!username || !apiKey) throw new Error('Digiflazz belum dikonfigurasi');
  return crypto.createHash('md5').update(username + apiKey + String(refId || '')).digest('hex');
}

async function digiflazzCekSaldo() {
  const { username } = digiflazzCreds();
  const sign = digiflazzSign('depo');
  const response = await digiflazzApi.post('/cek-saldo', { cmd: 'deposit', username, sign });
  const data = response?.data?.data;
  if (data?.rc) throw new Error(String(data?.message || 'Gagal cek saldo Digiflazz'));
  return data;
}

async function digiflazzPriceListAll() {
  const { username } = digiflazzCreds();
  const sign = digiflazzSign('pricelist');
  const response = await digiflazzApi.post('/price-list', { cmd: 'prepaid', username, sign });
  const data = response?.data?.data;
  if (!Array.isArray(data)) {
    const msg = response?.data?.data?.message || response?.data?.message || 'Gagal mengambil price list Digiflazz';
    throw new Error(String(msg));
  }
  return data;
}

const pppoeTrafficSamples = new Map();
function prunePppoeTrafficSamples(now) {
  for (const [k, v] of pppoeTrafficSamples.entries()) {
    if (!v || !v.t || (now - v.t) > 15000) pppoeTrafficSamples.delete(k);
  }
}

function numField(obj, keys) {
  if (!obj) return 0;
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null && obj[k] !== '') {
      const n = Number(obj[k]);
      if (Number.isFinite(n)) return n;
    }
    if (obj[String(k).toLowerCase()] !== undefined && obj[String(k).toLowerCase()] !== null && obj[String(k).toLowerCase()] !== '') {
      const n = Number(obj[String(k).toLowerCase()]);
      if (Number.isFinite(n)) return n;
    }
  }
  return 0;
}

function strField(obj, keys) {
  if (!obj) return '';
  for (const k of keys) {
    const v = obj[k] !== undefined ? obj[k] : obj[String(k).toLowerCase()];
    if (v !== undefined && v !== null && String(v).trim() !== '') return String(v).trim();
  }
  return '';
}

async function invokeRouterOsMenuCommand(menu, command, args) {
  if (!menu) return null;
  if (typeof menu.call === 'function') return await menu.call(command, args);
  if (typeof menu.command === 'function') return await menu.command(command, args);
  if (typeof menu.run === 'function') return await menu.run(command, args);
  return null;
}

// ─── AUTH ──────────────────────────────────────────────────────────────────
function requireAdmin(req, res, next) {
  if (req.session?.isAdmin || req.session?.isCashier) return next();
  const adminKey = getSetting('admin_api_key', '');
  const providedKey = req.headers['x-admin-key'] || req.query.key;
  if (adminKey && providedKey === adminKey) return next();
  return res.status(401).json({ error: 'Unauthorized - Admin/Staff access required' });
}

function requireAdminSession(req, res, next) {
  if (req.session?.isAdmin || req.session?.isCashier) return next();
  return res.redirect('/admin/login');
}

function resolvePaidByName(req, fallback) {
  const fb = String(fallback || '').trim();
  if (req.session?.isCashier) {
    const nm = String(req.session.cashierName || '').trim();
    const un = String(req.session.cashierUsername || '').trim();
    if (nm && un) return `Kasir ${nm} (@${un})`;
    if (nm) return `Kasir ${nm}`;
    return 'Kasir';
  }
  if (req.session?.isAdmin) return fb || 'Admin';
  return fb || 'Admin';
}

async function trySendWhatsappPayment(customerPhone, message) {
  try {
    if (!getSetting('whatsapp_enabled', false)) return false;
    const to = String(customerPhone || '').trim();
    if (!to) return false;
    const { sendWA, whatsappStatus } = await import('../services/whatsappBot.mjs');
    if (!whatsappStatus || whatsappStatus.connection !== 'open') return false;
    await sendWA(to, String(message || '').trim());
    return true;
  } catch {
    return false;
  }
}

// Middleware strictly for Admin
function restrictToAdmin(req, res, next) {
  if (req.session?.isAdmin) return next();
  req.session._msg = { type: 'error', text: 'Hanya Admin yang dapat mengakses halaman ini.' };
  return res.redirect('/admin');
}

function company() { return getSetting('company_header', 'ISP Admin'); }

function flashMsg(req) {
  const m = req.session._msg;
  delete req.session._msg;
  return m || null;
}

function popUpdateLog(req) {
  const l = req.session._updateLog;
  delete req.session._updateLog;
  return l || '';
}

function readTextFileSafe(filePath) {
  try {
    return String(fs.readFileSync(filePath, 'utf8')).trim();
  } catch (e) {
    return '';
  }
}

function runCmd(cmd, args, cwd) {
  try {
    const r = spawnSync(cmd, args, { cwd, encoding: 'utf8' });
    return { ok: r.status === 0, code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
  } catch (e) {
    return { ok: false, code: -1, stdout: '', stderr: String(e?.message || e) };
  }
}

function copyDirSync(srcDir, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  const entries = fs.readdirSync(srcDir, { withFileTypes: true });
  for (const ent of entries) {
    const src = path.join(srcDir, ent.name);
    const dst = path.join(destDir, ent.name);
    if (ent.isDirectory()) copyDirSync(src, dst);
    else if (ent.isFile()) fs.copyFileSync(src, dst);
  }
}

function getGitDefaultBranch(repoRoot) {
  const r = runCmd('git', ['symbolic-ref', 'refs/remotes/origin/HEAD'], repoRoot);
  if (r.ok) {
    const ref = String(r.stdout || '').trim();
    const m = ref.match(/refs\/remotes\/origin\/(.+)$/);
    if (m && m[1]) return m[1].trim();
  }
  return 'main';
}

function getUpdateInfo(repoRoot) {
  const localVersion = readTextFileSafe(path.join(repoRoot, 'version.txt')) || '-';
  const info = { localVersion, remoteVersion: '-', branch: '-', needsUpdate: false, error: '' };

  const inside = runCmd('git', ['rev-parse', '--is-inside-work-tree'], repoRoot);
  if (!inside.ok) {
    info.error = 'Folder ini belum menjadi git repository.';
    return info;
  }

  const branch = getGitDefaultBranch(repoRoot);
  info.branch = branch;

  const fetch = runCmd('git', ['fetch', '--prune'], repoRoot);
  if (!fetch.ok) {
    info.error = 'Gagal git fetch: ' + (fetch.stderr || fetch.stdout || '').trim();
    return info;
  }

  const remote = runCmd('git', ['show', `origin/${branch}:version.txt`], repoRoot);
  if (!remote.ok) {
    info.error = `Tidak bisa membaca version.txt dari GitHub (origin/${branch}).`;
    return info;
  }

  const remoteVersion = String(remote.stdout || '').trim() || '-';
  info.remoteVersion = remoteVersion;
  info.needsUpdate = Boolean(remoteVersion && remoteVersion !== '-' && remoteVersion !== localVersion);
  return info;
}

function parseMikhmonOnLogin(script) {
  if (!script) return null;
  const m = String(script).match(/",rem,.*?,(.*?),(.*?),.*?"/);
  if (!m) return null;
  const validity = String(m[1] || '').trim();
  const priceStr = String(m[2] || '').trim();
  const price = Number(String(priceStr).replace(/[^\d]/g, '')) || 0;
  return { validity, price };
}

function genCode(len, charset) {
  const n = Math.max(4, Math.min(16, Number(len) || 6));
  let chars = '0123456789';
  if (charset === 'letters') chars = 'abcdefghjkmnpqrstuvwxyz';
  else if (charset === 'mixed') chars = 'abcdefghjkmnpqrstuvwxyz23456789';
  let out = '';
  for (let i = 0; i < n; i++) {
    out += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  // Avoid starting with 0 if it's only numbers
  if (charset === 'numbers' && out[0] === '0') out = '1' + out.slice(1);
  return out;
}

async function createVoucherBatchAsync(batchId) {
  const batch = db.prepare('SELECT * FROM voucher_batches WHERE id = ?').get(batchId);
  if (!batch) return;

  const routerId = batch.router_id ?? null;
  const vouchers = db.prepare('SELECT id, code, profile_name FROM vouchers WHERE batch_id = ? ORDER BY id ASC').all(batchId);

  const updateVoucher = db.prepare('UPDATE vouchers SET code=?, password=?, comment=?, status=?, created_at=created_at WHERE id=?');
  const markVoucherCreated = db.prepare('UPDATE vouchers SET status=? WHERE id=?');
  const incCreated = db.prepare("UPDATE voucher_batches SET qty_created = qty_created + 1, updated_at = CURRENT_TIMESTAMP WHERE id=?");
  const incFailed = db.prepare("UPDATE voucher_batches SET qty_failed = qty_failed + 1, updated_at = CURRENT_TIMESTAMP WHERE id=?");
  const setBatchStatus = db.prepare("UPDATE voucher_batches SET status=?, updated_at = CURRENT_TIMESTAMP WHERE id=?");

  const existsCode = db.prepare('SELECT 1 FROM vouchers WHERE router_id IS ? AND code = ? LIMIT 1');

  const makeUniqueCode = () => {
    const prefix = String(batch.prefix || '').trim();
    const coreLen = Math.max(4, Math.min(16, (Number(batch.code_length) || 6) - prefix.length));
    const userCode = prefix + genCode(coreLen, batch.charset || 'numbers');
    
    let passCode = userCode;
    if (batch.mode === 'member') {
      passCode = genCode(coreLen, batch.charset || 'numbers');
    }
    
    return { userCode, passCode };
  };

  const poolLimit = 8;
  let idx = 0;

  const worker = async () => {
    while (idx < vouchers.length) {
      const current = vouchers[idx++];
      let generated = { userCode: current.code, passCode: current.password || current.code };
      let attempt = 0;
      while (attempt < 10) {
        attempt++;

        if (existsCode.get(routerId, generated.userCode) && generated.userCode !== current.code) {
          generated = makeUniqueCode();
          continue;
        }

        try {
          const comment = `vc-${generated.userCode}-${batch.profile_name}`;
          const userData = {
            server: 'all',
            name: generated.userCode,
            password: generated.passCode,
            profile: batch.profile_name,
            comment
          };
          if (batch.validity) userData['limit-uptime'] = batch.validity;

          await mikrotikService.addHotspotUser(userData, routerId);

          if (generated.userCode !== current.code || generated.passCode !== current.password) {
            updateVoucher.run(generated.userCode, generated.passCode, comment, 'created', current.id);
          } else {
            markVoucherCreated.run('created', current.id);
          }
          incCreated.run(batchId);
          break;
        } catch (e) {
          const msg = String(e?.message || e || '');
          const isDup = msg.toLowerCase().includes('already') || msg.toLowerCase().includes('exist') || msg.toLowerCase().includes('duplicate');
          if (isDup) {
            generated = makeUniqueCode();
            continue;
          }
          markVoucherCreated.run('failed', current.id);
          incFailed.run(batchId);
          break;
        }
      }
      if (attempt >= 10) {
        markVoucherCreated.run('failed', current.id);
        incFailed.run(batchId);
      }
    }
  };

  setBatchStatus.run('creating', batchId);
  const workers = Array.from({ length: poolLimit }, () => worker());
  await Promise.all(workers);

  const final = db.prepare('SELECT qty_total, qty_created, qty_failed FROM voucher_batches WHERE id=?').get(batchId);
  if (final.qty_created >= final.qty_total && final.qty_failed === 0) setBatchStatus.run('ready', batchId);
  else if (final.qty_created > 0) setBatchStatus.run('partial', batchId);
  else setBatchStatus.run('failed', batchId);
}

// Global locals middleware
router.use((req, res, next) => {
  res.locals.session = req.session;
  next();
});

// ─── AUTH ROUTES ───────────────────────────────────────────────────────────
router.get('/login', (req, res) => {
  if (req.session?.isAdmin || req.session?.isCashier) return res.redirect('/admin');
  res.render('admin/login', { title: 'Admin Login', company: company(), error: null });
});

router.post('/login', express.urlencoded({ extended: true }), (req, res) => {
  const { username, password } = req.body;
  if (username === getSetting('admin_username', 'admin') && password === getSetting('admin_password', 'admin123')) {
    req.session.isAdmin = true;
    req.session.adminUser = username;
    return res.redirect('/admin');
  }
  
  // Check Cashier
  const cashier = adminSvc.authenticateCashier(username, password);
  if (cashier) {
    req.session.isCashier = true;
    req.session.cashierId = cashier.id;
    req.session.cashierName = cashier.name;
    req.session.cashierUsername = cashier.username;
    return res.redirect('/admin');
  }

  res.render('admin/login', { title: 'Admin Login', company: company(), error: 'Username atau password salah' });
});

router.get('/logout', (req, res) => { req.session.destroy(); res.redirect('/admin/login'); });

// ─── OLT MANAGEMENT ────────────────────────────────────────────────────────
router.get('/olts', requireAdminSession, async (req, res) => {
  const olts = oltSvc.getAllOlts();
  
  res.render('admin/olts', { 
    title: 'Manajemen OLT', 
    company: company(), 
    activePage: 'olts', 
    olts, 
    msg: flashMsg(req) 
  });
});

router.get('/olts/:id/stats', requireAdminSession, async (req, res) => {
  try {
    const stats = await oltSvc.getOltStats(req.params.id, req.query.full === 'true');
    res.json(stats);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/olts/:id/onu/:index/reboot', requireAdminSession, restrictToAdmin, async (req, res) => {
  try {
    await oltSvc.rebootOnu(req.params.id, req.params.index);
    res.json({ success: true, message: 'Perintah reboot berhasil dikirim.' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/olts/:id/onu/:index/rename', requireAdminSession, restrictToAdmin, express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const { name } = req.body;
    if (!name) throw new Error('Nama tidak boleh kosong');
    await oltSvc.renameOnu(req.params.id, req.params.index, name);
    res.json({ success: true, message: 'Nama ONU berhasil diubah.' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/olts/:id/onu/authorize', requireAdminSession, restrictToAdmin, express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const output = await oltSvc.authorizeOnu(req.params.id, req.body);
    res.json({ success: true, message: 'Otorisasi berhasil.', output });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/olts/:id/onu/configure-wan', requireAdminSession, restrictToAdmin, express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const { method, sn } = req.body;
    let output;
    if (method === 'tr069') {
      output = await oltSvc.configureWanViaAcs(sn, req.body);
    } else {
      output = await oltSvc.configureOnuWan(req.params.id, req.body);
    }
    res.json({ success: true, message: 'Konfigurasi WAN berhasil.', output });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/olts', requireAdminSession, restrictToAdmin, express.urlencoded({ extended: true }), (req, res) => {
  try {
    oltSvc.createOlt(req.body);
    req.session._msg = { type: 'success', text: 'OLT berhasil ditambahkan.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal: ' + e.message };
  }
  res.redirect('/admin/olts');
});

router.post('/olts/:id/update', requireAdminSession, restrictToAdmin, express.urlencoded({ extended: true }), (req, res) => {
  try {
    oltSvc.updateOlt(req.params.id, req.body);
    req.session._msg = { type: 'success', text: 'OLT berhasil diperbarui.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal: ' + e.message };
  }
  res.redirect('/admin/olts');
});

router.post('/olts/:id/delete', requireAdminSession, restrictToAdmin, (req, res) => {
  try {
    oltSvc.deleteOlt(req.params.id);
    req.session._msg = { type: 'success', text: 'OLT berhasil dihapus.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal: ' + e.message };
  }
  res.redirect('/admin/olts');
});

// ─── ODP & MAP MANAGEMENT ───────────────────────────────────────────────────
router.get('/map', requireAdminSession, (req, res) => {
  const customers = customerSvc.getAllCustomers();
  const odps = odpSvc.getAllOdps();
  
  res.render('admin/map', { 
    title: 'Peta Jaringan', 
    company: company(), 
    activePage: 'map', 
    customers, 
    odps,
    msg: flashMsg(req),
    settings: getSettings()
  });
});

router.get('/api/customers/:id/pppoe-traffic', requireAdminSession, async (req, res) => {
  const customerId = Number(req.params.id);
  if (!customerId) return res.status(400).json({ ok: false, error: 'invalid_customer' });

  const customer = customerSvc.getCustomerById(customerId);
  if (!customer) return res.status(404).json({ ok: false, error: 'not_found' });

  const routerId = customer.router_id ? Number(customer.router_id) : null;
  const username = String(customer.pppoe_username || '').trim();

  if (!routerId || !username) {
    return res.json({ ok: true, available: false, online: false, username: username || null, rxMbps: 0, txMbps: 0 });
  }

  const now = Date.now();
  prunePppoeTrafficSamples(now);

  let conn = null;
  try {
    conn = await mikrotikService.getConnection(routerId);
    const sessions = await conn.client.menu('/ppp/active').where('name', username).get();
    if (!sessions || sessions.length === 0) {
      return res.json({ ok: true, available: true, online: false, username, rxMbps: 0, txMbps: 0 });
    }

    const s = sessions[0];
    let iface = strField(s, ['interface', 'interface-name', 'interfaceName', 'ifname', 'if-name', 'pppInterface']) || null;
    const baseSessionId = strField(s, ['.id', 'id', 'sessionId', 'session-id']) || `${username}`;
    const bytesIn = numField(s, ['bytesIn', 'bytes-in', 'bytes_in']);
    const bytesOut = numField(s, ['bytesOut', 'bytes-out', 'bytes_out']);
    const uptime = strField(s, ['uptime']) || null;

    if (!iface) {
      try {
        const pppoeSrvMenu = conn.client.menu('/interface/pppoe-server');
        let pppoeRows = [];
        try {
          pppoeRows = await pppoeSrvMenu.where('user', username).get();
        } catch {
          pppoeRows = await pppoeSrvMenu.get();
        }
        const hit = (Array.isArray(pppoeRows) ? pppoeRows : []).find(r => String(r.user || r['user'] || '').trim() === username);
        const ifaceName = strField(hit, ['name']);
        if (ifaceName) iface = ifaceName;
      } catch {}
    }

    const sessionId = `${baseSessionId}${iface ? `|${iface}` : ''}`;

    const key = `${routerId || 'default'}:${username}`;
    const prev = pppoeTrafficSamples.get(key);
    let rxBytes = bytesIn;
    let txBytes = bytesOut;
    let source = 'ppp-active';

    if (iface) {
      const ifMenu = conn.client.menu('/interface');
      if (ifMenu) {
        try {
          const mtRaw = await invokeRouterOsMenuCommand(ifMenu, 'monitor-traffic', { interface: iface, once: '' });
          const mt = Array.isArray(mtRaw) ? mtRaw[0] : mtRaw;
          const rxBps = numField(mt, ['rxBitsPerSecond', 'rx-bits-per-second', 'rx-bits-per-second']);
          const txBps = numField(mt, ['txBitsPerSecond', 'tx-bits-per-second', 'tx-bits-per-second']);
          if (rxBps || txBps) {
            return res.json({
              ok: true,
              available: true,
              online: true,
              username,
              iface,
              source: 'monitor-traffic',
              uptime,
              rxMbps: (Number(rxBps) || 0) / 1e6,
              txMbps: (Number(txBps) || 0) / 1e6
            });
          }
        } catch {}
      }
    }

    if (iface) {
      try {
        const ifRows = await conn.client.menu('/interface').where('name', iface).get();
        if (ifRows && ifRows.length > 0) {
          const row = ifRows[0];
          const ifRx = numField(row, ['rxByte', 'rx-byte', 'rx-bytes', 'rxBytes']);
          const ifTx = numField(row, ['txByte', 'tx-byte', 'tx-bytes', 'txBytes']);
          if (ifRx || ifTx) {
            rxBytes = ifRx;
            txBytes = ifTx;
            source = 'interface';
          }
        }
      } catch {}
    }

    pppoeTrafficSamples.set(key, { t: now, sessionId, rxBytes, txBytes, source });

    if (!prev || prev.sessionId !== sessionId || !prev.t) {
      return res.json({
        ok: true,
        available: true,
        online: true,
        warmup: true,
        username,
        iface,
        source,
        uptime,
        rxMbps: 0,
        txMbps: 0
      });
    }

    const dtMs = Math.max(1, now - prev.t);
    const dIn = rxBytes - numField(prev, ['rxBytes']);
    const dOut = txBytes - numField(prev, ['txBytes']);
    if (dIn < 0 || dOut < 0) {
      return res.json({
        ok: true,
        available: true,
        online: true,
        warmup: true,
        username,
        iface,
        source,
        uptime,
        rxMbps: 0,
        txMbps: 0
      });
    }

    const rxMbps = (dIn * 8) / (dtMs / 1000) / 1e6;
    const txMbps = (dOut * 8) / (dtMs / 1000) / 1e6;

    return res.json({
      ok: true,
      available: true,
      online: true,
      username,
      iface,
      source,
      uptime,
      rxMbps: Number.isFinite(rxMbps) ? rxMbps : 0,
      txMbps: Number.isFinite(txMbps) ? txMbps : 0
    });
  } catch (e) {
    return res.json({ ok: false, error: e.message || 'failed' });
  } finally {
    if (conn && conn.api) conn.api.close();
  }
});

router.post('/api/customers/:id/cable-path', requireAdminSession, (req, res) => {
  try {
    const id = Number(req.params.id);
    const { path } = req.body;
    if (!id) throw new Error('ID pelanggan tidak valid');
    customerSvc.updateCustomerCablePath(id, path);
    res.json({ ok: true });
  } catch (e) {
    console.error('[API] Save Cable Path Error:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.post('/odps', requireAdminSession, restrictToAdmin, express.urlencoded({ extended: true }), (req, res) => {
  try {
    odpSvc.createOdp(req.body);
    req.session._msg = { type: 'success', text: 'ODP berhasil ditambahkan.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal: ' + e.message };
  }
  res.redirect('/admin/map');
});

router.post('/odps/:id/update', requireAdminSession, restrictToAdmin, express.urlencoded({ extended: true }), (req, res) => {
  try {
    odpSvc.updateOdp(req.params.id, req.body);
    req.session._msg = { type: 'success', text: 'ODP berhasil diperbarui.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal: ' + e.message };
  }
  res.redirect('/admin/map');
});

router.post('/odps/:id/delete', requireAdminSession, restrictToAdmin, (req, res) => {
  try {
    odpSvc.deleteOdp(req.params.id);
    req.session._msg = { type: 'success', text: 'ODP berhasil dihapus.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal: ' + e.message };
  }
  res.redirect('/admin/map');
});

// --- TECHNICIAN MANAGEMENT ---
router.get('/technicians', requireAdminSession, restrictToAdmin, (req, res) => {
  const technicians = adminSvc.getAllTechnicians();
  res.render('admin/technicians', { title: 'Manajemen Teknisi', company: company(), activePage: 'technicians', technicians, msg: flashMsg(req) });
});

router.post('/technicians', requireAdminSession, restrictToAdmin, express.urlencoded({ extended: true }), (req, res) => {
  try {
    adminSvc.createTechnician(req.body);
    req.session._msg = { type: 'success', text: 'Teknisi berhasil ditambahkan.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal: ' + e.message };
  }
  res.redirect('/admin/technicians');
});

router.post('/technicians/:id/update', requireAdminSession, restrictToAdmin, express.urlencoded({ extended: true }), (req, res) => {
  try {
    adminSvc.updateTechnician(req.params.id, req.body);
    req.session._msg = { type: 'success', text: 'Data teknisi diperbarui.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal: ' + e.message };
  }
  res.redirect('/admin/technicians');
});

router.post('/technicians/:id/delete', requireAdminSession, restrictToAdmin, (req, res) => {
  adminSvc.deleteTechnician(req.params.id);
  req.session._msg = { type: 'success', text: 'Teknisi berhasil dihapus.' };
  res.redirect('/admin/technicians');
});

// --- CASHIER MANAGEMENT ---
router.get('/cashiers', requireAdminSession, restrictToAdmin, (req, res) => {
  const cashiers = adminSvc.getAllCashiers();
  res.render('admin/cashiers', { title: 'Manajemen Kasir', company: company(), activePage: 'cashiers', cashiers, msg: flashMsg(req) });
});

router.post('/cashiers', requireAdminSession, restrictToAdmin, express.urlencoded({ extended: true }), (req, res) => {
  try {
    adminSvc.createCashier(req.body);
    req.session._msg = { type: 'success', text: 'Kasir berhasil ditambahkan.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal: ' + e.message };
  }
  res.redirect('/admin/cashiers');
});

router.post('/cashiers/:id/update', requireAdminSession, restrictToAdmin, express.urlencoded({ extended: true }), (req, res) => {
  try {
    adminSvc.updateCashier(req.params.id, req.body);
    req.session._msg = { type: 'success', text: 'Data kasir diperbarui.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal: ' + e.message };
  }
  res.redirect('/admin/cashiers');
});

router.post('/cashiers/:id/delete', requireAdminSession, restrictToAdmin, (req, res) => {
  adminSvc.deleteCashier(req.params.id);
  req.session._msg = { type: 'success', text: 'Kasir berhasil dihapus.' };
  res.redirect('/admin/cashiers');
});

// --- COLLECTOR MANAGEMENT ---
router.get('/collectors', requireAdminSession, restrictToAdmin, (req, res) => {
  const collectors = adminSvc.getAllCollectors();
  res.render('admin/collectors', { title: 'Manajemen Kolektor', company: company(), activePage: 'collectors', collectors, msg: flashMsg(req) });
});

router.post('/collectors', requireAdminSession, restrictToAdmin, express.urlencoded({ extended: true }), (req, res) => {
  try {
    adminSvc.createCollector(req.body);
    req.session._msg = { type: 'success', text: 'Kolektor berhasil ditambahkan.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal: ' + e.message };
  }
  res.redirect('/admin/collectors');
});

router.post('/collectors/:id/update', requireAdminSession, restrictToAdmin, express.urlencoded({ extended: true }), (req, res) => {
  try {
    adminSvc.updateCollector(req.params.id, req.body);
    req.session._msg = { type: 'success', text: 'Data kolektor diperbarui.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal: ' + e.message };
  }
  res.redirect('/admin/collectors');
});

router.post('/collectors/:id/delete', requireAdminSession, restrictToAdmin, (req, res) => {
  adminSvc.deleteCollector(req.params.id);
  req.session._msg = { type: 'success', text: 'Kolektor berhasil dihapus.' };
  res.redirect('/admin/collectors');
});

router.get('/collector-payments', requireAdminSession, (req, res) => {
  const status = String(req.query.status || 'pending').trim() || 'pending';
  const rows = db.prepare(`
    SELECT r.*,
           col.name as collector_name, col.username as collector_username,
           i.period_month, i.period_year, i.amount as invoice_amount, i.status as invoice_status,
           c.name as customer_name, c.phone as customer_phone, c.address as customer_address, c.lat, c.lng
    FROM collector_payment_requests r
    JOIN collectors col ON col.id = r.collector_id
    JOIN invoices i ON i.id = r.invoice_id
    JOIN customers c ON c.id = r.customer_id
    WHERE r.status = ?
    ORDER BY r.id DESC
    LIMIT 500
  `).all(status);

  res.render('admin/collector_payments', {
    title: 'Approval Pembayaran Kolektor',
    company: company(),
    activePage: 'collector_payments',
    status,
    rows,
    msg: flashMsg(req)
  });
});

router.post('/collector-payments/:id/approve', requireAdminSession, express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const id = Number(req.params.id || 0);
    if (!Number.isFinite(id) || id <= 0) throw new Error('ID tidak valid');
    const decidedNote = String(req.body.decided_note || '').trim();

    const row = db.prepare(`
      SELECT r.*, col.name as collector_name, col.username as collector_username
      FROM collector_payment_requests r
      JOIN collectors col ON col.id = r.collector_id
      WHERE r.id = ?
    `).get(id);
    if (!row) throw new Error('Request tidak ditemukan');
    if (String(row.status) !== 'pending') throw new Error('Request sudah diproses');

    const inv = billingSvc.getInvoiceById(row.invoice_id);
    if (!inv) throw new Error('Invoice tidak ditemukan');
    if (String(inv.status) === 'paid') {
      db.prepare(`
        UPDATE collector_payment_requests
        SET status='rejected', decided_by_role=?, decided_by_name=?, decided_note=?, decided_at=CURRENT_TIMESTAMP
        WHERE id=?
      `).run(req.session.isCashier ? 'cashier' : 'admin', resolvePaidByName(req, 'Admin'), 'Invoice sudah lunas', id);
      req.session._msg = { type: 'error', text: 'Invoice sudah lunas, request ditolak.' };
      return res.redirect('back');
    }

    const collectorLabel =
      (`Kolektor ${(String(row.collector_name || '').trim())}` +
        (String(row.collector_username || '').trim() ? ` (@${String(row.collector_username).trim()})` : '')).trim();

    const approver = resolvePaidByName(req, 'Admin');
    const notesParts = [
      'Via Kolektor',
      collectorLabel,
      `Approved oleh ${approver}`,
    ];
    if (row.note) notesParts.push(String(row.note));
    if (decidedNote) notesParts.push(`Approval: ${decidedNote}`);
    const notes = notesParts.join(' | ');

    billingSvc.markAsPaid(Number(row.invoice_id), collectorLabel, notes);

    db.prepare(`
      UPDATE collector_payment_requests
      SET status='approved', decided_by_role=?, decided_by_name=?, decided_note=?, decided_at=CURRENT_TIMESTAMP
      WHERE id=?
    `).run(req.session.isCashier ? 'cashier' : 'admin', approver, decidedNote, id);

    const customer = customerSvc.getCustomerById(inv.customer_id);
    if (customer && customer.phone) {
      const msg =
        `✅ *PEMBAYARAN BERHASIL*\n\n` +
        `👤 *Pelanggan:* ${customer.name}\n` +
        `🧾 *Invoice:* #${inv.id}\n` +
        `📅 *Periode:* ${inv.period_month}/${inv.period_year}\n` +
        `💰 *Nominal Tagihan:* Rp ${Number(inv.amount || 0).toLocaleString('id-ID')}\n` +
        `🏷️ *Dibayar Via:* ${collectorLabel}\n\n` +
        `Terima kasih.`;
      await trySendWhatsappPayment(customer.phone, msg);
    }

    const freshCustomer = customerSvc.getAllCustomers().find(c => Number(c.id) === Number(inv.customer_id));
    if (freshCustomer && freshCustomer.status === 'suspended' && freshCustomer.unpaid_count === 0) {
      await customerSvc.activateCustomer(inv.customer_id);
    }

    req.session._msg = { type: 'success', text: 'Request disetujui dan invoice dilunasi.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal: ' + (e.message || String(e)) };
  }
  res.redirect('back');
});

router.post('/collector-payments/:id/reject', requireAdminSession, express.urlencoded({ extended: true }), (req, res) => {
  try {
    const id = Number(req.params.id || 0);
    if (!Number.isFinite(id) || id <= 0) throw new Error('ID tidak valid');
    const decidedNote = String(req.body.decided_note || '').trim();
    const row = db.prepare(`SELECT * FROM collector_payment_requests WHERE id=?`).get(id);
    if (!row) throw new Error('Request tidak ditemukan');
    if (String(row.status) !== 'pending') throw new Error('Request sudah diproses');
    const approver = resolvePaidByName(req, 'Admin');
    db.prepare(`
      UPDATE collector_payment_requests
      SET status='rejected', decided_by_role=?, decided_by_name=?, decided_note=?, decided_at=CURRENT_TIMESTAMP
      WHERE id=?
    `).run(req.session.isCashier ? 'cashier' : 'admin', approver, decidedNote, id);
    req.session._msg = { type: 'success', text: 'Request ditolak.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal: ' + (e.message || String(e)) };
  }
  res.redirect('back');
});
// ─── CASHIER ATTENDANCE ──────────────────────────────────────────────────────
router.get('/cashiers/attendance', requireAdminSession, (req, res) => {
  try {
    const cashierId = req.session.cashierId || null;
    const cashierName = req.session.cashierName || req.session.username || 'Kasir';
    
    if (!cashierId) {
      req.session._msg = { type: 'error', text: 'Session kasir tidak valid' };
      return res.redirect('/admin');
    }

    const todayAttendance = attendanceSvc.getTodayAttendance('cashier', cashierId);
    const history = attendanceSvc.getAttendanceHistory('cashier', cashierId, 10);
    
    const now = new Date();
    const summary = attendanceSvc.getMonthlyAttendanceSummary(
      'cashier', 
      cashierId, 
      now.getFullYear(), 
      now.getMonth() + 1
    );
    
    res.render('admin/cashier_attendance', {
      title: 'Absensi Saya',
      company: company(),
      activePage: 'cashier_attendance',
      session: req.session,
      cashierName,
      todayAttendance,
      history,
      summary,
      msg: flashMsg(req),
      t: (key, defaultVal) => defaultVal || key
    });
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal memuat absensi: ' + e.message };
    res.redirect('/admin');
  }
});

router.post('/cashiers/attendance/checkin', requireAdminSession, express.json(), (req, res) => {
  try {
    const cashierId = req.session.cashierId;
    const cashierName = req.session.cashierName || req.session.username;
    
    if (!cashierId) {
      return res.json({ success: false, message: 'Session kasir tidak valid' });
    }
    
    const today = attendanceSvc.getTodayAttendance('cashier', cashierId);
    if (today) {
      return res.json({ success: false, message: 'Anda sudah melakukan check-in hari ini' });
    }
    
    const result = attendanceSvc.checkIn({
      employee_type: 'cashier',
      employee_id: cashierId,
      employee_name: cashierName,
      lat: req.body.lat || '',
      lng: req.body.lng || '',
      note: req.body.note || ''
    });
    
    res.json({ success: true, message: 'Check-in berhasil!', id: result.lastInsertRowid });
  } catch (e) {
    res.json({ success: false, message: 'Gagal check-in: ' + e.message });
  }
});

router.post('/cashiers/attendance/checkout', requireAdminSession, express.json(), (req, res) => {
  try {
    const cashierId = req.session.cashierId;
    
    if (!cashierId) {
      return res.json({ success: false, message: 'Session kasir tidak valid' });
    }
    
    const today = attendanceSvc.getTodayAttendance('cashier', cashierId);
    if (!today) {
      return res.json({ success: false, message: 'Anda belum check-in hari ini' });
    }
    
    if (today.status === 'checked_out') {
      return res.json({ success: false, message: 'Anda sudah check-out hari ini' });
    }
    
    attendanceSvc.checkOut(today.id, {
      lat: req.body.lat || '',
      lng: req.body.lng || '',
      note: req.body.note || ''
    });
    
    res.json({ success: true, message: 'Check-out berhasil!' });
  } catch (e) {
    res.json({ success: false, message: 'Gagal check-out: ' + e.message });
  }
});


router.get('/cashiers/reports', requireAdminSession, (req, res) => {
  const allCashiers = adminSvc.getAllCashiers();
  const isAdmin = Boolean(req.session?.isAdmin);
  const isCashier = Boolean(req.session?.isCashier);

  const requested = req.query.cashierId != null && String(req.query.cashierId).trim() !== ''
    ? Number(req.query.cashierId)
    : null;

  const cashierId =
    isCashier && !isAdmin
      ? Number(req.session.cashierId || 0) || null
      : requested;

  const selectedCashier = cashierId
    ? (allCashiers || []).find(c => Number(c.id) === Number(cashierId)) || null
    : null;

  const paidByExact = selectedCashier
    ? (`Kasir ${(String(selectedCashier.name || '').trim())}` + (String(selectedCashier.username || '').trim() ? ` (@${String(selectedCashier.username).trim()})` : '')).trim()
    : null;

  const invWhere = [];
  const invParams = [];
  invWhere.push(`i.status='paid'`);
  invWhere.push(`i.paid_by_name LIKE 'Kasir %'`);
  if (paidByExact) {
    invWhere.push(`i.paid_by_name = ?`);
    invParams.push(paidByExact);
  }

  const invoiceRows = db.prepare(`
    SELECT i.id as ref_id,
           i.paid_at as at,
           i.paid_by_name as actor_name,
           i.amount as amount,
           i.notes as notes,
           i.period_month,
           i.period_year,
           c.name as customer_name,
           c.phone as customer_phone,
           p.name as package_name
    FROM invoices i
    JOIN customers c ON i.customer_id = c.id
    LEFT JOIN packages p ON c.package_id = p.id
    WHERE ${invWhere.join(' AND ')}
    ORDER BY datetime(i.paid_at) DESC, i.id DESC
    LIMIT 500
  `).all(...invParams).map(r => ({
    kind: 'invoice',
    at: r.at,
    actor_name: r.actor_name,
    amount: Number(r.amount || 0),
    notes: r.notes || '',
    ref_id: r.ref_id,
    customer_name: r.customer_name || '',
    customer_phone: r.customer_phone || '',
    period_month: r.period_month,
    period_year: r.period_year,
    package_name: r.package_name || ''
  }));

  const topupWhere = [];
  const topupParams = [];
  topupWhere.push(`t.type='topup'`);
  topupWhere.push(`t.note LIKE 'Kasir %:%'`);
  if (paidByExact) {
    topupWhere.push(`t.note LIKE ?`);
    topupParams.push(`${paidByExact}:%`);
  }

  const topupRows = db.prepare(`
    SELECT t.id as ref_id,
           t.created_at as at,
           t.amount_buy as amount,
           t.note as notes,
           a.name as agent_name,
           a.username as agent_username
    FROM agent_transactions t
    JOIN agents a ON t.agent_id = a.id
    WHERE ${topupWhere.join(' AND ')}
    ORDER BY datetime(t.created_at) DESC, t.id DESC
    LIMIT 500
  `).all(...topupParams).map(r => {
    const rawNote = String(r.notes || '');
    const idx = rawNote.indexOf(':');
    const actor = idx > 0 ? rawNote.slice(0, idx).trim() : '';
    const rest = idx > 0 ? rawNote.slice(idx + 1).trim() : rawNote.trim();
    return {
      kind: 'agent_topup',
      at: r.at,
      actor_name: actor || 'Kasir',
      amount: Number(r.amount || 0),
      notes: rest,
      ref_id: r.ref_id,
      agent_name: r.agent_name || '',
      agent_username: r.agent_username || ''
    };
  });

  const rows = [...invoiceRows, ...topupRows].sort((a, b) => {
    const atA = a && a.at ? String(a.at) : '';
    const atB = b && b.at ? String(b.at) : '';
    if (atA !== atB) return atB.localeCompare(atA);
    return Number(b?.ref_id || 0) - Number(a?.ref_id || 0);
  }).slice(0, 800);

  const invSumRow = db.prepare(`
    SELECT COUNT(1) as cnt, SUM(i.amount) as total
    FROM invoices i
    WHERE ${invWhere.join(' AND ')}
  `).get(...invParams);

  const topupSumRow = db.prepare(`
    SELECT COUNT(1) as cnt, SUM(t.amount_buy) as total
    FROM agent_transactions t
    WHERE ${topupWhere.join(' AND ')}
  `).get(...topupParams);

  const safeCashiers = isAdmin
    ? allCashiers
    : selectedCashier
      ? [selectedCashier]
      : [];

  res.render('admin/cashier_reports', {
    title: 'Laporan Kasir',
    company: company(),
    activePage: 'cashiers_reports',
    cashiers: safeCashiers,
    cashierId: cashierId || '',
    paidByExact: paidByExact || '',
    rows,
    summary: {
      count: Number(invSumRow?.cnt || 0) + Number(topupSumRow?.cnt || 0),
      total: Number(invSumRow?.total || 0) + Number(topupSumRow?.total || 0),
      invoice_count: Number(invSumRow?.cnt || 0),
      invoice_total: Number(invSumRow?.total || 0),
      topup_count: Number(topupSumRow?.cnt || 0),
      topup_total: Number(topupSumRow?.total || 0)
    },
    msg: flashMsg(req)
  });
});

// --- AGENT MANAGEMENT ---
router.get('/agents', requireAdminSession, (req, res) => {
  const agents = agentSvc.getAllAgents();
  const routers = mikrotikService.getAllRouters();
  res.render('admin/agents', {
    title: 'Manajemen Agent',
    company: company(),
    activePage: 'agents',
    agents,
    routers,
    msg: flashMsg(req)
  });
});

router.post('/agents', requireAdminSession, restrictToAdmin, express.urlencoded({ extended: true }), (req, res) => {
  try {
    agentSvc.createAgent(req.body);
    req.session._msg = { type: 'success', text: 'Agent berhasil ditambahkan.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal: ' + e.message };
  }
  res.redirect('/admin/agents');
});

router.post('/agents/:id/update', requireAdminSession, restrictToAdmin, express.urlencoded({ extended: true }), (req, res) => {
  try {
    agentSvc.updateAgent(req.params.id, req.body);
    req.session._msg = { type: 'success', text: 'Data agent diperbarui.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal: ' + e.message };
  }
  res.redirect('/admin/agents');
});

router.post('/agents/:id/delete', requireAdminSession, restrictToAdmin, (req, res) => {
  try {
    agentSvc.deleteAgent(req.params.id);
    req.session._msg = { type: 'success', text: 'Agent berhasil dihapus.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal: ' + e.message };
  }
  res.redirect('/admin/agents');
});

router.post('/agents/:id/topup', requireAdminSession, express.urlencoded({ extended: true }), (req, res) => {
  try {
    const amount = Number(req.body.amount || 0);
    const note = String(req.body.note || '').trim();
    const actorName = req.session?.isCashier ? resolvePaidByName(req, 'Kasir') : (req.session.adminUser || 'Admin');
    agentSvc.topupAgent(req.params.id, amount, note, actorName);
    req.session._msg = { type: 'success', text: 'Topup saldo berhasil.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal topup: ' + e.message };
  }
  res.redirect('/admin/agents');
});

router.get('/agents/reports', requireAdminSession, restrictToAdmin, (req, res) => {
  const agents = agentSvc.getAllAgents();
  const agentId = req.query.agentId ? Number(req.query.agentId) : null;
  const txs = agentSvc.listAgentTransactions({ agentId, limit: 500 });
  res.render('admin/agent_reports', {
    title: 'Laporan Agent',
    company: company(),
    activePage: 'agents_reports',
    agents,
    agentId,
    txs,
    msg: flashMsg(req)
  });
});

router.get('/api/agents/:id/prices', requireAdmin, restrictToAdmin, (req, res) => {
  try {
    const rows = agentSvc.getAgentPrices(Number(req.params.id));
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/api/agents/:id/prices', requireAdmin, restrictToAdmin, express.json(), (req, res) => {
  try {
    const agentId = Number(req.params.id);
    const result = agentSvc.upsertAgentHotspotPrice(agentId, req.body);
    res.json({ success: true, result });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/api/agents/:id/prices/:priceId/delete', requireAdmin, restrictToAdmin, (req, res) => {
  try {
    const agentId = Number(req.params.id);
    const priceId = Number(req.params.priceId);
    const result = agentSvc.deleteAgentHotspotPrice(agentId, priceId);
    res.json({ success: true, result });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ─── DASHBOARD ─────────────────────────────────────────────────────────────
router.get('/', requireAdminSession, async (req, res) => {
  try {
    const billing = billingSvc.getDashboardStats();
    const custStats = customerSvc.getCustomerStats();
    res.render('admin/dashboard', {
      title: 'Dashboard', company: company(), version: '2.0.0',
      activePage: 'dashboard', billing, custStats
    });
  } catch (e) {
    logger.error('Admin dashboard error:', e);
    res.status(500).send('Error loading dashboard: ' + e.message);
  }
});

// ─── DEVICE ROUTES (existing) ───────────────────────────────────────────────
router.get('/devices', requireAdminSession, (req, res) => {
  res.render('admin/dashboard', { title: 'Monitoring ONU', company: company(), version: '2.0.0', activePage: 'devices', billing: null, custStats: null });
});

router.get('/bulk', requireAdminSession, (req, res) => {
  res.render('admin/dashboard', { title: 'Konfigurasi Massal', company: company(), version: '2.0.0', activePage: 'bulk', billing: null, custStats: null });
});

// ─── CUSTOMERS ─────────────────────────────────────────────────────────────
router.get('/customers', requireAdminSession, (req, res) => {
  const { search = '', status: filterStatus = '' } = req.query;
  const customers = customerSvc.getAllCustomers(search);
  const stats = customerSvc.getCustomerStats();
  const packages = customerSvc.getAllPackages();
  const routers = mikrotikService.getAllRouters();
  const olts = oltSvc.getAllOlts();
  const odps = odpSvc.getAllOdps();

  // Apply status filter in JS if provided
  const filteredCustomers = filterStatus 
    ? customers.filter(c => c.status === filterStatus)
    : customers;

  res.render('admin/customers', {
    title: 'Data Pelanggan', company: company(), activePage: 'customers',
    customers: filteredCustomers, stats, packages, routers, olts, odps, search, filterStatus, msg: flashMsg(req),
    settings: getSettings()
  });
});

router.post('/customers', requireAdminSession, express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const connectionType = String(req.body.connection_type || 'pppoe').trim().toLowerCase() || 'pppoe';
    req.body.connection_type = connectionType;

    if (connectionType !== 'pppoe') req.body.pppoe_username = '';
    if (connectionType !== 'static') req.body.static_ip = '';
    if (connectionType !== 'hotspot') {
      req.body.hotspot_username = '';
      req.body.hotspot_password = '';
      req.body.hotspot_profile = '';
    }

    if (connectionType === 'pppoe') {
      const routerId = req.body.router_id ? Number(req.body.router_id) : null;
      const username = String(req.body.pppoe_username || '').trim();
      req.body.pppoe_username = username;
      if (!username) throw new Error('PPPoE Username tidak boleh kosong');
      const existing = db.prepare('SELECT id, name FROM customers WHERE router_id IS ? AND pppoe_username = ? LIMIT 1').get(routerId, username);
      if (existing) throw new Error(`PPPoE Username sudah dipakai pelanggan lain: ${existing.name}`);

      let conn = null;
      try {
        conn = await mikrotikService.getConnection(routerId);
        const results = await conn.client.menu('/ppp/secret')
          .where('service', 'pppoe')
          .where('name', username)
          .get();
        if (!Array.isArray(results) || results.length === 0) throw new Error('PPPoE Username tidak ditemukan di MikroTik');
      } finally {
        if (conn && conn.api) conn.api.close();
      }
    }

    if (connectionType === 'hotspot') {
      const routerId = req.body.router_id ? Number(req.body.router_id) : null;
      const username = String(req.body.hotspot_username || '').trim();
      req.body.hotspot_username = username;
      if (!username) throw new Error('Hotspot Username tidak boleh kosong');
      const existing = db.prepare('SELECT id, name FROM customers WHERE router_id IS ? AND hotspot_username = ? LIMIT 1').get(routerId, username);
      if (existing) throw new Error(`Hotspot Username sudah dipakai pelanggan lain: ${existing.name}`);

      const password = String(req.body.hotspot_password || '').trim() || username;
      req.body.hotspot_password = password;

      let profile = String(req.body.hotspot_profile || '').trim();
      if (!profile && req.body.package_id) {
        const pkg = customerSvc.getPackageById(req.body.package_id);
        if (pkg) profile = String(pkg.name || '').trim();
      }
      req.body.hotspot_profile = profile;
      if (!profile) throw new Error('Hotspot User Profile tidak boleh kosong');

      const profs = await mikrotikService.getHotspotUserProfiles(routerId);
      const ok = Array.isArray(profs) && profs.some(p => String(p?.name || '').trim() === profile);
      if (!ok) throw new Error(`Hotspot User Profile "${profile}" tidak ditemukan di MikroTik`);
    }

    customerSvc.createCustomer(req.body);
    
    // Sync to MikroTik if username provided
    if (connectionType === 'pppoe' && req.body.pppoe_username) {
      let targetProfile = '';
      if (req.body.status === 'suspended') {
        targetProfile = req.body.isolir_profile || 'isolir';
      } else if (req.body.package_id) {
        const pkg = customerSvc.getPackageById(req.body.package_id);
        if (pkg) targetProfile = pkg.name;
      }
      if (targetProfile) {
        try {
          await mikrotikService.setPppoeProfile(req.body.pppoe_username, targetProfile, req.body.router_id);
        } catch (mErr) {
          console.error('Mikrotik sync error (create):', mErr);
        }
      }
    }
    if (connectionType === 'hotspot' && req.body.hotspot_username) {
      const disabled = String(req.body.status || 'active').toLowerCase() !== 'active';
      try {
        await mikrotikService.upsertHotspotUser({
          username: String(req.body.hotspot_username || '').trim(),
          password: String(req.body.hotspot_password || '').trim(),
          profile: String(req.body.hotspot_profile || '').trim(),
          macAddress: String(req.body.mac_address || '').trim(),
          disabled
        }, req.body.router_id ? Number(req.body.router_id) : null);
      } catch (mErr) {
        console.error('Mikrotik sync error (create hotspot):', mErr);
      }
    }

    req.session._msg = { type: 'success', text: `Pelanggan "${req.body.name}" berhasil ditambahkan.` };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal menambahkan pelanggan: ' + e.message };
  }
  res.redirect('/admin/customers');
});

router.post('/customers/:id/update', requireAdminSession, express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const customerId = Number(req.params.id);
    const connectionType = String(req.body.connection_type || 'pppoe').trim().toLowerCase() || 'pppoe';
    req.body.connection_type = connectionType;

    if (connectionType !== 'pppoe') req.body.pppoe_username = '';
    if (connectionType !== 'static') req.body.static_ip = '';
    if (connectionType !== 'hotspot') {
      req.body.hotspot_username = '';
      req.body.hotspot_password = '';
      req.body.hotspot_profile = '';
    }

    if (connectionType === 'pppoe') {
      const routerId = req.body.router_id ? Number(req.body.router_id) : null;
      const username = String(req.body.pppoe_username || '').trim();
      req.body.pppoe_username = username;
      if (!username) throw new Error('PPPoE Username tidak boleh kosong');
      const existing = db.prepare('SELECT id, name FROM customers WHERE router_id IS ? AND pppoe_username = ? AND id != ? LIMIT 1').get(routerId, username, customerId);
      if (existing) throw new Error(`PPPoE Username sudah dipakai pelanggan lain: ${existing.name}`);

      let conn = null;
      try {
        conn = await mikrotikService.getConnection(routerId);
        const results = await conn.client.menu('/ppp/secret')
          .where('service', 'pppoe')
          .where('name', username)
          .get();
        if (!Array.isArray(results) || results.length === 0) throw new Error('PPPoE Username tidak ditemukan di MikroTik');
      } finally {
        if (conn && conn.api) conn.api.close();
      }
    }

    if (connectionType === 'hotspot') {
      const routerId = req.body.router_id ? Number(req.body.router_id) : null;
      const username = String(req.body.hotspot_username || '').trim();
      req.body.hotspot_username = username;
      if (!username) throw new Error('Hotspot Username tidak boleh kosong');
      const existing = db.prepare('SELECT id, name FROM customers WHERE router_id IS ? AND hotspot_username = ? AND id != ? LIMIT 1').get(routerId, username, customerId);
      if (existing) throw new Error(`Hotspot Username sudah dipakai pelanggan lain: ${existing.name}`);

      const password = String(req.body.hotspot_password || '').trim() || username;
      req.body.hotspot_password = password;

      let profile = String(req.body.hotspot_profile || '').trim();
      if (!profile && req.body.package_id) {
        const pkg = customerSvc.getPackageById(req.body.package_id);
        if (pkg) profile = String(pkg.name || '').trim();
      }
      req.body.hotspot_profile = profile;
      if (!profile) throw new Error('Hotspot User Profile tidak boleh kosong');

      const profs = await mikrotikService.getHotspotUserProfiles(routerId);
      const ok = Array.isArray(profs) && profs.some(p => String(p?.name || '').trim() === profile);
      if (!ok) throw new Error(`Hotspot User Profile "${profile}" tidak ditemukan di MikroTik`);
    }

    customerSvc.updateCustomer(req.params.id, req.body);
    
    // Sync to MikroTik if username provided
    if (connectionType === 'pppoe' && req.body.pppoe_username) {
      let targetProfile = '';
      if (req.body.status === 'suspended') {
        targetProfile = req.body.isolir_profile || 'isolir';
      } else if (req.body.package_id) {
        const pkg = customerSvc.getPackageById(req.body.package_id);
        if (pkg) targetProfile = pkg.name;
      }
      if (targetProfile) {
        try {
          await mikrotikService.setPppoeProfile(req.body.pppoe_username, targetProfile, req.body.router_id);
        } catch (mErr) {
          console.error('Mikrotik sync error (update):', mErr);
        }
      }
    }
    if (connectionType === 'hotspot' && req.body.hotspot_username) {
      const disabled = String(req.body.status || 'active').toLowerCase() !== 'active';
      try {
        await mikrotikService.upsertHotspotUser({
          username: String(req.body.hotspot_username || '').trim(),
          password: String(req.body.hotspot_password || '').trim(),
          profile: String(req.body.hotspot_profile || '').trim(),
          macAddress: String(req.body.mac_address || '').trim(),
          disabled
        }, req.body.router_id ? Number(req.body.router_id) : null);
      } catch (mErr) {
        console.error('Mikrotik sync error (update hotspot):', mErr);
      }
    }

    req.session._msg = { type: 'success', text: 'Data pelanggan berhasil diperbarui.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal memperbarui: ' + e.message };
  }
  res.redirect('/admin/customers');
});

router.post('/customers/:id/delete', requireAdminSession, async (req, res) => {
  try {
    await customerSvc.deleteCustomer(req.params.id);
    req.session._msg = { type: 'success', text: 'Pelanggan berhasil dihapus.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal: ' + e.message };
  }
  res.redirect('/admin/customers');
});

// ─── EXPORT/IMPORT CUSTOMERS ──────────────────────────────────────
router.get('/customers/export', requireAdminSession, (req, res) => {
  try {
    const customers = customerSvc.getAllCustomers();
    const data = customers.map(c => ({
      'ID': c.id,
      'Nama': c.name,
      'Telepon': c.phone,
      'Email': c.email || '',
      'Alamat': c.address,
      'Paket': c.package_name || '-',
      'Tag ONU': c.genieacs_tag,
      'PPPoE Username': c.pppoe_username,
      'Isolir Profile': c.isolir_profile,
      'Status': c.status,
      'Tanggal Pasang': c.install_date,
      'Auto Isolir': c.auto_isolate === 1 ? 'YA' : 'TIDAK',
      'Tgl Isolir': c.isolate_day,
      'ODP': c.odp_name || '-',
      'Latitude': c.lat || '',
      'Longitude': c.lng || '',
      'Catatan': c.notes
    }));

    const ws = XLSX.utils.json_to_sheet(data);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Pelanggan');
    
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Disposition', 'attachment; filename=daftar_pelanggan.xlsx');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
  } catch (e) {
    logger.error('Export error:', e);
    res.status(500).send('Gagal export data.');
  }
});

router.post('/customers/import', requireAdminSession, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) throw new Error('File tidak ditemukan');
    const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws);
    logger.info(`[Import] Found ${rows.length} rows in Excel file.`);
    
    const packages = customerSvc.getAllPackages();
    const odps = odpSvc.getAllOdps();
    let count = 0;

    for (let row of rows) {
      // Normalize row keys (trim whitespace)
      const cleanRow = {};
      Object.keys(row).forEach(key => {
        cleanRow[key.trim()] = row[key];
      });

      const name = cleanRow['Nama'] || cleanRow['name'] || cleanRow['Name'];
      if (!name) {
        logger.debug('[Import] Skipping row - Name is empty.');
        continue; 
      }

      const pkgName = cleanRow['Paket'] || cleanRow['package'] || cleanRow['Package'];
      const pkg = packages.find(p => p.name === pkgName);

      const odpName = cleanRow['ODP'] || cleanRow['odp'] || cleanRow['ODP Name'];
      const odp = odps.find(o => o.name === odpName);
      
      const data = {
        name: name,
        phone: cleanRow['Telepon'] || cleanRow['phone'] || cleanRow['Phone'],
        email: cleanRow['Email'] || cleanRow['email'] || cleanRow['email_address'],
        address: cleanRow['Alamat'] || cleanRow['address'] || cleanRow['Address'],
        package_id: pkg ? pkg.id : null,
        odp_id: odp ? odp.id : null,
        lat: cleanRow['Latitude'] || cleanRow['latitude'] || cleanRow['Lat'] || '',
        lng: cleanRow['Longitude'] || cleanRow['longitude'] || cleanRow['Lng'] || '',
        genieacs_tag: cleanRow['Tag ONU'] || cleanRow['genieacs_tag'],
        pppoe_username: cleanRow['PPPoE Username'] || cleanRow['pppoe_username'],
        isolir_profile: cleanRow['Isolir Profile'] || cleanRow['isolir_profile'] || 'isolir',
        status: (cleanRow['Status'] || cleanRow['status'] || 'active').toLowerCase(),
        install_date: cleanRow['Tanggal Pasang'] || cleanRow['install_date'],
        auto_isolate: (cleanRow['Auto Isolir'] === 'TIDAK' || cleanRow['auto_isolate'] === 0) ? 0 : 1,
        isolate_day: parseInt(cleanRow['Tgl Isolir'] || cleanRow['isolate_day']) || 10,
        notes: cleanRow['Catatan'] || cleanRow['notes']
      };
      
      const id = cleanRow['ID'] || cleanRow['id'];
      if (id && !isNaN(id) && id !== '') {
        logger.info(`[Import] Updating customer ID: ${id}`);
        customerSvc.updateCustomer(id, data);
      } else {
        logger.info(`[Import] Creating new customer: ${name}`);
        customerSvc.createCustomer(data);
      }
      count++;
    }
    
    logger.info(`[Import] Finished. Total processed: ${count}`);
    req.session._msg = { type: 'success', text: `Berhasil mengimpor ${count} data pelanggan.` };
  } catch (e) {
    logger.error('Import error:', e);
    req.session._msg = { type: 'error', text: 'Gagal impor: ' + e.message };
  }
  res.redirect('/admin/customers');
});

router.post('/customers/:id/isolate', requireAdminSession, async (req, res) => {
  try {
    await customerSvc.suspendCustomer(req.params.id);
    const customer = customerSvc.getCustomerById(req.params.id);
    req.session._msg = { type: 'success', text: `Pelanggan "${customer.name}" berhasil di-isolir manual.` };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal isolir: ' + e.message };
  }
  res.redirect('back');
});

router.post('/customers/:id/unisolate', requireAdminSession, async (req, res) => {
  try {
    await customerSvc.activateCustomer(req.params.id);
    const customer = customerSvc.getCustomerById(req.params.id);
    req.session._msg = { type: 'success', text: `Layanan pelanggan "${customer.name}" berhasil diaktifkan kembali.` };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal aktivasi: ' + e.message };
  }
  res.redirect('back');
});

router.post('/customers/:id/billing/generate', requireAdminSession, express.urlencoded({ extended: true }), (req, res) => {
  try {
    const { month, year } = req.body;
    const result = billingSvc.generateInvoiceForCustomer(req.params.id, parseInt(month), parseInt(year));
    if (result.created) {
      req.session._msg = { type: 'success', text: `Tagihan berhasil dibuat untuk "${result.customerName}" periode ${month}/${year}.` };
    } else {
      req.session._msg = { type: 'success', text: `Tagihan sudah ada untuk "${result.customerName}" periode ${month}/${year}.` };
    }
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal generate tagihan: ' + e.message };
  }
  res.redirect('back');
});

router.post('/customers/:id/billing/reset-promo-cycles', requireAdminSession, restrictToAdmin, (req, res) => {
  try {
    const r = customerSvc.resetPromoCyclesUsed(req.params.id);
    if (!r.changes) {
      req.session._msg = { type: 'error', text: 'Pelanggan tidak ditemukan.' };
    } else {
      const c = customerSvc.getCustomerById(req.params.id);
      req.session._msg = { type: 'success', text: `Counter promo untuk "${c ? c.name : req.params.id}" di-reset (siklus promo dihitung ulang dari awal).` };
    }
  } catch (e) {
    req.session._msg = { type: 'error', text: e.message || String(e) };
  }
  res.redirect('back');
});

router.post('/customers/:id/billing/install-prorata', requireAdminSession, restrictToAdmin, (req, res) => {
  try {
    const out = billingSvc.createInstallProrataCatchUpInvoice(req.params.id);
    req.session._msg = {
      type: 'success',
      text: `Tagihan susulan prorata untuk "${out.customerName}" periode ${String(out.periodMonth).padStart(2, '0')}/${out.periodYear} sebesar Rp ${Number(out.amount).toLocaleString('id-ID')} (${out.billableDays}/${out.daysInMonth} hari).`
    };
  } catch (e) {
    req.session._msg = { type: 'error', text: e.message || String(e) };
  }
  res.redirect('back');
});

router.post('/customers/:id/billing/pay', requireAdminSession, express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const { month, months, year, paid_by_name, notes } = req.body;
    const y = parseInt(year);
    const paidBy = resolvePaidByName(req, paid_by_name);
    const customer = customerSvc.getCustomerById(req.params.id);

    if (months != null) {
      const sum = billingSvc.payInvoicesForCustomerMonths(req.params.id, y, months, paidBy, notes);
      const done = sum.paidMonths.length;
      const already = sum.alreadyPaidMonths.length;
      const created = sum.createdMonths.length;
      const total = Number(sum.totalAmount) || 0;
      req.session._msg = { type: 'success', text: `Pembayaran berhasil untuk "${sum.customerName}" tahun ${sum.year}. Total: Rp ${total.toLocaleString('id-ID')} (${sum.totalMonths || 0} bulan). Dibayar: ${done} bulan, dibuat: ${created}, sudah lunas: ${already}.` };

      if (customer && customer.phone && done > 0) {
        const monthsText = (sum.paidMonths || []).join(', ');
        const msg =
          `✅ *PEMBAYARAN BERHASIL*\n\n` +
          `👤 *Pelanggan:* ${customer.name}\n` +
          `📅 *Tahun:* ${sum.year}\n` +
          `🧾 *Bulan Dibayar:* ${monthsText || '-'}\n` +
          `💰 *Total:* Rp ${Number(total || 0).toLocaleString('id-ID')}\n` +
          `🏷️ *Dibayar Via:* ${paidBy}\n\n` +
          `Terima kasih.`;
        await trySendWhatsappPayment(customer.phone, msg);
      }
    } else {
      const m = parseInt(month);
      const result = billingSvc.payInvoiceForCustomerPeriod(req.params.id, m, y, paidBy, notes);
      if (result.alreadyPaid) {
        req.session._msg = { type: 'success', text: `Tagihan periode ${m}/${y} untuk "${result.customerName}" sudah lunas.` };
      } else {
        const verb = result.created ? 'dibuat & dilunasi' : 'dilunasi';
        req.session._msg = { type: 'success', text: `Tagihan periode ${m}/${y} untuk "${result.customerName}" berhasil ${verb}.` };

        if (customer && customer.phone) {
          const invs = billingSvc.getInvoicesByAny(String(req.params.id)) || [];
          const inv = (Array.isArray(invs) ? invs : []).find(i => Number(i?.period_month) === Number(m) && Number(i?.period_year) === Number(y)) || null;
          const amount = inv ? Number(inv.amount || 0) : 0;
          const msg =
            `✅ *PEMBAYARAN BERHASIL*\n\n` +
            `👤 *Pelanggan:* ${customer.name}\n` +
            `📅 *Periode:* ${m}/${y}\n` +
            `${inv ? `🧾 *Invoice:* #${inv.id}\n` : ''}` +
            `💰 *Nominal Tagihan:* Rp ${amount.toLocaleString('id-ID')}\n` +
            `🏷️ *Dibayar Via:* ${paidBy}\n\n` +
            `Terima kasih.`;
          await trySendWhatsappPayment(customer.phone, msg);
        }
      }
    }

    const freshCustomer = customerSvc.getAllCustomers().find(c => String(c.id) === String(req.params.id));
    if (freshCustomer && freshCustomer.status === 'suspended' && freshCustomer.unpaid_count === 0) {
      await customerSvc.activateCustomer(req.params.id);
    }
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal bayar: ' + e.message };
  }
  res.redirect('back');
});

// ─── PACKAGES ──────────────────────────────────────────────────────────────
router.get('/packages', requireAdminSession, (req, res) => {
  res.render('admin/packages', {
    title: 'Paket Internet', company: company(), activePage: 'packages',
    packages: customerSvc.getAllPackages(), msg: flashMsg(req)
  });
});

router.post('/packages', requireAdminSession, express.urlencoded({ extended: true }), (req, res) => {
  try {
    customerSvc.createPackage(req.body);
    req.session._msg = { type: 'success', text: `Paket "${req.body.name}" berhasil ditambahkan.` };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal: ' + e.message };
  }
  res.redirect('/admin/packages');
});

router.post('/packages/:id/update', requireAdminSession, express.urlencoded({ extended: true }), (req, res) => {
  try {
    customerSvc.updatePackage(req.params.id, req.body);
    req.session._msg = { type: 'success', text: 'Paket berhasil diperbarui.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal: ' + e.message };
  }
  res.redirect('/admin/packages');
});

router.post('/packages/:id/delete', requireAdminSession, (req, res) => {
  try {
    customerSvc.deletePackage(req.params.id);
    req.session._msg = { type: 'success', text: 'Paket berhasil dihapus.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal: ' + e.message };
  }
  res.redirect('/admin/packages');
});

// ─── BILLING ───────────────────────────────────────────────────────────────
router.get('/billing', requireAdminSession, (req, res) => {
  const { month: filterMonth, year: filterYear = new Date().getFullYear(), status: filterStatus = 'all', search = '' } = req.query;
  const summary = billingSvc.getInvoiceSummary(filterMonth || new Date().getMonth()+1, filterYear);
  const invoices = billingSvc.getAllInvoices({ month: filterMonth, year: filterYear, status: filterStatus, search });
  res.render('admin/billing', {
    title: 'Tagihan', company: company(), activePage: 'billing',
    invoices, summary, filterMonth, filterYear: parseInt(filterYear), filterStatus, search, msg: flashMsg(req)
  });
});

router.get('/billing/:id/print', requireAdminSession, (req, res) => {
  const inv = billingSvc.getInvoiceById(req.params.id);
  if (!inv) return res.status(404).send('Invoice tidak ditemukan');
  
  const customer = customerSvc.getCustomerById(inv.customer_id);
  if (!customer) return res.status(404).send('Data pelanggan tidak ditemukan');

  const settings = getSettings();
  res.render('admin/print_invoice', {
    invoice: inv,
    customer,
    company: settings.company_header || 'ALIJAYA DIGITAL NETWORK',
    settings
  });
});

router.post('/billing/generate', requireAdminSession, express.urlencoded({ extended: true }), (req, res) => {
  try {
    const { month, year } = req.body;
    const count = billingSvc.generateMonthlyInvoices(parseInt(month), parseInt(year));
    req.session._msg = { type: 'success', text: `${count} tagihan baru berhasil digenerate untuk periode ${month}/${year}.` };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal generate: ' + e.message };
  }
  res.redirect('/admin/billing');
});

router.get('/api/billing/unpaid/:customerId', requireAdmin, (req, res) => {
  try {
    const invoices = billingSvc.getUnpaidInvoicesByCustomerId(req.params.customerId);
    res.json(invoices);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/api/customers/:id/paid-months', requireAdmin, (req, res) => {
  try {
    const year = parseInt(req.query.year || new Date().getFullYear());
    const months = billingSvc.getPaidMonthsForCustomerYear(req.params.id, year);
    res.json({ year, months });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/api/customers/:id/billing-year', requireAdmin, (req, res) => {
  try {
    const year = parseInt(req.query.year || new Date().getFullYear());
    const summary = billingSvc.getCustomerBillingYearSummary(req.params.id, year);
    res.json(summary);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/billing/pay-bulk', requireAdminSession, express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const { invoice_ids, paid_by_name, notes } = req.body;
    const ids = Array.isArray(invoice_ids) ? invoice_ids : [invoice_ids];
    const paidBy = resolvePaidByName(req, paid_by_name);
    
    if (!ids || ids.length === 0) throw new Error('Tidak ada tagihan yang dipilih');

    const paidByCustomer = new Map();
    const touchedCustomerIds = new Set();
    let processed = 0;
    for (const id of ids) {
      const inv = billingSvc.getInvoiceById(id);
      if (inv) {
        processed++;
        const customerId = Number(inv.customer_id || 0);
        if (Number.isFinite(customerId) && customerId > 0) touchedCustomerIds.add(customerId);
        const wasPaid = String(inv.status || '').toLowerCase() === 'paid';
        billingSvc.markAsPaid(id, paidBy, notes);
        if (!wasPaid) {
          if (!paidByCustomer.has(customerId)) paidByCustomer.set(customerId, []);
          paidByCustomer.get(customerId).push({
            id: inv.id,
            amount: Number(inv.amount || 0),
            period_month: inv.period_month,
            period_year: inv.period_year
          });
        }
      }
    }

    const customersSnapshot = customerSvc.getAllCustomers();
    for (const customerId of touchedCustomerIds) {
      const freshCustomer = customersSnapshot.find(c => Number(c.id) === Number(customerId));
      if (freshCustomer && freshCustomer.status === 'suspended' && Number(freshCustomer.unpaid_count || 0) === 0) {
        await customerSvc.activateCustomer(customerId);
      }
    }

    for (const [customerId, paidInvoices] of paidByCustomer.entries()) {
      if (!paidInvoices || paidInvoices.length === 0) continue;
      const customer = customerSvc.getCustomerById(customerId);
      if (customer && customer.phone) {
        const total = paidInvoices.reduce((a, b) => a + Number(b.amount || 0), 0);
        const periods = paidInvoices
          .map(x => `${x.period_month}/${x.period_year}`)
          .slice(0, 10)
          .join(', ') + (paidInvoices.length > 10 ? `, +${paidInvoices.length - 10} lainnya` : '');
        const msg =
          `✅ *PEMBAYARAN BERHASIL*\n\n` +
          `👤 *Pelanggan:* ${customer.name}\n` +
          `🧾 *Tagihan Dibayar:* ${paidInvoices.length} invoice\n` +
          `📅 *Periode:* ${periods}\n` +
          `💰 *Total:* Rp ${Number(total || 0).toLocaleString('id-ID')}\n` +
          `🏷️ *Dibayar Via:* ${paidBy}\n\n` +
          `Terima kasih.`;
        await trySendWhatsappPayment(customer.phone, msg);
      }
    }

    req.session._msg = { type: 'success', text: `${processed} tagihan berhasil diproses.` };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal bayar massal: ' + e.message };
  }
  res.redirect('back');
});

router.post('/billing/delete-bulk', requireAdminSession, express.urlencoded({ extended: true }), (req, res) => {
  try {
    const { invoice_ids } = req.body;
    const ids = Array.isArray(invoice_ids) ? invoice_ids : [invoice_ids];
    const clean = ids
      .map(x => Number(x))
      .filter(n => Number.isFinite(n) && n > 0);
    if (!clean || clean.length === 0) throw new Error('Tidak ada tagihan yang dipilih');

    let deleted = 0;
    for (const id of clean) {
      try {
        billingSvc.deleteInvoice(id);
        deleted++;
      } catch {}
    }

    req.session._msg = { type: 'success', text: `${deleted} tagihan berhasil dihapus.` };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal hapus massal: ' + e.message };
  }
  res.redirect('back');
});

router.post('/billing/:id/pay', requireAdminSession, express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const inv = billingSvc.getInvoiceById(req.params.id);
    if (!inv) throw new Error('Tagihan tidak ditemukan');

    const paidBy = resolvePaidByName(req, req.body.paid_by_name);
    const wasPaid = String(inv.status || '').toLowerCase() === 'paid';
    billingSvc.markAsPaid(req.params.id, paidBy, req.body.notes);
    
    // Check if customer is currently suspended and has no more unpaid invoices
    const customer = customerSvc.getCustomerById(inv.customer_id);
    if (!wasPaid && customer && customer.phone) {
      const msg =
        `✅ *PEMBAYARAN BERHASIL*\n\n` +
        `👤 *Pelanggan:* ${customer.name}\n` +
        `🧾 *Invoice:* #${inv.id}\n` +
        `📅 *Periode:* ${inv.period_month}/${inv.period_year}\n` +
        `💰 *Nominal Tagihan:* Rp ${Number(inv.amount || 0).toLocaleString('id-ID')}\n` +
        `🏷️ *Dibayar Via:* ${paidBy}\n\n` +
        `Terima kasih.`;
      await trySendWhatsappPayment(customer.phone, msg);
    }
    if (customer && customer.status === 'suspended') {
      const freshCustomer = customerSvc.getAllCustomers().find(c => c.id === inv.customer_id);
      if (freshCustomer && freshCustomer.unpaid_count === 0) {
        await customerSvc.activateCustomer(inv.customer_id);
      }
    }

    req.session._msg = { type: 'success', text: 'Tagihan berhasil ditandai lunas.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal: ' + e.message };
  }
  res.redirect('back');
});

router.post('/billing/:id/unpay', requireAdminSession, (req, res) => {
  try {
    billingSvc.markAsUnpaid(req.params.id);
    req.session._msg = { type: 'success', text: 'Status tagihan direset ke Belum Bayar.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal: ' + e.message };
  }
  res.redirect('back');
});

router.post('/billing/:id/qris-assign', requireAdminSession, (req, res) => {
  try {
    const invId = Number(req.params.id);
    if (!Number.isFinite(invId) || invId <= 0) throw new Error('Invoice ID tidak valid');

    const force = String(req.query.force || '') === '1';
    const inv = db.prepare('SELECT id, status, amount, qris_amount_unique FROM invoices WHERE id=?').get(invId);
    if (!inv) throw new Error('Tagihan tidak ditemukan');
    if (String(inv.status) !== 'unpaid') throw new Error('Hanya tagihan BELUM BAYAR yang bisa dibuat kode QRIS.');

    if (!force && inv.qris_amount_unique) {
      req.session._msg = { type: 'success', text: 'Kode QRIS sudah ada untuk tagihan ini.' };
      return res.redirect('back');
    }

    const baseAmount = Number(inv.amount || 0);
    if (!Number.isFinite(baseAmount) || baseAmount <= 0) throw new Error('Nominal tagihan tidak valid');

    const exists = db.prepare('SELECT id FROM invoices WHERE status=? AND qris_amount_unique=? AND id!=? LIMIT 1');
    const update = db.prepare(`
      UPDATE invoices
      SET qris_unique_code=?, qris_amount_unique=?, qris_assigned_at=CURRENT_TIMESTAMP
      WHERE id=?
    `);

    let chosenCode = 0;
    let chosenAmount = 0;

    for (let i = 0; i < 50; i++) {
      const code = 1 + Math.floor(Math.random() * 999);
      const amount = baseAmount + code;
      if (!exists.get('unpaid', amount, invId)) {
        chosenCode = code;
        chosenAmount = amount;
        break;
      }
    }

    if (!chosenAmount) {
      for (let code = 1; code <= 999; code++) {
        const amount = baseAmount + code;
        if (!exists.get('unpaid', amount, invId)) {
          chosenCode = code;
          chosenAmount = amount;
          break;
        }
      }
    }

    if (!chosenAmount) throw new Error('Gagal membuat nominal unik (slot 1-999 penuh).');

    update.run(chosenCode, chosenAmount, invId);
    req.session._msg = { type: 'success', text: `Kode QRIS dibuat: Rp ${Number(chosenAmount).toLocaleString('id-ID')} (kode ${chosenCode}).` };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal membuat kode QRIS: ' + e.message };
  }
  res.redirect('back');
});

router.post('/billing/:id/qris-clear', requireAdminSession, (req, res) => {
  try {
    const invId = Number(req.params.id);
    if (!Number.isFinite(invId) || invId <= 0) throw new Error('Invoice ID tidak valid');
    db.prepare(`
      UPDATE invoices
      SET qris_unique_code=NULL, qris_amount_unique=NULL, qris_assigned_at=NULL
      WHERE id=?
    `).run(invId);
    req.session._msg = { type: 'success', text: 'Kode QRIS dihapus dari tagihan.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal menghapus kode QRIS: ' + e.message };
  }
  res.redirect('back');
});

router.post('/billing/:id/whatsapp', requireAdminSession, async (req, res) => {
  try {
    const inv = billingSvc.getInvoiceById(req.params.id);
    if (!inv) throw new Error('Tagihan tidak ditemukan');
    
    const customer = customerSvc.getCustomerById(inv.customer_id);
    if (!customer || !customer.phone) throw new Error('Nomor WhatsApp pelanggan tidak ditemukan');

    const { sendWA, whatsappStatus } = await import('../services/whatsappBot.mjs');
    
    if (whatsappStatus.connection !== 'open') {
      throw new Error('Bot WhatsApp belum terhubung. Silakan cek status WhatsApp di menu Admin.');
    }

    const qrisAmountUnique = Number(inv.qris_amount_unique || 0) || 0;
    const qrisCode = Number(inv.qris_unique_code || 0) || 0;
    const qrisQrUrl = String(getSetting('qris_static_qr_url', '') || '').trim();

    // Hitung Tagihan
    const unpaidInvoices = billingSvc.getUnpaidInvoicesByCustomerId(customer.id);
    const totalTagihan = unpaidInvoices.reduce((sum, i) => sum + i.amount, 0);
    const rincianBulan = unpaidInvoices.map(i => `${i.period_month}/${i.period_year}`).join(', ');
    
    // Generate Link Login
    const protocol = req.protocol;
    const host = req.get('host');
    const loginLink = `${protocol}://${host}/customer/login`;

    const templateQris = `Yth. *{{nama}}*,\n\nTagihan internet Anda untuk periode *{{periode}}*.\n\n📦 *Paket:* {{paket}}\n💳 *Pembayaran QRIS (Semua E-Wallet)*\n💰 *Nominal (WAJIB tepat):* Rp {{qris_nominal}}\n🏷️ *Kode:* {{qris_kode}}\n{{qris_qr}}\n\nCatatan: nominal harus sama persis agar sistem dapat mendeteksi pembayaran.\n\nTerima kasih.\nSalam,\nAdmin ${getSetting('company_header', 'ISP')}`;

    // Pesan Template (Sama dengan Broadcast Unpaid)
    const template = `Yth. *{{nama}}*,\n\nBerdasarkan data sistem kami, Anda memiliki tagihan internet yang *BELUM LUNAS*.\n\n📦 *Paket:* {{paket}}\n💰 *Total Tagihan:* Rp {{tagihan}}\n📅 *Periode:* {{rincian}}\n\nMohon segera melakukan pembayaran melalui portal pelanggan: {{link}}\n\nTerima kasih atas kerja samanya.\nSalam,\nAdmin ${getSetting('company_header', 'ISP')}`;

    const formattedMsg = (qrisAmountUnique > 0 && qrisCode > 0)
      ? templateQris
          .replace(/{{nama}}/gi, customer.name || 'Pelanggan')
          .replace(/{{periode}}/gi, `${inv.period_month}/${inv.period_year}`)
          .replace(/{{paket}}/gi, inv.package_name || '-')
          .replace(/{{qris_nominal}}/gi, Number(qrisAmountUnique).toLocaleString('id-ID'))
          .replace(/{{qris_kode}}/gi, String(qrisCode).padStart(3, '0'))
          .replace(/{{qris_qr}}/gi, qrisQrUrl ? `🔗 QRIS: ${qrisQrUrl}` : '')
      : template
          .replace(/{{nama}}/gi, customer.name || 'Pelanggan')
          .replace(/{{tagihan}}/gi, totalTagihan.toLocaleString('id-ID'))
          .replace(/{{rincian}}/gi, rincianBulan || '-')
          .replace(/{{paket}}/gi, inv.package_name || '-')
          .replace(/{{link}}/gi, loginLink);

    const sent = await sendWA(customer.phone, formattedMsg);
    if (!sent) throw new Error('Gagal mengirim pesan melalui WhatsApp Bot.');

    req.session._msg = { type: 'success', text: `Tagihan WhatsApp berhasil dikirim ke ${customer.name}.` };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal kirim WA: ' + e.message };
  }
  res.redirect('back');
});

router.post('/billing/:id/delete', requireAdminSession, (req, res) => {
  try {
    billingSvc.deleteInvoice(req.params.id);
    req.session._msg = { type: 'success', text: 'Tagihan berhasil dihapus.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal: ' + e.message };
  }
  res.redirect('back');
});

// ─── TICKETS ───────────────────────────────────────────────────────────────
const ticketSvc = require('../services/ticketService');

router.get('/tickets', requireAdminSession, (req, res) => {
  const { status = 'all' } = req.query;
  const tickets = ticketSvc.getAllTickets(status);
  const stats = ticketSvc.getTicketStats();
  res.render('admin/tickets', {
    title: 'Keluhan Pelanggan', company: company(), activePage: 'tickets',
    tickets, stats, filterStatus: status, msg: flashMsg(req)
  });
});

router.post('/tickets/:id/update', requireAdminSession, express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const { status } = req.body;
    const ticketId = req.params.id;
    
    ticketSvc.updateTicketStatus(ticketId, status);
    req.session._msg = { type: 'success', text: 'Status keluhan berhasil diperbarui.' };

    // --- WHATSAPP NOTIFICATION FOR RESOLVED TICKET (BY ADMIN) ---
    if (status === 'resolved') {
      try {
        const settings = getSettings();
        if (settings.whatsapp_enabled) {
          const { sendWA } = await import('../services/whatsappBot.mjs');
          const ticket = ticketSvc.getTicketById(ticketId);
          
          if (ticket) {
            const waMsg = `✅ *TIKET KELUHAN SELESAI*\n\n` +
                         `🎫 *ID Tiket:* #${ticket.id}\n` +
                         `👤 *Pelanggan:* ${ticket.customer_name}\n` +
                         `📝 *Subjek:* ${ticket.subject}\n` +
                         `🛠️ *Petugas:* Admin\n\n` +
                         `Keluhan Anda telah selesai dikerjakan. Terima kasih atas kesabarannya.`;

            // Kirim ke Pelanggan
            if (ticket.customer_phone) {
              await sendWA(ticket.customer_phone, waMsg);
            }

            // Kirim ke Admin Numbers
            if (settings.whatsapp_admin_numbers && settings.whatsapp_admin_numbers.length > 0) {
              const adminMsg = `✅ *LAPORAN TIKET SELESAI (OLEH ADMIN)*\n\n` +
                               `🎫 *ID Tiket:* #${ticket.id}\n` +
                               `👤 *Pelanggan:* ${ticket.customer_name}\n` +
                               `📝 *Subjek:* ${ticket.subject}\n` +
                               `💬 *Pesan:* ${ticket.message}`;
              const seen = new Set();
              for (const adminPhone of settings.whatsapp_admin_numbers) {
                let digits = String(adminPhone || '').replace(/\D/g, '');
                if (!digits) continue;
                if (digits.startsWith('0')) digits = '62' + digits.slice(1);
                if (seen.has(digits)) continue;
                seen.add(digits);
                await sendWA(digits, adminMsg);
              }
            }
          }
        }
      } catch (waErr) {
        console.error(`[AdminPortal] WA Notification Error: ${waErr.message}`);
      }
    }
    // -------------------------------------------------------------

  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal update keluhan: ' + e.message };
  }
  res.redirect('back');
});

router.post('/tickets/:id/delete', requireAdminSession, (req, res) => {
  try {
    ticketSvc.deleteTicket(req.params.id);
    req.session._msg = { type: 'success', text: 'Keluhan berhasil dihapus.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal hapus keluhan: ' + e.message };
  }
  res.redirect('back');
});

// ─── REPORTS ───────────────────────────────────────────────────────────────
router.get('/reports', requireAdminSession, (req, res) => {
  const filterYear = parseInt(req.query.year) || new Date().getFullYear();
  const now = new Date();
  const monthlyData = billingSvc.getMonthlyRevenue(filterYear);
  const recentPayments = billingSvc.getRecentPayments(10);
  const topUnpaid = billingSvc.getTopUnpaid(5);
  const activeCustomers = customerSvc.getCustomerStats().active;

  const yStr = String(filterYear);
  const revenueYearAllRow = db.prepare(
    "SELECT SUM(amount) as t FROM invoices WHERE status='paid' AND strftime('%Y', paid_at) = ?"
  ).get(yStr);
  const revenueYearAll = Number(revenueYearAllRow?.t || 0);

  const revenueYearDirectRow = db.prepare(
    "SELECT SUM(amount) as t FROM invoices WHERE status='paid' AND strftime('%Y', paid_at) = ? AND (paid_by_name IS NULL OR paid_by_name NOT LIKE 'Agent %')"
  ).get(yStr);
  const revenueYearDirect = Number(revenueYearDirectRow?.t || 0);
  const revenueYearAgent = Math.max(0, revenueYearAll - revenueYearDirect);

  const agentDepositYearRow = db.prepare(
    "SELECT SUM(amount_buy) as t FROM agent_transactions WHERE type='topup' AND strftime('%Y', created_at) = ?"
  ).get(yStr);
  const agentDepositYear = Number(agentDepositYearRow?.t || 0);

  const nowYearStr = String(now.getFullYear());
  const nowMonthStr = String(now.getMonth() + 1).padStart(2, '0');
  const revenueThisMonthAllRow = db.prepare(
    "SELECT SUM(amount) as t FROM invoices WHERE status='paid' AND strftime('%Y', paid_at) = ? AND strftime('%m', paid_at) = ?"
  ).get(nowYearStr, nowMonthStr);
  const revenueThisMonthAll = Number(revenueThisMonthAllRow?.t || 0);

  const revenueThisMonthDirectRow = db.prepare(
    "SELECT SUM(amount) as t FROM invoices WHERE status='paid' AND strftime('%Y', paid_at) = ? AND strftime('%m', paid_at) = ? AND (paid_by_name IS NULL OR paid_by_name NOT LIKE 'Agent %')"
  ).get(nowYearStr, nowMonthStr);
  const revenueThisMonthDirect = Number(revenueThisMonthDirectRow?.t || 0);
  const revenueThisMonthAgent = Math.max(0, revenueThisMonthAll - revenueThisMonthDirect);

  const agentDepositMonthRow = db.prepare(
    "SELECT SUM(amount_buy) as t FROM agent_transactions WHERE type='topup' AND strftime('%Y', created_at) = ? AND strftime('%m', created_at) = ?"
  ).get(nowYearStr, nowMonthStr);
  const agentDepositThisMonth = Number(agentDepositMonthRow?.t || 0);

  const cashInYear = revenueYearDirect + agentDepositYear;
  const cashInThisMonth = revenueThisMonthDirect + agentDepositThisMonth;
  const pendingAmountRow = db.prepare("SELECT SUM(amount) as t FROM invoices WHERE status='unpaid'").get();
  const pendingAmount = Number(pendingAmountRow?.t || 0);

  res.render('admin/reports', {
    title: 'Laporan Keuangan', company: company(), activePage: 'reports',
    filterYear, monthlyData, chartData: monthlyData, recentPayments, topUnpaid,
    totalRevenue: revenueYearAll,
    thisMonth: revenueThisMonthAll,
    pendingAmount,
    activeCustomers,
    revenueYearAgent,
    revenueThisMonthAgent,
    agentDepositYear,
    agentDepositThisMonth,
    cashInYear,
    cashInThisMonth
  });
});

// ─── SETTINGS ──────────────────────────────────────────────────────────────
router.get('/settings', requireAdminSession, (req, res) => {
  const settings = getSettings();
  const protocol = req.headers['x-forwarded-proto'] || req.protocol;
  const host = req.get('host');
  const baseUrl = (settings && settings.app_url ? String(settings.app_url) : `${protocol}://${host}`).replace(/\/+$/, '');
  const digiflazzWebhookUrl = `${baseUrl}/webhook/digiflazz`;
  const paymentWebhookUrl = `${baseUrl}/customer/payment/callback`;
  res.render('admin/settings', {
    title: 'Pengaturan Sistem', company: company(), activePage: 'settings',
    settings, msg: flashMsg(req),
    digiflazzWebhookUrl,
    paymentWebhookUrl
  });
});

router.get('/digiflazz', requireAdminSession, restrictToAdmin, async (req, res) => {
  const settings = getSettings();
  const protocol = req.headers['x-forwarded-proto'] || req.protocol;
  const host = req.get('host');
  const baseUrl = (settings && settings.app_url ? String(settings.app_url) : `${protocol}://${host}`).replace(/\/+$/, '');
  const digiflazzWebhookUrl = `${baseUrl}/webhook/digiflazz`;
  let digi = { configured: digiflazzConfigured(), deposit: null, error: null };
  if (digi.configured) {
    try {
      const data = await digiflazzCekSaldo();
      digi.deposit = Number(data?.deposit || 0);
    } catch (e) {
      digi.error = String(e?.message || e || '');
    }
  }

  const q = String(req.query.q || '').trim();
  const category = String(req.query.category || '').trim();
  const status = String(req.query.status || '').trim();

  const where = [];
  const params = [];
  if (q) {
    where.push('(sku LIKE ? OR product_name LIKE ? OR brand LIKE ? OR category LIKE ?)');
    const like = `%${q}%`;
    params.push(like, like, like, like);
  }
  if (category) {
    where.push('category = ?');
    params.push(category);
  }
  if (status === 'active') where.push('status = 1');
  if (status === 'inactive') where.push('status = 0');

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const products = db.prepare(`SELECT * FROM digiflazz_products ${whereSql} ORDER BY category, brand, price_sell LIMIT 300`).all(...params);
  const categories = db.prepare("SELECT category FROM digiflazz_products WHERE category IS NOT NULL AND TRIM(category)<>'' GROUP BY category ORDER BY category").all().map(r => r.category);
  const stats = db.prepare('SELECT COUNT(1) AS total, SUM(CASE WHEN status=1 THEN 1 ELSE 0 END) AS active, SUM(CASE WHEN status=0 THEN 1 ELSE 0 END) AS inactive FROM digiflazz_products').get();
  const lastSync = db.prepare('SELECT * FROM digiflazz_sync_logs ORDER BY id DESC LIMIT 1').get();
  const webhookLogs = db.prepare(
    `
    SELECT id, created_at, ref_id, status, signature_ok, matched_agent_tx_id, ip
    FROM digiflazz_webhook_logs
    ORDER BY id DESC
    LIMIT 80
  `
  ).all();

  const recentPulsaTx = db.prepare(
    `
    SELECT t.*, a.name AS agent_name, a.username AS agent_username
    FROM agent_transactions t
    JOIN agents a ON a.id = t.agent_id
    WHERE t.type = 'pulsa'
    ORDER BY t.id DESC
    LIMIT 60
  `
  ).all();

  res.render('admin/digiflazz', {
    title: 'Digiflazz',
    company: company(),
    activePage: 'digiflazz',
    msg: flashMsg(req),
    settings,
    digi,
    digiflazzWebhookUrl,
    q,
    category,
    status,
    products,
    categories,
    stats,
    lastSync,
    recentPulsaTx,
    webhookLogs
  });
});

router.post('/digiflazz/check-balance', requireAdminSession, restrictToAdmin, async (req, res) => {
  try {
    const data = await digiflazzCekSaldo();
    const depo = Number(data?.deposit || 0);
    req.session._msg = { type: 'success', text: `Saldo Digiflazz: Rp ${depo.toLocaleString('id-ID')}` };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal cek saldo Digiflazz: ' + (e?.message || e) };
  }
  res.redirect('/admin/digiflazz');
});

router.post('/digiflazz/sync-products', requireAdminSession, restrictToAdmin, async (req, res) => {
  try {
    const markup = Math.max(0, Math.floor(Number(getSetting('digiflazz_markup', 0) || 0)));
    const list = await digiflazzPriceListAll();

    const selectOne = db.prepare('SELECT sku, product_name, category, brand, price_modal, price_sell, status FROM digiflazz_products WHERE sku = ?');
    const upsert = db.prepare(
      `
      INSERT INTO digiflazz_products (sku, product_name, category, brand, price_modal, price_sell, status, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(sku) DO UPDATE SET
        product_name=excluded.product_name,
        category=excluded.category,
        brand=excluded.brand,
        price_modal=excluded.price_modal,
        price_sell=excluded.price_sell,
        status=excluded.status,
        updated_at=CURRENT_TIMESTAMP
    `
    );

    const run = db.transaction(() => {
      const summary = { total: 0, inserted: 0, updated: 0, active: 0, inactive: 0, skippedNoPrice: 0 };
      for (const p of list) {
        summary.total++;
        const sku = String(p?.buyer_sku_code || '').trim();
        if (!sku) continue;

        const priceModal = Number(p?.price ?? p?.buyer_price ?? 0) || 0;
        if (priceModal <= 0) {
          summary.skippedNoPrice++;
          continue;
        }

        const status = p?.buyer_product_status ? 1 : 0;
        if (status === 1) summary.active++;
        else summary.inactive++;

        const existing = selectOne.get(sku);
        const name = String(p?.product_name || sku).trim();
        const cat = String(p?.category || '').trim();
        const brand = String(p?.brand || '').trim();
        const priceSell = Math.floor(priceModal + markup);

        if (!existing) summary.inserted++;
        else {
          const changed =
            String(existing.product_name || '') !== name ||
            String(existing.category || '') !== cat ||
            String(existing.brand || '') !== brand ||
            Number(existing.price_modal || 0) !== Math.floor(priceModal) ||
            Number(existing.price_sell || 0) !== priceSell ||
            Number(existing.status || 0) !== status;
          if (changed) summary.updated++;
        }

        upsert.run(sku, name, cat, brand, Math.floor(priceModal), priceSell, status);
      }

      db.prepare(
        'INSERT INTO digiflazz_sync_logs (total, inserted, updated, active, inactive) VALUES (?, ?, ?, ?, ?)'
      ).run(summary.total, summary.inserted, summary.updated, summary.active, summary.inactive);

      return summary;
    });

    const s = run();
    req.session._msg = { type: 'success', text: `Sync Digiflazz OK | Total: ${s.total} | Baru: ${s.inserted} | Update: ${s.updated} | Aktif: ${s.active} | Nonaktif: ${s.inactive} | SkipNoPrice: ${s.skippedNoPrice}` };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal sync produk Digiflazz: ' + (e?.message || e) };
  }
  res.redirect('/admin/digiflazz');
});

router.post('/digiflazz/products/update-price', requireAdminSession, restrictToAdmin, express.urlencoded({ extended: true }), (req, res) => {
  try {
    const sku = String(req.body.sku || '').trim();
    const priceSell = Math.max(0, Math.floor(Number(req.body.price_sell || 0) || 0));
    if (!sku) throw new Error('SKU wajib');
    const info = db.prepare('UPDATE digiflazz_products SET price_sell=?, updated_at=CURRENT_TIMESTAMP WHERE sku=?').run(priceSell, sku);
    if (info.changes === 0) throw new Error('SKU tidak ditemukan');
    req.session._msg = { type: 'success', text: `Harga jual diperbarui: ${sku}` };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal update harga: ' + (e?.message || e) };
  }
  res.redirect('/admin/digiflazz');
});

router.get('/update', requireAdminSession, restrictToAdmin, (req, res) => {
  const repoRoot = path.resolve(__dirname, '..');
  const info = getUpdateInfo(repoRoot);
  res.render('admin/update', {
    title: 'Update Aplikasi',
    company: company(),
    activePage: 'update',
    msg: flashMsg(req),
    info,
    log: popUpdateLog(req)
  });
});

router.post('/update/run', requireAdminSession, restrictToAdmin, (req, res) => {
  const repoRoot = path.resolve(__dirname, '..');
  const log = [];
  const pushCmd = (label, r) => {
    log.push(`$ ${label}`.trim());
    if (r.stdout) log.push(String(r.stdout).trimEnd());
    if (r.stderr) log.push(String(r.stderr).trimEnd());
  };

  const versionPath = path.join(repoRoot, 'version.txt');
  const localBefore = readTextFileSafe(versionPath) || '-';
  const branch = getGitDefaultBranch(repoRoot);
  const backupRoot = path.join(os.tmpdir(), `billing-update-backup-${Date.now()}`);
  const backupSettings = path.join(backupRoot, 'settings.json');
  const backupDb = path.join(backupRoot, 'database');
  const settingsPath = path.join(repoRoot, 'settings.json');
  const dbDir = path.join(repoRoot, 'database');

  try {
    const inside = runCmd('git', ['rev-parse', '--is-inside-work-tree'], repoRoot);
    pushCmd('git rev-parse --is-inside-work-tree', inside);
    if (!inside.ok) throw new Error('Folder ini belum menjadi git repository.');

    const fetch = runCmd('git', ['fetch', '--prune'], repoRoot);
    pushCmd('git fetch --prune', fetch);
    if (!fetch.ok) throw new Error('Gagal git fetch.');

    const remote = runCmd('git', ['show', `origin/${branch}:version.txt`], repoRoot);
    pushCmd(`git show origin/${branch}:version.txt`, remote);
    if (!remote.ok) throw new Error('Tidak bisa membaca version.txt dari GitHub.');
    const remoteVersion = String(remote.stdout || '').trim() || '-';

    if (remoteVersion !== '-' && remoteVersion === localBefore) {
      req.session._msg = { type: 'success', text: 'Versi sudah terbaru: ' + localBefore };
      req.session._updateLog = log.join('\n');
      return res.redirect('/admin/update');
    }

    fs.mkdirSync(backupRoot, { recursive: true });
    if (fs.existsSync(settingsPath)) fs.copyFileSync(settingsPath, backupSettings);
    if (fs.existsSync(dbDir)) copyDirSync(dbDir, backupDb);

    const resetSettings = runCmd('git', ['checkout', '--', 'settings.json'], repoRoot);
    pushCmd('git checkout -- settings.json', resetSettings);
    const resetDb = runCmd('git', ['checkout', '--', 'database'], repoRoot);
    pushCmd('git checkout -- database', resetDb);

    const resetHard = runCmd('git', ['reset', '--hard', `origin/${branch}`], repoRoot);
    pushCmd(`git reset --hard origin/${branch}`, resetHard);
    if (!resetHard.ok) throw new Error('Gagal reset ke origin/' + branch);

    if (remoteVersion && remoteVersion !== '-') {
      try {
        fs.writeFileSync(versionPath, remoteVersion + os.EOL, 'utf8');
        log.push(`$ write version.txt = ${remoteVersion}`);
      } catch (e) {
        log.push(`$ write version.txt failed: ${String(e?.message || e)}`);
      }
    }

    const authFolder = String(getSetting('whatsapp_auth_folder', 'auth_info_baileys') || 'auth_info_baileys');
    const clean = runCmd(
      'git',
      [
        'clean',
        '-fd',
        '-e', 'settings.json',
        '-e', 'database',
        '-e', 'node_modules',
        '-e', 'package-lock.json',
        '-e', authFolder,
        '-e', 'data'
      ],
      repoRoot
    );
    pushCmd(`git clean -fd -e settings.json -e database -e node_modules -e package-lock.json -e ${authFolder} -e data`, clean);

    if (fs.existsSync(backupSettings)) fs.copyFileSync(backupSettings, settingsPath);
    if (fs.existsSync(backupDb)) {
      fs.mkdirSync(dbDir, { recursive: true });
      copyDirSync(backupDb, dbDir);
    }

    const npm = runCmd('npm', ['install'], repoRoot);
    pushCmd('npm install', npm);
    if (!npm.ok) throw new Error('Update berhasil, tetapi npm install gagal.');

    const localAfter = readTextFileSafe(versionPath) || '-';
    req.session._msg = { type: 'success', text: `Update selesai. Versi: ${localBefore} → ${localAfter}. Silakan restart aplikasi.` };
    req.session._updateLog = log.join('\n');
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal update: ' + (e?.message || e) };
    req.session._updateLog = log.join('\n');
  } finally {
    try {
      if (fs.existsSync(backupRoot)) fs.rmSync(backupRoot, { recursive: true, force: true });
    } catch (e) {}
  }

  return res.redirect('/admin/update');
});

router.post('/api/telegram/sync', requireAdminSession, async (req, res) => {
  try {
    const { initTelegram } = require('../services/telegramBot');
    initTelegram();
    res.json({ success: true, message: 'Bot Telegram berhasil disinkronkan.' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/settings', requireAdminSession, express.urlencoded({ extended: true }), (req, res) => {
  try {
    const newSettings = { ...req.body };
    if (newSettings.whatsapp_enabled === 'true') newSettings.whatsapp_enabled = true;
    else if (newSettings.whatsapp_enabled === 'false') newSettings.whatsapp_enabled = false;
    
    if (newSettings.tripay_enabled === 'true') newSettings.tripay_enabled = true;
    else if (newSettings.tripay_enabled === 'false') newSettings.tripay_enabled = false;
    
    if (newSettings.midtrans_enabled === 'true') newSettings.midtrans_enabled = true;
    else if (newSettings.midtrans_enabled === 'false') newSettings.midtrans_enabled = false;

    if (newSettings.default_gateway) newSettings.default_gateway = newSettings.default_gateway.toLowerCase();

    if (typeof newSettings.whatsapp_admin_numbers === 'string') {
      newSettings.whatsapp_admin_numbers = newSettings.whatsapp_admin_numbers.split(',').map(n => n.trim()).filter(Boolean);
    }
    if (newSettings.server_port) newSettings.server_port = parseInt(newSettings.server_port);
    if (newSettings.mikrotik_port) newSettings.mikrotik_port = parseInt(newSettings.mikrotik_port);
    if (newSettings.whatsapp_broadcast_delay) newSettings.whatsapp_broadcast_delay = parseInt(newSettings.whatsapp_broadcast_delay);
    if (newSettings.digiflazz_markup !== undefined) newSettings.digiflazz_markup = parseInt(newSettings.digiflazz_markup) || 0;
    
    newSettings.login_otp_enabled = (newSettings.login_otp_enabled === 'true');
    newSettings.telegram_enabled = (newSettings.telegram_enabled === 'true');
    newSettings.auto_backup_enabled = (newSettings.auto_backup_enabled === 'true');

    const success = saveSettings(newSettings);
    if (success) {
      // Re-init services if needed
      if (newSettings.telegram_enabled) {
        require('../services/telegramBot').initTelegram();
      } else {
        require('../services/telegramBot').initTelegram(); // This will stop it if it was running
      }
      req.session._msg = { type: 'success', text: 'Pengaturan berhasil disimpan.' };
    } else {
      req.session._msg = { type: 'error', text: 'Gagal menyimpan pengaturan' };
    }
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal: ' + e.message };
  }
  res.redirect('/admin/settings');
});

// ─── BACKUP & RECOVERY ──────────────────────────────────────────────────────
router.get('/backup', requireAdminSession, (req, res) => {
  const result = backupSvc.listBackups();
  res.render('admin/backup', {
    title: 'Backup & Recovery',
    company: company(),
    activePage: 'backup',
    msg: flashMsg(req),
    backups: result.backups || [],
    total: result.total || 0,
    getSetting
  });
});

router.post('/backup/create', requireAdminSession, express.urlencoded({ extended: true }), (req, res) => {
  try {
    const { type } = req.body;
    let result;

    if (type === 'all') {
      result = backupSvc.backupAll();
    } else if (type === 'database') {
      result = backupSvc.backupDatabase();
    } else if (type === 'settings') {
      result = backupSvc.backupSettings();
    } else {
      req.session._msg = { type: 'error', text: 'Tipe backup tidak valid' };
      return res.redirect('/admin/backup');
    }

    if (result.success) {
      req.session._msg = { type: 'success', text: `Backup berhasil dibuat: ${result.fileName}` };
    } else {
      req.session._msg = { type: 'error', text: `Gagal backup: ${result.error}` };
    }
  } catch (e) {
    req.session._msg = { type: 'error', text: `Gagal: ${e.message}` };
  }
  res.redirect('/admin/backup');
});

router.post('/backup/restore', requireAdminSession, express.urlencoded({ extended: true }), (req, res) => {
  try {
    const { fileName, type } = req.body;
    let result;

    if (type === 'database') {
      result = backupSvc.restoreDatabase(fileName);
    } else if (type === 'settings') {
      result = backupSvc.restoreSettings(fileName);
    } else {
      req.session._msg = { type: 'error', text: 'Tipe restore tidak valid' };
      return res.redirect('/admin/backup');
    }

    if (result.success) {
      req.session._msg = { type: 'success', text: `Restore berhasil: ${fileName}` };
    } else {
      req.session._msg = { type: 'error', text: `Gagal restore: ${result.error}` };
    }
  } catch (e) {
    req.session._msg = { type: 'error', text: `Gagal: ${e.message}` };
  }
  res.redirect('/admin/backup');
});

router.post('/backup/delete', requireAdminSession, express.urlencoded({ extended: true }), (req, res) => {
  try {
    const { fileName } = req.body;
    const fs = require('fs');
    const path = require('path');
    const backupDir = path.join(__dirname, '../backups');
    const backupFilePath = path.join(backupDir, fileName);

    if (!fs.existsSync(backupFilePath)) {
      req.session._msg = { type: 'error', text: 'File backup tidak ditemukan' };
      return res.redirect('/admin/backup');
    }

    fs.unlinkSync(backupFilePath);
    logger.info(`[Backup] Backup deleted: ${fileName}`);
    req.session._msg = { type: 'success', text: `Backup berhasil dihapus: ${fileName}` };
  } catch (e) {
    req.session._msg = { type: 'error', text: `Gagal menghapus: ${e.message}` };
  }
  res.redirect('/admin/backup');
});

router.post('/backup/cleanup', requireAdminSession, express.urlencoded({ extended: true }), (req, res) => {
  try {
    const { retentionDays } = req.body;
    const result = backupSvc.cleanupOldBackups(parseInt(retentionDays) || 30);

    if (result.success) {
      req.session._msg = { type: 'success', text: `Cleanup selesai: ${result.deletedCount} backup lama dihapus` };
    } else {
      req.session._msg = { type: 'error', text: `Gagal cleanup: ${result.error}` };
    }
  } catch (e) {
    req.session._msg = { type: 'error', text: `Gagal: ${e.message}` };
  }
  res.redirect('/admin/backup');
});

// ─── INVENTORY / WAREHOUSE ──────────────────────────────────────────────────
router.get('/inventory', requireAdminSession, (req, res) => {
  const items = inventorySvc.getAllItems(req.query.q);
  const categories = inventorySvc.getAllCategories();
  const logs = inventorySvc.getInventoryLogs(100);

  res.render('admin/inventory', {
    title: 'Manajemen Inventaris',
    company: company(),
    activePage: 'inventory',
    msg: flashMsg(req),
    items,
    categories,
    logs
  });
});

router.post('/inventory/category/add', requireAdminSession, express.urlencoded({ extended: true }), (req, res) => {
  try {
    inventorySvc.createCategory(req.body);
    req.session._msg = { type: 'success', text: 'Kategori berhasil ditambahkan.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal: ' + e.message };
  }
  res.redirect('/admin/inventory');
});

router.post('/inventory/category/delete/:id', requireAdminSession, (req, res) => {
  try {
    inventorySvc.deleteCategory(req.params.id);
    req.session._msg = { type: 'success', text: 'Kategori berhasil dihapus.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal: ' + e.message };
  }
  res.redirect('/admin/inventory');
});

router.post('/inventory/item/add', requireAdminSession, express.urlencoded({ extended: true }), (req, res) => {
  try {
    inventorySvc.createItem(req.body);
    req.session._msg = { type: 'success', text: 'Barang berhasil ditambahkan.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal: ' + e.message };
  }
  res.redirect('/admin/inventory');
});

router.post('/inventory/item/edit/:id', requireAdminSession, express.urlencoded({ extended: true }), (req, res) => {
  try {
    inventorySvc.updateItem(req.params.id, req.body);
    req.session._msg = { type: 'success', text: 'Barang berhasil diperbarui.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal: ' + e.message };
  }
  res.redirect('/admin/inventory');
});

router.post('/inventory/stock/add', requireAdminSession, express.urlencoded({ extended: true }), (req, res) => {
  try {
    inventorySvc.addStock(req.body, req.session.adminUser || 'Admin');
    req.session._msg = { type: 'success', text: 'Stok berhasil ditambahkan.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal: ' + e.message };
  }
  res.redirect('/admin/inventory');
});

router.get('/audit-logs', requireAdminSession, restrictToAdmin, (req, res) => {
  const filters = {
    action: req.query.action || null,
    entity_type: req.query.entity_type || null,
    limit: 100
  };
  const logs = auditSvc.getAuditTrail(filters);
  const stats = auditSvc.getAuditStats();

  res.render('admin/audit_logs', {
    title: 'Audit Trail / Log Aktivitas',
    company: company(),
    activePage: 'audit_logs',
    logs,
    stats,
    filters
  });
});

// ─── MONITORING ──────────────────────────────────────────────────────────────
router.get('/monitoring', requireAdminSession, restrictToAdmin, async (req, res) => {
  const healthStatus = monitoringSvc.getHealthStatus();
  const performanceSummary = monitoringSvc.getPerformanceSummary();
  const dependencies = await diagnosticsSvc.checkDependencies();
  const recentErrors = diagnosticsSvc.getRecentErrors(10);

  res.render('admin/monitoring', {
      title: 'Monitoring Sistem',
      company: company(),
      activePage: 'monitoring',
      healthStatus,
      performanceSummary,
      dependencies,
      recentErrors
    });
});

router.get('/api/health', requireAdmin, (req, res) => {
  const healthStatus = monitoringSvc.getHealthStatus();
  res.json(healthStatus);
});

router.get('/api/metrics', requireAdmin, (req, res) => {
  const metrics = monitoringSvc.getAllMetrics();
  res.json(metrics);
});

router.get('/api/metrics/history', requireAdmin, (req, res) => {
  const limit = parseInt(req.query.limit) || 10;
  const history = monitoringSvc.getMetricsHistory(limit);
  res.json(history);
});

// ─── API ROUTES (existing) ──────────────────────────────────────────────────
router.get('/api/stats', requireAdmin, async (req, res) => {
  try {
    const result = await customerDevice.listAllDevices(1000);
    if (!result.ok) return res.json({ error: result.message });
    const devices = result.devices;
    const total = devices.length;
    let online = 0, offline = 0;
    const now = Date.now();
    devices.forEach(d => {
      if (d._lastInform && (now - new Date(d._lastInform).getTime()) < 15 * 60 * 1000) online++;
      else offline++;
    });
    res.json({ total, online, offline, warning: 0, lastUpdate: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ error: 'Failed to get stats', detail: e.message });
  }
});

router.get('/api/devices', requireAdmin, async (req, res) => {
  try {
    const { search, status, limit = 100, offset = 0 } = req.query;
    const result = await customerDevice.listAllDevices(1000);
    if (!result.ok) return res.json({ error: result.message });
    let devices = result.devices.map(d => {
      const mapped = customerDevice.mapDeviceData(d, d._tags?.[0] || d._id);
      return {
        id: d._id, tags: d._tags || [],
        serialNumber: mapped.serialNumber,
        lastInform: d._lastInform,
        status: mapped.status.toLowerCase(),
        pppoeIP: mapped.pppoeIP,
        pppoeUsername: mapped.pppoeUsername,
        rxPower: mapped.rxPower,
        uptime: mapped.uptime,
        model: mapped.model,
        softwareVersion: mapped.softwareVersion,
        userConnected: mapped.totalAssociations,
        ssid: mapped.ssid
      };
    });
    if (search) { 
      const s = search.toLowerCase();
      const billingCustomers = customerSvc.getAllCustomers(s);
      const matchingTags = new Set(billingCustomers.map(c => c.genieacs_tag?.toLowerCase()).filter(Boolean));
      const matchingPppoes = new Set(billingCustomers.map(c => c.pppoe_username?.toLowerCase()).filter(Boolean));

      devices = devices.filter(d => 
        d.id.toLowerCase().includes(s) ||
        d.tags.some(t => t.toLowerCase().includes(s) || matchingTags.has(t.toLowerCase())) || 
        d.serialNumber.toLowerCase().includes(s) || 
        (d.pppoeIP && d.pppoeIP.toLowerCase().includes(s)) ||
        (d.pppoeUsername && d.pppoeUsername !== 'N/A' && d.pppoeUsername.toLowerCase().includes(s)) ||
        (d.pppoeUsername && matchingPppoes.has(d.pppoeUsername.toLowerCase()))
      ); 
    }
    if (status && status !== 'all') devices = devices.filter(d => d.status === status);
    const total = devices.length;
    const paginated = devices.slice(parseInt(offset), parseInt(offset) + parseInt(limit));
    res.json({ devices: paginated, total, limit: parseInt(limit), offset: parseInt(offset) });
  } catch (e) {
    res.status(500).json({ error: 'Failed to get devices', detail: e.message });
  }
});

router.get('/api/device/:tag', requireAdmin, async (req, res) => {
  try {
    const data = await customerDevice.getCustomerDeviceData(req.params.tag);
    if (!data || data.status === 'Tidak ditemukan') return res.status(404).json({ error: 'Device not found' });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: 'Failed to get device details' });
  }
});

router.post('/api/device/:tag/ssid', requireAdmin, express.json(), async (req, res) => {
  const { ssid } = req.body;
  if (!ssid) return res.status(400).json({ error: 'SSID required' });
  const ok = await customerDevice.updateSSID(req.params.tag, ssid);
  // Kirim notifikasi WhatsApp ke pelanggan
  if (ok) {
    try {
      const tag = req.params.tag;
      const cust = customerSvc.findCustomerByAny(tag);
      if (cust && cust.phone) {
        const now = new Date().toLocaleString('id-ID');
        const msg = `📶 *PERUBAHAN SSID WIFI*\n\n` +
          `👤 *Pelanggan:* ${cust.name}\n` +
          `🕒 *Waktu:* ${now}\n\n` +
          `SSID WiFi Anda sudah diperbarui menjadi:\n` +
          `📡 *${ssid}*\n\n` +
          `Silakan pilih SSID baru di perangkat Anda untuk terhubung.\n` +
          `⚠️ Jangan bagikan info ini ke orang lain.`;
        await trySendWhatsappPayment(cust.phone, msg);
      }
    } catch (e) { logger.error('[Admin] Gagal kirim notif SSID via WA: ' + (e.message || e)); }
  }
  res.json({ success: ok });
});

router.post('/api/device/:tag/password', requireAdmin, express.json(), async (req, res) => {
  const { password } = req.body;
  if (!password || password.length < 8) return res.status(400).json({ error: 'Password minimal 8 karakter' });
  const ok = await customerDevice.updatePassword(req.params.tag, password);
  // Kirim notifikasi WhatsApp ke pelanggan
  if (ok) {
    try {
      const tag = req.params.tag;
      const cust = customerSvc.findCustomerByAny(tag);
      if (cust && cust.phone) {
        const now = new Date().toLocaleString('id-ID');
        const msg = `🔑 *PERUBAHAN PASSWORD WIFI*\n\n` +
          `👤 *Pelanggan:* ${cust.name}\n` +
          `🕒 *Waktu:* ${now}\n\n` +
          `Password WiFi Anda sudah diperbarui menjadi:\n` +
          `🔐 *${password}*\n\n` +
          `Silakan gunakan password baru untuk terhubung.\n` +
          `⚠️ Jangan bagikan password ini ke orang lain.`;
        await trySendWhatsappPayment(cust.phone, msg);
      }
    } catch (e) { logger.error('[Admin] Gagal kirim notif Password via WA: ' + (e.message || e)); }
  }
  res.json({ success: ok });
});

router.post('/api/device/:tag/reboot', requireAdmin, async (req, res) => {
  const result = await customerDevice.requestReboot(req.params.tag);
  res.json(result);
});

router.post('/api/bulk/ssid', requireAdmin, express.json(), async (req, res) => {
  const { tags, ssid } = req.body;
  if (!Array.isArray(tags) || !ssid) return res.status(400).json({ error: 'Tags and SSID required' });
  const results = [];
  for (const tag of tags) {
    try {
      const success = await customerDevice.updateSSID(tag, ssid);
      results.push({ tag, success });
      // Kirim notifikasi WhatsApp ke pelanggan
      if (success) {
        try {
          const cust = customerSvc.findCustomerByAny(tag);
          if (cust && cust.phone) {
            const now = new Date().toLocaleString('id-ID');
            const msg = `📶 *PERUBAHAN SSID WIFI*\n\n` +
              `👤 *Pelanggan:* ${cust.name}\n` +
              `🕒 *Waktu:* ${now}\n\n` +
              `SSID WiFi Anda sudah diperbarui menjadi:\n` +
              `📡 *${ssid}*\n\n` +
              `Silakan pilih SSID baru di perangkat Anda untuk terhubung.\n` +
              `⚠️ Jangan bagikan info ini ke orang lain.`;
            await trySendWhatsappPayment(cust.phone, msg);
          }
        } catch (e) { /* ignore per-customer WA notification errors */ }
      }
    }
    catch (e) { results.push({ tag, success: false, error: e.message }); }
  }
  res.json({ results, total: tags.length, success: results.filter(r => r.success).length });
});

router.get('/api/mikrotik/profiles', requireAdmin, async (req, res) => {
  try {
    const profiles = await mikrotikService.getPppoeProfiles(req.query.routerId);
    res.json(profiles);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/api/mikrotik/users', requireAdmin, async (req, res) => {
  try {
    const routerId = req.query.routerId ? Number(req.query.routerId) : null;
    const onlyUnused = String(req.query.onlyUnused || '') === '1';
    const excludeCustomerId = req.query.excludeCustomerId ? Number(req.query.excludeCustomerId) : null;
    const users = await mikrotikService.getPppoeUsers(routerId);
    if (!onlyUnused) return res.json(users);

    const rows = excludeCustomerId
      ? db.prepare("SELECT pppoe_username FROM customers WHERE router_id IS ? AND id != ? AND pppoe_username IS NOT NULL AND TRIM(pppoe_username) != ''").all(routerId, excludeCustomerId)
      : db.prepare("SELECT pppoe_username FROM customers WHERE router_id IS ? AND pppoe_username IS NOT NULL AND TRIM(pppoe_username) != ''").all(routerId);
    const used = new Set(rows.map(r => String(r.pppoe_username).trim()).filter(Boolean));
    const filtered = (Array.isArray(users) ? users : []).filter(u => u && u.name && !used.has(String(u.name).trim()));
    res.json(filtered);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── MIKROTIK MONITORING ───────────────────────────────────────────────────
router.get('/mikrotik', requireAdminSession, (req, res) => {
  const routers = mikrotikService.getAllRouters();
  res.render('admin/mikrotik', {
    title: 'Monitoring MikroTik', company: company(), activePage: 'mikrotik', 
    routers, msg: flashMsg(req)
  });
});

router.get('/vouchers', requireAdminSession, (req, res) => {
  const routers = mikrotikService.getAllRouters();
  res.render('admin/vouchers', {
    title: 'Manajemen Voucher', company: company(), activePage: 'mikrotik',
    routers, msg: flashMsg(req), settings: getSettings()
  });
});

router.get('/api/vouchers/template', requireAdminSession, (req, res) => {
  const settings = getSettings();
  res.json({
    use_template: !!settings.voucher_print_use_template,
    default_style: String(settings.voucher_print_default_style || ''),
    header: String(settings.voucher_print_template_header || ''),
    row: String(settings.voucher_print_template_row || ''),
    footer: String(settings.voucher_print_template_footer || '')
  });
});

router.post('/api/vouchers/template', requireAdminSession, restrictToAdmin, express.json({ limit: '1mb' }), (req, res) => {
  try {
    const useTemplate = !!req.body.use_template;
    const defaultStyle = String(req.body.default_style || '').trim().toLowerCase();
    const header = String(req.body.header || '');
    const row = String(req.body.row || '');
    const footer = String(req.body.footer || '');
    saveSettings({
      voucher_print_use_template: useTemplate,
      voucher_print_default_style: defaultStyle,
      voucher_print_template_header: header,
      voucher_print_template_row: row,
      voucher_print_template_footer: footer
    });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/api/webhook/payment-notif/logs', requireAdminSession, (req, res) => {
  try {
    const limit = Math.max(1, Math.min(500, Number(req.query.limit) || 200));
    const service = String(req.query.service || '').trim();
    const q = String(req.query.q || '').trim();

    const where = [];
    const params = [];
    if (service) {
      where.push('service = ?');
      params.push(service);
    }
    if (q) {
      where.push('(content LIKE ? OR service LIKE ?)');
      params.push(`%${q}%`, `%${q}%`);
    }

    const sql = `
      SELECT id, created_at, service, content, parsed_amount, parsed_ok, matched_invoice_id, ip
      FROM webhook_payment_notifs
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY id DESC
      LIMIT ?
    `;
    const rows = db.prepare(sql).all(...params, limit);
    res.json({ ok: true, rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.post('/api/webhook/payment-notif/clear', requireAdminSession, restrictToAdmin, express.json(), (req, res) => {
  try {
    db.prepare('DELETE FROM webhook_payment_notifs').run();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.get('/vouchers/batches/:id/print', requireAdminSession, (req, res) => {
  const batchId = Number(req.params.id);
  const batch = db.prepare(`
    SELECT b.*, r.name AS router_name
    FROM voucher_batches b
    LEFT JOIN routers r ON r.id = b.router_id
    WHERE b.id = ?
  `).get(batchId);
  if (!batch) return res.status(404).send('Batch tidak ditemukan');

  const vouchers = db.prepare(`
    SELECT code, password, profile_name, used_at
    FROM vouchers
    WHERE batch_id = ?
    ORDER BY code ASC
  `).all(batchId);

  const settings = getSettings();
  const requestedStyle = String(req.query.style || '').trim().toLowerCase();
  const style = requestedStyle || String(settings.voucher_print_default_style || '').trim().toLowerCase() || (settings.voucher_print_use_template ? 'template' : 'cards');

  const escapeHtml = (s) => String(s ?? '').replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

  const stripUnsafe = (html) => {
    let out = String(html || '');
    out = out.replace(/<\?(?:php)?[\s\S]*?\?>/gi, '');
    out = out.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');
    out = out.replace(/\son\w+\s*=\s*(['"]).*?\1/gi, '');
    return out;
  };

  const applyVars = (tpl, vars) => {
    let out = String(tpl || '');
    out = out.replace(/%([a-zA-Z0-9_#]+)%/g, (m, k) => (vars[k] != null ? vars[k] : m));
    out = out.replace(/\{\{\s*([a-zA-Z0-9_#]+)\s*\}\}/g, (m, k) => (vars[k] != null ? vars[k] : m));
    return out;
  };

  const formatValidity = (v) => {
    if (!v) return '-';
    const s = String(v).trim();
    const mDay = s.match(/^(\d+)\s*d$/i);
    if (mDay) return `${Number(mDay[1])} hari`;
    return s;
  };

  let renderedHtml = '';
  let templateError = '';
  const builtinTemplate = (name) => {
    const phone = (Array.isArray(settings.whatsapp_admin_numbers) && settings.whatsapp_admin_numbers.length > 0)
      ? ('+' + String(settings.whatsapp_admin_numbers[0]))
      : String(settings.company_phone || '');
    const companyName = settings.company_header || company();
    const timeStamp = new Date().toISOString();
    const priceNumber = Number(batch.price || 0);
    const priceText = priceNumber.toLocaleString('id-ID');
    const validityText = formatValidity(batch.validity);

    const rows = (vouchers || []).map((v, i) => {
      const credential = (String(v.code) === String(v.password))
        ? escapeHtml(String(v.code))
        : `U: ${escapeHtml(v.code)}<br>P: ${escapeHtml(v.password)}`;
      return {
        idx: i + 1,
        username: escapeHtml(v.code),
        password: escapeHtml(v.password),
        credential,
        profile: escapeHtml(batch.profile_name || v.profile_name || ''),
        company: escapeHtml(companyName),
        phone: escapeHtml(phone),
        timeStamp: escapeHtml(timeStamp),
        currency: 'Rp',
        price: escapeHtml(String(priceNumber)),
        priceText: escapeHtml(priceText),
        validity: escapeHtml(batch.validity || ''),
        validityText: escapeHtml(validityText),
      };
    });

    if (name === 'mks') {
      const css = `<style>
@page{size:A4;margin:6mm}
*{box-sizing:border-box}
body{margin:0;font-family:Arial,sans-serif;color:#0f172a}
.v-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}
.vc{border:1px solid #0f172a;border-radius:10px;min-height:110px;padding:8px;position:relative;break-inside:avoid;overflow:hidden}
.vc:before{content:"";position:absolute;inset:0;background:linear-gradient(120deg,rgba(59,130,246,.03),rgba(16,185,129,.025))}
.vc>*{position:relative}
.vh{font-weight:900;font-size:11px;letter-spacing:.2px}
.vp{position:absolute;top:8px;right:8px;font-size:10.5px;font-weight:800;background:rgba(16,185,129,.16);border:1px solid rgba(16,185,129,.35);padding:2px 7px;border-radius:999px}
.vm{font-size:10px;color:#334155;margin-top:6px}
.vu{font-weight:950;font-size:18px;letter-spacing:1px;margin-top:8px;font-family:Consolas,monospace;line-height:1.15}
.vf{position:absolute;left:50%;bottom:6px;transform:translateX(-50%);font-size:9.5px;color:#334155;white-space:nowrap}
</style>`;
      const html = rows.map(r => `<div class="vc">
  <div class="vh">${r.company}</div>
  <div class="vp">${r.currency} ${r.priceText}</div>
  <div class="vm">${r.profile} • ${r.validityText}</div>
  <div class="vu">${r.credential}</div>
  <div class="vf">WA: ${r.phone}</div>
</div>`).join('\n');
      return `${css}<div class="v-grid">\n${html}\n</div>`;
    }

    if (name === 'simple') {
      const css = `<style>
@page{size:A4;margin:6mm}
*{box-sizing:border-box}
body{margin:0;font-family:Arial,sans-serif;color:#0f172a}
.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}
.card{border:1.5px solid #334155;border-radius:10px;padding:8px 8px 22px;min-height:110px;position:relative;break-inside:avoid}
.hd{font-weight:800;font-size:11px}
.code{font-weight:900;font-size:22px;letter-spacing:2px;margin-top:6px;font-family:Consolas,monospace}
.meta{font-size:10px;color:#334155;margin-top:4px}
.wa{position:absolute;left:50%;bottom:6px;transform:translateX(-50%);font-size:9.5px;color:#334155;white-space:nowrap}
</style>`;
      const html = rows.map(r => `<div class="card">
  <div class="hd">${r.company}</div>
  <div class="meta">${r.profile} • ${r.validityText} • ${r.currency} ${r.priceText}</div>
  <div class="code">${r.username}</div>
  <div class="meta">${r.password}</div>
  <div class="wa">WA: ${r.phone}</div>
</div>`).join('\n');
      return `${css}<div class="grid">\n${html}\n</div>`;
    }

    if (name === 'minimal') {
      const css = `<style>
@page{size:A4;margin:6mm}
*{box-sizing:border-box}
body{margin:0;font-family:Arial,sans-serif;color:#0f172a}
.g{display:grid;grid-template-columns:repeat(4,1fr);gap:6px}
.c{border:1px dashed #334155;border-radius:8px;padding:6px 6px 18px;min-height:84px;position:relative;break-inside:avoid}
.t{font-weight:900;font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.m{font-size:9.5px;color:#334155;margin-top:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.k{font-weight:950;font-size:18px;letter-spacing:2px;margin-top:8px;font-family:Consolas,monospace}
.w{position:absolute;left:6px;right:6px;bottom:5px;font-size:9px;color:#334155;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
</style>`;
      const html = rows.map(r => `<div class="c">
  <div class="t">${r.company}</div>
  <div class="m">${r.profile}</div>
  <div class="k">${r.username}</div>
  <div class="w">${r.validityText} • ${r.currency} ${r.priceText} • ${r.phone}</div>
</div>`).join('\n');
      return `${css}<div class="g">\n${html}\n</div>`;
    }

    return '';
  };

  if (style === 'mks' || style === 'simple' || style === 'minimal') {
    renderedHtml = builtinTemplate(style);
  } else if (style === 'template') {
    const headerTpl = String(settings.voucher_print_template_header || '');
    const rowTpl = String(settings.voucher_print_template_row || '');
    const footerTpl = String(settings.voucher_print_template_footer || '');

    if (rowTpl.trim()) {
      const looksLikePhpOnly = (tpl) => {
        const s = String(tpl || '');
        const hasHtml = /<\s*[a-zA-Z][^>]*>/.test(s);
        const phpSignals = /(\$[a-zA-Z_])|(\bif\s*\()|(\bsubstr\s*\()|(\bstrlen\s*\()|(\belse(if)?\b)|(\bforeach\b)/.test(s);
        const manyPhp = (s.match(/\$/g) || []).length >= 3;
        return !hasHtml && (phpSignals || manyPhp);
      };
      const combined = `${headerTpl}\n${rowTpl}\n${footerTpl}`;
      if (/<\?(?:php)?/i.test(combined) || looksLikePhpOnly(combined)) {
        templateError = 'Template yang dipaste masih format PHP (Mikhmon). Di sini hanya mendukung template HTML + placeholder (%username% dll).';
      }

      const phone = (Array.isArray(settings.whatsapp_admin_numbers) && settings.whatsapp_admin_numbers.length > 0)
        ? ('+' + String(settings.whatsapp_admin_numbers[0]))
        : String(settings.company_phone || '');
      const timeStamp = new Date().toISOString();
      const priceNumber = Number(batch.price || 0);
      const priceText = priceNumber.toLocaleString('id-ID');
      const validityText = formatValidity(batch.validity);

      const parts = [];
      parts.push(stripUnsafe(applyVars(headerTpl, {
        company: escapeHtml(settings.company_header || company()),
        phone: escapeHtml(phone),
        timeStamp: escapeHtml(timeStamp),
        currency: 'Rp',
        validityText: escapeHtml(validityText),
        priceText: escapeHtml(priceText)
      })));

      vouchers.forEach((v, i) => {
        const credential = (String(v.code) === String(v.password))
          ? escapeHtml(String(v.code))
          : `U: ${escapeHtml(v.code)}<br>P: ${escapeHtml(v.password)}`;
        const vars = {
          username: escapeHtml(v.code),
          password: escapeHtml(v.password),
          profile: escapeHtml(batch.profile_name || v.profile_name || ''),
          validity: escapeHtml(batch.validity || ''),
          validityText: escapeHtml(validityText),
          price: escapeHtml(String(priceNumber)),
          priceText: escapeHtml(priceText),
          currency: 'Rp',
          company: escapeHtml(settings.company_header || company()),
          phone: escapeHtml(phone),
          timeStamp: escapeHtml(timeStamp),
          '#': escapeHtml(String(i + 1)),
          credential
        };
        parts.push(stripUnsafe(applyVars(rowTpl, vars)));
      });

      parts.push(stripUnsafe(applyVars(footerTpl, {
        company: escapeHtml(settings.company_header || company()),
        phone: escapeHtml(phone),
        timeStamp: escapeHtml(timeStamp),
        currency: 'Rp',
        validityText: escapeHtml(validityText),
        priceText: escapeHtml(priceText)
      })));

      renderedHtml = parts.join('\n');
    }
  }

  let finalStyle = style;
  if (finalStyle === 'template') {
    const s = String(renderedHtml || '').trim();
    if (!s || !/<\s*[a-zA-Z][^>]*>/.test(s) || templateError) {
      renderedHtml = '';
      finalStyle = 'cards';
    }
  }

  res.render('admin/print_vouchers', {
    title: 'Cetak Voucher',
    company: company(),
    settings,
    batch,
    vouchers,
    style: finalStyle,
    renderedHtml,
    templateError
  });
});

router.get('/vouchers/batches/:id/export.csv', requireAdminSession, (req, res) => {
  const batchId = Number(req.params.id);
  const batch = db.prepare(`
    SELECT b.*, r.name AS router_name
    FROM voucher_batches b
    LEFT JOIN routers r ON r.id = b.router_id
    WHERE b.id = ?
  `).get(batchId);
  if (!batch) return res.status(404).send('Batch tidak ditemukan');

  const vouchers = db.prepare(`
    SELECT code, password, profile_name, used_at
    FROM vouchers
    WHERE batch_id = ?
    ORDER BY code ASC
  `).all(batchId);

  const lines = [];
  lines.push(['code', 'password', 'profile', 'validity', 'price', 'router', 'batch_id', 'created_at', 'used_at'].join(','));
  const createdAt = batch.created_at || '';
  const validity = batch.validity || '';
  const price = Number(batch.price || 0);
  const routerName = batch.router_name || '';
  for (const v of vouchers) {
    const row = [
      v.code,
      v.password,
      v.profile_name,
      validity,
      price,
      routerName,
      batchId,
      createdAt,
      v.used_at || ''
    ].map(x => `"${String(x ?? '').replace(/"/g, '""')}"`).join(',');
    lines.push(row);
  }

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename=vouchers_batch_${batchId}.csv`);
  res.send(lines.join('\n'));
});

router.get('/api/vouchers/batches', requireAdmin, (req, res) => {
  const routerId = req.query.routerId ? Number(req.query.routerId) : null;
  const rows = db.prepare(`
    SELECT
      b.*,
      r.name AS router_name,
      (SELECT COUNT(1) FROM vouchers v WHERE v.batch_id = b.id) AS vouchers_count,
      (SELECT COUNT(1) FROM vouchers v WHERE v.batch_id = b.id AND v.used_at IS NOT NULL) AS used_count
    FROM voucher_batches b
    LEFT JOIN routers r ON r.id = b.router_id
    WHERE (? IS NULL OR b.router_id = ?)
    ORDER BY b.id DESC
    LIMIT 200
  `).all(routerId, routerId);
  res.json(rows);
});

router.get('/api/vouchers/batches/:id', requireAdmin, (req, res) => {
  const batchId = Number(req.params.id);
  const batch = db.prepare(`
    SELECT
      b.*,
      r.name AS router_name,
      (SELECT COUNT(1) FROM vouchers v WHERE v.batch_id = b.id) AS vouchers_count,
      (SELECT COUNT(1) FROM vouchers v WHERE v.batch_id = b.id AND v.used_at IS NOT NULL) AS used_count
    FROM voucher_batches b
    LEFT JOIN routers r ON r.id = b.router_id
    WHERE b.id = ?
  `).get(batchId);
  if (!batch) return res.status(404).json({ error: 'Batch tidak ditemukan' });

  const vouchers = db.prepare(`
    SELECT id, code, password, profile_name, status, used_at, last_seen_comment, last_seen_uptime, last_seen_at
    FROM vouchers
    WHERE batch_id = ?
    ORDER BY code ASC
    LIMIT 2000
  `).all(batchId);
  res.json({ batch, vouchers });
});

router.post('/api/vouchers/batches', requireAdmin, express.json(), async (req, res) => {
  try {
    const routerId = req.query.routerId ? Number(req.query.routerId) : null;
    const profileName = String(req.body.profile || '').trim();
    const qty = Math.max(1, Math.min(5000, Number(req.body.qty) || 0));
    const prefix = String(req.body.prefix || '').trim();
    const codeLength = Math.max(4, Math.min(16, Number(req.body.codeLength) || 6));
    const mode = String(req.body.mode || 'voucher');
    const charset = String(req.body.charset || 'numbers');
    const priceInput = req.body.price;
    
    if (!profileName) return res.status(400).json({ error: 'Profile wajib diisi' });
    if (!qty) return res.status(400).json({ error: 'Jumlah voucher wajib diisi' });
    if (prefix.length >= codeLength) return res.status(400).json({ error: 'Prefix terlalu panjang' });

    const profiles = await mikrotikService.getHotspotUserProfiles(routerId);
    const profile = profiles.find(p => p.name === profileName);
    if (!profile) return res.status(400).json({ error: 'Profile Hotspot tidak ditemukan di MikroTik' });

    const meta = parseMikhmonOnLogin(profile.onLogin || profile['on-login']);
    if (!meta || !meta.validity) return res.status(400).json({ error: 'Profile belum memiliki metadata harga/durasi (Format Mikhmon)' });

    const createdBy = req.session?.isAdmin ? (req.session.adminUser || 'admin') : (req.session.cashierName || 'staff');
    let price = Number(meta.price || 0);
    if (priceInput !== undefined && priceInput !== null && String(priceInput).trim() !== '') {
      const p = Number(priceInput);
      if (!Number.isFinite(p) || p < 0) return res.status(400).json({ error: 'Harga tidak valid' });
      price = Math.floor(p);
    }

    const insertBatch = db.prepare(`
      INSERT INTO voucher_batches (router_id, profile_name, qty_total, qty_created, qty_failed, price, validity, prefix, code_length, status, created_by, mode, charset)
      VALUES (?, ?, ?, 0, 0, ?, ?, ?, ?, 'creating', ?, ?, ?)
    `);
    const batchRes = insertBatch.run(routerId, profileName, qty, price, meta.validity || '', prefix, codeLength, createdBy, mode, charset);
    const batchId = Number(batchRes.lastInsertRowid);

    const insertVoucher = db.prepare(`
      INSERT INTO vouchers (batch_id, router_id, code, password, profile_name, comment, status)
      VALUES (?, ?, ?, ?, ?, ?, 'pending')
    `);

    const exists = db.prepare('SELECT 1 FROM vouchers WHERE router_id IS ? AND code = ? LIMIT 1');
    const codes = new Set();
    const makeCode = () => {
      const coreLen = Math.max(4, Math.min(16, codeLength - prefix.length));
      const userCode = prefix + genCode(coreLen, charset);
      let passCode = userCode;
      if (mode === 'member') {
        passCode = genCode(coreLen, charset);
      }
      return { userCode, passCode };
    };

    const initialVouchers = [];
    while (initialVouchers.length < qty) {
      const generated = makeCode();
      if (codes.has(generated.userCode)) continue;
      if (exists.get(routerId, generated.userCode)) continue;
      codes.add(generated.userCode);
      initialVouchers.push(generated);
    }

    const tx = db.transaction((items) => {
      for (const c of items) {
        insertVoucher.run(batchId, routerId, c.userCode, c.passCode, profileName, `vc-${c.userCode}-${profileName}`);
      }
    });
    tx(initialVouchers);

    setImmediate(() => {
      createVoucherBatchAsync(batchId).catch(e => logger.error('[VoucherBatch] Error: ' + (e?.message || e)));
    });

    res.json({ success: true, batchId });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/api/vouchers/batches/:id/sync', requireAdmin, async (req, res) => {
  try {
    const batchId = Number(req.params.id);
    const batch = db.prepare('SELECT * FROM voucher_batches WHERE id = ?').get(batchId);
    if (!batch) return res.status(404).json({ error: 'Batch tidak ditemukan' });

    const routerId = batch.router_id ?? null;
    const users = await mikrotikService.getHotspotUsers(routerId);
    const byName = new Map();
    for (const u of users) {
      if (u?.name) byName.set(String(u.name), u);
    }

    const list = db.prepare('SELECT id, code, used_at FROM vouchers WHERE batch_id = ?').all(batchId);
    const updSeen = db.prepare("UPDATE vouchers SET last_seen_comment=?, last_seen_uptime=?, last_seen_at=CURRENT_TIMESTAMP WHERE id=?");
    const markUsed = db.prepare("UPDATE vouchers SET used_at=CURRENT_TIMESTAMP, status='used', last_seen_comment=?, last_seen_uptime=?, last_seen_at=CURRENT_TIMESTAMP WHERE id=?");
    const markMissing = db.prepare("UPDATE vouchers SET status='missing', last_seen_at=CURRENT_TIMESTAMP WHERE id=?");

    let usedNew = 0;
    let missing = 0;

    const tx = db.transaction(() => {
      for (const v of list) {
        const u = byName.get(String(v.code));
        if (!u) {
          markMissing.run(v.id);
          missing++;
          continue;
        }
        const comment = String(u.comment || '');
        const uptime = String(u.uptime || '');
        const isUsedByComment = comment && !comment.toLowerCase().startsWith('vc') && !comment.toLowerCase().startsWith('up');
        const isUsedByUptime = uptime && uptime !== '0s' && uptime !== '0' && uptime !== '00:00:00';
        const usedNow = isUsedByComment || isUsedByUptime;
        if (usedNow && !v.used_at) {
          markUsed.run(comment, uptime, v.id);
          usedNew++;
        } else {
          updSeen.run(comment, uptime, v.id);
        }
      }
    });
    tx();

    res.json({ success: true, usedNew, missing, total: list.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/api/vouchers/batches/:id/delete', requireAdmin, async (req, res) => {
  try {
    const batchId = Number(req.params.id);
    if (!batchId) return res.status(400).json({ error: 'Batch ID tidak valid' });

    const batch = db.prepare('SELECT id, status FROM voucher_batches WHERE id = ?').get(batchId);
    if (!batch) return res.status(404).json({ error: 'Batch tidak ditemukan' });
    if (String(batch.status) === 'creating') {
      return res.status(400).json({ error: 'Batch sedang diproses (creating). Silakan tunggu hingga selesai.' });
    }

    const stats = db.prepare(`
      SELECT
        (SELECT COUNT(1) FROM vouchers v WHERE v.batch_id = ?) AS total,
        (SELECT COUNT(1) FROM vouchers v WHERE v.batch_id = ? AND v.used_at IS NOT NULL) AS used
    `).get(batchId, batchId);

    const del = db.prepare('DELETE FROM voucher_batches WHERE id = ?');
    del.run(batchId);

    res.json({ success: true, deletedBatchId: batchId, deletedVouchers: stats?.total || 0, usedCount: stats?.used || 0 });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/api/mikrotik/secrets', requireAdmin, async (req, res) => {
  try { res.json(await mikrotikService.getPppoeSecrets(req.query.routerId)); } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/api/mikrotik/secrets', requireAdmin, express.json(), async (req, res) => {
  try { await mikrotikService.addPppoeSecret(req.body, req.query.routerId); res.json({ success: true }); } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/api/mikrotik/secrets/:id/update', requireAdmin, express.json(), async (req, res) => {
  try { await mikrotikService.updatePppoeSecret(req.params.id, req.body, req.query.routerId); res.json({ success: true }); } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/api/mikrotik/secrets/:id/delete', requireAdmin, async (req, res) => {
  try { await mikrotikService.deletePppoeSecret(req.params.id, req.query.routerId); res.json({ success: true }); } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/api/mikrotik/hotspot-users', requireAdmin, async (req, res) => {
  try { res.json(await mikrotikService.getHotspotUsers(req.query.routerId)); } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/api/mikrotik/hotspot-users', requireAdmin, express.json(), async (req, res) => {
  try { await mikrotikService.addHotspotUser(req.body, req.query.routerId); res.json({ success: true }); } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/api/mikrotik/hotspot-users/:id/update', requireAdmin, express.json(), async (req, res) => {
  try { await mikrotikService.updateHotspotUser(req.params.id, req.body, req.query.routerId); res.json({ success: true }); } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/api/mikrotik/hotspot-users/:id/delete', requireAdmin, async (req, res) => {
  try { await mikrotikService.deleteHotspotUser(req.params.id, req.query.routerId); res.json({ success: true }); } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/api/mikrotik/hotspot-profiles', requireAdmin, async (req, res) => {
  try { res.json(await mikrotikService.getHotspotProfiles(req.query.routerId)); } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/api/mikrotik/active-pppoe', requireAdmin, async (req, res) => {
  try { res.json(await mikrotikService.getPppoeActive(req.query.routerId)); } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/api/mikrotik/active-hotspot', requireAdmin, async (req, res) => {
  try { res.json(await mikrotikService.getHotspotActive(req.query.routerId)); } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/api/mikrotik/ip-pools', requireAdmin, async (req, res) => {
  try { res.json(await mikrotikService.getIpPools(req.query.routerId)); } catch (e) { res.status(500).json({ error: e.message }); }
});

// PPPoE Profiles CRUD
router.post('/api/mikrotik/pppoe-profiles', requireAdmin, express.json(), async (req, res) => {
  try { await mikrotikService.addPppoeProfile(req.body, req.query.routerId); res.json({ success: true }); } catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/api/mikrotik/pppoe-profiles/:id/update', requireAdmin, express.json(), async (req, res) => {
  try { await mikrotikService.updatePppoeProfile(req.params.id, req.body, req.query.routerId); res.json({ success: true }); } catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/api/mikrotik/pppoe-profiles/:id/delete', requireAdmin, async (req, res) => {
  try { await mikrotikService.deletePppoeProfile(req.params.id, req.query.routerId); res.json({ success: true }); } catch (e) { res.status(500).json({ error: e.message }); }
});

// Hotspot User Profiles CRUD
router.get('/api/mikrotik/hotspot-user-profiles', requireAdmin, async (req, res) => {
  try {
    const rows = await mikrotikService.getHotspotUserProfiles(req.query.routerId);
    res.json((Array.isArray(rows) ? rows : []).map((r) => ({ ...r, id: r.id || r['.id'] })));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
router.get('/api/mikrotik/hotspot-user-profiles/:id', requireAdmin, async (req, res) => {
  try {
    const row = await mikrotikService.getHotspotUserProfileById(req.params.id, req.query.routerId);
    if (!row) return res.status(404).json({ error: 'Profile tidak ditemukan' });
    return res.json({ ok: true, row });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});
router.post('/api/mikrotik/hotspot-user-profiles', requireAdmin, express.json(), async (req, res) => {
  try { await mikrotikService.addHotspotUserProfile(req.body, req.query.routerId); res.json({ success: true }); } catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/api/mikrotik/hotspot-user-profiles/:id/update', requireAdmin, express.json(), async (req, res) => {
  try { await mikrotikService.updateHotspotUserProfile(req.params.id, req.body, req.query.routerId); res.json({ success: true }); } catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/api/mikrotik/hotspot-user-profiles/:id/delete', requireAdmin, async (req, res) => {
  try { await mikrotikService.deleteHotspotUserProfile(req.params.id, req.query.routerId); res.json({ success: true }); } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/api/mikrotik/backup', requireAdmin, async (req, res) => {
  try {
    const backup = await mikrotikService.getBackup(req.query.routerId);
    res.setHeader('Content-disposition', 'attachment; filename=mikrotik_backup_' + new Date().toISOString().slice(0,10) + '.rsc');
    res.setHeader('Content-type', 'text/plain');
    res.send(backup);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── WHATSAPP ──────────────────────────────────────────────────────────────
// Global Broadcast Tracker
global.broadcastStatus = {
  active: false,
  total: 0,
  sent: 0,
  failed: 0,
  startTime: null,
  paused: false,
  stopped: false,
  currentBatch: 0,
  messagesPerHour: 0,
  hourlyLimit: 100
};

// Helper: Random delay generator untuk smart rate limiting
function getRandomDelay(baseDelayMs, varianceMs = 3000) {
  const minDelay = Math.max(baseDelayMs - varianceMs, 2000);
  const maxDelay = baseDelayMs + varianceMs;
  return Math.floor(Math.random() * (maxDelay - minDelay + 1)) + minDelay;
}

// Helper: Exponential backoff untuk error handling
function getBackoffDelay(attemptCount, baseDelayMs = 2000) {
  const maxDelay = 30000;
  const delay = Math.min(baseDelayMs * Math.pow(2, attemptCount), maxDelay);
  return delay + Math.floor(Math.random() * 1000);
}

// Helper: Message variation untuk menghindari spam detection
function addMessageVariation(message, index) {
  const variations = [
    '',
    '\n\n_',
    '\n\n•',
    '\n\n▪',
    '\n\n▫'
  ];
  const suffix = variations[index % variations.length];
  return message + suffix;
}

// Helper: Cek apakah waktu aman untuk broadcast (hindari jam sibuk)
function isSafeTimeToBroadcast() {
  const now = new Date();
  const hour = now.getHours();
  // Hindari jam 00:00 - 06:00 (jam malam) dan jam 18:00 - 21:00 (jam sibuk)
  return hour >= 8 && hour <= 17;
}

// Helper: Hitung delay berdasarkan jam (lebih lama di jam sibuk)
function getTimeBasedDelay(baseDelayMs) {
  const now = new Date();
  const hour = now.getHours();
  
  // Jam sibuk (18:00 - 21:00): delay 2x lebih lama
  if (hour >= 18 && hour <= 21) {
    return baseDelayMs * 2;
  }
  
  // Jam malam (00:00 - 06:00): delay 3x lebih lama
  if (hour >= 0 && hour <= 6) {
    return baseDelayMs * 3;
  }
  
  // Jam normal: delay normal
  return baseDelayMs;
}

// Helper: Cek duplicate message untuk menghindari spam
function isDuplicateMessage(phone, message, messageHistory) {
  const key = `${phone}_${message.substring(0, 50)}`;
  const lastSent = messageHistory.get(key);
  if (!lastSent) return false;
  
  const timeDiff = Date.now() - lastSent;
  return timeDiff < 3600000; // 1 jam
}

// Helper: Cek apakah error adalah permanent (tidak perlu retry)
function isPermanentError(errorMessage) {
  const permanentErrorPatterns = [
    /invalid.*number/i,
    /number.*not.*found/i,
    /phone.*not.*exist/i,
    /blocked/i,
    /banned/i,
    /not.*registered/i,
    /user.*not.*found/i,
    /404/i,
    /400/i
  ];
  
  return permanentErrorPatterns.some(pattern => pattern.test(errorMessage));
}

// Helper: Cek apakah error adalah temporary (bisa retry)
function isTemporaryError(errorMessage) {
  const temporaryErrorPatterns = [
    /timeout/i,
    /network/i,
    /connection/i,
    /rate.*limit/i,
    /too.*many/i,
    /429/i,
    /500/i,
    /502/i,
    /503/i,
    /504/i
  ];
  
  return temporaryErrorPatterns.some(pattern => pattern.test(errorMessage));
}

// Global message history untuk duplicate detection
global.broadcastMessageHistory = new Map();

router.get('/whatsapp', requireAdminSession, async (req, res) => {
  res.render('admin/whatsapp', {
    title: 'Status WhatsApp', company: company(), activePage: 'whatsapp', msg: flashMsg(req)
  });
});

router.get('/whatsapp/broadcast', requireAdminSession, (req, res) => {
  res.render('admin/broadcast', {
    title: 'Broadcast WhatsApp', company: company(), activePage: 'broadcast', msg: flashMsg(req),
    broadcastStatus: global.broadcastStatus, getSetting
  });
});

router.get('/api/whatsapp/broadcast-status', requireAdminSession, (req, res) => {
  res.json(global.broadcastStatus);
});

// API: Pause Broadcast
router.post('/api/whatsapp/broadcast-pause', requireAdminSession, (req, res) => {
  if (!global.broadcastStatus.active) {
    return res.json({ ok: false, error: 'Tidak ada broadcast yang sedang berjalan.' });
  }
  global.broadcastStatus.paused = true;
  logger.info('[Broadcast] Broadcast dipause oleh admin.');
  res.json({ ok: true, message: 'Broadcast berhasil dipause.' });
});

// API: Resume Broadcast
router.post('/api/whatsapp/broadcast-resume', requireAdminSession, (req, res) => {
  if (!global.broadcastStatus.active) {
    return res.json({ ok: false, error: 'Tidak ada broadcast yang sedang berjalan.' });
  }
  global.broadcastStatus.paused = false;
  logger.info('[Broadcast] Broadcast dilanjutkan oleh admin.');
  res.json({ ok: true, message: 'Broadcast berhasil dilanjutkan.' });
});

// API: Stop Broadcast
router.post('/api/whatsapp/broadcast-stop', requireAdminSession, (req, res) => {
  if (!global.broadcastStatus.active) {
    return res.json({ ok: false, error: 'Tidak ada broadcast yang sedang berjalan.' });
  }
  global.broadcastStatus.stopped = true;
  global.broadcastStatus.paused = false;
  logger.info('[Broadcast] Broadcast dihentikan oleh admin.');
  res.json({ ok: true, message: 'Broadcast berhasil dihentikan.' });
});

router.post('/whatsapp/broadcast', requireAdminSession, express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const { target, message, delay: customDelay, batchSize: customBatchSize, hourlyLimit: customHourlyLimit } = req.body;
    if (!message) throw new Error('Pesan tidak boleh kosong');
    
    // Smart Rate Limit Settings
    const baseDelayMs = (parseInt(customDelay) || getSetting('whatsapp_broadcast_delay', 5)) * 1000; // Default 5 detik
    const batchSize = parseInt(customBatchSize) || 15; // Default 15 pesan per batch (lebih aman)
    const batchPauseMs = 120000; // Pause 2 menit setelah setiap batch (lebih aman)
    const hourlyLimit = parseInt(customHourlyLimit) || 80; // Default 80 pesan per jam (lebih aman)
    
    if (customDelay) {
      const v = parseInt(customDelay);
      if (Number.isFinite(v) && v >= 1 && v <= 60) {
        saveSettings({ whatsapp_broadcast_delay: v });
      }
    }

    if (global.broadcastStatus.active) {
      throw new Error('Ada proses broadcast yang sedang berjalan. Silakan tunggu hingga selesai.');
    }

    let customers = [];
    const allCust = customerSvc.getAllCustomers();
    
    if (target === 'all') {
      customers = allCust;
    } else if (target === 'active') {
      customers = allCust.filter(c => c.status === 'active');
    } else if (target === 'suspended') {
      customers = allCust.filter(c => c.status === 'suspended');
    } else if (target === 'unpaid') {
      customers = allCust.filter(c => c.unpaid_count > 0);
    }

    // Ambil pelanggan unik berdasarkan nomor HP
    const uniqueCustomers = [];
    const seenPhones = new Set();
    for (const c of customers) {
      if (c.phone && c.phone.length > 8 && !seenPhones.has(c.phone)) {
        uniqueCustomers.push(c);
        seenPhones.add(c.phone);
      }
    }

    if (uniqueCustomers.length === 0) {
      throw new Error('Tidak ada nomor pelanggan yang valid untuk target tersebut.');
    }

    const { sendWA } = await import('../services/whatsappBot.mjs');
    
    // Initialize Tracker dengan Smart Rate Limit
    global.broadcastStatus = {
      active: true,
      total: uniqueCustomers.length,
      sent: 0,
      failed: 0,
      startTime: new Date(),
      paused: false,
      stopped: false,
      currentBatch: 0,
      messagesPerHour: 0,
      hourlyLimit: hourlyLimit
    };

    const sendMessageAsync = async () => {
      let batchCount = 0;
      let messagesInCurrentHour = 0;
      let hourStartTime = Date.now();
      
      for (let i = 0; i < uniqueCustomers.length; i++) {
        // Cek jika broadcast dihentikan
        if (global.broadcastStatus.stopped) {
          logger.info('[Broadcast] Broadcast dihentikan oleh admin.');
          break;
        }
        
        // Cek jika broadcast dipause
        while (global.broadcastStatus.paused) {
          await new Promise(r => setTimeout(r, 2000));
          if (global.broadcastStatus.stopped) break;
        }
        
        if (global.broadcastStatus.stopped) break;

        // Hourly Rate Limiting
        const elapsedHour = Date.now() - hourStartTime;
        if (elapsedHour >= 3600000) { // 1 jam
          messagesInCurrentHour = 0;
          hourStartTime = Date.now();
        }
        
        if (messagesInCurrentHour >= hourlyLimit) {
          const waitTime = 3600000 - elapsedHour;
          logger.info(`[Broadcast] Hourly limit tercapai (${hourlyLimit} pesan). Menunggu ${Math.floor(waitTime / 60000)} menit...`);
          await new Promise(r => setTimeout(r, waitTime));
          messagesInCurrentHour = 0;
          hourStartTime = Date.now();
        }

        const cust = uniqueCustomers[i];
        let attemptCount = 0;
        const maxAttempts = 3;
        
        while (attemptCount < maxAttempts) {
          try {
            // Smart Random Delay
            const randomDelay = getRandomDelay(baseDelayMs, 2000);
            await new Promise(r => setTimeout(r, randomDelay));
            
            // Hitung Tagihan
            const unpaidInvoices = billingSvc.getUnpaidInvoicesByCustomerId(cust.id);
            const totalTagihan = unpaidInvoices.reduce((sum, inv) => sum + inv.amount, 0);
            const rincianBulan = unpaidInvoices.map(inv => `${inv.period_month}/${inv.period_year}`).join(', ');
            
            // Generate Link Login
            const protocol = req.protocol;
            const host = req.get('host');
            const loginLink = `${protocol}://${host}/customer/login`;

            // Format Pesan dengan variation untuk menghindari spam detection
            let formattedMsg = message
              .replace(/{{nama}}/gi, cust.name || 'Pelanggan')
              .replace(/{{tagihan}}/gi, totalTagihan.toLocaleString('id-ID'))
              .replace(/{{rincian}}/gi, rincianBulan || '-')
              .replace(/{{paket}}/gi, cust.package_name || '-')
              .replace(/{{link}}/gi, loginLink);
            
            // Add subtle variation untuk menghindari spam detection
            formattedMsg = addMessageVariation(formattedMsg, i);

            await sendWA(cust.phone, formattedMsg);
            global.broadcastStatus.sent++;
            messagesInCurrentHour++;
            global.broadcastStatus.messagesPerHour = messagesInCurrentHour;
            batchCount++;
            
            // Batch Processing: Pause setelah N pesan
            if (batchCount >= batchSize && i < uniqueCustomers.length - 1) {
              logger.info(`[Broadcast] Selesai batch ${global.broadcastStatus.currentBatch + 1} (${batchSize} pesan). Pause ${Math.floor(batchPauseMs / 1000)} detik...`);
              global.broadcastStatus.currentBatch++;
              await new Promise(r => setTimeout(r, batchPauseMs));
              batchCount = 0;
            }
            
            break; // Sukses, keluar dari retry loop
          } catch (e) {
            attemptCount++;
            const errorMsg = e.message || e.toString();
            
            // Cek apakah error permanent (tidak perlu retry)
            if (isPermanentError(errorMsg)) {
              logger.warn(`[Broadcast] SKIP: Error permanent untuk ${cust.phone} - ${errorMsg}`);
              global.broadcastStatus.failed++;
              break; // Skip retry langsung ke pelanggan berikutnya
            }
            
            // Error temporary, bisa retry
            logger.error(`[Broadcast] Gagal kirim ke ${cust.phone} (attempt ${attemptCount}/${maxAttempts}): ${errorMsg}`);
            
            if (attemptCount >= maxAttempts) {
              logger.warn(`[Broadcast] Max attempts tercapai untuk ${cust.phone}`);
              global.broadcastStatus.failed++;
            } else {
              // Exponential backoff untuk retry
              const backoffDelay = getBackoffDelay(attemptCount);
              logger.info(`[Broadcast] Retry ke ${cust.phone} dalam ${Math.floor(backoffDelay / 1000)} detik...`);
              await new Promise(r => setTimeout(r, backoffDelay));
            }
          }
        }
      }
      
      global.broadcastStatus.active = false;
      logger.info(`[Broadcast] Selesai. Terkirim: ${global.broadcastStatus.sent}, Gagal: ${global.broadcastStatus.failed}`);
    };
    
    sendMessageAsync(); 

    req.session._msg = { type: 'success', text: `Broadcast sedang diproses untuk dikirim ke ${uniqueCustomers.length} pelanggan dengan smart rate limit.` };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal Broadcast: ' + e.message };
  }
  res.redirect('/admin/whatsapp/broadcast');
});

router.post('/whatsapp/auto-billing', requireAdminSession, express.urlencoded({ extended: true }), (req, res) => {
  try {
    const enabled = req.body && req.body.enabled ? true : false;
    const delay = req.body && req.body.delay ? parseInt(req.body.delay) : null;
    const next = { whatsapp_auto_billing_enabled: enabled };
    if (delay != null && Number.isFinite(delay) && delay >= 1 && delay <= 60) {
      next.whatsapp_broadcast_delay = delay;
    }
    const msg = req.body && typeof req.body.message === 'string' ? req.body.message.trim() : '';
    if (msg) {
      next.whatsapp_auto_billing_message = msg;
    }
    saveSettings(next);
    req.session._msg = { type: 'success', text: `Pengingat tagihan otomatis ${enabled ? 'diaktifkan' : 'dimatikan'}.` };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal menyimpan pengaturan: ' + e.message };
  }
  res.redirect('/admin/whatsapp/broadcast');
});

router.get('/api/whatsapp/status', requireAdmin, async (req, res) => {
    try {
      const { whatsappStatus } = await import('../services/whatsappBot.mjs');
      res.json(whatsappStatus);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

router.post('/whatsapp/test-notification', requireAdminSession, async (req, res) => {
  try {
    const { sendWA, whatsappStatus } = await import('../services/whatsappBot.mjs');
    if (whatsappStatus.connection !== 'open') {
      throw new Error('Bot WhatsApp belum terhubung. Silakan scan QR hingga status Terhubung.');
    }
    const adminPhone = '087820851413';
    const msg =
      `🧪 *TEST NOTIFIKASI WHATSAPP*\n\n` +
      `✅ Jika pesan ini masuk, berarti notifikasi WhatsApp dari Billing Alijaya System sudah berfungsi.\n` +
      `📅 Waktu: ${new Date().toLocaleString('id-ID')}`;
    const ok = await sendWA(adminPhone, msg);
    if (!ok) throw new Error('Gagal mengirim pesan test (sendWA=false).');
    req.session._msg = { type: 'success', text: 'Test notifikasi WhatsApp berhasil dikirim.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal kirim test WhatsApp: ' + e.message };
  }
  res.redirect('/admin/whatsapp');
});

router.post('/whatsapp/reset', requireAdminSession, (req, res) => {
  try {
    const authFolder = getSetting('whatsapp_auth_folder', 'auth_info_baileys');
    const folderPath = path.resolve(__dirname, '..', authFolder);
    
    if (fs.existsSync(folderPath)) {
      fs.rmSync(folderPath, { recursive: true, force: true });
      logger.info(`[WA] Session reset by admin. Folder ${authFolder} deleted.`);
      
      // Trigger restart bot secara asinkron
      import('../services/whatsappBot.mjs').then(m => m.restartWhatsAppBot()).catch(e => {
        logger.error('Failed to trigger WA restart:', e.message);
      });

      req.session._msg = { text: 'Sesi WhatsApp berhasil dihapus. Bot sedang memulai ulang, silakan tunggu QR Code muncul.', type: 'success' };
    } else {
      req.session._msg = { text: 'Folder sesi tidak ditemukan atau sudah dihapus.', type: 'warning' };
    }
    res.redirect('/admin/whatsapp');
  } catch (e) {
    logger.error('Failed to reset WA session:', e.message);
    req.session._msg = { text: 'Gagal menghapus sesi: ' + e.message + '. (Kemungkinan file sedang digunakan, silakan matikan aplikasi dulu lalu hapus folder ' + getSetting('whatsapp_auth_folder', 'auth_info_baileys') + ' secara manual)', type: 'danger' };
    res.redirect('/admin/whatsapp');
  }
});

// ─── ROUTERS (MULTI-ROUTER) ──────────────────────────────────────────────────
router.get('/routers', requireAdminSession, (req, res) => {
  res.render('admin/routers', {
    title: 'Manajemen Router', company: company(), activePage: 'mikrotik',
    routers: mikrotikService.getAllRouters(), msg: flashMsg(req)
  });
});

router.post('/routers', requireAdminSession, express.urlencoded({ extended: true }), (req, res) => {
  try {
    mikrotikService.createRouter(req.body);
    req.session._msg = { type: 'success', text: `Router "${req.body.name}" berhasil ditambahkan.` };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal: ' + e.message };
  }
  res.redirect('/admin/routers');
});

router.post('/routers/:id/update', requireAdminSession, express.urlencoded({ extended: true }), (req, res) => {
  try {
    mikrotikService.updateRouter(req.params.id, req.body);
    req.session._msg = { type: 'success', text: 'Router berhasil diperbarui.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal: ' + e.message };
  }
  res.redirect('/admin/routers');
});

router.post('/routers/:id/delete', requireAdminSession, (req, res) => {
  try {
    mikrotikService.deleteRouter(req.params.id);
    req.session._msg = { type: 'success', text: 'Router berhasil dihapus.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal: ' + e.message };
  }
  res.redirect('/admin/routers');
});

router.get('/api/routers/:id/test', requireAdmin, async (req, res) => {
  try {
    const conn = await mikrotikService.getConnection(req.params.id);
    if (conn && conn.api) {
      conn.api.close();
      return res.json({ success: true, message: 'Koneksi ke Router Berhasil!' });
    }
    throw new Error('Gagal terhubung ke router');
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

router.post('/api/routers/:id/setup-firewall', requireAdmin, async (req, res) => {
  try {
    const result = await mikrotikService.setupIsolirFirewall(req.params.id);
    res.json(result);
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

router.get('/api/isolir-portal-script', requireAdmin, async (req, res) => {
  try {
    const data = await mikrotikService.generateIsolirPortalScript();
    res.json({ success: true, ...data });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

router.get('/api/mikrotik/profiles/:routerId', requireAdmin, async (req, res) => {
  try {
    const profiles = await mikrotikService.getPppoeProfiles(req.params.routerId);
    res.json(profiles);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/api/mikrotik/users/:routerId', requireAdmin, async (req, res) => {
  try {
    const routerId = req.params.routerId ? Number(req.params.routerId) : null;
    const onlyUnused = String(req.query.onlyUnused || '') === '1';
    const excludeCustomerId = req.query.excludeCustomerId ? Number(req.query.excludeCustomerId) : null;
    const users = await mikrotikService.getPppoeUsers(routerId);
    if (!onlyUnused) return res.json(users);

    const rows = excludeCustomerId
      ? db.prepare("SELECT pppoe_username FROM customers WHERE router_id IS ? AND id != ? AND pppoe_username IS NOT NULL AND TRIM(pppoe_username) != ''").all(routerId, excludeCustomerId)
      : db.prepare("SELECT pppoe_username FROM customers WHERE router_id IS ? AND pppoe_username IS NOT NULL AND TRIM(pppoe_username) != ''").all(routerId);
    const used = new Set(rows.map(r => String(r.pppoe_username).trim()).filter(Boolean));
    const filtered = (Array.isArray(users) ? users : []).filter(u => u && u.name && !used.has(String(u.name).trim()));
    res.json(filtered);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
// ─── ATTENDANCE MANAGEMENT ───────────────────────────────────────────────────

// Attendance dashboard
router.get('/attendance', requireAdminSession, (req, res) => {
  try {
    const date = req.query.date || new Date().toISOString().split('T')[0];
    const attendances = attendanceSvc.getAttendanceByDate(date);
    const stats = attendanceSvc.getAttendanceStats(date);
    const lateCheckIns = attendanceSvc.getLateCheckIns(date);
    const notCheckedOut = attendanceSvc.getNotCheckedOut(date);
    
    res.render('admin/attendance', {
      title: 'Manajemen Absensi',
      company: company(),
      activePage: 'attendance',
      session: req.session,
      attendances,
      stats,
      lateCheckIns,
      notCheckedOut,
      selectedDate: date,
      msg: flashMsg(req),
      t: (key, defaultVal) => defaultVal || key
    });
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal memuat data absensi: ' + e.message };
    res.redirect('/admin');
  }
});

// Get attendance by date range (API)
router.get('/api/attendance/range', requireAdminSession, (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    if (!startDate || !endDate) {
      return res.json({ success: false, message: 'Start date dan end date wajib diisi' });
    }
    
    const attendances = attendanceSvc.getAttendanceByDateRange(startDate, endDate);
    res.json({ success: true, data: attendances });
  } catch (e) {
    res.json({ success: false, message: e.message });
  }
});

// Get employee attendance history
router.get('/api/attendance/employee/:type/:id', requireAdminSession, (req, res) => {
  try {
    const { type, id } = req.params;
    const limit = req.query.limit ? parseInt(req.query.limit) : 30;
    const history = attendanceSvc.getAttendanceHistory(type, parseInt(id), limit);
    res.json({ success: true, data: history });
  } catch (e) {
    res.json({ success: false, message: e.message });
  }
});

// Get monthly summary
router.get('/api/attendance/summary/:type/:id/:year/:month', requireAdminSession, (req, res) => {
  try {
    const { type, id, year, month } = req.params;
    const summary = attendanceSvc.getMonthlyAttendanceSummary(
      type, 
      parseInt(id), 
      parseInt(year), 
      parseInt(month)
    );
    res.json({ success: true, data: summary });
  } catch (e) {
    res.json({ success: false, message: e.message });
  }
});

// Update attendance (admin correction)
router.post('/attendance/:id/update', requireAdminSession, express.json(), (req, res) => {
  try {
    const { id } = req.params;
    const { check_in_time, check_in_note, check_out_time, check_out_note } = req.body;
    
    // Calculate duration if both times provided
    let duration = 0;
    if (check_in_time && check_out_time) {
      const checkIn = new Date(check_in_time);
      const checkOut = new Date(check_out_time);
      duration = Math.floor((checkOut - checkIn) / 1000 / 60);
    }
    
    attendanceSvc.updateAttendance(parseInt(id), {
      check_in_time,
      check_in_note: check_in_note || '',
      check_out_time: check_out_time || null,
      check_out_note: check_out_note || '',
      work_duration_minutes: duration
    });
    
    auditSvc.log('admin', req.session.username || 'admin', 'update_attendance', `Updated attendance #${id}`);
    res.json({ success: true, message: 'Absensi berhasil diperbarui' });
  } catch (e) {
    res.json({ success: false, message: 'Gagal update absensi: ' + e.message });
  }
});

// Delete attendance
router.post('/attendance/:id/delete', requireAdminSession, (req, res) => {
  try {
    const { id } = req.params;
    attendanceSvc.deleteAttendance(parseInt(id));
    auditSvc.log('admin', req.session.username || 'admin', 'delete_attendance', `Deleted attendance #${id}`);
    req.session._msg = { type: 'success', text: 'Absensi berhasil dihapus' };
    res.redirect('/admin/attendance');
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal hapus absensi: ' + e.message };
    res.redirect('/admin/attendance');
  }
});

// Export attendance to Excel
router.get('/attendance/export', requireAdminSession, (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    if (!startDate || !endDate) {
      req.session._msg = { type: 'error', text: 'Tanggal mulai dan akhir wajib diisi' };
      return res.redirect('/admin/attendance');
    }
    
    const attendances = attendanceSvc.getAttendanceByDateRange(startDate, endDate);
    
    // Prepare data for Excel
    const data = attendances.map(a => ({
      'ID': a.id,
      'Tipe Karyawan': a.employee_type,
      'Nama': a.employee_name,
      'Check In': a.check_in_time,
      'Lokasi Check In': a.check_in_lat && a.check_in_lng ? `${a.check_in_lat}, ${a.check_in_lng}` : '-',
      'Catatan Check In': a.check_in_note || '-',
      'Check Out': a.check_out_time || '-',
      'Lokasi Check Out': a.check_out_lat && a.check_out_lng ? `${a.check_out_lat}, ${a.check_out_lng}` : '-',
      'Catatan Check Out': a.check_out_note || '-',
      'Durasi (menit)': a.work_duration_minutes || 0,
      'Status': a.status
    }));
    
    const ws = XLSX.utils.json_to_sheet(data);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Absensi');
    
    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    
    res.setHeader('Content-Disposition', `attachment; filename=absensi_${startDate}_${endDate}.xlsx`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buffer);
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal export: ' + e.message };
    res.redirect('/admin/attendance');
  }
});


// ─── PAYROLL / GAJI KARYAWAN ───────────────────────────────────────────────

router.get('/payroll', requireAdmin, (req, res) => {
  const now = new Date();
  const month = parseInt(req.query.month) || (now.getMonth() + 1);
  const year = parseInt(req.query.year) || now.getFullYear();

  const employees = payrollSvc.getAllEmployees();
  const slips = payrollSvc.getSlipsByPeriod(month, year);
  const summary = payrollSvc.getPayrollSummary(month, year);

  const { getSettingsWithCache } = require('../config/settingsManager');
  res.render('admin/payroll', {
    title: 'Gaji Karyawan',
    company: getSettingsWithCache().company_header || 'My ISP',
    employees,
    slips,
    summary,
    selectedMonth: month,
    selectedYear: year,
    msg: req.session._msg || null
  });
  req.session._msg = null;
});

router.post('/payroll/settings', requireAdmin, (req, res) => {
  try {
    payrollSvc.upsertPayrollSetting(req.body);
    req.session._msg = { type: 'success', text: 'Pengaturan gaji berhasil disimpan.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal: ' + e.message };
  }
  res.redirect('/admin/payroll');
});

router.post('/payroll/generate', requireAdmin, (req, res) => {
  const month = parseInt(req.body.month);
  const year = parseInt(req.body.year);
  if (!month || !year) {
    req.session._msg = { type: 'error', text: 'Bulan dan tahun diperlukan' };
    return res.redirect('/admin/payroll');
  }

  const result = payrollSvc.generateAllSlips(month, year);
  req.session._msg = { 
    type: 'success', 
    text: `Generate selesai: ${result.generated} berhasil, ${result.skipped} dilewati, ${result.errors.length} error.` 
  };
  res.redirect(`/admin/payroll?month=${month}&year=${year}`);
});

router.post('/payroll/slip/:id/deduction', requireAdmin, express.json(), (req, res) => {
  try {
    const { other_deduction, other_deduction_note } = req.body;
    payrollSvc.updateSlipDeductions(req.params.id, other_deduction, other_deduction_note);
    res.json({ success: true, message: 'Potongan diperbarui' });
  } catch (e) {
    res.json({ success: false, message: e.message });
  }
});

router.post('/payroll/slip/:id/approve', requireAdmin, (req, res) => {
  try {
    payrollSvc.approveSlip(req.params.id);
    req.session._msg = { type: 'success', text: 'Slip berhasil di-approve.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: e.message };
  }
  res.redirect('back');
});

router.post('/payroll/slip/:id/paid', requireAdmin, (req, res) => {
  try {
    payrollSvc.markSlipPaid(req.params.id);
    req.session._msg = { type: 'success', text: 'Slip ditandai lunas (paid).' };
  } catch (e) {
    req.session._msg = { type: 'error', text: e.message };
  }
  res.redirect('back');
});

router.post('/payroll/slip/:id/delete', requireAdmin, (req, res) => {
  try {
    payrollSvc.deleteSlip(req.params.id);
    req.session._msg = { type: 'success', text: 'Slip berhasil dihapus.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: e.message };
  }
  res.redirect('back');
});

router.post('/payroll/bulk-approve', requireAdmin, (req, res) => {
  try {
    payrollSvc.bulkApprove(parseInt(req.body.month), parseInt(req.body.year));
    req.session._msg = { type: 'success', text: 'Semua slip draft berhasil di-approve.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: e.message };
  }
  res.redirect('back');
});

router.post('/payroll/bulk-paid', requireAdmin, (req, res) => {
  try {
    payrollSvc.bulkMarkPaid(parseInt(req.body.month), parseInt(req.body.year));
    req.session._msg = { type: 'success', text: 'Semua slip approved ditandai lunas.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: e.message };
  }
  res.redirect('back');
});

router.post('/payroll/delete-drafts', requireAdmin, (req, res) => {
  try {
    payrollSvc.deleteSlipsByPeriod(parseInt(req.body.month), parseInt(req.body.year));
    req.session._msg = { type: 'success', text: 'Semua slip draft dihapus.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: e.message };
  }
  res.redirect('back');
});

router.get('/payroll/slip/:id/print', requireAdmin, (req, res) => {
  const slip = payrollSvc.getSlipById(req.params.id);
  if (!slip) return res.status(404).send('Slip tidak ditemukan');
  
  const { getSettingsWithCache } = require('../config/settingsManager');
  res.render('admin/print_payslip', {
    company: getSettingsWithCache().company_header || 'My ISP',
    slip
  });
});

router.post('/payroll/slip/:id/send-wa', requireAdmin, async (req, res) => {
  try {
    const slip = payrollSvc.getSlipById(req.params.id);
    if (!slip) throw new Error('Slip tidak ditemukan');
    
    const phone = payrollSvc.getEmployeePhone(slip.employee_type, slip.employee_id);
    if (!phone) throw new Error('Nomor HP karyawan tidak diset');

    const { getSettingsWithCache } = require('../config/settingsManager');
    const settings = getSettingsWithCache();
    if (!settings.whatsapp_enabled) throw new Error('WhatsApp bot tidak aktif');

    const { sendWA, whatsappStatus } = await import('../services/whatsappBot.mjs');
    if (!whatsappStatus || whatsappStatus.connection !== 'open') {
      throw new Error('WhatsApp bot tidak terkoneksi');
    }

    const monthNames = ['','Januari','Februari','Maret','April','Mei','Juni','Juli','Agustus','September','Oktober','November','Desember'];
    
    const msg = `🧾 *SLIP GAJI KARYAWAN*\n\n` +
      `👤 *Nama:* ${slip.employee_name}\n` +
      `📅 *Periode:* ${monthNames[slip.period_month]} ${slip.period_year}\n` +
      `🏢 *Status:* ${slip.status.toUpperCase()}\n\n` +
      `*PENDAPATAN:*\n` +
      `- Gaji Pokok: Rp ${slip.base_salary.toLocaleString('id-ID')}\n` +
      (slip.transport_allowance ? `- Tunj. Transport: Rp ${slip.transport_allowance.toLocaleString('id-ID')}\n` : '') +
      (slip.meal_allowance ? `- Tunj. Makan: Rp ${slip.meal_allowance.toLocaleString('id-ID')}\n` : '') +
      (slip.phone_allowance ? `- Tunj. Pulsa: Rp ${slip.phone_allowance.toLocaleString('id-ID')}\n` : '') +
      (slip.other_allowance ? `- Tunj. Lain: Rp ${slip.other_allowance.toLocaleString('id-ID')}\n` : '') +
      (slip.ticket_bonus ? `- Bonus Tiket: +Rp ${slip.ticket_bonus.toLocaleString('id-ID')}\n` : '') +
      (slip.collection_commission ? `- Komisi Tagihan: +Rp ${slip.collection_commission.toLocaleString('id-ID')}\n` : '') +
      (slip.overtime_bonus ? `- Lembur: +Rp ${slip.overtime_bonus.toLocaleString('id-ID')}\n` : '') +
      `*Total Pendapatan: Rp ${slip.gross_salary.toLocaleString('id-ID')}*\n\n` +
      `*POTONGAN:*\n` +
      (slip.absence_deduction ? `- Potongan Absen: -Rp ${slip.absence_deduction.toLocaleString('id-ID')}\n` : '') +
      (slip.late_deduction ? `- Potongan Terlambat: -Rp ${slip.late_deduction.toLocaleString('id-ID')}\n` : '') +
      (slip.other_deduction ? `- Potongan Lain: -Rp ${slip.other_deduction.toLocaleString('id-ID')}\n` : '') +
      `*Total Potongan: Rp ${slip.total_deductions.toLocaleString('id-ID')}*\n\n` +
      `💰 *GAJI BERSIH: Rp ${slip.net_salary.toLocaleString('id-ID')}*\n\n` +
      `Terima kasih atas kerja keras Anda! 🙏`;

    await sendWA(phone, msg);
    res.json({ success: true, message: 'Terkirim' });
  } catch (e) {
    res.json({ success: false, message: e.message });
  }
});

module.exports = router;
