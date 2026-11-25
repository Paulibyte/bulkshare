require('dotenv').config();
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const cookieSession = require('cookie-session');
const { db, getSettings } = require('./db');
const { expireStale } = require('./lib/pools');
const opay = require('./lib/opay');

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('trust proxy', 1); // behind Nginx on the VPS

app.use(express.urlencoded({ extended: false, limit: '200kb' }));
app.use(express.json({ limit: '200kb' }));
app.use('/static', express.static(path.join(__dirname, 'public'), { maxAge: '7d' }));

app.use(cookieSession({
  name: 'bs_sess',
  secret: process.env.SESSION_SECRET || 'dev-only-secret-change-me',
  maxAge: 1000 * 60 * 60 * 12,
  sameSite: 'lax',
  httpOnly: true,
  secure: process.env.COOKIE_SECURE === 'true',
}));

// Shared view helpers
const naira = n => '₦' + Number(n || 0).toLocaleString('en-NG');
const fmtDate = s => {
  if (!s) return 'To be announced';
  const d = new Date(s);
  if (isNaN(d)) return s;
  return d.toLocaleString('en-NG', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'Africa/Lagos' });
};
// SQLite datetime('now') values are UTC without a zone marker
const fmtUtc = s => (s ? fmtDate(s.replace(' ', 'T') + 'Z') : '');

app.use((req, res, next) => {
  if (!req.session.csrf) req.session.csrf = crypto.randomBytes(16).toString('hex');
  res.locals.csrf = req.session.csrf;
  res.locals.settings = getSettings();
  res.locals.naira = naira;
  res.locals.fmtDate = fmtDate;
  res.locals.fmtUtc = fmtUtc;
  res.locals.admin = req.session.adminId ? { id: req.session.adminId, email: req.session.adminEmail } : null;
  res.locals.flash = req.session.flash || null;
  res.locals.opayEnabled = opay.enabled();
  res.locals.path = req.path;
  delete req.session.flash;
  res.locals.categories = db.prepare('SELECT * FROM categories ORDER BY sort, name').all();
  next();
});

app.use('/', require('./routes/public'));
app.use('/admin', require('./routes/admin'));

app.use((req, res) => res.status(404).render('message', { title: 'Not found', message: 'That page does not exist.' }));
app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).render('message', { title: 'Something went wrong', message: err.expose ? err.message : 'Please try again.' });
});

setInterval(expireStale, 60 * 1000).unref();

const port = process.env.PORT || 3060;
if (require.main === module) {
  app.listen(port, () => console.log(`BulkShare running on http://localhost:${port}`));
}
module.exports = app;
