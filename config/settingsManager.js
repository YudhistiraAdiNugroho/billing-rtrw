const fs = require('fs');
const path = require('path');
const { logger } = require('./logger');
const { decryptSettings, encryptSettings } = require('./settingsEncryption');
const { validateSettings } = require('./settingsValidator');
const { logSettingsChange } = require('./settingsAudit');

// Cache untuk settings dengan timestamp
let settingsCache = null;
let settingsCacheTime = 0;
const CACHE_DURATION = 2000; // 2 detik

// File system watcher untuk auto-reload settings
const settingsPath = path.join(__dirname, '../settings.json');
let watcher = null;

// Helper untuk baca settings.json secara dinamis
function getSettings() {
  try {
    const rawSettings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    // Decrypt sensitive fields
    return decryptSettings(rawSettings);
  } catch (error) {
    logger.error(`[settings] Error reading settings.json: ${error.message}`);
    return {};
  }
}

// Helper untuk baca settings.json dengan cache
function getSettingsWithCache() {
  const now = Date.now();
  if (!settingsCache || (now - settingsCacheTime) > CACHE_DURATION) {
    settingsCache = getSettings();
    settingsCacheTime = now;
  }
  return settingsCache;
}

// Helper untuk mendapatkan nilai setting dengan fallback
function getSetting(key, defaultValue = null) {
  const settings = getSettingsWithCache();
  return settings[key] !== undefined ? settings[key] : defaultValue;
}

// Helper untuk mendapatkan multiple settings
function getSettingsByKeys(keys) {
  const settings = getSettingsWithCache();
  const result = {};
  keys.forEach(key => {
    result[key] = settings[key];
  });
  return result;
}

// File system watcher untuk auto-reload settings
function startSettingsWatcher() {
  try {
    // Hapus watcher lama jika ada
    if (watcher) {
      watcher.close();
    }
    
    // Buat watcher baru
    watcher = fs.watch(settingsPath, (eventType, filename) => {
      if (eventType !== 'change') return;
      // Di Windows `filename` sering null; hanya abaikan jika jelas bukan settings.json
      if (filename != null && filename !== 'settings.json') return;

      settingsCache = null;
      settingsCacheTime = 0;

      try {
        const s = getSettingsWithCache();
        const port = s.server_port ?? 4555;
        const host = s.server_host || 'localhost';
        const gurl = s.genieacs_url || '(tidak diatur)';
        const company = s.company_header || '(default)';
        logger.info(`[settings] settings.json dimuat ulang — port ${port}, host ${host}, company: ${company}, GenieACS: ${gurl}`);
      } catch (error) {
        logger.error(`[settings] Gagal memuat ulang settings.json: ${error.message}`);
      }
    });

    logger.info('[settings] Memantau perubahan settings.json');
  } catch (error) {
    logger.error(`[settings] Error starting settings watcher: ${error.message}`);
  }
}

// Mulai watcher saat modul dimuat
startSettingsWatcher();

// Menyimpan pengaturan ke settings.json dengan validation & encryption
function saveSettings(newSettings, actor = 'system', metadata = {}) {
  try {
    const currentSettings = getSettings();
    const updatedSettings = { ...currentSettings, ...newSettings };

    // Validate settings
    const validation = validateSettings(updatedSettings);
    if (!validation.valid) {
      logger.warn(`[settings] Validation failed: ${validation.errors.join(', ')}`);
      return {
        success: false,
        errors: validation.errors
      };
    }

    // Track changes untuk audit trail
    const changes = {};
    Object.keys(newSettings).forEach(field => {
      if (currentSettings[field] !== newSettings[field]) {
        changes[field] = {
          oldValue: currentSettings[field] || '',
          newValue: newSettings[field] || ''
        };
      }
    });

    // Encrypt sensitive fields
    const encryptedSettings = encryptSettings(updatedSettings);

    // Save to file
    fs.writeFileSync(settingsPath, JSON.stringify(encryptedSettings, null, 2), 'utf-8');

    // Update cache
    settingsCache = updatedSettings;
    settingsCacheTime = Date.now();

    // Log to audit trail
    if (Object.keys(changes).length > 0) {
      logSettingsChange(actor, changes, metadata);
    }

    logger.info(`[settings] Settings saved successfully by ${actor}`);
    return {
      success: true,
      changes: Object.keys(changes)
    };
  } catch (error) {
    logger.error(`[settings] Error saving settings.json: ${error.message}`);
    return {
      success: false,
      errors: [error.message]
    };
  }
}

module.exports = {
  getSettings,
  getSettingsWithCache,
  getSetting,
  getSettingsByKeys,
  saveSettings,
  startSettingsWatcher
};
