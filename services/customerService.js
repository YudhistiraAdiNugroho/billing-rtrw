/**
 * Service: CRUD Pelanggan & Paket
 */
const db = require('../config/database');
const { logger } = require('../config/logger');
const { getCurrentDateInTimezone, getSetting } = require('../config/settingsManager');

// ─── HELPER FUNCTIONS ─────────────────────────────────────────
/**
 * Get effective router_id for a customer
 * Respects multi-router mode setting:
 * - If mode is 'active': returns customer's router_id (could be NULL)
 * - If mode is 'disabled': returns customer's router_id if set, else auto-detect
 *   - First tries explicit default_router_id setting
 *   - If not set, auto-detects first (smallest ID) available router
 */
function getEffectiveRouterId(customerRouterId) {
  const mode = getSetting('multi_router_mode', 'active');
  
  // Mode: active (multi-router) - return as-is
  if (mode === 'active') {
    return customerRouterId || null;
  }
  
  // Mode: disabled (single router with fallback) - use explicit default or auto-detect
  if (mode === 'disabled') {
    if (customerRouterId && customerRouterId > 0) {
      // Customer has explicit router assignment - use it
      return customerRouterId;
    }
    
    // Try explicit default_router_id setting first
    const explicitDefault = getSetting('default_router_id', null);
    if (explicitDefault) {
      const parsed = parseInt(explicitDefault);
      if (parsed && parsed > 0) {
        return parsed;
      }
    }
    
    // Auto-detect: find first (smallest ID) router that exists
    try {
      const routers = db.prepare('SELECT id FROM routers WHERE is_active = 1 ORDER BY id ASC LIMIT 1').get();
      if (routers && routers.id > 0) {
        return routers.id;
      }
    } catch (e) {
      // Ignore if routers table doesn't exist or query fails
    }
  }
  
  return null;
}

// ─── CUSTOMERS ───────────────────────────────────────────────
function getAllCustomers(search = '') {
  const now = getCurrentDateInTimezone();
  const month = now.getMonth() + 1;
  const year = now.getFullYear();

  const base = `
    SELECT c.*, p.name as package_name, p.price as package_price,
           p.promo_cycles as package_promo_cycles,
           p.prorate_first_invoice as package_prorate_first_invoice,
           p.speed_down, p.speed_up, p.fup_limit_gb, p.use_fup,
           r.name as router_name,
           o.name as olt_name,
           odp.name as odp_name,
           (SELECT COUNT(*) FROM invoices WHERE customer_id=c.id AND status='unpaid') as unpaid_count,
           u.bytes_in, u.bytes_out
    FROM customers c
    LEFT JOIN packages p ON c.package_id = p.id
    LEFT JOIN routers r ON c.router_id = r.id
    LEFT JOIN olts o ON c.olt_id = o.id
    LEFT JOIN odps odp ON c.odp_id = odp.id
    LEFT JOIN customer_usage u ON u.customer_id = c.id AND u.period_month = ${month} AND u.period_year = ${year}
  `;
  if (search) {
    const s = `%${search}%`;
    return db.prepare(base + ` WHERE c.name LIKE ? OR c.phone LIKE ? OR c.genieacs_tag LIKE ? OR c.address LIKE ? ORDER BY c.name ASC`).all(s, s, s, s);
  }
  return db.prepare(base + ` ORDER BY c.name ASC`).all();
}

function resetPromoCyclesUsed(customerId) {
  const id = Number(customerId);
  if (!Number.isFinite(id) || id <= 0) throw new Error('ID pelanggan tidak valid');
  return db.prepare('UPDATE customers SET promo_cycles_used = 0 WHERE id=?').run(id);
}

function getCustomerById(id) {
  return db.prepare(`
    SELECT c.*, p.name as package_name, p.price as package_price,
           p.promo_cycles as package_promo_cycles,
           p.prorate_first_invoice as package_prorate_first_invoice,
           r.name as router_name, o.name as olt_name, odp.name as odp_name
    FROM customers c 
    LEFT JOIN packages p ON c.package_id = p.id 
    LEFT JOIN routers r ON c.router_id = r.id
    LEFT JOIN olts o ON c.olt_id = o.id
    LEFT JOIN odps odp ON c.odp_id = odp.id
    WHERE c.id = ?
  `).get(id);
}

function createCustomer(data) {
  return db.prepare(`
    INSERT INTO customers (name, phone, email, address, package_id, router_id, olt_id, odp_id, pon_port, lat, lng, genieacs_tag, pppoe_username, pppoe_password, pppoe_remote_address, isolir_profile, status, install_date, notes, auto_isolate, isolate_day, connection_type, static_ip, mac_address, hotspot_username, hotspot_password, hotspot_profile, collector_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    data.name, data.phone || '', data.email || '', data.address || '',
    data.package_id ? parseInt(data.package_id) : null,
    data.router_id ? parseInt(data.router_id) : null,
    data.olt_id ? parseInt(data.olt_id) : null,
    data.odp_id ? parseInt(data.odp_id) : null,
    data.pon_port || '',
    data.lat || '',
    data.lng || '',
    data.genieacs_tag || '', data.pppoe_username || '',
    data.pppoe_password || '',
    data.pppoe_remote_address || '',
    data.isolir_profile || 'isolir',
    data.status || 'active',
    data.install_date || null, data.notes || '',
    data.auto_isolate !== undefined ? parseInt(data.auto_isolate) : 1,
    data.isolate_day !== undefined ? parseInt(data.isolate_day) : 10,
    data.connection_type || 'pppoe',
    data.static_ip || '',
    data.mac_address || '',
    data.hotspot_username || '',
    data.hotspot_password || '',
    data.hotspot_profile || '',
    data.collector_id ? parseInt(data.collector_id) : null
  );
}

function updateCustomer(id, data) {
  const prev = db.prepare('SELECT package_id FROM customers WHERE id=?').get(id);
  const newPkgId = data.package_id ? parseInt(data.package_id, 10) : null;
  const pkgChanged = prev && Number(prev.package_id || 0) !== Number(newPkgId || 0);

  const result = db.prepare(`
    UPDATE customers SET name=?, phone=?, email=?, address=?, package_id=?, router_id=?, olt_id=?, odp_id=?, pon_port=?, lat=?, lng=?, genieacs_tag=?, pppoe_username=?, pppoe_password=?, pppoe_remote_address=?, isolir_profile=?, status=?, install_date=?, notes=?, auto_isolate=?, isolate_day=?, cable_path=?, connection_type=?, static_ip=?, mac_address=?, hotspot_username=?, hotspot_password=?, hotspot_profile=?, collector_id=?
    WHERE id=?
  `).run(
    data.name, data.phone || '', data.email || '', data.address || '',
    data.package_id ? parseInt(data.package_id) : null,
    data.router_id ? parseInt(data.router_id) : null,
    data.olt_id ? parseInt(data.olt_id) : null,
    data.odp_id ? parseInt(data.odp_id) : null,
    data.pon_port || '',
    data.lat || '',
    data.lng || '',
    data.genieacs_tag || '', data.pppoe_username || '',
    data.pppoe_password || '',
    data.pppoe_remote_address || '',
    data.isolir_profile || 'isolir',
    data.status || 'active',
    data.install_date || null, data.notes || '',
    data.auto_isolate !== undefined ? parseInt(data.auto_isolate) : 1,
    data.isolate_day !== undefined ? parseInt(data.isolate_day) : 10,
    data.cable_path || null,
    data.connection_type || 'pppoe',
    data.static_ip || '',
    data.mac_address || '',
    data.hotspot_username || '',
    data.hotspot_password || '',
    data.hotspot_profile || '',
    data.collector_id ? parseInt(data.collector_id) : null,
    id
  );

  if (pkgChanged) {
    db.prepare('UPDATE customers SET promo_cycles_used = 0 WHERE id=?').run(id);
  }

  return result;
}

function updateCustomerCablePath(id, path) {
  return db.prepare('UPDATE customers SET cable_path = ? WHERE id = ?').run(path, id);
}

async function deleteCustomer(id) {
  const customer = getCustomerById(id);
  const mikrotikSvc = require('./mikrotikService');
  
  // WARNING: Check if customer has MikroTik connections without router_id
  const hasMikrotikConnection = customer && (
    customer.connection_type === 'pppoe' && customer.pppoe_username
    || customer.connection_type === 'static' && customer.static_ip
    || customer.connection_type === 'hotspot' && customer.hotspot_username
  );
  
  if (hasMikrotikConnection && !customer.router_id) {
    logger.warn(`[deleteCustomer] Pelanggan "${customer.name}" (ID: ${id}) memiliki koneksi ${customer.connection_type} tapi router_id NULL. Akun tidak akan dihapus dari MikroTik.`);
  }
  
  // Remove static IP if connection type is static
  if (customer && customer.connection_type === 'static' && customer.static_ip && customer.router_id) {
    try {
      await mikrotikSvc.removeStaticIp(customer.static_ip, customer.router_id);
    } catch (e) {
      console.error('Failed to remove static IP from MikroTik during customer deletion:', e);
    }
  }
  
  // Remove PPPoE secret if connection type is pppoe and username exists
  if (customer && customer.connection_type === 'pppoe' && customer.pppoe_username && customer.router_id) {
    try {
      console.log(`[DELETE] Attempting to remove PPPoE secret: ${customer.pppoe_username} from router ${customer.router_id}`);
      
      // Get PPPoE secrets to find the ID
      const secrets = await mikrotikSvc.getPppoeSecrets(customer.router_id);
      console.log(`[DELETE] Found ${secrets.length} PPPoE secrets in MikroTik`);
      
      // Try to find by exact name match
      let secret = secrets.find(s => s.name === customer.pppoe_username);
      
      // If not found, try case-insensitive match
      if (!secret) {
        const username = String(customer.pppoe_username || '').toLowerCase();
        secret = secrets.find(s => String(s.name || '').toLowerCase() === username);
      }
      
      if (secret) {
        // Check both .id and id fields
        const secretId = secret['.id'] || secret.id;
        console.log(`[DELETE] Found secret with ID: ${secretId}, name: ${secret.name}`);
        
        if (secretId) {
          await mikrotikSvc.deletePppoeSecret(secretId, customer.router_id);
          console.log(`[DELETE] Successfully removed PPPoE secret for ${customer.pppoe_username} from MikroTik`);
        } else {
          console.warn(`[DELETE] Secret found but no ID available for ${customer.pppoe_username}`);
        }
      } else {
        console.warn(`[DELETE] PPPoE secret for ${customer.pppoe_username} not found in MikroTik`);
        console.log(`[DELETE] Available usernames: ${secrets.map(s => s.name).join(', ')}`);
      }
    } catch (e) {
      console.error('[DELETE] Failed to remove PPPoE secret from MikroTik during customer deletion:', e);
    }
  }
  
  // Remove Hotspot user if connection type is hotspot and username exists
  if (customer && customer.connection_type === 'hotspot' && customer.hotspot_username && customer.router_id) {
    try {
      // Get hotspot user to find the ID
      const hotspotUser = await mikrotikSvc.getHotspotUserByName(customer.hotspot_username, customer.router_id);
      
      if (hotspotUser && hotspotUser.id) {
        await mikrotikSvc.deleteHotspotUser(hotspotUser.id, customer.router_id);
        console.log(`Successfully removed Hotspot user ${customer.hotspot_username} from MikroTik`);
      } else {
        console.warn(`Hotspot user ${customer.hotspot_username} not found in MikroTik`);
      }
    } catch (e) {
      console.error('Failed to remove Hotspot user from MikroTik during customer deletion:', e);
    }
  }
  
  return db.prepare('DELETE FROM customers WHERE id=?').run(id);
}

function getCustomerStats() {
  return {
    total:     db.prepare('SELECT COUNT(*) as c FROM customers').get().c,
    active:    db.prepare("SELECT COUNT(*) as c FROM customers WHERE status='active'").get().c,
    suspended: db.prepare("SELECT COUNT(*) as c FROM customers WHERE status='suspended'").get().c,
    inactive:  db.prepare("SELECT COUNT(*) as c FROM customers WHERE status='inactive'").get().c,
  };
}

// ─── PACKAGES ────────────────────────────────────────────────
function getAllPackages() {
  return db.prepare(`
    SELECT p.*, COUNT(c.id) as customer_count
    FROM packages p LEFT JOIN customers c ON c.package_id = p.id
    GROUP BY p.id ORDER BY p.price ASC
  `).all();
}

function getPackageById(id) {
  return db.prepare('SELECT * FROM packages WHERE id=?').get(id);
}

function createPackage(data) {
  const down = Math.round(parseFloat(data.speed_down || 0) * 1000);
  const up = Math.round(parseFloat(data.speed_up || 0) * 1000);
  const n_down = Math.round(parseFloat(data.night_speed_down || 0) * 1000);
  const n_up = Math.round(parseFloat(data.night_speed_up || 0) * 1000);
  const f_down = Math.round(parseFloat(data.fup_speed_down || 0) * 1000);
  const f_limit = parseFloat(data.fup_limit_gb || 0);

  const promoPrice = parsePromoPrice(data.promo_price);
  const promoCycles = Math.max(0, parseInt(data.promo_cycles, 10) || 0);
  const prorateFirst = data.prorate_first_invoice ? 1 : 0;
  const usePpn = data.use_ppn ? 1 : 0;
  const ppnPercentage = parseFloat(data.ppn_percentage || 11.0);
  const useUso = data.use_uso ? 1 : 0;
  const usoPercentage = parseFloat(data.uso_percentage || 1.75);

  return db.prepare(`
    INSERT INTO packages (
      name, price, promo_price, promo_cycles, prorate_first_invoice,
      speed_down, speed_up, 
      use_night_speed, night_profile_name, night_speed_down, night_speed_up, 
      use_fup, fup_profile_name, fup_limit_gb, fup_speed_down, 
      description,
      use_ppn, ppn_percentage, use_uso, uso_percentage
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    data.name, parseInt(data.price) || 0, promoPrice, promoCycles, prorateFirst,
    down, up,
    data.use_night_speed ? 1 : 0, data.night_profile_name || null, n_down, n_up,
    data.use_fup ? 1 : 0, data.fup_profile_name || null, f_limit, f_down,
    data.description || '',
    usePpn, ppnPercentage, useUso, usoPercentage
  );
}

function parsePromoPrice(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return null;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function updatePackage(id, data) {
  const down = Math.round(parseFloat(data.speed_down || 0) * 1000);
  const up = Math.round(parseFloat(data.speed_up || 0) * 1000);
  const n_down = Math.round(parseFloat(data.night_speed_down || 0) * 1000);
  const n_up = Math.round(parseFloat(data.night_speed_up || 0) * 1000);
  const f_down = Math.round(parseFloat(data.fup_speed_down || 0) * 1000);
  const f_limit = parseFloat(data.fup_limit_gb || 0);
  const promoPrice = parsePromoPrice(data.promo_price);
  const promoCycles = Math.max(0, parseInt(data.promo_cycles, 10) || 0);
  const prorateFirst = data.prorate_first_invoice ? 1 : 0;
  const usePpn = data.use_ppn ? 1 : 0;
  const ppnPercentage = parseFloat(data.ppn_percentage || 11.0);
  const useUso = data.use_uso ? 1 : 0;
  const usoPercentage = parseFloat(data.uso_percentage || 1.75);

  return db.prepare(`
    UPDATE packages 
    SET name=?, price=?, promo_price=?, promo_cycles=?, prorate_first_invoice=?,
        speed_down=?, speed_up=?, 
        use_night_speed=?, night_profile_name=?, night_speed_down=?, night_speed_up=?, 
        use_fup=?, fup_profile_name=?, fup_limit_gb=?, fup_speed_down=?, 
        description=?, is_active=?,
        use_ppn=?, ppn_percentage=?, use_uso=?, uso_percentage=?
    WHERE id=?
  `).run(
    data.name, parseInt(data.price) || 0, promoPrice, promoCycles, prorateFirst,
    down, up,
    data.use_night_speed ? 1 : 0, data.night_profile_name || null, n_down, n_up,
    data.use_fup ? 1 : 0, data.fup_profile_name || null, f_limit, f_down,
    data.description || '', data.is_active == '1' ? 1 : 0,
    usePpn, ppnPercentage, useUso, usoPercentage,
    id
  );
}

function deletePackage(id) {
  return db.prepare('DELETE FROM packages WHERE id=?').run(id);
}

function findCustomerByAny(val) {
  if (!val) return null;
  const cleanVal = val.toString().trim();
  
  // 1. Try Phone (Priority for Login)
  const phoneDigits = cleanVal.replace(/\D/g, '');
  if (phoneDigits.length >= 8) {
    // Cari yang 8-10 digit terakhirnya sama (lebih akurat untuk 08 vs 62)
    const suffix = phoneDigits.slice(-9);
    const p1 = db.prepare('SELECT id FROM customers WHERE phone LIKE ?').get(`%${suffix}`);
    if (p1) return getCustomerById(p1.id);
  }

  // 2. Try GenieACS Tag (Exact Match)
  const byTag = db.prepare('SELECT id FROM customers WHERE genieacs_tag = ?').get(cleanVal);
  if (byTag) return getCustomerById(byTag.id);

  // 3. Try PPPoE Username (Exact Match)
  const byPppoe = db.prepare('SELECT id FROM customers WHERE pppoe_username = ?').get(cleanVal);
  if (byPppoe) return getCustomerById(byPppoe.id);

  // 4. Try MAC Address (Exact Match or Partial Match for ONU MAC format)
  // Handle ONU MAC format like: F4B5AA-ZXHN%20F477-01FFFFFFFF011FFF23F4B5AA7D806FBA
  const byMac = db.prepare('SELECT id FROM customers WHERE mac_address = ?').get(cleanVal);
  if (byMac) return getCustomerById(byMac.id);
  
  // Try partial MAC match (first part before dash for ONU format)
  if (cleanVal.includes('-')) {
    const macPrefix = cleanVal.split('-')[0];
    if (macPrefix.length >= 6) {
      const byMacPrefix = db.prepare('SELECT id FROM customers WHERE mac_address LIKE ?').get(`${macPrefix}%`);
      if (byMacPrefix) return getCustomerById(byMacPrefix.id);
    }
  }

  // 5. Try ID if numeric
  if (/^\d+$/.test(cleanVal) && cleanVal.length < 8) {
    const c = getCustomerById(parseInt(cleanVal));
    if (c) return c;
  }
  
  return null;
}

async function suspendCustomer(id) {
  const customer = getCustomerById(id);
  if (!customer) throw new Error('Pelanggan tidak ditemukan');
  
  const mikrotikSvc = require('./mikrotikService');

  // Get effective router_id (respects multi-router mode setting)
  const effectiveRouterId = getEffectiveRouterId(customer.router_id);

  // Validate router_id is present if customer has MikroTik connection
  const hasMikrotikConnection = customer.connection_type === 'pppoe' && customer.pppoe_username
    || customer.connection_type === 'static' && customer.static_ip
    || customer.connection_type === 'hotspot' && customer.hotspot_username;
  
  if (hasMikrotikConnection && !effectiveRouterId) {
    logger.warn(`[suspendCustomer] Pelanggan "${customer.name}" (ID: ${id}) memiliki koneksi ${customer.connection_type} tapi router_id NULL dan tidak ada default router. Isolir lokal hanya, MikroTik tidak diupdate.`);
    updateCustomer(id, { ...customer, status: 'suspended' });
    return;
  }

  // UPDATE MIKROTIK DULU sebelum update database status (priority: network change)
  try {
    if (customer.connection_type === 'static' && customer.static_ip) {
      const pkg = getPackageById(customer.package_id);
      let limit = '5M/5M';
      if (pkg) {
        const up = Number(pkg.speed_up || 0) || 0;
        const down = Number(pkg.speed_down || 0) || 0;
        const upMbps = up > 0 ? Math.max(1, Math.round(up / 1000)) : 5;
        const downMbps = down > 0 ? Math.max(1, Math.round(down / 1000)) : 5;
        limit = `${upMbps}M/${downMbps}M`;
      }
      await mikrotikSvc.manageStaticIp({
        ip: customer.static_ip,
        name: customer.name,
        limit: limit,
        isolate: true
      }, effectiveRouterId);
    } else if (customer.pppoe_username) {
      const isolirProfile = customer.isolir_profile || 'isolir';
      await mikrotikSvc.setPppoeProfile(customer.pppoe_username, isolirProfile, effectiveRouterId);
      if (effectiveRouterId) {
        try {
          await mikrotikSvc.ensurePppProfileIsolirAddressListHook(isolirProfile, effectiveRouterId);
        } catch (e) {
          logger.warn(`[suspendCustomer] Hook profil isolir "${isolirProfile}" di router ${effectiveRouterId}: ${e.message}`);
        }
      }
    } else if (customer.connection_type === 'hotspot' && customer.hotspot_username) {
      await mikrotikSvc.setHotspotUserDisabled(customer.hotspot_username, true, effectiveRouterId);
    }
  } catch (mikrotikErr) {
    logger.error(`[suspendCustomer] GAGAL ubah profil di MikroTik: ${mikrotikErr.message}. Tetap update status ke database.`);
    // Continue execution - update database status despite MikroTik error (graceful degradation)
  }

  // Update database status SETELAH MikroTik berhasil (atau gagal tapi continue)
  updateCustomer(id, { ...customer, status: 'suspended' });

  // WhatsApp Notification
  if (customer.phone) {
    try {
      const { getSetting } = require('../config/settingsManager');
      if (getSetting('whatsapp_enabled', false)) {
        const { sendWA, whatsappStatus } = await import('./whatsappBot.mjs');
        if (whatsappStatus && whatsappStatus.connection === 'open') {
          const defaultIsolir = `Yth. Pelanggan {{nama}},\n\nLayanan internet Anda (Paket {{paket}}) saat ini ditangguhkan (Terisolir) karena belum melunasi tagihan sebesar *Rp {{tagihan}}*.\n\nSilakan lakukan pembayaran segera melalui portal pelanggan: {{link}}\n\nTerima kasih.`;
          const template = db.getAppSetting('whatsapp_isolir_message', defaultIsolir);

          // Get unpaid invoices & calculate total amount
          const billingSvc = require('./billingService');
          const unpaidInvoices = billingSvc.getUnpaidInvoicesByCustomerId(customer.id);
          const totalTagihan = unpaidInvoices.reduce((sum, inv) => sum + (Number(inv.amount) || 0), 0);

          // Generate Login Link
          const explicitBaseUrl = String(getSetting('public_base_url', '') || '').trim();
          let baseUrl = explicitBaseUrl.replace(/\/+$/, '');
          if (!baseUrl) {
            const hostRaw = String(getSetting('server_host', 'localhost') || 'localhost').trim();
            const port = Number(getSetting('server_port', 3001) || 3001);
            const proto = port === 443 ? 'https' : 'http';
            const host = /^https?:\/\//i.test(hostRaw) ? hostRaw.replace(/\/+$/, '') : `${proto}://${hostRaw}`;
            baseUrl = (port === 80 || port === 443) ? host : `${host}:${port}`;
          }
          const loginLink = `${baseUrl}/customer/login`;

          const formattedMsg = template
            .replace(/{{nama}}/gi, customer.name || 'Pelanggan')
            .replace(/{{paket}}/gi, customer.package_name || '-')
            .replace(/{{tagihan}}/gi, totalTagihan.toLocaleString('id-ID'))
            .replace(/{{link}}/gi, loginLink);

          await sendWA(customer.phone, formattedMsg);
        }
      }
    } catch (waErr) {
      logger.error(`[suspendCustomer] Gagal kirim notif WhatsApp isolir: ${waErr.message}`);
    }
  }

  return true;
}

async function activateCustomer(id) {
  const customer = getCustomerById(id);
  if (!customer) throw new Error('Pelanggan tidak ditemukan');
  
  // Get effective router_id (respects multi-router mode setting)
  const effectiveRouterId = getEffectiveRouterId(customer.router_id);

  // Validate router_id is present if customer has MikroTik connection
  const hasMikrotikConnection = customer.connection_type === 'pppoe' && customer.pppoe_username
    || customer.connection_type === 'static' && customer.static_ip
    || customer.connection_type === 'hotspot' && customer.hotspot_username;
  
  if (hasMikrotikConnection && !effectiveRouterId) {
    logger.warn(`[activateCustomer] Pelanggan "${customer.name}" (ID: ${id}) memiliki koneksi ${customer.connection_type} tapi router_id NULL dan tidak ada default router. Aktivasi lokal hanya, MikroTik tidak diupdate.`);
    updateCustomer(id, { ...customer, status: 'active' });
    return;
  }

  const mikrotikSvc = require('./mikrotikService');

  // UPDATE MIKROTIK DULU sebelum update database status (priority: network change)
  try {
    if (customer.connection_type === 'static' && customer.static_ip) {
      const pkg = getPackageById(customer.package_id);
      let limit = '5M/5M';
      if (pkg) {
        const up = Number(pkg.speed_up || 0) || 0;
        const down = Number(pkg.speed_down || 0) || 0;
        const upMbps = up > 0 ? Math.max(1, Math.round(up / 1000)) : 5;
        const downMbps = down > 0 ? Math.max(1, Math.round(down / 1000)) : 5;
        limit = `${upMbps}M/${downMbps}M`;
      }
      await mikrotikSvc.manageStaticIp({
        ip: customer.static_ip,
        name: customer.name,
        limit: limit,
        isolate: false
      }, effectiveRouterId);
    } else if (customer.pppoe_username) {
      const pkg = getPackageById(customer.package_id);
      const targetProfile = pkg ? pkg.name : 'default';
      
      // Validasi profile tidak kosong
      if (!targetProfile || String(targetProfile).trim() === '') {
        logger.warn(`[activateCustomer] Profile kosong untuk PPPoE user "${customer.pppoe_username}". Gunakan profile 'default'.`);
      }
      
      await mikrotikSvc.setPppoeProfile(customer.pppoe_username, targetProfile, effectiveRouterId);
    } else if (customer.connection_type === 'hotspot' && customer.hotspot_username) {
      const pkg = getPackageById(customer.package_id);
      const targetProfile = String(customer.hotspot_profile || '').trim() || (pkg ? pkg.name : '');
      await mikrotikSvc.upsertHotspotUser({
        username: String(customer.hotspot_username || '').trim(),
        password: String(customer.hotspot_password || '').trim(),
        profile: targetProfile,
        macAddress: String(customer.mac_address || '').trim(),
        disabled: false
      }, effectiveRouterId);
    }
  } catch (mikrotikErr) {
    logger.error(`[activateCustomer] GAGAL ubah profil di MikroTik: ${mikrotikErr.message}. Tetap update status ke database.`);
    // Continue execution - update database status despite MikroTik error (graceful degradation)
  }

  // Update database status SETELAH MikroTik berhasil (atau gagal tapi continue)
  updateCustomer(id, { ...customer, status: 'active' });
  return true;
}

module.exports = {
  getAllCustomers, getCustomerById, createCustomer, updateCustomer, deleteCustomer, getCustomerStats,
  getAllPackages, getPackageById, createPackage, updatePackage, deletePackage,
  suspendCustomer, activateCustomer, findCustomerByAny, updateCustomerCablePath,
  resetPromoCyclesUsed, getEffectiveRouterId
};
