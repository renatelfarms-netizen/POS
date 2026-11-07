# Renatel Shop POS

A point-of-sale system for a small retail shop, in a single file (`index.html`). No build step.

## Features
- Sales with receipts, split payments, discounts, refunds and editable receipts
- Inventory with cost and sale prices, SKUs, stock history and expiry dates
- Customers, credit balances and invoices
- Deliveries with riders and pay-on-delivery
- Purchase orders and supplier balances
- Expenses and reports with charts, plus PDF reports
- Staff accounts with roles (owner, manager, accountant, cashier, stock keeper, delivery), password reset, and an activity trail
- Ghana regions and towns for customers, deliveries and the shop address

## Using it
The shop runs online at https://renatel.shop. Open it in any browser on a phone, tablet or computer. There is no app to install.

On the website everything runs centrally from the host: nothing about the shop is stored on phones or computers, and devices are not registered or named. Staff open the shop with their own name and password (full name, either name, or the names in any order). `server.js` checks the login against the shop's staff list (`POST /api/login`) and gives that browser tab a signed session for one day; "Sign out every device" ends all sessions, and `POST /api/reset` resets a password with the shop recovery code. The shop lives in Supabase (`shop_docs`), reached only through locked-down database functions that accept the server's `SUPABASE_BACKUP_TOKEN`; record numbers come from a central sequence (`shop_ids`). Each person opens on their own branch (set on their staff record; the owner can use both).

Backups are made by the server only: every 10 minutes, if anything changed, the whole shop is saved on the hosting (outside the website folder) and in Supabase; all backups from the last 2 days are kept, then one a day for 90 days. Owners and managers can press Back up now; only the owner can restore, which signs everyone out. Inside Claude, the page uses Claude's built-in shop database instead, and Gmail for emailed reports and reset codes.

## Online shop
Customers can buy at https://renatel.shop/store and pay online. Only products the owner ticks **Sell on the online shop** (in the product form, Kumasi branch) are listed. When a payment succeeds, `store.js` records it in the POS like a till sale: stock goes down, a sale is added (seller "Online shop", method "Online"), a stock move and an activity entry are logged, and a delivery job is created if the customer chose delivery. Orders are handled one at a time, so the last item can never be sold twice; if an item sells out while someone is paying, the order is flagged in the activity trail for a refund.

Payments use Paystack (Mobile Money and cards) once `PAYSTACK_SECRET_KEY` is set on the hosting, with the webhook `https://renatel.shop/api/store/paystack`. A `sk_test_` key uses Paystack's test mode. With no key, the shop runs in **test mode**: a practice payment screen replaces Paystack and no money moves, but stock and sales are real.

## Hosting
The site is hosted on Hostinger as a small Node.js app: `server.js` serves `index.html` and has no dependencies. Every push to `main` deploys automatically.

To try it on your own computer: `npm start`, then open http://localhost:3000.

## Notes
- No keys or secrets are stored in this repository.
- Shop data is not stored here. It lives in the browser or in the shop database.
