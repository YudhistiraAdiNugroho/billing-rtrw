/**
 * Service RADIUS Server (Authentication & Accounting UDP Service)
 * Menggunakan SQLite database billing.db & modul radiusPacket
 */
const dgram = require('dgram');
const db = require('../config/database');
const { getSetting } = require('../config/settingsManager');
const { logger } = require('../config/logger');
const {
  CODES,
  ATTR_TYPES,
  MIKROTIK_VENDOR_ID,
  MIKROTIK_VSAS,
  decodePacket,
  encodeResponsePacket
} = require('../utils/radiusPacket');

let authSocket = null;
let acctSocket = null;
let isRunning = false;

/**
 * Mencari Secret NAS berdasarkan IP NAS
 */
function getNasSecret(nasIp) {
  const defaultSecret = getSetting('radius_secret', 'secret123');
  try {
    const nasRow = db.prepare(`
      SELECT secret FROM radius_nas
      WHERE is_active = 1 AND (nasname = ? OR nasname = '0.0.0.0' OR nasname = '0.0.0.0/0')
      ORDER BY id DESC LIMIT 1
    `).get(nasIp);

    if (nasRow && nasRow.secret) {
      return nasRow.secret;
    }
  } catch (err) {
    logger.error(`[RADIUS] Error getNasSecret: ${err.message}`);
  }
  return defaultSecret;
}

/**
 * Mencari data pelanggan / pengguna dari SQLite DB
 */
function findUserCredentials(username) {
  const cleanUsername = String(username || '').trim();
  if (!cleanUsername) return null;

  // 1. Cek tabel customers (pppoe_username atau name atau phone)
  try {
    const cust = db.prepare(`
      SELECT c.id, c.name, c.pppoe_username, c.status, c.static_ip, c.package_id,
             p.name as package_name, p.speed_up, p.speed_down
      FROM customers c
      LEFT JOIN packages p ON p.id = c.package_id
      WHERE c.pppoe_username = ? OR c.name = ? OR c.phone = ?
      LIMIT 1
    `).get(cleanUsername, cleanUsername, cleanUsername);

    if (cust) {
      let secret = '';
      try {
        const pppoeUser = db.prepare(`SELECT secret FROM pppoe_users WHERE username = ? LIMIT 1`).get(cleanUsername);
        if (pppoeUser) secret = pppoeUser.secret;
      } catch (e) {}

      return {
        type: 'customer',
        id: cust.id,
        username: cleanUsername,
        secret: secret,
        status: cust.status,
        staticIp: cust.static_ip,
        speedUp: cust.speed_up || 0,
        speedDown: cust.speed_down || 0,
        packageName: cust.package_name || ''
      };
    }
  } catch (err) {
    logger.error(`[RADIUS] Error findUserCredentials customers: ${err.message}`);
  }

  // 2. Cek tabel pppoe_users (jika ada)
  try {
    const pppoe = db.prepare(`
      SELECT pu.id, pu.customer_id, pu.username, pu.secret, pu.status, pu.profile_name,
             c.status as customer_status, c.static_ip,
             p.speed_up, p.speed_down
      FROM pppoe_users pu
      LEFT JOIN customers c ON c.id = pu.customer_id
      LEFT JOIN packages p ON p.id = c.package_id
      WHERE pu.username = ? LIMIT 1
    `).get(cleanUsername);

    if (pppoe) {
      const finalStatus = (pppoe.customer_status === 'suspended' || pppoe.status === 'disabled') ? 'suspended' : 'active';
      return {
        type: 'pppoe',
        id: pppoe.id,
        username: pppoe.username,
        secret: pppoe.secret,
        status: finalStatus,
        staticIp: pppoe.static_ip,
        speedUp: pppoe.speed_up || 0,
        speedDown: pppoe.speed_down || 0,
        packageName: pppoe.profile_name || ''
      };
    }
  } catch (err) {
    // Tabel pppoe_users mungkin tidak ada di skema tertentu
  }

  // 3. Cek tabel vouchers (Voucher Hotspot/PPPoE)
  try {
    const voucher = db.prepare(`
      SELECT code, password, profile_name, status FROM vouchers WHERE code = ? LIMIT 1
    `).get(cleanUsername);

    if (voucher) {
      return {
        type: 'voucher',
        id: voucher.code,
        username: voucher.code,
        secret: voucher.password,
        status: voucher.status === 'used' || voucher.status === 'expired' ? 'suspended' : 'active',
        speedUp: 0,
        speedDown: 0,
        packageName: voucher.profile_name || ''
      };
    }
  } catch (err) {
    logger.error(`[RADIUS] Error findUserCredentials vouchers: ${err.message}`);
  }

  return null;
}

/**
 * Memproses RADIUS Access-Request (Authentication)
 */
function handleAuthMessage(msg, rinfo) {
  const nasIp = rinfo.address;
  const secret = getNasSecret(nasIp);

  let reqPacket;
  try {
    reqPacket = decodePacket(msg, secret);
  } catch (err) {
    logger.warn(`[RADIUS Auth] Gagal decode paket dari ${nasIp}:${rinfo.port} - ${err.message}`);
    return;
  }

  if (reqPacket.code !== CODES.ACCESS_REQUEST) {
    return;
  }

  const username = reqPacket.parsedAttrs.username || '';
  const inputPassword = reqPacket.parsedAttrs.password || '';

  logger.info(`[RADIUS Auth] Request dari NAS ${nasIp} untuk user '${username}'`);

  const user = findUserCredentials(username);
  if (!user) {
    logger.warn(`[RADIUS Auth] Reject '${username}' - User tidak ditemukan`);
    sendAuthResponse(CODES.ACCESS_REJECT, reqPacket, [], secret, rinfo);
    return;
  }

  // Verifikasi Password (jika user.secret diset)
  if (user.secret && user.secret !== inputPassword) {
    logger.warn(`[RADIUS Auth] Reject '${username}' - Password salah`);
    sendAuthResponse(CODES.ACCESS_REJECT, reqPacket, [], secret, rinfo);
    return;
  }

  const isolirAction = getSetting('radius_isolir_action', 'pool');
  const isolirPool = getSetting('radius_isolir_pool', 'isolir');

  // Penanganan Status Terisolir / Non-Aktif
  if (user.status === 'suspended' || user.status === 'isolir' || user.status === 'inactive') {
    if (isolirAction === 'reject') {
      logger.warn(`[RADIUS Auth] Reject '${username}' - Status terisolir`);
      sendAuthResponse(CODES.ACCESS_REJECT, reqPacket, [], secret, rinfo);
      return;
    } else {
      logger.info(`[RADIUS Auth] Accept '${username}' dengan Isolir Pool '${isolirPool}'`);
      const isolirAttrs = [
        { type: ATTR_TYPES.SERVICE_TYPE, value: 2 },
        { type: ATTR_TYPES.FRAMED_PROTOCOL, value: 1 },
        { type: ATTR_TYPES.FRAMED_POOL, value: isolirPool },
        {
          type: ATTR_TYPES.VENDOR_SPECIFIC,
          vendorId: MIKROTIK_VENDOR_ID,
          vendorType: MIKROTIK_VSAS.RATE_LIMIT,
          value: '512k/512k'
        }
      ];
      sendAuthResponse(CODES.ACCESS_ACCEPT, reqPacket, isolirAttrs, secret, rinfo);
      return;
    }
  }

  // 3. Cek Batasan Sesi Login Ganda (Simultaneous-Use / Multi-Login)
  const limitSimultaneous = getSetting('radius_limit_simultaneous', '1') === '1';
  if (limitSimultaneous) {
    const activeSession = db.prepare(`
      SELECT COUNT(1) as c FROM radius_accounting
      WHERE username = ? AND status_type IN (1, 3)
    `).get(username)?.c || 0;

    if (activeSession >= 1) {
      logger.warn(`[RADIUS Auth] Reject '${username}' - Sesi aktif ganda terdeteksi (User sudah online)`);
      sendAuthResponse(CODES.ACCESS_REJECT, reqPacket, [], secret, rinfo);
      return;
    }
  }

  // Status Aktif -> Access-Accept dengan Atribut Kuota/Speed Limit
  const responseAttrs = [
    { type: ATTR_TYPES.SERVICE_TYPE, value: 2 },
    { type: ATTR_TYPES.FRAMED_PROTOCOL, value: 1 }
  ];

  if (user.staticIp) {
    responseAttrs.push({ type: ATTR_TYPES.FRAMED_IP_ADDRESS, value: user.staticIp, isIp: true });
  }

  // Atribut Rate Limit (Mikrotik-Rate-Limit) & Mikrotik-Group (Profile)
  const defaultRateLimit = getSetting('radius_default_rate_limit', '5M/10M');
  if (user.speedDown || user.speedUp) {
    const rateLimitStr = `${user.speedUp}M/${user.speedDown}M`;
    responseAttrs.push({
      type: ATTR_TYPES.VENDOR_SPECIFIC,
      vendorId: MIKROTIK_VENDOR_ID,
      vendorType: MIKROTIK_VSAS.RATE_LIMIT,
      value: rateLimitStr
    });
  } else if (defaultRateLimit) {
    responseAttrs.push({
      type: ATTR_TYPES.VENDOR_SPECIFIC,
      vendorId: MIKROTIK_VENDOR_ID,
      vendorType: MIKROTIK_VSAS.RATE_LIMIT,
      value: defaultRateLimit
    });
  }

  // Kirimkan nama paket / profile ke MikroTik via Mikrotik-Group jika ada
  if (user.packageName) {
    responseAttrs.push({
      type: ATTR_TYPES.VENDOR_SPECIFIC,
      vendorId: MIKROTIK_VENDOR_ID,
      vendorType: MIKROTIK_VSAS.GROUP,
      value: user.packageName
    });
  }

  logger.info(`[RADIUS Auth] Accept '${username}' - Berhasil diautentikasi`);

  // Record instant online session entry upon Access-Accept
  try {
    const authSessionId = reqPacket.parsedAttrs.acctSessionId || `auth-${Date.now()}-${username}`;
    db.prepare(`
      INSERT INTO radius_accounting (
        username, nas_ip, framed_ip, session_id, status_type,
        calling_station_id, updated_at
      ) VALUES (?, ?, ?, ?, 1, ?, NOW_LOCAL())
    `).run(
      username,
      nasIp,
      reqPacket.parsedAttrs.framedIp || '',
      authSessionId,
      reqPacket.parsedAttrs.callingStationId || ''
    );
  } catch (e) {}

  sendAuthResponse(CODES.ACCESS_ACCEPT, reqPacket, responseAttrs, secret, rinfo);
}

function sendAuthResponse(code, reqPacket, attributes, secret, rinfo) {
  try {
    const resBuf = encodeResponsePacket({
      code,
      identifier: reqPacket.identifier,
      requestAuthenticator: reqPacket.authenticator,
      attributes,
      secret
    });
    authSocket.send(resBuf, rinfo.port, rinfo.address);
  } catch (err) {
    logger.error(`[RADIUS Auth] Gagal me-reply response: ${err.message}`);
  }
}

/**
 * Memproses RADIUS Accounting-Request
 */
function handleAcctMessage(msg, rinfo) {
  const nasIp = rinfo.address;
  const secret = getNasSecret(nasIp);

  let reqPacket;
  try {
    reqPacket = decodePacket(msg, secret);
  } catch (err) {
    logger.warn(`[RADIUS Acct] Gagal decode paket dari ${nasIp}:${rinfo.port} - ${err.message}`);
    return;
  }

  if (reqPacket.code !== CODES.ACCOUNTING_REQUEST) {
    return;
  }

  const {
    username = '',
    acctStatusType = 1,
    acctSessionId = '',
    framedIp = '',
    acctInputOctets = 0,
    acctOutputOctets = 0,
    acctInputGigawords = 0,
    acctOutputGigawords = 0,
    acctSessionTime = 0,
    acctTerminateCause = 0,
    callingStationId = '',
    calledStationId = ''
  } = reqPacket.parsedAttrs;

  if (username && acctSessionId) {
    try {
      // Upsert ke radius_accounting
      const stmt = db.prepare(`
        INSERT INTO radius_accounting (
          username, nas_ip, framed_ip, session_id, status_type,
          input_octets, output_octets, input_gigawords, output_gigawords,
          session_time, terminate_cause, calling_station_id, called_station_id,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW_LOCAL())
        ON CONFLICT(id) DO UPDATE SET
          status_type = excluded.status_type,
          input_octets = excluded.input_octets,
          output_octets = excluded.output_octets,
          session_time = excluded.session_time,
          terminate_cause = excluded.terminate_cause,
          updated_at = NOW_LOCAL()
      `);

      // Cek apakah session_id sudah ada
      const existing = db.prepare(`SELECT id FROM radius_accounting WHERE session_id = ? LIMIT 1`).get(acctSessionId);
      if (existing) {
        db.prepare(`
          UPDATE radius_accounting SET
            status_type = ?,
            input_octets = ?,
            output_octets = ?,
            input_gigawords = ?,
            output_gigawords = ?,
            session_time = ?,
            terminate_cause = ?,
            updated_at = NOW_LOCAL()
          WHERE session_id = ?
        `).run(
          acctStatusType,
          acctInputOctets,
          acctOutputOctets,
          acctInputGigawords,
          acctOutputGigawords,
          acctSessionTime,
          acctTerminateCause,
          acctSessionId
        );
      } else {
        stmt.run(
          username, nasIp, framedIp, acctSessionId, acctStatusType,
          acctInputOctets, acctOutputOctets, acctInputGigawords, acctOutputGigawords,
          acctSessionTime, acctTerminateCause, callingStationId, calledStationId
        );
      }

      // Catat sampel trafik ke pppoe_traffic_samples jika user terdaftar di pppoe_users
      const pppoeUser = db.prepare(`SELECT id FROM pppoe_users WHERE username = ? LIMIT 1`).get(username);
      if (pppoeUser) {
        db.prepare(`
          INSERT INTO pppoe_traffic_samples (pppoe_user_id, bytes_in, bytes_out)
          VALUES (?, ?, ?)
        `).run(pppoeUser.id, acctInputOctets, acctOutputOctets);
      }
    } catch (err) {
      logger.error(`[RADIUS Acct] Gagal simpan accounting: ${err.message}`);
    }
  }

  // Kirim Accounting-Response
  try {
    const resBuf = encodeResponsePacket({
      code: CODES.ACCOUNTING_RESPONSE,
      identifier: reqPacket.identifier,
      requestAuthenticator: reqPacket.authenticator,
      attributes: [],
      secret
    });
    acctSocket.send(resBuf, rinfo.port, rinfo.address);
  } catch (err) {
    logger.error(`[RADIUS Acct] Gagal me-reply Accounting-Response: ${err.message}`);
  }
}

/**
 * Menjalankan Server RADIUS (UDP Auth & Acct)
 */
function start() {
  if (isRunning) return;

  const authPort = parseInt(getSetting('radius_auth_port', 1812), 10) || 1812;
  const acctPort = parseInt(getSetting('radius_acct_port', 1813), 10) || 1813;

  try {
    authSocket = dgram.createSocket('udp4');
    authSocket.on('message', handleAuthMessage);
    authSocket.on('error', (err) => logger.error(`[RADIUS Auth Error] ${err.message}`));
    authSocket.bind(authPort, () => {
      logger.info(`[RADIUS] Auth Server mendengarkan pada port UDP ${authPort}`);
    });

    acctSocket = dgram.createSocket('udp4');
    acctSocket.on('message', handleAcctMessage);
    acctSocket.on('error', (err) => logger.error(`[RADIUS Acct Error] ${err.message}`));
    acctSocket.bind(acctPort, () => {
      logger.info(`[RADIUS] Accounting Server mendengarkan pada port UDP ${acctPort}`);
    });

    isRunning = true;
  } catch (err) {
    logger.error(`[RADIUS] Gagal menjalankan server RADIUS: ${err.message}`);
  }
}

/**
 * Menghentikan Server RADIUS
 */
function stop() {
  if (!isRunning) return;
  try {
    if (authSocket) authSocket.close();
    if (acctSocket) acctSocket.close();
  } catch (e) {}
  authSocket = null;
  acctSocket = null;
  isRunning = false;
  logger.info(`[RADIUS] Server RADIUS telah dihentikan.`);
}

function getStatus() {
  return {
    enabled: getSetting('radius_enabled', '0') === '1',
    running: isRunning,
    authPort: parseInt(getSetting('radius_auth_port', 1812), 10) || 1812,
    acctPort: parseInt(getSetting('radius_acct_port', 1813), 10) || 1813,
    secret: getSetting('radius_secret', 'secret123'),
    isolirAction: getSetting('radius_isolir_action', 'pool'),
    isolirPool: getSetting('radius_isolir_pool', 'isolir'),
    limitSimultaneous: getSetting('radius_limit_simultaneous', '1') === '1',
    defaultRateLimit: getSetting('radius_default_rate_limit', '5M/10M')
  };
}

function getOnlineSessions() {
  try {
    return db.prepare(`
      SELECT * FROM radius_accounting
      WHERE status_type IN (1, 3)
      ORDER BY updated_at DESC LIMIT 100
    `).all();
  } catch (e) {
    return [];
  }
}

function getAccountingLogs(limit = 100) {
  try {
    return db.prepare(`
      SELECT * FROM radius_accounting
      ORDER BY id DESC LIMIT ?
    `).all(limit);
  } catch (e) {
    return [];
  }
}

module.exports = {
  start,
  stop,
  getStatus,
  getOnlineSessions,
  getAccountingLogs
};
