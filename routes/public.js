const express = require('express');
const { db, getSettings } = require('../db');
const pools = require('../lib/pools');
const opay = require('../lib/opay');
const { verifyCsrf, flash, proofUpload, baseUrl } = require('../lib/util');

const router = express.Router();

const PRODUCT_SQL = `SELECT p.*, c.name AS category_name, c.slug AS category_slug,
  l.name AS location_name, l.address AS location_address, l.notes AS location_notes
  FROM products p LEFT JOIN categories c ON c.id = p.category_id LEFT JOIN locations l ON l.id = p.location_id`;

function listProducts({ categoryId, q, show }) {
  const where = [], args = [];
  if (show === 'past') where.push(`p.status IN ('closed','completed')`);
  else where.push(`p.status IN ('open','closed')`);
  if (categoryId) { where.push('p.category_id = ?'); args.push(categoryId); }
  if (q) { where.push('(p.title LIKE ? OR p.description LIKE ?)'); args.push(`%${q}%`, `%${q}%`); }
  const order = show === 'past' ? 'p.closed_at DESC' : `CASE p.status WHEN 'open' THEN 0 ELSE 1 END, p.sharing_date IS NULL, p.sharing_date`;
  return pools.withStats(db.prepare(`${PRODUCT_SQL} WHERE ${where.join(' AND ')} ORDER BY ${order}`).all(...args));
}

router.get('/', (req, res) => {
  pools.expireStale();
  const q = (req.query.q || '').trim().slice(0, 60);
  const show = req.query.show === 'past' ? 'past' : 'current';
  res.render('home', { title: null, products: listProducts({ q, show }), q, show, activeCat: null });
});

router.get('/category/:slug', (req, res, next) => {
  pools.expireStale();
  const cat = db.prepare('SELECT * FROM categories WHERE slug = ?').get(req.params.slug);
  if (!cat) return next();
  res.render('home', { title: cat.name, products: listProducts({ categoryId: cat.id }), q: '', show: 'current', activeCat: cat });
});

router.get('/p/:slug', (req, res, next) => {
  pools.expireStale();
  const p = db.prepare(`${PRODUCT_SQL} WHERE p.slug = ? AND p.status != 'draft'`).get(req.params.slug);
  if (!p) return next();
  p.stats = pools.stats(p);
  const areas = db.prepare('SELECT * FROM delivery_areas ORDER BY name').all();
  const recent = db.prepare(`SELECT customer_name, slots, paid_at FROM orders
     WHERE product_id = ? AND status = 'paid' ORDER BY paid_at DESC LIMIT 8`).all(p.id)
    .map(r => ({ ...r, display: r.customer_name.split(/\s+/)[0] + ' ' + ((r.customer_name.split(/\s+/)[1] || '')[0] || '') }));
  res.render('product', { title: p.title, p, areas, recent, form: req.session.lastForm || {}, shareUrl: `${baseUrl(req)}/p/${p.slug}` });
  delete req.session.lastForm;
});

router.post('/p/:slug/join', verifyCsrf, (req, res, next) => {
  const p = db.prepare('SELECT * FROM products WHERE slug = ?').get(req.params.slug);
  if (!p) return next();
  const b = req.body;
  const back = () => { req.session.lastForm = { ...b, _csrf: undefined }; res.redirect(`/p/${p.slug}#join`); };
  const phone = (b.phone || '').replace(/[^\d+]/g, '');
  if (!b.customer_name || b.customer_name.trim().length < 3) { flash(req, 'error', 'Enter your full name.'); return back(); }
  if (phone.length < 10) { flash(req, 'error', 'Enter a valid phone number.'); return back(); }
  if (b.payment_method === 'opay' && !opay.enabled()) { flash(req, 'error', 'OPay is not available right now. Choose bank transfer.'); return back(); }
  try {
    const r = pools.reserve(p.id, { ...b, phone });
    res.redirect(`/order/${r.code}?t=${r.token}`);
  } catch (e) {
    if (!(e instanceof pools.PoolError)) return next(e);
    flash(req, 'error', e.message);
    back();
  }
});

function loadOrder(req) {
  const o = db.prepare(`SELECT o.*, p.title, p.slug, p.sharing_date, p.status AS product_status, p.image,
      l.name AS location_name, l.address AS location_address
    FROM orders o JOIN products p ON p.id = o.product_id LEFT JOIN locations l ON l.id = p.location_id
    WHERE o.code = ?`).get(req.params.code);
  if (!o || o.token !== (req.query.t || req.body?.t)) return null;
  return o;
}

router.get('/order/:code', (req, res, next) => {
  pools.expireStale();
  const o = loadOrder(req);
  if (!o) return next();
  res.render('order', { title: `Order ${o.code}`, o });
});

router.post('/order/:code/proof', proofUpload.single('proof'), verifyCsrf, (req, res, next) => {
  const o = loadOrder(req);
  if (!o) return next();
  const link = `/order/${o.code}?t=${o.token}`;
  if (!['pending', 'expired'].includes(o.status) || o.payment_method !== 'bank') { flash(req, 'error', 'This order cannot take a transfer proof now.'); return res.redirect(link); }
  if (!req.body.transfer_sender || req.body.transfer_sender.trim().length < 3) {
    flash(req, 'error', 'Enter the name on the account you paid from.'); return res.redirect(link);
  }
  // An expired order can still submit proof; admin decides (markPaid handles "no slots left" as refund_due).
  db.prepare(`UPDATE orders SET status = 'awaiting_confirmation', transfer_sender = ?, transfer_note = ?, transfer_proof = COALESCE(?, transfer_proof) WHERE id = ?`)
    .run(req.body.transfer_sender.trim().slice(0, 100), (req.body.transfer_note || '').trim().slice(0, 300) || null,
      req.file ? req.file.filename : null, o.id);
  flash(req, 'success', 'Thanks! We have received your transfer details. Your slot is held while we confirm the payment.');
  res.redirect(link);
});

router.post('/order/:code/cancel', verifyCsrf, (req, res, next) => {
  const o = loadOrder(req);
  if (!o) return next();
  if (o.status === 'pending') pools.setOrderStatus(o.id, 'cancelled', 'Cancelled by customer.');
  flash(req, 'success', 'Your reservation was cancelled and the slot released.');
  res.redirect(`/order/${o.code}?t=${o.token}`);
});

router.post('/order/:code/opay', verifyCsrf, async (req, res, next) => {
  const o = loadOrder(req);
  if (!o) return next();
  const link = `/order/${o.code}?t=${o.token}`;
  if (o.status !== 'pending' || o.payment_method !== 'opay') return res.redirect(link);
  try {
    // Re-use the checkout already opened for this order (OPay refuses a second create with the same reference)
    if (o.opay_url) {
      const st = await verifyOpay(o).catch(() => null);
      if (st === 'paid' || st === 'refund_due') return res.redirect(link);
      if (!st || st === 'INITIAL' || st === 'PENDING') return res.redirect(303, o.opay_url);
      flash(req, 'error', 'The OPay checkout for this order has closed. Please start a new order or pay by bank transfer.');
      return res.redirect(link);
    }
    const p = db.prepare('SELECT * FROM products WHERE id = ?').get(o.product_id);
    const data = await opay.createCashier({ order: o, product: p, baseUrl: baseUrl(req) });
    db.prepare('UPDATE orders SET opay_order_no = ?, opay_status = ?, opay_url = ? WHERE id = ?')
      .run(data.orderNo || null, data.status || 'INITIAL', data.cashierUrl, o.id);
    res.redirect(303, data.cashierUrl);
  } catch (e) {
    console.error('[opay]', e.message);
    flash(req, 'error', 'Could not open OPay checkout right now. Please try again in a minute, or switch to bank transfer.');
    res.redirect(link);
  }
});

router.post('/order/:code/switch-bank', verifyCsrf, (req, res, next) => {
  const o = loadOrder(req);
  if (!o) return next();
  if (o.status === 'pending' && o.payment_method === 'opay' && !o.opay_url) {
    const mins = Math.round((parseFloat(getSettings().bank_hold_hours) || 6) * 60);
    db.prepare(`UPDATE orders SET payment_method = 'bank', expires_at = datetime('now', ?) WHERE id = ?`).run(`+${mins} minutes`, o.id);
  }
  res.redirect(`/order/${o.code}?t=${o.token}`);
});

// Verify an OPay payment by asking OPay directly (never trust the browser or callback body alone)
async function verifyOpay(orderRow) {
  const data = await opay.queryStatus(orderRow.code);
  db.prepare('UPDATE orders SET opay_status = ?, opay_order_no = COALESCE(opay_order_no, ?) WHERE id = ?')
    .run(data.status, data.orderNo || null, orderRow.id);
  if (data.status === 'SUCCESS') {
    const kobo = Number(data.amount && data.amount.total);
    if (kobo && kobo < orderRow.total * 100) {
      pools.setOrderStatus(orderRow.id, 'awaiting_confirmation', `OPay amount ${kobo / 100} is less than order total.`);
      return 'mismatch';
    }
    return pools.markPaid(orderRow.id, `OPay ${data.orderNo || ''}`.trim());
  }
  return data.status;
}

router.get('/payments/opay/return', async (req, res, next) => {
  const o = db.prepare('SELECT * FROM orders WHERE code = ?').get(String(req.query.code || ''));
  if (!o) return next();
  try { await verifyOpay(o); } catch (e) { console.error('[opay return]', e.message); }
  res.redirect(`/order/${o.code}?t=${o.token}`);
});

router.post('/payments/opay/callback', async (req, res) => {
  try {
    const payload = req.body && (req.body.payload || req.body);
    const ref = payload && (payload.reference || payload.merchantReference);
    const o = ref && db.prepare('SELECT * FROM orders WHERE code = ?').get(String(ref));
    if (o && o.payment_method === 'opay') await verifyOpay(o);
  } catch (e) { console.error('[opay callback]', e.message); }
  res.json({ code: '00000', message: 'SUCCESS' });
});

router.get('/track', (req, res) => res.render('track', { title: 'Track my order', error: null, codeVal: '', phoneVal: '' }));
router.post('/track', verifyCsrf, (req, res) => {
  const codeVal = String(req.body.code || '').trim().toUpperCase();
  const phoneVal = String(req.body.phone || '').replace(/[^\d+]/g, '');
  const o = db.prepare('SELECT code, token, phone FROM orders WHERE code = ?').get(codeVal);
  const last10 = s => s.replace(/\D/g, '').slice(-10);
  if (!o || last10(o.phone) !== last10(phoneVal)) {
    return res.render('track', { title: 'Track my order', error: 'No order matches that reference and phone number.', codeVal, phoneVal });
  }
  res.redirect(`/order/${o.code}?t=${o.token}`);
});

router.get('/how-it-works', (req, res) => res.render('how', { title: 'How it works' }));

module.exports = router;
