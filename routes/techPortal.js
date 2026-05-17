const express = require('express');
const router = express.Router();
const techSvc = require('../services/techService');
const customerSvc = require('../services/customerService');
const odpSvc = require('../services/odpService');
const { getSetting } = require('../config/settingsManager');
const mikrotikService = require('../services/mikrotikService');
const db = require('../config/database');
const oltSvc = require('../services/oltService');
const attendanceSvc = require('../services/attendanceService');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { uploadAttendance, removeAttendanceFile } = require('../middleware/attendanceUpload');

// Configure multer for photo uploads
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const uploadDir = path.join(__dirname, '../public/uploads/tickets');
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, 'ticket-' + uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({
  storage: storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB max
  fileFilter: function (req, file, cb) {
    const allowedTypes = /jpeg|jpg|png|gif|webp/;
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = allowedTypes.test(file.mimetype);
    if (mimetype && extname) {
      return cb(null, true);
    } else {
      cb(new Error('Hanya file gambar yang diperbolehkan (JPEG, PNG, GIF, WebP)'));
    }
  }
});

const waSendDedup = new Map();
function normalizeWaDigits(input) {
  let digits = String(input || '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.startsWith('0')) digits = '62' + digits.slice(1);
  if (digits.length < 8) return '';
  return digits;
}
function shouldSendWa(key, ttlMs = 15000) {
  const now = Date.now();
  const last = waSendDedup.get(key);
  if (last && (now - last) < ttlMs) return false;
  waSendDedup.set(key, now);
  if (waSendDedup.size > 5000) {
    for (const [k, t] of waSendDedup.entries()) {
      if ((now - t) > 10 * 60 * 1000) waSendDedup.delete(k);
    }
  }
  return true;
}

function requireTechSession(req, res, next) {
  if (req.session && req.session.isTechnician && req.session.techId) {
    return next();
  }
  res.redirect('/tech/login');
}

function flashMsg(req) {
  const m = req.session._msg;
  delete req.session._msg;
  return m || null;
}

function company() { return getSetting('company_header', 'ISP App'); }

// --- AUTH ---
router.get('/login', (req, res) => {
  if (req.session && req.session.isTechnician) return res.redirect('/tech');
  res.render('tech/login', { title: 'Teknisi Login', company: company(), error: null });
});

router.post('/login', express.urlencoded({ extended: true }), (req, res) => {
  const { username, password } = req.body;
  const tech = techSvc.authenticate(username, password);
  if (tech) {
    req.session.isTechnician = true;
    req.session.techId = tech.id;
    req.session.techName = tech.name;
    return res.redirect('/tech');
  }
  res.render('tech/login', { title: 'Teknisi Login', company: company(), error: 'Username atau password salah!' });
});

router.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/tech/login');
});

// --- DASHBOARD (My Tickets) ---
router.get('/', requireTechSession, (req, res) => {
  const techId = req.session.techId;
  const stats = techSvc.getTechStats(techId);
  const myTickets = techSvc.getAssignedTickets(techId);
  
  res.render('tech/dashboard', {
    title: 'Dashboard Teknisi', 
    company: company(), 
    techName: req.session.techName,
    activePage: 'dashboard',
    stats,
    tickets: myTickets,
    msg: flashMsg(req)
  });
});

// --- OPEN TICKETS (Pool) ---
router.get('/pool', requireTechSession, (req, res) => {
  const openTickets = techSvc.getOpenTickets();
  res.render('tech/pool', {
    title: 'Tiket Baru', 
    company: company(), 
    activePage: 'pool',
    tickets: openTickets,
    msg: flashMsg(req)
  });
});

// --- HISTORY TICKETS ---
router.get('/history', requireTechSession, (req, res) => {
  const techId = req.session.techId;
  const historyTickets = techSvc.getResolvedTickets(techId);
  res.render('tech/history', {
    title: 'Riwayat Tiket', 
    company: company(), 
    activePage: 'history',
    tickets: historyTickets,
    msg: flashMsg(req)
  });
});

// --- NETWORK MAP ---
router.get('/map', requireTechSession, (req, res) => {
  const customers = customerSvc.getAllCustomers();
  const odps = odpSvc.getAllOdps();
  
  res.render('tech/map', { 
    title: 'Peta Jaringan', 
    company: company(), 
    activePage: 'map', 
    customers, 
    odps,
    msg: flashMsg(req),
    settings: getSetting('office_lat') ? { office_lat: getSetting('office_lat'), office_lng: getSetting('office_lng') } : {}
  });
});

// --- ACTIONS ---
router.post('/tickets/:id/take', requireTechSession, (req, res) => {
  try {
    techSvc.takeTicket(req.params.id, req.session.techId);
    req.session._msg = { type: 'success', text: 'Tiket berhasil diambil. Silakan mulai kerjakan.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal mengambil tiket: ' + e.message };
  }
  res.redirect('/tech');
});

router.post('/tickets/:id/update', requireTechSession, upload.array('photos', 10), async (req, res) => {
  try {
    const { status, notes } = req.body;
    const ticketId = req.params.id;
    const techId = req.session.techId;
    
    // Prepare photo data
    let photoPaths = [];
    let photoMetadata = [];
    
    if (req.files && req.files.length > 0) {
      photoPaths = req.files.map(f => '/uploads/tickets/' + f.filename);
      photoMetadata = req.files.map((f, idx) => ({
        filename: f.filename,
        originalName: f.originalname,
        size: f.size,
        uploadedAt: new Date().toISOString(),
        lat: req.body.gps_lat || '',
        lng: req.body.gps_lng || ''
      }));
    }
    
    // Update ticket with photos and notes
    techSvc.updateTicketStatus(ticketId, techId, status, {
      notes: notes || '',
      photos: JSON.stringify(photoPaths),
      photoMetadata: JSON.stringify(photoMetadata)
    });
    
    req.session._msg = { type: 'success', text: 'Status keluhan berhasil diperbarui.' };

    // --- WHATSAPP NOTIFICATION FOR RESOLVED TICKET ---
    if (status === 'resolved') {
      try {
        const { getSettingsWithCache } = require('../config/settingsManager');
        const settings = getSettingsWithCache();
        
        if (settings.whatsapp_enabled) {
          const { sendWA } = await import('../services/whatsappBot.mjs');
          const ticketSvc = require('../services/ticketService');
          const ticket = ticketSvc.getTicketById(ticketId);
          
          if (ticket) {
            const photoCount = photoPaths.length;
            const photoText = photoCount > 0 ? `\n📸 *Foto Pekerjaan:* ${photoCount} foto terlampir` : '';
            
            const waMsg = `✅ *TIKET KELUHAN SELESAI*\n\n` +
                         `🎫 *ID Tiket:* #${ticket.id}\n` +
                         `👤 *Pelanggan:* ${ticket.customer_name}\n` +
                         `📝 *Subjek:* ${ticket.subject}\n` +
                         `🛠️ *Teknisi:* ${req.session.techName}${photoText}\n\n` +
                         `Keluhan Anda telah selesai dikerjakan. Terima kasih atas kesabarannya.`;

            // Kirim ke Pelanggan
            if (ticket.customer_phone) {
              const digits = normalizeWaDigits(ticket.customer_phone);
              if (digits) {
                const key = `ticket:resolved:customer:${ticketId}:${digits}`;
                if (shouldSendWa(key)) await sendWA(digits, waMsg);
              }
            }

            // Kirim ke Admin dengan info foto
            if (settings.whatsapp_admin_numbers && settings.whatsapp_admin_numbers.length > 0) {
              const notesText = notes ? `\n💬 *Catatan:* ${notes}` : '';
              const adminMsg = `✅ *LAPORAN TIKET SELESAI*\n\n` +
                               `🎫 *ID Tiket:* #${ticket.id}\n` +
                               `👤 *Pelanggan:* ${ticket.customer_name}\n` +
                               `🛠️ *Teknisi:* ${req.session.techName}\n` +
                               `📝 *Subjek:* ${ticket.subject}\n` +
                               `💬 *Pesan:* ${ticket.message}${notesText}${photoText}`;
              const recipients = new Set();
              for (const adminPhone of settings.whatsapp_admin_numbers) {
                const digits = normalizeWaDigits(adminPhone);
                if (digits) recipients.add(digits);
              }
              for (const digits of recipients) {
                const key = `ticket:resolved:admin:${ticketId}:${digits}`;
                if (!shouldSendWa(key)) continue;
                await sendWA(digits, adminMsg);
              }
            }
          }
        }
      } catch (waErr) {
        console.error(`[TechPortal] WA Notification Error: ${waErr.message}`);
      }
    }
    // -------------------------------------------------

  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal update keluhan: ' + e.message };
  }
  res.redirect('/tech');
});

// --- MONITORING ONU ---
router.get('/monitoring', requireTechSession, (req, res) => {
  res.render('tech/monitoring', {
    title: 'Monitoring ONU',
    company: company(),
    activePage: 'monitoring',
    msg: flashMsg(req)
  });
});

// --- CREATE CUSTOMER (Technician) ---
router.get('/customers/new', requireTechSession, (req, res) => {
  const packages = customerSvc.getAllPackages();
  const odps = odpSvc.getAllOdps();
  const routers = mikrotikService.getAllRouters();
  const olts = oltSvc.getAllOlts();
  res.render('tech/create_customer', {
    title: 'Tambah Pelanggan',
    company: company(),
    activePage: 'create_customer',
    packages,
    odps,
    routers,
    olts,
    msg: flashMsg(req)
  });
});

router.post('/customers', requireTechSession, express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const name = String(req.body.name || '').trim();
    if (!name) throw new Error('Nama pelanggan wajib diisi');

    const customerData = {
      name,
      phone: String(req.body.phone || '').trim(),
      email: String(req.body.email || '').trim(),
      address: String(req.body.address || '').trim(),
      package_id: req.body.package_id ? Number(req.body.package_id) : null,
      pppoe_username: String(req.body.pppoe_username || '').trim(),
      router_id: req.body.router_id ? Number(req.body.router_id) : null,
      olt_id: req.body.olt_id ? Number(req.body.olt_id) : null,
      odp_id: req.body.odp_id ? Number(req.body.odp_id) : null,
      pon_port: String(req.body.pon_port || '').trim(),
      lat: String(req.body.lat || '').trim(),
      lng: String(req.body.lng || '').trim(),
      isolir_profile: String(req.body.isolir_profile || 'isolir').trim() || 'isolir',
      status: String(req.body.status || 'active').trim() || 'active',
      install_date: req.body.install_date ? String(req.body.install_date).trim() : null,
      notes: String(req.body.notes || '').trim(),
      auto_isolate: req.body.auto_isolate !== undefined ? Number(req.body.auto_isolate) : 1,
      isolate_day: req.body.isolate_day !== undefined ? Number(req.body.isolate_day) : 10
    };

    if (customerData.pppoe_username) {
      const existing = db.prepare('SELECT id, name FROM customers WHERE router_id IS ? AND pppoe_username = ? LIMIT 1').get(customerData.router_id ?? null, customerData.pppoe_username);
      if (existing) throw new Error(`PPPoE Username sudah dipakai pelanggan lain: ${existing.name}`);

      let conn = null;
      try {
        conn = await mikrotikService.getConnection(customerData.router_id || null);
        const results = await conn.client.menu('/ppp/secret')
          .where('service', 'pppoe')
          .where('name', customerData.pppoe_username)
          .get();
        if (!Array.isArray(results) || results.length === 0) throw new Error('PPPoE Username tidak ditemukan di MikroTik');
      } finally {
        if (conn && conn.api) conn.api.close();
      }
    }

    const inserted = customerSvc.createCustomer(customerData);

    if (customerData.pppoe_username) {
      let targetProfile = '';
      if (customerData.status === 'suspended') {
        targetProfile = customerData.isolir_profile || 'isolir';
      } else if (customerData.package_id) {
        const pkg = customerSvc.getPackageById(customerData.package_id);
        if (pkg) targetProfile = pkg.name;
      }
      if (targetProfile) {
        try {
          await mikrotikService.setPppoeProfile(customerData.pppoe_username, targetProfile, customerData.router_id);
        } catch (mErr) {}
      }
    }

    const updateOdpFlag = String(req.body.update_odp || '') === '1';
    if (updateOdpFlag && customerData.odp_id) {
      const existing = odpSvc.getOdpById(customerData.odp_id);
      if (existing) {
        const newLat = String(req.body.odp_lat || '').trim();
        const newLng = String(req.body.odp_lng || '').trim();
        const newCap = req.body.odp_port_capacity !== undefined && req.body.odp_port_capacity !== null && String(req.body.odp_port_capacity).trim() !== ''
          ? Number(req.body.odp_port_capacity)
          : (existing.port_capacity || 16);
        const newPon = String(req.body.odp_pon_port || '').trim();

        odpSvc.updateOdp(existing.id, {
          name: existing.name,
          olt_id: existing.olt_id,
          pon_port: newPon || existing.pon_port || '',
          port_capacity: Number.isFinite(newCap) && newCap > 0 ? Math.floor(newCap) : (existing.port_capacity || 16),
          lat: newLat || existing.lat || '',
          lng: newLng || existing.lng || '',
          description: existing.description || ''
        });
      }
    }

    req.session._msg = { type: 'success', text: `Pelanggan "${name}" berhasil dibuat.` };
    res.redirect('/tech/customers/new');
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal membuat pelanggan: ' + e.message };
    res.redirect('/tech/customers/new');
  }
});

// API Endpoints for Technician
const customerDevice = require('../services/customerDeviceService');

router.get('/api/mikrotik/pppoe-users', requireTechSession, async (req, res) => {
  try {
    const routerId = req.query.routerId ? Number(req.query.routerId) : null;
    const users = await mikrotikService.getPppoeUsers(routerId);
    const usedRows = db.prepare('SELECT pppoe_username FROM customers WHERE router_id IS ? AND pppoe_username IS NOT NULL AND TRIM(pppoe_username) != ""').all(routerId);
    const used = new Set(usedRows.map(r => String(r.pppoe_username).trim()).filter(Boolean));
    const filtered = (Array.isArray(users) ? users : []).filter(u => u && u.name && !used.has(String(u.name).trim()));
    res.json(filtered);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/api/mikrotik/pppoe-profiles', requireTechSession, async (req, res) => {
  try {
    const routerId = req.query.routerId ? Number(req.query.routerId) : null;
    const profiles = await mikrotikService.getPppoeProfiles(routerId);
    res.json(profiles);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/api/odps/:id/ports', requireTechSession, (req, res) => {
  try {
    const odpId = Number(req.params.id);
    if (!odpId) return res.status(400).json({ error: 'ODP tidak valid' });
    const usage = odpSvc.getOdpPortUsage(odpId);
    if (!usage) return res.status(404).json({ error: 'ODP tidak ditemukan' });
    res.json(usage);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/api/devices', requireTechSession, async (req, res) => {
  try {
    const { search, status, limit = 100, offset = 0 } = req.query;
    const customers = db.prepare('SELECT id, name, phone, pppoe_username, genieacs_tag FROM customers').all();
    const byPppoe = new Map();
    const byTag = new Map();
    for (const c of customers) {
      const pu = String(c.pppoe_username || '').trim().toLowerCase();
      const tg = String(c.genieacs_tag || '').trim();
      if (pu) byPppoe.set(pu, c);
      if (tg) byTag.set(tg, c);
    }

    const result = await customerDevice.listAllDevices(1000);
    if (!result.ok) return res.json({ error: result.message });
    
    let devices = result.devices.map(d => {
      const mapped = customerDevice.mapDeviceData(d, d._tags?.[0] || d._id);
      const pu = String(mapped.pppoeUsername || '').trim();
      const puKey = pu && pu !== 'N/A' ? pu.toLowerCase() : '';
      let customer = puKey ? byPppoe.get(puKey) : null;
      if (!customer && Array.isArray(d._tags)) {
        for (const t of d._tags) {
          const hit = byTag.get(String(t || '').trim());
          if (hit) { customer = hit; break; }
        }
      }
      return {
        id: d._id, 
        tags: d._tags || [],
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
        ssid: mapped.ssid,
        customerId: customer ? customer.id : null,
        customerName: customer ? customer.name : '',
        customerPhone: customer ? customer.phone : ''
      };
    });

    if (search) {
      const s = search.toLowerCase();
      devices = devices.filter(d => 
        d.id.toLowerCase().includes(s) ||
        d.tags.some(t => t.toLowerCase().includes(s)) || 
        d.serialNumber.toLowerCase().includes(s) || 
        (d.pppoeUsername && d.pppoeUsername !== 'N/A' && d.pppoeUsername.toLowerCase().includes(s)) ||
        (d.customerName && d.customerName.toLowerCase().includes(s)) ||
        (d.customerPhone && d.customerPhone.toLowerCase().includes(s))
      );
    }

    if (status && status !== 'all') devices = devices.filter(d => d.status === status);
    
    res.json({ devices: devices.slice(0, 100), total: devices.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/api/device/:tag', requireTechSession, async (req, res) => {
  try {
    const data = await customerDevice.getCustomerDeviceData(req.params.tag);
    if (!data || data.status === 'Tidak ditemukan') return res.status(404).json({ error: 'Device not found' });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: 'Failed to get device details' });
  }
});

router.post('/api/device/:tag/ssid', requireTechSession, express.json(), async (req, res) => {
  const { ssid } = req.body;
  if (!ssid) return res.status(400).json({ error: 'SSID required' });
  const ok = await customerDevice.updateSSID(req.params.tag, ssid);
  // Kirim notifikasi WhatsApp ke pelanggan
  if (ok) {
    try {
      const { getSettingsWithCache } = require('../config/settingsManager');
      const settings = getSettingsWithCache();
      if (settings.whatsapp_enabled) {
        const tag = req.params.tag;
        const cust = customerSvc.findCustomerByAny(tag);
        if (cust && cust.phone) {
          const { sendWA, whatsappStatus } = await import('../services/whatsappBot.mjs');
          if (whatsappStatus && whatsappStatus.connection === 'open') {
            const now = new Date().toLocaleString('id-ID');
            const msg = `\ud83d\udcf6 *PERUBAHAN SSID WIFI*\n\n` +
              `\ud83d\udc64 *Pelanggan:* ${cust.name}\n` +
              `\ud83d\udd52 *Waktu:* ${now}\n\n` +
              `SSID WiFi Anda sudah diperbarui menjadi:\n` +
              `\ud83d\udce1 *${ssid}*\n\n` +
              `Silakan pilih SSID baru di perangkat Anda untuk terhubung.\n` +
              `\u26a0\ufe0f Jangan bagikan info ini ke orang lain.`;
            await sendWA(cust.phone, msg);
          }
        }
      }
    } catch (e) { /* ignore WA notification errors */ }
  }
  res.json({ success: ok });
});

router.post('/api/device/:tag/password', requireTechSession, express.json(), async (req, res) => {
  const { password } = req.body;
  if (!password || password.length < 8) return res.status(400).json({ error: 'Password minimal 8 karakter' });
  const ok = await customerDevice.updatePassword(req.params.tag, password);
  // Kirim notifikasi WhatsApp ke pelanggan
  if (ok) {
    try {
      const { getSettingsWithCache } = require('../config/settingsManager');
      const settings = getSettingsWithCache();
      if (settings.whatsapp_enabled) {
        const tag = req.params.tag;
        const cust = customerSvc.findCustomerByAny(tag);
        if (cust && cust.phone) {
          const { sendWA, whatsappStatus } = await import('../services/whatsappBot.mjs');
          if (whatsappStatus && whatsappStatus.connection === 'open') {
            const now = new Date().toLocaleString('id-ID');
            const msg = `\ud83d\udd11 *PERUBAHAN PASSWORD WIFI*\n\n` +
              `\ud83d\udc64 *Pelanggan:* ${cust.name}\n` +
              `\ud83d\udd52 *Waktu:* ${now}\n\n` +
              `Password WiFi Anda sudah diperbarui menjadi:\n` +
              `\ud83d\udd10 *${password}*\n\n` +
              `Silakan gunakan password baru untuk terhubung.\n` +
              `\u26a0\ufe0f Jangan bagikan password ini ke orang lain.`;
            await sendWA(cust.phone, msg);
          }
        }
      }
    } catch (e) { /* ignore WA notification errors */ }
  }
  res.json({ success: ok });
});

router.post('/api/device/:tag/reboot', requireTechSession, async (req, res) => {
  const result = await customerDevice.requestReboot(req.params.tag);
  res.json(result);
});

// ─── ATTENDANCE ROUTES ───────────────────────────────────────────────────────

// Get attendance page
router.get('/attendance', requireTechSession, (req, res) => {
  const techId = req.session.techId;
  const todayAttendance = attendanceSvc.getTodayAttendance('technician', techId);
  const history = attendanceSvc.getAttendanceHistory('technician', techId, 10);
  
  // Get monthly summary
  const now = new Date();
  const summary = attendanceSvc.getMonthlyAttendanceSummary(
    'technician',
    techId,
    now.getFullYear(),
    now.getMonth() + 1
  );
  
  res.render('tech/attendance', {
    title: 'Absensi',
    company: company(),
    activePage: 'attendance',
    techName: req.session.techName,
    todayAttendance,
    history,
    summary,
    msg: flashMsg(req)
  });
});

// Check-in
router.post('/attendance/checkin', requireTechSession, uploadAttendance.single('photo'), (req, res) => {
  try {
    const techId = req.session.techId;
    const techName = req.session.techName;

    if (!req.file) {
      return res.json({ success: false, message: 'Foto check-in wajib diunggah' });
    }
    
    // Check if already checked in today
    const today = attendanceSvc.getTodayAttendance('technician', techId);
    if (today) {
      removeAttendanceFile(req.file);
      return res.json({ success: false, message: 'Anda sudah melakukan check-in hari ini' });
    }
    
    // Prepare photo path
    let photoPath = '';
    if (req.file) {
      photoPath = '/uploads/attendance/' + req.file.filename;
    }
    
    const result = attendanceSvc.checkIn({
      employee_type: 'technician',
      employee_id: techId,
      employee_name: techName,
      lat: req.body.lat || '',
      lng: req.body.lng || '',
      note: req.body.note || '',
      photo: photoPath
    });
    
    res.json({ success: true, message: 'Check-in berhasil!', id: result.lastInsertRowid });
  } catch (e) {
    removeAttendanceFile(req.file);
    res.json({ success: false, message: 'Gagal check-in: ' + e.message });
  }
});

// Check-out
router.post('/attendance/checkout', requireTechSession, uploadAttendance.single('photo'), (req, res) => {
  try {
    const techId = req.session.techId;

    if (!req.file) {
      return res.json({ success: false, message: 'Foto check-out wajib diunggah' });
    }
    
    // Get today's attendance
    const today = attendanceSvc.getTodayAttendance('technician', techId);
    if (!today) {
      removeAttendanceFile(req.file);
      return res.json({ success: false, message: 'Anda belum check-in hari ini' });
    }
    
    if (today.status === 'checked_out') {
      removeAttendanceFile(req.file);
      return res.json({ success: false, message: 'Anda sudah check-out hari ini' });
    }
    
    // Prepare photo path
    let photoPath = '';
    if (req.file) {
      photoPath = '/uploads/attendance/' + req.file.filename;
    }
    
    attendanceSvc.checkOut(today.id, {
      lat: req.body.lat || '',
      lng: req.body.lng || '',
      note: req.body.note || '',
      photo: photoPath
    });
    
    res.json({ success: true, message: 'Check-out berhasil!' });
  } catch (e) {
    removeAttendanceFile(req.file);
    res.json({ success: false, message: 'Gagal check-out: ' + e.message });
  }
});

// Get attendance history (API)
router.get('/api/attendance/history', requireTechSession, (req, res) => {
  try {
    const techId = req.session.techId;
    const limit = req.query.limit ? parseInt(req.query.limit) : 30;
    const history = attendanceSvc.getAttendanceHistory('technician', techId, limit);
    res.json({ success: true, data: history });
  } catch (e) {
    res.json({ success: false, message: e.message });
  }
});

module.exports = router;
