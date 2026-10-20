import { readSheet } from 'read-excel-file/node';
import { MAX_STORE_FILE_BYTES, StoreListError } from './store-list.mjs';

export const MAX_IMPORTED_ASINS = 10_000;
const MAX_INPUT_ENTRIES = 20_000;
const ASIN_PATTERN = /^[A-Z0-9]{10}$/;
const DOMAINS = Object.freeze({ AU: 'amazon.com.au', US: 'amazon.com', CA: 'amazon.ca', NL: 'amazon.nl',
  UK: 'amazon.co.uk', DE: 'amazon.de', FR: 'amazon.fr', IT: 'amazon.it', ES: 'amazon.es',
  PL: 'amazon.pl', MX: 'amazon.com.mx', BR: 'amazon.com.br' });
const HEADERS = new Map([
  ['asin', 'asin'], ['asins', 'asin'], ['商品asin', 'asin'], ['产品asin', 'asin'],
  ['producturl', 'url'], ['amazonurl', 'url'], ['url', 'url'], ['商品链接', 'url'], ['产品链接', 'url'],
  ['marketplace', 'marketplace'], ['market', 'marketplace'], ['站点', 'marketplace'], ['国家', 'marketplace'],
]);
const textValue = value => String(value ?? '').normalize('NFKC').trim();
const fail = (code, message) => { throw Object.assign(new StoreListError(code, message), { status: 422 }); };

function marketCode(value) {
  const code = textValue(value).toUpperCase();
  if (!DOMAINS[code]) fail('UNSUPPORTED_MARKETPLACE', `不支持站点 ${code || '（空）'}，请选择明确的 Amazon 站点。`);
  return code;
}

function tokens(value) { return textValue(value).split(/[\s,;|，；]+/).filter(Boolean); }

function parseToken(value, selectedMarket, rowNumber) {
  const text = textValue(value);
  const plainAsin = text.toUpperCase();
  if (ASIN_PATTERN.test(plainAsin)) return { asin: plainAsin, marketplace: selectedMarket, rowNumber, marketplaceSource: 'selected' };
  let url;
  try { url = new URL(text); } catch { fail('INVALID_ASIN_INPUT', `第 ${rowNumber} 行不是有效的 10 位 ASIN 或 Amazon 商品链接。`); }
  const host = url.hostname.toLowerCase();
  const marketplace = Object.keys(DOMAINS).find(code => host === DOMAINS[code] || host === `www.${DOMAINS[code]}`);
  if (!marketplace || !['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port) {
    fail('INVALID_ASIN_URL', `第 ${rowNumber} 行必须是支持站点的 Amazon 商品链接，不能使用短链接或其他域名。`);
  }
  const match = url.pathname.match(/\/(?:dp|gp\/product|gp\/aw\/d)\/([A-Z0-9]{10})(?:\/|$)/i);
  if (!match) fail('INVALID_ASIN_URL', `第 ${rowNumber} 行商品链接缺少明确 ASIN，请使用 /dp/ASIN 链接。`);
  url.protocol = 'https:';
  return { asin: match[1].toUpperCase(), marketplace, rowNumber, marketplaceSource: 'product_url', productUrl: url.href };
}

function finish(entries, { marketplace, rawRows, sourceColumn = null, sourceFormat = null, skippedBlankAsinRows = [] }) {
  if (!entries.length) fail('EMPTY_ASIN_LIST', '请至少填写一个 ASIN 或 Amazon 商品链接。');
  if (entries.length > MAX_INPUT_ENTRIES) fail('TOO_MANY_ASINS', `单次最多读取 ${MAX_INPUT_ENTRIES} 个输入项。`);
  const marketplaces = [...new Set(entries.map(item => item.marketplace))];
  if (marketplaces.length !== 1) fail('ASIN_MARKETPLACE_MISMATCH', `本批包含 ${marketplaces.join('、')} 站点，请按站点分批导入；纯 ASIN 使用当前选择的站点。`);
  const detectedMarketplace = marketplaces[0];
  const records = new Map();
  for (const entry of entries) {
    const key = `${entry.marketplace}:${entry.asin}`;
    const existing = records.get(key);
    if (existing) {
      existing.rowNumbers.push(entry.rowNumber);
      if (entry.productUrl && existing.marketplaceSource !== 'product_url') {
        existing.productUrl = entry.productUrl;
        existing.marketplaceSource = 'product_url';
      }
      continue;
    }
    records.set(key, { ...entry, rowNumbers: [entry.rowNumber], productUrl: entry.productUrl || `https://www.${DOMAINS[entry.marketplace]}/dp/${entry.asin}` });
  }
  const rows = [...records.values()];
  if (rows.length > MAX_IMPORTED_ASINS) fail('TOO_MANY_ASINS', `单批最多导入 ${MAX_IMPORTED_ASINS} 个不同 ASIN。`);
  const rowNumbers = [...new Set(entries.map(item => item.rowNumber))];
  const productUrls = Object.fromEntries(rows.filter(row => row.marketplaceSource === 'product_url').map(row => [row.asin, row.productUrl]));
  return { inputMode: 'asins', marketplace: detectedMarketplace, rows,
    stores: [{ inputMode: 'asins', marketplace: detectedMarketplace, sellerId: null, sellerName: null,
      sellerUrl: null, asins: rows.map(row => row.asin), rowNumbers, resolved: true, importBlocked: false,
      ...(Object.keys(productUrls).length ? { productUrls } : {}),
      criteria: {}, criteriaSource: { schemaVersion: '1.0', marginUnit: 'percent', rows: [] } }],
    audit: { inputMode: 'asins', rawRows, inputEntries: entries.length, uniqueAsins: rows.length,
      uniqueSellers: 0, duplicates: entries.length - rows.length, repaired: 0, invalid: 0, resolved: 1,
      unresolved: 0, marketplace: detectedMarketplace, selectedMarketplace: marketplace,
      marketplaceDomain: DOMAINS[detectedMarketplace], detectedMarketplaces: marketplaces,
      requiresSeparateBatches: false, criteriaConflictStores: 0,
      ...(sourceColumn ? { sourceColumn } : {}), ...(sourceFormat ? { sourceFormat } : {}),
      skippedBlankAsinRows: skippedBlankAsinRows.length },
    issues: skippedBlankAsinRows.map(rowNumber => ({ rowNumber, code: 'EMPTY_ASIN_CELL_SKIPPED',
      message: '该行 ASIN 列为空，已跳过；没有从商品链接或店铺链接扩充采集范围。' })),
    rejectedRows: [], marketplaceGroups: [{ marketplace: detectedMarketplace, rowNumbers,
      acceptedRows: rawRows - skippedBlankAsinRows.length, rejectedRows: 0, requiresSeparateBatch: false }] };
}

export function parseAsinText(text, { marketplace = 'AU' } = {}) {
  const market = marketCode(marketplace);
  if (typeof text !== 'string') fail('INVALID_ASIN_INPUT', 'ASIN 输入内容必须是文本。');
  if (Buffer.byteLength(text) > MAX_STORE_FILE_BYTES) fail('FILE_TOO_LARGE', 'ASIN 文本超过 5 MB 限制。');
  const entries = [];
  let rawRows = 0;
  text.split(/\r?\n/).forEach((line, index) => {
    const values = tokens(line);
    if (values.length) rawRows += 1;
    for (const value of values) {
      if (entries.length >= MAX_INPUT_ENTRIES) fail('TOO_MANY_ASINS', `单次最多读取 ${MAX_INPUT_ENTRIES} 个输入项。`);
      entries.push(parseToken(value, market, index + 1));
    }
  });
  return finish(entries, { marketplace: market, rawRows });
}

export function parseAsinRows(rows, { marketplace = 'AU', requireAsinColumn = false } = {}) {
  const market = marketCode(marketplace);
  if (!Array.isArray(rows) || !rows.length) fail('EMPTY_ASIN_LIST', 'Excel 没有可读取的 ASIN 数据。');
  const header = {};
  (rows[0] || []).forEach((value, index) => {
    const key = HEADERS.get(textValue(value).toLowerCase().replace(/[\s_-]+/g, ''));
    if (key && header[key] !== undefined) fail('INVALID_ASIN_HEADER', `Excel 存在重复的 ${key} 列。`);
    if (key) header[key] = index;
  });
  if (requireAsinColumn && header.asin === undefined) fail('ASIN_COLUMN_REQUIRED', '当前文件没有 ASIN 列，请重新选择包含 ASIN 列的 Excel。');
  if (header.asin === undefined && header.url === undefined) {
    if (Object.keys(header).length) fail('INVALID_ASIN_HEADER', 'Excel 表头缺少 ASIN 或商品链接列。');
    // Without a named product column, only one consistently positioned cell per
    // row is unambiguous. Every row is data, including row one. Seller identities
    // in product URL queries never become collection scope.
    const entries = [];
    let sourceIndex = null;
    for (let index = 0; index < rows.length; index += 1) {
      const populated = (rows[index] || []).map((value, column) => ({ value, column }))
        .filter(cell => textValue(cell.value));
      if (!populated.length) continue;
      if (populated.length !== 1 || (sourceIndex !== null && sourceIndex !== populated[0].column)) {
        fail('AMBIGUOUS_ASIN_COLUMNS', `第 ${index + 1} 行存在不明确的多列输入，请保留单列 ASIN / 商品链接，或添加明确表头。`);
      }
      sourceIndex = populated[0].column;
      entries.push(parseToken(populated[0].value, market, index + 1));
      if (entries.length > MAX_INPUT_ENTRIES) fail('TOO_MANY_ASINS', `单次最多读取 ${MAX_INPUT_ENTRIES} 个输入项。`);
    }
    return finish(entries, { marketplace: market, rawRows: entries.length,
      sourceColumn: entries.some(entry => entry.marketplaceSource === 'product_url') ? 'product_url' : 'asin',
      sourceFormat: 'headerless_single_column' });
  }
  // Once an ASIN column is present it is the sole source of requested products.
  // Seller/product URL columns cannot silently supply extra ASINs or change
  // the selected marketplace of a plain ASIN.
  const sourceColumn = header.asin !== undefined ? 'asin' : 'product_url';
  const entries = [];
  const skippedBlankAsinRows = [];
  let rawRows = 0;
  for (let index = 1; index < rows.length; index += 1) {
    const row = rows[index] || [];
    if (row.every(value => !textValue(value))) continue;
    rawRows += 1;
    const rowNumber = index + 1;
    const selectedTokens = tokens(row[sourceColumn === 'asin' ? header.asin : header.url]);
    if (!selectedTokens.length && sourceColumn === 'asin') {
      skippedBlankAsinRows.push(rowNumber);
      continue;
    }
    if (!selectedTokens.length) fail('INVALID_ASIN_INPUT', `第 ${rowNumber} 行未填写商品链接。`);
    const declared = textValue(row[header.marketplace]);
    const rowMarket = declared ? marketCode(declared) : market;
    const selected = selectedTokens.map(token => parseToken(token, rowMarket, rowNumber));
    if (declared && selected.some(item => item.marketplace !== rowMarket)) fail('ASIN_MARKETPLACE_MISMATCH', `第 ${rowNumber} 行站点与商品链接不一致，请修正后导入。`);
    entries.push(...selected);
    if (entries.length > MAX_INPUT_ENTRIES) fail('TOO_MANY_ASINS', `单次最多读取 ${MAX_INPUT_ENTRIES} 个输入项。`);
  }
  return finish(entries, { marketplace: market, rawRows, sourceColumn, skippedBlankAsinRows });
}

export async function parseAsinListBuffer(input, { fileName = 'asins.xlsx', marketplace = 'AU', requireAsinColumn = false } = {}) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input || []);
  if (!buffer.length) fail('EMPTY_FILE', '上传文件为空。');
  if (buffer.length > MAX_STORE_FILE_BYTES) fail('FILE_TOO_LARGE', 'Excel 超过 5 MB 限制。');
  let decodedName;
  try { decodedName = decodeURIComponent(fileName); } catch { decodedName = fileName; }
  if (!String(decodedName).toLowerCase().endsWith('.xlsx')) fail('UNSUPPORTED_FILE_TYPE', '仅支持 .xlsx 文件。');
  if (buffer[0] !== 0x50 || buffer[1] !== 0x4b) fail('INVALID_XLSX', '上传内容不是 XLSX 文件。');
  let rows;
  try { rows = await readSheet(buffer); } catch { fail('INVALID_XLSX', '无法读取该 XLSX 文件。'); }
  return parseAsinRows(rows, { marketplace, requireAsinColumn });
}

// A store-mode upload can preserve an independently validated direct-product view
// of the exact same workbook. Never reconstruct this proof from merged store
// records, discovered products or store checkpoints after the file is gone.
export async function buildUploadedAsinProjection(input, options = {}) {
  const projection = { version: 1, source: 'uploaded_excel_direct_products' };
  try {
    const data = await parseAsinListBuffer(input, options);
    return { ...projection, status: 'ready', data };
  } catch (error) {
    if (!(error instanceof StoreListError)) throw error;
    return { ...projection, status: 'unavailable', data: null, error: { code: error.code, message: error.message } };
  }
}

// Validate persisted input again before starting: snapshots can also arrive via
// /api/runs, so the upload parser alone is not a sufficient scope boundary.
export function validateDirectAsinStores(stores, marketplace) {
  const market = marketCode(marketplace);
  if (!Array.isArray(stores) || !stores.length) fail('EMPTY_ASIN_LIST', 'ASIN 任务没有有效输入。');
  const entries = [];
  for (const store of stores) {
    if (!store || typeof store !== 'object' || Array.isArray(store)) fail('INVALID_ASIN_INPUT', 'ASIN 任务输入格式无效。');
    if (store.sellerId || store.sellerName || store.sellerUrl) fail('INVALID_ASIN_INPUT', 'ASIN 直采任务不能混入店铺身份。');
    if (store.marketplace && marketCode(store.marketplace) !== market) fail('ASIN_MARKETPLACE_MISMATCH', 'ASIN 任务站点与批次不一致。');
    if (!Array.isArray(store.asins) || !store.asins.length) fail('EMPTY_ASIN_LIST', 'ASIN 任务没有有效输入。');
    for (const asin of store.asins) {
      if (typeof asin !== 'string' || !ASIN_PATTERN.test(asin)) fail('INVALID_ASIN_INPUT', 'ASIN 任务包含未校验的 ASIN。');
      entries.push(asin);
    }
    validateDirectAsinProductUrls(store.productUrls, store.asins, market);
  }
  if (entries.length > MAX_IMPORTED_ASINS) fail('TOO_MANY_ASINS', `单批最多导入 ${MAX_IMPORTED_ASINS} 个 ASIN。`);
  return [...new Set(entries)];
}

// Saved URLs are navigation hints for the existing ASIN set, never a source of
// additional products or a reason to adopt a different page ASIN.
export function validateDirectAsinProductUrls(value, asins, marketplace) {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_ASIN_URL', '商品链接映射格式无效。');
  const market = marketCode(marketplace);
  const requested = new Set(asins);
  const result = {};
  for (const [asin, productUrl] of Object.entries(value)) {
    if (!requested.has(asin) || !ASIN_PATTERN.test(asin) || typeof productUrl !== 'string' || productUrl.length > 8192
      || /[\u0000-\u0020\u007f]/.test(productUrl)) fail('INVALID_ASIN_URL', '商品链接必须属于原任务导入的 ASIN。');
    const parsed = parseToken(productUrl, market, 1);
    if (!parsed.productUrl || parsed.asin !== asin || parsed.marketplace !== market) {
      fail('INVALID_ASIN_URL', '商品链接的 ASIN 与站点必须和原任务一致。');
    }
    result[asin] = parsed.productUrl;
  }
  return result;
}
