// Slot accounting for shared bulk purchases.
// "paid"  = slots in confirmed orders
// "held"  = slots reserved by orders still waiting for payment / confirmation
// remaining = total_slots - paid - held   (entry closes automatically at 0 paid-remaining)
const crypto = require('crypto');
const { db, getSettings } = require('../db');

const HELD = ['pending', 'awaiting_confirmation'];

function expireStale() {
  db.prepare(`UPDATE orders SET status = 'expired'
              WHERE status = 'pending' AND expires_at IS NOT NULL AND expires_at < datetime('now')`).run();
}

function stats(product) {
  const row = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN status = 'paid' THEN slots END), 0) AS paid,
      COALESCE(SUM(CASE WHEN status IN ('pending','awaiting_confirmation') THEN slots END), 0) AS held,
      COUNT(DISTINCT CASE WHEN status = 'paid' THEN phone END) AS paid_people
    FROM orders WHERE product_id = ?`).get(product.id);
  const remaining = Math.max(0, product.total_slots - row.paid - row.held);
  return {
    paid: row.paid, held: row.held, remaining, paidPeople: row.paid_people,
    paidRemaining: Math.max(0, product.total_slots - row.paid),
    percent: Math.min(100, Math.round((row.paid / product.total_slots) * 100)),
    heldPercent: Math.min(100, Math.round((row.held / product.total_slots) * 100)),
  };
}

// What a single buyer would pay to take the item: the whole item (if nobody has joined yet)
// or all remaining shares. Returns null when not offered.
function wholeQuote(p, s) {
  if (!p.allow_whole || p.status !== 'open' || s.remaining < 1) return null;
  if (s.remaining === p.total_slots) {
    const amount = p.whole_price || p.total_price;
    return { type: 'whole', slots: s.remaining, amount, saving: Math.max(0, p.slot_price * p.total_slots - amount) };
  }
  if (s.remaining <= p.max_slots_per_customer) return null; // normal share picker already covers it
  return { type: 'remaining', slots: s.remaining, amount: s.remaining * p.slot_price, saving: 0 };
}

function withStats(products) {
  return products.map(p => { const st = stats(p); return { ...p, stats: st, whole: wholeQuote(p, st) }; });
}

function code() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (const b of crypto.randomBytes(6)) s += alphabet[b % alphabet.length];
  return 'BS-' + s;
}

class PoolError extends Error {}

// Create an order and hold its slots. Runs in one transaction so two people
// can never take the last slot at the same time.
const reserve = db.transaction((productId, input) => {
  expireStale();
  const p = db.prepare('SELECT * FROM products WHERE id = ?').get(productId);
  if (!p || p.status !== 'open') throw new PoolError('This item is no longer taking new contributors.');
  const s = stats(p);
  let slots, amount, purchaseType = 'share';
  if (input.purchase_type === 'whole') {
    const q = wholeQuote(p, s);
    if (!q) throw new PoolError(p.allow_whole ? 'This item can no longer be bought whole. You can still join with shares.' : 'This item is only sold in shares.');
    // The buyer saw a price for a certain number of shares; if someone joined meanwhile, ask them to review
    if (input.expected_slots && parseInt(input.expected_slots, 10) !== q.slots) {
      throw new PoolError(`Someone just joined. ${q.slots} share(s) are left now for ₦${q.amount.toLocaleString('en-NG')}. Please review and try again.`);
    }
    slots = q.slots; amount = q.amount; purchaseType = q.type;
  } else {
    slots = parseInt(input.slots, 10);
    if (!Number.isInteger(slots) || slots < 1) throw new PoolError('Choose at least 1 slot.');
    if (slots > p.max_slots_per_customer) throw new PoolError(`You can take at most ${p.max_slots_per_customer} slot(s) on this item.`);
    if (slots > s.remaining) {
      throw new PoolError(s.remaining === 0
        ? 'All slots are taken or reserved right now. Check back shortly in case a reservation expires.'
        : `Only ${s.remaining} slot(s) left.`);
    }
    amount = slots * p.slot_price;
  }

  let fee = 0, areaName = null, areaId = null;
  if (input.fulfillment === 'delivery') {
    if (!p.allow_delivery) throw new PoolError('Delivery is not available for this item.');
    const area = db.prepare('SELECT * FROM delivery_areas WHERE id = ?').get(input.delivery_area_id);
    if (!area) throw new PoolError('Choose your delivery area.');
    if (!input.delivery_address || input.delivery_address.trim().length < 5) throw new PoolError('Enter your delivery address.');
    fee = area.fee; areaName = area.name; areaId = area.id;
  } else {
    if (!p.allow_pickup) throw new PoolError('Pickup is not available for this item.');
    input.fulfillment = 'pickup';
  }
  const method = input.payment_method === 'opay' ? 'opay' : 'bank';
  const set = getSettings();
  const hold = method === 'opay'
    ? `+${parseInt(set.opay_hold_minutes, 10) || 30} minutes`
    : `+${Math.round((parseFloat(set.bank_hold_hours) || 6) * 60)} minutes`;

  const total = amount + fee;
  const c = code();
  const token = crypto.randomBytes(16).toString('hex');
  db.prepare(`INSERT INTO orders (code, token, product_id, customer_name, phone, email, slots, slot_price,
      fulfillment, delivery_area_id, delivery_area, delivery_address, delivery_fee, total, payment_method,
      purchase_type, status, expires_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'pending', datetime('now', ?))`)
    .run(c, token, p.id, input.customer_name.trim(), input.phone.trim(), (input.email || '').trim() || null,
      slots, p.slot_price, input.fulfillment, areaId, areaName,
      input.fulfillment === 'delivery' ? input.delivery_address.trim() : null, fee, total, method, purchaseType, hold);
  return { code: c, token };
});

// Confirm payment for an order (bank transfer approved by admin, or OPay verified).
// Returns the new status: 'paid' or 'refund_due' (paid too late and the item filled up).
const markPaid = db.transaction((orderId, note) => {
  const o = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!o) throw new PoolError('Order not found');
  if (o.status === 'paid' || o.status === 'refund_due' || o.status === 'refunded') return o.status;
  const p = db.prepare('SELECT * FROM products WHERE id = ?').get(o.product_id);
  const s = stats(p);
  // Slots this order may take: if it was still holding, its own slots are counted in "held".
  const ownHeld = HELD.includes(o.status) ? o.slots : 0;
  const free = p.total_slots - s.paid - (s.held - ownHeld);
  if (o.slots > free || p.status === 'cancelled') {
    db.prepare(`UPDATE orders SET status = 'refund_due', paid_at = datetime('now'),
                admin_note = TRIM(COALESCE(admin_note,'') || ' ' || ?) WHERE id = ?`)
      .run('Payment received after slots were gone — refund needed.', o.id);
    return 'refund_due';
  }
  const last = db.prepare(`SELECT COALESCE(MAX(slot_to), 0) m FROM orders WHERE product_id = ? AND status = 'paid'`).get(p.id).m;
  db.prepare(`UPDATE orders SET status = 'paid', paid_at = datetime('now'), slot_from = ?, slot_to = ?,
              admin_note = CASE WHEN ? IS NULL THEN admin_note ELSE TRIM(COALESCE(admin_note,'') || ' ' || ?) END
              WHERE id = ?`)
    .run(last + 1, last + o.slots, note || null, note || null, o.id);
  refreshProductStatus(p.id);
  return 'paid';
});

// Close entry when every slot is paid for; reopen if a paid order is cancelled.
function refreshProductStatus(productId) {
  const p = db.prepare('SELECT * FROM products WHERE id = ?').get(productId);
  const s = stats(p);
  if (p.status === 'open' && s.paid >= p.total_slots) {
    db.prepare(`UPDATE products SET status = 'closed', closed_at = datetime('now') WHERE id = ?`).run(p.id);
  } else if (p.status === 'closed' && s.paid < p.total_slots) {
    db.prepare(`UPDATE products SET status = 'open', closed_at = NULL WHERE id = ?`).run(p.id);
  }
}

function setOrderStatus(orderId, status, note) {
  const o = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!o) return;
  db.prepare(`UPDATE orders SET status = ?,
      admin_note = CASE WHEN ? IS NULL OR ? = '' THEN admin_note ELSE TRIM(COALESCE(admin_note,'') || ' ' || ?) END
      WHERE id = ?`).run(status, note || null, note || null, note || null, orderId);
  refreshProductStatus(o.product_id);
}

module.exports = { expireStale, stats, withStats, wholeQuote, reserve, markPaid, refreshProductStatus, setOrderStatus, PoolError };
