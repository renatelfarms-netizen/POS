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

## Running it
Open `index.html` in a browser. When it is opened on its own, data is saved in that browser only (localStorage).

Inside Claude, the page also uses Claude's built-in shop database so every device sees the same data, and Gmail for emailed reports and reset codes. Those features are not available when the file is hosted elsewhere.

## Hosting
Any static host works, for example GitHub Pages (Settings, Pages, deploy from the `main` branch). A hosted copy keeps its data per device unless it is connected to a shared database.

## Notes
- No keys or secrets are stored in this repository.
- Shop data is not stored here. It lives in the browser or in the shop database.
