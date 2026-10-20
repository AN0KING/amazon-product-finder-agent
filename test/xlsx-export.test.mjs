import assert from 'node:assert/strict';
import test from 'node:test';
import { unzipSync, strFromU8 } from 'fflate';
import { load } from 'cheerio';
import sharp from 'sharp';
import { createEmbeddedImageWorkbook } from '../lib/xlsx-export.mjs';

// Header/format fixture only: no source workbook product rows are retained.
const headers = ['商品 ID', '竞品图片', '源 ASIN', '商品名称', '生效采购件数',
  '竞品当前售价 (CAD)', '竞品当前售价 (CNY)', '我们的售价 (CAD)', '我们的售价 (CNY)',
  '评分', '评价数', '竞品 30 天销量', '商品重量 (kg)', '商品上架时间', '整套采购成本 (CNY)',
  '采购税率 (%)', '采购税费 (CNY)', '落地采购成本 (CNY)', '履约方式', 'FBA 配送费 (CAD)',
  'FBA 配送费 (CNY)', '空运单价 (CNY/kg)', '单件空运头程 (CNY)', 'Amazon 佣金率 (%)',
  '汇损率 (%)', '营销费率 (%)', '管理费率 (%)', '退货预留率 (%)', '预估总成本 (CAD)',
  '预估总成本 (CNY)', '预估单件利润 (CAD)', '预估单件利润 (CNY)', '预估经营利润率 (%)', '数据采集时间'];
const widths = [15, 16, 12, 56, 14, 20, 20, 18, 18, 10, 10, 16, 15, 16, 20, 14, 16, 20, 10, 18, 18, 19, 20, 19, 12, 14, 14, 16, 18, 18, 20, 20, 20, 26];
const columnFormats = headers.map(header => header === '商品上架时间' ? 'yyyy-mm-dd' : 'General');
const base = overrides => ({ worksheetName: '已初审产品', headers, rows: [Array(headers.length).fill(null)], images: [null],
  imageColumnIndex: 1, layout: 'reviewed-products-v1', columnFormats, fetchImpl: async () => { throw new Error('Unexpected image request'); }, ...overrides });
const contents = buffer => {
  const files = unzipSync(buffer);
  return { files, sheet: load(strFromU8(files['xl/worksheets/sheet1.xml']), { xmlMode: true }),
    styles: load(strFromU8(files['xl/styles.xml']), { xmlMode: true }) };
};

test('reviewed-product layout keeps template widths, fonts, borders, rows, frozen header and full filter after inserting date', async () => {
  const row = Array(headers.length).fill(null);
  row[0] = 'CA:SYNTHETIC1'; row[3] = 'A long sample product name '.repeat(30); row[33] = '2026-10-13T00:00:00.000Z';
  const { buffer } = await createEmbeddedImageWorkbook(base({ rows: [row] }));
  const { sheet, styles } = contents(buffer);
  assert.deepEqual(sheet('cols col').toArray().map(node => Number(sheet(node).attr('width'))), widths);
  assert.equal(sheet('dimension').attr('ref'), 'A1:AH2');
  assert.equal(sheet('autoFilter').attr('ref'), 'A1:AH2');
  assert.equal(sheet('pane').attr('topLeftCell'), 'A2');
  assert.equal(sheet('pane').attr('ySplit'), '1');
  assert.equal(sheet('sheetView').attr('showGridLines'), '0');
  assert.equal(sheet('sheetFormatPr').attr('defaultRowHeight'), '12.75');
  assert.equal(sheet('row[r="1"]').attr('ht'), '24');
  assert.equal(sheet('row[r="2"]').attr('ht'), '80');
  assert.deepEqual(sheet('row[r="1"] c').toArray().map(node => sheet(node).text()), headers);
  assert.equal(styles('fonts font').first().find('name').attr('val'), 'Arial');
  assert.equal(styles('fonts font').first().find('sz').attr('val'), '10');
  const headingFont = styles('fonts font').eq(1);
  assert.equal(headingFont.find('b').length, 1);
  assert.equal(headingFont.find('color').attr('rgb'), 'FFFFFFFF');
  assert.equal(styles('fills fill').eq(2).find('fgColor').attr('rgb'), 'FF17324D');
  assert.equal(styles('borders border').eq(1).find('bottom').attr('style'), 'thin');
  assert.equal(styles('borders border').eq(1).find('bottom color').attr('rgb'), 'FFD9E2E7');
  assert.equal(styles('cellXfs xf').eq(2).find('alignment').attr('wrapText'), '1');
  assert.equal(styles('cellXfs xf').eq(2).find('alignment').attr('vertical'), 'center');
});

test('dates and financial values remain numeric while percentages keep template General units and missing values stay blank', async () => {
  const row = Array(headers.length).fill(null);
  row[0] = 'CA:0000000001'; row[5] = 0; row[12] = 0.02; row[13] = 45943;
  row[15] = 4; row[24] = 1.5; row[32] = -2.25;
  const { buffer } = await createEmbeddedImageWorkbook(base({ rows: [row, Array(headers.length).fill(null)], images: [null, null] }));
  const { sheet, styles } = contents(buffer);
  assert.equal(sheet('c[r="A2"]').attr('t'), 'inlineStr');
  assert.equal(sheet('c[r="A2"] t').text(), 'CA:0000000001');
  for (const [ref, number] of [['F2', 0], ['M2', 0.02], ['N2', 45943], ['P2', 4], ['Y2', 1.5], ['AG2', -2.25]]) {
    assert.equal(sheet(`c[r="${ref}"]`).attr('t'), undefined);
    assert.equal(Number(sheet(`c[r="${ref}"] v`).text()), number);
  }
  assert.equal(styles('numFmt[numFmtId="164"]').attr('formatCode'), 'yyyy-mm-dd');
  assert.equal(sheet('c[r="N2"]').attr('s'), '5');
  assert.equal(styles('cellXfs xf').eq(5).attr('numFmtId'), '164');
  assert.equal(styles('cellXfs xf').eq(Number(sheet('c[r="P2"]').attr('s'))).attr('numFmtId'), '0');
  assert.equal(sheet('c[r="N3"] v').length, 0);
  assert.equal(sheet('c[r="N3"]').attr('s'), '5');
});

test('sparse cells and image entries retain row alignment and formula-looking source strings remain literal', async () => {
  const row = new Array(headers.length);
  row[0] = '=HYPERLINK("https://example.com","sample")';
  row[3] = '<f>1+1</f> & product'; row[13] = null;
  const { buffer, imageAudit } = await createEmbeddedImageWorkbook(base({ rows: [row], images: new Array(1) }));
  const { sheet } = contents(buffer);
  assert.equal(sheet('row[r="2"] c').length, headers.length);
  assert.equal(sheet('f').length, 0);
  assert.equal(sheet('c[r="A2"]').attr('t'), 'inlineStr');
  assert.equal(sheet('c[r="A2"] t').text(), row[0]);
  assert.equal(sheet('c[r="D2"] t').text(), row[3]);
  assert.equal(sheet('c[r="N2"] v').length, 0);
  assert.equal(imageAudit.missing, 1);
  assert.equal(imageAudit.requested, 0);
  assert.equal(row[1], undefined, 'The caller row must not be mutated.');
});

test('approved image downloads stay deduplicated with embedded B-column anchors and safe literal hyperlinks', async () => {
  const picture = await sharp({ create: { width: 16, height: 16, channels: 3, background: '#6699cc' } }).png().toBuffer();
  const imageUrl = 'https://m.media-amazon.com/images/I/synthetic.jpg';
  const row = Array(headers.length).fill(null); row[3] = 'https://www.amazon.ca/dp/B000000001';
  let calls = 0;
  const { buffer, imageAudit } = await createEmbeddedImageWorkbook(base({ rows: [row, row], images: [imageUrl, imageUrl],
    lookupHost: async () => [{ address: '8.8.8.8' }], fetchImpl: async (_url, options) => {
      calls += 1; assert.equal(options.redirect, 'manual'); return new Response(picture, { headers: { 'content-type': 'image/png' } });
    } }));
  const { sheet, files } = contents(buffer);
  assert.equal(calls, 1); assert.equal(imageAudit.embedded, 2); assert.equal(imageAudit.uniqueRequested, 1);
  assert.equal(sheet('hyperlink').length, 2);
  assert.equal(sheet('hyperlink').first().attr('ref'), 'D2');
  const drawing = load(strFromU8(files['xl/drawings/drawing1.xml']), { xmlMode: true });
  assert.equal(drawing('xdr\\:oneCellAnchor').length, 2);
  assert.deepEqual(drawing('xdr\\:col').toArray().map(node => drawing(node).text()), ['1', '1']);
  assert.deepEqual(drawing('xdr\\:row').toArray().map(node => drawing(node).text()), ['1', '2']);
  assert.equal(drawing('xdr\\:ext').first().attr('cx'), String(96 * 9525));
  assert.equal(drawing('xdr\\:ext').first().attr('cy'), String(96 * 9525));
  assert.equal(Object.keys(files).filter(name => name.startsWith('xl/media/')).length, 1);
});

test('unapproved or private-host images fail per row without fetching and unsafe hyperlinks do not become relationships', async () => {
  const row = Array(headers.length).fill(null); row[3] = 'javascript:alert(1)'; row[33] = 'https://user:secret@example.com/';
  let calls = 0;
  const { buffer, imageAudit } = await createEmbeddedImageWorkbook(base({ rows: [row, row],
    images: ['http://127.0.0.1/private.jpg', 'https://m.media-amazon.com/images/I/private.jpg'],
    lookupHost: async () => [{ address: '127.0.0.1' }], fetchImpl: async () => { calls += 1; throw new Error('Must not fetch'); } }));
  const { sheet, files } = contents(buffer);
  assert.equal(calls, 0); assert.equal(imageAudit.failed, 2);
  assert.equal(sheet('hyperlink').length, 0);
  assert.equal(files['xl/drawings/drawing1.xml'], undefined);
});

test('layout options are validated before downloads and default exports remain available', async () => {
  for (const override of [
    { layout: 'unsupported' }, { columnFormats: ['General'] }, { columnFormats: headers.map(() => '0%') },
    { columnFormats: headers.map((_, index) => index === 1 ? 'yyyy-mm-dd' : 'General') },
    { headers: new Array(headers.length) }, { rows: new Array(1) },
  ]) await assert.rejects(createEmbeddedImageWorkbook(base(override)), error => error.status === 400);
  const small = { worksheetName: 'Other', headers: ['竞品图片', 'toString'], rows: [[null, 'a']], images: [null], imageColumnIndex: 0 };
  const standard = contents((await createEmbeddedImageWorkbook(small)).buffer);
  assert.equal(standard.sheet('sheetFormatPr').attr('defaultRowHeight'), '18');
  const templated = contents((await createEmbeddedImageWorkbook({ ...small, layout: 'reviewed-products-v1' })).buffer);
  assert.equal(templated.sheet('cols col').eq(1).attr('width'), '10');
});
