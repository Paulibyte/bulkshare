// Branding helpers: colour theme + logo/favicon processing
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const sharp = require('sharp');

const HEX = /^#([0-9a-f]{6})$/i;
const clean = (v, fallback) => (HEX.test(String(v || '').trim()) ? String(v).trim().toLowerCase() : fallback);

function mix(hex, withHex, amount) { // amount 0..1 of withHex
  const a = parseInt(hex.slice(1), 16), b = parseInt(withHex.slice(1), 16);
  const ch = (x, sh) => (x >> sh) & 255;
  const m = sh => Math.round(ch(a, sh) * (1 - amount) + ch(b, sh) * amount);
  return '#' + ((1 << 24) + (m(16) << 16) + (m(8) << 8) + m(0)).toString(16).slice(1);
}
function luminance(hex) {
  const n = parseInt(hex.slice(1), 16);
  const c = [16, 8, 0].map(s => { const v = ((n >> s) & 255) / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}

function themeCss(s) {
  const primary = clean(s.primary_color, '#14532d');
  const accent = clean(s.accent_color, '#e8a317');
  const bg = clean(s.bg_color, '#f7f4ee');
  const onAccent = luminance(accent) > 0.4 ? '#1c1c1c' : '#ffffff';
  return `:root{--green:${primary};--green-2:${mix(primary, '#ffffff', 0.1)};--green-soft:${mix(primary, '#ffffff', 0.88)};` +
    `--amber:${accent};--amber-dark:${mix(accent, '#000000', 0.12)};--amber-soft:${mix(accent, '#ffffff', 0.85)};--on-amber:${onAccent};--bg:${bg}}`;
}

const brandDir = path.join(__dirname, '..', 'public', 'uploads', 'brand');

async function saveLogo(filePath) {
  fs.mkdirSync(brandDir, { recursive: true });
  const name = 'logo-' + crypto.randomBytes(5).toString('hex') + '.png';
  let img = sharp(filePath).rotate();
  try { img = sharp(await img.trim({ threshold: 12 }).toBuffer()); } catch { img = sharp(filePath).rotate(); }
  await img.resize({ width: 600, height: 600, fit: 'inside', withoutEnlargement: true }).png().toFile(path.join(brandDir, name));
  return 'brand/' + name;
}

// Square icons at 32, 192 and 180 (apple, white background) from any image
async function saveFavicons(filePath) {
  fs.mkdirSync(brandDir, { recursive: true });
  const base = 'fav-' + crypto.randomBytes(5).toString('hex');
  const src = await sharp(filePath).rotate().png().toBuffer();
  const square = size => sharp(src).resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } });
  await square(32).png().toFile(path.join(brandDir, base + '-32.png'));
  await square(192).png().toFile(path.join(brandDir, base + '-192.png'));
  await sharp(src).resize(160, 160, { fit: 'contain', background: '#ffffff' })
    .extend({ top: 10, bottom: 10, left: 10, right: 10, background: '#ffffff' }).flatten({ background: '#ffffff' })
    .png().toFile(path.join(brandDir, base + '-180.png'));
  return 'brand/' + base;
}

// URLs the templates use
function assets(s) {
  const logo = s.logo ? `/static/uploads/${s.logo}` : '/static/img/logo.png';
  const fav = s.favicon
    ? { ico: null, png32: `/static/uploads/${s.favicon}-32.png`, png192: `/static/uploads/${s.favicon}-192.png`, apple: `/static/uploads/${s.favicon}-180.png` }
    : { ico: '/static/img/favicon.ico', png32: '/static/img/favicon-32.png', png192: '/static/img/icon-192.png', apple: '/static/img/apple-touch-icon.png' };
  return { logo, fav };
}

module.exports = { themeCss, saveLogo, saveFavicons, assets, clean };
