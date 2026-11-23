import { timingSafeEqual } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { readConfig } from './config.mjs';

const hostname = '127.0.0.1';
const port = 18188;
const address = `${hostname}:${port}`;
const { requestKey } = await readConfig();
const expectedKey = Buffer.from(requestKey);
const dataDir = fileURLToPath(new URL('./data/', import.meta.url));
await mkdir(dataDir, { recursive: true });
process.env.LAPLACE_LOGIN_SYNC_DATA_DIR = dataDir;
process.env.LAPLACE_LOGIN_SYNC_AUTH_MODE = '1';
process.env.LAPLACE_LOGIN_SYNC_AUTH_KEY = requestKey;
const { default: upstream } = await import('./upstream/src/index.ts');

export default {
  hostname,
  port,
  maxRequestBodySize: 4 * 1024 * 1024,
  async fetch(request) {
    const origin = request.headers.get('Origin');
    const key = Buffer.from(request.headers.get('X-LSC-Install') || '');
    if (request.headers.get('Host') !== address ||
        (origin && !/^chrome-extension:\/\/[a-p]{32}$/u.test(origin)) ||
        key.length !== expectedKey.length || !timingSafeEqual(key, expectedKey)) {
      return new Response(null, { status: 403 });
    }

    const { pathname, search } = new URL(request.url);
    if (pathname === '/health' && request.method === 'GET') {
      return Response.json({ service: 'laplace-sc-login-sync' }, { headers: { 'Cache-Control': 'no-store' } });
    }
    if (search || request.method !== 'POST' || !/^(?:\/update|\/remove|\/get\/[a-zA-Z0-9]{1,128})$/u.test(pathname)) {
      return new Response(null, { status: 404 });
    }

    const response = await upstream.fetch(request);
    const headers = new Headers(response.headers);
    headers.delete('Access-Control-Allow-Origin');
    headers.set('Cache-Control', 'no-store');
    return new Response(response.body, { status: response.status, headers });
  }
};
