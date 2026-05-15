/**
 * Service: Voucher Payment Gateway Integration
 * Otomatis mengambil payment methods dari payment gateway yang aktif
 */
const axios = require('axios');
const crypto = require('crypto');
const { getSettingsWithCache } = require('../config/settingsManager');
const { logger } = require('../config/logger');
const paymentSvc = require('./paymentService');

/**
 * Get available payment methods dari payment gateway yang aktif
 */
async function getAvailablePaymentMethods() {
  const settings = getSettingsWithCache();
  const methods = [];

  try {
    // Tripay methods
    if (settings.tripay_enabled && settings.tripay_api_key) {
      const tripayMethods = await getTripayPaymentMethods(settings);
      methods.push(...tripayMethods);
    }

    // Midtrans methods (Snap)
    if (settings.midtrans_enabled && settings.midtrans_server_key) {
      const midtransMethods = await getMidtransPaymentMethods(settings);
      methods.push(...midtransMethods);
    }

    // Xendit methods
    if (settings.xendit_enabled && settings.xendit_api_key) {
      const xenditMethods = await getXenditPaymentMethods(settings);
      methods.push(...xenditMethods);
    }

    // Duitku methods
    if (settings.duitku_enabled && settings.duitku_api_key) {
      const duitkuMethods = await getDuitkuPaymentMethods(settings);
      methods.push(...duitkuMethods);
    }

    return methods;
  } catch (error) {
    logger.error('[VoucherPayment] Error getting payment methods:', error.message);
    return [];
  }
}

/**
 * Get Tripay payment methods
 */
async function getTripayPaymentMethods(settings) {
  try {
    const isLive = settings.tripay_mode === 'live' || settings.tripay_mode === 'production';
    const baseUrl = isLive
      ? 'https://tripay.co.id/api/merchant/payment-method'
      : 'https://tripay.co.id/api-sandbox/merchant/payment-method';

    const response = await axios.get(baseUrl, {
      headers: { Authorization: `Bearer ${settings.tripay_api_key}` },
      timeout: 5000
    });

    if (response.data && response.data.success && Array.isArray(response.data.data)) {
      return response.data.data.map(method => ({
        gateway: 'tripay',
        code: method.code,
        name: method.name,
        icon: method.icon_url || '',
        fee: method.fee_flat || 0,
        feePercent: method.fee_percent || 0,
        minAmount: method.min_amount || 0,
        maxAmount: method.max_amount || 0,
        active: method.active === true || method.active === 1
      })).filter(m => m.active);
    }

    return [];
  } catch (error) {
    logger.warn('[VoucherPayment] Tripay methods fetch failed:', error.message);
    return [];
  }
}

/**
 * Get Midtrans payment methods (hardcoded, Midtrans tidak provide API untuk list methods)
 */
async function getMidtransPaymentMethods(settings) {
  // Midtrans Snap support these payment methods
  const methods = [
    { code: 'credit_card', name: 'Kartu Kredit', icon: '💳' },
    { code: 'bank_transfer', name: 'Transfer Bank', icon: '🏦' },
    { code: 'echannel', name: 'ATM Bersama/Prima', icon: '🏧' },
    { code: 'bca_va', name: 'BCA Virtual Account', icon: '🏦' },
    { code: 'bni_va', name: 'BNI Virtual Account', icon: '🏦' },
    { code: 'bri_va', name: 'BRI Virtual Account', icon: '🏦' },
    { code: 'permata_va', name: 'Permata Virtual Account', icon: '🏦' },
    { code: 'other_va', name: 'Virtual Account Lainnya', icon: '🏦' },
    { code: 'gopay', name: 'GoPay', icon: '📱' },
    { code: 'qris', name: 'QRIS', icon: '📲' }
  ];

  return methods.map(method => ({
    gateway: 'midtrans',
    code: method.code,
    name: method.name,
    icon: method.icon,
    fee: 0,
    feePercent: 0,
    minAmount: 10000,
    maxAmount: 999999999,
    active: true
  }));
}

/**
 * Get Xendit payment methods
 */
async function getXenditPaymentMethods(settings) {
  try {
    // Xendit payment methods (hardcoded)
    const methods = [
      { code: 'BANK_TRANSFER', name: 'Transfer Bank', icon: '🏦' },
      { code: 'EWALLET', name: 'E-Wallet (OVO, Dana, LinkAja)', icon: '📱' },
      { code: 'RETAIL_OUTLET', name: 'Retail Outlet (Indomaret, Alfamart)', icon: '🏪' },
      { code: 'CREDIT_CARD', name: 'Kartu Kredit', icon: '💳' },
      { code: 'QR_CODE', name: 'QRIS', icon: '📲' }
    ];

    return methods.map(method => ({
      gateway: 'xendit',
      code: method.code,
      name: method.name,
      icon: method.icon,
      fee: 0,
      feePercent: 0,
      minAmount: 1000,
      maxAmount: 999999999,
      active: true
    }));
  } catch (error) {
    logger.warn('[VoucherPayment] Xendit methods fetch failed:', error.message);
    return [];
  }
}

/**
 * Get Duitku payment methods
 */
async function getDuitkuPaymentMethods(settings) {
  try {
    // Duitku payment methods (hardcoded)
    const methods = [
      { code: 'OV', name: 'Outlet Retail', icon: '🏪' },
      { code: 'BT', name: 'Transfer Bank', icon: '🏦' },
      { code: 'CC', name: 'Kartu Kredit', icon: '💳' },
      { code: 'QRIS', name: 'QRIS', icon: '📲' },
      { code: 'EWALLET', name: 'E-Wallet', icon: '📱' }
    ];

    return methods.map(method => ({
      gateway: 'duitku',
      code: method.code,
      name: method.name,
      icon: method.icon,
      fee: 0,
      feePercent: 0,
      minAmount: 1000,
      maxAmount: 999999999,
      active: true
    }));
  } catch (error) {
    logger.warn('[VoucherPayment] Duitku methods fetch failed:', error.message);
    return [];
  }
}

/**
 * Create voucher payment transaction
 */
async function createVoucherPayment(voucherOrder, paymentMethod, appUrl = '') {
  const settings = getSettingsWithCache();

  if (!voucherOrder || !voucherOrder.id) {
    throw new Error('Voucher order tidak valid');
  }

  if (!paymentMethod || !paymentMethod.gateway) {
    throw new Error('Payment method tidak valid');
  }

  const gateway = paymentMethod.gateway.toLowerCase();

  // Prepare invoice object
  const invoice = {
    id: voucherOrder.id,
    amount: voucherOrder.price,
    item_name: `Voucher Hotspot ${voucherOrder.profile_name}`,
    sku: `VOUCHER-${voucherOrder.id}`
  };

  // Prepare customer object
  const customer = {
    name: 'Pembeli Voucher',
    phone: voucherOrder.buyer_phone,
    email: ''
  };

  // Prepare options
  const opts = {
    orderPrefix: 'VOUCHER',
    itemName: `Voucher Hotspot ${voucherOrder.profile_name}`,
    sku: `VOUCHER-${voucherOrder.id}`,
    callbackPath: '/customer/payment/callback',
    returnPath: `/customer/voucher?order=${voucherOrder.id}`
  };

  try {
    let result;

    switch (gateway) {
      case 'tripay':
        result = await paymentSvc.createTripayTransaction(
          invoice,
          customer,
          paymentMethod.code,
          appUrl,
          opts
        );
        break;

      case 'midtrans':
        result = await paymentSvc.createMidtransTransaction(
          invoice,
          customer,
          'snap',
          appUrl,
          opts
        );
        break;

      case 'xendit':
        result = await createXenditPayment(invoice, customer, paymentMethod.code, appUrl, opts);
        break;

      case 'duitku':
        result = await createDuitkuPayment(invoice, customer, paymentMethod.code, appUrl, opts);
        break;

      default:
        throw new Error(`Gateway ${gateway} tidak didukung`);
    }

    return {
      success: true,
      gateway,
      paymentMethod: paymentMethod.code,
      link: result.link,
      reference: result.reference || result.order_id,
      orderId: result.order_id,
      payload: result.payload
    };
  } catch (error) {
    logger.error(`[VoucherPayment] Error creating payment (${gateway}):`, error.message);
    throw error;
  }
}

/**
 * Create Xendit payment
 */
async function createXenditPayment(invoice, customer, method, appUrl, opts) {
  const settings = getSettingsWithCache();
  const apiKey = settings.xendit_api_key;
  const isLive = settings.xendit_mode === 'live' || settings.xendit_mode === 'production';

  const baseUrl = isLive
    ? 'https://api.xendit.co/v2/invoices'
    : 'https://api.sandbox.xendit.co/v2/invoices';

  const invoiceId = `VOUCHER-${invoice.id}-${Date.now()}`;
  const finalAppUrl = appUrl || settings.app_url || '';

  const payload = {
    external_id: invoiceId,
    amount: invoice.amount,
    description: opts.itemName,
    customer: {
      given_names: customer.name,
      email: customer.email || `voucher${invoice.id}@alijaya.net`,
      mobile_number: customer.phone
    },
    payment_methods: [method],
    callback_url: finalAppUrl ? `${finalAppUrl}${opts.callbackPath}` : undefined,
    redirect_url: finalAppUrl ? `${finalAppUrl}${opts.returnPath}` : undefined
  };

  try {
    const response = await axios.post(baseUrl, payload, {
      auth: { username: apiKey, password: '' },
      timeout: 5000
    });

    if (response.data && response.data.id) {
      return {
        success: true,
        link: response.data.invoice_url,
        reference: response.data.id,
        order_id: invoiceId,
        payload: response.data
      };
    }

    throw new Error('Xendit response tidak valid');
  } catch (error) {
    const msg = error.response ? JSON.stringify(error.response.data) : error.message;
    logger.error('[Xendit] Error:', msg);
    throw new Error('Xendit Error: ' + msg);
  }
}

/**
 * Create Duitku payment
 */
async function createDuitkuPayment(invoice, customer, method, appUrl, opts) {
  const settings = getSettingsWithCache();
  const merchantCode = settings.duitku_merchant_code;
  const apiKey = settings.duitku_api_key;
  const isLive = settings.duitku_mode === 'live' || settings.duitku_mode === 'production';

  const baseUrl = isLive
    ? 'https://api-prod.duitku.com/api/merchant/v2/inquiry'
    : 'https://api-sandbox.duitku.com/api/merchant/v2/inquiry';

  const invoiceId = `VOUCHER${invoice.id}${Date.now()}`;
  const finalAppUrl = appUrl || settings.app_url || '';

  const signature = crypto
    .md5(merchantCode + invoiceId + invoice.amount + apiKey)
    .digest('hex');

  const payload = {
    merchantCode,
    paymentAmount: invoice.amount,
    paymentMethod: method,
    merchantOrderId: invoiceId,
    productDetails: opts.itemName,
    customerVaName: customer.name,
    email: customer.email || `voucher${invoice.id}@alijaya.net`,
    phoneNumber: customer.phone,
    returnUrl: finalAppUrl ? `${finalAppUrl}${opts.returnPath}` : undefined,
    callbackUrl: finalAppUrl ? `${finalAppUrl}${opts.callbackPath}` : undefined,
    signature
  };

  try {
    const response = await axios.post(baseUrl, payload, {
      timeout: 5000
    });

    if (response.data && response.data.statusCode === '00') {
      return {
        success: true,
        link: response.data.paymentUrl,
        reference: response.data.reference,
        order_id: invoiceId,
        payload: response.data
      };
    }

    throw new Error(response.data.statusMessage || 'Duitku response tidak valid');
  } catch (error) {
    const msg = error.response ? JSON.stringify(error.response.data) : error.message;
    logger.error('[Duitku] Error:', msg);
    throw new Error('Duitku Error: ' + msg);
  }
}

/**
 * Get default payment gateway
 */
function getDefaultPaymentGateway() {
  const settings = getSettingsWithCache();
  const defaultGateway = settings.default_gateway || 'tripay';

  // Check if default gateway is enabled
  const gatewaySettings = {
    tripay: { enabled: settings.tripay_enabled, key: settings.tripay_api_key },
    midtrans: { enabled: settings.midtrans_enabled, key: settings.midtrans_server_key },
    xendit: { enabled: settings.xendit_enabled, key: settings.xendit_api_key },
    duitku: { enabled: settings.duitku_enabled, key: settings.duitku_api_key }
  };

  if (gatewaySettings[defaultGateway]?.enabled && gatewaySettings[defaultGateway]?.key) {
    return defaultGateway;
  }

  // Fallback to first enabled gateway
  for (const [gateway, config] of Object.entries(gatewaySettings)) {
    if (config.enabled && config.key) {
      return gateway;
    }
  }

  return null;
}

module.exports = {
  getAvailablePaymentMethods,
  getTripayPaymentMethods,
  getMidtransPaymentMethods,
  getXenditPaymentMethods,
  getDuitkuPaymentMethods,
  createVoucherPayment,
  createXenditPayment,
  createDuitkuPayment,
  getDefaultPaymentGateway
};
