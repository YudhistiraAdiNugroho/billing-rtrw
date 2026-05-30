const express = require('express');
const router = express.Router();
const axios = require('axios');
const db = require('../config/database');
const { getSetting, getSettings } = require('../config/settingsManager');
const sidebarMenuSvc = require('../services/sidebarMenuService');
const customerDevice = require('../services/customerDeviceService');
const fs = require('fs');
const path = require('path');

// Helper for DB queries (using better-sqlite3)
function getACSServers(id = null) {
    const legacyACS = getLegacyACS();
    const legacyServer = legacyACS.acs_url ? { 
        id: 'legacy', 
        name: 'Default ACS', 
        url: legacyACS.acs_url, 
        username: legacyACS.acs_user, 
        password: legacyACS.acs_pass 
    } : null;

    if (id === 'legacy') return legacyServer ? [legacyServer] : [];

    let query = 'SELECT * FROM genieacs_servers';
    let params = [];
    if (id && id !== 'all') {
        query += ' WHERE id = ?';
        params.push(id);
        const row = db.prepare(query).get(params);
        return row ? [row] : [];
    }
    
    const rows = db.prepare(query).all(params);
    return legacyServer ? [legacyServer, ...rows] : rows;
}

function getLegacyACS() {
    return {
        acs_url: getSetting('genieacs_url', ''),
        acs_user: getSetting('genieacs_username', ''),
        acs_pass: getSetting('genieacs_password', ''),
        acs_vparams: '', // Default empty for now
        acs_path_pppoe: 'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.Username',
        acs_path_ip: 'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANIPConnection.1.ExternalIPAddress'
    };
}

function getAxiosConfig(server) {
    const config = {
        timeout: 15000,
        headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/json'
        }
    };
    if (server.username && server.password) {
        config.auth = {
            username: server.username,
            password: server.password
        };
    }
    return config;
}

// Helper to normalize URL
function normalizeUrl(url) {
    if (!url) return '';
    return url.endsWith('/') ? url.slice(0, -1) : url;
}

// Helper to get nested value like genieacs.js
function getNestedValue(obj, path) {
    try {
        const parts = path.split('.');
        let current = obj;
        for (const part of parts) {
            if (!current) return null;
            current = current[part];
        }
        if (current && typeof current === 'object' && '_value' in current) {
            return current._value;
        }
        if (current && typeof current === 'object' && current.hasOwnProperty('_value')) {
            return current._value;
        }
        return current;
    } catch (e) {
        return null;
    }
}

// Standard paths for RX Power and PPPoE
const RX_POWER_PATHS = [
    'VirtualParameters.RXPower',
    'VirtualParameters.RXpower',
    'VirtualParameters.rx_power',
    'VirtualParameters.redaman',
    'InternetGatewayDevice.WANDevice.1.WANPONInterfaceConfig.RXPower',
    'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.X_HW_OpticalSignal.RXPower',
    'Device.XPON.Interface.1.Stats.RXPower',
    'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANDSLDiagnostics.FECOutput' // some devices
];

const PPPOE_PATHS = [
    'VirtualParameters.PPPoEUser',
    'VirtualParameters.pppoe_user',
    'VirtualParameters.pppoeUsername',
    'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.Username',
    'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.2.WANPPPConnection.1.Username',
    'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.2.Username'
];

const IP_PATHS = [
    'VirtualParameters.IPAddress',
    'VirtualParameters.ip_address',
    'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANIPConnection.1.ExternalIPAddress',
    'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.ExternalIPAddress'
];

// Middleware: Require Admin Session
const requireAdmin = (req, res, next) => {
    if (req.session && req.session.isAdmin) {
        return next();
    }
    res.status(403).json({ success: false, message: 'Forbidden' });
};

const requireAdminSession = (req, res, next) => {
    if (req.session && req.session.isAdmin) {
        return next();
    }
    res.redirect('/admin/login');
};

function company() { return getSetting('company_header', 'ISP Admin'); }

function requireSidebarMenuAccess(menuKey) {
    return (req, res, next) => {
        const access = sidebarMenuSvc.evaluateMenuAccess(menuKey, req.session);
        if (access.allowed) return next();

        if (access.reason === 'hidden') {
            req.session._msg = { type: 'error', text: `Menu "${access.menu.labelDefault}" sedang disembunyikan dari sidebar.` };
            return res.redirect('/admin');
        }

        if (access.reason === 'locked') {
            req.session._msg = { type: 'error', text: `Menu "${access.menu.labelDefault}" terkunci. Hubungi ${sidebarMenuSvc.getFeatureContactPhone()} untuk mendapatkan password.` };
            return res.redirect('/admin/sidebar-settings');
        }

        req.session._msg = { type: 'error', text: 'Anda tidak memiliki akses ke menu ini.' };
        return res.redirect('/admin');
    };
}

router.use((req, res, next) => {
    res.locals.session = req.session;
    res.locals.sidebarSections = sidebarMenuSvc.getSidebarSections(req.session);
    res.locals.sidebarBottomNavItems = sidebarMenuSvc.getBottomNavItems(req.session);
    res.locals.settings = getSettings();
    res.locals.company = company();
    next();
});

router.use(requireAdminSession, requireSidebarMenuAccess('acs_pro'));

async function getLANHosts(deviceId, serverConfig) {
    try {
        const baseUrl = normalizeUrl(serverConfig.url);
        const [hostsResponse, wifiResponse] = await Promise.all([
            axios.get(`${baseUrl}/devices/`, {
                ...getAxiosConfig(serverConfig),
                params: {
                    query: JSON.stringify({ _id: deviceId }),
                    projection: 'InternetGatewayDevice.LANDevice.1.Hosts'
                }
            }).catch(() => ({ data: [] })),
            axios.get(`${baseUrl}/devices/`, {
                ...getAxiosConfig(serverConfig),
                params: {
                    query: JSON.stringify({ _id: deviceId }),
                    projection: 'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.AssociatedDevice,InternetGatewayDevice.LANDevice.1.WLANConfiguration.5.AssociatedDevice'
                }
            }).catch(() => ({ data: [] }))
        ]);

        const device = Array.isArray(hostsResponse.data) && hostsResponse.data.length > 0 ? hostsResponse.data[0] : null;
        if (!device) return [];

        const hostsData = device.InternetGatewayDevice?.LANDevice?.['1']?.Hosts;
        if (!hostsData) return [];

        let hostArray = [];
        if (hostsData.Host) {
            if (Array.isArray(hostsData.Host)) {
                hostArray = hostsData.Host;
            } else if (typeof hostsData.Host === 'object') {
                hostArray = Object.values(hostsData.Host).filter(v => v && typeof v === 'object');
            }
        }

        const wifiRssiMap = new Map();
        const wifiDevice = Array.isArray(wifiResponse.data) && wifiResponse.data.length > 0 ? wifiResponse.data[0] : null;
        if (wifiDevice) {
            const wlanConfig = wifiDevice.InternetGatewayDevice?.LANDevice?.['1']?.WLANConfiguration;
            if (wlanConfig) {
                for (const bandKey of ['1', '5']) {
                    const band = wlanConfig[bandKey];
                    if (!band || !band.AssociatedDevice) continue;

                    let devArray = [];
                    if (Array.isArray(band.AssociatedDevice)) {
                        devArray = band.AssociatedDevice;
                    } else if (typeof band.AssociatedDevice === 'object') {
                        devArray = Object.values(band.AssociatedDevice).filter(v => v && typeof v === 'object');
                    }

                    const bandLabel = bandKey === '5' ? '5GHz' : '2.4GHz';
                    devArray.forEach(dev => {
                        const mac = dev.AssociatedDeviceMACAddress?._value || dev.MACAddress?._value || null;
                        const rssi = dev.X_HW_RSSI?._value || dev.SignalStrength?._value || null;
                        const rate = dev.LastDataTransmitRate?._value || dev.X_HW_TxRate?._value || null;

                        if (mac) {
                            wifiRssiMap.set(mac.toString().toLowerCase(), {
                                rssi: rssi !== null ? parseInt(rssi) : null,
                                rate: rate,
                                band: bandLabel
                            });
                        }
                    });
                }
            }
        }

        return hostArray.map((host, index) => {
            const getHostVal = (key) => {
                const val = host[key];
                if (val && typeof val === 'object' && '_value' in val) return val._value;
                return val;
            };

            const mac = getHostVal('MACAddress') || '-';
            const ip = getHostVal('IPAddress') || '-';
            const hostname = getHostVal('HostName') || 'Unknown';
            const activeRaw = getHostVal('Active');
            const interfaceType = getHostVal('InterfaceType') || '';
            const layer2Interface = getHostVal('Layer2Interface') || '';
            
            let bytesReceived = 0;
            let bytesSent = 0;
            const stats = host['X_HW_Stats'];
            if (stats && typeof stats === 'object') {
                bytesReceived = parseInt(stats.BytesReceived?._value || stats.BytesReceived || 0);
                bytesSent = parseInt(stats.BytesSent?._value || stats.BytesSent || 0);
            }

            const l2Str = layer2Interface.toString().toLowerCase();
            const isWiFi = interfaceType.toString().toLowerCase().includes('802.11') || l2Str.includes('wlan') || l2Str.includes('wifi');
            
            let finalRssi = null;
            let band = l2Str.includes('5') ? '5GHz' : '2.4GHz';
            const macLower = mac.toString().toLowerCase();

            if (isWiFi && wifiRssiMap.has(macLower)) {
                const wifiInfo = wifiRssiMap.get(macLower);
                finalRssi = wifiInfo.rssi;
                band = wifiInfo.band;
            }

            return {
                index: index + 1,
                mac, ip, hostname,
                active: activeRaw === true || activeRaw === 'true' || activeRaw === 1,
                isWiFi, band, rssi: finalRssi,
                bytesReceived, bytesSent
            };
        });
    } catch (err) {
        console.error(`[getLANHosts] Error:`, err.message);
        return [];
    }
}

// ============================================
// DEVICE FETCH HELPERS
// ============================================

async function fetchDevicesFromACS(server, vParams = [], paths = {}, options = {}) {
    const { page = 1, limit = null } = options;
    try {
        const baseUrl = normalizeUrl(server.url);
        // Gabungkan proyeksi dasar dengan path pencarian
        let projection = '_id,_lastInform,_ip,_deviceId._Manufacturer,_deviceId._ProductClass,_deviceId._SerialNumber,VirtualParameters,InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1';
        
        const params = { projection };
        if (limit !== null) {
            params.limit = limit + 1;
            params.skip = (page - 1) * limit;
        }

        const response = await axios.get(`${baseUrl}/devices`, {
            ...getAxiosConfig(server),
            params
        });

        if (!Array.isArray(response.data)) return { server, devices: [], hasMore: false };

        const hasMore = limit !== null && response.data.length > limit;
        const devicesData = hasMore ? response.data.slice(0, limit) : response.data;

        const devices = devicesData.map(d => {
            // Fallback PPPoE
            let pppoeUser = '-';
            for (const path of PPPOE_PATHS) {
                const val = getNestedValue(d, path);
                if (val && val !== '-') {
                    pppoeUser = val;
                    break;
                }
            }

            // Fallback RX Power
            let rxPower = '-';
            for (const path of RX_POWER_PATHS) {
                const val = getNestedValue(d, path);
                if (val && val !== '-') {
                    rxPower = val;
                    break;
                }
            }

            // Fallback IP
            let ip = d._ip || '-';
            if (ip === '-') {
                for (const path of IP_PATHS) {
                    const val = getNestedValue(d, path);
                    if (val && val !== '-') {
                        ip = val;
                        break;
                    }
                }
            }

            // Customer Name
            const customerName = getNestedValue(d, 'VirtualParameters.CustomerName') || 
                                getNestedValue(d, 'VirtualParameters.customer_name') || 
                                '-';

            return {
                id: d._id,
                sn: d._deviceId?._SerialNumber || d._id,
                last_inform: d._lastInform,
                isOnline: d._lastInform ? (Date.now() - new Date(d._lastInform).getTime() < 300000) : false,
                customer_name: customerName,
                rx_power: rxPower,
                pppoe_user: pppoeUser,
                ip: ip,
                acs_server_name: server.name,
                acs_server_id: server.id
            };
        });

        return { server, devices, hasMore };
    } catch (err) {
        console.error(`[fetchDevicesFromACS] Error on ${server.name}:`, err.message);
        return { server, devices: [], hasMore: false, error: err.message };
    }
}

// ============================================
// ROUTES
// ============================================

router.get('/', async (req, res) => {
    try {
        const searchQuery = String(req.query.q || '').trim() || null;
        const acsServers = getACSServers();
        const legacyACS = getLegacyACS();
        
        const activeServers = acsServers.length > 0 ? acsServers :
            (legacyACS.acs_url ? [{ id: 'legacy', name: 'Default ACS', url: legacyACS.acs_url, username: legacyACS.acs_user, password: legacyACS.acs_pass }] : []);

        const selectedAcsId = req.query.acs || (activeServers[0]?.id);
        const targetServers = selectedAcsId && selectedAcsId !== 'all' ? activeServers.filter(s => String(s.id) === String(selectedAcsId)) : activeServers;

        let allDevices = [];
        if (targetServers.length > 0) {
            if (searchQuery) {
                // Search mode: query devices with search filter
                const query = JSON.stringify({
                    $or: [
                        { '_deviceId._SerialNumber': { $regex: searchQuery, $options: 'i' } },
                        { 'VirtualParameters.CustomerName': { $regex: searchQuery, $options: 'i' } },
                        { 'VirtualParameters.customer_name': { $regex: searchQuery, $options: 'i' } },
                        { 'VirtualParameters.PPPoEUser': { $regex: searchQuery, $options: 'i' } },
                        { '_tags': searchQuery }
                    ]
                });
                
                for (const server of targetServers) {
                    try {
                        const baseUrl = normalizeUrl(server.url);
                        const response = await axios.get(`${baseUrl}/devices`, {
                            ...getAxiosConfig(server),
                            params: { query }
                        });
                        
                        if (Array.isArray(response.data)) {
                            const devices = response.data.map(d => {
                                let rxPower = '-';
                                for (const path of RX_POWER_PATHS) {
                                    const val = getNestedValue(d, path);
                                    if (val && val !== '-') { rxPower = val; break; }
                                }
                                
                                let pppoeUser = '-';
                                for (const path of PPPOE_PATHS) {
                                    const val = getNestedValue(d, path);
                                    if (val && val !== '-') { pppoeUser = val; break; }
                                }
                                
                                let ip = d._ip || '-';
                                if (ip === '-') {
                                    for (const path of IP_PATHS) {
                                        const val = getNestedValue(d, path);
                                        if (val && val !== '-') { ip = val; break; }
                                    }
                                }
                                
                                const customerName = getNestedValue(d, 'VirtualParameters.CustomerName') ||
                                                    getNestedValue(d, 'VirtualParameters.customer_name') || '-';
                                
                                return {
                                    id: d._id,
                                    sn: d._deviceId?._SerialNumber || d._id,
                                    last_inform: d._lastInform,
                                    isOnline: d._lastInform ? (Date.now() - new Date(d._lastInform).getTime() < 300000) : false,
                                    manufacturer: d._deviceId?._Manufacturer || '-',
                                    model: d._deviceId?._ProductClass || '-',
                                    rx_power: rxPower,
                                    pppoe_ip: ip,
                                    pppoe_user: pppoeUser,
                                    customer_name: customerName,
                                    acs_server_id: server.id,
                                    acs_server_name: server.name
                                };
                            });
                            allDevices = allDevices.concat(devices);
                        }
                    } catch (err) {
                        console.error(`Search error on server ${server.name}:`, err.message);
                    }
                }
            } else {
                // Normal mode: fetch all devices
                const results = await Promise.allSettled(targetServers.map(s => fetchDevicesFromACS(s, [], legacyACS)));
                results.forEach(r => { if (r.status === 'fulfilled') allDevices = allDevices.concat(r.value.devices); });
            }
        }

        res.render('admin/acs', {
            user: req.session,
            devices: allDevices,
            acsServers: activeServers,
            selectedAcsId,
            searchQuery,
            currentPage: 'acs_pro'
        });
    } catch (err) {
        console.error('ACS page error:', err);
        res.render('admin/acs', { user: req.session, devices: [], acsServers: [], selectedAcsId: null, searchQuery: null, currentPage: 'acs_pro' });
    }
});

router.get('/device/:deviceId', async (req, res) => {
    try {
        const acsId = String(req.query.acsId || req.query.acs || '').trim() || null;
        const deviceToken = String(req.params.deviceId || '');

        const legacyData = await customerDevice.getCustomerDeviceData(deviceToken);
        if (legacyData && legacyData.phone) {
            const isOnline = String(legacyData.status || '').toLowerCase() === 'online';
            const clients = Array.isArray(legacyData.connectedUsers) ? legacyData.connectedUsers : [];
            return res.render('admin/acs_device', {
                user: req.session,
                device: legacyData,
                clients,
                isOnline,
                acsId: acsId || 'legacy',
                acsName: 'Default ACS',
                currentPage: 'acs_pro'
            });
        }

        const servers = getACSServers(acsId);
        if (servers.length === 0) return res.status(404).send('ACS Server not found');

        const server = servers[0];
        const baseUrl = normalizeUrl(server.url);
        const deviceId = deviceToken;

        const response = await axios.get(`${baseUrl}/devices`, {
            ...getAxiosConfig(server),
            params: {
                query: JSON.stringify({ _id: deviceId }),
                projection: '_id,_lastInform,_deviceId,_registered,_ip,_tags,_events,VirtualParameters,InternetGatewayDevice'
            }
        });

        const deviceData = Array.isArray(response.data) && response.data.length > 0 ? response.data[0] : null;
        if (!deviceData) return res.status(404).send('Device not found');

        const lastInform = deviceData._lastInform;
        const isOnline = lastInform ? (Date.now() - new Date(lastInform).getTime() < 300000) : false;

        // Fallbacks for detail page using the same logic as listing
        let rxPower = '-';
        for (const path of RX_POWER_PATHS) {
            const val = getNestedValue(deviceData, path);
            if (val && val !== '-') {
                rxPower = val;
                break;
            }
        }

        let pppoeUser = '-';
        for (const path of PPPOE_PATHS) {
            const val = getNestedValue(deviceData, path);
            if (val && val !== '-') {
                pppoeUser = val;
                break;
            }
        }

        const customerName = getNestedValue(deviceData, 'VirtualParameters.CustomerName') || 
                            getNestedValue(deviceData, 'VirtualParameters.customer_name') || 
                            '-';

        let ip = deviceData._ip || '-';
        if (ip === '-') {
            for (const path of IP_PATHS) {
                const val = getNestedValue(deviceData, path);
                if (val && val !== '-') {
                    ip = val;
                    break;
                }
            }
        }

        const rawClients = await getLANHosts(deviceData._id, server);
        const clients = (Array.isArray(rawClients) ? rawClients : []).map((c) => ({
            hostname: c.hostname || 'Unknown',
            ip: c.ip || '-',
            mac: c.mac || '-',
            iface: c.isWiFi ? `WiFi ${c.band || ''}`.trim() : 'LAN',
            status: c.active ? 'Online' : 'Offline',
            rssi: typeof c.rssi === 'number' ? c.rssi : null
        }));

        res.render('admin/acs_device', {
            user: req.session,
            device: {
                phone: deviceData._id,
                serialNumber: deviceData._deviceId?._SerialNumber || deviceData._id,
                model: deviceData._deviceId?._ProductClass || '-',
                softwareVersion: '-',
                status: isOnline ? 'Online' : 'Offline',
                lastInform: lastInform || null,
                rxPower: rxPower,
                pppoeIP: ip,
                pppoeUsername: pppoeUser,
                ssid: getNestedValue(deviceData, 'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.SSID') || '-',
                uptime: '-'
            },
            clients,
            isOnline,
            acsId: server.id,
            acsName: server.name,
            currentPage: 'acs_pro'
        });
    } catch (err) {
        res.status(500).send(err.message);
    }
});

// POST /admin/acs/api/servers
router.post('/api/servers', requireAdmin, async (req, res) => {
    const { name, url, username, password, location } = req.body;
    try {
        db.prepare(
            'INSERT INTO genieacs_servers (name, url, username, password, location) VALUES (?, ?, ?, ?, ?)'
        ).run(name, url, username || null, password || null, location || '');
        res.json({ success: true, message: 'ACS server added' });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// PUT /admin/acs/api/servers/legacy (Default ACS)
router.put('/api/servers/legacy', requireAdmin, express.json(), async (req, res) => {
    try {
        const url = String(req.body?.url || '').trim();
        if (!url) return res.status(400).json({ success: false, message: 'URL wajib diisi' });
        if (!/^https?:\/\//i.test(url)) return res.status(400).json({ success: false, message: 'URL harus diawali http:// atau https://' });

        const clearUsername = Boolean(req.body?.clear_username);
        const clearPassword = Boolean(req.body?.clear_password);
        const usernameInput = String(req.body?.username || '').trim();
        const passwordInput = String(req.body?.password || '');

        const currentSettings = getSettings();
        currentSettings.genieacs_url = url;

        if (clearUsername) currentSettings.genieacs_username = '';
        else if (usernameInput) currentSettings.genieacs_username = usernameInput;

        if (clearPassword) currentSettings.genieacs_password = '';
        else if (String(passwordInput || '').trim()) currentSettings.genieacs_password = String(passwordInput || '');

        const settingsPath = path.join(__dirname, '../settings.json');
        fs.writeFileSync(settingsPath, JSON.stringify(currentSettings, null, 2), 'utf8');

        res.json({ success: true, message: 'Default ACS berhasil diperbarui.' });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// PUT /admin/acs/api/servers/:id
router.put('/api/servers/:id', requireAdmin, async (req, res) => {
    try {
        const id = String(req.params.id || '').trim();
        if (!id) return res.status(400).json({ success: false, message: 'Invalid server id' });

        const name = String(req.body?.name || '').trim();
        const url = String(req.body?.url || '').trim();
        if (!name || !url) return res.status(400).json({ success: false, message: 'Name and URL are required' });

        const existing = db.prepare('SELECT id, password FROM genieacs_servers WHERE id = ?').get(id);
        if (!existing) return res.status(404).json({ success: false, message: 'ACS server not found' });

        const usernameRaw = req.body?.username;
        const passwordRaw = req.body?.password;
        const location = String(req.body?.location || '');

        const clearUsername = Boolean(req.body?.clear_username);
        const clearPassword = Boolean(req.body?.clear_password);

        const username = clearUsername ? null : (String(usernameRaw || '').trim() || null);

        let password = existing.password || null;
        if (clearPassword) password = null;
        else if (String(passwordRaw || '').trim()) password = String(passwordRaw || '');

        db.prepare(
            'UPDATE genieacs_servers SET name = ?, url = ?, username = ?, password = ?, location = ? WHERE id = ?'
        ).run(name, url, username, password, location, id);

        res.json({ success: true, message: 'ACS server updated' });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// DELETE /admin/acs/api/servers/:id
router.delete('/api/servers/:id', requireAdmin, async (req, res) => {
    try {
        db.prepare('DELETE FROM genieacs_servers WHERE id = ?').run(req.params.id);
        res.json({ success: true, message: 'ACS server deleted' });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// DELETE /admin/acs/api/device/:deviceId
router.delete('/api/device/:deviceId', requireAdmin, async (req, res) => {
    try {
        const { acsId } = req.body;
        const servers = getACSServers(acsId);
        if (servers.length === 0) return res.json({ success: false, message: 'ACS not found' });
        
        const server = servers[0];
        const baseUrl = normalizeUrl(server.url);
        const deviceId = String(req.params.deviceId || '');
        
        await axios.delete(
            `${baseUrl}/devices/${encodeURIComponent(deviceId)}`,
            getAxiosConfig(server)
        );
        res.json({ success: true, message: 'Device deleted' });
    } catch (e) {
        res.json({ success: false, message: e.message });
    }
});

// POST /admin/acs/api/remote-enable/:deviceId
router.post('/api/remote-enable/:deviceId', requireAdmin, async (req, res) => {
    try {
        const { acsId } = req.body;
        const servers = getACSServers(acsId);
        if (servers.length === 0) return res.json({ success: false, message: 'ACS not found' });
        
        const server = servers[0];
        const baseUrl = normalizeUrl(server.url);
        const deviceId = String(req.params.deviceId || '');
        
        await axios.post(
            `${baseUrl}/devices/${encodeURIComponent(deviceId)}/tasks`,
            { 
                name: 'setParameterValues',
                parameterValues: [['InternetGatewayDevice.X_HW_Security.AclServices.HTTPWanEnable', true, 'xsd:boolean']]
            },
            { ...getAxiosConfig(server), timeout: 10000 }
        );
        res.json({ success: true, message: 'Remote WAN enabled' });
    } catch (e) {
        res.json({ success: false, message: e.message });
    }
});

// POST /admin/acs/api/reboot/:deviceId
router.post('/api/reboot/:deviceId', requireAdmin, async (req, res) => {
    try {
        const { acsId } = req.body;
        const servers = getACSServers(acsId);
        if (servers.length === 0) return res.json({ success: false, message: 'ACS not found' });
        
        const server = servers[0];
        const baseUrl = normalizeUrl(server.url);
        const deviceId = String(req.params.deviceId || '');
        
        await axios.post(
            `${baseUrl}/devices/${encodeURIComponent(deviceId)}/tasks`,
            { name: 'reboot' },
            { ...getAxiosConfig(server), timeout: 10000 }
        );
        res.json({ success: true, message: 'Reboot command sent' });
    } catch (e) {
        res.json({ success: false, message: e.message });
    }
});

// POST /admin/acs/api/refresh/:deviceId
router.post('/api/refresh/:deviceId', requireAdmin, async (req, res) => {
    try {
        const { acsId } = req.body;
        const servers = getACSServers(acsId);
        if (servers.length === 0) return res.json({ success: false, message: 'ACS not found' });
        
        const server = servers[0];
        const baseUrl = normalizeUrl(server.url);
        const deviceId = String(req.params.deviceId || '');
        
        await axios.post(
            `${baseUrl}/devices/${encodeURIComponent(deviceId)}/tasks`,
            { name: 'refreshObject', objectName: '' },
            { ...getAxiosConfig(server), timeout: 10000 }
        );
        res.json({ success: true, message: 'Refresh task queued' });
    } catch (e) {
        res.json({ success: false, message: e.message });
    }
});

// POST /admin/acs/api/sync/all
router.post('/api/sync/all', requireAdmin, async (req, res) => {
    try {
        const servers = getACSServers();
        if (servers.length === 0) return res.json({ success: true, message: 'No servers to sync' });
        
        let total = 0;
        for (const s of servers) {
            const result = await fetchDevicesFromACS(s, [], {});
            total += result.devices.length;
            db.prepare('UPDATE genieacs_servers SET device_count = ?, last_sync = (NOW_LOCAL()) WHERE id = ?').run(result.devices.length, s.id);
        }
        res.json({ success: true, message: `Sync complete. Total ${total} devices.` });
    } catch (e) {
        res.json({ success: false, message: e.message });
    }
});

// GET /api/clients/:deviceId
router.get('/api/clients/:deviceId', requireAdmin, async (req, res) => {
    try {
        const { deviceId } = req.params;
        const { acsId } = req.query;
        const servers = getACSServers(acsId);
        if (servers.length === 0) return res.json({ success: false });

        const hosts = await getLANHosts(String(deviceId || ''), servers[0]);
        res.json({ success: true, data: hosts });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

// GET /admin/acs/search - Redirect to main page with query params
router.get('/search', requireAdminSession, async (req, res) => {
    const { q, acs } = req.query;
    const params = new URLSearchParams();
    if (q) params.append('q', q);
    if (acs) params.append('acs', acs);
    res.redirect(`/admin/acs?${params.toString()}`);
});

module.exports = router;
