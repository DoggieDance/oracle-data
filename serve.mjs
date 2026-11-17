// tiny static server with CORS, for local testing of public/
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
const root = path.resolve(process.argv[2] || 'public'), port = +(process.argv[3] || 4803);
http.createServer((q, r) => {
  const f = path.join(root, decodeURIComponent(q.url.split('?')[0]));
  if (!f.startsWith(root) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { r.writeHead(404, { 'access-control-allow-origin': '*' }); return r.end(); }
  r.writeHead(200, { 'access-control-allow-origin': '*', 'content-type': f.endsWith('.json') ? 'application/json' : 'text/html' }); fs.createReadStream(f).pipe(r);
}).listen(port, () => console.log('serving', root, 'on', port));
