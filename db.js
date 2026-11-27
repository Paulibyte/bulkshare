// Database setup (SQLite via better-sqlite3). One file: data/bulkshare.db
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');

const dataDir = path.join(__dirname, 'data');
fs.mkdirSync(dataDir, { recursive: true });
const db = new Database(process.env.DB_PATH || path.join(dataDir, 'bulkshare.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS admins (
  id INTEGER PRIMARY KEY, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, name TEXT
);
CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, slug TEXT UNIQUE NOT NULL, sort INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS locations (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, address TEXT, notes TEXT
);
CREATE TABLE IF NOT EXISTS delivery_areas (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, fee INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY,
  category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  title TEXT NOT NULL, slug TEXT UNIQUE NOT NULL, description TEXT, image TEXT,
  total_price INTEGER NOT NULL,          -- naira
  total_slots INTEGER NOT NULL,
  slot_price INTEGER NOT NULL,           -- naira, ceil(total_price / total_slots)
  max_slots_per_customer INTEGER NOT NULL DEFAULT 1,
  sharing_date TEXT,                     -- 'YYYY-MM-DDTHH:MM'
  location_id INTEGER REFERENCES locations(id) ON DELETE SET NULL,
  allow_pickup INTEGER NOT NULL DEFAULT 1,
  allow_delivery INTEGER NOT NULL DEFAULT 1,
  allow_whole INTEGER NOT NULL DEFAULT 1, -- one buyer may take the whole item / all remaining shares
  whole_price INTEGER,                   -- optional special price when one buyer takes the whole item
  status TEXT NOT NULL DEFAULT 'open',   -- draft | open | closed | completed | cancelled
  closed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,             -- public reference e.g. BS-7K3QX9
  token TEXT NOT NULL,                   -- secret for the order page link
  product_id INTEGER NOT NULL REFERENCES products(id),
  customer_name TEXT NOT NULL, phone TEXT NOT NULL, email TEXT,
  slots INTEGER NOT NULL, slot_price INTEGER NOT NULL,
  fulfillment TEXT NOT NULL,             -- pickup | delivery
  delivery_area_id INTEGER, delivery_area TEXT, delivery_address TEXT,
  delivery_fee INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL,
  payment_method TEXT NOT NULL,          -- bank | opay
  purchase_type TEXT NOT NULL DEFAULT 'share', -- share | whole | remaining
  status TEXT NOT NULL DEFAULT 'pending',
     -- pending | awaiting_confirmation | paid | rejected | expired | cancelled | refund_due | refunded
  slot_from INTEGER, slot_to INTEGER,    -- slot numbers assigned when paid
  handed_over INTEGER NOT NULL DEFAULT 0,-- collected at sharing / delivered
  transfer_sender TEXT, transfer_proof TEXT, transfer_note TEXT,
  opay_order_no TEXT, opay_status TEXT, opay_url TEXT,
  admin_note TEXT,
  expires_at TEXT,
  paid_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_orders_product ON orders(product_id, status);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
`);

// Upgrades for databases created by earlier versions
function addColumn(table, col, def) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
}
addColumn('products', 'allow_whole', 'INTEGER NOT NULL DEFAULT 1');
addColumn('products', 'whole_price', 'INTEGER');
addColumn('orders', 'purchase_type', "TEXT NOT NULL DEFAULT 'share'");
addColumn('orders', 'opay_url', 'TEXT');

const defaults = {
  site_name: 'BulkShare Owerri',
  tagline: 'Buy in bulk together. Pay less. Share on the day.',
  bank_name: '', account_name: '', account_number: '',
  bank_hold_hours: '6',      // how long an unpaid bank-transfer order holds its slots
  opay_hold_minutes: '30',   // how long an unpaid OPay order holds its slots
  whatsapp: '', support_phone: '',
  // Branding & customization (editable in Admin > Settings)
  logo: '',                  // '' = built-in logo (public/img/logo.png)
  favicon: '',               // '' = built-in favicon
  show_name_with_logo: '1',
  header_style: 'light',     // light | brand
  primary_color: '#14532d',
  accent_color: '#e8a317',
  bg_color: '#f7f4ee',
  hero_title: 'Buy in bulk together. Pay less. Share on the day.',
  hero_text: 'Join other buyers in Owerri to buy a cow, a bag of rice, a keg of oil and more at bulk price. Pay for your share, then collect at the market on sharing day or have it delivered.',
  announcement: '',
  footer_text: 'Owerri, Imo State',
  contact_email: '', address: '',
  facebook: '', instagram: '', tiktok: '',
  meta_description: 'Group bulk-buying in Owerri. Share a cow, rice, oil and more at bulk price.',
  show_recent_joiners: '1',
  show_reserved_count: '1',
  button_label: 'Join this share',
};
const insSetting = db.prepare('INSERT OR IGNORE INTO settings(key, value) VALUES (?, ?)');
for (const [k, v] of Object.entries(defaults)) insSetting.run(k, v);

// First-run seed
if (db.prepare('SELECT COUNT(*) n FROM categories').get().n === 0) {
  const c = db.prepare('INSERT INTO categories(name, slug, sort) VALUES (?, ?, ?)');
  [['Livestock (Cow, Goat, Ram)', 'livestock'], ['Foodstuff (Rice, Beans, Garri)', 'foodstuff'],
   ['Oil & Condiments', 'oil-condiments'], ['Poultry & Fish', 'poultry-fish'], ['Drinks', 'drinks']]
    .forEach(([n, s], i) => c.run(n, s, i));
  const l = db.prepare('INSERT INTO locations(name, address) VALUES (?, ?)');
  [['Relief Market', 'Relief Market, Owerri'], ['Douglas Road Market', 'Douglas Road, Owerri'],
   ['Eke Onunwa Market', 'Eke Onunwa, Owerri'], ['Orji Market', 'Orji, Owerri North']]
    .forEach(r => l.run(...r));
  const d = db.prepare('INSERT INTO delivery_areas(name, fee) VALUES (?, ?)');
  [['MCC Road', 1500], ['Orji Road', 1500], ['Egbu Road', 2000], ['Orlu Road', 2000], ['Old Nekede Road', 2000]]
    .forEach(r => d.run(...r));
}
if (db.prepare('SELECT COUNT(*) n FROM admins').get().n === 0) {
  const email = process.env.ADMIN_EMAIL || 'admin@example.com';
  const pass = process.env.ADMIN_PASSWORD || 'changeme123';
  db.prepare('INSERT INTO admins(email, password_hash, name) VALUES (?, ?, ?)')
    .run(email.toLowerCase(), bcrypt.hashSync(pass, 10), 'Admin');
  console.log(`[setup] Admin account created: ${email} (change the password after first login)`);
}

function getSettings() {
  const out = {};
  for (const r of db.prepare('SELECT key, value FROM settings').all()) out[r.key] = r.value;
  return out;
}
function setSetting(key, value) {
  db.prepare('INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, value);
}

module.exports = { db, getSettings, setSetting };
