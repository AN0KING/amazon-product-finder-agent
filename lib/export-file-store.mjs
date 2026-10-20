import { randomBytes } from "node:crypto";
import { link, lstat, mkdir, open, unlink } from "node:fs/promises";
import path from "node:path";

export const DEFAULT_EXPORT_DIRECTORY = process.env.SCOUT_EXPORT_DIR || "D:\\铺货筛选";

const EXPORT_FILE_NAME_PATTERN = /^Scout_(?:AU|US|NL|CA|UK|DE|FR|IT|ES|PL|MX|BR)_(?:全部候选产品|已初审产品|合格初筛产品)_\d{8}_\d{6}\.xlsx$/u;
const HANDOFF_FILE_NAME_PATTERN = /^Scout_(?:AU|US|NL|CA|UK|DE|FR|IT|ES|PL|MX|BR)_(?:初筛交接包|已初审产品交接包|已初审产品交接草稿)_\d{8}_\d{6}\.json$/u;
const MAX_COLLISION_ATTEMPTS = 999;

export class ExportFileStoreError extends Error {
  constructor(code, message, status = 500) {
    super(message);
    this.name = "ExportFileStoreError";
    this.code = code;
    this.status = status;
  }
}

export async function saveExportWorkbook(input = {}) {
  return saveExportDocument(input, normalizeExportFileName);
}

export async function saveExportHandoff({ document, fileName, directory } = {}) {
  if (!document || typeof document !== "object" || Array.isArray(document)
    || document.package_type !== "analysis_to_procurement" || typeof document.schema_version !== "string"
    || !document.schema_version || typeof document.package_id !== "string" || !document.package_id.trim()
    || typeof document.batch_id !== "string" || !document.batch_id.trim()
    || !Array.isArray(document.products) || !document.products.length
    || document.products.some((product) => !product || typeof product !== "object" || Array.isArray(product)
      || typeof product.product_id !== "string" || !product.product_id.trim() || product.analysis_review_status !== "approved")
    || !hasValidManualSelection(document) || !hasValidHandoffReadiness(document)) {
    throw new ExportFileStoreError("INVALID_EXPORT_HANDOFF", "交接包为空、人工初审范围不一致或格式无效，未执行保存。", 422);
  }
  let serialized;
  try {
    serialized = JSON.stringify(document, null, 2);
    if (typeof serialized !== "string" || !serialized.startsWith("{")) throw new TypeError("Invalid JSON document");
  } catch {
    throw new ExportFileStoreError("INVALID_EXPORT_HANDOFF", "交接包不能转换为有效 JSON，未执行保存。", 422);
  }
  const buffer = Buffer.from(`${serialized}\n`, "utf8");
  return saveExportDocument({ buffer, fileName, directory }, (value) => normalizeExportFileName(value, HANDOFF_FILE_NAME_PATTERN));
}

function hasValidManualSelection(document) {
  const selection = document.manual_selection, ids = document.products.map((product) => product.product_id);
  return selection?.method === "manual_analysis_review" && selection.source_field === "reviewStatus"
    && selection.required_value === "approved" && selection.scope_only === true && selection.business_approval === false
    && selection.automatic_rules_control_selection === false && selection.selected_count === ids.length
    && new Set(ids).size === ids.length && Array.isArray(selection.product_ids) && selection.product_ids.length === ids.length
    && selection.product_ids.every((id, index) => id === ids[index]);
}

function hasValidHandoffReadiness(document) {
  const readiness = document.readiness;
  if (!readiness || readiness.requires_consumer_validation !== true || readiness.consumer_import_compatibility !== "not_verified"
    || !Array.isArray(readiness.products) || readiness.products.length !== document.products.length) return false;
  let draftCount = 0;
  for (let index = 0; index < document.products.length; index += 1) {
    const product = document.products[index], assessment = readiness.products[index];
    if (!["pass", "excluded", "pending"].includes(product.filter?.decision)) return false;
    const draft = product.filter.decision !== "pass" || !product.preliminary_profit?.result
      || Boolean(product.preliminary_profit?.missing_inputs?.length) || Boolean(product.missing_fields?.length)
      || Boolean(product.filter.reasons?.length);
    if (!assessment || assessment.product_id !== product.product_id
      || assessment.status !== (draft ? "draft" : "ready_for_procurement_review") || !Array.isArray(assessment.reasons)) return false;
    if (draft) draftCount += 1;
  }
  return readiness.draft === (draftCount > 0) && readiness.draft_count === draftCount
    && readiness.ready_count === document.products.length - draftCount
    && readiness.status === (draftCount ? "draft" : "ready_for_procurement_review");
}

async function saveExportDocument({
  buffer,
  fileName,
  directory = DEFAULT_EXPORT_DIRECTORY,
} = {}, normalizeFileName) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new ExportFileStoreError("INVALID_EXPORT_WORKBOOK", "生成的 Excel 文件为空，未执行保存。", 500);
  }
  const normalizedFileName = normalizeFileName(fileName);
  if (typeof directory !== "string" || !directory.trim()) {
    throw new ExportFileStoreError("INVALID_EXPORT_DIRECTORY", "Excel 导出目录无效。", 500);
  }
  const resolvedDirectory = path.resolve(directory);
  const temporaryPath = path.join(
    resolvedDirectory,
    `.${normalizedFileName}.${process.pid}.${Date.now()}.${randomBytes(8).toString("hex")}.tmp`,
  );
  let temporaryHandle = null;

  try {
    try {
      await mkdir(resolvedDirectory, { recursive: true });
    } catch (error) {
      const existing = await lstat(resolvedDirectory).catch(() => null);
      if (existing && (!existing.isDirectory() || existing.isSymbolicLink())) {
        throw new ExportFileStoreError(
          "INVALID_EXPORT_DIRECTORY",
          `Excel 导出位置 ${resolvedDirectory} 必须是真实目录，不能是文件、符号链接或联接点。`,
          500,
        );
      }
      throw error;
    }
    const directoryStats = await lstat(resolvedDirectory);
    if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink()) {
      throw new ExportFileStoreError(
        "INVALID_EXPORT_DIRECTORY",
        `Excel 导出位置 ${resolvedDirectory} 必须是真实目录，不能是文件、符号链接或联接点。`,
        500,
      );
    }

    temporaryHandle = await open(temporaryPath, "wx", 0o600);
    await temporaryHandle.writeFile(buffer);
    await temporaryHandle.sync();
    await temporaryHandle.close();
    temporaryHandle = null;

    const extension = path.extname(normalizedFileName);
    const stem = normalizedFileName.slice(0, -extension.length);
    for (let attempt = 1; attempt <= MAX_COLLISION_ATTEMPTS; attempt += 1) {
      const candidateName = attempt === 1 ? normalizedFileName : `${stem}_${attempt}${extension}`;
      const candidatePath = path.join(resolvedDirectory, candidateName);
      try {
        // Publishing a hard link exposes only the already-synced complete file and never overwrites a collision.
        await link(temporaryPath, candidatePath);
        return { directory: resolvedDirectory, fileName: candidateName, filePath: candidatePath };
      } catch (error) {
        if (error?.code === "EEXIST") continue;
        throw error;
      }
    }
  } catch (error) {
    if (error instanceof ExportFileStoreError) throw error;
    throw new ExportFileStoreError(
      "EXPORT_SAVE_FAILED",
      `Excel 已生成，但无法保存到 ${resolvedDirectory}。请确认该目录可写后重试。`,
      500,
    );
  } finally {
    await temporaryHandle?.close().catch(() => {});
    await unlink(temporaryPath).catch((error) => {
      if (error?.code !== "ENOENT") {
        // Cleanup failure must not hide the original save result or error.
      }
    });
  }

  throw new ExportFileStoreError(
    "EXPORT_NAME_COLLISION_LIMIT",
    `目录 ${resolvedDirectory} 中同名导出文件过多，请整理后重试。`,
    409,
  );
}

export function normalizeExportFileName(value, pattern = EXPORT_FILE_NAME_PATTERN) {
  const fileName = typeof value === "string" ? value.normalize("NFC") : "";
  if (
    !fileName
    || fileName !== value
    || fileName !== fileName.trim()
    || fileName.length > 128
    || path.posix.basename(fileName) !== fileName
    || path.win32.basename(fileName) !== fileName
    || !pattern.test(fileName)
  ) {
    throw new ExportFileStoreError("INVALID_EXPORT_FILE_NAME", "导出文件名无效。", 400);
  }
  return fileName;
}
