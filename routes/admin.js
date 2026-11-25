const express = require('express');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const { db, getSettings, setSetting } = require('../db');
const pools = require('../lib/pools');
const opay = require('../lib/opay');
const { verifyCsrf, flash, slugify, productUpload, proofDir } = require('../lib/util');

const router = express.Router();
const ORDER_STATUSES = ['pending', 'awaiting_confirmation', 'paid', 'refund_due', 'refunded', 'rejected', 'expired', 'cancelled'];

// ---- auth ----
const attempts = new Map(); // simple login throttle per IP
router.get('/login', (req, res) => res.render('admin/login', { title: 'Admin login', error: null }));
router.post('/login', verifyCsrf, (req, res) => {
  const ip = req.ip, now = Date.now();
  const a = attempts.get(ip) || { n: 0, t: now };
  if (now - a.t > 15 * 60 * 1000) { a.n = 0; a.t = now; }
  if (a.n >= 10) return res.status(429).render('admin/login', { title: 'Admin login', error: 'Too many attempts. Wait 15 minutes.' });
  const u = db.prepare('SELECT * FROM admins WHERE email = ?').get(String(req.body.email || '').toLowerCase().trim());
  if (!u || !bcrypt.compareSync(String(req.body.password || ''), u.password_hash)) {
    a.n++; attempts.set(ip, a);
    return res.render('admin/login', { title: 'Admin login', error: 'Wrong email or password.' });
  }
  attempts.delete(ip);
  req.session.adminId = u.id; req.session.adminEmail = u.email;
  res.redirect('/admin');
});
router.post('/logout', verifyCsrf, (req, res) => { req.session = null; res.redirect('/admin/login'); });

router.use((req, res, next) => {
  if (!req.session.adminId) return res.redirect('/admin/login');
  res.locals.layoutAdmin = true;
  next();
});

// ---- dashboard ----
router.get('/', (req, res) => {
  pools.expireStale();
  const products = pools.withStats(db.prepare(`SELECT p.*, l.name location_name FROM products p LEFT JOIN locations l ON l.id = p.location_id
    WHERE p.status IN ('open','closed') ORDER BY p.sharing_date IS NULL, p.sharing_date`).all());
  const count = st => db.prepare('SELECT COUNT(*) n FROM orders WHERE status = ?').get(st).n;
  const revenue = db.prepare(`SELECT COALESCE(SUM(total),0) s FROM orders WHERE status = 'paid'`).get().s;
  const toConfirm = db.prepare(`SELECT o.*, p.title FROM orders o JOIN products p ON p.id = o.product_id
    WHERE o.status IN ('awaiting_confirmation','refund_due') ORDER BY o.created_at`).all();
  res.render('admin/dashboard', {
    title: 'Dashboard', products, toConfirm, revenue,
    counts: { awaiting: count('awaiting_confirmation'), pending: count('pending'), refund: count('refund_due'), paid: count('paid') },
  });
});

// ---- products ----
const productLists = () => ({
  cats: db.prepare('SELECT * FROM categories ORDER BY sort, name').all(),
  locs: db.prepare('SELECT * FROM locations ORDER BY name').all(),
});

router.get('/products', (req, res) => {
  pools.expireStale();
  const st = req.query.status || '';
  const rows = db.prepare(`SELECT p.*, c.name category_name FROM products p LEFT JOIN categories c ON c.id = p.category_id
    ${st ? 'WHERE p.status = ?' : ''} ORDER BY p.created_at DESC`).all(...(st ? [st] : []));
  res.render('admin/products', { title: 'Products', products: pools.withStats(rows), st });
});

router.get('/products/new', (req, res) => res.render('admin/product-form', { title: 'New product', p: { max_slots_per_customer: 1, allow_pickup: 1, allow_delivery: 1, status: 'open' }, ...productLists(), sold: 0 }));

router.get('/products/:id/edit', (req, res, next) => {
  const p = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  if (!p) return next();
  const s = pools.stats(p);
  res.render('admin/product-form', { title: 'Edit product', p, ...productLists(), sold: s.paid + s.held });
});

function readProduct(req, existing) {
  const b = req.body;
  const total_price = parseInt(String(b.total_price).replace(/[^\d]/g, ''), 10);
  const total_slots = parseInt(b.total_slots, 10);
  const errors = [];
  if (!b.title || b.title.trim().length < 3) errors.push('Title is required.');
  if (!total_price || total_price < 100) errors.push('Enter the total price in naira.');
  if (!total_slots || total_slots < 2) errors.push('Number of customers (slots) must be at least 2.');
  const p = {
    title: (b.title || '').trim(), description: (b.description || '').trim(),
    category_id: b.category_id ? parseInt(b.category_id, 10) : null,
    location_id: b.location_id ? parseInt(b.location_id, 10) : null,
    total_price, total_slots,
    slot_price: total_slots ? Math.ceil(total_price / total_slots) : 0,
    max_slots_per_customer: Math.max(1, parseInt(b.max_slots_per_customer, 10) || 1),
    sharing_date: b.sharing_date || null,
    allow_pickup: b.allow_pickup ? 1 : 0, allow_delivery: b.allow_delivery ? 1 : 0,
    status: ['draft', 'open'].includes(b.status) ? b.status : (existing ? existing.status : 'open'),
  };
  if (!p.allow_pickup && !p.allow_delivery) errors.push('Allow pickup, delivery, or both.');
  if (existing) {
    const s = pools.stats(existing);
    if (total_slots < s.paid + s.held) errors.push(`Slots cannot be less than ${s.paid + s.held} (already paid or reserved).`);
    if (['closed', 'completed', 'cancelled'].includes(existing.status)) p.status = existing.status;
  }
  return { p, errors };
}

router.post('/products', productUpload.single('image'), verifyCsrf, (req, res) => {
  const { p, errors } = readProduct(req);
  if (errors.length) { flash(req, 'error', errors.join(' ')); return res.render('admin/product-form', { title: 'New product', p, ...productLists(), sold: 0 }); }
  let slug = slugify(p.title), i = 1;
  while (db.prepare('SELECT 1 FROM products WHERE slug = ?').get(slug)) slug = `${slugify(p.title)}-${++i}`;
  db.prepare(`INSERT INTO products (category_id, title, slug, description, image, total_price, total_slots, slot_price,
      max_slots_per_customer, sharing_date, location_id, allow_pickup, allow_delivery, status)
    VALUES (@category_id, @title, @slug, @description, @image, @total_price, @total_slots, @slot_price,
      @max_slots_per_customer, @sharing_date, @location_id, @allow_pickup, @allow_delivery, @status)`)
    .run({ ...p, slug, image: req.file ? req.file.filename : null });
  flash(req, 'success', 'Product created.');
  res.redirect('/admin/products');
});

router.post('/products/:id', productUpload.single('image'), verifyCsrf, (req, res, next) => {
  const existing = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  if (!existing) return next();
  const { p, errors } = readProduct(req, existing);
  if (errors.length) {
    flash(req, 'error', errors.join(' '));
    return res.redirect(`/admin/products/${existing.id}/edit`);
  }
  db.prepare(`UPDATE products SET category_id=@category_id, title=@title, description=@description,
      image=COALESCE(@image, image), total_price=@total_price, total_slots=@total_slots, slot_price=@slot_price,
      max_slots_per_customer=@max_slots_per_customer, sharing_date=@sharing_date, location_id=@location_id,
      allow_pickup=@allow_pickup, allow_delivery=@allow_delivery, status=@status WHERE id=@id`)
    .run({ ...p, image: req.file ? req.file.filename : null, id: existing.id });
  pools.refreshProductStatus(existing.id);
  flash(req, 'success', 'Product saved.' + (existing.slot_price !== p.slot_price ? ' New slot price applies to new orders only.' : ''));
  res.redirect('/admin/products');
});

router.post('/products/:id/status', verifyCsrf, (req, res, next) => {
  const p = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  if (!p) return next();
  const to = req.body.status;
  const allowed = { draft: ['open'], open: ['draft', 'closed', 'cancelled'], closed: ['open', 'completed', 'cancelled'], completed: ['closed'], cancelled: [] };
  if (!(allowed[p.status] || []).includes(to)) { flash(req, 'error', 'That change is not allowed.'); return res.redirect(req.get('referer') || '/admin/products'); }
  db.prepare(`UPDATE products SET status = ?, closed_at = CASE WHEN ? IN ('closed','completed') THEN COALESCE(closed_at, datetime('now')) ELSE closed_at END WHERE id = ?`).run(to, to, p.id);
  if (to === 'cancelled') {
    db.prepare(`UPDATE orders SET status = 'cancelled' WHERE product_id = ? AND status IN ('pending')`).run(p.id);
    db.prepare(`UPDATE orders SET status = 'refund_due', admin_note = TRIM(COALESCE(admin_note,'') || ' Item cancelled - refund if payment was received.') WHERE product_id = ? AND status IN ('paid','awaiting_confirmation')`).run(p.id);
    flash(req, 'success', 'Item cancelled. Paid orders are now marked "refund due".');
  } else flash(req, 'success', `Status changed to ${to}.`);
  res.redirect(req.get('referer') || '/admin/products');
});

router.get('/products/:id/participants', (req, res, next) => {
  const p = db.prepare(`SELECT p.*, l.name location_name, l.address location_address FROM products p LEFT JOIN locations l ON l.id = p.location_id WHERE p.id = ?`).get(req.params.id);
  if (!p) return next();
  p.stats = pools.stats(p);
  const orders = db.prepare(`SELECT * FROM orders WHERE product_id = ? AND status IN ('paid','awaiting_confirmation','pending','refund_due') ORDER BY status != 'paid', slot_from, created_at`).all(p.id);
  if (req.query.format === 'csv') {
    const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = [['Slots', 'Name', 'Phone', 'Email', 'Qty', 'Fulfilment', 'Area', 'Address', 'Total', 'Method', 'Status', 'Handed over', 'Ref'].join(',')];
    for (const o of orders) lines.push([o.slot_from ? `${o.slot_from}-${o.slot_to}` : '', o.customer_name, o.phone, o.email, o.slots, o.fulfillment, o.delivery_area, o.delivery_address, o.total, o.payment_method, o.status, o.handed_over ? 'yes' : 'no', o.code].map(esc).join(','));
    res.set('Content-Type', 'text/csv').attachment(`${p.slug}-participants.csv`);
    return res.send(lines.join('\n'));
  }
  res.render('admin/participants', { title: `Participants — ${p.title}`, p, orders });
});

// ---- orders ----
router.get('/orders', (req, res) => {
  pools.expireStale();
  const st = ORDER_STATUSES.includes(req.query.status) ? req.query.status : '';
  const q = (req.query.q || '').trim();
  const where = [], args = [];
  if (st) { where.push('o.status = ?'); args.push(st); }
  if (q) { where.push('(o.code LIKE ? OR o.customer_name LIKE ? OR o.phone LIKE ?)'); args.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  const orders = db.prepare(`SELECT o.*, p.title FROM orders o JOIN products p ON p.id = o.product_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY o.created_at DESC LIMIT 300`).all(...args);
  res.render('admin/orders', { title: 'Orders', orders, st, q, statuses: ORDER_STATUSES });
});

router.get('/orders/:id', (req, res, next) => {
  const o = db.prepare(`SELECT o.*, p.title, p.slug, p.total_slots FROM orders o JOIN products p ON p.id = o.product_id WHERE o.id = ?`).get(req.params.id);
  if (!o) return next();
  res.render('admin/order', { title: `Order ${o.code}`, o });
});

router.post('/orders/:id/:action', verifyCsrf, async (req, res, next) => {
  const o = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
  if (!o) return next();
  const note = (req.body.note || '').trim().slice(0, 300);
  try {
    switch (req.params.action) {
      case 'confirm': {
        if (!['pending', 'awaiting_confirmation', 'expired'].includes(o.status)) throw new Error('Only unpaid orders can be confirmed.');
        const r = pools.markPaid(o.id, note || 'Bank transfer confirmed by admin.');
        flash(req, r === 'paid' ? 'success' : 'error', r === 'paid' ? 'Payment confirmed. Slot(s) assigned.' : 'All slots were already taken — order marked "refund due".');
        break;
      }
      case 'reject':
        if (!['pending', 'awaiting_confirmation'].includes(o.status)) throw new Error('Only unpaid orders can be rejected.');
        pools.setOrderStatus(o.id, 'rejected', note || 'Payment not found.');
        flash(req, 'success', 'Order rejected and slot(s) released.'); break;
      case 'cancel':
        if (o.status === 'paid') {
          pools.setOrderStatus(o.id, 'refund_due', note || 'Cancelled after payment.');
          flash(req, 'success', 'Paid order cancelled; marked "refund due". Slot(s) released.');
        } else {
          pools.setOrderStatus(o.id, 'cancelled', note);
          flash(req, 'success', 'Order cancelled.');
        }
        break;
      case 'refunded':
        if (o.status !== 'refund_due') throw new Error('Only "refund due" orders can be marked refunded.');
        pools.setOrderStatus(o.id, 'refunded', note || 'Refund sent.');
        flash(req, 'success', 'Marked as refunded.'); break;
      case 'handover':
        db.prepare('UPDATE orders SET handed_over = 1 - handed_over WHERE id = ?').run(o.id);
        break;
      case 'verify-opay': {
        if (!opay.enabled()) throw new Error('OPay keys are not set.');
        const d = await opay.queryStatus(o.code);
        db.prepare('UPDATE orders SET opay_status = ? WHERE id = ?').run(d.status, o.id);
        if (d.status === 'SUCCESS' && !['paid', 'refund_due', 'refunded'].includes(o.status)) pools.markPaid(o.id, `OPay ${d.orderNo || ''}`);
        flash(req, 'success', `OPay says: ${d.status}`); break;
      }
      default: return next();
    }
  } catch (e) { flash(req, 'error', e.message); }
  const back = String(req.body.back || '');
  res.redirect(/^\/admin\/[\w\/?=&-]*$/.test(back) ? back : `/admin/orders/${o.id}`);
});

router.get('/proof/:file', (req, res, next) => {
  const f = path.basename(req.params.file);
  const full = path.join(proofDir, f);
  if (!fs.existsSync(full)) return next();
  res.sendFile(full);
});

// ---- categories, locations, delivery areas ----
router.get('/setup', (req, res) => {
  res.render('admin/setup', {
    title: 'Categories & locations',
    cats: db.prepare(`SELECT c.*, (SELECT COUNT(*) FROM products WHERE category_id = c.id) n FROM categories c ORDER BY sort, name`).all(),
    locs: db.prepare(`SELECT l.*, (SELECT COUNT(*) FROM products WHERE location_id = l.id) n FROM locations l ORDER BY name`).all(),
    areas: db.prepare('SELECT * FROM delivery_areas ORDER BY name').all(),
  });
});
router.post('/setup/:kind', verifyCsrf, (req, res) => {
  const b = req.body, id = b.id ? parseInt(b.id, 10) : null;
  const kind = req.params.kind;
  try {
    if (b._delete && id) {
      const table = { category: 'categories', location: 'locations', area: 'delivery_areas' }[kind];
      if (table) db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id);
      flash(req, 'success', 'Deleted.');
    } else if (kind === 'category' && b.name) {
      const slug = slugify(b.name);
      if (id) db.prepare('UPDATE categories SET name = ?, slug = ?, sort = ? WHERE id = ?').run(b.name.trim(), slug, parseInt(b.sort, 10) || 0, id);
      else db.prepare('INSERT INTO categories(name, slug, sort) VALUES (?, ?, ?)').run(b.name.trim(), slug, parseInt(b.sort, 10) || 0);
      flash(req, 'success', 'Category saved.');
    } else if (kind === 'location' && b.name) {
      if (id) db.prepare('UPDATE locations SET name = ?, address = ?, notes = ? WHERE id = ?').run(b.name.trim(), b.address || '', b.notes || '', id);
      else db.prepare('INSERT INTO locations(name, address, notes) VALUES (?, ?, ?)').run(b.name.trim(), b.address || '', b.notes || '');
      flash(req, 'success', 'Location saved.');
    } else if (kind === 'area' && b.name) {
      const fee = parseInt(String(b.fee).replace(/[^\d]/g, ''), 10) || 0;
      if (id) db.prepare('UPDATE delivery_areas SET name = ?, fee = ? WHERE id = ?').run(b.name.trim(), fee, id);
      else db.prepare('INSERT INTO delivery_areas(name, fee) VALUES (?, ?)').run(b.name.trim(), fee);
      flash(req, 'success', 'Delivery area saved.');
    }
  } catch (e) {
    flash(req, 'error', /UNIQUE/.test(e.message) ? 'A category with that name already exists.' : e.message);
  }
  res.redirect('/admin/setup');
});

// ---- settings ----
router.get('/settings', (req, res) => res.render('admin/settings', { title: 'Settings', s: getSettings() }));
router.post('/settings', verifyCsrf, (req, res) => {
  for (const k of ['site_name', 'tagline', 'bank_name', 'account_name', 'account_number', 'bank_hold_hours', 'opay_hold_minutes', 'whatsapp', 'support_phone']) {
    if (k in req.body) setSetting(k, String(req.body[k]).trim().slice(0, 200));
  }
  flash(req, 'success', 'Settings saved.');
  res.redirect('/admin/settings');
});
router.post('/password', verifyCsrf, (req, res) => {
  const u = db.prepare('SELECT * FROM admins WHERE id = ?').get(req.session.adminId);
  if (!bcrypt.compareSync(req.body.current || '', u.password_hash)) flash(req, 'error', 'Current password is wrong.');
  else if ((req.body.next || '').length < 8) flash(req, 'error', 'New password must be at least 8 characters.');
  else { db.prepare('UPDATE admins SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(req.body.next, 10), u.id); flash(req, 'success', 'Password changed.'); }
  res.redirect('/admin/settings');
});

module.exports = router;
