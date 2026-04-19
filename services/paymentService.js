/**
 * Service: Integrasi Payment Gateway (Tripay)
 */
const axios = require('axios');
const crypto = require('crypto');
const { getSettingsWithCache } = require('../config/settingsManager');

/**
 * Membuat transaksi baru di Tripay
 */
async function createTripayTransaction(invoice, customer, method = 'QRIS') {
  const settings = getSettingsWithCache();
  if (!settings.tripay_enabled) throw new Error('Payment Gateway tidak aktif.');

  const apiKey = settings.tripay_api_key;
  const privateKey = settings.tripay_private_key;
  const merchantCode = settings.tripay_merchant_code;
  const baseUrl = settings.tripay_mode === 'live' 
    ? 'https://tripay.co.id/api/transaction/create' 
    : 'https://tripay.co.id/api-sandbox/transaction/create';

  const merchantRef = `INV-${invoice.id}-${Date.now()}`;
  const amount = invoice.amount;

  // Generate Signature
  const signature = crypto.createHmac('sha256', privateKey)
    .update(merchantCode + merchantRef + amount)
    .digest('hex');

  const payload = {
    method: method,
    merchant_ref: merchantRef,
    amount: amount,
    customer_name: customer.name || 'Pelanggan',
    customer_email: 'customer@mail.com', // Tripay butuh email, kita kasih placeholder
    customer_phone: customer.phone || '',
    order_items: [
      {
        sku: invoice.package_name || 'INTERNET',
        name: `Tagihan Internet ${invoice.package_name || ''}`,
        price: amount,
        quantity: 1
      }
    ],
    signature: signature
  };

  try {
    const res = await axios.post(baseUrl, payload, {
      headers: { Authorization: `Bearer ${apiKey}` }
    });
    return res.data;
  } catch (error) {
    const msg = error.response ? JSON.stringify(error.response.data) : error.message;
    throw new Error('Gagal membuat transaksi ke Tripay: ' + msg);
  }
}

/**
 * Validasi Webhook Signature dari Tripay
 */
function verifyWebhook(jsonBody, signature, privateKey) {
  const callbackSignature = crypto.createHmac('sha256', privateKey)
    .update(jsonBody)
    .digest('hex');
  return callbackSignature === signature;
}

module.exports = {
  createTripayTransaction,
  verifyWebhook
};
