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

On the website, data is saved in each browser (localStorage). Inside Claude, the page also uses Claude's built-in shop database so every device sees the same data, and Gmail for emailed reports and reset codes.

## Hosting
The site is hosted on Hostinger as a small Node.js app: `server.js` serves `index.html` and has no dependencies. Every push to `main` deploys automatically.

To try it on your own computer: `npm start`, then open http://localhost:3000.

## Notes
- No keys or secrets are stored in this repository.
- Shop data is not stored here. It lives in the browser or in the shop database.
