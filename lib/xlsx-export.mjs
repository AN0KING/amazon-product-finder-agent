import { readFile } from "node:fs/promises";

import { strToU8, zipSync } from "fflate";
import sharp from "sharp";

import {
  downloadAllowedProductImage,
  toOriginalAmazonImageUrl,
} from "./1688-image-download.mjs";

const MAX_EXCEL_ROWS = 1_048_576;
const MAX_EXCEL_COLUMNS = 16_384;
const MAX_CELL_TEXT_LENGTH = 32_767;
const DEFAULT_IMAGE_TIMEOUT_MS = 12_000;
const DEFAULT_IMAGE_LIMIT_BYTES = 5 * 1024 * 1024;
const DEFAULT_IMAGE_CONCURRENCY = 4;
const EMBED_IMAGE_SIZE_PX = 512;
const DISPLAY_IMAGE_SIZE_PX = 96;
const EMBED_IMAGE_JPEG_QUALITY = 92;
const EMU_PER_PIXEL = 9_525;
const REVIEWED_PRODUCTS_LAYOUT = "reviewed-products-v1";
// Template widths follow the field meaning, so inserting a date or changing
// marketplace currency cannot shift widths onto unrelated columns.
const REVIEWED_PRODUCT_COLUMN_WIDTHS = Object.freeze({
  "商品 ID": 15, "竞品图片": 16, "源 ASIN": 12, "商品名称": 56, "生效采购件数": 14,
  "竞品当前售价": 20, "我们的售价": 18, "评分": 10, "评价数": 10, "竞品 30 天销量": 16,
  "商品重量": 15, "商品上架时间": 16, "整套采购成本": 20, "采购税率": 14, "采购税费": 16,
  "落地采购成本": 20, "履约方式": 10, "FBA 配送费": 18, "空运单价": 19, "单件空运头程": 20,
  "Amazon 佣金率": 19, "汇损率": 12, "营销费率": 14, "管理费率": 14, "退货预留率": 16,
  "预估总成本": 18, "预估单件利润": 20, "预估经营利润率": 20, "数据采集时间": 26,
  "1688厂家链接": 42, "亚马逊链接": 42, "ASIN": 15, "月销量": 14, "最低售价": 18,
  "采购成本": 32, "国内物流费用": 20, "佣金占比": 18, "FBA物流费": 18, "重量": 16,
  "空运头程": 18, "汇率折损费": 20, "Marketing": 18, "管理费": 18, "退货率损失": 20,
  "VAT": 18, "总成本": 18, "总利润额": 18, "利润率": 18,
});

export class XlsxExportError extends Error {
  constructor(code, message, status = 422, cause = null) {
    super(message, cause ? { cause } : undefined);
    this.name = "XlsxExportError";
    this.code = code;
    this.status = status;
  }
}

export async function createEmbeddedImageWorkbook({
  worksheetName = "运营确认表",
  headers,
  rows,
  images,
  imageColumnIndex,
  imageStatusColumnIndex,
  layout,
  columnFormats,
  signal,
  fetchImpl = globalThis.fetch,
  lookupHost,
  imageTimeoutMs = DEFAULT_IMAGE_TIMEOUT_MS,
  maxImageBytes = DEFAULT_IMAGE_LIMIT_BYTES,
  imageConcurrency = DEFAULT_IMAGE_CONCURRENCY,
  temporaryRoot,
} = {}) {
  validateWorkbookInput({
    worksheetName,
    headers,
    rows,
    images,
    imageColumnIndex,
    imageStatusColumnIndex,
    layout,
    columnFormats,
  });
  validateImageOptions({ imageTimeoutMs, maxImageBytes, imageConcurrency, fetchImpl, lookupHost });
  throwIfAborted(signal);

  const normalizedRows = Array.from(rows, (row) => Array.from(row));
  const normalizedImages = Array.from(images, normalizeImageInput).map((image) => ({
    ...image,
    url: canonicalizeExportImageUrl(image.url),
  }));
  const imageAudit = {
    total: normalizedImages.length,
    requested: 0,
    uniqueRequested: 0,
    embedded: 0,
    failed: 0,
    missing: 0,
    failures: [],
  };
  const uniqueUrls = new Map();

  normalizedImages.forEach((image, rowIndex) => {
    if (!image.url) {
      normalizedRows[rowIndex][imageColumnIndex] = "无图片链接";
      setImageStatus(normalizedRows[rowIndex], imageStatusColumnIndex, "无图片链接");
      imageAudit.missing += 1;
      return;
    }
    imageAudit.requested += 1;
    if (!uniqueUrls.has(image.url)) uniqueUrls.set(image.url, []);
    uniqueUrls.get(image.url).push(rowIndex);
  });
  imageAudit.uniqueRequested = uniqueUrls.size;

  const uniqueImageEntries = [...uniqueUrls.entries()];
  const outcomes = await mapWithConcurrency(uniqueImageEntries, imageConcurrency, async ([url]) => {
    throwIfAborted(signal);
    return prepareImage(url, {
      signal,
      fetchImpl,
      lookupHost,
      imageTimeoutMs,
      maxImageBytes,
      temporaryRoot,
    });
  });

  const media = [];
  const embeddedRows = [];
  for (let entryIndex = 0; entryIndex < uniqueImageEntries.length; entryIndex += 1) {
    const [url, rowIndexes] = uniqueImageEntries[entryIndex];
    const outcome = outcomes[entryIndex];
    if (!outcome.ok) {
      for (const rowIndex of rowIndexes) {
        normalizedRows[rowIndex][imageColumnIndex] = "图片获取失败";
        setImageStatus(normalizedRows[rowIndex], imageStatusColumnIndex, `嵌入失败：${outcome.message}`);
        imageAudit.failed += 1;
        imageAudit.failures.push({
          rowNumber: rowIndex + 2,
          url,
          code: outcome.code,
          message: outcome.message,
        });
      }
      continue;
    }

    const mediaId = media.length + 1;
    media.push({ id: mediaId, buffer: outcome.buffer });
    for (const rowIndex of rowIndexes) {
      normalizedRows[rowIndex][imageColumnIndex] = "";
      setImageStatus(normalizedRows[rowIndex], imageStatusColumnIndex, "已嵌入");
      embeddedRows.push({ rowIndex, mediaId });
      imageAudit.embedded += 1;
    }
  }

  throwIfAborted(signal);
  validateNormalizedCells(normalizedRows);
  const hyperlinks = collectHyperlinks(normalizedRows, imageColumnIndex);
  const files = buildPackage({
    worksheetName,
    headers,
    rows: normalizedRows,
    imageColumnIndex,
    media,
    embeddedRows,
    hyperlinks,
    layout,
    columnFormats,
  });

  return {
    buffer: Buffer.from(zipSync(files, { level: 6 })),
    imageAudit,
  };
}

async function prepareImage(url, options) {
  let downloaded;
  const timeoutSignal = AbortSignal.timeout(options.imageTimeoutMs);
  const requestSignal = options.signal
    ? AbortSignal.any([options.signal, timeoutSignal])
    : timeoutSignal;
  try {
    downloaded = await downloadAllowedProductImage(url, {
      fetchImpl: options.fetchImpl,
      lookupHost: options.lookupHost,
      signal: requestSignal,
      maxBytes: options.maxImageBytes,
      temporaryRoot: options.temporaryRoot,
    });
    const source = await readFile(downloaded.path);
    const buffer = await sharp(source, { failOn: "error" })
      .rotate()
      .resize(EMBED_IMAGE_SIZE_PX, EMBED_IMAGE_SIZE_PX, {
        fit: "contain",
        background: { r: 255, g: 255, b: 255, alpha: 1 },
        withoutEnlargement: true,
      })
      .flatten({ background: "#ffffff" })
      .jpeg({ quality: EMBED_IMAGE_JPEG_QUALITY, chromaSubsampling: "4:4:4" })
      .toBuffer();
    return { ok: true, buffer };
  } catch (error) {
    if (options.signal?.aborted) throw options.signal.reason || error;
    const timedOut = timeoutSignal.aborted;
    return {
      ok: false,
      code: timedOut ? "IMAGE_TIMEOUT" : String(error?.code || "IMAGE_EXPORT_FAILED"),
      message: timedOut ? "商品图片下载超时。" : String(error?.message || "商品图片无法嵌入工作簿。"),
    };
  } finally {
    await downloaded?.cleanup?.().catch(() => {});
  }
}

function buildPackage({
  worksheetName,
  headers,
  rows,
  imageColumnIndex,
  media,
  embeddedRows,
  hyperlinks,
  layout,
  columnFormats,
}) {
  const hasDrawing = embeddedRows.length > 0;
  const hasSheetRelationships = hasDrawing || hyperlinks.length > 0;
  const files = {
    "[Content_Types].xml": xmlFile(contentTypesXml(hasDrawing)),
    "_rels/.rels": xmlFile(rootRelationshipsXml()),
    "docProps/app.xml": xmlFile(appPropertiesXml(worksheetName)),
    "docProps/core.xml": xmlFile(corePropertiesXml()),
    "xl/workbook.xml": xmlFile(workbookXml(worksheetName)),
    "xl/_rels/workbook.xml.rels": xmlFile(workbookRelationshipsXml()),
    "xl/styles.xml": xmlFile(stylesXml(columnFormats?.includes("yyyy-mm-dd"), columnFormats?.includes("0.00"))),
    "xl/worksheets/sheet1.xml": xmlFile(worksheetXml({
      headers,
      rows,
      imageColumnIndex,
      hasDrawing,
      hyperlinks,
      layout,
      columnFormats,
    })),
  };

  if (hasSheetRelationships) {
    files["xl/worksheets/_rels/sheet1.xml.rels"] = xmlFile(sheetRelationshipsXml({ hasDrawing, hyperlinks }));
  }
  if (hasDrawing) {
    files["xl/drawings/drawing1.xml"] = xmlFile(drawingXml(embeddedRows, imageColumnIndex));
    files["xl/drawings/_rels/drawing1.xml.rels"] = xmlFile(drawingRelationshipsXml(media));
    for (const image of media) files[`xl/media/image${image.id}.jpeg`] = image.buffer;
  }
  return files;
}

function worksheetXml({ headers, rows, imageColumnIndex, hasDrawing, hyperlinks, layout, columnFormats }) {
  const finalRow = rows.length + 1;
  const finalColumn = columnName(headers.length - 1);
  const widths = inferColumnWidths(headers, rows, imageColumnIndex, layout);
  const hyperlinkByCell = new Map(hyperlinks.map((item) => [item.ref, item]));
  const headerCells = headers.map((value, columnIndex) => cellXml(value, columnIndex, 1, 1, false)).join("");
  const dataRows = rows.map((row, rowIndex) => {
    const excelRow = rowIndex + 2;
    const cells = row.map((value, columnIndex) => {
      const ref = `${columnName(columnIndex)}${excelRow}`;
      const style = columnIndex === imageColumnIndex ? 4 : hyperlinkByCell.has(ref) ? 3
        : columnFormats?.[columnIndex] === "yyyy-mm-dd" ? 5
          : columnFormats?.[columnIndex] === "0.00" ? (columnFormats.includes("yyyy-mm-dd") ? 6 : 5) : 2;
      return cellXml(value, columnIndex, excelRow, style, true);
    }).join("");
    return `<row r="${excelRow}" ht="80" customHeight="1">${cells}</row>`;
  }).join("");
  const cols = widths.map((width, index) => `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>`).join("");
  const hyperlinkXml = hyperlinks.length
    ? `<hyperlinks>${hyperlinks.map((item) => `<hyperlink ref="${item.ref}" r:id="rId${item.relationshipId}"/>`).join("")}</hyperlinks>`
    : "";
  const drawing = hasDrawing ? '<drawing r:id="rId1"/>' : "";

  return xmlDocument(`<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
    <dimension ref="A1:${finalColumn}${finalRow}"/>
    <sheetViews><sheetView workbookViewId="0" showGridLines="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A2" sqref="A2"/></sheetView></sheetViews>
    <sheetFormatPr ${layout === REVIEWED_PRODUCTS_LAYOUT ? 'baseColWidth="8" defaultColWidth="9" defaultRowHeight="12.75"' : 'defaultRowHeight="18"'}/>
    <cols>${cols}</cols>
    <sheetData><row r="1" ht="${layout === REVIEWED_PRODUCTS_LAYOUT ? 48 : 24}" customHeight="1">${headerCells}</row>${dataRows}</sheetData>
    <autoFilter ref="A1:${finalColumn}${finalRow}"/>
    ${hyperlinkXml}
    <pageMargins left="0.3" right="0.3" top="0.5" bottom="0.5" header="0.2" footer="0.2"/>
    ${drawing}
  </worksheet>`);
}

function cellXml(value, columnIndex, rowNumber, style, includeBlank) {
  const reference = `${columnName(columnIndex)}${rowNumber}`;
  if (value === null || value === undefined || value === "") {
    return includeBlank ? `<c r="${reference}" s="${style}"/>` : "";
  }
  if (typeof value === "number") {
    return `<c r="${reference}" s="${style}"><v>${String(value)}</v></c>`;
  }
  if (typeof value === "boolean") {
    return `<c r="${reference}" s="${style}" t="b"><v>${value ? 1 : 0}</v></c>`;
  }
  const text = String(value);
  const preserve = /^\s|\s$/.test(text) ? ' xml:space="preserve"' : "";
  return `<c r="${reference}" s="${style}" t="inlineStr"><is><t${preserve}>${escapeXml(text)}</t></is></c>`;
}

function collectHyperlinks(rows, imageColumnIndex) {
  const links = [];
  rows.forEach((row, rowIndex) => {
    row.forEach((value, columnIndex) => {
      if (columnIndex === imageColumnIndex || typeof value !== "string") return;
      let url;
      try {
        url = new URL(value);
      } catch (_) {
        return;
      }
      if (url.protocol !== "https:" || url.username || url.password) return;
      links.push({
        ref: `${columnName(columnIndex)}${rowIndex + 2}`,
        target: url.href,
        relationshipId: 0,
      });
    });
  });
  const firstRelationshipId = 2;
  links.forEach((link, index) => { link.relationshipId = firstRelationshipId + index; });
  return links;
}

function drawingXml(embeddedRows, imageColumnIndex) {
  const anchors = embeddedRows.map((entry, index) => {
    const relationshipId = entry.mediaId;
    const row = entry.rowIndex + 1;
    return `<xdr:oneCellAnchor>
      <xdr:from><xdr:col>${imageColumnIndex}</xdr:col><xdr:colOff>${4 * EMU_PER_PIXEL}</xdr:colOff><xdr:row>${row}</xdr:row><xdr:rowOff>${4 * EMU_PER_PIXEL}</xdr:rowOff></xdr:from>
      <xdr:ext cx="${DISPLAY_IMAGE_SIZE_PX * EMU_PER_PIXEL}" cy="${DISPLAY_IMAGE_SIZE_PX * EMU_PER_PIXEL}"/>
      <xdr:pic>
        <xdr:nvPicPr><xdr:cNvPr id="${index + 2}" name="竞品图片 ${entry.rowIndex + 1}"/><xdr:cNvPicPr><a:picLocks noChangeAspect="1"/></xdr:cNvPicPr></xdr:nvPicPr>
        <xdr:blipFill><a:blip r:embed="rId${relationshipId}"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill>
        <xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${DISPLAY_IMAGE_SIZE_PX * EMU_PER_PIXEL}" cy="${DISPLAY_IMAGE_SIZE_PX * EMU_PER_PIXEL}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr>
      </xdr:pic>
      <xdr:clientData/>
    </xdr:oneCellAnchor>`;
  }).join("");
  return xmlDocument(`<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">${anchors}</xdr:wsDr>`);
}

function drawingRelationshipsXml(media) {
  return relationshipsXml(media.map((image) => ({
    id: image.id,
    type: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image",
    target: `../media/image${image.id}.jpeg`,
  })));
}

function sheetRelationshipsXml({ hasDrawing, hyperlinks }) {
  const relationships = [];
  if (hasDrawing) {
    relationships.push({
      id: 1,
      type: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing",
      target: "../drawings/drawing1.xml",
    });
  }
  for (const link of hyperlinks) {
    relationships.push({
      id: link.relationshipId,
      type: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink",
      target: link.target,
      targetMode: "External",
    });
  }
  return relationshipsXml(relationships);
}

function relationshipsXml(relationships) {
  const items = relationships.map((item) => `<Relationship Id="rId${item.id}" Type="${item.type}" Target="${escapeXml(item.target)}"${item.targetMode ? ` TargetMode="${item.targetMode}"` : ""}/>`).join("");
  return xmlDocument(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${items}</Relationships>`);
}

function contentTypesXml(hasDrawing) {
  const drawing = hasDrawing
    ? '<Default Extension="jpeg" ContentType="image/jpeg"/><Override PartName="/xl/drawings/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>'
    : "";
  return xmlDocument(`<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
    <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
    <Default Extension="xml" ContentType="application/xml"/>
    ${drawing}
    <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
    <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
    <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
    <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
    <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
  </Types>`);
}

function rootRelationshipsXml() {
  return relationshipsXml([
    { id: 1, type: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument", target: "xl/workbook.xml" },
    { id: 2, type: "http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties", target: "docProps/core.xml" },
    { id: 3, type: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties", target: "docProps/app.xml" },
  ]);
}

function workbookRelationshipsXml() {
  return relationshipsXml([
    { id: 1, type: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet", target: "worksheets/sheet1.xml" },
    { id: 2, type: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles", target: "styles.xml" },
  ]);
}

function workbookXml(worksheetName) {
  return xmlDocument(`<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><bookViews><workbookView/></bookViews><sheets><sheet name="${escapeXml(worksheetName)}" sheetId="1" r:id="rId1"/></sheets><calcPr calcId="191029"/></workbook>`);
}

function appPropertiesXml(worksheetName) {
  return xmlDocument(`<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>Scout Amazon Agent</Application><HeadingPairs><vt:vector size="2" baseType="variant"><vt:variant><vt:lpstr>Worksheets</vt:lpstr></vt:variant><vt:variant><vt:i4>1</vt:i4></vt:variant></vt:vector></HeadingPairs><TitlesOfParts><vt:vector size="1" baseType="lpstr"><vt:lpstr>${escapeXml(worksheetName)}</vt:lpstr></vt:vector></TitlesOfParts></Properties>`);
}

function corePropertiesXml() {
  const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  return xmlDocument(`<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:creator>Scout Amazon Agent</dc:creator><cp:lastModifiedBy>Scout Amazon Agent</cp:lastModifiedBy><dcterms:created xsi:type="dcterms:W3CDTF">${timestamp}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${timestamp}</dcterms:modified></cp:coreProperties>`);
}

function stylesXml(hasDates = false, hasDecimals = false) {
  return xmlDocument(`<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
    ${hasDates ? '<numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy-mm-dd"/></numFmts>' : ""}
    <fonts count="3">
      <font><sz val="10"/><name val="Arial"/><family val="2"/></font>
      <font><b/><color rgb="FFFFFFFF"/><sz val="10"/><name val="Arial"/><family val="2"/></font>
      <font><u/><color rgb="FF0563C1"/><sz val="10"/><name val="Arial"/><family val="2"/></font>
    </fonts>
    <fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF17324D"/><bgColor indexed="64"/></patternFill></fill></fills>
    <borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left/><right/><top/><bottom style="thin"><color rgb="FFD9E2E7"/></bottom><diagonal/></border></borders>
    <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
    <cellXfs count="${5 + Number(hasDates) + Number(hasDecimals)}">
      <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
      <xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
      <xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>
      <xf numFmtId="0" fontId="2" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>
      <xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="bottom" wrapText="1"/></xf>
      ${hasDates ? '<xf numFmtId="164" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>' : ""}
      ${hasDecimals ? '<xf numFmtId="2" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>' : ""}
    </cellXfs>
    <cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles><dxfs count="0"/><tableStyles count="0" defaultTableStyle="TableStyleMedium2" defaultPivotStyle="PivotStyleLight16"/>
  </styleSheet>`);
}

function inferColumnWidths(headers, rows, imageColumnIndex, layout) {
  return headers.map((header, columnIndex) => {
    if (columnIndex === imageColumnIndex) return 16;
    const templateHeader = header.trim().replace(/\s*(?:\([^()]*\)|（[^（）]*）)\s*$/, "");
    const templateWidth = layout === REVIEWED_PRODUCTS_LAYOUT && Object.hasOwn(REVIEWED_PRODUCT_COLUMN_WIDTHS, templateHeader)
      ? REVIEWED_PRODUCT_COLUMN_WIDTHS[templateHeader] : null;
    if (templateWidth !== null && templateWidth !== undefined) return templateWidth;
    let longest = displayWidth(header);
    for (const row of rows) longest = Math.max(longest, displayWidth(row[columnIndex]));
    return Math.min(56, Math.max(10, longest + 2));
  });
}

function displayWidth(value) {
  if (value === null || value === undefined) return 0;
  return [...String(value)].reduce((width, character) => width + (/[^\u0000-\u00ff]/.test(character) ? 2 : 1), 0);
}

export function validateWorkbookInput({ worksheetName, headers, rows, images, imageColumnIndex, imageStatusColumnIndex, layout, columnFormats }) {
  if (typeof worksheetName !== "string" || !worksheetName.trim() || worksheetName.length > 31
    || /[\[\]:*?/\\\u0000-\u001f]/.test(worksheetName) || /^'|'$/.test(worksheetName)) {
    throw new XlsxExportError("INVALID_WORKSHEET_NAME", "工作表名称无效或超过 31 个字符。", 400);
  }
  if (!Array.isArray(headers) || headers.length < 1 || headers.length > MAX_EXCEL_COLUMNS) {
    throw new XlsxExportError("INVALID_HEADERS", `表头必须包含 1-${MAX_EXCEL_COLUMNS} 列。`, 400);
  }
  if (!Array.isArray(rows) || rows.length + 1 > MAX_EXCEL_ROWS) {
    throw new XlsxExportError("ROW_LIMIT_EXCEEDED", `导出数据不能超过 ${MAX_EXCEL_ROWS - 1} 行。`, 413);
  }
  if (layout !== undefined && layout !== null && layout !== REVIEWED_PRODUCTS_LAYOUT) {
    throw new XlsxExportError("INVALID_WORKBOOK_LAYOUT", "导出表格版式无效。", 400);
  }
  if (columnFormats !== undefined && columnFormats !== null
    && (!Array.isArray(columnFormats) || columnFormats.length !== headers.length
      || Array.from(columnFormats).some(format => ![undefined, null, "General", "yyyy-mm-dd", "0.00"].includes(format)))) {
    throw new XlsxExportError("INVALID_COLUMN_FORMATS", "列格式必须与表头对应，且只能使用 General、yyyy-mm-dd 或 0.00。", 400);
  }
  if (columnFormats?.[imageColumnIndex] === "yyyy-mm-dd") {
    throw new XlsxExportError("INVALID_COLUMN_FORMATS", "图片列不能使用日期格式。", 400);
  }
  if (!Array.isArray(images) || images.length !== rows.length) {
    throw new XlsxExportError("IMAGE_ROW_MISMATCH", "图片列表必须与数据行逐行对应。", 400);
  }
  if (!Number.isInteger(imageColumnIndex) || imageColumnIndex < 0 || imageColumnIndex >= headers.length) {
    throw new XlsxExportError("INVALID_IMAGE_COLUMN", "图片列位置无效。", 400);
  }
  if (imageStatusColumnIndex !== undefined && imageStatusColumnIndex !== null
    && (!Number.isInteger(imageStatusColumnIndex) || imageStatusColumnIndex < 0
      || imageStatusColumnIndex >= headers.length || imageStatusColumnIndex === imageColumnIndex)) {
    throw new XlsxExportError("INVALID_IMAGE_STATUS_COLUMN", "图片嵌入状态列位置无效。", 400);
  }
  Array.from(headers).forEach((header, columnIndex) => validateCellValue(header, `表头第 ${columnIndex + 1} 列`, true));
  Array.from(rows).forEach((row, rowIndex) => {
    if (!Array.isArray(row) || row.length !== headers.length) {
      throw new XlsxExportError("ROW_WIDTH_MISMATCH", `第 ${rowIndex + 1} 行与表头列数不一致。`, 400);
    }
    row.forEach((value, columnIndex) => validateCellValue(value, `${columnName(columnIndex)}${rowIndex + 2}`));
  });
}

function validateNormalizedCells(rows) {
  rows.forEach((row, rowIndex) => row.forEach((value, columnIndex) => validateCellValue(value, `${columnName(columnIndex)}${rowIndex + 2}`)));
}

function validateCellValue(value, location, requireText = false) {
  if (requireText && typeof value !== "string") {
    throw new XlsxExportError("INVALID_HEADER_VALUE", `${location}必须是文本。`, 400);
  }
  if (value === null || value === undefined) return;
  if (!["string", "number", "boolean"].includes(typeof value)) {
    throw new XlsxExportError("INVALID_CELL_VALUE", `${location}不是可导出的单元格值。`, 400);
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new XlsxExportError("INVALID_CELL_NUMBER", `${location}不是有限数值。`, 400);
  }
  if (typeof value === "string" && value.length > MAX_CELL_TEXT_LENGTH) {
    throw new XlsxExportError("CELL_TEXT_TOO_LONG", `${location}超过 Excel 单元格文本上限。`, 413);
  }
}

function validateImageOptions({ imageTimeoutMs, maxImageBytes, imageConcurrency, fetchImpl, lookupHost }) {
  if (!Number.isInteger(imageTimeoutMs) || imageTimeoutMs < 1_000 || imageTimeoutMs > 60_000) {
    throw new XlsxExportError("INVALID_IMAGE_TIMEOUT", "图片下载超时必须在 1-60 秒之间。", 500);
  }
  if (!Number.isInteger(maxImageBytes) || maxImageBytes < 1 || maxImageBytes > 20 * 1024 * 1024) {
    throw new XlsxExportError("INVALID_IMAGE_LIMIT", "图片大小上限配置无效。", 500);
  }
  if (!Number.isInteger(imageConcurrency) || imageConcurrency < 1 || imageConcurrency > 8) {
    throw new XlsxExportError("INVALID_IMAGE_CONCURRENCY", "图片并发数必须在 1-8 之间。", 500);
  }
  if (typeof fetchImpl !== "function") {
    throw new XlsxExportError("INVALID_FETCH_IMPLEMENTATION", "图片下载功能不可用。", 500);
  }
  if (lookupHost !== undefined && typeof lookupHost !== "function") {
    throw new XlsxExportError("INVALID_DNS_LOOKUP", "图片域名验证功能不可用。", 500);
  }
}

function normalizeImageInput(value) {
  if (value === null || value === undefined || value === "") return { url: "" };
  if (typeof value === "string") return { url: value.trim() };
  if (typeof value === "object" && !Array.isArray(value) && (value.url === null || value.url === undefined || typeof value.url === "string")) {
    return { url: String(value.url || "").trim() };
  }
  throw new XlsxExportError("INVALID_IMAGE_ENTRY", "图片列表包含无效条目。", 400);
}

function canonicalizeExportImageUrl(value) {
  if (!value) return "";
  try {
    return toOriginalAmazonImageUrl(value);
  } catch (_) {
    // The downloader keeps invalid or unapproved URLs as row-level failures.
    return value;
  }
}

function setImageStatus(row, imageStatusColumnIndex, value) {
  if (Number.isInteger(imageStatusColumnIndex)) row[imageStatusColumnIndex] = value;
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      results[index] = await mapper(items[index], index);
    }
  });
  const settled = await Promise.allSettled(workers);
  const failure = settled.find((result) => result.status === "rejected");
  if (failure) throw failure.reason;
  return results;
}

function columnName(index) {
  let value = index + 1;
  let result = "";
  while (value > 0) {
    const remainder = (value - 1) % 26;
    result = String.fromCharCode(65 + remainder) + result;
    value = Math.floor((value - 1) / 26);
  }
  return result;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw signal.reason || new DOMException("The operation was aborted.", "AbortError");
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function xmlDocument(contents) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>${contents}`;
}

function xmlFile(contents) {
  return strToU8(contents);
}
