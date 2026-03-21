const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 5173;
const ROOT = __dirname;
const MIME = {
  html: 'text/html',
  js:   'application/javascript',
  css:  'text/css',
  jpg:  'image/jpeg',
  png:  'image/png',
  ico:  'image/x-icon',
};

http.createServer((req, res) => {
  const filePath = path.join(ROOT, req.url === '/' ? 'index.html' : req.url);
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    res.writeHead(404); return res.end('Not found');
  }
  const ext = filePath.split('.').pop();
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'text/plain',
    'Access-Control-Allow-Origin': '*',
  });
  fs.createReadStream(filePath).pipe(res);
}).listen(PORT, () => console.log(`VR server running on http://localhost:${PORT}`));
