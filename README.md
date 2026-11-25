# BulkShare Owerri

Group bulk-buying for Owerri. The admin lists an item (for example a cow worth ₦1,500,000) and sets how many people share it (for example 30). The app works out the price of one share (₦50,000). Customers reserve shares, pay by **direct bank transfer** or **OPay**, and choose to **collect at the market on sharing day** or **get delivery**. Each item page shows how many people have paid and how many shares are left. When every share is paid, entry closes automatically.

## Features

**Customers**
- Shop with categories, search, and "Completed shares" history
- Item page: total price, price per share, sharing date and market, live counts (paid / reserved / left) with a progress bar, "Recently joined", WhatsApp share button
- Join form: number of shares (capped per customer), name, phone, email, pickup or delivery (area + address, fee added), payment method, live total
- Bank transfer: account details with copy buttons, order reference as narration, upload receipt (image/PDF)
- OPay: redirect to OPay Checkout (card, transfer, USSD, wallet); payment is verified with a signed status query before the share is confirmed
- Order page with share numbers (e.g. #4–#5) after payment, printable receipt
- Track order with reference + phone number

**Admin** (`/admin`)
- Dashboard: transfers to confirm, pending reservations, refunds due, confirmed revenue, progress of all open items
- Products: create/edit with photo, category, total price, number of shares, max shares per customer, sharing date, market, pickup/delivery options; publish, close entry, mark shared, reopen, cancel
- Orders: filter/search, view receipt, confirm paid, reject, cancel, mark refunded, re-check OPay
- Participants list per item (share numbers, pickup vs delivery, "handed over" tick), print or download CSV for sharing day
- Categories, delivery areas + fees, and sharing points/markets in Owerri
- Settings: site name, bank details, reservation hold times, support phone/WhatsApp, change password

## How the share counting works

- **Paid** = shares in confirmed orders.
- **Reserved** = shares held by people who have started paying. A bank-transfer reservation is held for 6 hours (OPay: 30 minutes) — both adjustable in Settings. Once a receipt is uploaded, it stays held until the admin confirms or rejects.
- **Left** = total − paid − reserved. Nobody can reserve more than what is left, so an item can never be oversold.
- When paid = total, the item closes. If a paid order is later cancelled, the item reopens.
- If a payment arrives after the reservation expired and the item has filled up, the order is marked **refund due** instead of overselling.
- Cancelling an item marks every paid order as **refund due**.

## Run locally

```bash
npm install
cp .env.example .env      # edit values
npm start                 # http://localhost:3060
```

The first start creates the admin account from `ADMIN_EMAIL` / `ADMIN_PASSWORD`. Log in at `/admin`, then fill in your bank details under **Settings**.

## Deploy on the VPS (PM2 + Nginx)

```bash
cd /var/www
git clone https://github.com/<you>/bulkshare.git && cd bulkshare
npm install --omit=dev
cp .env.example .env && nano .env          # set BASE_URL, SESSION_SECRET, admin, OPay keys
pm2 start ecosystem.config.js && pm2 save
```

Nginx server block (e.g. `share.bulktins.com`), then run certbot for HTTPS:

```nginx
server {
  server_name share.bulktins.com;
  client_max_body_size 6M;
  location / {
    proxy_pass http://127.0.0.1:3060;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
```

Keep PM2 at **1 instance** (already set in `ecosystem.config.js`).

**Back up** the `data/` folder (database + receipts) and `public/uploads/` (product photos). They are ignored by git, so `git pull` never touches them.

## OPay setup

1. In your OPay merchant dashboard, get the **Merchant ID**, **Public Key** and **Secret Key**.
2. Put them in `.env`. Start with `OPAY_BASE_URL=https://testapi.opaycheckout.com` (sandbox). When testing is done, switch to `https://liveapi.opaycheckout.com` with your live keys, then `pm2 restart bulkshare`.
3. The app sends OPay these addresses automatically (based on `BASE_URL`):
   - return: `https://your-domain/payments/opay/return`
   - callback: `https://your-domain/payments/opay/callback`
4. The OPay option only appears to customers when all three keys are set.

Do a small live payment first to confirm everything works with your merchant account. If OPay changes its API, the code to adjust is in `lib/opay.js`.

## Files

```
server.js            app setup
db.js                SQLite schema, default data, settings
lib/pools.js         share counting, reservations, auto close, refunds
lib/opay.js          OPay create + status check
routes/public.js     shop, join, order, payment, tracking
routes/admin.js      admin panel
views/               page templates (EJS)
public/css/style.css styles
```
