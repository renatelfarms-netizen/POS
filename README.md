# Tessa POS (test version)

Built from the Renatel Shop app. Many shops each run their own shop on one website.

- `/` platform page: main page; `/register` create a shop (free to use); `/login` find your shop
- `/<shop-link>` a shop's app, e.g. `/kofi-mart`. Staff log in there with name + password.
- `/admin` platform admin: every shop, pause / open, notes
- `/help` help page: step-by-step guides with pictures and the support WhatsApp number (`help.html`)

Each shop's data, staff, logins, backups and limits are kept apart by shop id.
A login token from one shop is refused by every other shop.

## Each shop also gets (same features as Renatel Shop)
- **Online shop** at `/<shop-link>/shop`: customers create an account, buy and pay; stock is taken from the shop's branch. Receipts at `/<shop-link>/r/…`, credit invoices at `/<shop-link>/i/…`, product photos at `/<shop-link>/img/…`.
- **Paystack** (Mobile Money and cards): each shop owner pastes their own secret key in Online shop → Settings. Webhook: `/<shop-link>/api/store/paystack`.
- **SMS (USMS-GH)**: each shop uses its own USMS-GH token and sender ID. Receipt SMS, password reset codes, credit reminders and delivery texts.
- **Credit reminders** (daily, once per customer per day; the platform runs the job for every open shop) and "I have paid" approval.
- **Delivery SMS**: rider jobs, on the way, courier handover, delivered, instructions.
- **Reminder SMS to shop owners** (platform, from the shared SMS account): owners who created a shop but added nothing (day 1, 3, 7), set it up but never used it (2, 5, 10 days after they were last seen) or went quiet after using it (7, 14, 30 days) get a short text with their shop link and the support WhatsApp number (`SUPPORT_WHATSAPP`, default 0244022727). Shops in use get nothing. Sent 9am to 6pm Ghana time, each message once (`mt_job_once`). Off until switched on at `/admin`, which shows who is due, the exact text, what was sent, and lets one shop be muted. Settings and the sent list are kept in `mt_kv` 'nudge'.
- **Admin page** (`/admin`): boxes on top count the shops (all, joined today, joined this week, in use, set up but not used, not started, gone quiet, paused); tap one to see those shops. The list shows for each shop its type, town, products, staff, sales, online orders and when it was last active, with search, filters, type of business and ordering (newest first by default). Payments, SMS and reminder settings are on their own tab. The details come from one database call, `mt_shop_stats`; without it the list still loads, with fewer details.
- **Withdrawals**: shops that take online payments through the platform's Paystack see their money in Online shop → Settings → Payments (and on top of the Online shop page). The **owner only** presses Withdraw (any amount up to what is still owed, no minimum, one request at a time). The request shows at the top of `/admin` (🔔 Withdrawal requests, with the amount and the account to pay); the admin pays within 24 hours and records the payout, which closes the request and texts the owner. Requests are kept per shop in `mt_docs` ('platWd'); `mt_wd_list` reads them all for `/admin`.
- Customer logins, signed links, photos, keys, one-time codes and jobs are kept apart by shop (`schema_shop_features.sql`).

## Files
- `server.js` web server (no dependencies)
- `index.html` the shop app
- `landing.html` platform page, `admin.html` admin page
- `schema.sql` the database tables and functions (run once in Supabase)
- `schema_shop_features.sql` per-shop tables and functions for the online shop, SMS and reminders (run once, after schema.sql)
- `store.js`, `store.html` the online shop (shared with Renatel Shop)

## Environment variables
- `SUPABASE_URL`, `SUPABASE_KEY`, `SUPABASE_BACKUP_TOKEN` (`SUPABASE_KEY` is the secret / service_role key; the database functions refuse the public key)
- `PLATFORM_ADMIN_PASSWORD` password for /admin
- `PLATFORM_NAME` (default "Tessa POS"), `PLATFORM_HOST` (e.g. the domain)
- `MAIL_API_BASE` optional; mail settings are read from `site_secret_get` in Supabase

## Not done yet
- More than two branches per shop.
