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

**Online only**: the POS works only while the device can reach renatel.shop. If the connection drops, a full-screen "No internet connection" lock covers the shop within a few seconds: nothing can be entered, changed or printed, and it unlocks by itself when the connection is back (a change made in the last moments before the drop is saved then). A receipt prints only after the sale is saved in the shop database.

Backups are made by the server only: every 10 minutes, if anything changed, the whole shop is saved on the hosting (outside the website folder) and in Supabase; all backups from the last 2 days are kept, then one a day for 90 days. Owners and managers can press Back up now; only the owner can restore, which signs everyone out. Inside Claude, the page uses Claude's built-in shop database instead, and Gmail for emailed reports and reset codes.

## Online shop
Customers buy at **https://renatel.shop** and pay online (old `/store` links still work). The staff POS is at **https://renatel.shop/pos** (a 🔐 POS button appears on the shop on staff devices). **Every product in the POS is on the shop** (with its photo, price and live stock) unless the owner ticks **Hide from the online shop** in the product form.

Each customer is served by the **nearest branch**: on their first visit they choose their region or tap *Use my location*, and the shop picks Kumasi or Accra by distance (Greater Accra, Eastern, Central, Western and Volta → Accra; the rest → Kumasi). They see that branch's products and stock, and when the payment succeeds `store.js` records it in that branch like a till sale: stock goes down, a sale is added (seller "Online shop", method "Online"), a stock move and an activity entry are logged, and a delivery job is created if they chose delivery. Orders are handled one at a time, so the last item can never be sold twice; if an item sells out while someone is paying, the order is flagged in the activity trail for a refund.

**Managing the shop in the POS** (🌐 Online shop menu): *Orders* (every online order with customer, branch, items and payment; mark ready → collected/delivered, which also completes the delivery job; cancel unpaid orders; mark sold-out orders refunded), *Products* (show or hide each product online, add photos), *Customers* (all accounts; block or unblock) and *Settings* (open/close the shop for orders, announcement banner, pickup and delivery on/off, delivery note). The owner has all four; in Staff → 🔑 Access the owner can give any staff member any of the four. The server checks these permissions on every request (`/api/store/admin/*`), and every action is written to the activity trail.

**Customer accounts**: anyone can browse and fill a cart, but checking out needs an account (name, phone number, optional email, password). Customers can sign in, see their orders under *My account*, change their details and password, and reset a forgotten password with a code sent to their email. Accounts are kept in Supabase (`web_accounts`, through token-checked functions), never in the data the tills sync. Each account is added to the POS **Customers** list of the customer's branch (an existing customer with the same phone number is reused), and online sales are linked to that customer.

**Password reset by SMS**: staff (POS → Forgot password → 📱 Text me a code) and online shop customers (Sign in → Forgot password) get a 6-digit code by SMS to the phone on their account (email remains an option). Codes are kept as hashes in Supabase (`otp_codes`, token-checked functions) so every server process can check them; 15 minutes, 5 tries, one code per minute.

**SMS receipts** (USMS-GH): after every purchase the customer gets a thank-you SMS with a link to their receipt, e.g. `https://renatel.shop/r/k601.mqAHrtyc8z` (branch + sale number + a signature, so receipt links can't be guessed). Online orders: sent when the payment is recorded. Till sales: sent automatically when the buyer's phone is entered (any receipt can also be re-sent from its menu: 📱 Send receipt by SMS). The owner sets it up in 🌐 Online shop → ⚙️ Settings → 📱 SMS receipts: paste the USMS-GH API token (Developers page) and the approved sender ID; the server checks the token with USMS-GH and keeps both in Supabase `site_secrets`. The message can be edited ({shop} {name} {no} {total} {link}); it uses "GHS" so each text is one standard SMS.

**Product photos**: add one in the product form (take a picture or choose a file; it is shrunk on the device first). Photos are kept in Supabase (`shop_photos`, through token-checked functions) and cached on the hosting in `~/renatel-photos`, and served at `/img/<code>`. Product records only hold the photo code, so the tills stay fast.

Payments use **Paystack** (Mobile Money and cards). The owner connects it in the POS: 🌐 Online shop → ⚙️ Settings → 💳 Payments → paste the Paystack Secret Key. The server checks the key with Paystack, keeps it privately in Supabase (`site_secrets`, write-only function `site_secret_set`), and the shop switches from practice payments to Paystack at once (a `sk_test_` key uses Paystack's test mode, `sk_live_` takes real money). Set the Paystack webhook to `https://renatel.shop/api/store/paystack`. `PAYSTACK_SECRET_KEY` on the hosting, if set, takes priority. With no key the shop runs in **test mode**: a practice payment screen, no money moves, but stock and sales are real.

### Credit and reminders
- At the till, a sale paid (fully or partly) by **Credit** needs a pay-by date: 7, 14 or 30 days, or any date.
- The customer gets an SMS with the amount on credit, the pay-by date and a link to their invoice (`/i/<code>`).
- From the pay-by date, the server texts every customer whose balance is due, once a day at the time set in Online shop → Settings → Credit reminders (default 9:00, Ghana time), until the balance is paid. Only one server process sends each reminder (`job_once` table).
- On the invoice (or from My account on the online shop) the customer taps **I have paid** with the amount, method and transaction ID. Staff who manage customers see it in **Customers → Payments to approve**; approving records the payment (lowers the balance) and texts a thank-you; rejecting texts the customer. Reminders pause while a claim waits (up to 3 days).
- In a customer's profile: change the pay-by date, pause/resume reminders, text a reminder now, copy the invoice link.
- Older credit sales made before this feature have no pay-by date, so they are not reminded until you set one in the profile.

### Delivery SMS
- When a rider is assigned (at the till or in Deliveries), the rider gets an SMS with the items, customer name and phone, address, GPS, amount to collect and note. Riders need a phone number in Staff.
- **Out for delivery** texts the customer that it is on the way, with the rider's name and phone. **Delivered** texts the customer that it was delivered to the address. That includes online orders marked delivered.
- **📦 To courier** hands a delivery over to a courier company, bus station or another rider, with phone and waybill number. The status becomes *With courier*, the customer is texted the courier details, and the courier can be texted the delivery details. You can hand over again for more legs.
- **📱** in Deliveries sends any instructions by SMS to the rider, the courier, another rider, the customer or any number.
- Each automatic text can be switched off in Online shop → Settings → Delivery SMS. Every SMS is recorded in the activity log.

## Hosting
The site is hosted on Hostinger as a small Node.js app: `server.js` serves `index.html` and has no dependencies. Every push to `main` deploys automatically.

To try it on your own computer: `npm start`, then open http://localhost:3000.

## Notes
- No keys or secrets are stored in this repository.
- Shop data is not stored here. It lives in the browser or in the shop database.
