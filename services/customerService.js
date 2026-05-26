/**
 * Service: CRUD Pelanggan & Paket
 */
const db = require('../config/database');
const { logger } = require('../config/logger');
const { getCurrentDateInTimezone } = require('../config/settingsManager');

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
  
  // Remove static IP if connection type is static
  if (customer && customer.connection_type === 'static' && customer.static_ip) {
    try {
      await mikrotikSvc.removeStaticIp(customer.static_ip, customer.router_id);
    } catch (e) {
      console.error('Failed to remove static IP from MikroTik during customer deletion:', e);
    }
  }
  
  // Remove PPPoE secret if connection type is pppoe and username exists
  if (customer && customer.connection_type === 'pppoe' && customer.pppoe_username) {
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
  if (customer && customer.connection_type === 'hotspot' && customer.hotspot_username) {
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

  return db.prepare(`
    INSERT INTO packages (
      name, price, promo_price, promo_cycles, prorate_first_invoice,
      speed_down, speed_up, 
      use_night_speed, night_profile_name, night_speed_down, night_speed_up, 
      use_fup, fup_profile_name, fup_limit_gb, fup_speed_down, 
      description
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    data.name, parseInt(data.price) || 0, promoPrice, promoCycles, prorateFirst,
    down, up,
    data.use_night_speed ? 1 : 0, data.night_profile_name || null, n_down, n_up,
    data.use_fup ? 1 : 0, data.fup_profile_name || null, f_limit, f_down,
    data.description || ''
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

  return db.prepare(`
    UPDATE packages 
    SET name=?, price=?, promo_price=?, promo_cycles=?, prorate_first_invoice=?,
        speed_down=?, speed_up=?, 
        use_night_speed=?, night_profile_name=?, night_speed_down=?, night_speed_up=?, 
        use_fup=?, fup_profile_name=?, fup_limit_gb=?, fup_speed_down=?, 
        description=?, is_active=? 
    WHERE id=?
  `).run(
    data.name, parseInt(data.price) || 0, promoPrice, promoCycles, prorateFirst,
    down, up,
    data.use_night_speed ? 1 : 0, data.night_profile_name || null, n_down, n_up,
    data.use_fup ? 1 : 0, data.fup_profile_name || null, f_limit, f_down,
    data.description || '', data.is_active == '1' ? 1 : 0, id
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
  
  updateCustomer(id, { ...customer, status: 'suspended' });
  const mikrotikSvc = require('./mikrotikService');

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
    }, customer.router_id);
  } else if (customer.pppoe_username) {
    const isolirProfile = customer.isolir_profile || 'isolir';
    await mikrotikSvc.setPppoeProfile(customer.pppoe_username, isolirProfile, customer.router_id);
    if (customer.router_id) {
      try {
        await mikrotikSvc.ensurePppProfileIsolirAddressListHook(isolirProfile, customer.router_id);
      } catch (e) {
        logger.warn(`[suspendCustomer] Hook profil isolir "${isolirProfile}" di router ${customer.router_id}: ${e.message}`);
      }
    }
  } else if (customer.connection_type === 'hotspot' && customer.hotspot_username) {
    await mikrotikSvc.setHotspotUserDisabled(customer.hotspot_username, true, customer.router_id);
  }
  return true;
}

async function activateCustomer(id) {
  const customer = getCustomerById(id);
  if (!customer) throw new Error('Pelanggan tidak ditemukan');
  
  updateCustomer(id, { ...customer, status: 'active' });
  const mikrotikSvc = require('./mikrotikService');

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
    }, customer.router_id);
  } else if (customer.pppoe_username) {
    const pkg = getPackageById(customer.package_id);
    const targetProfile = pkg ? pkg.name : 'default';
    await mikrotikSvc.setPppoeProfile(customer.pppoe_username, targetProfile, customer.router_id);
  } else if (customer.connection_type === 'hotspot' && customer.hotspot_username) {
    const pkg = getPackageById(customer.package_id);
    const targetProfile = String(customer.hotspot_profile || '').trim() || (pkg ? pkg.name : '');
    await mikrotikSvc.upsertHotspotUser({
      username: String(customer.hotspot_username || '').trim(),
      password: String(customer.hotspot_password || '').trim(),
      profile: targetProfile,
      macAddress: String(customer.mac_address || '').trim(),
      disabled: false
    }, customer.router_id);
  }
  return true;
}

module.exports = {
  getAllCustomers, getCustomerById, createCustomer, updateCustomer, deleteCustomer, getCustomerStats,
  getAllPackages, getPackageById, createPackage, updatePackage, deletePackage,
  suspendCustomer, activateCustomer, findCustomerByAny, updateCustomerCablePath,
  resetPromoCyclesUsed
};
