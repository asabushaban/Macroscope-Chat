'use strict';

const http = require('node:http');
const { spawn } = require('node:child_process');
const { randomBytes, timingSafeEqual } = require('node:crypto');
const { readFile } = require('node:fs/promises');
const path = require('node:path');

const HOST = '127.0.0.1';
const PORT = 8787;
const LOCAL_ORIGIN = `http://${HOST}:${PORT}`;
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_MESSAGE_LENGTH = 20_000;
const MAX_JSON_BODY = 25_000;
const MAX_REMOTE_BODY = 2_000_000;
const POLL_TIMEOUT_MS = 55 * 60 * 1000;
const DEFAULT_POLL_DELAY_MS = 2_000;
const MIN_POLL_DELAY_MS = 1_000;
const MAX_POLL_DELAY_MS = 15_000;
const MAX_TEMPORARY_ERRORS = 4;
const TUNNEL_START_TIMEOUT_MS = 20_000;
const MAX_INBOUND_MESSAGES = 100;

let settings = initialSettings();
let inboundTunnel = null;
let inboundMessages = [];
let nextInboundMessageId = 1;

function initialSettings() {
  const webhookUrl = process.env.MACROSCOPE_WEBHOOK_URL || '';
  const apiToken = process.env.MACROSCOPE_API_TOKEN || '';
  if (!webhookUrl || !apiToken) return null;
  try {
    validateWebhookUrl(webhookUrl);
    return { webhookUrl, apiToken };
  } catch {
    console.warn('Ignoring invalid Macroscope environment configuration.');
    return null;
  }
}

function validateWebhookUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new ClientError('Enter a valid webhook URL.');
  }
  if (url.protocol !== 'https:') {
    throw new ClientError('The webhook URL must use https://.');
  }
  if (url.username || url.password) {
    throw new ClientError('The webhook URL must not contain credentials.');
  }
  return url.toString();
}

function validatePollUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new MacroscopeError('The webhook returned an invalid polling URL.', 502);
  }
  const isLocal = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !(isLocal && url.protocol === 'http:')) {
    throw new MacroscopeError('The webhook returned an unsafe polling URL.', 502);
  }
  if (url.username || url.password) {
    throw new MacroscopeError('The webhook returned an invalid polling URL.', 502);
  }
  return url.toString();
}

function randomToken(bytes = 24) {
  return randomBytes(bytes).toString('base64url');
}

function secretsMatch(actual, expected) {
  const actualBuffer = Buffer.from(String(actual || ''));
  const expectedBuffer = Buffer.from(String(expected || ''));
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

function publicInboundState() {
  if (!inboundTunnel) return { status: 'stopped' };
  return {
    status: inboundTunnel.publicUrl ? 'ready' : 'starting',
    webhookUrl: inboundTunnel.publicUrl
      ? `${inboundTunnel.publicUrl}/hooks/${inboundTunnel.pathToken}`
      : undefined,
  };
}

function startInboundTunnel() {
  if (inboundTunnel) {
    return inboundTunnel.readyPromise || Promise.resolve(publicInboundState());
  }
  const address = inboundServer.address();
  if (!address || typeof address === 'string') {
    return Promise.reject(new ClientError('The local webhook listener is not ready yet.', 503));
  }

  const child = spawn('cloudflared', ['tunnel', '--url', `http://${HOST}:${address.port}`], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  inboundTunnel = {
    child,
    pathToken: randomToken(32),
    publicUrl: '',
  };

  const readyPromise = new Promise((resolve, reject) => {
    let settled = false;
    let output = '';
    const timeout = setTimeout(() => {
      fail(new ClientError('Cloudflare Tunnel did not provide a public URL in time.', 504));
      stopInboundTunnel();
    }, TUNNEL_START_TIMEOUT_MS);

    const fail = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    };
    const inspectOutput = (chunk) => {
      output = `${output}${chunk}`.slice(-12_000);
      const match = output.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
      if (!match || settled || !inboundTunnel || inboundTunnel.child !== child) return;
      inboundTunnel.publicUrl = match[0];
      settled = true;
      clearTimeout(timeout);
      resolve(publicInboundState());
    };

    child.stdout.on('data', inspectOutput);
    child.stderr.on('data', inspectOutput);
    child.once('error', (error) => {
      if (inboundTunnel && inboundTunnel.child === child) inboundTunnel = null;
      fail(new ClientError(
        error.code === 'ENOENT'
          ? 'cloudflared is not installed. Install it with: brew install cloudflared'
          : 'Could not start Cloudflare Tunnel.',
        503
      ));
    });
    child.once('exit', (code) => {
      if (inboundTunnel && inboundTunnel.child === child) inboundTunnel = null;
      if (!settled) fail(new ClientError(`Cloudflare Tunnel stopped before it was ready${code ? ` (exit ${code})` : ''}.`, 503));
    });
  });
  inboundTunnel.readyPromise = readyPromise;
  return readyPromise;
}

function stopInboundTunnel() {
  const current = inboundTunnel;
  inboundTunnel = null;
  if (current && current.child.exitCode === null && !current.child.killed) current.child.kill('SIGTERM');
}

class ClientError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

class MacroscopeError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.status = status;
  }
}

function buildTriggerPayload(message) {
  // This is the single place to change if the webhook expects another field
  // name or needs additional request context in the future.
  return { query: message };
}

async function triggerMacroscope(message, signal) {
  const current = settings;
  if (!current) throw new ClientError('Open Settings and add your Macroscope credentials first.', 409);

  let response;
  try {
    response = await fetch(current.webhookUrl, {
      method: 'POST',
      headers: {
        'X-Webhook-Secret': current.apiToken,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(buildTriggerPayload(message)),
      signal,
    });
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    throw new MacroscopeError('Could not connect to the Macroscope webhook.');
  }

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new MacroscopeError('The Macroscope webhook secret was rejected.', 502);
    }
    if (response.status === 429) {
      throw new MacroscopeError('Macroscope is rate limiting requests. Please try again shortly.', 503);
    }
    throw new MacroscopeError(`The Macroscope webhook returned HTTP ${response.status}.`);
  }

  const data = await readJsonResponse(response, 'The webhook returned a non-JSON response.');
  if (!data || typeof data.pollUrl !== 'string') {
    throw new MacroscopeError('The webhook did not return a polling URL.');
  }
  if (typeof data.jobToken !== 'string' || !data.jobToken) {
    throw new MacroscopeError('The webhook did not return a job token.');
  }
  return { pollUrl: validatePollUrl(data.pollUrl), jobToken: data.jobToken };
}

async function pollMacroscope(pollUrl, jobToken, signal) {
  const startedAt = Date.now();
  let temporaryErrors = 0;
  let nextDelay = 0;

  while (Date.now() - startedAt < POLL_TIMEOUT_MS) {
    if (nextDelay) await abortableDelay(nextDelay, signal);
    let response;
    try {
      response = await fetch(pollUrl, {
        headers: { Authorization: `Bearer ${jobToken}` },
        signal,
      });
    } catch (error) {
      if (error.name === 'AbortError') throw error;
      temporaryErrors += 1;
      if (temporaryErrors > MAX_TEMPORARY_ERRORS) {
        throw new MacroscopeError('The local connection to Macroscope was interrupted.');
      }
      nextDelay = temporaryRetryDelay(temporaryErrors);
      continue;
    }

    if (response.status === 401 || response.status === 403) {
      throw new MacroscopeError('The job token expired. Please send the request again.', 502);
    }

    if (response.status === 429 || response.status >= 500) {
      temporaryErrors += 1;
      if (temporaryErrors > MAX_TEMPORARY_ERRORS) {
        throw new MacroscopeError(
          response.status === 429
            ? 'Macroscope is still rate limiting this job. Please try again later.'
            : 'Macroscope returned repeated server errors while checking the job.'
        );
      }
      nextDelay = retryAfterMs(response.headers.get('retry-after')) || temporaryRetryDelay(temporaryErrors);
      continue;
    }

    if (response.status !== 200 && response.status !== 202) {
      throw new MacroscopeError(`Polling returned unexpected HTTP ${response.status}.`);
    }

    const data = await readJsonResponse(response, 'Macroscope returned a non-JSON polling response.');
    if (!data || typeof data.status !== 'string') {
      throw new MacroscopeError('Macroscope returned a polling response without a status.');
    }

    temporaryErrors = 0;
    if (response.status === 202 || data.status === 'running') {
      nextDelay = retryAfterMs(response.headers.get('retry-after')) || DEFAULT_POLL_DELAY_MS;
      continue;
    }
    if (data.status === 'completed') return formatResult(data.response);
    if (data.status === 'failed') {
      const detail = typeof data.error === 'string' && data.error.trim()
        ? ` ${sanitizeRemoteMessage(data.error, jobToken)}`
        : '';
      throw new MacroscopeError(`The Macroscope request failed.${detail}`);
    }
    throw new MacroscopeError(`Macroscope returned an unexpected job status: ${safeStatus(data.status)}.`);
  }
  throw new MacroscopeError('The request timed out before Macroscope finished.', 504);
}

function formatResult(value) {
  if (typeof value === 'string') return value;
  if (value === undefined) return '';
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function safeStatus(value) {
  return String(value).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40) || 'unknown';
}

function sanitizeRemoteMessage(value, extraSecret = '') {
  let message = String(value).replace(/[\r\n\t]+/g, ' ');
  const secrets = [settings && settings.apiToken, extraSecret].filter(Boolean);
  for (const secret of secrets) message = message.split(secret).join('[redacted]');
  return message.slice(0, 300);
}

function retryAfterMs(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0) return 0;
  return Math.min(MAX_POLL_DELAY_MS, Math.max(MIN_POLL_DELAY_MS, seconds * 1000));
}

function temporaryRetryDelay(attempt) {
  return Math.min(MAX_POLL_DELAY_MS, Math.max(MIN_POLL_DELAY_MS, 1000 * (2 ** attempt)));
}

function abortableDelay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason || new DOMException('Aborted', 'AbortError'));
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason || new DOMException('Aborted', 'AbortError'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

async function readJsonResponse(response, errorMessage) {
  const text = await response.text();
  if (text.length > MAX_REMOTE_BODY) throw new MacroscopeError('Macroscope returned a response that was too large.');
  try {
    return JSON.parse(text);
  } catch {
    throw new MacroscopeError(errorMessage);
  }
}

function securityHeaders(contentType) {
  return {
    'Content-Type': contentType,
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' https:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Cache-Control': 'no-store',
  };
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { ...securityHeaders('application/json; charset=utf-8'), 'Content-Length': Buffer.byteLength(payload) });
  res.end(payload);
}

async function readJsonBody(req) {
  const contentType = (req.headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase();
  if (contentType !== 'application/json') {
    throw new ClientError('Content-Type must be application/json.', 415);
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_JSON_BODY) throw new ClientError('The request body is too large.', 413);
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new ClientError('The request body must contain valid JSON.');
  }
}

function validateOrigin(req) {
  if (req.headers.host !== `${HOST}:${PORT}`) throw new ClientError('Request host is not allowed.', 403);
  const origin = req.headers.origin;
  if (origin && origin !== LOCAL_ORIGIN) throw new ClientError('Request origin is not allowed.', 403);
}

function inboundMessageFrom(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ClientError('The webhook body must be a JSON object.');
  }
  const candidate = body.response ?? body.message ?? body.content ?? body.text ?? body;
  const message = formatResult(candidate).trim();
  if (!message) throw new ClientError('The webhook body did not contain a response.');
  if (message.length > MAX_MESSAGE_LENGTH) {
    throw new ClientError(`Webhook responses are limited to ${MAX_MESSAGE_LENGTH.toLocaleString()} characters.`, 413);
  }
  return message;
}

async function handleInboundWebhook(req, res, pathToken) {
  const current = inboundTunnel;
  if (!current || !secretsMatch(pathToken, current.pathToken)) {
    return sendJson(res, 404, { error: 'Webhook endpoint not found.' });
  }
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed.' });
  const body = await readJsonBody(req);
  const message = {
    id: nextInboundMessageId++,
    response: inboundMessageFrom(body),
    receivedAt: new Date().toISOString(),
  };
  inboundMessages.push(message);
  if (inboundMessages.length > MAX_INBOUND_MESSAGES) inboundMessages = inboundMessages.slice(-MAX_INBOUND_MESSAGES);
  return sendJson(res, 202, { accepted: true, id: message.id });
}

async function handleInboundRequest(req, res) {
  try {
    const url = new URL(req.url, 'http://webhook.local');
    const match = url.pathname.match(/^\/hooks\/([A-Za-z0-9_-]+)$/);
    if (!match) return sendJson(res, 404, { error: 'Webhook endpoint not found.' });
    return await handleInboundWebhook(req, res, match[1]);
  } catch (error) {
    const status = Number.isInteger(error.status) ? error.status : 500;
    const message = status === 500 ? 'The webhook listener encountered an error.' : error.message;
    if (!res.headersSent && !res.writableEnded) sendJson(res, status, { error: message });
  }
}

async function handleApi(req, res, pathname) {
  validateOrigin(req);
  if (req.method === 'GET' && pathname === '/api/status') {
    return sendJson(res, 200, { configured: Boolean(settings) });
  }
  if (req.method === 'POST' && pathname === '/api/settings') {
    const body = await readJsonBody(req);
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new ClientError('The settings request must be a JSON object.');
    }
    const webhookUrl = validateWebhookUrl(body.webhookUrl);
    if (typeof body.apiToken !== 'string' || !body.apiToken.trim()) {
      throw new ClientError('Enter a webhook API key.');
    }
    settings = { webhookUrl, apiToken: body.apiToken };
    return sendJson(res, 200, { configured: true });
  }
  if (req.method === 'DELETE' && pathname === '/api/settings') {
    await readJsonBody(req);
    settings = null;
    return sendJson(res, 200, { configured: false });
  }
  if (req.method === 'GET' && pathname === '/api/inbound/status') {
    return sendJson(res, 200, publicInboundState());
  }
  if (req.method === 'POST' && pathname === '/api/inbound/start') {
    await readJsonBody(req);
    return sendJson(res, 200, await startInboundTunnel());
  }
  if (req.method === 'DELETE' && pathname === '/api/inbound/tunnel') {
    await readJsonBody(req);
    stopInboundTunnel();
    return sendJson(res, 200, publicInboundState());
  }
  if (req.method === 'GET' && pathname === '/api/inbound/messages') {
    const after = Number(new URL(req.url, LOCAL_ORIGIN).searchParams.get('after')) || 0;
    const messages = inboundMessages.filter((message) => message.id > after);
    return sendJson(res, 200, { messages, tunnel: publicInboundState() });
  }
  if (req.method === 'POST' && pathname === '/api/chat') {
    const body = await readJsonBody(req);
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new ClientError('The chat request must be a JSON object.');
    }
    if (typeof body.message !== 'string' || !body.message.trim()) throw new ClientError('Enter a message.');
    if (body.message.length > MAX_MESSAGE_LENGTH) {
      throw new ClientError(`Messages are limited to ${MAX_MESSAGE_LENGTH.toLocaleString()} characters.`);
    }
    const controller = new AbortController();
    const stop = () => { if (!res.writableEnded) controller.abort(); };
    req.once('aborted', stop);
    res.once('close', stop);
    const job = await triggerMacroscope(body.message, controller.signal);
    const response = await pollMacroscope(job.pollUrl, job.jobToken, controller.signal);
    if (!controller.signal.aborted && !res.writableEnded) sendJson(res, 200, { response });
    return;
  }
  sendJson(res, 404, { error: 'API endpoint not found.' });
}

const staticFiles = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
]);

async function handleRequest(req, res) {
  try {
    const url = new URL(req.url, LOCAL_ORIGIN);
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url.pathname);
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'Method not allowed.' });
    const file = staticFiles.get(url.pathname);
    if (!file) return sendJson(res, 404, { error: 'Not found.' });
    const body = await readFile(path.join(PUBLIC_DIR, file[0]));
    res.writeHead(200, { ...securityHeaders(file[1]), 'Content-Length': body.length });
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch (error) {
    if (error.name === 'AbortError') return;
    const status = Number.isInteger(error.status) ? error.status : 500;
    const message = status === 500 ? 'The local server encountered an error.' : error.message;
    if (status >= 500) console.error(`Request failed: ${error.constructor.name} (${status})`);
    if (!res.headersSent && !res.writableEnded) sendJson(res, status, { error: message });
  }
}

const inboundServer = http.createServer(handleInboundRequest);
inboundServer.listen(0, HOST);

const server = http.createServer(handleRequest);
server.listen(PORT, HOST, () => console.log(`Macroscope Chat is available at ${LOCAL_ORIGIN}`));

function shutdown() {
  settings = null;
  stopInboundTunnel();
  inboundMessages = [];
  inboundServer.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2_000).unref();
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
