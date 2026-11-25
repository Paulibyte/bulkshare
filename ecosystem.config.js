// PM2: pm2 start ecosystem.config.js
// Keep instances at 1 — slot reservations rely on a single process writing to SQLite.
module.exports = {
  apps: [{ name: 'bulkshare', script: 'server.js', instances: 1, exec_mode: 'fork', env: { NODE_ENV: 'production' } }],
};
