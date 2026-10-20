import assert from 'node:assert/strict';
import test from 'node:test';
import { parseAmazonProductPage, parseAmazonStorePage } from '../lib/amazon-store-client.mjs';
const product = '<input id="ASIN" value="B000000001"><h1 id="productTitle">Sample tool</h1>';
const store = '<div id="search"><div data-component-type="s-search-result" data-asin="B000000001"><span>Sample tool</span></div></div>';
const parsers = [parseAmazonStorePage, parseAmazonProductPage];
const helpers = '<script src="https://example.awswaf.com/helper.js"></script><script>window.gokuProps={};const prompt="robot check";const message="request rate limited";const url="/errors/validatecaptcha";</script>';
for (const body of [product, store]) {
  test(`normal ${body === product ? 'product' : 'store'} content with security helper scripts is not an active challenge or throttle`, () => {
    for (const parse of parsers) {
      const result = parse('<title>Amazon</title>' + body + helpers);
      assert.equal(result.challenge, false);
      assert.equal(result.rateLimited, false);
    }
  });
}
test('hidden templates and support links do not pause valid product content', () => {
  for (const parse of parsers) {
    const result = parse(product + '<template><form action="/errors/validatecaptcha">robot check</form></template><div hidden><input id="captchacharacters"></div><div style="display:none"><div id="challenge-container"></div></div><a href="/errors/validatecaptcha">help</a>');
    assert.equal(result.challenge, false);
  }
});
test('real CAPTCHA form remains a challenge even with product content behind it', () => {
  for (const parse of parsers) {
    const result = parse(product + '<form action="/errors/validatecaptcha"><input name="captchacharacters"></form>');
    assert.equal(result.challenge, true);
  }
});
test('visible challenge and WAF interstitials remain blocked', () => {
  for (const html of ['<title>Robot Check</title>', '<body>Enter the characters you see below</body>', '<div id="challenge-container"></div>', '<script>window.gokuProps={};</script>', '<body>Verify that you’re not a robot</body>']) {
    for (const parse of parsers) assert.equal(parse(html).challenge, true, html);
  }
});
test('visible rate limit pages are distinct from CAPTCHA and script constants', () => {
  for (const parse of parsers) {
    const result = parse('<title>429 Too Many Requests</title><body>Request rate limited</body>');
    assert.equal(result.rateLimited, true);
    assert.equal(result.challenge, false);
    assert.equal(parse('<body>Page unavailable</body><script>const message="request rate limited";</script>').rateLimited, false);
  }
});
test('a blank title by itself does not prove that access validation is required', () => {
  for (const parse of parsers) assert.equal(parse('<title>&nbsp;</title>' + product).challenge, false);
});

test('a search container with only challenge text is not successful commerce content', () => {
  for (const parse of parsers) assert.equal(parse('<div id="search">Enter the characters you see below</div>').challenge, true);
});
test('an explicit empty store with security helper scripts is not a verification pause', () => {
  for (const parse of parsers) assert.equal(parse('<div id="search">No results</div>' + helpers).challenge, false);
});

test('Amazon robot text without that still requires explicit verification', () => {
  for (const text of ["Sorry, we just need to make sure you're not a robot.", "Verify you're not a robot", "Verify you’re not a robot"]) {
    for (const parse of parsers) assert.equal(parse(`<body>${text}</body>`).challenge, true);
  }
});
