# Mictobystar apps

Build files for the Mictobystar POS apps. The POS itself is on the `mictobystar` branch; this branch only wraps it.

- `windows/` is a small Electron app. It opens the POS website (`/pos?app=windows`) in its own window.
- `android/` is a Trusted Web Activity. It opens the POS website (`/pos?app=android`) full screen in Chrome's engine.
- `site.txt` (and `windows/site.txt`) is the website the apps open. Change both and push to build apps for a new address. The website must also serve `/.well-known/assetlinks.json` for the Android app (it does, from the `mictobystar` branch).

`?app=…` puts the POS in app mode on that device: it keeps a copy of the shop there, works without internet, and sends everything to the shop when the internet is back.

Every push to this branch builds both apps on GitHub and publishes them as the release `mictobystar-apps`:

- Windows: https://github.com/renatelfarms-netizen/POS/releases/download/mictobystar-apps/Mictobystar-Setup.exe
- Android: https://github.com/renatelfarms-netizen/POS/releases/download/mictobystar-apps/Mictobystar.apk

Build output is kept in the `build-logs` release.
