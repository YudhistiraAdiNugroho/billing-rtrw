/**
 * Service: Performance Monitoring System
 * Memantau kesehatan sistem dan performa aplikasi
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const { logger } = require('../config/logger');

// Store metrics history
const metricsHistory = new Map();
const MAX_HISTORY_SIZE = 100;

/**
 * Get system metrics
 */
function getSystemMetrics() {
  const cpus = os.cpus();
  const cpuUsage = process.cpuUsage();
  const totalMemory = os.totalmem();
  const freeMemory = os.freemem();
  const usedMemory = totalMemory - freeMemory;
  
  // Calculate CPU usage percentage
  const cpuPercent = (cpuUsage.user + cpuUsage.system) / 1000000;
  
  // Calculate memory usage percentage
  const memoryPercent = (usedMemory / totalMemory) * 100;
  
  // Get uptime
  const uptime = process.uptime();
  const uptimeHours = Math.floor(uptime / 3600);
  const uptimeMinutes = Math.floor((uptime % 3600) / 60);
  const uptimeSeconds = Math.floor(uptime % 60);
  
  // Get load average
  const loadAverage = os.loadavg();
  
  return {
    timestamp: new Date().toISOString(),
    cpu: {
      usage: cpuPercent.toFixed(2),
      cores: cpus.length,
      model: cpus[0].model,
      speed: cpus[0].speed
    },
    memory: {
      total: formatBytes(totalMemory),
      free: formatBytes(freeMemory),
      used: formatBytes(usedMemory),
      percentage: memoryPercent.toFixed(2)
    },
    uptime: {
      seconds: uptime,
      formatted: `${uptimeHours}h ${uptimeMinutes}m ${uptimeSeconds}s`
    },
    loadAverage: {
      '1min': loadAverage[0].toFixed(2),
      '5min': loadAverage[1].toFixed(2),
      '15min': loadAverage[2].toFixed(2)
    },
    platform: os.platform(),
    arch: os.arch(),
    nodeVersion: process.version
  };
}

/**
 * Get application metrics
 */
function getAppMetrics() {
  const memoryUsage = process.memoryUsage();
  
  return {
    pid: process.pid,
    memory: {
      rss: formatBytes(memoryUsage.rss),
      heapTotal: formatBytes(memoryUsage.heapTotal),
      heapUsed: formatBytes(memoryUsage.heapUsed),
      external: formatBytes(memoryUsage.external),
      arrayBuffers: formatBytes(memoryUsage.arrayBuffers)
    },
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  };
}

/**
 * Get disk usage
 */
function getDiskUsage() {
  try {
    const diskInfo = getDiskInfo('/');
    
    return {
      ...diskInfo,
      timestamp: new Date().toISOString()
    };
  } catch (e) {
    logger.error(`[Monitoring] Failed to get disk usage: ${e.message}`);
    return {
      total: 'N/A',
      free: 'N/A',
      used: 'N/A',
      percentage: 'N/A',
      timestamp: new Date().toISOString()
    };
  }
}

/**
 * Get disk info (cross-platform)
 */
function getDiskInfo(dir) {
  try {
    // For Unix-like systems
    if (os.platform() !== 'win32') {
      const { execSync } = require('child_process');
      const output = execSync(`df -h ${dir}`).toString();
      const lines = output.split('\n');
      if (lines.length > 1) {
        const parts = lines[1].split(/\s+/);
        return {
          total: parts[1],
          used: parts[2],
          free: parts[3],
          percentage: parts[4]
        };
      }
    }
    
    // For Windows or fallback
    const stats = fs.statSync(dir);
    return {
      total: 'N/A',
      free: 'N/A',
      used: 'N/A',
      percentage: 'N/A'
    };
  } catch (e) {
    return {
      total: 'N/A',
      free: 'N/A',
      used: 'N/A',
      percentage: 'N/A'
    };
  }
}

/**
 * Get database metrics
 */
function getDatabaseMetrics() {
  try {
    const db = require('../config/database');
    const dbPath = path.join(__dirname, '../database/billing.db');
    const stats = fs.statSync(dbPath);
    
    // Get table counts
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
    const tableCounts = {};
    
    for (const table of tables) {
      try {
        const count = db.prepare(`SELECT COUNT(*) as count FROM ${table.name}`).get();
        tableCounts[table.name] = count.count;
      } catch (e) {
        tableCounts[table.name] = 'N/A';
      }
    }
    
    return {
      size: formatBytes(stats.size),
      path: dbPath,
      tables: tableCounts,
      totalTables: tables.length,
      timestamp: new Date().toISOString()
    };
  } catch (e) {
    logger.error(`[Monitoring] Failed to get database metrics: ${e.message}`);
    return {
      size: 'N/A',
      path: 'N/A',
      tables: {},
      totalTables: 0,
      timestamp: new Date().toISOString()
    };
  }
}

/**
 * Get all metrics
 */
function getAllMetrics() {
  const system = getSystemMetrics();
  const app = getAppMetrics();
  const disk = getDiskUsage();
  const database = getDatabaseMetrics();
  
  const allMetrics = {
    system,
    app,
    disk,
    database,
    timestamp: new Date().toISOString()
  };
  
  // Store in history
  storeMetricsHistory(allMetrics);
  
  return allMetrics;
}

/**
 * Store metrics in history
 */
function storeMetricsHistory(metrics) {
  const key = metrics.timestamp;
  metricsHistory.set(key, metrics);
  
  // Keep only the last MAX_HISTORY_SIZE entries
  if (metricsHistory.size > MAX_HISTORY_SIZE) {
    const oldestKey = metricsHistory.keys().next().value;
    metricsHistory.delete(oldestKey);
  }
}

/**
 * Get metrics history
 */
function getMetricsHistory(limit = 10) {
  const history = Array.from(metricsHistory.values())
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
    .slice(0, limit);
  
  return history;
}

/**
 * Get health status
 */
function getHealthStatus() {
  const metrics = getAllMetrics();
  const issues = [];
  const warnings = [];
  
  // Check CPU usage
  const cpuUsage = parseFloat(metrics.system.cpu.usage);
  if (cpuUsage > 80) {
    issues.push(`CPU usage is high: ${cpuUsage}%`);
  } else if (cpuUsage > 60) {
    warnings.push(`CPU usage is elevated: ${cpuUsage}%`);
  }
  
  // Check memory usage
  const memoryUsage = parseFloat(metrics.system.memory.percentage);
  if (memoryUsage > 80) {
    issues.push(`Memory usage is high: ${memoryUsage}%`);
  } else if (memoryUsage > 60) {
    warnings.push(`Memory usage is elevated: ${memoryUsage}%`);
  }
  
  // Check load average
  const load1 = parseFloat(metrics.system.loadAverage['1min']);
  const cores = metrics.system.cpu.cores;
  if (load1 > cores * 2) {
    issues.push(`Load average is high: ${load1} (cores: ${cores})`);
  } else if (load1 > cores) {
    warnings.push(`Load average is elevated: ${load1} (cores: ${cores})`);
  }
  
  // Check disk usage
  const diskPercentage = metrics.disk.percentage;
  if (diskPercentage !== 'N/A') {
    const diskPercent = parseFloat(diskPercentage.replace('%', ''));
    if (diskPercent > 80) {
      issues.push(`Disk usage is high: ${diskPercentage}`);
    } else if (diskPercent > 60) {
      warnings.push(`Disk usage is elevated: ${diskPercentage}`);
    }
  }
  
  // Determine overall health status
  let status = 'healthy';
  if (issues.length > 0) {
    status = 'critical';
  } else if (warnings.length > 0) {
    status = 'warning';
  }
  
  return {
    status,
    issues,
    warnings,
    metrics,
    timestamp: new Date().toISOString()
  };
}

/**
 * Format bytes to human readable format
 */
function formatBytes(bytes) {
  if (bytes === 0) return '0 Bytes';
  
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  
  return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
}

/**
 * Get performance summary
 */
function getPerformanceSummary() {
  const history = getMetricsHistory(10);
  
  if (history.length === 0) {
    return {
      timestamp: new Date().toISOString(),
      summary: 'No historical data available'
    };
  }
  
  // Calculate averages
  const avgCpu = history.reduce((sum, m) => sum + parseFloat(m.system.cpu.usage), 0) / history.length;
  const avgMemory = history.reduce((sum, m) => sum + parseFloat(m.system.memory.percentage), 0) / history.length;
  const avgLoad1 = history.reduce((sum, m) => sum + parseFloat(m.system.loadAverage['1min']), 0) / history.length;
  
  // Find max values
  const maxCpu = Math.max(...history.map(m => parseFloat(m.system.cpu.usage)));
  const maxMemory = Math.max(...history.map(m => parseFloat(m.system.memory.percentage)));
  const maxLoad1 = Math.max(...history.map(m => parseFloat(m.system.loadAverage['1min'])));
  
  return {
    timestamp: new Date().toISOString(),
    period: {
      start: history[history.length - 1].timestamp,
      end: history[0].timestamp,
      samples: history.length
    },
    averages: {
      cpu: avgCpu.toFixed(2),
      memory: avgMemory.toFixed(2),
      load1: avgLoad1.toFixed(2)
    },
    maximums: {
      cpu: maxCpu.toFixed(2),
      memory: maxMemory.toFixed(2),
      load1: maxLoad1.toFixed(2)
    }
  };
}

/**
 * Clear metrics history
 */
function clearMetricsHistory() {
  metricsHistory.clear();
  logger.info('[Monitoring] Metrics history cleared');
}

module.exports = {
  getSystemMetrics,
  getAppMetrics,
  getDiskUsage,
  getDatabaseMetrics,
  getAllMetrics,
  getMetricsHistory,
  getHealthStatus,
  getPerformanceSummary,
  clearMetricsHistory
};
