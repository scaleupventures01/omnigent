import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import path from 'node:path';

const HOST = '127.0.0.1';
const PORT = 6789;
const DATA_PATH = process.env.OMNI_STATUSLINE_DATA ?? path.join(homedir(), '.claude', 'statusline-data.json');
const ALLOWED_ORIGINS = new Set([
  'http://localhost:6767',
  'http://127.0.0.1:6767',
  'http://localhost:6768',
  'http://127.0.0.1:6768',
]);

function corsHeaders(request) {
  const origin = request.headers.origin;

  if (!origin || !ALLOWED_ORIGINS.has(origin)) {
    return {};
  }

  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    Vary: 'Origin',
  };
}

const server = createServer(async (request, response) => {
  const headers = corsHeaders(request);

  if (request.method === 'OPTIONS' && request.url === '/statusline') {
    response.writeHead(204, {
      ...headers,
      'Cache-Control': 'no-store',
    });
    response.end();
    return;
  }

  if (request.method !== 'GET' || request.url !== '/statusline') {
    response.writeHead(404, {
      ...headers,
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    response.end(JSON.stringify({ error: 'Not found' }));
    return;
  }

  try {
    const contents = await readFile(DATA_PATH, 'utf8');
    JSON.parse(contents);
    response.writeHead(200, {
      ...headers,
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    response.end(contents);
  } catch (error) {
    console.error('Failed to serve statusline data:', error);
    response.writeHead(500, {
      ...headers,
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    response.end(JSON.stringify({ error: 'Unable to read statusline data' }));
  }
});

server.on('clientError', (error, socket) => {
  console.error('HTTP client error:', error);
  socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
});

server.on('error', (error) => {
  console.error('Statusline server error:', error);
});

server.listen(PORT, HOST);
