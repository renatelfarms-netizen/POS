# Tessa POS (test version)

Built from the Renatel Shop app. Many shops each run their own shop on one website.

- `/` platform page: main page; `/register` create a shop (free to use); `/login` find your shop
- `/<shop-link>` a shop's app, e.g. `/kofi-mart`. Staff log in there with name + password.
- `/admin` platform admin: every shop, pause / open, notes

Each shop's data, staff, logins, backups and limits are kept apart by shop id.
A login token from one shop is refused by every other shop.

## Files
- `server.js` web server (no dependencies)
- `index.html` the shop app
- `landing.html` platform page, `admin.html` admin page
- `schema.sql` the database tables and functions (run once in Supabase)

## Environment variables
- `SUPABASE_URL`, `SUPABASE_KEY`, `SUPABASE_BACKUP_TOKEN`
- `PLATFORM_ADMIN_PASSWORD` password for /admin
- `PLATFORM_NAME` (default "Tessa POS"), `PLATFORM_HOST` (e.g. the domain)
- `MAIL_API_BASE` optional; mail settings are read from `site_secret_get` in Supabase

## Not done yet
- More than two branches per shop.
