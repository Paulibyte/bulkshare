// OPay Checkout (Cashier / Express Checkout) integration.
// Create: POST {base}/api/v1/international/cashier/create  (Bearer PUBLIC key + MerchantId)
// Status: POST {base}/api/v1/international/cashier/status  (Bearer HMAC-SHA512(body, SECRET key) + MerchantId)
// Amounts are sent in kobo (naira x 100).
// We never trust the callback body on its own: every callback / return triggers a signed status query.
const crypto = require('crypto');

const cfg = () => ({
  base: (process.env.OPAY_BASE_URL || 'https://testapi.opaycheckout.com').replace(/\/$/, ''),
  merchantId: process.env.OPAY_MERCHANT_ID || '',
  publicKey: process.env.OPAY_PUBLIC_KEY || '',
  secretKey: process.env.OPAY_SECRET_KEY || '',
});

function enabled() {
  const c = cfg();
  return Boolean(c.merchantId && c.publicKey && c.secretKey);
}

async function post(path, body, bearer) {
  const c = cfg();
  const res = await fetch(c.base + '/api/v1/international' + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + bearer, MerchantId: c.merchantId },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { throw new Error(`OPay returned non-JSON (${res.status}): ${text.slice(0, 200)}`); }
  return json;
}

async function createCashier({ order, product, baseUrl }) {
  const c = cfg();
  const body = {
    country: 'NG',
    reference: order.code,
    amount: { total: order.total * 100, currency: 'NGN' },
    returnUrl: `${baseUrl}/payments/opay/return?code=${encodeURIComponent(order.code)}`,
    cancelUrl: `${baseUrl}/order/${order.code}?t=${order.token}`,
    callbackUrl: `${baseUrl}/payments/opay/callback`,
    expireAt: 30,
    product: { name: product.title.slice(0, 80), description: `${order.slots} slot(s) - ${order.code}` },
    userInfo: {
      userId: order.phone, userName: order.customer_name,
      userMobile: order.phone, userEmail: order.email || undefined,
    },
  };
  const r = await post('/cashier/create', body, c.publicKey);
  if (r.code !== '00000' || !r.data || !r.data.cashierUrl) {
    throw new Error(`OPay create failed: ${r.code} ${r.message || ''}`);
  }
  return r.data; // { cashierUrl, orderNo, reference, status, ... }
}

async function queryStatus(reference) {
  const c = cfg();
  const body = { country: 'NG', reference };
  const signature = crypto.createHmac('sha512', c.secretKey).update(JSON.stringify(body)).digest('hex');
  const r = await post('/cashier/status', body, signature);
  if (r.code !== '00000' || !r.data) throw new Error(`OPay status failed: ${r.code} ${r.message || ''}`);
  return r.data; // { reference, orderNo, status: INITIAL|PENDING|SUCCESS|FAIL|CLOSE, amount: {total, currency} }
}

module.exports = { enabled, createCashier, queryStatus };
