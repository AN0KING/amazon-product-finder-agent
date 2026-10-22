import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../1688-dependencies/1688-image-finder/dist/commands/login.js', import.meta.url), 'utf8');
const completion = source.slice(source.indexOf('async function completeLoginInContext('), source.indexOf('async function readBrokerManagedImageSearchUpload('));

for (const freshLogin of [false, true]) {
  test(`${freshLogin ? 'fresh QR' : 'ordinary'} login ${freshLogin ? 'requires a new scan' : 'keeps the current identity'}`, async () => {
    const events = [];
    let cookies = [{ name: 'session', value: 'old-account' }];
    let identity = { memberId: 'old-account' };
    const page = { isClosed: () => false, bringToFront: async () => {}, goto: async url => events.push(url) };
    const ctx = {
      pages: () => [page], cookies: async () => cookies,
      clearCookies: async () => { events.push('clear'); cookies = []; identity = null; },
    };
    const complete = vm.runInNewContext(`${completion}; completeLoginInContext`, {
      LOGIN_URL: 'login-page', LOGIN_WARMUP_URL: 'home-page', info() {}, printInteractive() {},
      verifiedIdentityFromContext: async () => { events.push('reuse'); return identity; },
      waitForLogin: async (_ctx, _page, _timeout, _headed, initialCookies) => {
        assert.deepEqual(initialCookies, []);
        events.push('scan'); identity = { memberId: 'new-account' };
      },
      persistOfficialSessionCookies: async () => identity,
      requireOnlineIdentity: async (_ctx, value) => { assert.equal(value.memberId, 'new-account'); events.push('verify'); },
      assertSameIdentity: (a, b) => assert.equal(a.memberId, b.memberId),
    });
    const result = await complete(ctx, { freshLogin, headed: true, openBrowser: true, reuseExistingPage: true, brokerMode: true, purpose: 'login' });
    assert.equal(result.memberId, freshLogin ? 'new-account' : 'old-account');
    assert.equal(events.includes('clear'), freshLogin);
    assert.equal(events.includes('scan'), freshLogin);
    assert.equal(events.includes('reuse'), !freshLogin);
    if (freshLogin) assert.deepEqual(events.slice(0, 3), ['clear', 'login-page', 'scan']);
  });
}

test('image verification never clears the bound account', async () => {
  let cleared = false;
  const identity = { memberId: 'bound-account' };
  const page = { isClosed: () => false };
  const complete = vm.runInNewContext(`${completion}; completeLoginInContext`, {
    waitForImageSearchVerification: async () => identity,
    persistOfficialSessionCookies: async () => identity,
    assertSameIdentity: (a, b) => assert.equal(a.memberId, b.memberId), printInteractive() {}, attachQrRenderer() {},
  });
  await complete({ pages: () => [page], clearCookies: async () => { cleared = true; } },
    { freshLogin: true, reuseExistingPage: true, purpose: 'image_search' });
  assert.equal(cleared, false);
});
