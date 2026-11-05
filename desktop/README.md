# Renatel Shop POS: Windows app

The shop page (`../index.html`) packaged as a Windows desktop app with Electron.

## Install (for the shop)
1. Run `Renatel-Shop-POS-Setup-1.0.0.exe`.
2. If Windows shows "Windows protected your PC", choose **More info**, then **Run anyway**. The installer is not code-signed yet, so Windows warns about every unsigned app.
3. Open **Renatel Shop POS** from the desktop or Start menu shortcut.

## Where the data is saved
The app saves the shop's data on that computer, in the app's own folder (`%APPDATA%\Renatel Shop POS`). Each computer has its own copy of the data.

Because it runs outside Claude, these features are not available in the desktop app: the shared shop database, emailing reports and reset codes through Gmail, and SMS. Reports can still be saved as PDF (needs internet the first time) and shared through the WhatsApp links.

### Moving your shop's data to the app
1. In the existing shop page: **Settings, Data & backup, Create & copy backup**.
2. In the desktop app: create the owner account, log in, then **Settings, Data & backup**. Paste the backup into the restore box and press **Restore**.

Make a backup regularly. Uninstalling the app does not remove its data, but deleting the `%APPDATA%\Renatel Shop POS` folder does.

## Build it yourself
Needs Node.js 20 or newer.

```
cd desktop
npm install
npm run dist      # builds dist/Renatel-Shop-POS-Setup-<version>.exe
npm start         # runs the app without building an installer
```

`npm run sync` (run automatically) copies `../index.html` into `app/` so the app always uses the latest shop page.

## How it works
- `main.js`: the window, links that open in the browser, and the single-instance lock.
- `preload.js`, `dialogPreload.js`, `dialog.html`: replacement pop-up boxes. Desktop apps do not support the browser's `alert`, `confirm` and `prompt`, which the shop page uses.
