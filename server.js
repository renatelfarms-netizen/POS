'use strict';
// Web server for renatel.shop: serves the shop page (index.html).
// No dependencies. The desktop app in desktop/ is separate and is not run here.
const http = require('http');
const fs = require('fs');
const path = require('path');

const PAGE = path.join(__dirname, 'index.html');
const PORT = process.env.PORT || 3000;

const HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-cache',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'SAMEORIGIN',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Strict-Transport-Security': 'max-age=31536000',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()'
};

let cache = null;
function page() {
  if (!cache) cache = fs.readFileSync(PAGE);
  return cache;
}

http.createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' });
    return res.end();
  }
  const url = (req.url || '/').split('?')[0];
  if (url === '/robots.txt') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end('User-agent: *\nDisallow: /\n');
  }
  if (url === '/favicon.ico') {
    res.writeHead(204);
    return res.end();
  }
  // Every other address shows the shop page (it is a single-page app).
  try {
    const body = page();
    res.writeHead(200, HEADERS);
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch (e) {
    console.error(e);
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('The shop page is missing.');
  }
}).listen(PORT, () => console.log('Renatel Shop running on port ' + PORT));
