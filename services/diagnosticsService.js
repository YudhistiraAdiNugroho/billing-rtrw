/**
 * Service: System Diagnostics & Troubleshooting
 * Melakukan pengecekan terhadap dependensi eksternal dan diagnosa masalah
 */
const { logger } = require('../config/logger');
const db = require('../config/database');
const mikrotikService = require('./mikrotikService');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

/**
 * Perform a full system dependency check
 */
async function checkDependencies() {
  const results = {
    mikrotik: [],
    genieacs: { status: 'unknown', message: '' },
    whatsapp: { status: 'unknown', message: '' },
    paymentGateways: [],
    timestamp: new Date().toISOString()
  };

  // 1. Check MikroTik Routers
  try {
    const routers = db.prepare('SELECT * FROM routers').all();
    for (const r of routers) {
      try {
        // Simple connectivity check (get identity or similar)
        const isOnline = await mikrotikService.checkConnection(r.id);
        results.mikrotik.push({
          name: r.name,
          host: r.host,
          status: isOnline ? 'online' : 'offline',
          error: isOnline ? null : 'Connection failed'
        });
      } catch (err) {
        results.mikrotik.push({
          name: r.name,
          host: r.host,
          status: 'offline',
          error: err.message
        });
      }
    }
  } catch (err) {
    logger.error(`[Diagnostics] MikroTik check failed: ${err.message}`);
  }

  // 2. Check GenieACS
  try {
    const { getSetting } = require('../config/settingsManager');
    const acsUrl = getSetting('genieacs_url', 'http://localhost:7557');
    const response = await axios.get(acsUrl, { timeout: 3000 });
    results.genieacs = {
      status: response.status === 200 ? 'online' : 'warning',
      message: `GenieACS is responding (Status: ${response.status})`
    };
  } catch (err) {
    results.genieacs = {
      status: 'offline',
      message: `GenieACS unreachable: ${err.message}`
    };
  }

  // 3. Check WhatsApp Gateway (Internal Check)
  try {
    const whatsappSvc = require('./whatsapp'); // Assuming it exists
    const isConnected = whatsappSvc.isConnected ? whatsappSvc.isConnected() : false;
    results.whatsapp = {
      status: isConnected ? 'online' : 'offline',
      message: isConnected ? 'WhatsApp is connected' : 'WhatsApp is disconnected'
    };
  } catch (err) {
    results.whatsapp = { status: 'offline', message: 'WhatsApp service error' };
  }

  return results;
}

/**
 * Get recent errors from log file
 */
function getRecentErrors(limit = 10) {
  try {
    const logPath = path.join(__dirname, '../logs/error.log');
    if (!fs.existsSync(logPath)) return [];

    const content = fs.readFileSync(logPath, 'utf8');
    const lines = content.split('\n').filter(line => line.trim() !== '');
    return lines.slice(-limit).reverse();
  } catch (err) {
    return [`Error reading log: ${err.message}`];
  }
}

/**
 * Comprehensive Customer Diagnostics
 */
async function diagnoseCustomer(customerId) {
  const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(customerId);
  if (!customer) throw new Error('Customer not found');

  const report = {
    customer: { name: customer.name, pppoe: customer.pppoe_username },
    billing: { status: 'clean', unpaidCount: 0 },
    mikrotik: { status: 'unknown', details: null },
    genieacs: { status: 'unknown', signal: null },
    timestamp: new Date().toISOString()
  };

  // 1. Billing Check
  const unpaid = db.prepare("SELECT COUNT(*) as count FROM invoices WHERE customer_id = ? AND status = 'unpaid'").get(customerId);
  report.billing.unpaidCount = unpaid.count;
  if (unpaid.count > 0) report.billing.status = 'warning';

  // 2. MikroTik Check
  if (customer.pppoe_username && customer.router_id) {
    try {
      const active = await mikrotikService.getPppoeActive(customer.router_id);
      const session = active.find(s => s.name === customer.pppoe_username);
      if (session) {
        report.mikrotik = {
          status: 'online',
          details: {
            uptime: session.uptime,
            address: session.address,
            caller_id: session['caller-id']
          }
        };
      } else {
        report.mikrotik.status = 'offline';
      }
    } catch (err) {
      report.mikrotik.status = 'error';
      report.mikrotik.error = err.message;
    }
  }

  return report;
}

module.exports = {
  checkDependencies,
  getRecentErrors,
  diagnoseCustomer
};
