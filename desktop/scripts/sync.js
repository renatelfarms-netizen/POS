// Copies the shop page (../index.html) into the desktop app before building.
const fs = require('fs');
const path = require('path');
const src = path.join(__dirname, '..', '..', 'index.html');
const dst = path.join(__dirname, '..', 'app', 'index.html');
if (!fs.existsSync(src)) {
  console.error('Cannot find ' + src);
  process.exit(1);
}
fs.mkdirSync(path.dirname(dst), { recursive: true });
fs.copyFileSync(src, dst);
console.log('Copied index.html (' + fs.statSync(dst).size + ' bytes) into app/');
