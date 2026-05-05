const express = require('express');
const router = express.Router();
const { getSetting } = require('../config/settingsManager');
const agentSvc = require('../services/agentService');
const billingSvc = require('../services/billingService');
const customerSvc = require('../services/customerService');

function requireAgentSession(req, res, next) {
  if (req.session && req.session.isAgent && req.session.agentId) return next();
  return res.redirect('/agent/login');
}

function flashMsg(req) {
  const m = req.session._msg;
  delete req.session._msg;
  return m || null;
}

function popReceipt(req) {
  const r = req.session._agentReceipt;
  delete req.session._agentReceipt;
  return r || null;
}

function company() {
  return getSetting('company_header', 'ISP App');
}

router.get('/login', (req, res) => {
  if (req.session && req.session.isAgent) return res.redirect('/agent');
  res.render('agent/login', { title: 'Login Agent', company: company(), error: null });
});

router.post('/login', express.urlencoded({ extended: true }), (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  const agent = agentSvc.authenticate(username, password);
  if (agent) {
    req.session.isAgent = true;
    req.session.agentId = agent.id;
    req.session.agentName = agent.name;
    return res.redirect('/agent');
  }
  return res.render('agent/login', { title: 'Login Agent', company: company(), error: 'Username atau password salah!' });
});

router.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/agent/login');
});

router.get('/', requireAgentSession, (req, res) => {
  const agentId = req.session.agentId;
  const agent = agentSvc.getAgentById(agentId);
  const q = String(req.query.q || '').trim();

  const invoices = q ? billingSvc.getInvoicesByAny(q) : [];
  const unpaidInvoices = (Array.isArray(invoices) ? invoices : []).filter(i => i && i.status !== 'paid');

  const prices = agentSvc
    .getAgentPrices(agentId)
    .filter(p => p && p.is_active)
    .sort((a, b) => {
      const as = Number(a.sell_price || 0);
      const bs = Number(b.sell_price || 0);
      if (as !== bs) return as - bs;
      const ab = Number(a.buy_price || 0);
      const bb = Number(b.buy_price || 0);
      if (ab !== bb) return ab - bb;
      const ap = String(a.profile_name || '');
      const bp = String(b.profile_name || '');
      return ap.localeCompare(bp);
    });
  const txs = agentSvc.listAgentTransactions({ agentId, limit: 40 });

  const digiflazzMarkup = Number(getSetting('digiflazz_markup', 0) || 0);
  const digiflazzConfigured = Boolean(
    String(getSetting('digiflazz_username', '') || '').trim() &&
    String(getSetting('digiflazz_api_key', '') || '').trim()
  );

  const digiflazzCatalogProducts = digiflazzConfigured
    ? agentSvc.listDigiflazzProducts({ include_inactive: false, limit: 3000 })
    : [];

  const digiflazzBrandsMap = new Map();
  for (const p of (digiflazzCatalogProducts || [])) {
    const brandName = String(p.brand || '').trim() || '-';
    const categoryName = String(p.category || '').trim() || '-';
    const key = `${categoryName}__${brandName}`;
    if (!digiflazzBrandsMap.has(key)) {
      digiflazzBrandsMap.set(key, { key, name: brandName, category: categoryName, items: [] });
    }
    digiflazzBrandsMap.get(key).items.push(p);
  }
  const digiflazzBrandsData = Array.from(digiflazzBrandsMap.values());
  const digiflazzCategories = Array.from(new Set((digiflazzCatalogProducts || []).map(p => String(p.category || '').trim()).filter(Boolean))).sort((a, b) => a.localeCompare(b));

  res.render('agent/dashboard', {
    title: 'Dashboard Agent',
    company: company(),
    agent,
    q,
    invoices: unpaidInvoices,
    prices,
    txs,
    digiflazzMarkup,
    digiflazzConfigured,
    digiflazzCategories,
    digiflazzBrandsData,
    msg: flashMsg(req),
    receipt: popReceipt(req)
  });
});

router.post('/pay-invoice', requireAgentSession, express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const invoiceId = Number(req.body.invoice_id || 0);
    if (!invoiceId) throw new Error('Invoice ID tidak valid');
    const note = String(req.body.note || '').trim();
    const result = await agentSvc.payInvoiceAsAgent(req.session.agentId, invoiceId, note);

    const customer = customerSvc.getCustomerById(result.invoice.customer_id);
    const settings = { whatsapp_enabled: getSetting('whatsapp_enabled', false) };

    let waSent = false;
    if (settings.whatsapp_enabled && customer && customer.phone) {
      try {
        const { sendWA, whatsappStatus } = await import('../services/whatsappBot.mjs');
        if (whatsappStatus.connection === 'open') {
          const msg =
            `✅ *PEMBAYARAN BERHASIL*\n\n` +
            `👤 *Pelanggan:* ${customer.name}\n` +
            `🧾 *Invoice:* #${result.invoice.id}\n` +
            `📅 *Periode:* ${result.invoice.period_month}/${result.invoice.period_year}\n` +
            `💰 *Nominal Tagihan:* Rp ${Number(result.invoice.amount || 0).toLocaleString('id-ID')}\n` +
            `🏷️ *Dibayar Via:* Agent ${result.agent.name}\n\n` +
            `Terima kasih.`;
          await sendWA(customer.phone, msg);
          waSent = true;
        }
      } catch (e) {}
    }

    req.session._agentReceipt = {
      type: 'invoice',
      tx_id: Number(result.tx?.id || 0),
      created_at: new Date().toISOString(),
      invoice_id: result.invoice.id,
      customer_name: customer?.name || '',
      customer_phone: customer?.phone || '',
      period: `${result.invoice.period_month}/${result.invoice.period_year}`,
      amount: Number(result.invoice.amount || 0),
      cost: Number(result.tx.cost || 0),
      fee: Number(result.tx.fee || 0),
      waSent
    };

    req.session._msg = { type: 'success', text: 'Pembayaran berhasil diproses.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal: ' + e.message };
  }
  res.redirect('/agent');
});

router.post('/sell-voucher', requireAgentSession, express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const priceId = Number(req.body.price_id || 0);
    if (!priceId) throw new Error('Harga voucher tidak valid');
    const buyerPhone = String(req.body.buyer_phone || '').trim();
    const result = await agentSvc.sellVoucherAsAgent(req.session.agentId, priceId, {});

    let waSent = false;
    if (getSetting('whatsapp_enabled', false) && buyerPhone) {
      try {
        const { sendWA, whatsappStatus } = await import('../services/whatsappBot.mjs');
        if (whatsappStatus.connection === 'open') {
          const msg =
            `🎫 *VOUCHER HOTSPOT*\n\n` +
            `📦 *Paket:* ${result.receipt.profile}\n` +
            `${result.receipt.validity ? `⏱️ *Masa Aktif:* ${result.receipt.validity}\n` : ''}` +
            `👤 *User:* ${result.receipt.code}\n` +
            `🔑 *Pass:* ${result.receipt.password}\n` +
            `💰 *Harga:* Rp ${Number(result.receipt.sell_price || 0).toLocaleString('id-ID')}\n\n` +
            `Simpan voucher ini.`;
          await sendWA(buyerPhone, msg);
          waSent = true;
        }
      } catch (e) {}
    }

    req.session._agentReceipt = {
      type: 'voucher',
      tx_id: Number(result.tx?.id || 0),
      created_at: new Date().toISOString(),
      profile: result.receipt.profile,
      validity: result.receipt.validity,
      code: result.receipt.code,
      password: result.receipt.password,
      sell_price: Number(result.receipt.sell_price || 0),
      buy_price: Number(result.price.buy_price || 0),
      waSent,
      buyer_phone: buyerPhone
    };

    req.session._msg = { type: 'success', text: 'Voucher berhasil dibuat.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal: ' + e.message };
  }
  res.redirect('/agent');
});

router.post('/pulsa', requireAgentSession, express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const sku = String(req.body.sku || '').trim();
    const target = String(req.body.target || '').trim();
    const buyerPhone = String(req.body.buyer_phone || '').trim();
    const sellPrice = req.body.sell_price !== undefined && String(req.body.sell_price).trim() !== ''
      ? Number(req.body.sell_price)
      : 0;

    const result = await agentSvc.buyPulsaAsAgent(req.session.agentId, sku, target, { sell_price: sellPrice });

    const status = String(result?.tx?.digi_status || 'pending').toLowerCase();
    const isSuccess = status === 'success';
    const isFailed = status === 'failed';

    let waSent = false;
    if (getSetting('whatsapp_enabled', false) && buyerPhone) {
      try {
        const { sendWA, whatsappStatus } = await import('../services/whatsappBot.mjs');
        if (whatsappStatus.connection === 'open') {
          const msg =
            `${isSuccess ? '✅' : isFailed ? '❌' : '⏳'} *TRANSAKSI PULSA*\n\n` +
            `📦 *SKU:* ${sku}\n` +
            `🎯 *Target:* ${target}\n` +
            `🧾 *Ref ID:* ${result?.tx?.digi_ref_id || '-'}\n` +
            `📡 *Status:* ${status.toUpperCase()}\n` +
            `${result?.tx?.digi_sn ? `🔢 *SN:* ${result.tx.digi_sn}\n` : ''}` +
            `${result?.tx?.digi_message ? `💬 *Pesan:* ${result.tx.digi_message}\n` : ''}` +
            `\nTerima kasih.`;
          await sendWA(buyerPhone, msg);
          waSent = true;
        }
      } catch (e) {}
    }

    req.session._agentReceipt = {
      type: 'pulsa',
      tx_id: Number(result?.tx?.id || 0),
      created_at: new Date().toISOString(),
      sku,
      target,
      ref_id: result?.tx?.digi_ref_id || '',
      trx_id: result?.tx?.digi_trx_id || '',
      sn: result?.tx?.digi_sn || '',
      status,
      message: result?.tx?.digi_message || '',
      buy_price: Number(result?.tx?.amount_buy || 0),
      sell_price: Number(result?.tx?.amount_sell || 0),
      waSent,
      buyer_phone: buyerPhone
    };

    req.session._msg = { type: isFailed ? 'error' : isSuccess ? 'success' : 'warning', text: isFailed ? 'Transaksi gagal (saldo otomatis direfund jika gagal langsung).' : isSuccess ? 'Transaksi berhasil diproses.' : 'Transaksi dibuat (pending). Silakan cek status di riwayat.' };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal: ' + e.message };
  }
  res.redirect('/agent');
});

router.post('/api/pulsa/order', requireAgentSession, express.json({ limit: '50kb' }), async (req, res) => {
  try {
    const sku = String(req.body?.sku || '').trim();
    const target = String(req.body?.target || '').trim();
    const buyerPhone = String(req.body?.buyer_phone || '').trim();
    const sellPrice = req.body?.sell_price !== undefined && String(req.body.sell_price).trim() !== ''
      ? Number(req.body.sell_price)
      : 0;

    const result = await agentSvc.buyPulsaAsAgent(req.session.agentId, sku, target, { sell_price: sellPrice });
    const status = String(result?.tx?.digi_status || 'pending').toLowerCase();
    const agentNow = agentSvc.getAgentById(req.session.agentId);

    const isSuccess = status === 'success';
    const isFailed = status === 'failed';
    let waSent = false;
    if (getSetting('whatsapp_enabled', false) && buyerPhone) {
      try {
        const { sendWA, whatsappStatus } = await import('../services/whatsappBot.mjs');
        if (whatsappStatus.connection === 'open') {
          const msg =
            `${isSuccess ? '✅' : isFailed ? '❌' : '⏳'} *TRANSAKSI PULSA*\n\n` +
            `📦 *SKU:* ${sku}\n` +
            `🎯 *Target:* ${target}\n` +
            `💰 *Harga:* Rp ${Number(result?.tx?.amount_sell || 0).toLocaleString('id-ID')}\n` +
            `🧾 *Ref ID:* ${result?.tx?.digi_ref_id || '-'}\n` +
            `📡 *Status:* ${status.toUpperCase()}\n` +
            `${result?.tx?.digi_sn ? `🔢 *SN:* ${result.tx.digi_sn}\n` : ''}` +
            `${result?.tx?.digi_message ? `💬 *Pesan:* ${result.tx.digi_message}\n` : ''}` +
            `\nTerima kasih.`;
          await sendWA(buyerPhone, msg);
          waSent = true;
        }
      } catch (e) {}
    }

    req.session._agentReceipt = {
      type: 'pulsa',
      tx_id: Number(result?.tx?.id || 0),
      created_at: new Date().toISOString(),
      sku,
      target,
      ref_id: result?.tx?.digi_ref_id || '',
      trx_id: result?.tx?.digi_trx_id || '',
      sn: result?.tx?.digi_sn || '',
      status,
      message: result?.tx?.digi_message || '',
      buy_price: Number(result?.tx?.amount_buy || 0),
      sell_price: Number(result?.tx?.amount_sell || 0),
      waSent,
      buyer_phone: buyerPhone
    };

    return res.json({
      success: true,
      status,
      message: result?.tx?.digi_message || '',
      ref_id: result?.tx?.digi_ref_id || '',
      sn: result?.tx?.digi_sn || '',
      price: Number(result?.tx?.amount_sell || 0),
      wa_sent: waSent,
      balance_after: agentNow ? Number(agentNow.balance || 0) : null
    });
  } catch (e) {
    return res.status(400).json({ success: false, message: e.message });
  }
});

router.post('/pulsa/check', requireAgentSession, express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const txId = Number(req.body.tx_id || 0);
    if (!txId) throw new Error('ID transaksi tidak valid');
    const result = await agentSvc.checkPulsaStatusAsAgent(req.session.agentId, txId);
    const status = String(result?.tx?.digi_status || '').toLowerCase();
    req.session._msg = { type: status === 'success' ? 'success' : status === 'failed' ? 'error' : 'warning', text: `Status transaksi #${txId}: ${status || '-'}` };
  } catch (e) {
    req.session._msg = { type: 'error', text: 'Gagal cek status: ' + e.message };
  }
  res.redirect('/agent');
});

router.post('/receipt/clear', requireAgentSession, (req, res) => {
  try {
    delete req.session._agentReceipt;
  } catch {}
  res.redirect('/agent');
});

router.get('/print/tx/:id', requireAgentSession, (req, res) => {
  try {
    const txId = Number(req.params.id || 0);
    if (!txId) return res.status(400).send('ID transaksi tidak valid');

    const tx = agentSvc.getAgentTransactionById(req.session.agentId, txId);
    if (!tx) return res.status(404).send('Transaksi tidak ditemukan');

    if (tx.type === 'voucher_sale') {
      const settings = {
        company_address: getSetting('company_address', ''),
        company_phone: getSetting('company_phone', ''),
        whatsapp_admin_numbers: getSetting('whatsapp_admin_numbers', [])
      };
      return res.render('agent/print_thermal_voucher', {
        company: company(),
        settings,
        tx
      });
    }

    if (tx.type === 'invoice_payment') {
      const invoice = billingSvc.getInvoiceById(tx.invoice_id);
      const customer = customerSvc.getCustomerById(tx.customer_id);
      const settings = {
        company_address: getSetting('company_address', ''),
        company_phone: getSetting('company_phone', ''),
        whatsapp_admin_numbers: getSetting('whatsapp_admin_numbers', [])
      };
      return res.render('agent/print_thermal_invoice', {
        company: company(),
        settings,
        tx,
        invoice,
        customer
      });
    }

    return res.status(400).send('Jenis transaksi belum didukung untuk print');
  } catch (e) {
    return res.status(500).send('Gagal print: ' + e.message);
  }
});

module.exports = router;
