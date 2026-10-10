import assert from 'node:assert/strict';
import test from 'node:test';
import { parseAmazonProductPage, parseAmazonStorePage } from '../lib/amazon-store-client.mjs';

test('Amazon inline error counters do not turn a price-hidden product into a navigation failure', () => {
  const page = `<title>Motorcycle Fork Oil Level Tool - Amazon Canada</title>
    <input id="ASIN" value="B0FQ161978">
    <span id="productTitle">Motorcycle Fork Oil Level Tool</span>
    <div id="corePrice_feature_div"></div>
    <div id="apex_desktop">To see product details, add this item to your cart.</div>
    <script>const tracker = {err_count:0}; const error = "ERR_CONNECTION_RESET";</script>
    <style>/* ERR_TIMED_OUT */</style><!-- ERR_CONNECTION_REFUSED -->`;
  const result = parseAmazonProductPage(page, { marketplace: 'CA', asin: 'B0FQ161978' });
  assert.equal(result.navigationError, false);
  assert.equal(result.explicitProduct, true);
  assert.equal(result.currentPrice, null);
});

test('inline browser error constants do not break a valid store result', () => {
  const page = `<div id="search"><div data-component-type="s-search-result" data-asin="B0FQ161978"><span class="social-proofing-faceout-title-text">50+ bought in past month</span></div></div>
    <script>var err_count=0;var code="ERR_CONNECTION_RESET";</script>`;
  const result = parseAmazonStorePage(page);
  assert.equal(result.navigationError, false);
  assert.deepEqual(result.asins, ['B0FQ161978']);
});

test('actual browser network errors remain navigation failures', () => {
  for (const html of [
    '<div id="main-frame-error">This site cannot be reached</div>',
    '<div class="error-code">ERR_CONNECTION_RESET</div>',
    '<body class="neterror">Connection failed</body>',
    '<body>net::ERR_NAME_NOT_RESOLVED</body>',
  ]) {
    assert.equal(parseAmazonProductPage(html).navigationError, true);
    assert.equal(parseAmazonStorePage(html).navigationError, true);
  }
});
