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

On the website, each phone or computer joins the shop once with the shop code (the `BACKUP_CODE` setting). After that every device shares one live shop database: `server.js` reads and writes it in Supabase through locked-down database functions (`shop_db_pull`, `shop_db_put`, `shop_db_del`) that only accept the server's `SUPABASE_BACKUP_TOKEN`. Each browser also keeps a local copy so the shop keeps working offline. Inside Claude, the page uses Claude's built-in shop database instead, and Gmail for emailed reports and reset codes.

## Hosting
The site is hosted on Hostinger as a small Node.js app: `server.js` serves `index.html` and has no dependencies. Every push to `main` deploys automatically.

To try it on your own computer: `npm start`, then open http://localhost:3000.

## Notes
- No keys or secrets are stored in this repository.
- Shop data is not stored here. It lives in the browser or in the shop database.
