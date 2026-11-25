const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');

function verifyCsrf(req, res, next) {
  const t = (req.body && req.body._csrf) || req.get('x-csrf-token');
  if (!t || !req.session.csrf || t !== req.session.csrf) {
    return res.status(403).render('message', { title: 'Form expired', message: 'Please go back, refresh the page and try again.' });
  }
  next();
}

function flash(req, type, text) { req.session.flash = { type, text }; }

function slugify(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'item';
}

function makeUpload(dir, { allowPdf = false } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const ok = allowPdf ? /^(image\/(jpeg|png|webp)|application\/pdf)$/ : /^image\/(jpeg|png|webp)$/;
  return multer({
    storage: multer.diskStorage({
      destination: dir,
      filename: (req, file, cb) => {
        const ext = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'application/pdf': '.pdf' }[file.mimetype];
        cb(null, crypto.randomBytes(12).toString('hex') + ext);
      },
    }),
    limits: { fileSize: 5 * 1024 * 1024, files: 2 },
    fileFilter: (req, file, cb) => cb(null, ok.test(file.mimetype)),
  });
}

const root = path.join(__dirname, '..');
const productUpload = makeUpload(path.join(root, 'public', 'uploads'));
const proofUpload = makeUpload(path.join(root, 'data', 'proofs'), { allowPdf: true });
const proofDir = path.join(root, 'data', 'proofs');
const brandUpload = makeUpload(path.join(root, 'data', 'tmp'));

const baseUrl = req => (process.env.BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');

module.exports = { verifyCsrf, flash, slugify, productUpload, proofUpload, proofDir, brandUpload, baseUrl };
