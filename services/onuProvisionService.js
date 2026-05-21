const { Client } = require('ssh2');
const { logger } = require('../config/logger');
const { getSetting } = require('../config/settingsManager');

/**
 * ONU Provision Service
 * Support untuk:
 * - ZTE C300/C320
 * - Huawei MA5800 Series
 * - Fiberhome AN5516 Series
 * - VSOL V1600/V2400 Series
 * - C-Data FD1600/FD1800 Series
 */

class ONUProvisionService {
  constructor() {
    this.connections = new Map();
  }

  /**
   * Connect ke OLT via SSH
   */
  async connectSSH(oltConfig) {
    return new Promise((resolve, reject) => {
      const conn = new Client();
      const timeout = setTimeout(() => {
        conn.end();
        reject(new Error('Connection timeout'));
      }, 30000);

      conn.on('ready', () => {
        clearTimeout(timeout);
        resolve(conn);
      });

      conn.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });

      conn.connect({
        host: oltConfig.host,
        port: oltConfig.port || 22,
        username: oltConfig.username,
        password: oltConfig.password,
        readyTimeout: 30000,
        keepaliveInterval: 10000
      });
    });
  }

  /**
   * Execute command via SSH
   */
  async executeCommand(conn, command, waitFor = '#') {
    return new Promise((resolve, reject) => {
      conn.shell((err, stream) => {
        if (err) return reject(err);

        let output = '';
        const timeout = setTimeout(() => {
          stream.end();
          reject(new Error('Command timeout'));
        }, 30000);

        stream.on('data', (data) => {
          output += data.toString();
          if (output.includes(waitFor)) {
            clearTimeout(timeout);
            stream.end();
          }
        });

        stream.on('close', () => {
          clearTimeout(timeout);
          resolve(output);
        });

        stream.stderr.on('data', (data) => {
          logger.error('SSH stderr:', data.toString());
        });

        // Send command
        stream.write(command + '\n');
      });
    });
  }

  /**
   * ZTE C300/C320 - Get unconfigured ONUs
   */
  async zteGetUnconfiguredONUs(oltConfig, pon) {
    let conn;
    try {
      conn = await this.connectSSH(oltConfig);
      
      // Enable mode
      await this.executeCommand(conn, 'enable', '#');
      
      // Show unconfigured ONUs
      const command = `show gpon onu uncfg gpon-olt_${pon}`;
      const output = await this.executeCommand(conn, command, '#');
      
      const onus = this.parseZTEUnconfiguredONUs(output);
      conn.end();
      
      return onus;
    } catch (error) {
      if (conn) conn.end();
      logger.error('ZTE get unconfigured ONUs error:', error);
      throw error;
    }
  }

  /**
   * Parse ZTE unconfigured ONUs output
   */
  parseZTEUnconfiguredONUs(output) {
    const onus = [];
    const lines = output.split('\n');
    
    for (const line of lines) {
      // Format: gpon-onu_1/1/1:1  ZTEG-F660  ZTEGC8343210  
      const match = line.match(/gpon-onu_(\d+\/\d+\/\d+):(\d+)\s+(\S+)\s+(\S+)/);
      if (match) {
        onus.push({
          pon: match[1],
          onuId: match[2],
          model: match[3],
          sn: match[4],
          vendor: 'ZTE'
        });
      }
    }
    
    return onus;
  }

  /**
   * ZTE C300/C320 - Provision ONU
   */
  async zteProvisionONU(oltConfig, params) {
    let conn;
    try {
      conn = await this.connectSSH(oltConfig);
      
      // Enable and config mode
      await this.executeCommand(conn, 'enable', '#');
      await this.executeCommand(conn, 'configure terminal', '#');
      
      const { pon, onuId, sn, name, vlan, bandwidth, wifiSsid, wifiPassword, lanMode, pppoeUsername, pppoePassword, tr069AcsUrl, tr069AcsUsername, tr069AcsPassword, tr069PeriodicInform } = params;
      
      // Add ONU
      let cmd = `interface gpon-olt_${pon}\n`;
      cmd += `onu ${onuId} type ${params.onuType || 'F660'} sn ${sn}\n`;
      cmd += `exit\n`;
      
      // Configure ONU
      cmd += `interface gpon-onu_${pon}:${onuId}\n`;
      cmd += `name ${name}\n`;
      cmd += `tcont 1 profile ${bandwidth || 'default'}\n`;
      cmd += `gemport 1 tcont 1\n`;
      
      // WiFi Configuration
      if (wifiSsid && wifiPassword) {
        cmd += `ssid 1 ${wifiSsid}\n`;
        cmd += `security 1 wpa2-psk AES ${wifiPassword}\n`;
        cmd += `wifi enable 1\n`;
      }
      
      // LAN Mode Configuration
      if (lanMode) {
        cmd += `lan-mode ${lanMode}\n`; // bridge or router
      }
      
      // PPPoE Configuration (if router mode)
      if (lanMode === 'router' && pppoeUsername && pppoePassword) {
        cmd += `wan-ip pppoe username ${pppoeUsername} password ${pppoePassword}\n`;
      }
      
      // TR069/CWMP Configuration
      if (tr069AcsUrl) {
        cmd += `tr069 enable\n`;
        cmd += `tr069 acs url ${tr069AcsUrl}\n`;
        
        if (tr069AcsUsername && tr069AcsPassword) {
          cmd += `tr069 acs username ${tr069AcsUsername}\n`;
          cmd += `tr069 acs password ${tr069AcsPassword}\n`;
        }
        
        if (tr069PeriodicInform) {
          cmd += `tr069 periodic-inform interval ${tr069PeriodicInform}\n`;
          cmd += `tr069 periodic-inform enable\n`;
        }
        
        logger.info(`TR069 configured for ONU ${name}: ACS URL=${tr069AcsUrl}, Interval=${tr069PeriodicInform || 300}s`);
      }
      
      cmd += `exit\n`;
      
      // Service port
      cmd += `pon-onu-mng gpon-onu_${pon}:${onuId}\n`;
      cmd += `service 1 gemport 1 vlan ${vlan}\n`;
      cmd += `vlan port eth_0/1 mode tag vlan ${vlan}\n`;
      cmd += `exit\n`;
      
      await this.executeCommand(conn, cmd, '#');
      
      conn.end();
      
      const features = [];
      if (wifiSsid) features.push('WiFi');
      if (lanMode) features.push(`LAN Mode: ${lanMode}`);
      if (tr069AcsUrl) features.push('TR069');
      
      return {
        success: true,
        message: `ONU provisioned successfully${features.length > 0 ? ' with ' + features.join(', ') : ''}`
      };
    } catch (error) {
      if (conn) conn.end();
      logger.error('ZTE provision ONU error:', error);
      throw error;
    }
  }

  /**
   * Huawei MA5800 - Get unconfigured ONUs
   */
  async huaweiGetUnconfiguredONUs(oltConfig, frame, slot, pon) {
    let conn;
    try {
      conn = await this.connectSSH(oltConfig);
      
      // Enable mode
      await this.executeCommand(conn, 'enable', '#');
      
      // Show autofind ONUs
      const command = `display ont autofind ${frame}/${slot}/${pon}`;
      const output = await this.executeCommand(conn, command, '#');
      
      const onus = this.parseHuaweiUnconfiguredONUs(output, frame, slot, pon);
      conn.end();
      
      return onus;
    } catch (error) {
      if (conn) conn.end();
      logger.error('Huawei get unconfigured ONUs error:', error);
      throw error;
    }
  }

  /**
   * Parse Huawei unconfigured ONUs output
   */
  parseHuaweiUnconfiguredONUs(output, frame, slot, pon) {
    const onus = [];
    const lines = output.split('\n');
    
    for (const line of lines) {
      // Format varies, look for SN pattern
      const match = line.match(/(\d+)\s+(\S+)\s+(\S+)/);
      if (match && match[2].length >= 12) {
        onus.push({
          frame,
          slot,
          pon,
          onuId: match[1],
          sn: match[2],
          model: match[3] || 'Unknown',
          vendor: 'Huawei'
        });
      }
    }
    
    return onus;
  }

  /**
   * Huawei MA5800 - Provision ONU
   */
  async huaweiProvisionONU(oltConfig, params) {
    let conn;
    try {
      conn = await this.connectSSH(oltConfig);
      
      // Enable and config mode
      await this.executeCommand(conn, 'enable', '#');
      await this.executeCommand(conn, 'config', '#');
      
      const { frame, slot, pon, onuId, sn, name, vlan, bandwidth, lineProfile, srvProfile, wifiSsid, wifiPassword, lanMode, pppoeUsername, pppoePassword, tr069AcsUrl, tr069AcsUsername, tr069AcsPassword, tr069PeriodicInform } = params;
      
      // Add ONU
      let cmd = `interface gpon ${frame}/${slot}\n`;
      cmd += `ont add ${pon} ${onuId} sn-auth ${sn} omci ont-lineprofile-id ${lineProfile || 1} ont-srvprofile-id ${srvProfile || 1} desc ${name}\n`;
      
      // WiFi Configuration
      if (wifiSsid && wifiPassword) {
        cmd += `ont wifi-config ${pon} ${onuId} ssid ${wifiSsid} wpa-psk ${wifiPassword}\n`;
      }
      
      // LAN Mode Configuration
      if (lanMode) {
        cmd += `ont port native-vlan ${pon} ${onuId} eth 1 vlan ${vlan} priority 0\n`;
      }
      
      // PPPoE Configuration (if router mode)
      if (lanMode === 'router' && pppoeUsername && pppoePassword) {
        cmd += `ont wan-config ${pon} ${onuId} pppoe username ${pppoeUsername} password ${pppoePassword}\n`;
      }
      
      // TR069/CWMP Configuration
      if (tr069AcsUrl) {
        cmd += `ont tr069-server ${pon} ${onuId} url ${tr069AcsUrl}\n`;
        
        if (tr069AcsUsername && tr069AcsPassword) {
          cmd += `ont tr069-server ${pon} ${onuId} username ${tr069AcsUsername} password ${tr069AcsPassword}\n`;
        }
        
        if (tr069PeriodicInform) {
          cmd += `ont tr069-server ${pon} ${onuId} periodic-inform interval ${tr069PeriodicInform}\n`;
          cmd += `ont tr069-server ${pon} ${onuId} periodic-inform enable\n`;
        }
        
        cmd += `ont tr069-server ${pon} ${onuId} enable\n`;
        
        logger.info(`TR069 configured for ONU ${name}: ACS URL=${tr069AcsUrl}, Interval=${tr069PeriodicInform || 300}s`);
      }
      
      cmd += `quit\n`;
      
      // Service port
      cmd += `service-port vlan ${vlan} gpon ${frame}/${slot}/${pon} ont ${onuId} gemport 1 multi-service user-vlan ${vlan}\n`;
      
      await this.executeCommand(conn, cmd, '#');
      
      conn.end();
      
      const features = [];
      if (wifiSsid) features.push('WiFi');
      if (lanMode) features.push(`LAN Mode: ${lanMode}`);
      if (tr069AcsUrl) features.push('TR069');
      
      return {
        success: true,
        message: `ONU provisioned successfully${features.length > 0 ? ' with ' + features.join(', ') : ''}`
      };
    } catch (error) {
      if (conn) conn.end();
      logger.error('Huawei provision ONU error:', error);
      throw error;
    }
  }

  /**
   * Fiberhome AN5516 - Provision ONU
   */
  async fiberhomeProvisionONU(oltConfig, params) {
    let conn;
    try {
      conn = await this.connectSSH(oltConfig);
      
      // Enable and config mode
      await this.executeCommand(conn, 'enable', '#');
      await this.executeCommand(conn, 'config', '#');
      
      const { frame, slot, pon, onuId, sn, name, vlan, lineProfile, srvProfile, wifiSsid, wifiPassword, lanMode, pppoeUsername, pppoePassword, tr069AcsUrl, tr069AcsUsername, tr069AcsPassword, tr069PeriodicInform } = params;
      
      // Add ONU
      let cmd = `interface gpon ${frame}/${slot}\n`;
      cmd += `ont add ${pon} ${onuId} sn-auth ${sn} ont-lineprofile-id ${lineProfile || 1} ont-srvprofile-id ${srvProfile || 1} desc ${name}\n`;
      
      // WiFi Configuration
      if (wifiSsid && wifiPassword) {
        cmd += `ont wlan ssid ${pon} ${onuId} 1 ${wifiSsid}\n`;
        cmd += `ont wlan security ${pon} ${onuId} 1 wpa2-psk aes ${wifiPassword}\n`;
        cmd += `ont wlan enable ${pon} ${onuId} 1\n`;
      }
      
      // LAN Mode Configuration
      if (lanMode) {
        cmd += `ont port vlan ${pon} ${onuId} eth 1 mode tag vlan ${vlan}\n`;
      }
      
      // PPPoE Configuration (if router mode)
      if (lanMode === 'router' && pppoeUsername && pppoePassword) {
        cmd += `ont wan ${pon} ${onuId} pppoe username ${pppoeUsername} password ${pppoePassword}\n`;
      }
      
      // TR069/CWMP Configuration
      if (tr069AcsUrl) {
        cmd += `ont cwmp ${pon} ${onuId} acs-url ${tr069AcsUrl}\n`;
        
        if (tr069AcsUsername && tr069AcsPassword) {
          cmd += `ont cwmp ${pon} ${onuId} acs-username ${tr069AcsUsername}\n`;
          cmd += `ont cwmp ${pon} ${onuId} acs-password ${tr069AcsPassword}\n`;
        }
        
        if (tr069PeriodicInform) {
          cmd += `ont cwmp ${pon} ${onuId} periodic-inform-interval ${tr069PeriodicInform}\n`;
          cmd += `ont cwmp ${pon} ${onuId} periodic-inform enable\n`;
        }
        
        cmd += `ont cwmp ${pon} ${onuId} enable\n`;
        
        logger.info(`TR069 configured for ONU ${name}: ACS URL=${tr069AcsUrl}, Interval=${tr069PeriodicInform || 300}s`);
      }
      
      cmd += `quit\n`;
      
      // Service port
      cmd += `service-port ${vlan} vlan ${vlan} gpon ${frame}/${slot}/${pon} ont ${onuId} gemport 1 multi-service user-vlan ${vlan}\n`;
      
      await this.executeCommand(conn, cmd, '#');
      
      conn.end();
      
      const features = [];
      if (wifiSsid) features.push('WiFi');
      if (lanMode) features.push(`LAN Mode: ${lanMode}`);
      if (tr069AcsUrl) features.push('TR069');
      
      return { 
        success: true, 
        message: `ONU provisioned successfully${features.length > 0 ? ' with ' + features.join(', ') : ''}` 
      };
    } catch (error) {
      if (conn) conn.end();
      logger.error('Fiberhome provision ONU error:', error);
      throw error;
    }
  }
  /**
   * VSOL V1600/V2400 - Provision ONU (Similar to ZTE)
   */
  async vsolProvisionONU(oltConfig, params) {
    let conn;
    try {
      conn = await this.connectSSH(oltConfig);
      
      // Enable and config mode
      await this.executeCommand(conn, 'enable', '#');
      await this.executeCommand(conn, 'configure terminal', '#');
      
      const { pon, onuId, sn, name, vlan, bandwidth, wifiSsid, wifiPassword, lanMode, pppoeUsername, pppoePassword, tr069AcsUrl, tr069AcsUsername, tr069AcsPassword, tr069PeriodicInform } = params;
      
      // Add ONU
      let cmd = `interface gpon-olt_${pon}\n`;
      cmd += `onu ${onuId} type ${params.onuType || 'V2802RGW'} sn ${sn}\n`;
      cmd += `exit\n`;
      
      // Configure ONU
      cmd += `interface gpon-onu_${pon}:${onuId}\n`;
      cmd += `name ${name}\n`;
      cmd += `tcont 1 profile ${bandwidth || 'default'}\n`;
      cmd += `gemport 1 tcont 1\n`;
      
      // WiFi Configuration
      if (wifiSsid && wifiPassword) {
        cmd += `ssid 1 ${wifiSsid}\n`;
        cmd += `security 1 wpa2-psk AES ${wifiPassword}\n`;
        cmd += `wifi enable 1\n`;
      }
      
      // LAN Mode Configuration
      if (lanMode) {
        cmd += `lan-mode ${lanMode}\n`;
      }
      
      // PPPoE Configuration (if router mode)
      if (lanMode === 'router' && pppoeUsername && pppoePassword) {
        cmd += `wan-ip pppoe username ${pppoeUsername} password ${pppoePassword}\n`;
      }
      
      // TR069/CWMP Configuration
      if (tr069AcsUrl) {
        cmd += `tr069 enable\n`;
        cmd += `tr069 acs url ${tr069AcsUrl}\n`;
        
        if (tr069AcsUsername && tr069AcsPassword) {
          cmd += `tr069 acs username ${tr069AcsUsername}\n`;
          cmd += `tr069 acs password ${tr069AcsPassword}\n`;
        }
        
        if (tr069PeriodicInform) {
          cmd += `tr069 periodic-inform interval ${tr069PeriodicInform}\n`;
          cmd += `tr069 periodic-inform enable\n`;
        }
        
        logger.info(`TR069 configured for ONU ${name}: ACS URL=${tr069AcsUrl}, Interval=${tr069PeriodicInform || 300}s`);
      }
      
      cmd += `exit\n`;
      
      // Service port
      cmd += `pon-onu-mng gpon-onu_${pon}:${onuId}\n`;
      cmd += `service 1 gemport 1 vlan ${vlan}\n`;
      cmd += `vlan port eth_0/1 mode tag vlan ${vlan}\n`;
      cmd += `exit\n`;
      
      await this.executeCommand(conn, cmd, '#');
      
      conn.end();
      
      const features = [];
      if (wifiSsid) features.push('WiFi');
      if (lanMode) features.push(`LAN Mode: ${lanMode}`);
      if (tr069AcsUrl) features.push('TR069');
      
      return { 
        success: true, 
        message: `ONU provisioned successfully${features.length > 0 ? ' with ' + features.join(', ') : ''}` 
      };
    } catch (error) {
      if (conn) conn.end();
      logger.error('VSOL provision ONU error:', error);
      throw error;
    }
  }

  /**
   * C-Data FD1600/FD1800 - Provision ONU (Similar to ZTE)
   */
  async cdataProvisionONU(oltConfig, params) {
    let conn;
    try {
      conn = await this.connectSSH(oltConfig);
      
      // Enable and config mode
      await this.executeCommand(conn, 'enable', '#');
      await this.executeCommand(conn, 'configure terminal', '#');
      
      const { pon, onuId, sn, name, vlan, bandwidth, wifiSsid, wifiPassword, lanMode, pppoeUsername, pppoePassword, tr069AcsUrl, tr069AcsUsername, tr069AcsPassword, tr069PeriodicInform } = params;
      
      // Add ONU
      let cmd = `interface gpon-olt_${pon}\n`;
      cmd += `onu ${onuId} type ${params.onuType || 'FD1104S'} sn ${sn}\n`;
      cmd += `exit\n`;
      
      // Configure ONU
      cmd += `interface gpon-onu_${pon}:${onuId}\n`;
      cmd += `name ${name}\n`;
      cmd += `tcont 1 profile ${bandwidth || 'default'}\n`;
      cmd += `gemport 1 tcont 1\n`;
      
      // WiFi Configuration
      if (wifiSsid && wifiPassword) {
        cmd += `ssid 1 ${wifiSsid}\n`;
        cmd += `security 1 wpa2-psk AES ${wifiPassword}\n`;
        cmd += `wifi enable 1\n`;
      }
      
      // LAN Mode Configuration
      if (lanMode) {
        cmd += `lan-mode ${lanMode}\n`;
      }
      
      // PPPoE Configuration (if router mode)
      if (lanMode === 'router' && pppoeUsername && pppoePassword) {
        cmd += `wan-ip pppoe username ${pppoeUsername} password ${pppoePassword}\n`;
      }
      
      // TR069/CWMP Configuration
      if (tr069AcsUrl) {
        cmd += `cwmp enable\n`;
        cmd += `cwmp acs url ${tr069AcsUrl}\n`;
        
        if (tr069AcsUsername && tr069AcsPassword) {
          cmd += `cwmp acs username ${tr069AcsUsername}\n`;
          cmd += `cwmp acs password ${tr069AcsPassword}\n`;
        }
        
        if (tr069PeriodicInform) {
          cmd += `cwmp periodic-inform interval ${tr069PeriodicInform}\n`;
          cmd += `cwmp periodic-inform enable\n`;
        }
        
        logger.info(`TR069 configured for ONU ${name}: ACS URL=${tr069AcsUrl}, Interval=${tr069PeriodicInform || 300}s`);
      }
      
      cmd += `exit\n`;
      
      // Service port
      cmd += `pon-onu-mng gpon-onu_${pon}:${onuId}\n`;
      cmd += `service 1 gemport 1 vlan ${vlan}\n`;
      cmd += `vlan port eth_0/1 mode tag vlan ${vlan}\n`;
      cmd += `exit\n`;
      
      await this.executeCommand(conn, cmd, '#');
      
      conn.end();
      
      const features = [];
      if (wifiSsid) features.push('WiFi');
      if (lanMode) features.push(`LAN Mode: ${lanMode}`);
      if (tr069AcsUrl) features.push('TR069');
      
      return { 
        success: true, 
        message: `ONU provisioned successfully${features.length > 0 ? ' with ' + features.join(', ') : ''}` 
      };
    } catch (error) {
      if (conn) conn.end();
      logger.error('C-Data provision ONU error:', error);
      throw error;
    }
  }


  /**
   * Get ONU details (works for both ZTE and Huawei)
   */
  async getONUDetails(oltConfig, vendor, params) {
    if (vendor === 'ZTE') {
      return this.zteGetONUDetails(oltConfig, params);
    } else if (vendor === 'Huawei') {
      return this.huaweiGetONUDetails(oltConfig, params);
    }
    throw new Error('Unsupported vendor');
  }

  /**
   * ZTE - Get ONU details
   */
  async zteGetONUDetails(oltConfig, params) {
    let conn;
    try {
      conn = await this.connectSSH(oltConfig);
      await this.executeCommand(conn, 'enable', '#');
      
      const { pon, onuId } = params;
      const command = `show gpon onu detail-info gpon-onu_${pon}:${onuId}`;
      const output = await this.executeCommand(conn, command, '#');
      
      conn.end();
      
      return this.parseZTEONUDetails(output);
    } catch (error) {
      if (conn) conn.end();
      throw error;
    }
  }

  /**
   * Parse ZTE ONU details
   */
  parseZTEONUDetails(output) {
    const details = {};
    const lines = output.split('\n');
    
    for (const line of lines) {
      if (line.includes('Name:')) {
        details.name = line.split(':')[1]?.trim();
      }
      if (line.includes('SN:')) {
        details.sn = line.split(':')[1]?.trim();
      }
      if (line.includes('Status:')) {
        details.status = line.split(':')[1]?.trim();
      }
      if (line.includes('RX Power:')) {
        details.rxPower = line.split(':')[1]?.trim();
      }
    }
    
    return details;
  }

  /**
   * Huawei - Get ONU details
   */
  async huaweiGetONUDetails(oltConfig, params) {
    let conn;
    try {
      conn = await this.connectSSH(oltConfig);
      await this.executeCommand(conn, 'enable', '#');
      
      const { frame, slot, pon, onuId } = params;
      const command = `display ont info ${frame} ${slot} ${pon} ${onuId}`;
      const output = await this.executeCommand(conn, command, '#');
      
      conn.end();
      
      return this.parseHuaweiONUDetails(output);
    } catch (error) {
      if (conn) conn.end();
      throw error;
    }
  }

  /**
   * Parse Huawei ONU details
   */
  parseHuaweiONUDetails(output) {
    const details = {};
    const lines = output.split('\n');
    
    for (const line of lines) {
      if (line.includes('Description')) {
        details.name = line.split(':')[1]?.trim();
      }
      if (line.includes('SN')) {
        details.sn = line.split(':')[1]?.trim();
      }
      if (line.includes('Run state')) {
        details.status = line.split(':')[1]?.trim();
      }
      if (line.includes('Rx optical power')) {
        details.rxPower = line.split(':')[1]?.trim();
      }
    }
    
    return details;
  }

  /**
   * Delete ONU
   */
  async deleteONU(oltConfig, vendor, params) {
    if (vendor === 'ZTE') {
      return this.zteDeleteONU(oltConfig, params);
    } else if (vendor === 'Huawei') {
      return this.huaweiDeleteONU(oltConfig, params);
    }
    throw new Error('Unsupported vendor');
  }

  /**
   * ZTE - Delete ONU
   */
  async zteDeleteONU(oltConfig, params) {
    let conn;
    try {
      conn = await this.connectSSH(oltConfig);
      await this.executeCommand(conn, 'enable', '#');
      await this.executeCommand(conn, 'configure terminal', '#');
      
      const { pon, onuId } = params;
      const cmd = `interface gpon-olt_${pon}\nno onu ${onuId}\nexit\n`;
      await this.executeCommand(conn, cmd, '#');
      
      conn.end();
      return { success: true, message: 'ONU deleted successfully' };
    } catch (error) {
      if (conn) conn.end();
      throw error;
    }
  }

  /**
   * Huawei - Delete ONU
   */
  async huaweiDeleteONU(oltConfig, params) {
    let conn;
    try {
      conn = await this.connectSSH(oltConfig);
      await this.executeCommand(conn, 'enable', '#');
      await this.executeCommand(conn, 'config', '#');
      
      const { frame, slot, pon, onuId } = params;
      const cmd = `interface gpon ${frame}/${slot}\nont delete ${pon} ${onuId}\nquit\n`;
      await this.executeCommand(conn, cmd, '#');
      
      conn.end();
      return { success: true, message: 'ONU deleted successfully' };
    } catch (error) {
      if (conn) conn.end();
      throw error;
    }
  }

  /**
   * Create PPPoE Secret in MikroTik
   */
  async createMikrotikPPPoE(mikrotikConfig, params) {
    const mikrotikService = require('./mikrotikService');
    
    try {
      const { username, password, profile, comment, localAddress, remoteAddress } = params;
      
      // Connect to MikroTik
      const conn = await mikrotikService.connect(mikrotikConfig);
      
      // Add PPP Secret
      const command = [
        '/ppp/secret/add',
        `=name=${username}`,
        `=password=${password}`,
        `=service=pppoe`,
        `=profile=${profile || 'default'}`,
        `=comment=${comment || ''}`,
      ];
      
      if (localAddress) {
        command.push(`=local-address=${localAddress}`);
      }
      
      if (remoteAddress) {
        command.push(`=remote-address=${remoteAddress}`);
      }
      
      await conn.write(command);
      conn.close();
      
      logger.info(`PPPoE secret created in MikroTik: ${username}`);
      return { success: true, message: 'PPPoE secret created successfully' };
    } catch (error) {
      logger.error('Create MikroTik PPPoE error:', error);
      throw error;
    }
  }

  /**
   * Delete PPPoE Secret from MikroTik
   */
  async deleteMikrotikPPPoE(mikrotikConfig, username) {
    const mikrotikService = require('./mikrotikService');
    
    try {
      const conn = await mikrotikService.connect(mikrotikConfig);
      
      // Find secret by name
      const secrets = await conn.write('/ppp/secret/print', [`?name=${username}`]);
      
      if (secrets && secrets.length > 0) {
        const secretId = secrets[0]['.id'];
        await conn.write('/ppp/secret/remove', [`=.id=${secretId}`]);
        logger.info(`PPPoE secret deleted from MikroTik: ${username}`);
      }
      
      conn.close();
      
      return { success: true, message: 'PPPoE secret deleted successfully' };
    } catch (error) {
      logger.error('Delete MikroTik PPPoE error:', error);
      throw error;
    }
  }

  /**
   * Full Provision: ONU + MikroTik PPPoE
   */
  async fullProvision(oltConfig, mikrotikConfig, params) {
    const results = {
      onu: null,
      pppoe: null,
      errors: []
    };
    
    try {
      // 1. Provision ONU
      const { vendor } = params;
      
      if (vendor === 'ZTE') {
        results.onu = await this.zteProvisionONU(oltConfig, params);
      } else if (vendor === 'Huawei') {
        results.onu = await this.huaweiProvisionONU(oltConfig, params);
      } else if (vendor === 'Fiberhome') {
        results.onu = await this.fiberhomeProvisionONU(oltConfig, params);
      } else if (vendor === 'VSOL') {
        results.onu = await this.vsolProvisionONU(oltConfig, params);
      } else if (vendor === 'CData') {
        results.onu = await this.cdataProvisionONU(oltConfig, params);
      } else {
        throw new Error(`Unsupported vendor: ${vendor}`);
      }
      
      logger.info(`ONU provisioned: ${params.name} (${vendor})`);
      
      // 2. Create PPPoE in MikroTik (if credentials provided)
      if (params.pppoeUsername && params.pppoePassword && mikrotikConfig) {
        try {
          results.pppoe = await this.createMikrotikPPPoE(mikrotikConfig, {
            username: params.pppoeUsername,
            password: params.pppoePassword,
            profile: params.bandwidth || 'default',
            comment: `${params.name} - Auto-provisioned`,
            remoteAddress: params.remoteAddress
          });
          
          logger.info(`PPPoE created: ${params.pppoeUsername}`);
        } catch (pppoeError) {
          results.errors.push(`PPPoE creation failed: ${pppoeError.message}`);
          logger.error('PPPoE creation failed:', pppoeError);
        }
      }
      
      return {
        success: true,
        message: 'Full provisioning completed',
        results
      };
    } catch (error) {
      results.errors.push(`Provisioning failed: ${error.message}`);
      logger.error('Full provision error:', error);
      throw error;
    }
  }
}

module.exports = new ONUProvisionService();

// Made with Bob
