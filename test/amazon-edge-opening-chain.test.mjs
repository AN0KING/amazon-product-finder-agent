import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import vm from 'node:vm';
import { openAmazonInEdge } from '../lib/amazon-edge-opener.mjs';

const [appSource, serverSource] = await Promise.all([
  readFile(new URL('../app.js', import.meta.url), 'utf8'),
  readFile(new URL('../server.mjs', import.meta.url), 'utf8'),
]);
const productUrl = 'https://www.amazon.com.au/dp/B09NXS1BLL?th=1#productDetails';

function sourceFunction(source, name, indent = '') {
  const start = source.search(new RegExp(`^${indent}(?:async )?function ${name}\\(`, 'm'));
  assert.notEqual(start, -1, `Missing production function ${name}`);
  const end = source.indexOf(`\n${indent}}`, start);
  assert.notEqual(end, -1);
  return source.slice(start, end + indent.length + 2);
}

async function clickHarness(t, { oldBackend = false, edgeInstalled = true } = {}) {
  const launches = [], requests = [], responses = [], toasts = [];
  const listener = createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${listener.address().port}`;
  assert.ok(![4173, 16880].includes(listener.address().port));
  t.after(async () => {
    listener.closeAllConnections();
    await new Promise(resolve => listener.close(resolve));
  });
  class HttpError extends Error {
    constructor(status, code, message) { super(message); Object.assign(this, { status, code }); }
  }
  let routeSource = sourceFunction(serverSource, 'routeRequest');
  if (oldBackend) {
    // Replay the loaded pre-0.9.57 route table: static assets are already newer
    // on disk, but the running process has no Edge route until it restarts.
    const start = routeSource.indexOf('  if (url.pathname === "/api/amazon/open-in-edge")');
    const end = routeSource.indexOf('  if (url.pathname === "/api/events")', start);
    assert.ok(start > 0 && end > start);
    routeSource = routeSource.slice(0, start) + routeSource.slice(end);
  }
  const serverContext = vm.createContext({
    URL, Buffer, HttpError, ORIGIN: origin, EXPECTED_HOST: new URL(origin).host,
    archivingRunId: null, STATIC_FILES: new Map(), JSON_BODY_LIMIT: 16_384,
    openAmazonInEdge: url => openAmazonInEdge(url, {
      platform: 'win32', environment: {}, statImpl: async () => ({ isFile: () => edgeInstalled }),
      spawnImpl(executable, args, options) {
        launches.push({ executable, args, options });
        const child = new EventEmitter();
        child.unref = () => {};
        queueMicrotask(() => child.emit('spawn'));
        return child;
      },
    }),
  });
  const route = vm.runInContext([
    routeSource,
    ...['enforceLocalRequest', 'isRuntimeVerifyRequest', 'readJsonBody', 'readBody', 'requireMethod',
      'requireContentType', 'isPlainObject', 'sendJson', 'securityHeaders'].map(name => sourceFunction(serverSource, name)),
    `async (request, response) => {
      try {
        enforceLocalRequest(request);
        await routeRequest(request, response, new URL(request.url, ORIGIN));
      } catch (error) {
        sendJson(response, error.status || 500, { ok: false, error: { code: error.code, message: error.message } });
      }
    }`,
  ].join('\n'), serverContext);
  listener.on('request', route);
  const clientContext = vm.createContext({
    AbortController,
    window: { setTimeout, clearTimeout },
    updateSellerSpriteCallCount: () => {},
    showToast: (...args) => toasts.push(args),
    fetch: async (pathname, options) => {
      assert.equal(pathname, '/api/amazon/open-in-edge');
      requests.push({ pathname, ...options });
      const response = await fetch(new URL(pathname, origin), {
        ...options, headers: { ...options.headers, Origin: origin, 'Sec-Fetch-Site': 'same-origin' },
      });
      responses.push({ status: response.status, payload: await response.clone().json() });
      return response;
    },
  });
  const click = vm.runInContext([
    sourceFunction(appSource, 'apiRequest', '  '),
    sourceFunction(appSource, 'openAmazonLinkInEdge', '  '),
    'openAmazonLinkInEdge',
  ].join('\n'), clientContext);
  const link = { dataset: {}, getAttribute: name => name === 'data-amazon-url' ? productUrl : null };
  return { click: () => click(link), launches, requests, responses, toasts, link };
}

test('candidate click reaches the real HTTP route and opens the exact URL only in Edge', async t => {
  const harness = await clickHarness(t);
  await harness.click();
  assert.equal(harness.requests.length, 1);
  assert.equal(harness.requests[0].method, 'POST');
  assert.deepEqual(JSON.parse(harness.requests[0].body), { url: productUrl });
  assert.equal(harness.responses[0].status, 200);
  assert.equal(harness.launches.length, 1);
  assert.match(harness.launches[0].executable, /Microsoft\\Edge\\Application\\msedge\.exe$/);
  assert.deepEqual(harness.launches[0].args, [productUrl]);
  assert.equal(harness.launches[0].options.shell, false);
  assert.equal(harness.toasts.length, 0);
  assert.equal(harness.link.dataset.openingEdge, undefined);
});

test('a newer UI with a still-running old server identifies the missing local route as a service update problem', async t => {
  const harness = await clickHarness(t, { oldBackend: true });
  await harness.click();
  assert.equal(harness.responses[0].status, 404);
  assert.deepEqual(harness.responses[0].payload.error, {
    code: 'NOT_FOUND', message: 'The requested local endpoint does not exist.',
  });
  assert.equal(harness.launches.length, 0);
  assert.match(harness.toasts[0][0], /本地服务.*(?:尚未|未).*加载.*Edge.*接口/);
  assert.match(harness.toasts[0][0], /页面版本不一致/);
  assert.match(harness.toasts[0][0], /启动器.*安全重启服务.*刷新/);
  assert.doesNotMatch(harness.toasts[0][0], /The requested local endpoint does not exist/);
  assert.equal(harness.link.dataset.openingEdge, undefined);
});

test('an actual Edge installation failure remains distinct from a missing local API', async t => {
  const harness = await clickHarness(t, { edgeInstalled: false });
  await harness.click();
  assert.equal(harness.responses[0].payload.error.code, 'EDGE_NOT_INSTALLED');
  assert.match(harness.toasts[0][0], /未找到 Microsoft Edge/);
  assert.doesNotMatch(harness.toasts[0][0], /本地服务.*未.*加载/);
  assert.equal(harness.launches.length, 0);
});
