# Mictobystar POS

This branch (`mictobystar`) is the Mictobystar shop: a separate shop from Renatel Shop, with its own website, its own Supabase project (`mictobystar`) and its own backups and photos on the hosting (`~/mictobystar-backups`, `~/mictobystar-photos`). It shares no data with renatel.shop. **Mictobystar is POS only: there is no online shop.** The home page opens the POS (`/pos`), the customer shop pages and their API are switched off in `server.js` (`posOnly`), and the old 🌐 Online shop menu is a 📱 SMS menu for the owner (SMS receipts, credit reminders, delivery texts). The Online shop, customer accounts and Paystack sections below describe the main POS and do not apply here; receipt (`/r/…`) and invoice (`/i/…`) links in texts still work.

### Windows and Android apps, and working offline (Mictobystar)
- The apps are built from the `mictobystar-apps` branch (an Electron wrapper for Windows, a Trusted Web Activity for Android) and published as the GitHub release `mictobystar-apps`. They open `/pos?app=windows` or `/pos?app=android`. Settings → Data has the download links.
- `?app=…` marks the device (localStorage `mb-app`) and turns on **app mode** (`APPM` in `index.html`). Only in app mode: `sw.js` keeps the page on the device, the page keeps a copy of the shop in IndexedDB (`mb-offline`: every stored document as it is on the device, plus each document as last seen in the shop), there is no lock screen when the internet drops, and staff can log in offline against the copy.
- Back online, the page logs in to the shop again and `firstLoad`/`applyRemote` merge each document three ways (`merge3`): what only one side changed is taken from that side; stock (`stock`, `wh`) and customer balances (`owed`, `adv`) move by the difference, so sales made offline and sales made on other tills both count; lists (sales, expenses, the trail) merge record by record.
- Receipt numbers: the apps keep about 150 numbers reserved from the shop for offline use; if they run out, a long time-based number is used.
- Texts (SMS), online backups, password reset codes and new product photos need internet. In an ordinary browser nothing changed: the shop locks while offline and keeps nothing on the device.
- **Automatic updates**: the server stamps the page with its version (`<meta name="pos-v">`, a hash of `index.html`) and answers `GET /api/version`. Whenever the device is online (on opening, every 5 minutes, when the internet comes back, when the app comes to the front), the page checks; if a newer version is live it reloads by itself as soon as nothing is in progress (empty till, no open window, nothing typed, offline work sent), then shows “Mictobystar updated”. The service worker fetches the page fresh whenever the website answers.
- `/.well-known/assetlinks.json` (`assetlinks.json`) lets the Android app show the site full screen; it holds the fingerprint of the app's signing key.

### Customers, debts, dates and looks (Mictobystar)
- **Buyer details are optional per sale**: on the Sell page, *👤 With buyer details* / *🚶 Without details (walk-in)* (`bwalk`), even when Settings requires a buyer. With details, *💾 Save this buyer to my customers list* (`bsave`) can be unticked: the name and phone then go on the receipt only (`custName`, `custPhone` on the sale). Credit, advance and delivery sales always save the customer.
- **✏️ Edit customer** (`custEdit`) from the customers list, the customer’s profile, the Sell page (returning customer), the debt lists, the receipt and the ⋯ sale menu. A new name is copied to that customer’s receipts.
- **Customers page tabs**: 👥 All customers (with search), 💳 Who owes us (overdue filter, PDF, CSV) and 📜 Customer history (bought, on credit, paid back, owes now and last visit for any period; CSV and PDF, also a *Customer history* type in Send report). Debt payments are kept on the customer (`payLog`); older ones are read from the activity trail.
- **Home** shows the customers who owe (owners, managers and accountants); *Owed to you ›* opens the full list.
- **📅 Pick dates** (`CR`, `rangeAB('custom')`) on Reports (shop and warehouse), Receipts, Expenses, Customer history and Send report (PDF).
- **More fonts** for the whole website (Settings → Themes), and more receipt design options: any website font for the receipt or just the shop name, very small to very large text, bold text, line spacing, one-line items, message/footer alignment, customer phone and number of items.

### Sale types on the Sell page (Mictobystar)
- **🛒 Sale / 📅 Credit sale / 📃 Invoice only** chips at the top of the current sale. Credit sale selects Credit and asks for the pay-by date. Invoice only makes an invoice to print or send without taking stock or recording a sale or payment (kept in the `quotes` collection, listed under Receipts → Invoices only, where it can be turned into a sale or deleted).
- **📦 Pay now, collect later**: tick it, give the collection date and time; the sale is charged and stock is set aside at once, and it waits under Receipts → Paid, waiting to be collected until someone marks it Collected. On unless `set.pickup` is `false`.
- **💰 Advance payment**: Customers → 💰 Advance (or the customer's profile) records money a customer pays before buying (`adv` and `advLog` on the customer; it can first pay off what they owe, and can text the customer). At the till, entering that customer as the buyer shows the advance and **Use advance**, which pays with the method `Advance` (with Split payment for the rest if the advance is not enough). Refunds can go back to the advance, deleting or editing a sale puts the advance right, and Reports show advance received, given back and held.
 Every push to this branch deploys to the Mictobystar website only. `SITE_URL` on the hosting must be the shop's address (it is used in SMS receipt and invoice links): change it when the domain changes.

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
The POS runs online at the shop's address + `/pos` (the home page is the customers' online shop). Open it in any browser on a phone, tablet or computer. There is no app to install.

On the website everything runs centrally from the host: nothing about the shop is stored on phones or computers, and devices are not registered or named. Staff open the shop with their own name and password (full name, either name, or the names in any order). `server.js` checks the login against the shop's staff list (`POST /api/login`) and gives that browser tab a signed session for one day; "Sign out every device" ends all sessions, and `POST /api/reset` resets a password with the shop recovery code. The shop lives in Supabase (`shop_docs`), reached only through locked-down database functions that accept the server's `SUPABASE_BACKUP_TOKEN`; record numbers come from a central sequence (`shop_ids`). Each person opens on their own branch (set on their staff record; the owner can use both).

**Online only**: the POS works only while the device can reach the website. If the connection drops, a full-screen "No internet connection" lock covers the shop within a few seconds: nothing can be entered, changed or printed, and it unlocks by itself when the connection is back (a change made in the last moments before the drop is saved then). A receipt prints only after the sale is saved in the shop database.

Backups are made by the server only: every 10 minutes, if anything changed, the whole shop is saved on the hosting (outside the website folder) and in Supabase; all backups from the last 2 days are kept, then one a day for 90 days. Owners and managers can press Back up now; only the owner can restore, which signs everyone out. Inside Claude, the page uses Claude's built-in shop database instead, and Gmail for emailed reports and reset codes.

## Online shop
Customers buy at the shop's home page and pay online (old `/store` links still work). The staff POS is at `/pos` (a 🔐 POS button appears on the shop on staff devices). **Every product in the POS is on the shop** (with its photo, price and live stock) unless the owner ticks **Hide from the online shop** in the product form.

Each customer is served by the **nearest branch**: on their first visit they choose their region or tap *Use my location*, and the shop picks Kumasi or Accra by distance (Greater Accra, Eastern, Central, Western and Volta → Accra; the rest → Kumasi). They see that branch's products and stock, and when the payment succeeds `store.js` records it in that branch like a till sale: stock goes down, a sale is added (seller "Online shop", method "Online"), a stock move and an activity entry are logged, and a delivery job is created if they chose delivery. Orders are handled one at a time, so the last item can never be sold twice; if an item sells out while someone is paying, the order is flagged in the activity trail for a refund.

**Managing the shop in the POS** (🌐 Online shop menu): *Orders* (every online order with customer, branch, items and payment; mark ready → collected/delivered, which also completes the delivery job; cancel unpaid orders; mark sold-out orders refunded), *Products* (show or hide each product online, add photos), *Customers* (all accounts; block or unblock) and *Settings* (open/close the shop for orders, announcement banner, pickup and delivery on/off, delivery note). The owner has all four; in Staff → 🔑 Access the owner can give any staff member any of the four. The server checks these permissions on every request (`/api/store/admin/*`), and every action is written to the activity trail.

**Customer accounts**: anyone can browse and fill a cart, but checking out needs an account (name, phone number, optional email, password). Customers can sign in, see their orders under *My account*, change their details and password, and reset a forgotten password with a code sent to their email. Accounts are kept in Supabase (`web_accounts`, through token-checked functions), never in the data the tills sync. Each account is added to the POS **Customers** list of the customer's branch (an existing customer with the same phone number is reused), and online sales are linked to that customer.

**Password reset by SMS**: staff (POS → Forgot password → 📱 Text me a code) and online shop customers (Sign in → Forgot password) get a 6-digit code by SMS to the phone on their account (email remains an option). Codes are kept as hashes in Supabase (`otp_codes`, token-checked functions) so every server process can check them; 15 minutes, 5 tries, one code per minute.

**SMS receipts** (USMS-GH): after every purchase the customer gets a thank-you SMS with a link to their receipt, e.g. `https://<shop address>/r/k601.mqAHrtyc8z` (branch + sale number + a signature, so receipt links can't be guessed). Online orders: sent when the payment is recorded. Till sales: sent automatically when the buyer's phone is entered (any receipt can also be re-sent from its menu: 📱 Send receipt by SMS). The owner sets it up in 🌐 Online shop → ⚙️ Settings → 📱 SMS receipts: paste the USMS-GH API token (Developers page) and the approved sender ID; the server checks the token with USMS-GH and keeps both in Supabase `site_secrets`. The message can be edited ({shop} {name} {no} {total} {link}); it uses "GHS" so each text is one standard SMS.

**Product photos**: add one in the product form (take a picture or choose a file; it is shrunk on the device first). Photos are kept in Supabase (`shop_photos`, through token-checked functions) and cached on the hosting in `~/mictobystar-photos`, and served at `/img/<code>`. Product records only hold the photo code, so the tills stay fast.

Payments use **Paystack** (Mobile Money and cards). The owner connects it in the POS: 🌐 Online shop → ⚙️ Settings → 💳 Payments → paste the Paystack Secret Key. The server checks the key with Paystack, keeps it privately in Supabase (`site_secrets`, write-only function `site_secret_set`), and the shop switches from practice payments to Paystack at once (a `sk_test_` key uses Paystack's test mode, `sk_live_` takes real money). Set the Paystack webhook to `https://<shop address>/api/store/paystack`. `PAYSTACK_SECRET_KEY` on the hosting, if set, takes priority. With no key the shop runs in **test mode**: a practice payment screen, no money moves, but stock and sales are real.

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
The site is hosted on Hostinger as a small Node.js app: `server.js` serves `index.html` and has no dependencies. Every push to `mictobystar` deploys automatically.

To try it on your own computer: `npm start`, then open http://localhost:3000.

## Notes
- No keys or secrets are stored in this repository.
- Shop data is not stored here. It lives in the browser or in the shop database.
