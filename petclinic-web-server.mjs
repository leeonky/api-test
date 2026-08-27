import { createReadStream } from 'node:fs';
import { access, readFile, stat } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = process.env.PUBLIC_DIR ?? path.join(__dirname, 'public');
const backendOrigin = process.env.BACKEND_ORIGIN ?? 'http://backend:9966';
const port = Number(process.env.PORT ?? 10081);

const contentTypes = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.ico', 'image/x-icon'],
  ['.js', 'application/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.map', 'application/json; charset=utf-8'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2']
]);

function sendError(res, statusCode, message) {
  res.writeHead(statusCode, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(message);
}

async function proxyRequest(req, res) {
  const targetUrl = new URL(req.url, backendOrigin);
  const headers = new Headers();

  for (const [key, value] of Object.entries(req.headers)) {
    if (value !== undefined) {
      headers.set(key, Array.isArray(value) ? value.join(', ') : value);
    }
  }

  headers.set('host', new URL(backendOrigin).host);

  const upstream = await fetch(targetUrl, {
    method: req.method,
    headers,
    body: req.method === 'GET' || req.method === 'HEAD' ? undefined : req,
    duplex: 'half'
  });

  const responseHeaders = {};
  upstream.headers.forEach((value, key) => {
    if (key !== 'transfer-encoding' && key !== 'content-encoding') {
      responseHeaders[key] = value;
    }
  });

  res.writeHead(upstream.status, responseHeaders);

  if (!upstream.body || req.method === 'HEAD') {
    res.end();
    return;
  }

  for await (const chunk of upstream.body) {
    res.write(chunk);
  }
  res.end();
}

function resolveFilePath(urlPathname) {
  const decodedPath = decodeURIComponent(urlPathname);
  const requestedPath = decodedPath === '/' ? '/index.html' : decodedPath;
  const normalizedPath = path.normalize(requestedPath).replace(/^(\.\.[/\\])+/, '');
  return path.join(publicDir, normalizedPath);
}

async function serveFile(filePath, res) {
  const extension = path.extname(filePath);
  const contentType = contentTypes.get(extension) ?? 'application/octet-stream';

  res.writeHead(200, { 'Content-Type': contentType });
  createReadStream(filePath).pipe(res);
}

async function serveFrontend(req, res) {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
  const candidate = resolveFilePath(url.pathname);

  try {
    const fileStat = await stat(candidate);
    if (fileStat.isFile()) {
      if (req.method === 'HEAD') {
        const extension = path.extname(candidate);
        const contentType = contentTypes.get(extension) ?? 'application/octet-stream';
        res.writeHead(200, { 'Content-Type': contentType });
        res.end();
        return;
      }

      await serveFile(candidate, res);
      return;
    }
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || (error.code !== 'ENOENT' && error.code !== 'ENOTDIR')) {
      throw error;
    }
  }

  const indexPath = path.join(publicDir, 'index.html');
  try {
    await access(indexPath);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      sendError(res, 500, 'Frontend bundle is missing.');
      return;
    }

    throw error;
  }

  if (req.method === 'HEAD') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end();
    return;
  }

  try {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(await readFile(indexPath));
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      sendError(res, 500, 'Frontend bundle is missing.');
      return;
    }

    throw error;
  }
}

const server = http.createServer(async (req, res) => {
  try {
    if (!req.url) {
      sendError(res, 400, 'Missing request URL.');
      return;
    }

    if (req.url.startsWith('/petclinic/')) {
      await proxyRequest(req, res);
      return;
    }

    await serveFrontend(req, res);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    sendError(res, 502, `Upstream request failed: ${message}`);
  }
});

server.listen(port, '0.0.0.0');
