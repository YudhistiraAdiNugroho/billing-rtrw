const crypto = require('crypto');
const { getSetting, getSettings, saveSettings } = require('../config/settingsManager');
const { getAppSetting, saveAppSetting } = require('../config/database');

const FEATURE_PASSWORD_HASH = '45d841d9f79ebadb8db21b0068b6b6d10a49ff66865e9fbf88267cceccd3c784';
const FEATURE_CONTACT_PHONE = '081947215703';

function getFeaturePasswordHash() {
  return getSetting('feature_password_hash', FEATURE_PASSWORD_HASH);
}

function getFeatureContactPhone() {
  return getSetting('feature_contact_phone', FEATURE_CONTACT_PHONE);
}

const SETTINGS_KEY = 'sidebar_menu_states';
const STATE_VISIBLE = 'visible';
const STATE_HIDDEN = 'hidden';
const STATE_LOCKED = 'locked';
const VALID_STATES = new Set([STATE_VISIBLE, STATE_HIDDEN, STATE_LOCKED]);

const MENU_DEFINITIONS = [
  { key: 'dashboard', section: 'main', href: '/admin', icon: 'bi bi-speedometer2', labelKey: 'admin.nav.dashboard', labelDefault: 'Dashboard', roles: ['admin', 'cashier'], bottomNav: true, activePages: ['dashboard'] },
  { key: 'mikrotik', section: 'main', href: '/admin/mikrotik', icon: 'bi bi-router', labelKey: 'admin.nav.mikrotik', labelDefault: 'MikroTik', roles: ['admin', 'cashier'], bottomNav: true, activePages: ['mikrotik'] },
  { key: 'map', section: 'main', href: '/admin/map', icon: 'bi bi-map', labelKey: 'admin.nav.network_map', labelDefault: 'Peta Jaringan', roles: ['admin', 'cashier'], activePages: ['map'] },
  { key: 'whatsapp', section: 'main', href: '/admin/whatsapp', icon: 'bi bi-whatsapp', labelKey: 'admin.nav.whatsapp', labelDefault: 'WhatsApp', roles: ['admin', 'cashier'], activePages: ['whatsapp'] },
  { key: 'broadcast', section: 'main', href: '/admin/whatsapp/broadcast', icon: 'bi bi-megaphone', labelKey: 'admin.broadcast.title', labelDefault: 'Broadcast WhatsApp', roles: ['admin', 'cashier'], activePages: ['broadcast'] },

  { key: 'customers', section: 'billing', href: '/admin/customers', icon: 'bi bi-people', labelKey: 'admin.nav.customers', labelDefault: 'Pelanggan', roles: ['admin', 'cashier'], bottomNav: true, activePages: ['customers'] },
  { key: 'packages', section: 'billing', href: '/admin/packages', icon: 'bi bi-box-seam', labelKey: 'admin.nav.internet_packages', labelDefault: 'Paket Internet', roles: ['admin', 'cashier'], activePages: ['packages'] },
  { key: 'billing', section: 'billing', href: '/admin/billing', icon: 'bi bi-receipt', labelKey: 'admin.nav.invoices', labelDefault: 'Tagihan', roles: ['admin', 'cashier'], bottomNav: true, activePages: ['billing'] },
  { key: 'digiflazz', section: 'billing', href: '/admin/digiflazz', icon: 'bi bi-phone', labelKey: 'admin.nav.digiflazz', labelDefault: 'Digiflazz', roles: ['admin'], activePages: ['digiflazz'] },
  { key: 'reports', section: 'billing', href: '/admin/reports', icon: 'bi bi-bar-chart-line', labelKey: 'admin.nav.finance_report', labelDefault: 'Laporan Keuangan', roles: ['admin', 'cashier'], activePages: ['reports'] },
  { key: 'cashiers_reports', section: 'billing', href: '/admin/cashiers/reports', icon: 'bi bi-journal-text', labelKey: 'admin.nav.cashiers_reports', labelDefault: 'Laporan Kasir', roles: ['admin', 'cashier'], activePages: ['cashiers_reports'] },
  { key: 'collector_payments', section: 'billing', href: '/admin/collector-payments', icon: 'bi bi-check2-square', labelKey: 'admin.nav.collector_payments', labelDefault: 'Approval Kolektor', roles: ['admin', 'cashier'], activePages: ['collector_payments'] },

  { key: 'tickets', section: 'service', href: '/admin/tickets', icon: 'bi bi-headset', labelKey: 'admin.nav.customer_tickets', labelDefault: 'Keluhan Pelanggan', roles: ['admin', 'cashier'], activePages: ['tickets'] },
  { key: 'inventory', section: 'service', href: '/admin/inventory', icon: 'bi bi-boxes', labelKey: 'admin.nav.inventory', labelDefault: 'Inventaris (Stok)', roles: ['admin', 'cashier'], activePages: ['inventory'] },
  { key: 'attendance', section: 'service', href: '/admin/attendance', icon: 'bi bi-calendar-check', labelKey: 'admin.nav.attendance', labelDefault: 'Absensi Karyawan', roles: ['admin', 'cashier'], activePages: ['attendance'] },
  { key: 'payroll', section: 'service', href: '/admin/payroll', icon: 'bi bi-wallet2', labelKey: 'admin.nav.payroll', labelDefault: 'Gaji Karyawan', roles: ['admin', 'cashier'], activePages: ['payroll'] },

  { key: 'cashier_attendance', section: 'cashier', href: '/admin/cashiers/attendance', icon: 'bi bi-calendar-check', labelKey: 'admin.nav.cashier_attendance', labelDefault: 'Absensi Saya', roles: ['cashier'], activePages: ['cashier_attendance'] },

  { key: 'technicians', section: 'user_management', href: '/admin/technicians', icon: 'bi bi-person-gear', labelKey: 'admin.nav.technicians', labelDefault: 'Teknisi', roles: ['admin'], activePages: ['technicians'] },
  { key: 'cashiers', section: 'user_management', href: '/admin/cashiers', icon: 'bi bi-person-vcard', labelKey: 'admin.nav.cashiers', labelDefault: 'Kasir', roles: ['admin'], activePages: ['cashiers'] },
  { key: 'collectors', section: 'user_management', href: '/admin/collectors', icon: 'bi bi-person-badge', labelKey: 'admin.nav.collectors', labelDefault: 'Kolektor', roles: ['admin'], activePages: ['collectors'] },
  { key: 'agents', section: 'user_management', href: '/admin/agents', icon: 'bi bi-person-badge', labelKey: 'admin.nav.agents', labelDefault: 'Agent', roles: ['admin', 'cashier'], activePages: ['agents'] },
  { key: 'agents_reports', section: 'user_management', href: '/admin/agents/reports', icon: 'bi bi-journal-text', labelKey: 'admin.nav.agent_reports', labelDefault: 'Laporan Agent', roles: ['admin'], activePages: ['agents_reports'] },

  { key: 'update', section: 'system', href: '/admin/update', icon: 'bi bi-cloud-arrow-down', labelKey: 'admin.nav.update', labelDefault: 'Update GitHub', roles: ['admin'], activePages: ['update'] },
  { key: 'settings', section: 'system', href: '/admin/settings', icon: 'bi bi-gear', labelKey: 'admin.nav.settings', labelDefault: 'Pengaturan', roles: ['admin'], activePages: ['settings'] },
  { key: 'backup', section: 'system', href: '/admin/backup', icon: 'bi bi-hdd-stack', labelKey: 'admin.nav.backup', labelDefault: 'Backup & Recovery', roles: ['admin'], activePages: ['backup'] },
  { key: 'monitoring', section: 'system', href: '/admin/monitoring', icon: 'bi bi-activity', labelKey: 'admin.nav.monitoring', labelDefault: 'Monitoring Sistem', roles: ['admin'], activePages: ['monitoring'] },
  { key: 'audit_logs', section: 'system', href: '/admin/audit-logs', icon: 'bi bi-shield-lock', labelKey: 'admin.nav.audit_logs', labelDefault: 'Log Aktivitas', roles: ['admin'], activePages: ['audit_logs'] }
];

const DEFAULT_MENU_STATES = {
  dashboard: STATE_VISIBLE,
  mikrotik: STATE_VISIBLE,
  map: STATE_VISIBLE,
  whatsapp: STATE_VISIBLE,
  broadcast: STATE_VISIBLE,
  customers: STATE_VISIBLE,
  packages: STATE_VISIBLE,
  billing: STATE_VISIBLE,
  digiflazz: STATE_VISIBLE,
  reports: STATE_VISIBLE,
  cashiers_reports: STATE_VISIBLE,
  collector_payments: STATE_VISIBLE,
  tickets: STATE_VISIBLE,
  inventory: STATE_LOCKED,
  attendance: STATE_LOCKED,
  payroll: STATE_LOCKED,
  cashier_attendance: STATE_VISIBLE,
  technicians: STATE_LOCKED,
  cashiers: STATE_LOCKED,
  collectors: STATE_LOCKED,
  agents: STATE_LOCKED,
  agents_reports: STATE_LOCKED,
  update: STATE_VISIBLE,
  settings: STATE_VISIBLE,
  backup: STATE_VISIBLE,
  monitoring: STATE_VISIBLE,
  audit_logs: STATE_VISIBLE
};

const SECTION_DEFINITIONS = [
  { key: 'main', labelKey: 'admin.section.main', labelDefault: 'UTAMA' },
  { key: 'billing', labelKey: 'admin.section.billing', labelDefault: 'BILLING' },
  { key: 'service', labelKey: 'admin.section.service', labelDefault: 'LAYANAN' },
  { key: 'cashier', labelKey: 'admin.section.cashier', labelDefault: 'KASIR' },
  { key: 'user_management', labelKey: 'admin.section.user_management', labelDefault: 'MANAJEMEN USER' },
  { key: 'system', labelKey: 'admin.section.system', labelDefault: 'SISTEM' }
];

function sha256(input) {
  return crypto.createHash('sha256').update(String(input || '')).digest('hex');
}

function normalizeState(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return VALID_STATES.has(normalized) ? normalized : STATE_VISIBLE;
}

function getStoredMenuStates() {
  // Coba ambil dari Database dulu (Lebih Aman)
  let raw = getAppSetting(SETTINGS_KEY, null);
  let activationKeys = getAppSetting('sidebar_activation_keys', {});

  // Fallback ke settings.json jika di DB masih kosong (Migration)
  if (raw === null) {
    raw = getSetting(SETTINGS_KEY, {});
    activationKeys = getSetting('sidebar_activation_keys', {});
    // Langsung migrasi ke DB agar kedepannya pakai DB
    if (Object.keys(raw).length > 0) {
      saveAppSetting(SETTINGS_KEY, raw);
      saveAppSetting('sidebar_activation_keys', activationKeys);
    }
  }

  const stateMap = {};

  for (const menu of MENU_DEFINITIONS) {
    const defaultState = DEFAULT_MENU_STATES[menu.key] || STATE_VISIBLE;
    const storedState = raw && raw[menu.key] ? raw[menu.key] : defaultState;
    const normalized = normalizeState(storedState);

    // Jika menu aslinya LOCKED tapi diubah jadi VISIBLE/HIDDEN, cek kunci aktivasinya
    if (defaultState === STATE_LOCKED && normalized !== STATE_LOCKED) {
      const expectedKey = sha256(menu.key + getFeaturePasswordHash());
      const providedKey = activationKeys[menu.key];

      if (providedKey !== expectedKey) {
        // Kunci tidak cocok! Kembalikan ke LOCKED
        stateMap[menu.key] = STATE_LOCKED;
        continue;
      }
    }

    stateMap[menu.key] = normalized;
  }
  return stateMap;
}

function saveMenuStates(stateMap) {
  const activationKeys = getAppSetting('sidebar_activation_keys', {});
  const passwordHash = getFeaturePasswordHash();

  for (const key in stateMap) {
    const newState = stateMap[key];
    const defaultState = DEFAULT_MENU_STATES[key] || STATE_VISIBLE;

    // Jika menu yang aslinya LOCKED diaktifkan (jadi visible/hidden), generate kunci
    if (defaultState === STATE_LOCKED && newState !== STATE_LOCKED) {
      activationKeys[key] = sha256(key + passwordHash);
    } else if (newState === STATE_LOCKED) {
      // Jika dikunci kembali, hapus kuncinya
      delete activationKeys[key];
    }
  }

  // Simpan ke Database (Utama)
  saveAppSetting(SETTINGS_KEY, sanitizeMenuStates(stateMap));
  saveAppSetting('sidebar_activation_keys', activationKeys);

  // Tetap simpan ke settings.json sebagai cadangan / kompatibilitas
  const currentJson = getSettings();
  return saveSettings({
    ...currentJson,
    [SETTINGS_KEY]: sanitizeMenuStates(stateMap),
    sidebar_activation_keys: activationKeys
  });
}

function sanitizeMenuStates(input) {
  const clean = {};
  for (const menu of MENU_DEFINITIONS) {
    clean[menu.key] = normalizeState(input && input[menu.key] ? input[menu.key] : DEFAULT_MENU_STATES[menu.key]);
  }
  return clean;
}

function isMenuAllowedForSession(menu, session) {
  const roles = Array.isArray(menu.roles) ? menu.roles : ['admin'];
  if (roles.includes('admin') && session && session.isAdmin) return true;
  if (roles.includes('cashier') && session && session.isCashier) return true;
  return false;
}

function enrichMenu(menu, states) {
  const state = states[menu.key] || DEFAULT_MENU_STATES[menu.key] || STATE_VISIBLE;
  const locked = state === STATE_LOCKED;
  const hidden = state === STATE_HIDDEN;
  return {
    ...menu,
    state,
    locked,
    hidden,
    hrefResolved: menu.href,
    lockedMessage: locked ? `Menu "${menu.labelDefault}" terkunci. Hubungi ${getFeatureContactPhone()} untuk mendapatkan password aktivasi.` : ''
  };
}

function getSidebarSections(session) {
  const states = getStoredMenuStates();
  return SECTION_DEFINITIONS.map((section) => {
    const items = MENU_DEFINITIONS
      .filter((menu) => menu.section === section.key)
      .filter((menu) => isMenuAllowedForSession(menu, session))
      .map((menu) => enrichMenu(menu, states))
      .filter((menu) => !menu.hidden);

    return {
      ...section,
      items
    };
  }).filter((section) => section.items.length > 0);
}

function getBottomNavItems(session) {
  const states = getStoredMenuStates();
  return MENU_DEFINITIONS
    .filter((menu) => menu.bottomNav)
    .filter((menu) => isMenuAllowedForSession(menu, session))
    .map((menu) => enrichMenu(menu, states))
    .filter((menu) => !menu.hidden);
}

function getConfigMenus() {
  const states = getStoredMenuStates();
  return MENU_DEFINITIONS.map((menu) => {
    const section = SECTION_DEFINITIONS.find((s) => s.key === menu.section);
    return {
      ...menu,
      state: states[menu.key] || DEFAULT_MENU_STATES[menu.key] || STATE_VISIBLE,
      roleLabel: menu.roles.includes('admin') && menu.roles.includes('cashier')
        ? 'Admin & Kasir'
        : menu.roles.includes('cashier')
          ? 'Kasir'
          : 'Admin',
      sectionLabel: section?.labelDefault || menu.section,
      sectionLabelKey: section?.labelKey || ''
    };
  });
}

function getMenuDefinition(key) {
  return MENU_DEFINITIONS.find((menu) => menu.key === key) || null;
}

function isFeaturePasswordValid(password) {
  return sha256(password) === getFeaturePasswordHash();
}

function evaluateMenuAccess(menuKey, session) {
  const menu = getMenuDefinition(menuKey);
  if (!menu) {
    return { allowed: true, state: STATE_VISIBLE, menu: null };
  }

  if (!isMenuAllowedForSession(menu, session)) {
    return { allowed: false, state: 'forbidden', menu, reason: 'forbidden' };
  }

  const states = getStoredMenuStates();
  const state = states[menu.key] || DEFAULT_MENU_STATES[menu.key] || STATE_VISIBLE;
  if (state === STATE_HIDDEN) {
    return { allowed: false, state, menu, reason: 'hidden' };
  }
  if (state === STATE_LOCKED) {
    return { allowed: false, state, menu, reason: 'locked' };
  }
  return { allowed: true, state, menu, reason: null };
}

module.exports = {
  getFeatureContactPhone,
  getFeaturePasswordHash,
  STATE_VISIBLE,
  STATE_HIDDEN,
  STATE_LOCKED,
  MENU_DEFINITIONS,
  getSidebarSections,
  getBottomNavItems,
  getConfigMenus,
  getMenuDefinition,
  getStoredMenuStates,
  sanitizeMenuStates,
  isFeaturePasswordValid,
  saveMenuStates,
  evaluateMenuAccess,
};
