import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { EdgeCdpSession } from '../lib/amazon-edge-cdp.mjs';

const url = 'https://www.amazon.ca/dp/B0FWRPKFQD';
async function inspect(html, title = 'Amazon product') {
  const session = new EdgeCdpSession({ edgeExecutable: 'mock' });
  session.command = async (_method, params) => ({result: {value: vm.runInNewContext(params.expression, {
    document: { readyState: 'complete', title, documentElement: {outerHTML: html}, querySelector: () => null },
    location: { href: url },
  })}});
  return session.inspectPage();
}

test('CDP does not treat a normal product with a security helper as a CAPTCHA', async () => {
  const state = await inspect('<h1 id="productTitle">Welding rods</h1><script>window.gokuProps={};</script>');
  assert.equal(state.challenge, false);
});

test('CDP still recognizes an actual robot check page', async () => {
  const state = await inspect('<title>Robot Check</title><form action="/errors/validatecaptcha"><input id="captchacharacters"></form>', 'Robot Check');
  assert.equal(state.challenge, true);
});

for (const challenge of [false, true]) test(`navigation deadline distinguishes loading from verification: challenge=${challenge}`, async t => {
  t.mock.timers.enable({apis: ['Date', 'setTimeout'], now: 100_000});
  const session = new EdgeCdpSession({ edgeExecutable: 'mock' });
  session.command = async () => ({});
  session.waitForEvent = async () => null;
  session.inspectPage = async () => ({url, readyState:'loading', byteLength:100, challenge});
  let settled = false;
  const result = session.navigateUntilSettled(url).then(() => {settled=true;return null;}, error => {settled=true;return error;});
  for (let i=0;i<200 && !settled;i++) {
    for(let j=0;j<8;j++) await Promise.resolve();
    t.mock.timers.tick(500);
  }
  const error = await result;
  assert.equal(error?.code, challenge ? 'EDGE_CDP_CHALLENGE_TIMEOUT' : 'EDGE_CDP_NAVIGATION_TIMEOUT');
});
