import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAmazonProductPage } from '../lib/amazon-store-client.mjs';

const asin = 'B07W7QVNVT';
const row = (label, value) => `<tr><th>${label}</th><td>${value}</td></tr>`;
// Reduced from the observed Voyager side sheet. Values are synthetic regression
// data; this fixture is not evidence of the current live product's measurements.
const section = (heading, rows) => `<div class="voyager-side-sheet-attribute-section"><h1 class="voyager-ns-desktop-subsection-name">${heading}</h1><div class="a-section"><table class="a-keyvalue prodDetTable" role="presentation">${rows}</table></div></div>`;
const sheet = (content, attributes = '') => `<div id="voyager-ns-desktop-side-sheet-container" role="dialog" ${attributes}><div id="voyager-ns-desktop-side-sheet-main-section"><h1>Product specifications</h1><div class="voyager-ns-desktop-attribute-sections">${content}</div></div></div>`;
const parse = body => parseAmazonProductPage(`<input id="ASIN" value="${asin}"><h1 id="productTitle">Synthetic specifications</h1>${body}`, { asin, marketplace: 'AU' });

test('visible full specifications supply Item Weight and Date First Available with source headings', () => {
  const result = parse(sheet(section('Item details', row('Date First Available', '21 December 2021'))
    + section('Measurements', row('Item Weight', '70 g') + row('Load Capacity', '30 kg'))));
  assert.equal(result.productWeightKg, .07);
  assert.equal(result.productWeightEvidence.rawText, '70 g');
  assert.equal(result.amazonFirstAvailableDate, '2021-12-21');
  assert.equal(result.productInformation.rowCount, 3);
  assert.equal(result.productInformation.status, 'complete');
  assert.deepEqual(result.productInformation.sections.map(s => s.heading), ['Item details', 'Measurements']);
  assert.match(result.productWeightEvidence.selector, /voyager-ns-desktop-side-sheet-main-section/);
});

test('full specification Measurements preserve priority over old bullet unit readings', () => {
  const result = parse('<div id="detailBullets_feature_div"><ul><li><b>Item Weight:</b> 0.15 Pounds</li></ul></div>'
    + sheet(section('Measurements', row('Item Weight', '70 g'))));
  assert.equal(result.productWeightKg, .07);
  assert.equal(result.productWeightEvidence.rawText, '70 g');
  assert.equal(result.productInformation.weightSelection.alternatives[0].rawText, '0.15 Pounds');
});

test('closed, hidden, template and recommendation side sheets cannot supply measurements or dates', () => {
  const content = section('Measurements', row('Item Weight', '999 g') + row('Date First Available', '1 January 2000'));
  for (const attributes of ['class="aok-hidden"', 'hidden', 'aria-hidden="true"', 'style="display:none"']) {
    const result = parse(sheet(content, attributes));
    assert.equal(result.productWeightKg, null, attributes);
    assert.equal(result.amazonFirstAvailableDate, null, attributes);
  }
  for (const wrapper of ['<template>', '<div id="recommendations">', '<div data-hook="review">']) {
    const result = parse(wrapper + sheet(content) + (wrapper === '<template>' ? '</template>' : '</div>'));
    assert.equal(result.productWeightKg, null, wrapper);
    assert.equal(result.amazonFirstAvailableDate, null, wrapper);
  }
});

test('full specifications do not substitute capacity, package weight or dimensions for Item Weight', () => {
  const result = parse(sheet(section('Measurements', row('Package Weight', '70 g') + row('Load Capacity', '30 kg')
    + row('Product Dimensions', '10 x 5 x 3 cm; 70 g'))));
  assert.equal(result.productWeightKg, null);
  assert.equal(result.productInformation.rowCount, 3);
  assert.equal(result.productInformation.weightStatus, 'unresolved');
  assert.equal(result.amazonFirstAvailableDateStatus, 'unresolved');
});
