import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAmazonStorePage } from '../lib/amazon-store-client.mjs';

const asin = 'B0A0000001';
const card = content => `<div id="search"><div data-component-type="s-search-result" data-asin="${asin}">${content}</div></div>`;
const sales = content => parseAmazonStorePage(card(content)).salesByAsin[asin] || null;

test('store purchase evidence accepts accessible badge text and localized quantity', () => {
  assert.deepEqual(sales('<span aria-label="50+ bought in past month">50+</span>'), { sales30: 50, rawText: '50+ bought in past month' });
  assert.deepEqual(sales('<div id="socialProofingAsinFaceout_feature_div">Plus de 100 achetés au cours du mois dernier</div>'), {
    sales30: 100, rawText: 'Plus de 100 achetés au cours du mois dernier',
  });
});

test('hidden and nested related-product badges do not supply store-card sales', () => {
  for (const wrapper of ['hidden', 'style="display:none"', 'class="aok-hidden"', 'data-asin="B0A0000002"', 'class="a-carousel"']) {
    assert.equal(sales(`<div ${wrapper}><span class="social-proofing-faceout-title-text">100+ bought in past month</span></div>`), null, wrapper);
  }
});

test('conflicting or mixed statement badges do not pick arbitrary store-card sales', () => {
  assert.equal(sales('<span>50+ bought in past month</span><span>100+ bought in past month</span>'), null);
  assert.equal(sales('<span>100+ bought in past month for another product</span>'), null);
  assert.equal(sales('<span>100+ bought in past 3 months</span>'), null);
});

test('visible duplicate badges retain one stable lower-bound reading', () => {
  assert.deepEqual(sales('<span>50+ bought in past month</span><span>50+ bought in past month</span>'), { sales30: 50, rawText: '50+ bought in past month' });
});
