import test from 'node:test';
import assert from 'node:assert/strict';
import { amazonMonthlySalesValue, hasQualifyingAmazonMonthlySales, parseAmazonMonthlySales } from '../lib/amazon-sales-policy.mjs';

const asin = 'B012345678';
const product = (value = 50, rawText = `${value}+ bought in past month`, extra = {}) => ({ asin, sales30: value,
  sales30Evidence: { source: 'amazon_product_page', period: 'past_month', kind: 'lower_bound', value, rawText, asin, ...extra } });

test('explicit Amazon monthly purchase badges qualify from 50 upward including abbreviated counts', () => {
  for (const [value, raw] of [[50, '50+ bought in past month'], [100, '100+ bought in past month'],
    [200, '200+ purchased in the past month'], [1000, '1K+ bought in past month'],
    [1500, '1.5K+ bought in past month'], [2000, '2,000+ bought in past month'],
    [10000, '过去一个月购买 1万+'], [50, '５０＋ bought in past month']]) {
    assert.equal(amazonMonthlySalesValue(product(value, raw)), value, raw);
    assert.equal(hasQualifyingAmazonMonthlySales(product(value, raw)), true, raw);
  }
  assert.equal(hasQualifyingAmazonMonthlySales(product(49)), false);
  assert.equal(amazonMonthlySalesValue(product(0)), 0);
  assert.equal(hasQualifyingAmazonMonthlySales(product(50, '50 bought in past month', { source: 'amazon_store_card', kind: 'displayed_count' })), true);
});

test('numeric monthly sales alone and manual or unrelated evidence do not qualify', () => {
  for (const candidate of [null, {}, { sales30: 200 }, { sales30: 200, sales30Evidence: null },
    product(100, '100+ bought in past month', { source: 'manual' }),
    product(100, '100+ bought in past month', { source: 'sellersprite' }),
    product(100, '100+ bought in past month', { period: 'last_year' }),
    product(100, '100+ bought in past month', { kind: 'estimate' }),
    product(100, '100+ bought in past month', { rawText: '' }),
    product(100, '100+ bought in past month', { value: '100' }),
    product(100, '100+ bought in past month', { value: Infinity }),
    product(100, '100+ bought in past month', { value: 100.1 }),
    product(100, '100+ bought in past month', { value: -100 }),
    product(200, '100+ bought in past month'), product(100, '100 reviews'),
    product(100, '100+ bought last week'), product(100, '100+ bought in past 3 months'),
  ]) {
    assert.equal(amazonMonthlySalesValue(candidate), null);
    assert.equal(hasQualifyingAmazonMonthlySales(candidate), false);
  }
});

test('monthly evidence must belong to the source ASIN rather than another product or variation', () => {
  assert.equal(hasQualifyingAmazonMonthlySales(product(100, undefined, { asin: 'B098765432' })), false);
  assert.equal(hasQualifyingAmazonMonthlySales(product(100, undefined, { asin: '' })), false);
  assert.equal(hasQualifyingAmazonMonthlySales({ ...product(), sourceAsin: 'B098765432' }), false);
  assert.equal(hasQualifyingAmazonMonthlySales({ ...product(), asin: 'B098765432', sourceAsin: asin }), true);
  assert.equal(hasQualifyingAmazonMonthlySales({ ...product(), asin: asin.toLowerCase() }), true);
  assert.equal(hasQualifyingAmazonMonthlySales({ ...product(), asin: undefined, id: 'isolated-fixture' }), false);
  assert.equal(hasQualifyingAmazonMonthlySales({ ...product(), asin: '', id: asin }), false);
  assert.equal(hasQualifyingAmazonMonthlySales({ ...product(), asin: 'invalid' }), false);
  assert.equal(hasQualifyingAmazonMonthlySales({ ...product(), sourceAsin: 'invalid' }), false);
});

test('badge parsing rejects unrelated quantities, periods, unsafe integers and malformed counts', () => {
  for (const text of ['50+', '50 ratings in past month', '100+ bought last year', 'bought in past month',
    '999999999999999999999+ bought in past month', '0.5 bought in past month']) assert.equal(parseAmazonMonthlySales(text), null, text);
});


test('localized one-month purchase badges preserve real quantity and separators', () => {
  for (const [raw, expected] of [
    ['50+ gekocht in de afgelopen maand', 50],
    ['100+ Mal im letzten Monat gekauft', 100],
    ['1.000+ Mal im letzten Monat gekauft', 1000],
    ['1,5 Tsd.+ Mal im letzten Monat gekauft', 1500],
    ['Plus de 50 achetés au cours du mois dernier', 50],
    ['Plus de 1 000 achetés au cours du mois dernier', 1000],
    ['100+ acquistati nel mese scorso', 100],
    ['100+ comprados el mes pasado', 100],
    ['Mais de 1 mil compras no mês passado', 1000],
    ['Kupiono ponad 50 razy w zeszłym miesiącu', 50],
    ['过去一个月购买了100件以上', 100],
    ['過去1か月で100点以上購入されました', 100],
    ['50\u200b+ bought in past month', 50],
  ]) assert.equal(parseAmazonMonthlySales(raw), expected, raw);
});

test('purchase badges require a single complete count and one-month statement', () => {
  for (const raw of [
    '1,00+ bought in past month', '1.23+ bought in past month', '1,00,000+ bought in past month',
    '100+ Mal in den letzten 3 Monaten gekauft', '100+ comprados el año pasado',
    '100 achetés au cours des 3 derniers mois', '50+ bought in past month and 200+ bought in past year',
    '50 reviews, 100+ bought in past month', '50+ bought in past month for another product',
  ]) assert.equal(parseAmazonMonthlySales(raw), null, raw);
});
