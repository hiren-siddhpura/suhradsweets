import { createServer, request as httpRequest } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { networkInterfaces } from 'node:os';

const root = resolve(fileURLToPath(new URL('.', import.meta.url)));
const port = Number(process.env.OMS_DEV_PORT || 8000);
const types = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.ttf': 'font/ttf',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
};

function ipv4Number(address) {
  const parts = address?.replace(/^::ffff:/, '').split('.').map(Number);
  if (!parts || parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
  return parts.reduce((value, part) => ((value << 8) | part) >>> 0, 0);
}

function allowedPeer(request) {
  const remote = request.socket.remoteAddress;
  if (remote === '::1' || remote === '127.0.0.1' || remote === '::ffff:127.0.0.1') return true;
  const peer = ipv4Number(remote);
  const local = ipv4Number(request.socket.localAddress);
  if (peer === null || local === null) return false;
  return Object.values(networkInterfaces()).flat().some((entry) => {
    if (entry.family !== 'IPv4' || entry.internal || ipv4Number(entry.address) !== local) return false;
    const mask = ipv4Number(entry.netmask);
    return mask !== null && (peer & mask) === (local & mask);
  });
}

// Proxy only the browser SDK's emulator APIs. Firebase emulators stay bound to
// loopback, so the LAN exposes only this development server's port.
function emulatorPort(path) {
  if (path.startsWith('/identitytoolkit.googleapis.com/') || path.startsWith('/securetoken.googleapis.com/')) return 9099;
  if (path.startsWith('/google.firestore.v1.Firestore/') || path.startsWith('/v1/projects/demo-suh-oms/databases/')) return 8080;
  if (path.startsWith('/demo-suh-oms/us-central1/')) return 5001;
  if (path.startsWith('/v0/b/')) return 9199;
  return null;
}

function proxyEmulator(request, response, targetPort) {
  const headers = { ...request.headers, host: `127.0.0.1:${targetPort}` };
  delete headers.connection;
  const upstream = httpRequest({ hostname: '127.0.0.1', port: targetPort, path: request.url,
    method: request.method, headers }, (upstreamResponse) => {
    response.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.headers);
    upstreamResponse.pipe(response);
  });
  upstream.on('error', () => { if (!response.headersSent) response.writeHead(502); response.end('Local emulator unavailable.'); });
  request.pipe(upstream);
}

createServer(async (request, response) => {
  if (!allowedPeer(request)) { response.writeHead(403).end('Local network access only.'); return; }
  const rawPath = new URL(request.url, 'http://localhost').pathname;
  const targetPort = emulatorPort(rawPath);
  if (targetPort) { proxyEmulator(request, response, targetPort); return; }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405).end();
    return;
  }
  let path;
  try {
    path = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
  } catch {
    response.writeHead(400).end();
    return;
  }
  if (path.split('/').some((part) => part.startsWith('.') && part !== '.')) {
    response.writeHead(404).end();
    return;
  }
  const file = resolve(root, `.${path === '/' ? '/index.html' : path}`);
  if (file !== root && !file.startsWith(root + sep)) {
    response.writeHead(404).end();
    return;
  }
  try {
    let content = await readFile(file);
    if (path === '/' || path === '/index.html') content = Buffer.from(content.toString().replace('</head>', '<script>window.__OMS_LOCAL_EMULATOR_PROXY__ = true;window.__OMS_LOCAL_EMULATOR_CONFIG__ = {apiKey:"demo-local-key",authDomain:"demo-suh-oms.firebaseapp.com",projectId:"demo-suh-oms",storageBucket:"demo-suh-oms.firebasestorage.app",appId:"demo-local-app"};</script></head>'));
    response.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    response.end(request.method === 'HEAD' ? undefined : content);
  } catch {
    response.writeHead(404).end();
  }
}).listen(port, '0.0.0.0', () => console.log(`Suhrad Sweets OMS: http://localhost:${port}`));
