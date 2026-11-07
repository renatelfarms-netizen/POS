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
The POS runs online at https://renatel.shop/pos (renatel.shop itself is the customers' online shop). Open it in any browser on a phone, tablet or computer. There is no app to install.

On the website everything runs centrally from the host: nothing about the shop is stored on phones or computers, and devices are not registered or named. Staff open the shop with their own name and password (full name, either name, or the names in any order). `server.js` checks the login against the shop's staff list (`POST /api/login`) and gives that browser tab a signed session for one day; "Sign out every device" ends all sessions, and `POST /api/reset` resets a password with the shop recovery code. The shop lives in Supabase (`shop_docs`), reached only through locked-down database functions that accept the server's `SUPABASE_BACKUP_TOKEN`; record numbers come from a central sequence (`shop_ids`). Each person opens on their own branch (set on their staff record; the owner can use both).

Backups are made by the server only: every 10 minutes, if anything changed, the whole shop is saved on the hosting (outside the website folder) and in Supabase; all backups from the last 2 days are kept, then one a day for 90 days. Owners and managers can press Back up now; only the owner can restore, which signs everyone out. Inside Claude, the page uses Claude's built-in shop database instead, and Gmail for emailed reports and reset codes.

## Online shop
Customers buy at **https://renatel.shop** and pay online (old `/store` links still work). The staff POS is at **https://renatel.shop/pos** (a 🔐 POS button appears on the shop on staff devices). **Every product in the POS is on the shop** (with its photo, price and live stock) unless the owner ticks **Hide from the online shop** in the product form.

Each customer is served by the **nearest branch**: on their first visit they choose their region or tap *Use my location*, and the shop picks Kumasi or Accra by distance (Greater Accra, Eastern, Central, Western and Volta → Accra; the rest → Kumasi). They see that branch's products and stock, and when the payment succeeds `store.js` records it in that branch like a till sale: stock goes down, a sale is added (seller "Online shop", method "Online"), a stock move and an activity entry are logged, and a delivery job is created if they chose delivery. Orders are handled one at a time, so the last item can never be sold twice; if an item sells out while someone is paying, the order is flagged in the activity trail for a refund.

**Managing the shop in the POS** (🌐 Online shop menu): *Orders* (every online order with customer, branch, items and payment; mark ready → collected/delivered, which also completes the delivery job; cancel unpaid orders; mark sold-out orders refunded), *Products* (show or hide each product online, add photos), *Customers* (all accounts; block or unblock) and *Settings* (open/close the shop for orders, announcement banner, pickup and delivery on/off, delivery note). The owner has all four; in Staff → 🔑 Access the owner can give any staff member any of the four. The server checks these permissions on every request (`/api/store/admin/*`), and every action is written to the activity trail.

**Customer accounts**: anyone can browse and fill a cart, but checking out needs an account (name, phone number, optional email, password). Customers can sign in, see their orders under *My account*, change their details and password, and reset a forgotten password with a code sent to their email. Accounts are kept in Supabase (`web_accounts`, through token-checked functions), never in the data the tills sync. Each account is added to the POS **Customers** list of the customer's branch (an existing customer with the same phone number is reused), and online sales are linked to that customer.

**Product photos**: add one in the product form (take a picture or choose a file; it is shrunk on the device first). Photos are kept in Supabase (`shop_photos`, through token-checked functions) and cached on the hosting in `~/renatel-photos`, and served at `/img/<code>`. Product records only hold the photo code, so the tills stay fast.

Payments use **Paystack** (Mobile Money and cards). The owner connects it in the POS: 🌐 Online shop → ⚙️ Settings → 💳 Payments → paste the Paystack Secret Key. The server checks the key with Paystack, keeps it privately in Supabase (`site_secrets`, write-only function `site_secret_set`), and the shop switches from practice payments to Paystack at once (a `sk_test_` key uses Paystack's test mode, `sk_live_` takes real money). Set the Paystack webhook to `https://renatel.shop/api/store/paystack`. `PAYSTACK_SECRET_KEY` on the hosting, if set, takes priority. With no key the shop runs in **test mode**: a practice payment screen, no money moves, but stock and sales are real.

## Hosting
The site is hosted on Hostinger as a small Node.js app: `server.js` serves `index.html` and has no dependencies. Every push to `main` deploys automatically.

To try it on your own computer: `npm start`, then open http://localhost:3000.

## Notes
- No keys or secrets are stored in this repository.
- Shop data is not stored here. It lives in the browser or in the shop database.
