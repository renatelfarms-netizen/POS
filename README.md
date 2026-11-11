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
- Customer logins, signed links, photos, keys, one-time codes and jobs are kept apart by shop (`schema_shop_features.sql`).

## Files
- `server.js` web server (no dependencies)
- `index.html` the shop app
- `landing.html` platform page, `admin.html` admin page
- `schema.sql` the database tables and functions (run once in Supabase)
- `schema_shop_features.sql` per-shop tables and functions for the online shop, SMS and reminders (run once, after schema.sql)
- `store.js`, `store.html` the online shop (shared with Renatel Shop)

## Environment variables
- `SUPABASE_URL`, `SUPABASE_KEY`, `SUPABASE_BACKUP_TOKEN`
- `PLATFORM_ADMIN_PASSWORD` password for /admin
- `PLATFORM_NAME` (default "Tessa POS"), `PLATFORM_HOST` (e.g. the domain)
- `MAIL_API_BASE` optional; mail settings are read from `site_secret_get` in Supabase

## Not done yet
- More than two branches per shop.
