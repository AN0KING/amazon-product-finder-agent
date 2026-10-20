import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyPageState, detectPageState, recoverHintForPageState } from '../dist/session/page-state.js';

// Minimal replay of the 2026-10-15 Edge failure artifact. The saved browser
// error page had this internal URL, title and error code; no account data is
// needed to reproduce its former "unknown/upload unsupported" classification.
const failedLogin = {
  url: 'chrome-error://chromewebdata/',
  title: 'login.taobao.com',
  text: '嗯...无法访问此页面\n似乎 login.taobao.com 关闭了连接。\nERR_CONNECTION_CLOSED',
};

test('Edge connection failure is a network error, not an unsupported page or expired account', () => {
  const state = classifyPageState(failedLogin);
  assert.equal(state.kind, 'network_error');
  assert.equal(state.errorCode, 'ERR_CONNECTION_CLOSED');
  assert.match(recoverHintForPageState(state.kind), /network|connection/i);
});

test('the live page probe preserves the browser network error code', async () => {
  const state = await detectPageState({
    url: () => failedLogin.url,
    title: async () => failedLogin.title,
    evaluate: async () => failedLogin.text,
  });
  assert.equal(state.kind, 'network_error');
  assert.equal(state.errorCode, 'ERR_CONNECTION_CLOSED');
});

test('browser errors without readable text remain load failures', () => {
  const state = classifyPageState({ url: 'edge-error://edgewebdata/', title: null, text: '' });
  assert.equal(state.kind, 'network_error');
  assert.equal(state.errorCode, null);
});

test('normal pages cannot become network errors by mentioning an error code', () => {
  assert.equal(classifyPageState({ ...failedLogin, url: 'https://s.1688.com/youyuan/index.htm' }).kind, 'normal_1688_page');
  assert.equal(classifyPageState({ ...failedLogin, url: 'https://login.taobao.com/jump?group=tao' }).kind, 'not_logged_in');
  assert.equal(classifyPageState({ ...failedLogin, url: 'https://example.test/chrome-error://chromewebdata/' }).kind, 'unknown');
});
