import { normalizeReviewRange, reviewRangeExclusionReasons, intersectReviewRanges } from "./lib/review-range.mjs";
import { OPERATIONS_MISSING, normalizeSupplierChoiceUrl, chosenSupplierUrl, operationsColumnHeaders, operationsColumnValues } from "./lib/operations-export.mjs";
import { monthlySalesValue, monthlySalesEvidence, hasQualifyingMonthlySales, summarizeMonthlySalesCoverage, isMonthlySalesFilterRequired } from "./lib/monthly-sales-policy.mjs";
import { normalizeISODateOnly, todayDateOnly, matchesAmazonListingDate } from "./lib/amazon-listing-date.mjs";
import {
  DEFAULT_PROFIT_RATES,
  DOMESTIC_FREIGHT_RATE_RANGE_CNY_PER_KG,
  PROFIT_FORMULA_VERSION,
  calculateProductProfit,
  applyMissingWeightProfitAssumption,
  hasInvalidProductWeight,
  estimateAu2026FbaFeeByProductWeight,
  estimateCa2026FbaFeeByProductWeight,
  estimateUs2023FbaFeeByProductWeight,
  isAmazonWeightUnavailable,
  resolveManualWeightOverride,
  usesItemWeightOnly,
  automaticProfitWeightKg,
  resolveProductDimensionsCm, parseProductDimensionsCm, hasAnyProductShippingSpecification, estimateFbaByAvailableSpecifications, marketDimensionalWeightKg, fbaSelectionExplanation,
  automaticProductWeightKg,
  automaticPackageWeightKg,
  profitWeightSourceLabel,
  hasManualFulfillmentFee,
  estimateMinimumFbaFee,
} from "./lib/profit-model.mjs";
import {
  TITLE_PIECE_COUNT_RULE_VERSION,
  calculatePieceAdjustedPurchaseCostCny,
  extractTitlePieceCount,
  normalizePieceCount,
} from "./lib/title-piece-count.mjs";
import { selectManuallyReviewedProducts } from "./lib/analysis-handoff.mjs";
import { summarizeAnalysisCoverage } from "./lib/analysis-coverage.mjs";
import {
  amazonDetailPauseMessage,
  decideAmazonDetailRetry,
} from "./lib/amazon-detail-retry.mjs";
import {
  AMAZON_PRICE_PARSER_VERSION,
  candidateCurrentPrice,
  hasFailedAmazonDetailAttempt,
  hasManualAmazonPrice,
  invalidateLegacyAmazonPrice,
  isAmazonPagePrice,
  mergeAmazonDetailAudit,
  mergeAmazonPriceState,
} from "./lib/amazon-price-state.mjs";

(() => {
  "use strict";

  const COMPETITOR_PRICE_RATIO = 1;
  const APP_VERSION = "0.9.72";
  const EXPORT_DIRECTORY_LABEL = "本机导出目录";
  const FBA_WEIGHT_STANDARD_SIZE_POLICY = "large";
  const AU_FBA_ENVELOPE_SIZE_POLICY = "standard";
  const AMAZON_STORE_BATCH_SIZE = 20;
  const AMAZON_DETAIL_BATCH_SIZE = 20;
  const AMAZON_RETRY_FALLBACK_MS = 15_000;
  const AMAZON_DETAIL_PARSER_VERSION = AMAZON_PRICE_PARSER_VERSION;
  const MAX_FINAL_CANDIDATES_PER_STORE = 500;
  const RESULTS_PAGE_SIZE = 100;
  const REQUIRED_1688_QUOTES = 10;
  const INCLUDED_1688_QUOTES = 6;
  const SUPPLIER_PROFIT_THRESHOLD = 0.85;
  const MIN_IMAGE_SIMILARITY_SCORE = 0.5;
  const IMAGE_SIMILARITY_OPERATOR = "gt";
  const SUPPLIER_RULE_VERSION = "1688-image-only-always-top6-trimmed-10-v6";
  const SUPPLIER_COST_MODE_VERIFIED = "verified_trimmed_10";
  const SUPPLIER_COST_MODE_FALLBACK = "low_confidence_top_6";
  const MARKET_CONFIGS = Object.freeze({
    NL: Object.freeze({
      code: "NL",
      marketplaceId: "A1805IZSGTT6HS",
      amazonDomain: "www.amazon.nl",
      locale: "nl-NL",
      currency: "EUR",
      nameZh: "荷兰站",
      eyebrow: "AMAZON NETHERLANDS",
      defaultExchangeRate: 7.85,
      deliveryRegion: null,
      enabled: true,
    }),
    AU: Object.freeze({
      code: "AU",
      marketplaceId: "A39IBJ37TRP1C6",
      amazonDomain: "www.amazon.com.au",
      locale: "en-AU",
      currency: "AUD",
      nameZh: "澳大利亚站",
      eyebrow: "AMAZON AUSTRALIA",
      defaultExchangeRate: 4.8,
      defaultAirFreightRateCnyPerKg: 45,
      defaultCommissionRate: 11,
      defaultManagementRate: 6,
      defaultReturnsRate: 4,
      airFreightActualWeightOnly: true,
      deliveryRegion: "墨尔本 3010",
      enabled: true,
    }),
    US: Object.freeze({
      code: "US",
      marketplaceId: "ATVPDKIKX0DER",
      amazonDomain: "www.amazon.com",
      locale: "en-US",
      currency: "USD",
      nameZh: "美国站",
      eyebrow: "AMAZON UNITED STATES",
      defaultExchangeRate: 7.12,
      deliveryRegion: "纽约 10001",
      enabled: true,
    }),
    CA: Object.freeze({
      code: "CA",
      marketplaceId: "A2EUQ1WTGCTBG2",
      amazonDomain: "www.amazon.ca",
      locale: "en-CA",
      currency: "CAD",
      nameZh: "加拿大站",
      eyebrow: "AMAZON CANADA",
      defaultExchangeRate: 5.2,
      defaultAirFreightRateCnyPerKg: 45,
      defaultReturnsRate: 4,
      deliveryRegion: "多伦多 M5V 2T6",
      enabled: true,
    }),
    UK: Object.freeze({
      code: "UK",
      marketplaceId: "A1F83G8C2ARO7P",
      amazonDomain: "www.amazon.co.uk",
      locale: "en-GB",
      currency: "GBP",
      nameZh: "英国站",
      eyebrow: "AMAZON UNITED KINGDOM",
      defaultExchangeRate: 9.6,
      deliveryRegion: "伦敦 EC1A 1BB",
      enabled: true,
    }),
    DE: Object.freeze({
      code: "DE",
      marketplaceId: "A1PA6795UKMFR9",
      amazonDomain: "www.amazon.de",
      locale: "de-DE",
      currency: "EUR",
      nameZh: "德国站",
      eyebrow: "AMAZON GERMANY",
      defaultExchangeRate: 7.85,
      deliveryRegion: "柏林 10115",
      enabled: true,
    }),
    FR: Object.freeze({
      code: "FR",
      marketplaceId: "A13V1IB3VIYZZH",
      amazonDomain: "www.amazon.fr",
      locale: "fr-FR",
      currency: "EUR",
      nameZh: "法国站",
      eyebrow: "AMAZON FRANCE",
      defaultExchangeRate: 7.85,
      deliveryRegion: "巴黎 75001",
      enabled: true,
    }),
    IT: Object.freeze({
      code: "IT",
      marketplaceId: "APJ6JRA9NG5V4",
      amazonDomain: "www.amazon.it",
      locale: "it-IT",
      currency: "EUR",
      nameZh: "意大利站",
      eyebrow: "AMAZON ITALY",
      defaultExchangeRate: 7.85,
      deliveryRegion: "米兰 20121",
      enabled: true,
    }),
    ES: Object.freeze({
      code: "ES",
      marketplaceId: "A1RKKUPIHCS9HS",
      amazonDomain: "www.amazon.es",
      locale: "es-ES",
      currency: "EUR",
      nameZh: "西班牙站",
      eyebrow: "AMAZON SPAIN",
      defaultExchangeRate: 7.85,
      deliveryRegion: "马德里 28001",
      enabled: true,
    }),
    PL: Object.freeze({
      code: "PL",
      marketplaceId: "A1C3SOZRARQ6R3",
      amazonDomain: "www.amazon.pl",
      locale: "pl-PL",
      currency: "PLN",
      nameZh: "波兰站",
      eyebrow: "AMAZON POLAND",
      defaultExchangeRate: 1.85,
      deliveryRegion: "华沙 00-001",
      enabled: true,
    }),
    MX: Object.freeze({
      code: "MX",
      marketplaceId: "A1AM78C64UM0Y8",
      amazonDomain: "www.amazon.com.mx",
      locale: "es-MX",
      currency: "MXN",
      nameZh: "墨西哥站",
      eyebrow: "AMAZON MEXICO",
      defaultExchangeRate: 0.42,
      deliveryRegion: "墨西哥城 06600",
      enabled: true,
    }),
    BR: Object.freeze({
      code: "BR",
      marketplaceId: "A2Q3Y263D00KWC",
      amazonDomain: "www.amazon.com.br",
      locale: "pt-BR",
      currency: "BRL",
      nameZh: "巴西站",
      eyebrow: "AMAZON BRAZIL",
      defaultExchangeRate: 1.35,
      deliveryRegion: "圣保罗 01310-100",
      enabled: true,
    }),
  });
  let activeMarket = MARKET_CONFIGS.NL;
  const VIEW_TITLES = {
    task: "新建找品任务",
    results: "候选商品",
    history: "任务记录",
  };
  const REVIEW_LABELS = {
    pending: "待初审",
    approved: "已通过",
    rejected: "已淘汰",
    rematch: "待重匹配",
  };
  const SUPPLIER_NAMES = [
    "Shenzhen Homewise Co.",
    "Ningbo Wellmade Factory",
    "Yiwu Bright Living Ltd.",
    "Guangzhou Daily Goods Co.",
    "Dongguan Simpleworks Ltd.",
    "Xiamen Field Supply Co.",
    "Hangzhou Newday Trading",
    "Foshan Easehome Factory",
    "Jinhua Origin Products",
    "Suzhou Practical Life Co.",
  ];

  const FALLBACK_PRODUCT_SEED = [
    {
      id: "au-001",
      asin: "B0C8AU4L21",
      name: "硅胶空气炸锅内衬 2 件套",
      englishName: "Reusable Silicone Air Fryer Liners, 2 Pack",
      sellerId: "A3HOMENESTAU9",
      storeName: "HomeNest AU",
      price30: 34.95,
      sales30: 286,
      sales60: 603,
      purchaseCost: 25.4,
      fbaFee: 4.8,
      billingWeight: 0.35,
      productWeight: 0.31,
      fbaWeight: 0.35,
      productDimensions: "20 × 20 × 7 cm",
      fbaDimensions: "21 × 21 × 8 cm",
      parameterSource: "FBA 包装参数",
      firstFba: "2024-02-18",
      rating: 4.5,
      reviews: 684,
      moq: 100,
      risk: "低风险",
      visualIcon: "cooking-pot",
      visualTone: "visual-coral",
      hasAPlus: true,
      missing: [],
    },
    {
      id: "au-002",
      asin: "B0CJ7R2A6M",
      name: "可伸缩竹制抽屉分隔板 4 件套",
      englishName: "Expandable Bamboo Drawer Dividers, 4 Pack",
      sellerId: "A1ORGANISE88AU",
      storeName: "Orderly Living",
      price30: 54.9,
      sales30: 132,
      sales60: 281,
      purchaseCost: 30.8,
      fbaFee: 6.1,
      billingWeight: 0.55,
      productWeight: 0.48,
      fbaWeight: 0.55,
      productDimensions: "43 × 6 × 1.5 cm",
      fbaDimensions: "45 × 14 × 7 cm",
      parameterSource: "FBA 包装参数",
      firstFba: "2023-11-06",
      rating: 4.4,
      reviews: 319,
      moq: 50,
      risk: "低风险",
      visualIcon: "panel-top",
      visualTone: "visual-mint",
      hasAPlus: true,
      missing: [],
    },
    {
      id: "au-003",
      asin: "B0D1K9AU73",
      name: "宠物慢食舔食垫 3 件套",
      englishName: "Pet Lick Mats with Suction Cups, 3 Pack",
      sellerId: "A2PAWKIND77AU",
      storeName: "PawKind Direct",
      price30: 29.99,
      sales30: 418,
      sales60: 847,
      purchaseCost: 18.2,
      fbaFee: 4.1,
      billingWeight: 0.28,
      productWeight: 0.24,
      fbaWeight: 0.28,
      productDimensions: "20 × 20 × 0.8 cm",
      fbaDimensions: "21 × 21 × 3 cm",
      parameterSource: "FBA 包装参数",
      firstFba: "2024-05-23",
      rating: 4.6,
      reviews: 942,
      moq: 100,
      risk: "低风险",
      visualIcon: "bone",
      visualTone: "visual-yellow",
      hasAPlus: false,
      missing: [],
    },
    {
      id: "au-004",
      asin: "B0BZ5F8Q2P",
      name: "旅行收纳袋 8 件套",
      englishName: "Compression Packing Cubes for Travel, 8 Set",
      sellerId: "A3HOMENESTAU9",
      storeName: "HomeNest AU",
      price30: 42.95,
      sales30: 207,
      sales60: 459,
      purchaseCost: 31.2,
      fbaFee: 5.0,
      billingWeight: 0.48,
      productWeight: 0.44,
      fbaWeight: 0.48,
      productDimensions: "40 × 30 × 10 cm",
      fbaDimensions: "32 × 25 × 8 cm",
      parameterSource: "FBA 包装参数",
      firstFba: "2023-08-14",
      rating: 4.3,
      reviews: 1217,
      moq: 100,
      risk: "低风险",
      visualIcon: "luggage",
      visualTone: "visual-blue",
      hasAPlus: true,
      missing: [],
    },
    {
      id: "au-005",
      asin: "B0CQ2V7N5K",
      name: "磁吸调味料置物架 2 件套",
      englishName: "Magnetic Spice Rack for Fridge, 2 Pack",
      sellerId: "A2KITCHENLAB9",
      storeName: "KitchenLab AU",
      price30: 59.99,
      sales30: 76,
      sales60: 169,
      purchaseCost: 48.0,
      fbaFee: 7.3,
      billingWeight: 1.05,
      productWeight: 0.93,
      fbaWeight: 1.05,
      productDimensions: "30 × 12 × 8 cm",
      fbaDimensions: "33 × 27 × 10 cm",
      parameterSource: "FBA 包装参数",
      firstFba: "2024-01-09",
      rating: 4.2,
      reviews: 186,
      moq: 50,
      risk: "重量成本敏感",
      visualIcon: "package-open",
      visualTone: "visual-red",
      hasAPlus: false,
      missing: [],
    },
    {
      id: "au-006",
      asin: "B0D4M2Q8RX",
      name: "充电式手持奶泡器",
      englishName: "USB Rechargeable Handheld Milk Frother",
      sellerId: "A2KITCHENLAB9",
      storeName: "KitchenLab AU",
      price30: 26.9,
      sales30: 191,
      sales60: 402,
      purchaseCost: 29.6,
      fbaFee: 4.25,
      billingWeight: null,
      productWeight: null,
      fbaWeight: null,
      productDimensions: "未知",
      fbaDimensions: "未知",
      parameterSource: "参数缺失",
      firstFba: "2024-06-03",
      rating: 4.1,
      reviews: 95,
      moq: 100,
      risk: "带电产品待排除",
      visualIcon: "blend",
      visualTone: "visual-purple",
      hasAPlus: true,
      missing: ["计费重量", "包装尺寸"],
    },
    {
      id: "au-007",
      asin: "B0CH8U3S6E",
      name: "双层水槽下方收纳架",
      englishName: "2 Tier Under Sink Organiser with Hooks",
      sellerId: "A1ORGANISE88AU",
      storeName: "Orderly Living",
      price30: 49.5,
      sales30: 114,
      sales60: 247,
      purchaseCost: 39.4,
      fbaFee: 6.75,
      billingWeight: 0.92,
      productWeight: 0.92,
      fbaWeight: null,
      productDimensions: "40 × 22 × 34 cm",
      fbaDimensions: "未知",
      parameterSource: "商品参数回退",
      firstFba: null,
      rating: 4.3,
      reviews: 211,
      moq: 50,
      risk: "供应商样本不足",
      visualIcon: "layers-3",
      visualTone: "visual-teal",
      hasAPlus: false,
      supplierAvailable: 6,
      missing: ["供应商样本不足"],
    },
    {
      id: "au-008",
      asin: "B0D2P6W4LT",
      name: "布艺阻力带 5 条套装",
      englishName: "Fabric Resistance Bands Set of 5",
      sellerId: "A2PAWKIND77AU",
      storeName: "PawKind Direct",
      price30: 32.99,
      sales30: 339,
      sales60: 720,
      purchaseCost: 21.5,
      fbaFee: null,
      billingWeight: 0.46,
      productWeight: 0.41,
      fbaWeight: 0.46,
      productDimensions: "36 × 8 cm",
      fbaDimensions: "24 × 18 × 8 cm",
      parameterSource: "FBA 包装参数",
      firstFba: "2024-03-27",
      rating: 4.5,
      reviews: 527,
      moq: 100,
      risk: "低风险",
      visualIcon: "dumbbell",
      visualTone: "visual-pink",
      hasAPlus: true,
      missing: [],
    },
  ];

  let taskExchangeRate = activeMarket.defaultExchangeRate;
  let products = [];
  let selectedStoreFile = null;
  let storeList = null;
  let importMode = "stores";
  let asinImportPreview = null;
  let failedImportFileDraft = null;
  let asinPreviewPromise = null;
  let asinPreviewGeneration = 0;
  let storeLoadGeneration = 0;
  let storeParseController = null;
  let storeImportPending = false;
  let taskReplacementPending = false;
  let taskContextGeneration = 0;
  let sellerSpriteStatus = "idle";
  let sellerSpriteCallCount = null;
  let sellerSpriteSessionCallCount = null;
  let sellerSpriteCheckPromise = null;
  let sellerSpriteConfiguration = null;
  let sellerSpriteCapabilities = null;
  let localMonitorState = null;
  let localMonitorPromise = null;
  let amazonConnectionChecks = {};
  let amazonCheckPromise = null;
  let amazonCheckController = null;
  let supplier1688Status = "idle";
  let supplier1688LoggedIn = false;
  let supplier1688WindowOpen = false;
  let supplier1688WindowPollTimer = null;
  let supplier1688Auth = null;
  let supplier1688RuntimeQueue = {};
  let supplier1688ImageSearchRecovery = null;
  let supplier1688Queue = {};
  let supplier1688RiskTask = null;
  let supplier1688RiskTaskScope = null;
  let supplier1688SessionPromise = null;
  let supplier1688ResumePromise = null;
  let supplier1688ResumeController = null;
  let supplier1688SelectionPending = false;
  let supplier1688ResumeRequested = false;
  let supplier1688StatusRequestId = 0;
  let currentRunController = null;
  let runState = createIdleRunState();
  let activeProductId = null;
  let activeRunCriteria = {};
  let currentVisibleProducts = [];
  let resultPage = 1;
  let analysisRunning = false;
  let exportRunning = false;
  const analysisHandoffPendingIds = new Set();
  const analysisVersionPendingIds = new Set();
  let toastTimer = null;
  let drawerFbaTouched = false;
  let drawerPurchaseInput = "unit";
  let drawerProfitSaveVersion = 0;
  let drawerProfitDraft = null;
  let drawerProfitBaseline = null;
  let profitEditorPendingSaves = 0;
  let profitEditorPersistenceEpoch = 0;
  let profitEditorSnapshotDeferred = false;
  const supplierChoiceDrafts = new Map();
  const supplierChoiceSaves = new Map();
  const PROFIT_EDITOR_INPUT_IDS = ["editSalePrice", "editPurchaseCost", "editPieceCount", "editPurchaseTotal", "editFbaFee", "editWeight"];
  let profitAutoCommitTimer = null;
  let lastFocusedElement = null;
  let drawerReturnPosition = null;
  let drawerTransitionId = 0;
  let lastDialogFocusedElement = null;
  let lastManualCostFocusedElement = null;
  let manualCostDraft = null;
  let runHistory = [];
  let persistenceSaveQueue = Promise.resolve();
  let persistenceErrorShown = false;
  let persistenceLastError = null;
  let amazonCollectionJob = null;
  let amazonCollectionRevision = null;
  let amazonCollectionStatusKnown = false;
  let amazonCollectionPollTimer = null;
  let amazonCollectionPollPromise = null;
  let amazonCollectionSnapshotPromise = null;
  let amazonCollectionControlPromise = null;
  let amazonCollectionControlPending = false;
  let amazonAccessRecoveryIdentity = "";
  let amazonCollectionRefreshError = null;
  let supplierCollectionTransition = false;
  let supplierPipelineState = null;
  let snapshotEvents = null;
  let snapshotRefreshPending = false;

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const byId = (id) => document.getElementById(id);

  document.addEventListener("DOMContentLoaded", init);

  async function init() {
    bindMarketplace();
    renderMarketUi();
    bindNavigation();
    bindAmazonConnection();
    bindFileImport();
    bind1688Session();
    bindStoreManager();
    bindSetupFilters();
    bindResults();
    bindDrawer();
    bindManualCostDialog();
    bindDialogs();
    bindHistory();
    bindAmazonCollection();
    renderResults();
    initIcons();
    setConnectionState("idle", "未启用 · Amazon 可用");
    setDataMode("idle", "Amazon 官网");
    updateStartAvailability();
    await loadAmazonCollectionStatus().catch(() => {});
    const [, persistedState] = await Promise.allSettled([loadRuntimeStatus(), loadPersistentWorkspace(), load1688SessionStatus(), loadSellerSpriteConfiguration()]);
    restorePending1688RiskStatus();
    if ((persistedState.status !== "fulfilled" || !persistedState.value) && storeLoadGeneration === 0 && !storeImportPending) await loadDefaultStoreList();
    startHeartbeat();
    startSnapshotEvents();
    await loadSupplierPipelineStatus().catch(() => {});
    scheduleAmazonCollectionPoll();
  }

  function startSnapshotEvents() {
    if (snapshotEvents || typeof window.EventSource !== "function") return;
    snapshotEvents = new window.EventSource('/api/events');
    snapshotEvents.onmessage = (event) => {
      try {
        const update = JSON.parse(event.data);
        if (taskReplacementPending || update.runId !== runState.id) return;
        if (supplier1688ResumePromise && runState.supplier1688Pipeline?.owner !== 'server') return;
        if (applyAmazonProductUpdate(update)) return;
        snapshotRefreshPending = true;
        void flushSnapshotUpdate();
      } catch { /* The regular status poll also catches up after reconnects. */ }
    };
  }

  function applyAmazonProductUpdate(update) {
    if (update?.kind !== "amazon_product") return false;
    // Product events use the Amazon revision; supplier events have an independent revision.
    if (runState.archivedAt || update.runId !== runState.id) return true;
    if (Number.isSafeInteger(update.revision) && Number.isSafeInteger(amazonCollectionRevision)
      && update.revision <= amazonCollectionRevision) return true;
    if (taskReplacementPending || amazonCollectionSnapshotPromise || snapshotRefreshPending
      || profitEditorPendingSaves || profitAutoCommitTimer !== null
      || isCurrentProfitEditorDraft(drawerProfitDraft) || (manualCostDraft && isManualCostDirty())
      || update.formulaVersion !== PROFIT_FORMULA_VERSION
      || !Number.isSafeInteger(update.baseRevision) || !Number.isSafeInteger(update.revision)
      || update.revision <= update.baseRevision || amazonCollectionRevision !== update.baseRevision
      || update.job?.owner !== "server" || update.job.runId !== runState.id
      || update.job.revision !== update.revision || !Array.isArray(update.products) || !update.products.length) return false;
    // A draft can exist before its debounce callback has recorded it.
    if (drawerProfitBaseline) {
      const pendingDraft = captureProfitEditorDraft();
      if (pendingDraft) { drawerProfitDraft = pendingDraft; return false; }
    }
    const replacements = new Map(update.products.map((product) => [product?.id, product]));
    if (replacements.size !== update.products.length || replacements.has(undefined)
      || update.products.some((product) => !products.some((existing) => existing.id === product.id))) return false;
    const scroll = [$(".view-stack"), $(".drawer-content")].filter(Boolean)
      .map((element) => ({ element, top: element.scrollTop, left: element.scrollLeft }));
    // Canonical products already include server-calculated fees and profit. Keep untouched objects intact.
    products = products.map((product) => replacements.get(product.id) || product);
    amazonCollectionRevision = update.revision;
    runState.amazonCollectionRevision = update.revision;
    if (update.runState && Object.hasOwn(update.runState, "mode")) runState.mode = update.runState.mode;
    if (update.runState && Object.hasOwn(update.runState, "completedAt")) runState.completedAt = update.runState.completedAt;
    applyAmazonCollectionJob(update.job);
    if (replacements.has(activeProductId)) populateDrawer(replacements.get(activeProductId));
    renderResults();
    scroll.forEach(({ element, top, left }) => { element.scrollTop = top; element.scrollLeft = left; });
    return true;
  }

  async function flushSnapshotUpdate() {
    if (taskReplacementPending || amazonCollectionSnapshotPromise || !snapshotRefreshPending) return;
    snapshotRefreshPending = false;
    try { await refreshAmazonCollectionSnapshot(); }
    catch { /* Retain current data; the next status poll retries. */ }
    finally { if (snapshotRefreshPending) void flushSnapshotUpdate(); }
  }

  async function loadSupplierPipelineStatus() {
    const generation = taskContextGeneration;
    const state = await apiRequest('/api/1688/pipeline', { timeout: 15000 });
    if (taskReplacementPending || generation !== taskContextGeneration) return supplierPipelineState;
    supplierPipelineState = state;
    if (supplierPipelineState?.runId === runState.id
      && supplierPipelineState.revision !== runState.supplier1688Pipeline?.revision) await refreshAmazonCollectionSnapshot();
    renderSupplier1688Stage();
    return supplierPipelineState;
  }

  const pendingTaskControls = new Map();
  const uncertainTaskControls = new Map();

  function interruptedControlResponse(error) {
    return ['REQUEST_TIMEOUT', 'NETWORK_ERROR', 'ECONNRESET', 'ECONNREFUSED', 'HTTP_502', 'HTTP_503', 'HTTP_504'].includes(error?.code)
      || error?.name === 'TypeError' || error?.name === 'AbortError'
      || /failed to fetch|networkerror|network request failed|connection (?:closed|reset)/i.test(error?.message || '');
  }

  function taskControlConfirmed(kind, payload, state, before) {
    if (!state || state.runId !== payload.runId) return false;
    const advanced = Number.isFinite(Number(before?.revision)) && Number(state.revision) > Number(before.revision);
    const active = ['queued', 'running', 'cooldown'].includes(state.status) && state.enabled !== false;
    if (kind === 'amazon') {
      if (payload.action === 'pause') return state.status === 'paused' && state.enabled === false && state.causeCode === 'USER_PAUSED';
      if (payload.action === 'pause_for_supplier') return state.workerActive === false && ['paused', 'completed', 'needs_attention'].includes(state.status);
      if (payload.action === 'retry_missing') return advanced && (active || state.status === 'completed');
      if (payload.action === 'resume_after_supplier' && before?.causeCode !== 'SUPPLIER_MATCHING') {
        return state.status === before?.status && state.causeCode === before?.causeCode && state.workerActive === false;
      }
      return active || (state.status === 'completed' && advanced);
    }
    if (payload.action === 'pause') return state.status === 'paused' && state.enabled === false;
    if (payload.action === 'append') return advanced && payload.productIds.every(id => state.productIds?.includes(id));
    if (payload.action === 'select_archived') return (!before || advanced)
      && state.authorizedArchivedAt === payload.archivedAt && payload.productIds.every(id => state.productIds?.includes(id));
    return active || (state.status === 'complete' && advanced);
  }

  function requestTaskControl(kind, payload, { timeout = 30000, before } = {}) {
    const base = kind === 'amazon' ? '/api/amazon/collection' : '/api/1688/pipeline';
    const key = JSON.stringify([kind, payload.runId, payload.action, [...(payload.productIds || [])].sort(), payload.asins || [], payload.archivedAt, payload.rematch]);
    if (pendingTaskControls.has(key)) return pendingTaskControls.get(key);
    const pending = (async () => {
      const saved = uncertainTaskControls.get(key);
      const original = saved?.before || before || (kind === 'amazon' ? currentAmazonCollectionJob() : runState.supplier1688Pipeline);
      const previous = original ? structuredClone(original) : null;
      if (!saved) {
        try {
          return await apiRequest(`${base}/control`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), timeout });
        } catch (error) {
          if (!interruptedControlResponse(error)) throw error;
          uncertainTaskControls.set(key, { before: previous ? structuredClone(previous) : null });
        }
      }
      // A lost response does not prove a failed command. Read once and never
      // replay a mutation while its outcome is unknown, including another click.
      try {
        const state = await apiRequest(base, { timeout: 15000 });
        if (taskControlConfirmed(kind, payload, state, previous)) {
          uncertainTaskControls.delete(key);
          return state;
        }
      } catch { /* Keep the original uncertain outcome; the next poll is read-only. */ }
      throw createRunError('CONTROL_OUTCOME_UNKNOWN', '操作结果待确认：请求已发出，但尚未确认后台状态；请稍后查看进度，勿重复提交。');
    })().finally(() => pendingTaskControls.delete(key));
    pendingTaskControls.set(key, pending);
    return pending;
  }

  async function refreshAfterTaskControl(label) {
    try { await refreshAmazonCollectionSnapshot(); return true; }
    catch {
      showToast(`${label}已确认，页面进度待同步；当前结果保留，请等待状态刷新。`, 'info', 6500);
      return false;
    }
  }

  function applySupplierPipelineState(state, runId = runState.id) {
    if (runState.id !== runId || state?.runId !== runId) return false;
    supplierPipelineState = state;
    runState.supplier1688Pipeline = state;
    renderSupplier1688Stage();
    return true;
  }

  function technical1688Pause(reason = supplier1688Queue?.ratePolicy?.pausedReason) {
    return ['SEARCH_TIMEOUT', 'SEARCH_WORKER_EXITED', 'SEARCH_WORKER_STOP_FAILED', 'SEARCH_INTERRUPTED'].includes(reason);
  }

  function supplierNoPendingMessage(pipeline = runState.supplier1688Pipeline) {
    const excluded = Number(pipeline?.excludedMonthlySalesCount || 0);
    return excluded > 0
      ? `当前没有可继续匹配的商品；${excluded} 个商品因缺少 Amazon 50+ 月购买量标识已跳过，已有结果保留。`
      : '当前没有可继续匹配的商品，已有结果和任务记录已保留。';
  }

  async function startServerSupplierPipeline() {
    if (storeImportPending || taskReplacementPending || (runState.archivedAt && !archivedSupplierMatchingEnabled())) return false;
    const runId = runState.id;
    if (!getPending1688ResumeProducts().length) {
      renderSupplier1688Stage();
      showToast(supplierNoPendingMessage(), 'info', 6200);
      return false;
    }
    try {
      supplierPipelineState = await requestTaskControl('supplier', { runId, action: 'resume' });
      if (runState.id !== runId) return false;
      applySupplierPipelineState(supplierPipelineState, runId);
      const snapshotSynced = await refreshAfterTaskControl('匹配控制');
      if (runState.id !== runId) return false;
      const latest = runState.supplier1688Pipeline || supplierPipelineState;
      renderSupplier1688Stage();
      if (latest?.status === 'complete' || Number(latest?.remaining) === 0) {
        showToast(supplierNoPendingMessage(latest), 'info', 6200);
        return false;
      }
      if (!['queued', 'running', 'cooldown'].includes(latest?.status) || latest.enabled === false) {
        showToast(latest?.message || '匹配仍处于暂停状态，断点已保留，请查看批次状态后继续。', 'info', 6200);
        return false;
      }
      if (snapshotSynced) showToast(latest.status === 'cooldown'
        ? '原批次正在冷却，断点已保留，冷却结束后后台会继续。'
        : '原批次已交给后台继续；每件商品取得报价后立即计算利润并更新列表。',
        latest.status === 'cooldown' ? 'info' : 'success', 6000);
      return true;
    } catch (error) {
      if (error.code === 'SUPPLIER_NO_PENDING_PRODUCTS') {
        if (runState.id === runId) await refreshAmazonCollectionSnapshot().catch(() => {});
        showToast(error.message, 'info', 6200);
        return false;
      }
      showToast(`匹配暂未继续：${error.message}`, 'error', 6000);
      return false;
    }
  }

  async function pauseServerSupplierPipeline() {
    const runId = runState.id;
    try {
      const state = await requestTaskControl('supplier', { runId, action: 'pause' });
      if (!applySupplierPipelineState(state, runId)) return;
      if (await refreshAfterTaskControl('匹配暂停')) showToast('已暂停后续匹配，当前已提交商品返回后会保存结果。', 'info', 5200);
    } catch (error) { showToast(error.message, error.code === 'CONTROL_OUTCOME_UNKNOWN' ? 'info' : 'error', 6200); }
  }

  function currentAmazonCollectionJob() {
    const saved = runState.amazonCollectionJob;
    return amazonCollectionJob?.runId === runState.id ? amazonCollectionJob
      : saved?.owner === "server" && (!saved.runId || saved.runId === runState.id) ? saved : null;
  }

  function isCollectionWriteLocked() {
    if (taskReplacementPending) return true;
    if (runState.supplier1688Pipeline?.owner === 'server'
      && (!runState.archivedAt || archivedSupplierMatchingEnabled())
      && (['queued', 'running', 'cooldown'].includes(runState.supplier1688Pipeline.status)
        || runState.supplier1688Pipeline.activeProductId)) return true;
    if (runState.archivedAt) return false;
    const job = currentAmazonCollectionJob();
    return Boolean(amazonCollectionControlPending || (job?.owner === "server"
      && (!['completed', 'paused', 'needs_attention'].includes(job.status) || job.workerActive === true)));
  }

  function hasOtherActiveCollection() {
    return Boolean(amazonCollectionJob?.owner === "server" && amazonCollectionJob.runId !== runState.id
      && !["completed", "cancelled"].includes(amazonCollectionJob.status));
  }

  function collectionWriteBlocked({ notify = true } = {}) {
    if (!isCollectionWriteLocked()) return false;
    if (notify) showToast("后台正在采集或匹配，可查看和筛选；暂停当前任务后可编辑和初审。", "info", 5000);
    return true;
  }

  function withKnownAmazonWorkerState(job, previous) {
    // Persisted snapshots and product events omit live worker state. Only an
    // explicit status value can release a lock observed for this same run.
    if (job?.owner !== "server" || typeof job.workerActive === "boolean" || !job.runId
      || previous?.runId !== job.runId || typeof previous.workerActive !== "boolean") return job;
    return { ...job, workerActive: previous.workerActive };
  }

  function applyAmazonCollectionJob(job) {
    amazonCollectionStatusKnown = true;
    const previous = amazonCollectionJob?.runId === job?.runId ? amazonCollectionJob : runState.amazonCollectionJob;
    amazonCollectionJob = job?.owner === "server" ? withKnownAmazonWorkerState(job, previous) : null;
    if (amazonCollectionJob?.runId === runState.id) runState.amazonCollectionJob = amazonCollectionJob;
    renderAmazonCollection();
    updateStartAvailability();
  }

  async function loadAmazonCollectionStatus() {
    const generation = taskContextGeneration;
    try {
      const job = await apiRequest("/api/amazon/collection", { timeout: 15000 });
      if (taskReplacementPending || generation !== taskContextGeneration) return amazonCollectionJob;
      amazonCollectionRefreshError = null;
      applyAmazonCollectionJob(job);
      return amazonCollectionJob;
    } catch (error) {
      amazonCollectionRefreshError = error.message;
      renderAmazonCollection();
      throw error;
    }
  }

  function scheduleAmazonCollectionPoll(delayMs = 5000) {
    if (amazonCollectionPollTimer !== null) window.clearTimeout(amazonCollectionPollTimer);
    amazonCollectionPollTimer = window.setTimeout(() => {
      amazonCollectionPollTimer = null;
      void pollAmazonCollection();
    }, delayMs);
  }

  async function pollAmazonCollection() {
    if (taskReplacementPending || supplierCollectionTransition) { scheduleAmazonCollectionPoll(); return; }
    if (amazonCollectionPollPromise) return amazonCollectionPollPromise;
    amazonCollectionPollPromise = (async () => {
      try {
        if (hasActive1688Work() && currentAmazonCollectionJob()?.causeCode === 'SUPPLIER_MATCHING') {
          await requestTaskControl('amazon', { runId: runState.id, action: 'pause_for_supplier' }, { timeout: 15000 });
        }
        const job = await loadAmazonCollectionStatus();
        if (job?.runId === runState.id && job.revision !== amazonCollectionRevision) await refreshAmazonCollectionSnapshot();
        await loadSupplierPipelineStatus();
      } catch { /* Keep the saved view and retry this status read, never restart collection. */ }
      finally { amazonCollectionPollPromise = null; scheduleAmazonCollectionPoll(); }
    })();
    return amazonCollectionPollPromise;
  }

  async function refreshAmazonCollectionSnapshot() {
    if (taskReplacementPending) return;
    const generation = taskContextGeneration;
    if (amazonCollectionSnapshotPromise) return amazonCollectionSnapshotPromise;
    const requestedRunId = runState.id;
    const requestedProfitEpoch = profitEditorPersistenceEpoch;
    if (!requestedRunId) return;
    amazonCollectionSnapshotPromise = (async () => {
      const snapshot = await apiRequest(`/api/runs/${encodeURIComponent(requestedRunId)}`, { timeout: 30000 });
      if (taskReplacementPending || generation !== taskContextGeneration || runState.id !== requestedRunId) return;
      // A read racing a profit save may still contain the old inputs. The next poll catches up.
      if (profitEditorPendingSaves || requestedProfitEpoch !== profitEditorPersistenceEpoch) {
        profitEditorSnapshotDeferred = true;
        return;
      }
      const view = {
        criteria: { ...activeRunCriteria }, page: resultPage, productId: activeProductId,
        profitDraft: isCurrentProfitEditorDraft(drawerProfitDraft) ? captureProfitEditorDraft() : null,
        filters: ["resultSearch", "resultMinMargin", "resultWeightBand", "resultsCompleteToggle", "monthlySalesBand", "minReviews", "maxReviews", "minRating", "amazonFirstAvailableFrom"].map((id) => {
          const input = byId(id); return { id, value: input?.value, checked: input?.checked };
        }),
        scroll: [$(".view-stack"), $(".drawer-content")].filter(Boolean).map((element) => ({ element, top: element.scrollTop, left: element.scrollLeft })),
      };
      restoreRunSnapshot(snapshot, { autoResume: false, persistMigrations: false });
      activeRunCriteria = view.criteria;
      resultPage = view.page;
      view.filters.forEach(({ id, value, checked }) => {
        const input = byId(id);
        if (input && value !== undefined) input.value = value;
        if (input && checked !== undefined) input.checked = checked;
      });
      if (view.productId && products.some((product) => product.id === view.productId)) {
        activeProductId = view.productId;
        populateDrawer(products.find((product) => product.id === activeProductId));
        restoreProfitEditorDraft(view.profitDraft);
      }
      renderResults();
      view.scroll.forEach(({ element, top, left }) => { element.scrollTop = top; element.scrollLeft = left; });
      renderAmazonCollection();
    })().finally(() => {
      amazonCollectionSnapshotPromise = null;
      flushDeferredProfitEditorSnapshot();
      // Events received during a poll-triggered snapshot must also get a fresh read.
      if (snapshotRefreshPending) void flushSnapshotUpdate();
    });
    return amazonCollectionSnapshotPromise;
  }

  function bindAmazonCollection() {
    byId("collectionAccessConfirmed")?.addEventListener("change", renderAmazonCollection);
    byId("collectionAccessResumeButton")?.addEventListener("click", () => {
      const job = currentAmazonCollectionJob();
      if (!byId("collectionAccessConfirmed")?.checked || !job || job.workerActive
        || job.status !== "needs_attention" || job.causeCode !== "AMAZON_ACCESS_CHALLENGE") return;
      return controlAmazonCollection("resume");
    });
    byId("collectionAccessProducts")?.addEventListener("click", async event => {
      const edge = event.target.closest("[data-amazon-url]");
      if (edge) { event.preventDefault(); await openAmazonLinkInEdge(edge); return; }
      const copy = event.target.closest("[data-copy-amazon-url]");
      if (!copy) return;
      try {
        await navigator.clipboard.writeText(copy.dataset.copyAmazonUrl);
        setText("collectionAccessFeedback", "原商品链接已复制。");
      } catch { setText("collectionAccessFeedback", "未能复制，请右键商品链接选择复制链接地址。"); }
    });
    byId("collectionPauseButton")?.addEventListener("click", () => void controlAmazonCollection("pause"));
    byId("collectionResumeButton")?.addEventListener("click", () => void controlAmazonCollection("resume"));
    byId("collectionRetryMissingButton")?.addEventListener("click", () => void controlAmazonCollection("retry_missing"));
  }

  function controlAmazonCollection(action) {
    if (amazonCollectionControlPromise) return amazonCollectionControlPromise;
    amazonCollectionControlPromise = performAmazonCollectionControl(action).finally(() => { amazonCollectionControlPromise = null; });
    return amazonCollectionControlPromise;
  }

  async function performAmazonCollectionControl(action) {
    if (storeImportPending || taskReplacementPending || runState.archivedAt || amazonCollectionControlPending || !currentAmazonCollectionJob() || hasActive1688Work()) return;
    const controlledRunId = runState.id;
    if (["resume", "retry_missing"].includes(action) && !isCollectionWriteLocked()) {
      if (exportRunning || analysisVersionPendingIds.size) {
        showToast("当前文件或分析版本正在保存，完成后可补采。", "info", 5000);
        return;
      }
      if (manualCostDraft && isManualCostDirty()) {
        saveManualCost();
        if (manualCostDraft && isManualCostDirty()) return;
      }
      if (profitAutoCommitTimer !== null) {
        clearProfitAutoCommit();
        if (!commitProfitEdits(false, { preserveEditor: true, preliminaryReview: true })) return;
      }
      if (!await persistCurrentRun({ notify: true }) || runState.id !== controlledRunId || isCollectionWriteLocked()) return;
      closeManualCostDialog({ force: true, restoreFocus: false });
    }
    amazonCollectionControlPending = true;
    clearProfitAutoCommit();
    renderAmazonCollection();
    updateStartAvailability();
    try {
      const job = await requestTaskControl('amazon', { runId: controlledRunId, action });
      if (runState.id !== controlledRunId) return;
      applyAmazonCollectionJob(job);
      await refreshAfterTaskControl('采集操作');
    } catch (error) {
      showToast(error.code === 'CONTROL_OUTCOME_UNKNOWN' ? error.message : `后台任务状态未更新：${error.message}`,
        error.code === 'CONTROL_OUTCOME_UNKNOWN' ? 'info' : 'error', 6500);
    } finally {
      amazonCollectionControlPending = false;
      renderAmazonCollection();
      updateStartAvailability();
      scheduleAmazonCollectionPoll();
    }
  }

  function renderAmazonCollection() {
    const editingLocked = storeImportPending || isCollectionWriteLocked();
    const activeProduct = products.find((product) => product.id === activeProductId);
    PROFIT_EDITOR_INPUT_IDS.forEach((id) => {
      const input = byId(id);
      if (input) input.disabled = editingLocked || isAnalysisReadOnly(activeProduct) || isProductSupplierBusy(activeProduct);
    });
    syncProfitEditorSaveButton(activeProduct);
    if (activeProduct) {
      const choiceLocked = editingLocked || isProductSupplierBusy(activeProduct);
      ['supplierManualUrl', 'saveSupplierChoiceButton'].forEach(id => { if (byId(id)) byId(id).disabled = choiceLocked; });
      $$('[data-supplier-choice]').forEach(radio => { radio.disabled = choiceLocked; });
    }
    if (editingLocked) {
      clearProfitAutoCommit();
      ["approveProductButton", "rejectProductButton", "rematchProductButton"].forEach((id) => {
        const button = byId(id); if (button) button.disabled = true;
      });
    }
    setExportActionsDisabled(exportRunning);
    const panel = byId("amazonCollectionPanel");
    if (!panel) return;
    const job = currentAmazonCollectionJob() || amazonCollectionJob;
    renderAmazonAccessRecovery(job);
    panel.hidden = !job;
    if (!job) return;
    const sameRun = job.runId === runState.id;
    const labels = { queued: "等待采集", running: "后台采集中", cooldown: "稍后自动重试", paused: "已手动暂停", completed: "采集已完成", cancelled: "已取消并归档", needs_attention: "需要处理后继续" };
    const counts = job.counts || {};
    panel.dataset.status = job.status || "queued";
    setText("collectionStatus", job.causeCode === 'SUPPLIER_MATCHING' ? '供应商匹配中，采集暂存' : labels[job.status] || "后台任务");
    setText("collectionProgress", `已处理 ${Number(counts.processed || 0)} / ${Number(counts.total || 0)} · 待采集 ${Number(counts.pending || 0)} · 字段完整 ${Number(counts.complete || 0)} · 字段缺失 ${Number(counts.partial || 0)} · 失败 ${Number(counts.failed || 0)}`);
    setText("collectionMessage", amazonCollectionRefreshError
      ? `暂未同步最新进度：${amazonCollectionRefreshError}。本地后台任务会继续运行。`
      : !sameRun ? "另一个任务正在后台采集；当前显示的是该任务的进度。"
      : job.causeCode === "AMAZON_ACCESS_CHALLENGE" ? "采集会话的访问检查未通过，断点已保存。请使用下方人工处理入口核对；历史超时提示不代表当前页面一定有验证码。"
      : job.message || (job.status === "completed" ? "采集结果已保存；页面未提供的字段保留为空，可按需补采。" : "关闭页面后本地后台仍会继续采集。"));
    setText("collectionEditingNote", sameRun && editingLocked
      ? "采集中可查看、筛选并发起图片匹配；暂停或完成后可编辑。"
      : sameRun && job.causeCode === 'SUPPLIER_MATCHING'
        ? "正在匹配供应商，Amazon 断点已保存；匹配结束后自动继续采集。"
        : sameRun && job.status === 'paused' ? "已暂停，断点已保留；点击继续采集可恢复，上传新文件才会取消并归档本任务。" : "");
    setText("collectionCause", job.causeCode ? `原因：${job.causeCode}` : "");
    const formatTime = (value) => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "—";
    setText("collectionLastProgress", formatTime(job.lastProgressAt || job.updatedAt));
    setText("collectionNextRetry", formatTime(job.nextRetryAt));
    const quality = byId("collectionQualitySummary");
    if (quality) quality.innerHTML = [["price", "售价"], ["weight", "重量"], ["title", "标题"], ["image", "主图"], ["rating", "星级"], ["reviews", "评价数"], ["sales30", "近 30 天销量"], ["salesAmount30", "近 30 天销售额"]].map(([key, label]) => {
      const field = job.quality?.[key] || {};
      return `<div><strong>${label}</strong><span>已核验 ${Number(field.verified || 0)}</span><small>缺失 ${Number(field.missing || 0)} · 页面未提供 ${Number(field.unavailable || 0)} · 无效 ${Number(field.invalid || 0)}</small></div>`;
    }).join("");
    const busy = storeImportPending || taskReplacementPending || Boolean(runState.archivedAt) || amazonCollectionControlPending || !sameRun || hasActive1688Work();
    const pause = byId("collectionPauseButton"), resume = byId("collectionResumeButton"), retry = byId("collectionRetryMissingButton");
    if (retry) retry.title = '重新访问存在缺失字段的商品页面；查看本地详情不会触发重访。';
    if (pause) pause.disabled = busy || !["queued", "running", "cooldown"].includes(job.status);
    if (resume) resume.disabled = busy || !["paused", "needs_attention", "cooldown"].includes(job.status);
    if (retry) retry.disabled = busy || !["completed", "paused", "needs_attention"].includes(job.status);
  }

  function renderAmazonAccessRecovery(job) {
    const panel = byId("collectionAccessPanel"), confirmed = byId("collectionAccessConfirmed");
    const resume = byId("collectionAccessResumeButton"), list = byId("collectionAccessProducts");
    if (!panel || !confirmed || !resume || !list) return;
    const visible = job?.runId === runState.id && job?.status === "needs_attention"
      && job.causeCode === "AMAZON_ACCESS_CHALLENGE" && !runState.archivedAt;
    panel.hidden = !visible;
    const identity = visible ? `${job.runId}:${job.revision}` : "";
    if (amazonAccessRecoveryIdentity !== identity) {
      amazonAccessRecoveryIdentity = identity;
      confirmed.checked = false;
      setText("collectionAccessFeedback", "");
    }
    resume.disabled = !visible || !confirmed.checked || job?.workerActive === true || amazonCollectionControlPending
      || storeImportPending || taskReplacementPending || hasActive1688Work();
    if (!visible) { list.innerHTML = ""; return; }
    const blocked = products.filter(product => amazonCollectionFailure(product)?.code === "AMAZON_ACCESS_CHALLENGE");
    list.innerHTML = blocked.map(product => {
      const url = amazonProductUrl(product), failure = amazonCollectionFailure(product);
      const legacyTimeout = failure.message === "Amazon browser page requires access verification.";
      return `<div class="collection-access-product"><strong>${escapeHtml(product.sourceAsin || product.asin)}</strong>
        <p>${escapeHtml(legacyTimeout ? "旧版将浏览器加载等待超时归类为访问验证；未保存验证页面证据，不能据此确认有验证码。" : failure.message || failure.reason)}</p>
        ${url ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">在新标签页打开原链接</a>
        <button class="secondary-button" type="button" data-amazon-url="${escapeHtml(url)}">在 Edge 打开</button>
        <button class="secondary-button" type="button" data-copy-amazon-url="${escapeHtml(url)}">复制链接</button>` : "<p>未找到有效商品链接，请核对原导入清单。</p>"}</div>`;
    }).join("") || "<p>暂停发生在店铺访问阶段，请核对原导入的店铺页面后再继续。</p>";
  }

  function bindAmazonConnection() {
    byId("amazonRefreshButton")?.addEventListener("click", () => {
      void refreshAmazonConnection();
    });
  }

  function bindNavigation() {
    $$("[data-view-target]").forEach((button) => {
      button.addEventListener("click", () => showView(button.dataset.viewTarget));
    });

    const menuButton = byId("mobileMenuButton");
    const sidebar = $(".sidebar");
    menuButton?.setAttribute("aria-expanded", "false");
    menuButton?.addEventListener("click", (event) => {
      event.stopPropagation();
      const isOpen = sidebar.classList.toggle("is-open");
      document.body.classList.toggle("menu-open", isOpen);
      menuButton.setAttribute("aria-expanded", String(isOpen));
    });
    document.addEventListener("click", (event) => {
      if (window.innerWidth > 820 || !sidebar?.classList.contains("is-open")) return;
      if (!sidebar.contains(event.target) && event.target !== menuButton) closeMobileMenu();
    });
  }

  function showView(viewName) {
    if (!VIEW_TITLES[viewName]) return;
    $$("[data-view]").forEach((panel) => panel.classList.toggle("is-active", panel.dataset.view === viewName));
    $$("[data-view-target]").forEach((button) => button.classList.toggle("is-active", button.dataset.viewTarget === viewName));
    byId("topbarTitle").textContent = VIEW_TITLES[viewName];
    closeMobileMenu();
    if (viewName === "results") renderResults();
    if (viewName === "history") updateHistorySummary();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function closeMobileMenu() {
    $(".sidebar")?.classList.remove("is-open");
    document.body.classList.remove("menu-open");
    byId("mobileMenuButton")?.setAttribute("aria-expanded", "false");
  }

  function createIdleRunState() {
    return {
      id: null,
      mode: "idle",
      dataSource: null,
      startedAt: null,
      completedAt: null,
      errors: [],
      storeVisits: [],
      coverage: null,
      marketplace: activeMarket.code,
      marketplaceId: activeMarket.marketplaceId,
      amazonDomain: activeMarket.amazonDomain,
      currency: activeMarket.currency,
      locale: activeMarket.locale,
      exchangeRate: taskExchangeRate,
      sourceMarketplace: activeMarket.code,
      providerMarketplace: null,
      providerMode: null,
      supplier1688Pipeline: null,
    };
  }

  function getDefaultProfitInputs(marketCode = activeMarket.code) {
    const market = MARKET_CONFIGS[marketCode] || MARKET_CONFIGS.AU;
    return {
      formulaVersion: PROFIT_FORMULA_VERSION,
      exchangeRate: market.defaultExchangeRate,
      ...DEFAULT_PROFIT_RATES,
      airFreightRateCnyPerKg: market.defaultAirFreightRateCnyPerKg ?? DEFAULT_PROFIT_RATES.airFreightRateCnyPerKg,
      commissionRate: market.defaultCommissionRate ?? DEFAULT_PROFIT_RATES.commissionRate,
      managementRate: market.defaultManagementRate ?? DEFAULT_PROFIT_RATES.managementRate,
      returnsRate: market.defaultReturnsRate ?? DEFAULT_PROFIT_RATES.returnsRate,
      airFreightActualWeightOnly: market.airFreightActualWeightOnly === true,
      volumetricDivisor: 139,
    };
  }

  function confirmActiveTaskReplacement(message, { uploading = false } = {}) {
    if (storeImportPending || taskReplacementPending) return false;
    if (!uploading && (isCollectionWriteLocked() || hasOtherActiveCollection())) { showToast("后台任务仍在管理采集数据，请等待采集完成后更换店铺任务。", "info", 5000); return false; }
    if (analysisVersionPendingIds.size) { showToast("新的分析版本正在保存，请完成后再切换任务。", "info", 4200); return false; }
    if (exportRunning) { showToast("导出正在保存，请完成后再切换任务。", "info", 4200); return false; }
    if (uploading && (runState.id || amazonCollectionJob?.runId || supplierPipelineState?.runId)) {
      return window.confirm(`${message}\n\n旧任务将取消并归档到任务记录，已保存结果和人工数据保留。是否继续？`);
    }
    if (!analysisRunning && !hasActive1688Work()) return true;
    return window.confirm(`${message}\n\n当前请求会被取消，已经保存的历史任务不会受影响。是否继续？`);
  }

  function cancelActiveTaskForReplacement() {
    supplier1688ResumeController?.abort(new DOMException("任务已由用户替换。", "AbortError"));
    const controller = currentRunController;
    if (controller && !controller.signal.aborted) {
      controller.abort(new DOMException("任务已由用户替换。", "AbortError"));
    }
    if (currentRunController === controller) currentRunController = null;
    analysisRunning = false;
    const button = byId("startAnalysisButton");
    button?.classList.remove("is-loading");
  }

  function assertCurrentTaskRequest(controller) {
    if (controller && currentRunController === controller && !controller.signal.aborted) return;
    throw controller?.signal?.reason || new DOMException("任务已被替换。", "AbortError");
  }

  function hasActive1688Work() {
    return supplier1688SelectionPending || Boolean(supplier1688ResumePromise);
  }

  function assertCurrent1688Request(controller, runId) {
    if (supplier1688ResumeController === controller && !controller.signal.aborted && runState.id === runId) return;
    throw controller.signal.reason || new DOMException("1688 任务已被替换。", "AbortError");
  }

  function bindMarketplace() {
    const select = byId("marketplaceSelect");
    if (!select) return;
    select.value = activeMarket.code;
    select.addEventListener("change", async () => {
      const nextMarket = MARKET_CONFIGS[select.value];
      if (!nextMarket?.enabled) {
        select.value = activeMarket.code;
        showToast("该站点尚未开放。", "info");
        return;
      }
      if (nextMarket.code === activeMarket.code) return;
      if (!confirmActiveTaskReplacement(`切换到 Amazon ${nextMarket.nameZh} 会清空当前清单和页面结果。`)) {
        select.value = activeMarket.code;
        return;
      }
      cancelActiveTaskForReplacement();

      storeLoadGeneration += 1;
      storeParseController?.abort();
      currentRunController?.abort();
      storeParseController = null;
      currentRunController = null;
      activeMarket = nextMarket;
      taskExchangeRate = activeMarket.defaultExchangeRate;
      storeList = null;
      selectedStoreFile = null;
      resetTaskResultsForStoreChange();
      resetStoreAuditUi();
      renderMarketUi();
      setImportStatus("warning", "等待导入");
      setText("uploadedFilename", "请选择 XLSX 店铺清单（自动识别站点）");
      updateStartAvailability();
      showToast(`已切换到 Amazon ${activeMarket.nameZh}，原站点任务数据已清空。`, "info", 4200);
    });
  }

  function renderMarketUi() {
    document.documentElement.dataset.marketplace = activeMarket.code;
    document.title = `Scout ${activeMarket.code} | 亚马逊找品 Agent`;
    const select = byId("marketplaceSelect");
    if (select) select.value = activeMarket.code;
    $$('[data-market-currency]').forEach((element) => { element.textContent = activeMarket.currency; });
    $$('[data-market-name]').forEach((element) => { element.textContent = activeMarket.nameZh; });
    $$('[data-market-region]').forEach((element) => { element.textContent = activeMarket.deliveryRegion || "未设置（全国）"; });
    const regionHint = byId("marketRegionHint");
    if (regionHint) regionHint.textContent = activeMarket.deliveryRegion
      ? `配送地区：${activeMarket.deliveryRegion}`
      : "配送地区：全国（未设置邮编）";
    $$('[data-market-eyebrow]').forEach((element) => { element.textContent = activeMarket.eyebrow; });
    $$('[data-market-domain]').forEach((element) => { element.textContent = activeMarket.amazonDomain; });
    $$('[data-market-version]').forEach((element) => { element.textContent = `${activeMarket.code} v${APP_VERSION} · 单次任务`; });
    $$('[data-fba-policy]').forEach((element) => { element.textContent = fbaPolicyDetail(activeMarket); });
    $$('[data-profit-policy]').forEach((element) => { element.textContent = profitPolicyLabel(activeMarket); });
    $$('[data-target-cost-policy]').forEach((element) => { element.textContent = targetCostPolicyLabel(activeMarket); });
    $$('[data-sale-price-policy]').forEach((element) => { element.textContent = salePricePolicyLabel(activeMarket); });
    setText("marketEyebrow", activeMarket.eyebrow);
    setText("brandMarket", `SCOUT ${activeMarket.code}`);
    setText("sidebarVersion", `${activeMarket.code} v${APP_VERSION} · 单次任务`);
    setText("exchangeRateLabel", `1 ${activeMarket.currency} 兑换人民币`);
    setText("fbaPolicyBadgeText", fbaPolicyShortLabel(activeMarket));
    setText("fbaPolicyName", fbaPolicyShortLabel(activeMarket));
    setText("historyMarketTitle", `${activeMarket.nameZh}竞品店铺 · 等待首次分析`);
    const description = byId("costModelDescription");
    if (description) description.textContent = `${profitPolicyLabel(activeMarket)}；${fbaPolicyDetail(activeMarket)}`;
    const demoButton = byId("useDemoDataButton");
    const demoMarketSupported = ["AU", "US"].includes(activeMarket.code);
    if (demoButton) {
      demoButton.hidden = !demoMarketSupported;
      demoButton.disabled = !demoMarketSupported;
      demoButton.title = demoMarketSupported ? "使用模拟数据演示" : `${activeMarket.nameZh}不提供模拟商品`;
    }
    setText("drawerProfitValue", "-- / 件");
    renderFilterCurrencyConversions();
    renderAmazonConnectionStatus();
  }

  function profitPolicyLabel(market = activeMarket) {
    if (market.code === "AU") return "AUD 澳洲铺货公式 · 佣金 11% · 采购税 4% · 空运 ¥0.045/g · 管理费 6% · 退货预留 4% · VAT 0%";
    if (market.code === "CA") return "CAD 单品公式 · 采购税 4% + 国内运费按商品重量估算 + 空运 ¥0.045/g · 退货预留 4% · 售价＜14 CAD 减 0.8 后加收 3.5% FBA 附加费";
    return `${market.currency} 单品公式 · 采购税 4% + 国内运费按商品重量估算 + 空运头程`;
  }

  function targetCostPolicyLabel(market = activeMarket) {
    return market.code === "US"
      ? "我们的售价 USD × 1.4"
      : `我们的售价 ${market.currency} × 当地币种兑 CNY 汇率 ÷ 5`;
  }

  function salePricePolicyLabel(market = activeMarket) {
    return `与竞品当前售价 ${market.currency} 相同`;
  }

  function fbaPolicyShortLabel(market = activeMarket) {
    if (market.code === "AU") return "澳洲 FBA · 标准信封";
    if (market.code === "CA") return "加拿大 FBA · 旺季信封";
    return market.code === "US" ? "FBA SOP · 商品重量" : "美国 FBA SOP · 商品重量代理";
  }

  function fbaPolicyDetail(market = activeMarket) {
    if (market.code === "AU") return "标准信封≤33×23×2.5cm、≤475g；0–75g、76–225g、226–475g 售价≤13 AUD 分别为3.67、4.35、4.70，＞13 AUD 为4.58、5.26、5.61；超475g按最高重量档封顶估费，头程仍按实际重量；尺寸未提供时按标准信封暂估，可手工覆盖";
    const standardPolicy = FBA_WEIGHT_STANDARD_SIZE_POLICY === "small" ? "1 lb 内按小号标准件" : "20 lb 内按大号标准件保守档";
    if (market.code === "US") return `仅按商品重量套用 FBA 物流费用计算 SOP（${standardPolicy}），不使用尺寸或 SellerSprite FBA 原值，可手工覆盖`;
    if (market.code === "CA") return `固定按加拿大旺季信封表暂估，超500g按最高重量档封顶估费，头程仍按实际重量；售价＜14 CAD 减0.8，恰好14不减；（基础费－优惠）×1.035，计算保留精度、显示两位小数，可手工覆盖`;
    return `仅按商品重量套用美国 FBA 物流费用计算 SOP（${standardPolicy}），费率数值按 ${market.currency} 名义估算，可手工覆盖`;
  }

  function resetTaskResultsForStoreChange() {
    closeManualCostDialog({ force: true, restoreFocus: false });
    supplier1688ResumeController?.abort(new DOMException("任务已由用户替换。", "AbortError"));
    currentRunController?.abort();
    amazonCheckController?.abort();
    currentRunController = null;
    amazonCheckController = null;
    amazonCheckPromise = null;
    analysisRunning = false;
    products = [];
    activeProductId = null;
    activeRunCriteria = {};
    currentVisibleProducts = [];
    runState = createIdleRunState();
    syncAmazonListingDateControl();
    restorePending1688RiskStatus();
    const progress = byId("progressPanel");
    if (progress) progress.hidden = true;
    const backdrop = byId("drawerBackdrop");
    if (backdrop) {
      backdrop.hidden = true;
      backdrop.classList.remove("is-open");
    }
    document.body.classList.remove("drawer-open");
    setDataMode(
      sellerSpriteStatus === "live" ? (activeMarket.code === "NL" ? "mixed" : "live") : sellerSpriteStatus === "error" ? "error" : "idle",
      sellerSpriteStatus === "live" ? (activeMarket.code === "NL" ? "DE 代理待命" : "实时数据") : sellerSpriteStatus === "error" ? "数据源异常" : sellerSpriteCheckPromise ? "检测中" : "等待连接",
    );
    renderResults();
    renderRunCoverage();
    updateHistorySummary();
  }

  async function archiveCurrentRunForUpload() {
    if (amazonCollectionControlPromise) await amazonCollectionControlPromise;
    if (!isCollectionWriteLocked() && runState.id && runState.mode !== "idle") {
      if (manualCostDraft && isManualCostDirty()) {
        saveManualCost();
        if (manualCostDraft && isManualCostDirty()) throw new Error("请先完成当前人工成本填写，再上传新文件。");
      }
      if (profitAutoCommitTimer !== null || drawerProfitDraft) {
        if (!await saveProfitEditor()) throw new Error("人工修改尚未保存，旧任务尚未归档。");
      }
      if (!await persistCurrentRun({ notify: true })) throw new Error("旧任务保存未成功，尚未切换新文件。");
    }
    await persistenceSaveQueue;
    const runIds = [...new Set([
      runState.mode !== "idle" ? runState.id : null,
      amazonCollectionJob?.status !== "cancelled" ? amazonCollectionJob?.runId : null,
      supplierPipelineState && !["complete", "cancelled"].includes(supplierPipelineState.status) ? supplierPipelineState.runId : null,
    ].filter(Boolean))];
    taskReplacementPending = true;
    taskContextGeneration += 1;
    snapshotRefreshPending = false;
    profitEditorSnapshotDeferred = false;
    clearProfitAutoCommit();
    cancelActiveTaskForReplacement();
    if (supplier1688ResumePromise) await supplier1688ResumePromise.catch(() => {});
    for (const runId of runIds) {
      const archived = await apiRequest(`/api/runs/${encodeURIComponent(runId)}/archive`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: "file_upload" }), timeout: 120000,
      });
      runHistory = Array.isArray(archived?.runs) ? archived.runs : runHistory;
    }
    amazonCollectionJob = null;
    amazonCollectionRevision = null;
    amazonCollectionRefreshError = null;
    amazonCollectionStatusKnown = false;
    supplierPipelineState = null;
    supplier1688ResumeRequested = false;
    drawerProfitDraft = null;
    drawerProfitBaseline = null;
    resultPage = 1;
    if (byId("resultSearch")) byId("resultSearch").value = "";
    if (byId("resultMinMargin")) byId("resultMinMargin").value = "";
    if (byId("resultsCompleteToggle")) byId("resultsCompleteToggle").checked = false;
  }

  function isAsinImport(data = storeList) {
    return data?.inputMode === "asins";
  }

  function currentTaskInputMode() {
    // Only the current task or its imported source establishes admission rules.
    // Changing the next-import tab must not change an existing task's candidates.
    if (["asins", "stores"].includes(runState.inputMode)) return runState.inputMode;
    return isAsinImport() ? "asins" : "stores";
  }

  function renderMonthlySalesAdmission() {
    const direct = currentTaskInputMode() === "asins";
    const control = byId("monthlySalesBand");
    if (control) {
      control.disabled = false;
      control.title = direct ? "ASIN 默认显示全部商品；选择月销量档位后才按销量筛选。" : "店铺导入按有效月销量及所选档位筛选。";
    }
    setText("monthlySalesAllOption", direct ? "全部商品（不限月销量）" : "全部合格月销量（有效值 ≥50）");
    if (byId("monthlySales50PlusOption")) byId("monthlySales50PlusOption").hidden = !direct;
    const row = byId("monthlySalesFilter");
    if (row) row.hidden = false;
    setText("monthlySalesAdmissionNote", direct
      ? "ASIN 导入：默认显示全部商品，包含月销量低于 50 和未知的商品；仅在主动选择销量档位时筛选。其他已选条件仍生效。"
      : "店铺导入：按有效月销量 ≥50 及所选销量档位初筛；未知销量单独统计，原始记录保留。");
  }

  function importedItemCount(data = storeList) {
    if (isAsinImport(data)) return new Set((data?.stores || []).flatMap((store) => store.asins || [])).size;
    return data?.audit?.uniqueSellers ?? data?.stores?.length ?? 0;
  }

  function hasNewAsinDraft() {
    return importMode === "asins" && Boolean(byId("asinTextInput")?.value.trim());
  }

  function selectedInputNeedsImport() {
    return failedImportFileDraft !== null || importMode !== (isAsinImport() ? "asins" : "stores") || hasNewAsinDraft();
  }

  function usableExcelAsinProjection(projection) {
    return projection?.version === 1 && ["uploaded_excel_asin_column", "uploaded_excel_direct_products"].includes(projection.source)
      && projection.status === "ready" && projection.data?.inputMode === "asins"
      && ["asin", "product_url"].includes(projection.data.audit?.sourceColumn) && importedItemCount(projection.data) > 0;
  }

  function renderSelectedInputSummary() {
    const pending = selectedInputNeedsImport();
    const summary = byId("selectedInputSummary");
    if (byId("discardImportDraftButton")) byId("discardImportDraftButton").hidden = !pending;
    if (byId("importMetrics")) byId("importMetrics").hidden = pending;
    if (byId("importDataAudit")) byId("importDataAudit").hidden = pending;
    if (pending && byId("storeManager")) byId("storeManager").hidden = true;
    if (!summary) return;
    summary.hidden = !pending;
    if (!pending) return;
    if (failedImportFileDraft && !hasNewAsinDraft()) {
      summary.textContent = `新文件“${failedImportFileDraft.fileName}”尚未导入：${failedImportFileDraft.error}。请重新选择有效文件，或取消新输入后返回原任务；不会自动续跑旧任务。`;
    } else if (importMode !== "asins") {
      summary.textContent = "已选择店铺模式，请重新上传店铺 Excel；不会继续当前 ASIN 任务。";
    } else if (hasNewAsinDraft()) {
      summary.textContent = "所选输入：新粘贴的 ASIN / 商品链接。点击开始后先校验、归档旧任务，再创建独立 ASIN 批次。";
    } else if (asinImportPreview?.status === "ready") {
      const preview = asinImportPreview.data;
      const asins = (preview.stores || []).flatMap(store => store.asins || []);
      summary.textContent = `所选输入：${asinImportPreview.fileName} 的${preview.audit.sourceColumn === "product_url" ? "商品链接" : " ASIN 列"} · ${preview.audit.marketplace} · ${importedItemCount(preview)} 个唯一 ASIN。${asins.slice(0, 8).join("、")}${asins.length > 8 ? "…" : ""}。只采集这些 ASIN；点击开始后归档旧任务，建立独立批次。`;
    } else if (asinImportPreview?.status === "loading") {
      summary.textContent = "正在校验当前 Excel 的 ASIN 列；旧任务和结果保持原状。";
    } else {
      summary.textContent = asinImportPreview?.error || "当前记录没有原始 Excel 的 ASIN 列，请重新选择含 ASIN 列的 Excel，或粘贴 ASIN。不会从旧店铺结果推断范围或继续旧任务。";
    }
  }

  async function prepareCurrentExcelAsins() {
    if (importMode !== "asins" || isAsinImport() || hasNewAsinDraft()) return null;
    const projection = storeList?.directAsinInput;
    if (usableExcelAsinProjection(projection)) {
      asinImportPreview = { status: "ready", data: structuredClone(projection.data), fileName: storeList.fileName || "当前 Excel" };
      if (byId("asinMarketplaceSelect")) byId("asinMarketplaceSelect").value = projection.data.audit.marketplace;
      renderSelectedInputSummary();
      return asinImportPreview;
    }
    if (projection?.status === "unavailable") {
      asinImportPreview = { status: "unavailable", error: `当前 Excel 的 ASIN 列不可用：${projection.error?.message || "未找到有效 ASIN 列"}。请修正并重新选择文件；不会使用店铺链接或旧结果补充范围。` };
      renderSelectedInputSummary();
      return asinImportPreview;
    }
    if (!selectedStoreFile) {
      asinImportPreview = { status: "unavailable", error: "当前历史记录未保存原始 Excel 的 ASIN 列。请重新选择含 ASIN 列的 Excel，或粘贴 ASIN；不会续跑旧店铺任务。" };
      renderSelectedInputSummary();
      return asinImportPreview;
    }
    if (asinPreviewPromise) return asinPreviewPromise;
    const file = selectedStoreFile;
    const generation = ++asinPreviewGeneration;
    const sourceGeneration = storeLoadGeneration;
    asinImportPreview = { status: "loading" };
    renderSelectedInputSummary();
    const request = (async () => {
      try {
        const data = await apiRequest("/api/asin-list/parse", {
          method: "POST", body: await file.arrayBuffer(),
          headers: { "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "X-File-Name": encodeURIComponent(file.name), "X-Marketplace": byId("asinMarketplaceSelect")?.value || activeMarket.code },
        });
        if (generation !== asinPreviewGeneration || sourceGeneration !== storeLoadGeneration) return null;
        if (data?.inputMode !== "asins" || !["asin", "product_url"].includes(data.audit?.sourceColumn) || !importedItemCount(data)) throw new Error("当前 Excel 没有有效的 ASIN 或商品链接。请重新选择对应 Excel。");
        asinImportPreview = { status: "ready", data, fileName: file.name };
      } catch (error) {
        if (generation !== asinPreviewGeneration || sourceGeneration !== storeLoadGeneration) return null;
        asinImportPreview = { status: "unavailable", error: `${error.message || "ASIN 列解析失败"}；旧任务未变更。` };
      } finally {
        if (generation === asinPreviewGeneration) {
          asinPreviewPromise = null;
          renderSelectedInputSummary();
          updateStartAvailability();
        }
      }
      return asinImportPreview;
    })();
    asinPreviewPromise = request;
    return request;
  }

  function setImportMode(mode) {
    importMode = mode === "asins" ? "asins" : "stores";
    const asins = importMode === "asins";
    byId("storeImportTab")?.setAttribute("aria-selected", String(!asins));
    byId("asinImportTab")?.setAttribute("aria-selected", String(asins));
    if (byId("storeImportHelp")) byId("storeImportHelp").hidden = asins;
    if (byId("asinImportPanel")) byId("asinImportPanel").hidden = !asins;
    setText("uploadedFilename", storeList && isAsinImport() === asins ? storeList.fileName : asins ? "重新选择含 ASIN 列的 Excel" : "选择店铺文件");
    setText("uploadHelp", asins ? "优先使用当前 Excel 的 ASIN 列；也可重新上传含 ASIN 列的 XLSX" : "每行一个 Amazon 店铺链接 · 自动识别国家并切换站点");
    if (asins && !isAsinImport()) void prepareCurrentExcelAsins();
    if (!selectedInputNeedsImport() && storeList) renderStoreManager({ collapse: true });
    renderSelectedInputSummary();
    updateStartAvailability();
  }

  async function importTaskSource({ file = null, text = "", mode = importMode, marketplace = activeMarket.code, preparedData = null, preparedFileName = null } = {}) {
    if (storeImportPending || taskReplacementPending) return false;
    if (file && !file.name.toLowerCase().endsWith(".xlsx")) {
      failedImportFileDraft = { fileName: file.name, mode, error: "仅支持 XLSX 文件" };
      renderSelectedInputSummary(); updateStartAvailability();
      showToast("实时解析仅支持 XLSX 文件。", "error", 4200);
      return false;
    }
    const asins = mode === "asins";
    if (!file && !preparedData && (!asins || !text.trim())) {
      showToast("请填写至少一个 ASIN 或 Amazon 商品链接。", "error", 4200);
      return false;
    }
    const fileName = file?.name || preparedFileName || "粘贴 ASIN 清单";
    if (!confirmActiveTaskReplacement(`导入“${fileName}”会替换当前采集清单和页面结果。`, { uploading: true })) return false;
    storeImportPending = true;
    const priorInert = document.body.inert;
    document.body.inert = true;
    const generation = ++storeLoadGeneration;
    storeParseController?.abort();
    const controller = new AbortController();
    storeParseController = controller;
    updateStartAvailability();
    renderAmazonCollection();
    setImportStatus("loading", "正在解析新清单");
    try {
      const data = preparedData ? structuredClone(preparedData) : await apiRequest(asins ? "/api/asin-list/parse" : "/api/store-list/parse", {
        method: "POST",
        body: file ? await file.arrayBuffer() : JSON.stringify({ text, marketplace }),
        headers: file ? {
          "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          "X-File-Name": encodeURIComponent(fileName), "X-Marketplace": marketplace,
        } : { "Content-Type": "application/json" },
        signal: controller.signal,
      });
      if (generation !== storeLoadGeneration || controller.signal.aborted) return false;
      const parsedCount = importedItemCount(data);
      if (!parsedCount || !Array.isArray(data.stores) || !data.stores.length) throw new Error(firstStoreIssueReason(data) || "新清单没有可导入的内容，旧任务已保留。");
      if (asins && data.inputMode !== "asins") throw new Error("ASIN 解析响应无效，旧任务已保留。");
      const detectedMarket = MARKET_CONFIGS[String(data.audit?.marketplace || "").trim().toUpperCase()];
      if (!detectedMarket?.enabled) throw new Error("新清单的站点尚不支持，旧任务已保留。");
      if (data.audit?.requiresSeparateBatches) throw new Error("清单包含不同国家的商品或店铺，请按国家分批导入，旧任务已保留。");
      if (data.stores.some(store => store.marketplace && store.marketplace !== detectedMarket.code)) throw new Error("清单的站点校验不一致，旧任务已保留。");
      setImportStatus("loading", "正在归档旧任务");
      await archiveCurrentRunForUpload();
      if (generation !== storeLoadGeneration) return false;
      // Keep the prior market/currency through its final draft save and archive.
      if (detectedMarket.code !== activeMarket.code) {
        activeMarket = detectedMarket;
        taskExchangeRate = activeMarket.defaultExchangeRate;
      }
      storeList = null;
      resetTaskResultsForStoreChange();
      asinPreviewGeneration += 1;
      asinPreviewPromise = null;
      asinImportPreview = null;
      failedImportFileDraft = null;
      if (asins && byId("asinTextInput")) byId("asinTextInput").value = "";
      selectedStoreFile = file;
      resetStoreAuditUi();
      renderMarketUi();
      applyStoreList(data, fileName);
      setImportMode(asins ? "asins" : "stores");
      if (byId("asinMarketplaceSelect")) byId("asinMarketplaceSelect").value = activeMarket.code;
      showToast(`已导入 Amazon ${activeMarket.nameZh} ${parsedCount} 个${asins ? "ASIN" : "唯一店铺"}，点击开始后采集；旧任务可在任务记录中查看。`, "success", 5000);
      return true;
    } catch (error) {
      if (generation !== storeLoadGeneration || controller.signal.aborted) return false;
      if (file) failedImportFileDraft = { fileName: file.name, mode, error: error.message || "解析失败" };
      renderSelectedInputSummary();
      setImportStatus("error", "新清单尚未载入");
      showToast(["MIXED_MARKETPLACES", "ASIN_MARKETPLACE_MISMATCH"].includes(error.code)
        ? "清单包含多个国家，请按国家分批导入；旧任务已保留。"
        : error.message || "导入未完成，旧任务记录已保留。", "error", 6200);
      return false;
    } finally {
      storeImportPending = false;
      taskReplacementPending = false;
      document.body.inert = priorInert;
      if (generation === storeLoadGeneration && byId("storeFileInput")) byId("storeFileInput").value = "";
      updateStartAvailability();
      renderAmazonCollection();
      scheduleAmazonCollectionPoll(0);
    }
  }

  function bindFileImport() {
    const input = byId("storeFileInput");
    byId("uploadZone")?.addEventListener("click", () => input?.click());
    byId("storeImportTab")?.addEventListener("click", () => setImportMode("stores"));
    byId("asinImportTab")?.addEventListener("click", () => setImportMode("asins"));
    byId("discardImportDraftButton")?.addEventListener("click", () => {
      if (storeImportPending || taskReplacementPending) return;
      failedImportFileDraft = null; asinImportPreview = null; asinPreviewGeneration += 1; asinPreviewPromise = null;
      if (byId("asinTextInput")) byId("asinTextInput").value = "";
      setImportMode(isAsinImport() ? "asins" : "stores");
    });
    if (byId("asinMarketplaceSelect")) byId("asinMarketplaceSelect").value = activeMarket.code;
    byId("asinTextInput")?.addEventListener("input", () => { renderSelectedInputSummary(); updateStartAvailability(); });
    byId("asinMarketplaceSelect")?.addEventListener("change", () => {
      if (!hasNewAsinDraft() && selectedInputNeedsImport()) { asinImportPreview = null; void prepareCurrentExcelAsins(); }
      renderSelectedInputSummary(); updateStartAvailability();
    });
    input?.addEventListener("change", async () => {
      const file = input.files?.[0];
      if (!file) return;
      await importTaskSource({ file, mode: importMode, marketplace: importMode === "asins" ? byId("asinMarketplaceSelect")?.value || activeMarket.code : activeMarket.code });
      input.value = "";
    });
    byId("importAsinsButton")?.addEventListener("click", () => importTaskSource({
      text: byId("asinTextInput")?.value || "", mode: "asins", marketplace: byId("asinMarketplaceSelect")?.value || activeMarket.code,
    }));

    byId("sellerSpriteRetryButton")?.addEventListener("click", () => {
      void checkSellerSpriteConnection();
    });
    byId("connectSellerSpriteButton")?.addEventListener("click", () => {
      void checkSellerSpriteConnection();
    });
    byId("retryConnectionButton")?.addEventListener("click", () => {
      const action = byId("retryConnectionButton")?.dataset.action;
      if (action === "analysis") {
        hideProgressError();
        void runAnalysis();
      } else if (action === "filters") {
        hideProgressError();
        showView("task");
        byId("monthlySalesBand")?.focus();
      } else {
        void checkSellerSpriteConnection();
      }
    });
    byId("useDemoDataButton")?.addEventListener("click", runDemoAnalysis);
  }

  async function loadDefaultStoreList() {
    const generation = ++storeLoadGeneration;
    storeParseController?.abort();
    storeParseController = new AbortController();
    storeList = null;
    resetTaskResultsForStoreChange();
    resetStoreAuditUi();
    setImportStatus("loading", "正在解析");
    try {
      const data = await apiRequest("/api/store-list/default", { timeout: 30000, signal: storeParseController.signal });
      if (generation !== storeLoadGeneration) return;
      const detectedCode = String(data?.audit?.marketplace || "").trim().toUpperCase();
      const detectedMarket = MARKET_CONFIGS[detectedCode];
      if (detectedMarket?.enabled && detectedMarket.code !== activeMarket.code) {
        activeMarket = detectedMarket;
        taskExchangeRate = activeMarket.defaultExchangeRate;
        resetTaskResultsForStoreChange();
        renderMarketUi();
      }
      selectedStoreFile = null;
      applyStoreList(data, data.fileName || "店铺.xlsx");
    } catch (error) {
      if (generation !== storeLoadGeneration || storeParseController.signal.aborted) return;
      storeList = null;
      setImportStatus("error", "未载入");
      updateStartAvailability();
      showToast(`默认店铺表未载入：${error.message}`, "error", 5200);
    }
  }

  function resetStoreAuditUi() {
    if (byId("storeImportWarnings")) { byId("storeImportWarnings").hidden = true; byId("storeImportWarnings").textContent = ""; }
    ["rawRowsMetric", "uniqueStoresMetric", "duplicateRowsMetric", "repairedRowsMetric"].forEach((id) => setText(id, "--"));
    ["marketAuditValue", "keyAuditValue", "repairAuditValue"].forEach((id) => setText(id, "--"));
    $$(".data-audit .audit-row em").forEach((element) => {
      element.textContent = "等待校验";
      element.className = "is-waiting";
    });
    const manager = byId("storeManager");
    const body = byId("storeManagerBody");
    const list = byId("currentStoreList");
    if (manager) manager.hidden = true;
    if (body) body.hidden = true;
    if (list) list.replaceChildren();
    setText("currentStoreCount", 0);
    byId("storeManagerToggle")?.setAttribute("aria-expanded", "false");
  }

  function applyStoreList(data, fileName) {
    const audit = data?.audit || {};
    const stores = Array.isArray(data?.stores) ? data.stores : [];
    if (audit.marketplace !== activeMarket.code) {
      throw new Error(`店铺表属于 ${audit.marketplace || "未知"} 站，与当前 ${activeMarket.code} 站不一致。`);
    }
    storeList = { ...data, audit: { ...audit }, sourceAudit: { ...audit }, stores, fileName, manuallyEdited: false };
    renderMonthlySalesAdmission();
    setImportMode(isAsinImport() ? "asins" : "stores");
    byId("uploadedFilename").textContent = fileName;
    renderStoreAuditUi(storeList.audit);
    renderStoreManager({ collapse: true });
    const issueReason = stores.length ? "" : firstStoreIssueReason(data);
    setImportStatus(issueReason ? "error" : audit.invalid ? "warning" : "success", issueReason ? "未导入" : audit.invalid ? "有待处理项" : "已解析");
    if (issueReason) {
      setText("repairAuditValue", issueReason);
      const auditStates = $$(".data-audit .audit-row em");
      if (auditStates[2]) {
        auditStates[2].textContent = "未导入";
        auditStates[2].className = "warning-text";
      }
    }
    updateStartAvailability();
    updateHistorySummary();
    renderAmazonConnectionStatus();
  }

  function firstStoreIssueReason(data = storeList) {
    if (data?.manuallyEdited) return "";
    const issue = Array.isArray(data?.issues) ? data.issues[0] : null;
    if (!issue) return "";
    const row = Number.isFinite(Number(issue.rowNumber)) ? `第 ${Number(issue.rowNumber)} 行：` : "";
    const labels = {
      MARKETPLACE_MISMATCH: `店铺链接站点与当前 ${activeMarket.nameZh} 不一致`,
      ROW_MARKETPLACE_URL_MISMATCH: "国家列与店铺链接所属国家不一致",
      UNSUPPORTED_ROW_MARKETPLACE: "国家列中的站点尚不支持",
      INVALID_SELLER_URL: "店铺链接格式无效",
      EMPTY_SELLER_URL: "店铺链接为空",
      INVALID_SELLER_ID: "Seller ID 格式无效",
      UNRESOLVED_ROW: "没有可用的店铺链接、Seller ID、店铺名或 ASIN",
      INVALID_ASIN: "ASIN 格式无效",
      SELLER_ID_MISMATCH: "Seller ID 与店铺链接中的 ID 不一致",
    };
    return `${row}${labels[issue.code] || issue.message || "店铺行无法解析"}`;
  }

  function renderStoreAuditUi(audit = {}) {
    renderStoreImportWarnings();
    setMetric("rawRowsMetric", audit.rawRows);
    setMetric("uniqueStoresMetric", importedItemCount());
    setText("uniqueImportMetricLabel", isAsinImport() ? "唯一 ASIN" : "唯一卖家");
    setMetric("duplicateRowsMetric", audit.duplicates);
    setMetric("repairedRowsMetric", audit.repaired);
    setText("marketAuditValue", audit.marketplaceDomain || activeMarket.amazonDomain);
    setText("keyAuditValue", isAsinImport() ? "Marketplace + ASIN" : "Marketplace + Seller ID");
    const repairNumber = Number(audit.repaired);
    const repaired = audit.repaired === null || audit.repaired === undefined || audit.repaired === "" || !Number.isFinite(repairNumber)
      ? null
      : repairNumber;
    const sourceRepaired = Number(storeList?.sourceAudit?.repaired || 0);
    setText(
      "repairAuditValue",
      repaired === null
        ? `源表修复 ${sourceRepaired} 条，当前归属不可确定`
        : repaired
          ? `${repaired} 条链接已修复并保留原值`
          : "无需修复",
    );
    const auditStates = $$(".data-audit .audit-row em");
    if (auditStates[0]) {
      auditStates[0].textContent = audit.invalid ? "需复核" : "通过";
      auditStates[0].className = audit.invalid ? "warning-text" : "";
    }
    if (auditStates[1]) {
      auditStates[1].textContent = "已规范化";
      auditStates[1].className = "";
    }
    if (auditStates[2]) {
      auditStates[2].textContent = repaired === null ? "源表记录" : repaired ? "保留原值" : "通过";
      auditStates[2].className = repaired === null || repaired ? "warning-text" : "";
    }
  }

  function bindStoreManager() {
    byId("storeManagerToggle")?.addEventListener("click", () => {
      const toggle = byId("storeManagerToggle");
      const body = byId("storeManagerBody");
      if (!toggle || !body || toggle.disabled) return;
      const expanded = toggle.getAttribute("aria-expanded") !== "true";
      toggle.setAttribute("aria-expanded", String(expanded));
      body.hidden = !expanded;
    });

    byId("currentStoreList")?.addEventListener("click", (event) => {
      const asinButton = event.target.closest("[data-remove-asin]");
      if (asinButton && !asinButton.disabled && !analysisRunning && !isCollectionWriteLocked() && !hasActive1688Work()) {
        const asin = asinButton.dataset.removeAsin;
        if ((products.length || runState.mode !== "idle") && !window.confirm(`移除 ASIN ${asin} 会清空当前分析结果，是否继续？`)) return;
        const stores = (storeList?.stores || []).map(store => ({
          ...store,
          asins: (store.asins || []).filter(value => value !== asin),
          ...(store.productUrls ? { productUrls: Object.fromEntries(Object.entries(store.productUrls).filter(([sourceAsin]) => sourceAsin !== asin)) } : {}),
        })).filter(store => store.asins.length);
        applyStoreMutation(stores, `已从本次任务移除 ASIN ${asin}。`);
        return;
      }
      const button = event.target.closest("[data-remove-store]");
      if (!button || button.disabled || analysisRunning || hasActive1688Work()) return;
      removeCurrentStore(Number(button.dataset.storeIndex));
    });

    byId("clearStoreListButton")?.addEventListener("click", () => {
      const count = importedItemCount();
      if (!count || analysisRunning || hasActive1688Work()) return;
      const confirmed = window.confirm(`清空当前任务的 ${count} 个${isAsinImport() ? "ASIN" : "店铺"}及已有分析结果？\n源 XLSX 不会被修改。`);
      if (confirmed) applyStoreMutation([], `已清空本次任务的 ${count} 个${isAsinImport() ? "ASIN" : "店铺"}；源文件未修改。`, { focusUpload: true });
    });
  }

  function renderStoreManager({ collapse = false } = {}) {
    const manager = byId("storeManager");
    const toggle = byId("storeManagerToggle");
    const body = byId("storeManagerBody");
    const list = byId("currentStoreList");
    if (!manager || !toggle || !body || !list) return;
    const stores = Array.isArray(storeList?.stores) ? storeList.stores : [];
    setText("currentStoreCount", importedItemCount());
    setText("currentImportListLabel", isAsinImport() ? "当前任务 ASIN" : "当前任务店铺");
    list.setAttribute("aria-label", isAsinImport() ? "当前任务 ASIN" : "当前任务店铺");
    manager.hidden = stores.length === 0;
    if (!stores.length) {
      list.replaceChildren();
      body.hidden = true;
      toggle.setAttribute("aria-expanded", "false");
      syncStoreManagerControls();
      return;
    }
    if (collapse) {
      body.hidden = true;
      toggle.setAttribute("aria-expanded", "false");
    }
    if (isAsinImport()) {
      list.innerHTML = [...new Set(stores.flatMap(store => store.asins || []))].map(asin => `
        <div class="current-store-item" role="listitem">
          <i class="current-store-icon" data-lucide="package" aria-hidden="true"></i>
          <div class="current-store-copy"><strong>${escapeHtml(asin)}</strong><span>Amazon ${escapeHtml(activeMarket.nameZh)} · 直接采集商品详情</span></div>
          <button class="icon-button current-store-remove" type="button" data-remove-asin="${escapeHtml(asin)}" aria-label="移除 ASIN ${escapeHtml(asin)}"><i data-lucide="trash-2" aria-hidden="true"></i></button>
        </div>`).join("");
      syncStoreManagerControls();
      initIcons();
      return;
    }
    list.innerHTML = stores.map((store, index) => {
      const sellerId = String(store?.sellerId || "未提供").trim();
      const sellerName = String(store?.sellerName || "未提供").trim();
      const label = store?.sellerName || store?.sellerId || store?.asins?.[0] || `店铺 ${index + 1}`;
      const sourceRows = Array.isArray(store?.rowNumbers) && store.rowNumbers.length
        ? store.rowNumbers.join("、")
        : "--";
      const removeLabel = `从当前任务移除 ${label}`;
      return `
        <div class="current-store-item" role="listitem">
          <i class="current-store-icon" data-lucide="store" aria-hidden="true"></i>
          <div class="current-store-copy">
            <strong>${escapeHtml(label)}</strong>
            <span><b>Seller ID</b> ${escapeHtml(sellerId)} <i aria-hidden="true">·</i> <b>店铺名</b> ${escapeHtml(sellerName)}</span>
            <small>源行号 ${escapeHtml(sourceRows)}${store.importBlocked ? " · 筛选条件冲突，本店暂停采集" : ""}</small>
          </div>
          <button class="icon-button current-store-remove" type="button" data-remove-store data-store-index="${index}" aria-label="${escapeHtml(removeLabel)}" title="${escapeHtml(removeLabel)}"${analysisRunning ? " disabled" : ""}>
            <i data-lucide="trash-2" aria-hidden="true"></i>
          </button>
        </div>`;
    }).join("");
    syncStoreManagerControls();
    initIcons();
  }

  function removeCurrentStore(index) {
    const stores = Array.isArray(storeList?.stores) ? storeList.stores : [];
    const removed = stores[index];
    if (!removed || analysisRunning || hasActive1688Work()) return;
    const label = removed.sellerName || removed.sellerId || removed.asins?.[0] || `店铺 ${index + 1}`;
    const hasTaskState = products.length > 0 || runState.mode !== "idle" || Boolean(runState.coverage) || runState.errors.length > 0;
    if (hasTaskState) {
      const confirmed = window.confirm(`移除“${label}”会清空现有分析结果和初审状态。是否继续？\n源 XLSX 不会被修改。`);
      if (!confirmed) return;
    }
    const nextStores = stores.filter((_, storeIndex) => storeIndex !== index);
    applyStoreMutation(nextStores, `已从本次任务移除“${label}”；源 XLSX 未修改。`, {
      focusIndex: Math.min(index, nextStores.length - 1),
      focusUpload: nextStores.length === 0,
    });
  }

  function applyStoreMutation(stores, message, { focusIndex = null, focusUpload = false } = {}) {
    if (!storeList || analysisRunning || hasActive1688Work()) return;
    const sourceAudit = storeList.sourceAudit || storeList.audit || {};
    const rowCount = stores.reduce((total, store) => total + Math.max(1, store.rowNumbers?.length || 0), 0);
    const duplicates = stores.reduce((total, store) => total + Math.max(0, (store.rowNumbers?.length || 1) - 1), 0);
    const resolved = stores.filter(isStoreActionable).length;
    const sourceRepaired = Number(sourceAudit.repaired || 0);
    const audit = {
      ...storeList.audit,
      rawRows: rowCount,
      uniqueSellers: isAsinImport() ? 0 : stores.length,
      ...(isAsinImport() ? { uniqueAsins: new Set(stores.flatMap(store => store.asins || [])).size } : {}),
      duplicates,
      repaired: stores.length === 0 || sourceRepaired === 0 ? 0 : null,
      invalid: stores.length === 0 ? 0 : Number(sourceAudit.invalid || 0),
      resolved,
      unresolved: stores.length - resolved,
    };
    const remainingAsins = new Set(stores.flatMap(store => store.asins || []));
    storeList = { ...storeList, audit, stores, sourceAudit, manuallyEdited: true, ...(isAsinImport() ? { rows: (storeList.rows || []).filter(row => remainingAsins.has(row.asin)) } : {}) };
    if (!stores.length) {
      selectedStoreFile = null;
      setText("uploadedFilename", "选择店铺文件");
    }
    resetTaskResultsForStoreChange();
    renderStoreAuditUi(audit);
    renderStoreManager();
    setImportStatus("warning", stores.length ? "清单已调整" : "清单为空");
    updateStartAvailability();
    updateHistorySummary();
    if (focusUpload) byId("uploadZone")?.focus();
    else if (Number.isInteger(focusIndex) && focusIndex >= 0) {
      byId("currentStoreList")?.querySelector(`[data-store-index="${focusIndex}"]`)?.focus();
    }
    showToast(message, "info", 5200);
  }

  function syncStoreManagerControls() {
    const hasStores = Boolean(storeList?.stores?.length);
    const disabled = analysisRunning || isCollectionWriteLocked() || hasActive1688Work() || !hasStores;
    const toggle = byId("storeManagerToggle");
    const clear = byId("clearStoreListButton");
    if (toggle) toggle.disabled = disabled;
    if (clear) clear.disabled = disabled;
    $$('[data-remove-store], [data-remove-asin]').forEach((button) => { button.disabled = disabled; });
  }

  async function loadRuntimeStatus() {
    try {
      const data = await apiRequest("/api/version", { timeout: 5000 });
      if (!data?.connected || sellerSpriteStatus !== "idle") return;
      sellerSpriteStatus = "live";
      setConnectionState("live", "已连接");
      setDataMode(activeMarket.code === "NL" ? "mixed" : "live", activeMarket.code === "NL" ? "DE 代理待命" : "实时数据");
      updateStartAvailability();
    } catch (_) {
      // Runtime status is local-only; a failed read must not trigger SellerSprite.
    }
  }

  function bind1688Session() {
    byId("relogin1688Button")?.addEventListener("click", () => {
      void start1688Session({ restart: true, freshLogin: true });
    });
    byId("login1688Button")?.addEventListener("click", () => {
      void start1688Session();
    });
    byId("check1688Button")?.addEventListener("click", () => {
      void check1688Session();
    });
    byId("resume1688Button")?.addEventListener("click", () => {
      void resume1688AfterVerification();
    });
    byId("restart1688Button")?.addEventListener("click", () => {
      void start1688Session({ restart: true });
    });
  }

  async function load1688SessionStatus() {
    const requestId = ++supplier1688StatusRequestId;
    try {
      const data = await apiRequest("/api/v1/runtime", { timeout: 8000 });
      if (requestId !== supplier1688StatusRequestId) return false;
      apply1688SessionStatus(data?.auth, data?.queue, data?.imageSearchRecovery ?? null);
      return true;
    } catch (error) {
      if (requestId !== supplier1688StatusRequestId) return false;
      const reason = authReasonFromError(error);
      apply1688SessionStatus({
        ready: false,
        checking: false,
        reason,
        message: reason === "service_unavailable" ? authStatusMessage({ reason }) : error.message,
      }, {}, null);
      return false;
    }
  }

  function schedule1688WindowStatusPoll() {
    if (supplier1688WindowPollTimer !== null) return;
    supplier1688WindowPollTimer = window.setTimeout(async () => {
      supplier1688WindowPollTimer = null;
      if (!supplier1688WindowOpen) return;
      if (supplier1688SessionPromise) {
        schedule1688WindowStatusPoll();
        return;
      }
      // Read the companion's local progress only; never verify or submit here.
      await load1688SessionStatus();
    }, 3000);
  }

  async function pauseActive1688ResumeForSession() {
    const pendingResume = supplier1688ResumePromise;
    if (!pendingResume) return false;
    const controller = supplier1688ResumeController;
    if (controller && !controller.signal.aborted) {
      controller.abort(new DOMException("1688 补做已暂停，以便打开专用 Edge。", "AbortError"));
    }
    await pendingResume.catch(() => false);
    return true;
  }

  async function start1688Session({ restart = false, freshLogin = false } = {}) {
    if (supplier1688SessionPromise) return supplier1688SessionPromise;
    await load1688SessionStatus();
    if (supplier1688SessionPromise) return supplier1688SessionPromise;
    supplier1688StatusRequestId += 1;
    const imageSearchVerification = !freshLogin && Boolean(supplier1688RiskTask?.id);
    const purpose = imageSearchVerification ? "image_search" : "login";
    const waitingReason = imageSearchVerification ? "waiting_image_verification" : "waiting_login";
    const pending = Promise.resolve().then(async () => {
      try {
        if (supplier1688ResumePromise) {
          apply1688SessionStatus({
            ready: false,
            checking: true,
            reason: "checking",
            message: "正在安全暂停 1688 补做",
          });
          await pauseActive1688ResumeForSession();
        }
        apply1688SessionStatus({
          ready: false,
          checking: true,
          reason: "starting_service",
          message: imageSearchVerification ? "正在启动 1688 图片搜索验证" : "正在启动 1688 采购助手",
        });
        await ensure1688ServiceAvailable();
        apply1688SessionStatus({
          ready: false,
          checking: true,
          reason: waitingReason,
          message: imageSearchVerification ? "正在打开 1688 图片搜索验证页" : "正在打开专用 Edge",
        });
        const data = await apiRequest("/api/v1/auth/open-login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            purpose,
            // Reuse an active login/verification window, preserving the user's progress.
            restart: restart === true || freshLogin === true,
            ...(freshLogin ? { freshLogin: true } : {}),
            ...(imageSearchVerification ? { taskId: supplier1688RiskTask.id } : {}),
          }),
          timeout: 50000,
        });
        if (data?.pending === true) {
          await load1688SessionStatus();
          showToast("专用 Edge 正在打开，页面加载完成后即可操作；请勿重复启动。", "info", 6200);
          return false;
        }
        if (data?.edgeReady !== true) {
          throw new Error(data?.alreadyRunning
            ? "1688 专用 Edge 尚未创建可见窗口，请稍后重试。"
            : "1688 专用 Edge 未能创建可见窗口，请重试。");
        }
        apply1688SessionStatus({
          ready: false,
          checking: true,
          reason: waitingReason,
          message: imageSearchVerification
            ? data?.alreadyRunning ? "1688 图片验证窗口已打开" : "1688 图片搜索验证页已打开"
            : data?.alreadyRunning ? "专用 Edge 正在等待登录" : "专用 Edge 已打开，等待登录",
        });
        showToast(
          imageSearchVerification
            ? "已打开专用 Edge，系统将提交一次商品图片；如出现验证码请手动完成。验证通过后点击“验证完成，继续搜图”。"
            : freshLogin ? "请使用新的 1688 或淘宝账号扫码登陆；完成后点击“刷新状态”。原有图片验证暂停仍需单独处理。"
            : "请在专用 Edge 中完成 1688 登录；完成后点击“刷新状态”。",
          "info",
          6200,
        );
        return false;
      } catch (error) {
        await load1688SessionStatus();
        showToast(`1688 ${imageSearchVerification ? "图片验证" : "登录"}窗口未就绪：${error.message}${supplier1688LoggedIn && !freshLogin ? "；已有登录身份仍保留。" : ""}`, "error", 6200);
        return false;
      }
    });
    supplier1688SessionPromise = pending;
    try {
      return await pending;
    } finally {
      if (supplier1688SessionPromise === pending) supplier1688SessionPromise = null;
      updateStartAvailability();
    }
  }

  async function resume1688AfterVerification() {
    if (supplier1688SessionPromise || hasActive1688Work()) return false;
    const technicalPause = technical1688Pause();
    const pending = Promise.resolve().then(async () => {
      try {
        const data = await apiRequest("/api/v1/queue/resume", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ confirmed: true }), timeout: 15000,
        });
        apply1688SessionStatus(data?.auth, data?.queue, data?.imageSearchRecovery ?? null);
        showToast(technicalPause ? "已确认继续原任务，搜图队列将按固定间隔继续。" : "图片验证已确认，搜图队列将按固定间隔继续。", "success", 5200);
        if (runState.supplier1688Pipeline?.owner === 'server') return await startServerSupplierPipeline();
        schedule1688StatusPolling();
        return true;
      } catch (error) {
        await load1688SessionStatus().catch(() => {});
        showToast(error.message || (technicalPause ? "搜图进程尚未恢复，原任务继续暂停，请检查本地服务。" : "图片验证尚未完成，搜图继续暂停。"), "info", 6200);
        return false;
      }
    });
    supplier1688SessionPromise = pending;
    try { return await pending; }
    finally { if (supplier1688SessionPromise === pending) supplier1688SessionPromise = null; updateStartAvailability(); }
  }

  async function check1688Session() {
    if (supplier1688SessionPromise) return supplier1688SessionPromise;
    supplier1688StatusRequestId += 1;
    const pending = Promise.resolve().then(async () => {
      try {
        apply1688SessionStatus({ ready: false, checking: true, reason: "starting_service", message: "正在启动 1688 采购助手" });
        await ensure1688ServiceAvailable();
        apply1688SessionStatus({ ready: false, checking: true, reason: "checking", message: "正在在线验证 1688 身份" });
        const data = await apiRequest("/api/v1/runtime?verify=1", { timeout: 30000 });
        apply1688SessionStatus(data?.auth, data?.queue, data?.imageSearchRecovery ?? null);
        const ready = data?.auth?.ready === true;
        if (!ready) {
          showToast(authStatusMessage(data?.auth), "info", 5200);
          return false;
        }
        if (technical1688Pause()) {
          showToast('1688 身份有效；搜图进程中断，断点已保留，请检查服务后点击「检查后继续」。', 'info', 6200);
          return true;
        }
        if (supplier1688RiskTask?.id) {
          if (supplier1688RiskTaskScope === "system") {
            showToast(supplier1688Queue?.ratePolicy?.manualVerificationCompletedAt
              ? "图片验证已完成，请点击「验证完成，继续搜图」恢复队列。"
              : "1688 账号已登录；搜图仍需人工验证，请点击「处理 1688 系统队列验证」。", "info", 6200);
            schedule1688StatusPolling();
            return true;
          }
          showToast("1688 身份有效；当前候选仍需完成图片搜索验证，请点击连接状态旁的「打开 1688 图片搜索验证」按钮。", "info", 6200);
          return true;
        }
        if (supplier1688Queue?.ratePolicy?.pausedReason) {
          showToast(supplier1688Queue.ratePolicy.manualResumeRequired
            ? "1688 账号已登录，但搜图队列仍暂停；未找到可用于验证的原任务，请检查任务记录。"
            : "1688 账号已登录；搜图队列正在冷却，请等待现有等待时间结束。", "info", 6200);
          return true;
        }
        const pendingCount = getPending1688ResumeProducts().length;
        if (!pendingCount) {
          const imageBlocked = Number(supplier1688Queue?.riskBlocked || 0) > 0;
          showToast(imageBlocked
            ? "1688 图片搜索仍需在专用 Edge 完成专项验证。"
            : "1688 在线身份验证通过；当前任务没有因断联待补做的候选。", imageBlocked ? "info" : "success", 5200);
          return true;
        }
        if (supplier1688ResumePromise) {
          const processed = Number(runState.supplier1688Resume?.processed || 0);
          const total = Number(runState.supplier1688Resume?.total || pendingCount);
          showToast(`1688 在线身份有效；补做正在进行 ${processed}/${total}，不会启动第二批。`, "success", 5200);
          return true;
        }
        schedule1688StatusPolling();
        showToast(`1688 在线身份有效；有 ${pendingCount} 个候选待补做。页面只同步状态，请点击「匹配当前筛选」继续。`, "info", 6800);
        return true;
      } catch (error) {
        apply1688SessionStatus({ ready: false, checking: false, reason: authReasonFromError(error), message: error.message });
        showToast(`1688 登录状态检查失败：${error.message}`, "error", 5200);
        return false;
      }
    });
    supplier1688SessionPromise = pending;
    try {
      return await pending;
    } finally {
      if (supplier1688SessionPromise === pending) supplier1688SessionPromise = null;
      updateStartAvailability();
    }
  }

  async function ensure1688ServiceAvailable() {
    const status = await apiRequest("/api/1688/service", { timeout: 5000 });
    if (status?.ready === true) return status;
    if (status?.status === "foreign") {
      const error = new Error(status.message || "本机 16880 端口被其他程序占用。");
      error.code = "PROCUREMENT_CONSOLE_IDENTITY_MISMATCH";
      throw error;
    }
    const recovered = await apiRequest("/api/1688/service/recover", {
      method: "POST",
      timeout: 90000,
    });
    if (recovered?.ready === true) return recovered;
    const error = new Error(recovered?.message || "1688 采购助手启动失败。");
    error.code = "PROCUREMENT_CONSOLE_START_FAILED";
    throw error;
  }

  function current1688ProcurementTaskIds() {
    return new Set(products
      .map((product) => validProcurementTaskId(product?.supplierProcurementTaskId))
      .filter(Boolean));
  }

  function scope1688RuntimeQueue(queue = {}, imageSearchRecovery = null) {
    const currentTaskIds = current1688ProcurementTaskIds();
    const runtimeActiveTasks = Array.isArray(queue?.activeTasks)
      ? queue.activeTasks.map((task) => ({ ...task }))
      : [];
    // AUTH_REQUIRED tasks are stored as failed and omitted from activeTasks.
    // The persisted manual pause still identifies the task needed for verification.
    const pausedTaskId = validProcurementTaskId(queue?.ratePolicy?.blockedTaskId);
    if (queue?.ratePolicy?.manualResumeRequired === true && pausedTaskId
      && ['AUTH_REQUIRED', 'RISK_VERIFICATION_REQUIRED'].includes(queue.ratePolicy.pausedReason)
      && !runtimeActiveTasks.some(task => task.id === pausedTaskId)) {
      runtimeActiveTasks.push({ id: pausedTaskId, status: 'risk_blocked',
        message: '1688 搜图队列仍暂停，请完成原任务的图片搜索验证。' });
    }
    const activeTasks = runtimeActiveTasks.length
      ? runtimeActiveTasks
        .filter((task) => currentTaskIds.has(validProcurementTaskId(task?.id)))
      : [];
    const legacyRiskTask = queue?.riskBlockedTask && currentTaskIds.has(validProcurementTaskId(queue.riskBlockedTask.id))
      ? { ...queue.riskBlockedTask, status: "risk_blocked" }
      : null;
    if (legacyRiskTask && !activeTasks.some((task) => task.id === legacyRiskTask.id)) activeTasks.push(legacyRiskTask);

    const linkedRecovery = imageSearchRecovery
      && currentTaskIds.has(validProcurementTaskId(imageSearchRecovery.taskId))
      ? { ...imageSearchRecovery }
      : null;
    if (linkedRecovery?.state === "waiting" && !activeTasks.some((task) => task.id === linkedRecovery.taskId)) {
      activeTasks.push({
        id: linkedRecovery.taskId,
        status: "risk_blocked",
        message: linkedRecovery.message || "1688 图片搜索需要人工验证。",
      });
    }

    const riskBlockedTask = activeTasks.find((task) => task.status === "risk_blocked") || null;
    const systemRiskBlockedTask = riskBlockedTask
      ? null
      : runtimeActiveTasks.find((task) => task.status === "risk_blocked")
        || (queue?.riskBlockedTask && !currentTaskIds.has(validProcurementTaskId(queue.riskBlockedTask.id))
          ? { ...queue.riskBlockedTask, status: "risk_blocked" }
          : null);
    return {
      queue: {
        ratePolicy: queue?.ratePolicy ? { ...queue.ratePolicy } : null,
        queued: activeTasks.filter((task) => task.status === "queued").length,
        running: activeTasks.filter((task) => task.status === "running").length,
        riskBlocked: activeTasks.filter((task) => task.status === "risk_blocked").length,
        activeTasks,
        riskBlockedTask,
      },
      riskBlockedTask,
      systemRiskBlockedTask,
      imageSearchRecovery: linkedRecovery,
    };
  }

  function apply1688SessionStatus(data = {}, queue, imageSearchRecovery) {
    const reason = String(data.reason || (data.ready === true ? "ready" : "login_required"));
    supplier1688Auth = { ...data };
    if (queue && typeof queue === "object") {
      supplier1688RuntimeQueue = {
        ...queue,
        activeTasks: Array.isArray(queue.activeTasks) ? queue.activeTasks.map((task) => ({ ...task })) : [],
      };
    }
    if (imageSearchRecovery !== undefined) {
      supplier1688ImageSearchRecovery = imageSearchRecovery && typeof imageSearchRecovery === "object"
        ? { ...imageSearchRecovery }
        : null;
    }
    const scopedRuntime = scope1688RuntimeQueue(supplier1688RuntimeQueue, supplier1688ImageSearchRecovery);
    supplier1688Queue = scopedRuntime.queue;
    supplier1688RiskTask = scopedRuntime.riskBlockedTask || scopedRuntime.systemRiskBlockedTask;
    supplier1688RiskTaskScope = scopedRuntime.riskBlockedTask ? "current" : scopedRuntime.systemRiskBlockedTask ? "system" : null;
    const imageBlocked = Boolean(supplier1688RiskTask?.id) || Boolean(supplier1688Queue?.ratePolicy?.pausedReason);
    const technicalPause = technical1688Pause();
    supplier1688LoggedIn = data.ready === true;
    supplier1688Status = supplier1688LoggedIn ? imageBlocked ? technicalPause ? "search_interrupted" : "image_verification_required" : "ready" : data.checking === true ? "checking" : reason;
    supplier1688WindowOpen = data.windowOpen === true || supplier1688RuntimeQueue?.waitingLogin === true
      || ["waiting_login", "waiting_image_verification"].includes(reason);
    if (supplier1688WindowOpen) schedule1688WindowStatusPoll();
    else if (supplier1688WindowPollTimer !== null) {
      window.clearTimeout(supplier1688WindowPollTimer);
      supplier1688WindowPollTimer = null;
    }
    const container = byId("supplier1688Connection");
    if (container) container.dataset.state = supplier1688LoggedIn ? imageBlocked ? "error" : "live" : data.checking === true ? "checking" : ["risk_control", "rate_limited", "verification_failed", "service_unavailable", "identity_mismatch"].includes(reason) ? "error" : "idle";
    const recoveryMessage = scopedRuntime.imageSearchRecovery?.message && scopedRuntime.imageSearchRecovery?.state !== "requeued"
      ? scopedRuntime.imageSearchRecovery.message
      : null;
    const imageSearchPhaseMessage = supplier1688WindowOpen ? {
      waiting_upload_page: "正在识别 1688 图片上传页",
      upload_control_ready: "正在提交商品图片",
      image_selected_waiting_result: "图片已选择，正在等待搜图结果",
      waiting_manual_verification: "1688 正在要求人工验证，请处理专用 Edge 窗口",
      verified_result: "本次图片结果已确认，正在保存验证状态",
    }[data.imageSearchPhase] : null;
    const windowErrorMessage = !supplier1688WindowOpen && data.lastWindowError?.message
      ? ({
          EDGE_STARTUP_TIMEOUT: "Edge 启动连接超时，本次窗口已关闭；验证未完成",
          EDGE_WINDOW_PROOF_TIMEOUT: "Edge 窗口检查超时，本次窗口已关闭；验证未完成",
          EDGE_WINDOW_WRONG_DESKTOP: "Edge 未在当前可操作桌面中通过检查，本次窗口已关闭；验证未完成",
          EDGE_WINDOW_CHECK_FAILED: "Edge 窗口检查程序执行失败，本次窗口已关闭；验证未完成",
          EDGE_WINDOW_NOT_VISIBLE: "程序未确认可操作的 Edge 窗口，本次窗口已关闭；验证未完成",
        }[data.lastWindowError.code] || (data.lastWindowError.code === "LOGIN_ONLINE_VERIFICATION_FAILED"
        ? `1688 在线登录校验未确认${imageBlocked ? "；图片搜索队列保持暂停" : ""}，请重新检查验证状态`
        : `上次窗口处理未完成：${data.lastWindowError.message}`))
      : null;
    const ratePolicy = supplier1688Queue?.ratePolicy;
    const verifiedForResume = Boolean(ratePolicy?.manualVerificationCompletedAt && ratePolicy?.pausedReason);
    render1688SessionStatusMessage(
      (technicalPause ? supplier1688LoggedIn
        ? "搜图进程中断，已保留断点；请检查服务后点击「检查后继续」"
        : "搜图进程中断，已保留断点；请先登录专用 Edge，再检查并继续" : null)
      || imageSearchPhaseMessage || (verifiedForResume ? "图片验证已完成，等待继续搜图" : null)
      || windowErrorMessage || recoveryMessage || (supplier1688LoggedIn && imageBlocked
        ? supplier1688RiskTaskScope === "system" ? "系统队列待图片验证" : "图片搜索待专项验证"
        : data.message || authStatusMessage(data)),
      data.checking === true,
    );
    const loginButton = byId("login1688Button");
    const checkButton = byId("check1688Button");
    const resumeButton = byId("resume1688Button");
    const restartButton = byId("restart1688Button");
    if (restartButton) {
      restartButton.hidden = !supplier1688WindowOpen;
      restartButton.disabled = Boolean(supplier1688SessionPromise);
    }
    if (resumeButton) {
      resumeButton.hidden = !verifiedForResume && !technicalPause;
      resumeButton.textContent = technicalPause ? '检查后继续' : '验证完成，继续搜图';
      resumeButton.disabled = Boolean(supplier1688SessionPromise);
    }
    setText("supplier1688RateText", ratePolicy?.minGapMs
      ? ratePolicy.cooldownEvery > 0 && ratePolicy.cooldownMs > 0
        ? `搜图间隔 ≥ ${Math.ceil(ratePolicy.minGapMs / 1000)} 秒 · 每 ${ratePolicy.cooldownEvery} 次休息 ${Math.ceil(ratePolicy.cooldownMs / 60000)} 分钟`
        : `每 60 分钟最多 ${Math.ceil(3_600_000 / ratePolicy.minGapMs)} 次 · 间隔 ≥ ${Math.ceil(ratePolicy.minGapMs / 10) / 100} 秒`
      : "");
    if (loginButton) {
      const unavailable = reason === "service_unavailable";
      const imageSearchVerification = !technicalPause && Boolean(supplier1688RiskTask?.id);
      const openLabel = imageSearchVerification
        ? supplier1688RiskTaskScope === "system" ? "处理 1688 系统队列验证" : "打开 1688 图片搜索验证"
        : unavailable ? "启动并打开 1688 专用 Edge" : "打开 1688 专用 Edge";
      loginButton.hidden = false;
      loginButton.disabled = Boolean(supplier1688SessionPromise);
      loginButton.setAttribute("aria-label", "连接账号");
      loginButton.title = `连接账号：${openLabel}`;
    }
    if (checkButton) {
      checkButton.hidden = false;
      checkButton.disabled = Boolean(supplier1688SessionPromise);
    }
    updateStartAvailability();
    initIcons();
  }

  function render1688SessionStatusMessage(baseMessage = null, checking = false) {
    const statusText = byId("supplier1688StatusText");
    if (!statusText) return;
    if (baseMessage) {
      statusText.dataset.baseMessage = baseMessage;
      statusText.dataset.checking = String(checking);
    }
    const base = statusText.dataset.baseMessage;
    if (!base) return;
    const pendingResumeCount = getPending1688ResumeProducts().length;
    const pendingResumeNote = pendingResumeCount ? ` · 待补 ${pendingResumeCount} 个` : "";
    const queued = Number(supplier1688Queue?.queued || 0);
    const riskBlocked = Number(supplier1688Queue?.riskBlocked || 0);
    const queueNote = riskBlocked
      ? ` · 图片阻塞 ${riskBlocked} 项${queued ? ` · 排队 ${queued}` : ""}`
      : queued ? ` · 排队 ${queued}` : "";
    const systemRiskNote = !technical1688Pause() && supplier1688RiskTaskScope === "system" && !base.includes("系统队列")
      ? " · 系统队列验证 1 项"
      : "";
    statusText.textContent = `${base}${queueNote}${systemRiskNote}${pendingResumeNote}`;
  }

  function authStatusMessage(auth = {}) {
    if (auth.ready === true) return "已在线验证";
    if (auth.checking === true) {
      if (auth.reason === "waiting_image_verification") return "等待专用 Edge 完成图片搜索验证";
      return auth.reason === "waiting_login" ? "等待专用 Edge 登录" : "正在在线验证";
    }
    const messages = {
      login_required: "需要在专用 Edge 重新登录",
      risk_control: "需要在专用 Edge 完成图片搜索验证",
      rate_limited: "1688 访问受限，请稍后处理",
      verification_failed: "在线身份验证失败",
      service_unavailable: "1688 采购助手未启动，点击登录按钮启动",
      identity_mismatch: "16880 端口被其他程序或不兼容版本占用",
    };
    return messages[auth.reason] || "尚未完成在线身份验证";
  }

  function authReasonFromError(error) {
    const code = String(error?.code || "").toUpperCase();
    if (["LOGIN_REQUIRED", "NOT_LOGGED_IN", "AUTH_REQUIRED", "LOGIN_EXPIRED", "SESSION_EXPIRED"].includes(code)) return "login_required";
    if (code === "RISK_CONTROL" || code === "RISK_VERIFICATION_REQUIRED") return "risk_control";
    if (code === "RATE_LIMITED") return "rate_limited";
    if (code === "PROCUREMENT_CONSOLE_UNAVAILABLE" || code === "PROCUREMENT_CONSOLE_START_FAILED") return "service_unavailable";
    if (code === "PROCUREMENT_CONSOLE_IDENTITY_MISMATCH") return "identity_mismatch";
    return code === "AUTH_CHECKING" ? "checking" : "verification_failed";
  }

  async function loadPersistentWorkspace() {
    const generation = taskContextGeneration;
    try {
      const data = await apiRequest("/api/state", { timeout: 15000 });
      if (storeImportPending || taskReplacementPending || generation !== taskContextGeneration) return true;
      runHistory = Array.isArray(data?.runs) ? data.runs : [];
      amazonConnectionChecks = data?.amazonConnectionChecks && typeof data.amazonConnectionChecks === "object"
        ? data.amazonConnectionChecks
        : {};
      updateSellerSpriteCallCount(data?.totalSellerSpriteCalls);
      if (!data?.latestRun) {
        renderHistoryList();
        renderAmazonConnectionStatus();
        return false;
      }
      restoreRunSnapshot(data.latestRun, { autoResume: true });
      if (runState.supplier1688Pipeline?.owner === 'server' && products.length) showView('results');
      return true;
    } catch (error) {
      renderHistoryList();
      showToast(`历史数据未同步：${error.message}`, "error", 5200);
      return false;
    }
  }

  function restoreRunSnapshot(snapshot, { autoResume = false, persistMigrations = true } = {}) {
    if (!snapshot || typeof snapshot !== "object" || !snapshot.runState || !Array.isArray(snapshot.products)) {
      throw new Error("保存的任务格式无效。");
    }
    const market = MARKET_CONFIGS[String(snapshot.runState.marketplace || "").toUpperCase()];
    if (!market?.enabled) throw new Error("保存任务的站点当前不可用。");

    const restoringDifferentRun = runState.id !== snapshot.runState.id;
    const previousCollectionJob = amazonCollectionJob?.runId === snapshot.runState.id
      ? amazonCollectionJob : currentAmazonCollectionJob();
    activeMarket = market;
    const legacyProfitDefaults = migrateLegacyProfitDefaults(snapshot.costParams, market.code);
    taskExchangeRate = finiteOrNull(snapshot.profitModel?.exchangeRate)
      || finiteOrNull(snapshot.runState.exchangeRate)
      || legacyProfitDefaults.exchangeRate;
    runState = {
      ...createIdleRunState(),
      ...snapshot.runState,
      criteria: snapshot.criteria && typeof snapshot.criteria === "object" ? snapshot.criteria : {},
    };
    const collection = snapshot.amazonCollection || runState.amazonCollectionJob;
    amazonCollectionRevision = snapshot.amazonCollectionRevision ?? runState.amazonCollectionRevision ?? collection?.revision ?? null;
    if (collection?.owner === "server") {
      const { items: _items, ...savedJob } = collection;
      const job = withKnownAmazonWorkerState(savedJob, previousCollectionJob);
      runState.amazonCollectionJob = job;
      if (!amazonCollectionJob || amazonCollectionJob.runId === runState.id) amazonCollectionJob = job;
    }
    products = snapshot.products.filter((product) => product && typeof product === "object");
    const savedProductCount = products.length;
    const profitFormulaRequiresMigration = snapshot.profitModel?.formulaVersion !== PROFIT_FORMULA_VERSION
      || products.some((product) => product.profitInputs?.formulaVersion !== PROFIT_FORMULA_VERSION);
    activeRunCriteria = snapshot.resultCriteria && typeof snapshot.resultCriteria === "object"
      ? { ...snapshot.resultCriteria }
      : { ...(runState.criteria || {}) };
    try {
      const savedDate = window.sessionStorage?.getItem(`scout:amazon-first-available-from:${runState.id}`);
      if (savedDate !== null && savedDate !== undefined) activeRunCriteria.amazonFirstAvailableFrom = savedDate;
    } catch (_) { /* Browser preferences are optional; the task snapshot remains usable. */ }
    activeRunCriteria.amazonFirstAvailableFrom = normalizeISODateOnly(activeRunCriteria.amazonFirstAvailableFrom) || "";
    syncAmazonListingDateControl();
    storeList = snapshot.storeList && typeof snapshot.storeList === "object" ? snapshot.storeList : null;
    if (restoringDifferentRun) { selectedStoreFile = null; failedImportFileDraft = null; asinImportPreview = null; asinPreviewGeneration += 1; asinPreviewPromise = null; }
    activeProductId = null;
    currentVisibleProducts = [];
    analysisRunning = false;
    mergeAnalyzedCandidateProducts(candidateItemsFromDiscoveredSources(snapshot.amazonDiscoveredSources));
    const existingAsins = new Set(products.map((product) => String(product.sourceAsin || product.asin || "").toUpperCase()));
    const newCollectionItems = (Array.isArray(snapshot.amazonCollection?.items) ? snapshot.amazonCollection.items : [])
      .filter((item) => !existingAsins.has(String(item.sourceAsin || item.asin || "").toUpperCase()));
    mergeAnalyzedCandidateProducts(newCollectionItems);
    if (runState.coverage && typeof runState.coverage === "object") {
      runState.coverage = {
        ...runState.coverage,
        discoveredAsins: Math.max(Number(runState.coverage.discoveredAsins || 0), products.length),
        products: products.length,
      };
    }

    renderMarketUi();
    applyStoredCriteriaToInputs(runState.criteria, snapshot.resultsCompleteOnly === true);
    if (storeList?.audit?.marketplace === activeMarket.code) {
      if (restoringDifferentRun) {
        setImportMode(isAsinImport() ? "asins" : "stores");
        if (byId("asinMarketplaceSelect")) byId("asinMarketplaceSelect").value = activeMarket.code;
      }
      setText("uploadedFilename", storeList.fileName || (isAsinImport() ? "历史 ASIN 清单" : "历史店铺清单"));
      renderStoreAuditUi(storeList.audit);
      renderStoreManager({ collapse: true });
      renderSelectedInputSummary();
      setImportStatus(storeList.audit?.invalid ? "warning" : "success", storeList.audit?.invalid ? "有待处理项" : "已恢复");
    } else {
      storeList = null;
      resetStoreAuditUi();
      setImportStatus("warning", "未载入");
    }

    let profitFormulaMigrated = profitFormulaRequiresMigration;
    let amazonPriceMigrated = false;
    products.forEach((product) => {
      if (runState.archivedAt || isAnalysisReadOnly(product)) return;
      if (!product.supplierSource && typeof product.alibabaSource === "string") product.supplierSource = product.alibabaSource;
      delete product.alibabaSource;
      amazonPriceMigrated = invalidateLegacyAmazonPrice(product, { analysisSourceMode: runState.analysisSourceMode }) || amazonPriceMigrated;
      if (!Number.isFinite(product.currentPrice) && !isAmazonPagePrice(product, runState.analysisSourceMode)
        && !hasManualAmazonPrice(product) && !product.priceRevalidation) {
        product.currentPrice = finiteOrNull(product.price30);
      }
      const previousFormulaVersion = product.profitInputs?.formulaVersion || null;
      ensureFulfillmentState(product);
      const previousAutomaticFbaFee = product.manualFbaFee === true ? null : finiteOrNull(product.fbaFee);
      ensureProductProfitInputs(product, legacyProfitDefaults);
      if (previousFormulaVersion !== PROFIT_FORMULA_VERSION) profitFormulaMigrated = true;
      const previousVersionHasOnlyAuMigration = [
        "profit-workbook-airfreight-us2023-domestic-v3",
        "profit-workbook-au-weight-freight-us2023-domestic-v4",
        "profit-workbook-au-flat-fba-rates-v5",
        "profit-workbook-au-2026-weight-fba-rates-v6",
        "profit-workbook-au-2026-smallest-envelope-fba-v7",
      ].includes(previousFormulaVersion);
      const previousVersionHasOnlyFbaMigration = [
        "profit-workbook-au-2026-weight-fba-rates-v6",
        "profit-workbook-au-2026-smallest-envelope-fba-v7",
        "profit-workbook-au-weight-only-fba-v9",
        "profit-workbook-au-ca-envelope-fba-v10",
        "profit-workbook-au-ca-envelope-capped-fba-v11",
      ].includes(previousFormulaVersion);
      // FBA-only upgrades invalidate approval only when the automatic fee actually changes below.
      const formulaChangeAffectsProduct = !previousVersionHasOnlyFbaMigration
        && (!previousVersionHasOnlyAuMigration || product.marketplace === "AU");
      if (previousFormulaVersion !== PROFIT_FORMULA_VERSION && formulaChangeAffectsProduct && product.reviewStatus === "approved") {
        product.reviewStatus = "pending";
      }
      ensureFulfillmentState(product);
      assumeFbaForWeightedProduct(product);
      refreshProductWeightState(product);
      migrateSupplierSimilarityPolicy(product);
      const previousSalePrice = finiteOrNull(product.salePrice);
      const restoredSalePrice = calculateOurSalePrice(product);
      const automaticSalePriceChanged = product.manualSalePrice !== true
        && (previousSalePrice === null
          ? restoredSalePrice !== null
          : restoredSalePrice === null || roundMoney(previousSalePrice) !== restoredSalePrice);
      if (product.reviewStatus === "approved" && automaticSalePriceChanged) product.reviewStatus = "pending";
      product.salePrice = restoredSalePrice;
      refreshSupplierTarget(product);
      applyAutomaticFba(product);
      const restoredAutomaticFbaFee = product.manualFbaFee === true ? null : finiteOrNull(product.fbaFee);
      const automaticFbaChanged = previousAutomaticFbaFee === null
        ? restoredAutomaticFbaFee !== null
        : restoredAutomaticFbaFee === null || Math.abs(previousAutomaticFbaFee - restoredAutomaticFbaFee) > 0.005;
      if (product.reviewStatus === "approved" && automaticFbaChanged) product.reviewStatus = "pending";
      rebuildProductMissing(product);
      updateProductComputed(product);
    });
    const supplierPipelineMigrated = runState.archivedAt ? false : restoreSupplier1688Pipeline();
    const recoveredAmazonErrorsReconciled = runState.archivedAt ? false : reconcileRecoveredAmazonProductErrors();
    restorePending1688RiskStatus();
    setDataMode(
      runState.mode === "mock" ? "mock" : isProxyAnalysis(runState) || runState.mode === "mixed" ? "mixed" : runState.mode === "error" ? "error" : "live",
      runState.mode === "error" ? "历史任务未完成" : dataModeLabel(runState),
    );
    renderResults();
    renderRunCoverage();
    updateHistorySummary();
    updateStartAvailability();
    initIcons();
    renderAmazonCollection();
    if (persistMigrations && !runState.archivedAt && !currentAmazonCollectionJob() && (products.length > savedProductCount || profitFormulaMigrated || amazonPriceMigrated || supplierPipelineMigrated || recoveredAmazonErrorsReconciled)) {
      setTimeout(() => void persistCurrentRun({ notify: true }), 0);
    }
    if (autoResume && !runState.archivedAt) scheduleAmazonRunResume();
  }

  function restoreSupplier1688Pipeline() {
    const existing = runState.supplier1688Pipeline;
    const knownProductIds = new Set(products.map((product) => product.id));
    let changed = false;

    products.forEach((product) => {
      const status = String(product.supplierSearchStatus || "not_started");
      const hasSupplierEvidence = Boolean(product.supplierProcurementTaskId)
        || Boolean(product.supplierRuleVersion)
        || Boolean(product.supplierSource)
        || (Array.isArray(product.suppliers) && product.suppliers.length > 0);
      if (!hasSupplierEvidence && ["not_started", "pending", "not_logged_in"].includes(status)) {
        if (status === "not_started" && product.supplierSearchStatus === "not_started") return;
        product.supplierSearchStatus = "not_started";
        product.supplierSearchError = null;
        product.supplierSearchErrorCode = null;
        changed = true;
      }
    });

    if (existing && typeof existing === "object" && Array.isArray(existing.productIds)) {
      const productIds = [...new Set(existing.productIds.map(String))].filter((id) => knownProductIds.has(id));
      const normalized = {
        ...existing,
        version: 2,
        status: existing.owner !== 'server' && existing.status === "running" ? "paused" : String(existing.status || "paused"),
        selectionId: String(existing.selectionId || `selection-${runState.id || Date.now()}`),
        scope: String(existing.scope || "confirmed_amazon_filters"),
        criteria: existing.criteria && typeof existing.criteria === "object" ? { ...existing.criteria } : {},
        productIds,
        selectedCount: Number(existing.selectedCount ?? productIds.length),
        matchableCount: Number(existing.matchableCount ?? productIds.length),
        processed: Math.max(0, Number(existing.processed || 0)),
        remaining: Math.max(0, Number(existing.remaining ?? productIds.length)),
        startedAt: existing.startedAt || null,
        updatedAt: existing.updatedAt || new Date().toISOString(),
        completedAt: existing.completedAt || null,
        lastReason: existing.owner !== 'server' && existing.status === "running" ? "page_reloaded" : existing.lastReason || null,
      };
      if (JSON.stringify(existing) !== JSON.stringify(normalized)) changed = true;
      runState.supplier1688Pipeline = normalized;
      return changed;
    }

    const legacyStartedIds = products
      .filter((product) => Boolean(product.supplierProcurementTaskId)
        || ["searching", "queue_waiting", "session_expired"].includes(String(product.supplierSearchStatus || "")))
      .map((product) => product.id);
    if (!legacyStartedIds.length) {
      if (existing !== null && existing !== undefined) changed = true;
      runState.supplier1688Pipeline = null;
      return changed;
    }

    const now = new Date().toISOString();
    runState.supplier1688Pipeline = {
      version: 2,
      status: "paused",
      selectionId: `legacy-${runState.id || Date.now()}`,
      scope: "legacy_started_only",
      criteria: {},
      productIds: [...new Set(legacyStartedIds)],
      selectedCount: legacyStartedIds.length,
      matchableCount: legacyStartedIds.length,
      processed: 0,
      remaining: legacyStartedIds.length,
      startedAt: runState.startedAt || null,
      updatedAt: now,
      completedAt: null,
      lastReason: "legacy_started_batch",
    };
    return true;
  }

  function candidateItemsFromDiscoveredSources(sources) {
    const candidates = new Map();
    (Array.isArray(sources) ? sources : []).forEach((source) => {
      if (!source || typeof source !== "object") return;
      const marketplace = String(source.marketplace || runState.marketplace || activeMarket.code).trim().toUpperCase();
      const sourceStore = {
        sellerId: String(source.sellerId || "").trim() || null,
        sellerName: String(source.sellerName || "").trim() || null,
        storeIndex: Number.isInteger(source.storeIndex) ? source.storeIndex : null,
        rowNumbers: Array.isArray(source.rowNumbers) ? source.rowNumbers : [],
      };
      (Array.isArray(source.asins) ? source.asins : []).forEach((value) => {
        const asin = String(value || "").trim().toUpperCase();
        if (!/^[A-Z0-9]{10}$/.test(asin)) return;
        const key = `${marketplace}:${asin}`;
        const existing = candidates.get(key);
        if (existing) {
          existing.sourceStores = mergeSourceStores(existing.sourceStores, [sourceStore]);
          return;
        }
        candidates.set(key, {
          id: key,
          marketplace,
          sourceMarketplace: marketplace,
          analysisSourceMode: runState.criteria?.useSellerSprite === true ? "amazon_sellsprite" : "amazon_only",
          asin,
          sourceAsin: asin,
          sourceAsins: [asin],
          parentAsin: null,
          parentResolved: false,
          sellerId: sourceStore.sellerId,
          sellerName: sourceStore.sellerName,
          sourceStores: [sourceStore],
          detailStatus: "pending",
          detailErrorCode: "AMAZON_DETAIL_PENDING",
          detailError: "Amazon 商品详情等待抓取。",
          detailRetryable: true,
          dataSource: "amazon-store-checkpoint",
          sourceTool: "amazon_store_checkpoint",
          collectedAt: source.collectedAt || runState.updatedAt || new Date().toISOString(),
        });
      });
    });
    return [...candidates.values()];
  }

  function amazonRunNeedsResume() {
    if (!runState.id || runState.analysisSourceMode !== "amazon_only") return false;
    if (runState.criteria?.useSellerSprite === true || !storeList?.stores?.some(isStoreActionable)) return false;
    const hasPendingPipeline = (runState.amazonPipeline?.stores || [])
      .some((entry) => ["pending", "waiting", "discovered"].includes(entry?.status));
    const hasPendingDetails = products.some(amazonProductNeedsDetailRepair);
    if (runState.completedAt && !hasPendingPipeline && !hasPendingDetails) return false;
    return true;
  }

  function scheduleAmazonRunResume() {
    // The service owns recovery. Restoring a page must never start or resume work.
    if (currentAmazonCollectionJob() || hasOtherActiveCollection()) scheduleAmazonCollectionPoll(0);
  }

  function migrateSupplierSimilarityPolicy(product) {
    if (isAnalysisReadOnly(product)) return;
    const suppliers = Array.isArray(product.suppliers) ? product.suppliers : [];
    const has1688Evidence = Boolean(product.supplierRuleVersion)
      || suppliers.length > 0
      || String(product.supplierSource || "").includes("1688");
    if (!has1688Evidence) return;
    const demoPolicyVerified = product.dataMode === "mock"
      && product.supplierSource === "1688-demo";
    const policyVerified = product.supplierRuleVersion === SUPPLIER_RULE_VERSION
      && (demoPolicyVerified || suppliers.every(supplierEvidenceMatchesCurrentPolicy));
    if (policyVerified) return;

    const audit = product.supplierSearchAudit && typeof product.supplierSearchAudit === "object"
      ? { ...product.supplierSearchAudit }
      : {};
    if (!audit.legacyCalculation) {
      audit.legacyCalculation = {
        ruleVersion: product.supplierRuleVersion || null,
        supplierAverageCny: finiteOrNull(product.supplierAverageCny),
        supplierProfitable: typeof product.supplierProfitable === "boolean" ? product.supplierProfitable : null,
        roughMargin: finiteOrNull(product.roughMargin),
        capturedAt: new Date().toISOString(),
      };
    }
    product.supplierSearchAudit = audit;
    product.suppliers = suppliers.map((supplier, index) => {
      const normalized = normalize1688Quote(supplier, index);
      if (!normalized) return null;
      const imageScore = validMatchScore(supplier?.imageSimilarityScore);
      const imageDecision = imageScore === null
        ? "unavailable"
        : imageScore > MIN_IMAGE_SIMILARITY_SCORE ? "passed" : "below_threshold";
      return {
        ...normalized,
        legacyIncluded: Boolean(supplier?.included),
        included: false,
        imageSimilarityScore: imageScore,
        imageSimilarityDecision: imageDecision,
        supplierMatchDecision: imageDecision,
        excludedReason: imageDecision === "below_threshold" ? "image_similarity_below_threshold" : "image_similarity_unavailable",
      };
    }).filter(Boolean);
    product.supplierSearchStatus = "similarity_unverified";
    product.supplierSearchError = "历史 1688 报价使用旧商品匹配规则，请重新匹配后再用于自动利润。";
    product.supplierCostMode = null;
    product.supplierCostConfidence = null;
    product.supplierSimilarity = {
      threshold: MIN_IMAGE_SIMILARITY_SCORE,
      operator: IMAGE_SIMILARITY_OPERATOR,
      evaluatedCount: product.suppliers.filter((supplier) => supplier.imageSimilarityScore !== null).length,
      imageQualifiedCount: product.suppliers.filter((supplier) => supplier.imageSimilarityDecision === "passed").length,
      qualifiedCount: 0,
      method: null,
      version: null,
    };
    if (isManualCostProduct(product)) return;
    product.supplierAverageCny = null;
    product.supplierProfitable = null;
    product.roughMargin = null;
    product.purchaseUnitCostCny = null;
    product.purchaseCost = null;
    if (product.reviewStatus === "approved") product.reviewStatus = "pending";
    if (!Array.isArray(product.missing)) product.missing = [];
    if (!product.missing.includes("利润计算参数")) product.missing.push("利润计算参数");
  }

  function migrateLegacyProfitDefaults(value, marketCode) {
    const defaults = getDefaultProfitInputs(marketCode);
    if (!value || typeof value !== "object") return defaults;
    const legacyMap = {
      exchangeRate: "exchangeRate",
      commission: "commissionRate",
      fxLoss: "fxLossRate",
      marketing: "marketingRate",
      management: "managementRate",
      returns: "returnsRate",
      freightRate: "airFreightRateCnyPerKg",
    };
    for (const [legacyKey, currentKey] of Object.entries(legacyMap)) {
      const number = finiteOrNull(value[legacyKey]);
      const isLegacyAuAirFreightDefault = (marketCode === "AU" || marketCode === "CA")
        && currentKey === "airFreightRateCnyPerKg"
        && (number === DEFAULT_PROFIT_RATES.airFreightRateCnyPerKg || number === 60);
      const isLegacyAuOperatingRate = marketCode === "AU" || marketCode === "CA"
        ? ((currentKey === "managementRate" && marketCode === "AU" && number === DEFAULT_PROFIT_RATES.managementRate)
          || (currentKey === "returnsRate" && (number === DEFAULT_PROFIT_RATES.returnsRate || number === 10))
          || (currentKey === "commissionRate" && marketCode === "AU" && number === DEFAULT_PROFIT_RATES.commissionRate))
        : false;
      if (number !== null && number >= 0 && !isLegacyAuAirFreightDefault && !isLegacyAuOperatingRate) defaults[currentKey] = number;
    }
    if (defaults.exchangeRate <= 0) defaults.exchangeRate = MARKET_CONFIGS[marketCode]?.defaultExchangeRate || activeMarket.defaultExchangeRate;
    return defaults;
  }

  function applyStoredCriteriaToInputs(criteria = {}, completeOnly = false) {
    const useSellerSprite = typeof criteria.useSellerSprite === "boolean"
      ? criteria.useSellerSprite
      : false;
    if (byId("useSellerSpriteToggle")) byId("useSellerSpriteToggle").checked = useSellerSprite;
    if (byId("monthlySalesBand")) {
      const restoredMonthlySalesBand = criteria.monthlySalesBand;
      // Preserve explicit sales selections; ASIN "all" includes low and unknown sales.
      byId("monthlySalesBand").value = ["all", "50_plus", "50_to_100", "100_plus"].includes(restoredMonthlySalesBand)
        ? restoredMonthlySalesBand
        : "all";
      activeRunCriteria.monthlySalesBand = byId("monthlySalesBand").value;
      if (runState.criteria && typeof runState.criteria === "object") runState.criteria.monthlySalesBand = byId("monthlySalesBand").value;
    }
    if (byId("minReviews")) byId("minReviews").value = criteria.minReviews ?? "";
    if (byId("maxReviews")) byId("maxReviews").value = criteria.maxReviews ?? "";
    if (byId("minRating")) byId("minRating").value = criteria.minRating ?? "";
    if (byId("completeOnlyToggle")) byId("completeOnlyToggle").checked = completeOnly;
    if (byId("resultsCompleteToggle")) byId("resultsCompleteToggle").checked = completeOnly;
    if (byId("resultMinMargin")) byId("resultMinMargin").value = "";
    renderMonthlySalesAdmission();
    updateStartAvailability();
  }

  function syncAmazonListingDateControl() {
    const input = byId("amazonFirstAvailableFrom");
    if (input) {
      input.max = todayDateOnly();
      input.value = activeRunCriteria.amazonFirstAvailableFrom || "";
    }
  }

  function saveAmazonListingDatePreference() {
    if (!runState.id) return;
    try { window.sessionStorage?.setItem(`scout:amazon-first-available-from:${runState.id}`, activeRunCriteria.amazonFirstAvailableFrom || ""); }
    catch (_) { /* Do not block filtering if browser preference storage is unavailable. */ }
  }

  function requestedAmazonListingDateFilter() {
    const value = byId("amazonFirstAvailableFrom")?.value || "";
    if (value && (!normalizeISODateOnly(value) || value > todayDateOnly())) {
      showToast("请选择不晚于今天的有效上架起始日期。", "error", 4200);
      return null;
    }
    return value;
  }

  function applyAmazonListingDateFilter() {
    const value = requestedAmazonListingDateFilter();
    if (value === null) return false;
    activeRunCriteria = { ...activeRunCriteria, amazonFirstAvailableFrom: value };
    saveAmazonListingDatePreference();
    resultPage = 1;
    renderResults();
    return true;
  }

  function captureRunSnapshot() {
    return {
      ...(amazonCollectionRevision === null ? {} : { amazonCollectionRevision }),
      runState: { ...runState, criteria: { ...(runState.criteria || {}) } },
      products,
      criteria: { ...(runState.criteria || {}) },
      resultCriteria: { ...activeRunCriteria },
      storeList,
      profitModel: { formulaVersion: PROFIT_FORMULA_VERSION, exchangeRate: taskExchangeRate },
      resultsCompleteOnly: byId("resultsCompleteToggle")?.checked ?? false,
    };
  }

  async function persistCurrentRun({ notify = false, onSettled = null } = {}) {
    if (isCollectionWriteLocked()) {
      persistenceLastError = createRunError("COLLECTION_MANAGED_READ_ONLY", "后台任务正在管理本任务数据，已停止页面快照写入。");
      if (notify) collectionWriteBlocked();
      return false;
    }
    if (!runState.id || runState.mode === "idle") {
      persistenceLastError = createRunError("INVALID_RUN_STATE", "当前任务尚未初始化，无法保存断点。");
      return false;
    }
    let body;
    try {
      body = JSON.stringify(captureRunSnapshot());
    } catch (error) {
      persistenceLastError = createRunError("SNAPSHOT_SERIALIZATION_FAILED", error?.message || "任务结果无法序列化。");
      if (notify) showToast("任务结果无法序列化，尚未保存。", "error", 5200);
      return false;
    }
    const savedRunId = runState.id;
    const savedCollectionRevision = amazonCollectionRevision;
    const save = () => {
      if (savedRunId !== runState.id || isCollectionWriteLocked()) throw createRunError("COLLECTION_MANAGED_READ_ONLY", "任务状态已改变，旧页面快照未写入。");
      if (savedCollectionRevision !== amazonCollectionRevision) throw createRunError("STALE_COLLECTION_SNAPSHOT", "后台采集结果已更新，旧页面快照未写入。");
      return apiRequest("/api/runs", { method: "POST", headers: { "Content-Type": "application/json" }, body, timeout: 120000 });
    };
    const pending = persistenceSaveQueue.then(save, save);
    persistenceSaveQueue = pending.catch(() => {});
    try {
      const data = await pending;
      onSettled?.();
      runHistory = Array.isArray(data?.runs) ? data.runs : runHistory;
      updateSellerSpriteCallCount(data?.totalSellerSpriteCalls);
      if (data?.summary?.id === runState.id) {
        runState.sellerSpriteCalls = Number(data.summary.sellerSpriteCalls || 0);
        runState.sellerSpriteCallsByTool = data.summary.sellerSpriteCallsByTool || {};
      }
      persistenceErrorShown = false;
      persistenceLastError = null;
      updateHistorySummary();
      return true;
    } catch (error) {
      onSettled?.();
      persistenceLastError = error;
      if (error?.code === "STALE_COLLECTION_SNAPSHOT") {
        // Finish an older read before requesting the post-conflict canonical state.
        if (amazonCollectionSnapshotPromise) await amazonCollectionSnapshotPromise.catch(() => {});
        await refreshAmazonCollectionSnapshot().catch(() => {});
        persistenceLastError = error;
      }
      if (notify || !persistenceErrorShown) {
        showToast(`任务结果未保存：${error.message}`, "error", 6200);
        persistenceErrorShown = true;
      }
      return false;
    }
  }

  async function loadHistoryRun(runId, button) {
    if (!runId) return;
    if (storeImportPending || taskReplacementPending || analysisRunning || hasActive1688Work() || exportRunning || analysisVersionPendingIds.size) {
      showToast("当前采集、匹配或保存尚未结束，完成后可载入历史任务。", "info", 4800);
      return;
    }
    const generation = taskContextGeneration;
    if (button) button.disabled = true;
    try {
      const snapshot = await apiRequest(`/api/runs/${encodeURIComponent(runId)}`, { timeout: 30000 });
      if (storeImportPending || taskReplacementPending || generation !== taskContextGeneration) return;
      restoreRunSnapshot(snapshot);
      showView("results");
      showToast(`已恢复 ${products.length} 个历史候选商品。`, "success");
    } catch (error) {
      showToast(`历史任务载入失败：${error.message}`, "error", 5200);
    } finally {
      if (button?.isConnected) button.disabled = false;
    }
  }

  async function openHistoryRunFolder(runId, button) {
    if (!runId) return;
    if (button) {
      button.disabled = true;
      button.setAttribute("aria-busy", "true");
    }
    try {
      await apiRequest(`/api/runs/${encodeURIComponent(runId)}/open-folder`, {
        method: "POST",
        timeout: 15000,
      });
      showToast("已打开任务文件夹，并定位到对应记录文件。", "success");
    } catch (error) {
      const messageByCode = {
        RUN_ARTIFACT_NOT_FOUND: "该任务的记录文件已被移动或删除。",
        RUN_ARTIFACT_UNAVAILABLE: "该任务记录暂时无法访问。",
        EXPLORER_NOT_SUPPORTED: "当前系统不支持自动打开任务文件夹。",
        EXPLORER_OPEN_FAILED: "Windows 资源管理器未能打开，请稍后重试。",
      };
      showToast(messageByCode[error.code] || `任务文件夹打开失败：${error.message}`, "error", 5200);
    } finally {
      if (button?.isConnected) {
        button.disabled = false;
        button.removeAttribute("aria-busy");
      }
    }
  }

  async function loadSellerSpriteConfiguration() {
    try {
      const data = await apiRequest("/api/sellsprite/status", { timeout: 15000 });
      sellerSpriteConfiguration = data.configuration || null;
      sellerSpriteCapabilities = data.capabilities || null;
      updateSellerSpriteCallCount(data.toolCallCount, data.sessionToolCallCount);
      if (sellerSpriteStatus === "idle") {
        setConnectionState("idle", sellerSpriteConfiguration?.configured === false
          ? "未配置 · Amazon 可用" : "待手动连接");
      }
      renderSellerSpriteSetupStatus();
      return data;
    } catch { return null; }
  }

  function renderSellerSpriteSetupStatus() {
    const supported = sellerSpriteCapabilities?.supportedMarketplaces;
    const notes = [];
    if (Array.isArray(supported) && !supported.includes(activeMarket.code)) notes.push(`当前 SellerSprite 接口不支持 ${activeMarket.code} 月销量，不能使用其他站点替代；请保持 Amazon 模式。`);
    if (sellerSpriteConfiguration?.configured === false) notes.push("本机未配置 SellerSprite，可关闭接入开关正常使用 Amazon 模式；需要时再配置程序的 SellerSprite 连接。");
    if (!notes.length) notes.push("开启后按同一站点和 ASIN 查询近 30 天销量；关闭时仅读取 Amazon 购买量提示。未取得销量的商品标记为未知。");
    setText("sellerSpriteSetupStatus", notes.join(" "));
  }

  async function checkSellerSpriteConnection() {
    if (byId("useSellerSpriteToggle")?.checked !== true) {
      showToast("请先开启“接入 SellerSprite”，再主动点击连接。", "info", 4500);
      return false;
    }
    if (sellerSpriteCheckPromise) return sellerSpriteCheckPromise;
    const checkPromise = Promise.resolve().then(async () => {
      sellerSpriteStatus = "checking";
      setConnectionState("checking", "正在连接…");
      setDataMode("checking", "连接中");
      updateStartAvailability();
      try {
        await loadSellerSpriteConfiguration();
        const data = await apiRequest("/api/sellsprite/connect", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ confirmed: true, marketplace: activeMarket.code }), timeout: 45000,
        });
        sellerSpriteCapabilities = data.capabilities || sellerSpriteCapabilities;
        const tools = Array.isArray(data.tools) ? data.tools : [];
        const requiredTools = ["competitor_lookup"];
        const missingTools = requiredTools.filter((tool) => !tools.includes(tool));
        if (missingTools.length) {
          const toolError = new Error(`SellerSprite 当前未提供所需工具：${missingTools.join("、")}。`);
          toolError.code = "SELLSPRITE_TOOL_UNAVAILABLE";
          throw toolError;
        }
        sellerSpriteStatus = "live";
        setConnectionState("live", "已连接");
        if (activeMarket.code === "NL") {
          setDataMode("mixed", runState.providerMode === "proxy" ? dataModeLabel(runState) : "DE 代理待命");
        } else {
          setDataMode(runState.mode === "mock" ? "mock" : runState.mode === "mixed" ? "mixed" : "live", runState.mode === "mock" ? "模拟数据" : runState.mode === "mixed" ? "混合估算" : "实时数据");
        }
        hideProgressError();
        updateStartAvailability();
        return true;
      } catch (error) {
        sellerSpriteStatus = "error";
        const presentation = sellerSpriteConnectionPresentation(error);
        showToast(presentation.message, "error", 8000);
        renderSellerSpriteSetupStatus();
        setConnectionState("error", presentation.status);
        setDataMode("error", "数据源异常");
        updateStartAvailability();
        showProgressError(presentation.title, presentation.message, {
          action: "connect",
          actionLabel: "重新连接",
          showDemo: true,
        });
        return false;
      }
    });

    sellerSpriteCheckPromise = checkPromise;
    try {
      return await checkPromise;
    } finally {
      if (sellerSpriteCheckPromise === checkPromise) {
        sellerSpriteCheckPromise = null;
      }
    }
  }

  function sellerSpriteConnectionPresentation(error) {
    const code = String(error?.code || "SELLSPRITE_UNAVAILABLE").toUpperCase();
    const presentations = {
      SELLSPRITE_MARKETPLACE_UNSUPPORTED: {
        status: "站点未支持", title: "当前站点暂无 SellerSprite 月销量接口",
        message: error?.message || "该接口不支持当前站点，请关闭接入开关使用 Amazon 页面数据。",
      },
      SELLSPRITE_CONNECT_REQUIRED: {
        status: "等待连接", title: "请主动连接 SellerSprite",
        message: "请先开启接入开关并点击连接；页面刷新和后台巡检不会自动建立授权会话。",
      },
      SELLSPRITE_AUTH_FAILED: {
        status: "授权被拒绝",
        title: "SellerSprite MCP 授权被拒绝",
        message: "SellerSprite 未接受程序配置的密钥或工具权限，请检查本地配置后再点击连接。",
      },
      SELLSPRITE_CONFIG_INVALID: {
        status: "配置不可用",
        title: "SellerSprite MCP 配置不可用",
        message: "程序的 SellerSprite MCP 地址或密钥配置缺失，请修正本地配置后再点击连接；关闭接入开关可使用 Amazon 模式。",
      },
      SELLSPRITE_NETWORK_ERROR: {
        status: "连接失败",
        title: "SellerSprite MCP 网络连接失败",
        message: "本机暂时无法通过 HTTPS 访问 SellerSprite，请检查网络后再点击连接。",
      },
      SELLSPRITE_TIMEOUT: {
        status: "连接超时",
        title: "SellerSprite MCP 连接超时",
        message: "SellerSprite 未在规定时间内响应，请稍后再点击连接。",
      },
      SELLSPRITE_REDIRECT_REJECTED: {
        status: "地址异常",
        title: "SellerSprite MCP 地址异常",
        message: "SellerSprite 返回了跨域或非 HTTPS 跳转。为防止密钥泄露，系统已拒绝连接。",
      },
      SELLSPRITE_REDIRECT_LIMIT: {
        status: "地址异常",
        title: "SellerSprite MCP 地址异常",
        message: "SellerSprite 返回了多次跳转，请检查程序配置的最终 MCP 地址。",
      },
      SELLSPRITE_TOOL_UNAVAILABLE: {
        status: "工具缺失",
        title: "SellerSprite MCP 工具不可用",
        message: error?.message || "SellerSprite 当前未提供本任务所需的接口。",
      },
    };
    return presentations[code] || {
      status: "连接失败",
      title: "SellerSprite MCP 连接失败",
      message: "连接检查未完成，请稍后再点击连接。",
    };
  }

  function renderAmazonConnectionStatus(visits = runState.storeVisits || []) {
    const entries = amazonStoreVisitsForDisplay(
      Array.isArray(visits) ? visits.filter((visit) => visit && typeof visit === "object") : [],
    );
    if (amazonCheckPromise) {
      setAmazonConnectionState("checking", "正在检查 Amazon…", "仅验证 Amazon 店铺访问，不会调用 SellerSprite。");
      return;
    }
    if (analysisRunning && !entries.length) {
      setAmazonConnectionState("checking", "正在访问 Amazon…");
      return;
    }
    if (isAsinImport()) {
      const returned = Number(runState.coverage?.detailReturned || 0);
      setAmazonConnectionState(returned ? "live" : "idle", `ASIN 直接采集 · 已取得 ${returned} 个详情`, "已导入 ASIN，直接访问商品详情页；采集进度和访问验证状态见采集监查。无需枚举店铺。");
      return;
    }
    const savedCheck = amazonConnectionChecks?.[activeMarket.code];
    const taskObservedAt = runState.completedAt || runState.startedAt;
    const savedCheckTime = Date.parse(savedCheck?.checkedAt || "");
    const taskObservedTime = Date.parse(taskObservedAt || "");
    if (savedCheck
      && Number.isFinite(savedCheckTime)
      && (!Number.isFinite(taskObservedTime) || savedCheckTime >= taskObservedTime)) {
      renderSavedAmazonConnectionCheck(savedCheck);
      return;
    }
    if (!entries.length) {
      setAmazonConnectionState("idle", "未检查");
      return;
    }

    const prefilled = entries.filter((visit) => visit.status === "not_required");
    const successful = entries.filter((visit) => ["visited", "empty"].includes(visit.status));
    const waiting = entries.filter((visit) => ["waiting", "pending"].includes(visit.status));
    const failed = entries.filter((visit) => visit.status === "failed");
    const interrupted = successful.filter((visit) => visit.interruption?.code);
    const discoveredAsins = entries.reduce((total, visit) => total + Number(visit.discoveredAsins || 0), 0);
    const firstIssue = failed[0] || interrupted[0] || waiting[0] || null;
    const issueDetail = firstIssue?.message
      || firstIssue?.interruption?.message
      || (firstIssue?.code || firstIssue?.interruption?.code ? storeVisitErrorLabel(firstIssue.code || firstIssue.interruption.code) : "");
    const observedAt = runState.completedAt || runState.startedAt;
    const observedDate = observedAt ? new Date(observedAt) : null;
    const observedLabel = observedDate && !Number.isNaN(observedDate.getTime())
      ? `最近访问：${observedDate.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false })}`
      : "";
    const regionLabel = amazonDeliveryRegionLabel(successful.find((visit) => visit.deliveryRegionReady === true));
    const detail = [issueDetail, regionLabel, observedLabel].filter(Boolean).join(" · ");

    if (prefilled.length === entries.length) {
      setAmazonConnectionState("idle", `任务未访问 · ${discoveredAsins} 个预填 ASIN`, ["本次店铺清单直接提供了 ASIN，无需访问 Amazon 店铺页。", observedLabel].filter(Boolean).join(" · "));
    } else if (waiting.length) {
      const counts = [`${successful.length} 成功`, `${waiting.length} 等待`];
      if (failed.length || interrupted.length) counts.push(`${failed.length + interrupted.length} 异常`);
      setAmazonConnectionState("mixed", `任务续跑中 · ${counts.join(" / ")}`, detail);
    } else if (successful.length && (failed.length || interrupted.length)) {
      setAmazonConnectionState("mixed", `任务部分可用 · ${successful.length} 成功 / ${failed.length + interrupted.length} 异常`, detail);
    } else if (successful.length) {
      setAmazonConnectionState("live", `任务最近成功 · ${successful.length} 店 / ${discoveredAsins} ASIN`, [regionLabel, observedLabel].filter(Boolean).join(" · "));
    } else {
      const code = firstIssue?.code || firstIssue?.interruption?.code;
      setAmazonConnectionState("error", `历史任务失败 · ${storeVisitErrorLabel(code)}`, detail);
    }
  }

  function renderSavedAmazonConnectionCheck(check) {
    const checkedDate = new Date(check.checkedAt);
    const checkedLabel = Number.isNaN(checkedDate.getTime())
      ? ""
      : `检查时间：${checkedDate.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false })}`;
    if (check.ready === true) {
      const sampleNote = check.empty === true ? "店铺明确为空" : `抽样发现 ${Number(check.discoveredAsins || 0)} 个 ASIN`;
      setAmazonConnectionState(
        "live",
        "当前可用 · 店铺已验证",
        [`Seller ${check.sellerId}`, sampleNote, amazonDeliveryRegionLabel(check), "未调用 SellerSprite", checkedLabel].filter(Boolean).join(" · "),
      );
      return;
    }
    setAmazonConnectionState(
      "error",
      `当前失败 · ${storeVisitErrorLabel(check.code)}`,
      [check.message, `Seller ${check.sellerId}`, checkedLabel].filter(Boolean).join(" · "),
    );
  }

  async function refreshAmazonConnection() {
    if (amazonCheckPromise) return amazonCheckPromise;
    const store = (storeList?.stores || []).find((item) => {
      const marketplace = String(item?.marketplace || activeMarket.code).toUpperCase();
      return marketplace === activeMarket.code && /^[A-Z0-9]{8,20}$/.test(String(item?.sellerId || "").toUpperCase());
    });
    if (!store) {
      setAmazonConnectionState("idle", "请先导入有效店铺");
      showToast("请先导入含 Seller ID 的当前站点店铺。", "error", 4200);
      return false;
    }

    const marketplace = activeMarket.code;
    const sellerId = String(store.sellerId).toUpperCase();
    const controller = new AbortController();
    amazonCheckController = controller;
    const checkPromise = apiRequest("/api/amazon/check", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ marketplace, sellerId }),
      signal: controller.signal,
      timeout: 90000,
    });
    amazonCheckPromise = checkPromise;
    setAmazonConnectionState("checking", "正在检查 Amazon…", "仅验证一页店铺访问，不会调用 SellerSprite。");
    updateStartAvailability();

    try {
      const result = await checkPromise;
      amazonConnectionChecks = { ...amazonConnectionChecks, [marketplace]: result };
      showToast(
        result.ready === true ? "Amazon 店铺访问正常。" : `Amazon 检查失败：${storeVisitErrorLabel(result.code)}`,
        result.ready === true ? "success" : "error",
        result.ready === true ? 3200 : 5200,
      );
      return result.ready === true;
    } catch (error) {
      if (controller.signal.aborted) return false;
      showToast(`Amazon 检查失败：${error.message}`, "error", 5200);
      return false;
    } finally {
      if (amazonCheckPromise === checkPromise) amazonCheckPromise = null;
      if (amazonCheckController === controller) amazonCheckController = null;
      renderAmazonConnectionStatus();
      updateStartAvailability();
    }
  }

  function setAmazonConnectionState(state, text, detail = "") {
    const container = byId("amazonConnection");
    const statusText = byId("amazonStatusText");
    if (container) {
      container.dataset.state = state;
      container.title = detail || text;
    }
    if (statusText) {
      statusText.textContent = text;
      statusText.title = detail || text;
    }
    const refreshButton = byId("amazonRefreshButton");
    if (refreshButton) {
      const hasStore = (storeList?.stores || []).some((item) => /^[A-Z0-9]{8,20}$/.test(String(item?.sellerId || "").toUpperCase()));
      const checking = state === "checking";
      refreshButton.disabled = checking || analysisRunning || !hasStore;
      const label = hasStore ? "重新检查 Amazon 店铺访问" : "请先导入含 Seller ID 的店铺";
      refreshButton.setAttribute("aria-label", label);
      refreshButton.title = label;
      const currentIcon = refreshButton.querySelector("svg, [data-lucide]");
      if (currentIcon) {
        const icon = document.createElement("i");
        icon.setAttribute("data-lucide", checking ? "loader-circle" : "refresh-cw");
        icon.setAttribute("aria-hidden", "true");
        currentIcon.replaceWith(icon);
      }
      initIcons();
    }
  }

  function setConnectionState(state, text) {
    const container = byId("sellerSpriteConnection");
    if (container) container.dataset.state = state;
    setText("sellerSpriteStatusText", text);
    const retry = byId("sellerSpriteRetryButton");
    if (retry) {
      retry.hidden = state === "live";
      retry.disabled = state === "checking" && Boolean(sellerSpriteCheckPromise);
      const action = state === "error" ? "重新连接 SellerSprite" : "连接 SellerSprite";
      retry.setAttribute("aria-label", action);
      retry.title = action;
      const currentIcon = retry.querySelector("svg, [data-lucide]");
      if (currentIcon) {
        const icon = document.createElement("i");
        icon.setAttribute("data-lucide", state === "checking" ? "loader-circle" : state === "error" ? "refresh-cw" : "plug");
        icon.setAttribute("aria-hidden", "true");
        currentIcon.replaceWith(icon);
      }
    }
  }

  function setDataMode(mode, text) {
    const label = byId("dataModeLabel");
    if (label) {
      label.dataset.mode = mode;
      label.setAttribute("aria-label", text);
      label.title = text;
      const currentIcon = label.querySelector("svg, [data-lucide]");
      if (currentIcon) {
        const icon = document.createElement("i");
        icon.setAttribute("data-lucide", mode === "idle" ? "plug" : mode === "checking" ? "loader-circle" : mode === "mock" ? "flask-conical" : mode === "error" ? "circle-alert" : mode === "mixed" ? "blend" : "radio");
        icon.setAttribute("aria-hidden", "true");
        currentIcon.replaceWith(icon);
      }
    }
    setText("dataModeText", text);
    initIcons();
  }

  function isProxyAnalysis(context = runState) {
    return String(context?.providerMode || "").trim().toLowerCase().startsWith("proxy");
  }

  function analysisSourceLabel(context = runState, { compact = false } = {}) {
    const source = String(context?.sourceMarketplace || context?.marketplace || activeMarket.code).trim().toUpperCase();
    const amazonOnly = context?.analysisSourceMode === "amazon_only"
      || context?.criteria?.useSellerSprite === false
      || context?.useSellerSprite === false
      || /Amazon\s+[A-Z]{2}\s+官网商品页/i.test(String(context?.dataSource || ""));
    if (amazonOnly) return compact ? `${source} · Amazon 官网` : `Amazon ${source} 官网商品页`;
    const hasProvider = Boolean(String(context?.providerMarketplace || "").trim());
    const provider = String(context?.providerMarketplace || (source === "NL" ? "DE" : source)).trim().toUpperCase();
    if (source === "NL" && !hasProvider) {
      return compact
        ? "NL 店铺 · SellerSprite DE 代理待确认"
        : "Amazon NL 店铺来源 + SellerSprite DE 代理待确认（不会标作 NL 实时数据）";
    }
    if (isProxyAnalysis(context)) {
      return compact
        ? `${source} 店铺 · SellerSprite ${provider} 代理（非 ${source} 实时）`
        : `Amazon ${source} 店铺来源 + SellerSprite ${provider} 代理分析（非 ${source} 站 SellerSprite 实时数据）`;
    }
    if (source === "NL") {
      return compact
        ? `NL 店铺 · SellerSprite ${provider} 口径未确认`
        : `Amazon NL 店铺来源 + SellerSprite ${provider} 分析口径未确认（不标记为 NL 实时数据）`;
    }
    if (context?.dataMode === "mock" || context?.mode === "mock") return "模拟数据 · 不可用于最终决策";
    return `Amazon ${source} 店铺来源 + SellerSprite ${provider} 实时分析`;
  }

  function dataModeLabel(context = runState) {
    if (isProxyAnalysis(context)) return context?.supplierSource || context?.mode === "mixed" ? "DE 代理 + 成本演示" : "DE 代理分析";
    if (context?.dataMode === "mock" || context?.mode === "mock") return "模拟数据";
    if (context?.analysisSourceMode === "amazon_only" && context?.mode !== "mixed" && !context?.supplierSource) return "Amazon 官网";
    return context?.mode === "mixed" || context?.supplierSource ? "混合估算" : "实时数据";
  }

  function setImportStatus(state, text) {
    const label = byId("importStatusLabel");
    if (!label) return;
    label.classList.remove("is-success", "is-warning", "is-error", "is-loading");
    label.classList.add(state === "success" ? "is-success" : state === "warning" ? "is-warning" : state === "error" ? "is-error" : "is-loading");
    const span = label.querySelector("span");
    if (span) span.textContent = text;
    else label.lastChild.textContent = text;
  }

  function updateStartAvailability() {
    const button = byId("startAnalysisButton");
    const fileInput = byId("storeFileInput");
    const uploadZone = byId("uploadZone");
    const marketplaceSelect = byId("marketplaceSelect");
    const connectButton = byId("connectSellerSpriteButton");
    const amazonRefreshButton = byId("amazonRefreshButton");
    const login1688Button = byId("login1688Button");
    const check1688Button = byId("check1688Button");
    const useSellerSprite = byId("useSellerSpriteToggle")?.checked === true;
    renderSellerSpriteSetupStatus();
    const sourceSupported = !Array.isArray(sellerSpriteCapabilities?.supportedMarketplaces) || sellerSpriteCapabilities.supportedMarketplaces.includes(activeMarket.code);
    const collectionLocked = isCollectionWriteLocked() || hasOtherActiveCollection();
    const uploading = storeImportPending || taskReplacementPending || amazonCollectionControlPending || supplierCollectionTransition;
    if (fileInput) fileInput.disabled = uploading || exportRunning || analysisVersionPendingIds.size > 0;
    if (uploadZone) uploadZone.disabled = fileInput?.disabled ?? uploading;
    for (const id of ["storeImportTab", "asinImportTab", "importAsinsButton", "asinTextInput", "asinMarketplaceSelect"]) {
      if (byId(id)) byId(id).disabled = fileInput?.disabled ?? uploading;
    }
    if (marketplaceSelect) marketplaceSelect.disabled = uploading || collectionLocked;
    if (amazonRefreshButton) {
      const hasAmazonStore = (storeList?.stores || []).some((item) => /^[A-Z0-9]{8,20}$/.test(String(item?.sellerId || "").toUpperCase()));
      amazonRefreshButton.disabled = collectionLocked || analysisRunning || Boolean(amazonCheckPromise) || !hasAmazonStore;
    }
    syncManualCostReadOnlyState();
    syncStoreManagerControls();
    if (login1688Button) {
      login1688Button.disabled = Boolean(supplier1688SessionPromise);
    }
    for (const id of ["resume1688Button", "restart1688Button", "relogin1688Button"]) {
      const button = byId(id);
      if (button) button.disabled = Boolean(supplier1688SessionPromise);
    }
    if (check1688Button) {
      const pendingResumeCount = getPending1688ResumeProducts().length;
      const checkLabel = supplier1688RiskTask?.id
        ? "在线验证 1688 身份；通过后处理图片验证"
        : pendingResumeCount
        ? `在线验证并自动补做 ${pendingResumeCount} 个未完成候选`
        : "在线验证 1688 身份";
      check1688Button.disabled = Boolean(supplier1688SessionPromise);
      check1688Button.setAttribute("aria-label", "刷新状态");
      check1688Button.title = `刷新状态：${checkLabel}`;
    }
    if (!supplier1688ResumePromise) render1688SessionStatusMessage();
    renderSupplier1688Stage();
    if (connectButton) {
      const isChecking = sellerSpriteStatus === "checking";
      const isLive = sellerSpriteStatus === "live";
      connectButton.hidden = !useSellerSprite;
      connectButton.disabled = analysisRunning || isChecking || isLive;
      connectButton.innerHTML = isChecking
        ? `<i data-lucide="loader-circle" aria-hidden="true"></i>正在连接`
        : isLive
          ? `<i data-lucide="circle-check" aria-hidden="true"></i>SellerSprite 已连接`
          : `<i data-lucide="${sellerSpriteStatus === "error" ? "refresh-cw" : "plug"}" aria-hidden="true"></i>${sellerSpriteStatus === "error" ? "重新连接 SellerSprite" : "连接 SellerSprite"}`;
    }
    if (!button) return;
    if (!uploading && selectedInputNeedsImport()) {
      const canPrepare = importMode === "asins" && (hasNewAsinDraft() || (!failedImportFileDraft && asinImportPreview?.status === "ready"));
      button.disabled = !canPrepare || asinImportPreview?.status === "loading" || exportRunning || analysisVersionPendingIds.size > 0;
      button.innerHTML = importMode === "asins" ? `开始新 ASIN 批次${asinImportPreview?.status === "ready" && !hasNewAsinDraft() ? ` · ${importedItemCount(asinImportPreview.data)} 个` : ""}` : "请先导入店铺清单";
      const reason = failedImportFileDraft && !hasNewAsinDraft() ? `新文件“${failedImportFileDraft.fileName}”未通过校验，请重新选择或取消新输入。旧任务不会自动续跑。`
        : asinImportPreview?.status === "loading" ? "正在校验当前 Excel 的 ASIN 列，旧任务未变更。"
        : canPrepare ? "仅按所选 ASIN 输入创建新批次；开始前归档旧任务，不会续跑原店铺任务。"
        : asinImportPreview?.error || "请重新选择当前 Excel 的 ASIN 列，或粘贴 ASIN；不会继续旧任务。";
      setText("analysisRequirementText", reason); button.title = reason;
      renderSelectedInputSummary();
      return;
    }
    if (uploading || runState.archivedAt) {
      button.disabled = true;
      button.innerHTML = uploading ? "正在载入新文件…" : "已归档，请上传新文件";
      setText("analysisRequirementText", uploading ? "新文件确认可用后，旧任务将取消并归档。" : "当前为历史记录，Amazon 采集已停止，可编辑商品、匹配 1688、初审和导出。");
      return;
    }
    if (collectionLocked) {
      const job = currentAmazonCollectionJob();
      const resumable = job && ["paused", "needs_attention", "cooldown"].includes(job.status);
      button.disabled = amazonCollectionControlPending || !resumable;
      button.innerHTML = `<i data-lucide="${resumable ? "play" : "loader-circle"}" aria-hidden="true"></i>${resumable ? "继续后台采集" : "后台正在采集"}`;
      setText("analysisRequirementText", "关闭页面后本地后台仍会继续采集。可在采集监查中查看状态、暂停或继续。采集完成后可编辑和初审。");
      return;
    }
    const storeCount = importedItemCount();
    const resolved = countResolvedStores();
    const marketMatches = storeList?.audit?.marketplace === activeMarket.code;
    const sellerSpriteBlocked = useSellerSprite && (sellerSpriteStatus !== "live" || !sourceSupported);
    button.disabled = analysisRunning || (hasActive1688Work() && !amazonRunNeedsResume()) || Boolean(amazonCheckPromise) || sellerSpriteBlocked || !storeList || storeCount === 0 || !resolved || !marketMatches;
    if (!analysisRunning) {
      button.innerHTML = runState.amazonDetailPause
        ? '<i data-lucide="play" aria-hidden="true"></i>继续 Amazon 详情'
        : `<i data-lucide="play" aria-hidden="true"></i>${isAsinImport() ? "开始采集" : "开始分析"} ${storeCount || "--"} 个${isAsinImport() ? "ASIN" : "店铺"}`;
    }
    let requirement = "载入店铺清单并完成数据源检测后可开始。";
    if (amazonCheckPromise) requirement = "正在检查 Amazon 店铺访问，完成后即可开始分析。";
    else if (analysisRunning) requirement = "当前店铺分析正在进行，请等待本轮完成。";
    else if (hasActive1688Work() && !amazonRunNeedsResume()) requirement = "当前1688匹配正在进行，结束后可开始新一轮店铺分析。";
    else if (useSellerSprite && !sourceSupported) requirement = `SellerSprite 当前不支持 ${activeMarket.code} 月销量；请关闭开关使用 Amazon 页面数据。`;
    else if (useSellerSprite && sellerSpriteStatus === "idle") requirement = "已选择接入 SellerSprite，请先点击连接；关闭开关可改用 Amazon 官网分析。";
    else if (useSellerSprite && sellerSpriteStatus === "checking") requirement = "正在执行你刚才发起的一次 SellerSprite 连接。";
    else if (useSellerSprite && sellerSpriteStatus === "error") requirement = "SellerSprite 连接不可用；可重新连接或关闭接入开关。";
    else if (!storeList) requirement = "请导入店铺清单，或粘贴 / 上传 ASIN 清单。";
    else if (!marketMatches) requirement = `当前店铺表不属于 ${activeMarket.nameZh}，请重新导入。`;
    else if (!storeCount) requirement = firstStoreIssueReason(storeList) || "当前任务店铺清单为空，请重新导入 XLSX。";
    else if (!resolved) requirement = "店铺清单缺少有效的 Seller ID 或预填 ASIN。";
    else if (runState.amazonDetailPause) requirement = amazonDetailPauseMessage(runState.amazonDetailPause);
    else if (useSellerSprite) requirement = `${isAsinImport() ? `${storeCount} 个 ASIN 将直接查询` : `${resolved} 个店铺可访问`}；本次只完成 Amazon 与 SellerSprite 商品数据，1688 需在结果页确认筛选后单独启动。`;
    else requirement = `${isAsinImport() ? `${storeCount} 个 ASIN 将直接访问商品详情` : `${resolved} 个店铺可访问`}；本次只从 Amazon 官网读取详情，不会自动调用 1688。`;
    setText("analysisRequirementText", requirement);
    button.title = requirement;
    const requirementElement = byId("analysisRequirementText");
    if (requirementElement) {
      requirementElement.classList.toggle("is-ready", !amazonCheckPromise && !sellerSpriteBlocked && Boolean(storeList) && resolved > 0);
      requirementElement.classList.toggle("is-error", (useSellerSprite && sellerSpriteStatus === "error") || (!sellerSpriteBlocked && Boolean(storeList) && resolved === 0));
    }
    initIcons();
  }

  function countResolvedStores() {
    return storeList?.stores?.filter(isStoreActionable).length || 0;
  }

  function isStoreActionable(store) {
    if (store?.importBlocked) return false;
    return Boolean(
      String(store?.sellerId || "").trim()
      || (Array.isArray(store?.asins) && store.asins.length),
    );
  }

  function startHeartbeat() {
    const ping = () => Promise.allSettled([
      fetch("/api/runtime/heartbeat", { method: "POST", cache: "no-store" }),
      loadLocalMonitorStatus(),
      // Read persisted counts while a long SellerSprite analysis request is in flight.
      loadRuntimeStatus(),
    ]);
    const initial = ping();
    window.setInterval(ping, 30000);
    return initial;
  }

  async function loadLocalMonitorStatus() {
    if (localMonitorPromise) return localMonitorPromise;
    const request = Promise.resolve().then(async () => {
      try {
        localMonitorState = await apiRequest("/api/monitor", { timeout: 8000 });
        renderLocalMonitorStatus();
        return localMonitorState;
      } catch {
        setText("localMonitorStatus", "暂时无法读取巡检状态");
        if (byId("localMonitorStatus")) byId("localMonitorStatus").dataset.state = "attention";
        setText("localMonitorCheckSummary", "保留上次记录；请检查本地服务。页面不会自动重启或恢复任务。");
        return null;
      }
    });
    localMonitorPromise = request;
    try { return await request; }
    finally { if (localMonitorPromise === request) localMonitorPromise = null; }
  }

  function renderLocalMonitorStatus() {
    const state = localMonitorState || {};
    const labels = {
      running: "运行中", healthy: "正常", ok: "正常", idle: "无任务", waiting: "等待新批次",
      cooldown: "冷却中", paused: "已暂停", complete: "已完成", completed: "已完成",
      needs_attention: "需要处理", error: "异常", failed: "异常", unavailable: "不可用",
      stopped: "已停止", degraded: "状态读取异常", throughput_limited: "吞吐不足", unknown: "待检查",
    };
    const checks = [["Amazon", state.checks?.amazon], ["1688", state.checks?.supplier1688]];
    const monitorErrors = [];
    if (state.errorCode) monitorErrors.push("后台巡检未能启动，请检查本地服务。");
    if (state.persistenceError) monitorErrors.push("巡检状态未能保存，请检查本地服务及数据目录。");
    const needsAttention = monitorErrors.length > 0 || checks.some(([, check]) =>
      ["needs_attention", "error", "failed", "throughput_limited"].includes(check?.status)
      || (["unavailable", "degraded"].includes(check?.status) && check?.hasActivity === true));
    setText("localMonitorStatus", monitorErrors.length ? "巡检服务异常，请检查本地服务"
      : state.configured === false ? "后台巡检已关闭"
      : state.enabled !== true ? "后台巡检尚未运行"
      : needsAttention ? "有事项需要处理" : "后台独立巡检中");
    const label = byId("localMonitorStatus");
    if (label) label.dataset.state = needsAttention ? "attention" : "normal";
    const formatTime = value => {
      const date = new Date(value || NaN);
      return Number.isFinite(date.getTime()) ? date.toLocaleString("zh-CN", { hour12: false }) : "尚未检查";
    };
    const checkSummary = checks.map(([name, check]) => {
      const optionalInactive = name === "1688" && check?.hasActivity !== true && ["unavailable", "degraded"].includes(check?.status);
      const status = optionalInactive ? "可选服务未启用 · 无匹配任务" : labels[check?.status] || "待检查";
      return `${name}：${status} · ${formatTime(check?.lastCheckedAt)}`;
    }).join("；");
    setText("localMonitorCheckSummary", [...monitorErrors, checkSummary].join(" "));
    const frequency = value => Number.isFinite(Number(value)) && Number(value) > 0 ? `${Math.round(Number(value) / 60000)} 分钟` : "未提供";
    setText("localMonitorFrequency", `Amazon ${frequency(state.intervals?.amazonMs)}；1688 ${frequency(state.intervals?.supplier1688Ms)}。巡检由本地服务执行，不依赖 AI 或网页保持打开。`);
    const events = Array.isArray(state.events) ? state.events.slice(-5).reverse() : [];
    const list = byId("localMonitorEvents");
    if (list) {
      list.hidden = !events.length;
      list.innerHTML = events.map(event => `<li><time>${escapeHtml(formatTime(event.createdAt))}</time><span>${escapeHtml(event.message || "巡检状态已更新")}</span></li>`).join("");
    }
    const empty = byId("localMonitorEmpty");
    if (empty) empty.hidden = Boolean(events.length);
  }

  async function apiRequest(path, { method = "GET", body, headers = {}, signal, timeout = 20000 } = {}) {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), timeout);
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    try {
      const response = await fetch(path, { method, body, headers, signal: controller.signal, cache: "no-store" });
      const payload = await response.json().catch(() => null);
      updateSellerSpriteCallCount(payload?.data?.toolCallCount, payload?.data?.sessionToolCallCount);
      if (!response.ok || payload?.ok === false) {
        const error = new Error(payload?.error?.message || `本地服务返回 ${response.status}`);
        error.code = payload?.error?.code || `HTTP_${response.status}`;
        error.status = response.status;
        error.data = payload?.data;
        error.details = payload?.error?.details && typeof payload.error.details === "object"
          ? payload.error.details
          : null;
        throw error;
      }
      return payload?.data ?? payload;
    } catch (error) {
      if (error.name === "AbortError") {
        const timeoutError = new Error("请求超时，请检查本地服务与任务状态。");
        timeoutError.code = "REQUEST_TIMEOUT";
        throw timeoutError;
      }
      throw error;
    } finally {
      window.clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  }

  function setMetric(id, value) {
    const missing = value === null || value === undefined || value === "";
    setText(id, !missing && Number.isFinite(Number(value)) ? String(Number(value)) : "--");
  }

  function setText(id, value) {
    const element = byId(id);
    if (element) element.textContent = String(value ?? "");
  }

  function updateSellerSpriteCallCount(value, sessionValue) {
    const count = value === null || value === undefined || value === "" ? NaN : Number(value);
    const sessionCount = sessionValue === null || sessionValue === undefined || sessionValue === "" ? NaN : Number(sessionValue);
    if (Number.isFinite(sessionCount) && sessionCount >= 0) sellerSpriteSessionCallCount = Math.trunc(sessionCount);
    if (!Number.isFinite(count) || count < 0) return;
    sellerSpriteCallCount = Math.trunc(count);
    setText("sellerSpriteCallCount", `历史商品调用 ${sellerSpriteCallCount} 次`);
    const element = byId("sellerSpriteCallCount");
    if (element) {
      const sessionText = Number.isInteger(sellerSpriteSessionCallCount) ? `；本次服务 ${sellerSpriteSessionCallCount} 次` : "";
      element.title = `程序历史累计商品接口调用 ${sellerSpriteCallCount} 次${sessionText}；1 次调用可能查询多个 ASIN，失败的实际调用也计入。连接和工具清单检查不计入。月销量成功数另按当前任务统计`;
    }
  }

  function bindSetupFilters() {
    byId("useSellerSpriteToggle")?.addEventListener("change", updateStartAvailability);
    syncAmazonListingDateControl();
    byId("amazonFirstAvailableFrom")?.addEventListener("change", applyAmazonListingDateFilter);
    byId("amazonFirstAvailableFrom")?.addEventListener("focus", (event) => { event.target.max = todayDateOnly(); });
    byId("clearAmazonListingDateButton")?.addEventListener("click", () => {
      if (byId("amazonFirstAvailableFrom")) byId("amazonFirstAvailableFrom").value = "";
      applyAmazonListingDateFilter();
    });

    byId("applyAmazonFiltersButton")?.addEventListener("click", () => {
      if (syncAmazonResultCriteria({ persist: true })) {
        showToast("已按当前条件刷新候选商品。", "info");
      }
    });

    byId("clearFiltersButton")?.addEventListener("click", () => {
      if (byId("monthlySalesBand")) byId("monthlySalesBand").value = "all";
      if (byId("minReviews")) byId("minReviews").value = "";
      if (byId("maxReviews")) byId("maxReviews").value = "";
      if (byId("minRating")) byId("minRating").value = "";
      if (byId("amazonFirstAvailableFrom")) byId("amazonFirstAvailableFrom").value = "";
      syncAmazonResultCriteria({ persist: true });
      showToast("Amazon 筛选已恢复默认；候选 ASIN 均保留。", "info");
    });

    byId("startAnalysisButton")?.addEventListener("click", runAnalysis);
  }

  function optionalReviewInput(id) {
    const input = byId(id);
    if (input?.validity?.badInput) return NaN;
    const value = String(input?.value ?? "").trim();
    return value === "" ? null : Number(value);
  }

  function getSetupCriteria() {
    return {
      useSellerSprite: byId("useSellerSpriteToggle")?.checked === true,
      monthlySalesBand: byId("monthlySalesBand")?.value || "all",
      minReviews: optionalReviewInput("minReviews"),
      maxReviews: optionalReviewInput("maxReviews"),
      minRating: numberOrNull(byId("minRating")?.value),
    };
  }

  function validateSetupCriteria(criteria) {
    try { normalizeReviewRange(criteria); } catch (error) { return error.message; }
    const numericValues = [criteria.minRating].filter((value) => value !== null && value !== undefined);
    if (numericValues.some((value) => !Number.isFinite(value) || value < 0)) {
      return "筛选条件只能填写不小于 0 的数字。";
    }
    if (!["all", "50_plus", "50_to_100", "100_plus"].includes(criteria.monthlySalesBand)) return "Amazon 月销量档位无效。";
    if (criteria.minRating !== null && criteria.minRating > 5) {
      return "最低评价星级不能超过 5。";
    }
    return null;
  }

  function syncAmazonResultCriteria({ persist = false } = {}) {
    const criteria = getSetupCriteria();
    const validationError = validateSetupCriteria(criteria);
    if (validationError) {
      showToast(validationError, "error", 4200);
      return false;
    }
    const amazonFirstAvailableFrom = requestedAmazonListingDateFilter();
    if (amazonFirstAvailableFrom === null) return false;
    const filters = {
      monthlySalesBand: criteria.monthlySalesBand,
      minReviews: criteria.minReviews,
      maxReviews: criteria.maxReviews,
      minRating: criteria.minRating,
    };
    activeRunCriteria = { ...activeRunCriteria, ...filters, amazonFirstAvailableFrom };
    saveAmazonListingDatePreference();
    if (runState.id && runState.mode !== "idle") runState.criteria = { ...(runState.criteria || {}), ...filters };
    resultPage = 1;
    renderResults();
    if (persist && runState.id && runState.mode !== "idle") void persistCurrentRun();
    return true;
  }

  async function runAnalysis() {
    if (storeImportPending || taskReplacementPending) return;
    // The selected mode is the user's next-start intent. Resolve it before any
    // existing job resume branch, including paused and verification-paused jobs.
    if (selectedInputNeedsImport()) {
      if (failedImportFileDraft && !hasNewAsinDraft()) { showToast(`新文件“${failedImportFileDraft.fileName}”尚未导入，请重选有效文件或取消新输入；旧任务未续跑。`, "error", 6200); return; }
      if (importMode !== "asins") { showToast("请先重新上传店铺清单，不会继续当前 ASIN 任务。", "info", 5200); return; }
      const intendedRunId = runState.id;
      const text = byId("asinTextInput")?.value.trim() || "";
      const preview = text ? null : await prepareCurrentExcelAsins();
      if (importMode !== "asins" || runState.id !== intendedRunId || text !== (byId("asinTextInput")?.value.trim() || "")) return;
      if (!text && preview?.status !== "ready") { showToast(preview?.error || "请重新选择含 ASIN 列的 Excel。旧任务已保留。", "error", 6200); return; }
      const nextCriteria = getSetupCriteria();
      const nextCriteriaError = validateSetupCriteria(nextCriteria);
      if (nextCriteriaError) { showToast(nextCriteriaError, "error", 5200); return; }
      const targetMarket = text ? byId("asinMarketplaceSelect")?.value || activeMarket.code : preview.data.audit.marketplace;
      if (nextCriteria.useSellerSprite && (sellerSpriteStatus !== "live" || (Array.isArray(sellerSpriteCapabilities?.supportedMarketplaces) && !sellerSpriteCapabilities.supportedMarketplaces.includes(targetMarket)))) {
        showToast("所选站点的 SellerSprite 尚不可用；请先连接或关闭接入开关。旧任务已保留。", "error", 6200); return;
      }
      const imported = await importTaskSource({ mode: "asins", text,
        marketplace: text ? byId("asinMarketplaceSelect")?.value || activeMarket.code : preview.data.audit.marketplace,
        preparedData: text ? null : preview.data, preparedFileName: preview?.fileName });
      if (!imported) return;
    }
    if (runState.archivedAt) return;
    if (!amazonCollectionStatusKnown) {
      try { await loadAmazonCollectionStatus(); }
      catch { showToast("暂未确认后台任务状态，请稍后重试。已有采集任务会继续运行。", "info", 5000); return; }
    }
    const managedJob = currentAmazonCollectionJob();
    if (managedJob && managedJob.status !== "completed") {
      if (["paused", "needs_attention", "cooldown"].includes(managedJob.status)) await controlAmazonCollection("resume");
      else scheduleAmazonCollectionPoll(0);
      return;
    }
    if (hasOtherActiveCollection()) { showToast("另一个后台采集任务尚未完成，请先查看其进度。", "info", 5000); return; }
    const automaticAmazonResume = !managedJob && amazonRunNeedsResume();
    if (analysisRunning) return;
    if (amazonCheckPromise) {
      showToast("请等待 Amazon 店铺访问检查完成。", "info", 3200);
      return;
    }
    const setupCriteria = getSetupCriteria();
    const savedCriteria = { ...(runState.criteria || {}) };
    const failedSellerSpriteResume = runState.mode === "error"
      && runState.resumeSellerSprite === true;
    const unfinishedSellerSpriteResume = !runState.completedAt
      && runState.analysisSourceMode === "amazon_sellsprite";
    const manualSellerSpriteResume = !automaticAmazonResume
      && (failedSellerSpriteResume || unfinishedSellerSpriteResume)
      && runState.marketplace === activeMarket.code
      && setupCriteria.useSellerSprite === true
      && JSON.stringify(savedCriteria) === JSON.stringify(setupCriteria);
    const resumeExisting = automaticAmazonResume || manualSellerSpriteResume;
    if (!resumeExisting && hasActive1688Work()) {
      showToast("当前 1688 批次仍在处理，请完成后再开始新的店铺任务。", "info", 4200);
      return;
    }
    const criteria = automaticAmazonResume ? savedCriteria : setupCriteria;
    const allowSellerSprite = !automaticAmazonResume && criteria.useSellerSprite === true;
    const validationError = validateSetupCriteria(criteria);
    if (validationError) {
      showToast(validationError, "error", 4200);
      return;
    }
    if (allowSellerSprite && sellerSpriteStatus !== "live") {
      showProgressError("SellerSprite 尚未授权", "店铺分析任务需要先完成一次 SellerSprite 授权。", { action: "connect", actionLabel: "授权并连接", showDemo: activeMarket.code !== "NL" });
      return;
    }
    if (!storeList?.stores?.length) {
      showProgressError("没有可分析的清单", "请先导入有效的店铺或 ASIN 清单。", { action: null, showDemo: true });
      return;
    }
    if (storeList.audit?.marketplace !== activeMarket.code) {
      showProgressError("店铺站点不匹配", `请重新导入 ${activeMarket.nameZh} 的 XLSX 店铺清单。`, { action: null, showDemo: true });
      return;
    }

    if (!resumeExisting) beginRun(criteria, "live");
    else {
      analysisRunning = true;
      // Resuming Amazon must not replace the user's confirmed result filters.
      if (automaticAmazonResume) runState.amazonDetailPause = null;
      runState.completedAt = null;
      runState.mode = "live";
      runState.errors = (runState.errors || []).filter((error) => error?.stage || error?.sellerId || error?.asin);
      updateStartAvailability();
      const button = byId("startAnalysisButton");
      if (button) {
        button.disabled = true;
        button.innerHTML = '<i data-lucide="loader-circle" aria-hidden="true"></i>正在续跑';
        button.classList.add("is-loading");
      }
      byId("progressPanel").hidden = false;
      hideProgressError();
      initIcons();
    }
    currentRunController?.abort();
    const controller = new AbortController();
    currentRunController = controller;
    const { signal } = controller;

    try {
      setStage(0, isAsinImport() ? "ASIN 清单已校验，正在准备商品详情采集" : "店铺清单已校验，正在准备店铺访问会话", 12);
      await delay(180);
      assertCurrentTaskRequest(controller);
      setStage(1, `${isAsinImport() ? "正在处理 ASIN 批次" : "正在处理店铺批次"} · ${criteria.useSellerSprite ? "Amazon 访问与 SellerSprite 商品分析" : "Amazon 官网商品分析"}`, 20);
      await delay(180);
      assertCurrentTaskRequest(controller);

      const resolvedStores = storeList.stores.filter(isStoreActionable);
      runState.inputMode = isAsinImport() ? "asins" : "stores";
      runState.coverage.queryable = resolvedStores.length;
      runState.coverage.unresolved = storeList.stores.length - resolvedStores.length;
      renderRunCoverage();
      if (!resolvedStores.length) {
        const count = storeList.audit?.uniqueSellers ?? storeList.stores.length;
        throw createRunError(
          "NO_ACTIONABLE_STORES",
          `当前 ${count} 个唯一店铺都缺少有效的 Seller ID 或预填 ASIN。`,
        );
      }

      ensureAmazonPipeline(resolvedStores);
      await persistCurrentRunRequired(signal);

      if (!allowSellerSprite) {
        amazonCollectionControlPending = true;
        const job = await apiRequest("/api/amazon/collection/start", {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ runId: runState.id }), timeout: 30000,
        });
        assertCurrentTaskRequest(controller);
        if (job?.owner !== "server" || job.runId !== runState.id) throw createRunError("COLLECTION_START_FAILED", "后台服务未确认任务归属，请刷新查看任务状态。");
        analysisRunning = false;
        applyAmazonCollectionJob(job);
        await refreshAmazonCollectionSnapshot();
        showView("results");
        showToast("任务已交给本地后台，关闭页面后也会继续。", "success", 5000);
        return;
      }

      const response = await fetchProductCandidates(resolvedStores, criteria, signal, (done, total, audit) => {
        if (currentRunController !== controller || signal.aborted) return;
        setStage(1, `已处理 ${done}/${total} 个店铺 · 已发现 ${audit.discoveredAsins} 个源 ASIN`, 20 + Math.round((done / total) * 42));
      }, { allowSellerSprite });
      assertCurrentTaskRequest(controller);
      runState.sourceMarketplace = response.sourceMarketplace || activeMarket.code;
      runState.providerMarketplace = response.providerMarketplace || null;
      runState.providerMode = response.providerMode || null;
      runState.sellerSpriteCalls = allowSellerSprite
        ? Number(response.runToolCallCount ?? Math.max(0, (sellerSpriteCallCount ?? 0) - (runState.toolCallBaseline ?? 0)))
        : Number(runState.sellerSpriteCalls || 0);
      const detailSuccessCount = Number(response.analysisAudit?.detailReturned ?? response.items.filter((item) => item.detailStatus !== "failed").length);
      const detailFailureCount = Number(response.analysisAudit?.detailFailed ?? Math.max(0, response.items.length - detailSuccessCount));
      const rateLimitWaits = Number(response.analysisAudit?.rateLimitWaits || 0);
      const sellerSpriteSessionLost = allowSellerSprite && hasSellerSpriteSessionError(response.errors);
      setStage(2, `已保留 ${products.length} 个源 ASIN · ${allowSellerSprite ? "SellerSprite" : "Amazon"} 详情成功 ${detailSuccessCount} · 待补 ${detailFailureCount}${rateLimitWaits ? ` · 限流等待 ${rateLimitWaits} 次` : ""}`, 70);
      if (sellerSpriteSessionLost) runState.resumeSellerSprite = true;
      else if (allowSellerSprite) runState.resumeSellerSprite = false;
      if (response.errors?.some((item) => item?.code === "LOCAL_PERSISTENCE_FAILED")) {
        throw createRunError("LOCAL_PERSISTENCE_FAILED", "本地调用记录无法保存，本次任务已停止，SellerSprite 商品工具未继续调用。");
      }
      if (!products.length && !response.items.length) {
        const visitAudit = response.visitAudit || {};
        const analysisAudit = response.analysisAudit || {};
        const unresolvedCount = (storeList.stores.length - resolvedStores.length) + response.unresolved.length;
        const errorCount = countFailedStores(response.errors);
        runState.coverage = {
          ...runState.coverage,
          queried: visitAudit.visited ?? 0,
          discoveredAsins: visitAudit.discoveredAsins ?? 0,
          reportedTotalAsins: visitAudit.reportedTotalAsins ?? null,
          notEnumeratedAsins: visitAudit.notEnumeratedAsins ?? null,
          omissionReasons: Array.isArray(visitAudit.omissionReasons) ? visitAudit.omissionReasons : [],
          visitFailed: visitAudit.visitFailed ?? 0,
          unresolved: unresolvedCount,
          failed: errorCount,
          parentCandidates: Number(analysisAudit.wideCandidates ?? 0),
          detailReturned: Number(analysisAudit.detailReturned ?? 0),
          detailFailed: Number(analysisAudit.detailFailed ?? 0),
          rateLimitWaits: Number(analysisAudit.rateLimitWaits ?? 0),
          products: 0,
          enrichment: response.enrichment,
        };
        runState.storeVisits = response.storeVisits;
        renderRunCoverage();
        const visited = Number(visitAudit.visited || 0);
        const discoveredAsins = Number(visitAudit.discoveredAsins || 0);
        const providerAttempted = Number(analysisAudit.detailCallsStarted || 0) > 0 || Number(analysisAudit.detailRequested || 0) > 0;
        if (!discoveredAsins && !providerAttempted) {
          if (Number(visitAudit.visitFailed || 0) > 0) {
            const firstStoreFailure = response.errors?.find((item) => item?.stage === "amazon_store");
            const failureReason = firstStoreFailure?.message ? ` 原因：${firstStoreFailure.message}` : "";
            throw createRunError("AMAZON_STORE_VISIT_FAILED", `Amazon 店铺访问未完成：已成功访问 ${visited} 个店铺，尚未发现 ASIN；商品详情分析未执行。${failureReason}`);
          }
          throw createRunError("NO_STORE_ASINS", `已访问 ${visited} 个店铺，但没有从 Amazon 店铺页发现 ASIN；商品详情分析未执行。`);
        }
        if (Number(analysisAudit.wideCandidates || 0) > 0 && Number(analysisAudit.selectedCandidates || 0) === 0) {
          throw createRunError("FILTERS_EMPTY", `已发现 ${discoveredAsins} 个 ASIN，但没有商品符合当前筛选条件。`);
        }
        throw createRunError("PROVIDER_NO_CANDIDATES", `已发现 ${discoveredAsins} 个 ASIN并完成${criteria.useSellerSprite ? " SellerSprite" : " Amazon 官网"}分析，但没有返回可用候选。`);
      }

      mergeAnalyzedCandidateProducts(response.items);
      // Each Amazon batch already merged its errors; keep concurrent 1688 updates.
      runState.coverage = {
        ...runState.coverage,
        queried: response.visitAudit?.visited ?? resolvedStores.length,
        discoveredAsins: response.visitAudit?.discoveredAsins ?? 0,
        reportedTotalAsins: response.visitAudit?.reportedTotalAsins ?? null,
        notEnumeratedAsins: response.visitAudit?.notEnumeratedAsins ?? null,
        omissionReasons: Array.isArray(response.visitAudit?.omissionReasons) ? response.visitAudit.omissionReasons : [],
        visitFailed: response.visitAudit?.visitFailed ?? 0,
        truncatedStores: response.visitAudit?.truncated ?? 0,
        unresolved: (storeList.stores.length - resolvedStores.length) + response.unresolved.length,
        failed: countFailedStores(response.errors),
        parentCandidates: Number(response.analysisAudit?.wideCandidates ?? products.length),
        detailReturned: Number(response.analysisAudit?.detailReturned ?? products.filter((product) => product.detailStatus !== "failed").length),
        detailFailed: Number(response.analysisAudit?.detailFailed ?? products.filter((product) => product.detailStatus === "failed").length),
        rateLimitWaits: Number(response.analysisAudit?.rateLimitWaits ?? 0),
        products: products.length,
        enrichment: response.enrichment,
      };
      runState.storeVisits = response.storeVisits;
      renderRunCoverage();
      renderResults();
      showView("results");
      await persistCurrentRunRequired(signal);
      setStage(3, runState.supplier1688Pipeline?.selectionId
        ? "Amazon 数据已保存 · 1688 按已确认批次独立处理"
        : "Amazon 数据已保存 · 1688 将在确认筛选后单独启动", 90);
      setStage(4, `正在计算${activeMarket.nameZh}利润`, 92);
      await delay(220);
      assertCurrentTaskRequest(controller);

      const supplierMatchedCount = products.filter((product) => ["complete", "fallback_estimate"].includes(product.supplierSearchStatus)).length;
      runState.mode = supplierMatchedCount || isProxyAnalysis(runState) ? "mixed" : "live";
      runState.dataSource = `${analysisSourceLabel(runState)}${supplierMatchedCount ? " + 1688 图片找厂" : "；1688 待筛选后单独匹配"}`;
      runState.completedAt = new Date().toISOString();
      setDataMode(isProxyAnalysis(runState) || supplierMatchedCount ? "mixed" : "live", dataModeLabel(runState));
      const coverageIssues = runState.coverage.unresolved + runState.coverage.visitFailed + runState.coverage.failed;
      finishRun(`${coverageIssues ? "分析完成，有待处理项" : "分析完成"} · ${products.length} 个${isProxyAnalysis(runState) ? "代理分析" : "实时"}候选`, 100);
      await persistCurrentRun({ notify: true });
      assertCurrentTaskRequest(controller);
      await delay(280);
      assertCurrentTaskRequest(controller);
      showView("results");
      const incomplete = products.filter((product) => !product.complete).length;
      const detailSource = criteria.useSellerSprite ? "SellerSprite" : "Amazon 官网";
      const supplierSummary = runState.supplier1688Pipeline?.selectionId
        ? "1688 保留已确认的固定批次，新增商品需再次点击匹配。"
        : "1688 未自动调用，请确认筛选后单独启动。";
      showToast(`Amazon 店铺访问 ${runState.coverage.queried}/${runState.coverage.requested}，已保留 ${products.length} 个唯一 ASIN；${detailSource}详情成功 ${runState.coverage.detailReturned || 0} 个、待补 ${runState.coverage.detailFailed || 0} 个${runState.coverage.rateLimitWaits ? `、限流等待 ${runState.coverage.rateLimitWaits} 次` : ""}。${supplierSummary}`, incomplete || coverageIssues ? "info" : "success", 6800);
    } catch (error) {
      if (signal.aborted) return;
      if (amazonCollectionControlPending) {
        analysisRunning = false;
        await loadAmazonCollectionStatus().catch(() => {});
        if (currentAmazonCollectionJob()) {
          await refreshAmazonCollectionSnapshot().catch(() => {});
          showToast(`后台任务已保留；页面同步提示：${error.message}`, "info", 5500);
          return;
        }
        amazonCollectionControlPending = false;
      }
      failRun(error);
      await persistCurrentRun({ notify: true });
    } finally {
      amazonCollectionControlPending = false;
      renderAmazonCollection();
      updateStartAvailability();
      scheduleAmazonCollectionPoll();
    }
  }

  function beginRun(criteria, mode, { resumeRunId = null } = {}) {
    closeManualCostDialog({ force: true, restoreFocus: false });
    analysisRunning = true;
    updateStartAvailability();
    products = [];
    amazonCollectionRevision = null;
    activeProductId = null;
    renderResults();
    activeRunCriteria = { ...criteria };
    syncAmazonListingDateControl();
    runState = {
      id: resumeRunId || (typeof window.crypto?.randomUUID === "function" ? window.crypto.randomUUID() : `run-${Date.now()}`),
      mode,
      dataSource: mode === "mock"
        ? "模拟数据"
        : criteria.useSellerSprite
          ? activeMarket.code === "NL" ? "Amazon NL 店铺来源 + SellerSprite DE 代理待确认" : "SellerSprite MCP"
          : `Amazon ${activeMarket.code} 官网商品页`,
      startedAt: new Date().toISOString(),
      completedAt: null,
      errors: [],
      storeVisits: [],
      marketplace: activeMarket.code,
      marketplaceId: activeMarket.marketplaceId,
      amazonDomain: activeMarket.amazonDomain,
      currency: activeMarket.currency,
      locale: activeMarket.locale,
      exchangeRate: taskExchangeRate,
      sourceMarketplace: activeMarket.code,
      providerMarketplace: null,
      providerMode: null,
      analysisSourceMode: criteria.useSellerSprite ? "amazon_sellsprite" : "amazon_only",
      criteria: { ...criteria },
      toolCallBaseline: sellerSpriteCallCount ?? 0,
      resumedFromCheckpoint: Boolean(resumeRunId),
      resumeSellerSprite: false,
      sellerSpriteCalls: 0,
      sellerSpriteCallsByTool: {},
      supplier1688Pipeline: null,
      coverage: {
        requested: storeList?.stores?.length || 0,
        queryable: 0,
        queried: 0,
        unresolved: 0,
        discoveredAsins: 0,
        reportedTotalAsins: null,
        notEnumeratedAsins: null,
        omissionReasons: [],
        visitFailed: 0,
        truncatedStores: 0,
        failed: 0,
        parentCandidates: 0,
        detailReturned: 0,
        detailFailed: 0,
        rateLimitWaits: 0,
        products: 0,
        enrichment: null,
      },
    };
    updateHistorySummary();
    byId("resultMinMargin").value = "";
    byId("resultWeightBand").value = "";
    byId("resultsCompleteToggle").checked = byId("completeOnlyToggle")?.checked === true;
    const panel = byId("progressPanel");
    panel.hidden = false;
    panel.classList.remove("is-error");
    hideProgressError();
    const button = byId("startAnalysisButton");
    button.disabled = true;
    button.innerHTML = '<i data-lucide="loader-circle" aria-hidden="true"></i>正在分析';
    button.classList.add("is-loading");
    $$("#stageList li").forEach((stage) => stage.classList.remove("is-current", "is-done", "is-error"));
    const detailStage = $("#stageList [data-stage=\"sellersprite\"]");
    if (detailStage) detailStage.innerHTML = `<span>03</span>${criteria.useSellerSprite ? "SellerSprite 详情 / 保留源 ASIN" : "Amazon 商品详情 / 保留源 ASIN"}`;
    renderRunCoverage();
    setProgress(0);
    panel.scrollIntoView({ behavior: "smooth", block: "nearest" });
    initIcons();
  }

  function amazonStorePipelineKey(store, index = 0) {
    const sellerId = String(store?.sellerId || "").trim().toUpperCase();
    if (sellerId) return `${runState.marketplace}:seller:${sellerId}`;
    const asins = [...new Set((store?.asins || []).map((asin) => String(asin || "").trim().toUpperCase()).filter(Boolean))].sort();
    return `${runState.marketplace}:source:${asins.join(",") || `row-${store?.rowNumbers?.join("-") || index}`}`;
  }

  function amazonProductNeedsDetailRepair(product) {
    if (!product || String(product.analysisSourceMode || runState.analysisSourceMode) !== "amazon_only") return false;
    if (String(product.detailStatus || "pending").toLowerCase() !== "success") {
      return product.detailRetryable === true;
    }
    return Number(product.detailParserVersion || 0) < AMAZON_DETAIL_PARSER_VERSION;
  }

  function amazonStoreHasDetailRepair(store) {
    const sellerId = String(store?.sellerId || "").trim().toUpperCase();
    const importedAsins = new Set((store?.asins || [])
      .map((asin) => String(asin || "").trim().toUpperCase())
      .filter(Boolean));
    return products.some((product) => {
      if (!amazonProductNeedsDetailRepair(product)) return false;
      const sourceStores = Array.isArray(product.sourceStores) ? product.sourceStores : [];
      if (sellerId && (
        String(product.sellerId || "").trim().toUpperCase() === sellerId
        || sourceStores.some((source) => String(source?.sellerId || "").trim().toUpperCase() === sellerId)
      )) return true;
      if (sellerId) return false;
      return [product.sourceAsin, ...(product.sourceAsins || []), product.asin]
        .map((asin) => String(asin || "").trim().toUpperCase())
        .some((asin) => importedAsins.has(asin));
    });
  }

  function retainedSourceAsinCountForStore(store) {
    const sellerId = String(store?.sellerId || "").trim().toUpperCase();
    const importedAsins = new Set((store?.asins || [])
      .map((asin) => String(asin || "").trim().toUpperCase())
      .filter(Boolean));
    const retainedAsins = new Set();
    products.forEach((product) => {
      if (amazonProductNeedsDetailRepair(product)) return;
      const sourceStores = Array.isArray(product.sourceStores) ? product.sourceStores : [];
      const belongsToSeller = sellerId && (
        String(product.sellerId || "").trim().toUpperCase() === sellerId
        || sourceStores.some((source) => String(source?.sellerId || "").trim().toUpperCase() === sellerId)
      );
      const productAsins = [...new Set([
        product.sourceAsin,
        ...(Array.isArray(product.sourceAsins) ? product.sourceAsins : []),
        product.asin,
      ].map((asin) => String(asin || "").trim().toUpperCase()).filter(Boolean))];
      const belongsToImportedAsins = !sellerId
        && productAsins.some((asin) => importedAsins.has(asin));
      if (!belongsToSeller && !belongsToImportedAsins) return;
      productAsins.forEach((asin) => {
        if (sellerId || importedAsins.has(asin)) retainedAsins.add(asin);
      });
    });
    return retainedAsins.size;
  }

  function amazonDetailAsinsForPipelineStates(chunkStates, stores) {
    const sellerIds = new Set();
    const importedAsins = new Set();
    chunkStates.forEach((entry) => {
      const store = stores[entry.index];
      const sellerId = String(store?.sellerId || "").trim().toUpperCase();
      if (sellerId) sellerIds.add(sellerId);
      else (store?.asins || []).forEach((asin) => importedAsins.add(String(asin || "").trim().toUpperCase()));
    });
    return [...new Set(products
      .filter((product) => amazonProductNeedsDetailRepair(product)
        || (String(product?.detailStatus || "pending").toLowerCase() !== "success" && product?.detailRetryable === true))
      .filter((product) => {
        const productSellerId = String(product.sellerId || "").trim().toUpperCase();
        if (productSellerId && sellerIds.has(productSellerId)) return true;
        if ((product.sourceStores || []).some((source) => sellerIds.has(String(source?.sellerId || "").trim().toUpperCase()))) return true;
        return [product.sourceAsin, ...(product.sourceAsins || []), product.asin]
          .map((asin) => String(asin || "").trim().toUpperCase())
          .some((asin) => importedAsins.has(asin));
      })
      .map((product) => String(product.sourceAsin || product.asin || "").trim().toUpperCase())
      .filter(Boolean))];
  }

  function ensureAmazonPipeline(stores) {
    const priorStores = new Map((runState.amazonPipeline?.stores || []).map((entry) => [entry.key, entry]));
    const visits = new Map((runState.storeVisits || []).map((visit, index) => [amazonStorePipelineKey(visit, index), visit]));
    const pipelineStores = stores.map((store, index) => {
      const key = amazonStorePipelineKey(store, index);
      const prior = priorStores.get(key);
      const needsDetailRepair = amazonStoreHasDetailRepair(store);
      if (prior) {
        return {
          ...prior,
          key,
          index,
          sellerId: store.sellerId || null,
          status: needsDetailRepair ? "discovered" : prior.status,
          retryAt: needsDetailRepair ? null : prior.retryAt,
        };
      }
      const visit = visits.get(key);
      const discoveredAsins = Number(visit?.discoveredAsins || 0);
      const retainedAsins = retainedSourceAsinCountForStore(store);
      const alreadyAnalyzed = visit?.complete === true && retainedAsins >= discoveredAsins;
      return {
        key,
        index,
        sellerId: store.sellerId || null,
        status: alreadyAnalyzed ? "analyzed" : visit?.complete === true ? "discovered" : "pending",
        attempts: 0,
        retryAt: null,
        lastCode: visit?.code || null,
        discoveredAsins,
      };
    });
    runState.amazonPipeline = {
      version: 1,
      phase: runState.amazonPipeline?.phase || "discover",
      stores: pipelineStores,
      updatedAt: new Date().toISOString(),
    };
    return runState.amazonPipeline;
  }

  function amazonPipelineStateForVisit(chunkStates, visit) {
    const sellerId = String(visit?.sellerId || "").trim().toUpperCase();
    return chunkStates.find((entry) => {
      return sellerId && String(entry.sellerId || "").trim().toUpperCase() === sellerId;
    }) || chunkStates[Number(visit?.storeIndex)] || null;
  }

  function replaceAmazonStoreVisits(visits, chunkStates) {
    const merged = new Map((runState.storeVisits || []).map((visit, index) => [amazonStorePipelineKey(visit, index), visit]));
    (visits || []).forEach((visit) => {
      const state = amazonPipelineStateForVisit(chunkStates, visit);
      if (state) merged.set(state.key, { ...visit, storeIndex: state.index });
    });
    runState.storeVisits = [...merged.values()];
  }

  function mergeAmazonRunErrors(nextErrors, completedSellerIds = new Set(), completedAsins = new Set()) {
    const retained = (runState.errors || []).filter((error) => {
      if (error?.stage === "amazon_product" && completedAsins.has(String(error.asin || "").trim().toUpperCase())) return false;
      if (error?.stage !== "amazon_store") return true;
      return !completedSellerIds.has(String(error.sellerId || "").trim().toUpperCase());
    });
    const keyed = new Map(retained.map((error, index) => [
      `${error.stage || ""}:${error.sellerId || ""}:${error.asin || ""}:${error.code || ""}:${index}`,
      error,
    ]));
    (nextErrors || []).forEach((error) => {
      const keyPrefix = `${error.stage || ""}:${error.sellerId || ""}:${error.asin || ""}:${error.code || ""}`;
      [...keyed.keys()].filter((key) => key.startsWith(`${keyPrefix}:`)).forEach((key) => keyed.delete(key));
      keyed.set(`${keyPrefix}:latest`, error);
    });
    runState.errors = [...keyed.values()];
  }

  function reconcileRecoveredAmazonProductErrors() {
    const successfulAsins = new Set(products
      .filter((product) => product.detailStatus === "success")
      .map((product) => String(product.sourceAsin || product.asin || "").trim().toUpperCase())
      .filter(Boolean));
    let changed = false;
    runState.errors = (runState.errors || []).map((error) => {
      const asin = String(error?.asin || "").trim().toUpperCase();
      if (error?.stage !== "amazon_product" || error.recovered === true || !successfulAsins.has(asin)) return error;
      changed = true;
      return { ...error, recovered: true };
    });
    if (runState.coverage && typeof runState.coverage === "object") {
      runState.coverage.failed = countFailedStores(runState.errors);
    }
    return changed;
  }

  function summarizeAmazonPipelineVisits() {
    const visits = runState.storeVisits || [];
    const omissionReasons = new Map();
    visits.forEach((visit) => (visit.omissionReasons || []).forEach((reason) => {
      const code = String(reason?.code || "AMAZON_ASIN_OMISSION");
      const current = omissionReasons.get(code) || { code, count: 0, countKnown: true, affectedStores: 0, message: String(reason?.message || "") };
      current.affectedStores += 1;
      if (Number.isInteger(reason?.count) && reason.count >= 0) current.count += reason.count;
      else current.countKnown = false;
      omissionReasons.set(code, current);
    }));
    const reported = visits.map((visit) => visit.reportedTotalAsins);
    const incompleteVisits = visits.filter((visit) => visit.complete !== true);
    const completedVisits = visits.filter((visit) => visit.complete === true);
    return {
      discoveredAsins: visits.reduce((total, visit) => total + Number(visit.discoveredAsins || 0), 0),
      reportedTotalAsins: visits.length && reported.every((value) => Number.isInteger(value) && value >= 0)
        ? reported.reduce((total, value) => total + value, 0)
        : null,
      notEnumeratedAsins: visits.reduce((total, visit) => total + Number(visit.notEnumeratedAsins || 0), 0),
      pendingEnumerationAsins: incompleteVisits.reduce((total, visit) => total + Number(visit.notEnumeratedAsins || 0), 0),
      completedReportedGapAsins: completedVisits.reduce((total, visit) => total + Number(visit.notEnumeratedAsins || 0), 0),
      incompleteStores: incompleteVisits.length,
      completedReportedGapStores: completedVisits.filter((visit) => Number(visit.notEnumeratedAsins || 0) > 0).length,
      omissionReasons: [...omissionReasons.values()].map(({ countKnown, ...reason }) => ({ ...reason, count: countKnown ? reason.count : null })),
      visited: visits.filter((visit) => visit.status === "visited" || visit.status === "empty" || visit.status === "not_required").length,
      pending: visits.filter((visit) => visit.status === "pending").length,
      waiting: visits.filter((visit) => visit.status === "waiting").length,
      visitFailed: visits.filter((visit) => visit.status === "failed").length,
      truncated: visits.filter((visit) => visit.truncated).length,
    };
  }

  function updateAmazonPipelineCoverage(stores) {
    const audit = summarizeAmazonPipelineVisits();
    const states = runState.amazonPipeline?.stores || [];
    runState.coverage = {
      ...(runState.coverage || {}),
      requested: storeList?.stores?.length || stores.length,
      queryable: stores.length,
      queried: audit.visited,
      discoveredAsins: audit.discoveredAsins,
      reportedTotalAsins: audit.reportedTotalAsins,
      notEnumeratedAsins: audit.notEnumeratedAsins,
      pendingEnumerationAsins: audit.pendingEnumerationAsins,
      completedReportedGapAsins: audit.completedReportedGapAsins,
      incompleteStores: audit.incompleteStores,
      completedReportedGapStores: audit.completedReportedGapStores,
      omissionReasons: audit.omissionReasons,
      visitFailed: states.filter((entry) => entry.status === "terminal").length,
      waitingStores: states.filter((entry) => ["pending", "waiting"].includes(entry.status)).length,
      truncatedStores: audit.truncated,
      products: products.length,
    };
    renderRunCoverage();
    return audit;
  }

  async function persistCurrentRunRequired(signal) {
    while (!signal?.aborted) {
      if (await persistCurrentRun()) return true;
      const status = Number(persistenceLastError?.status);
      if (Number.isFinite(status) && status >= 400 && status < 500 && ![408, 409, 429].includes(status)) {
        throw createRunError(
          persistenceLastError?.code || "LOCAL_PERSISTENCE_FAILED",
          `本地断点无法保存：${persistenceLastError?.message || "请求被拒绝"}`,
        );
      }
      if (["INVALID_RUN_STATE", "SNAPSHOT_SERIALIZATION_FAILED", "STALE_PRICE_SNAPSHOT", "STALE_COLLECTION_SNAPSHOT", "COLLECTION_MANAGED_READ_ONLY"].includes(persistenceLastError?.code)) throw persistenceLastError;
      await delayWithSignal(5_000, signal);
    }
    throw signal.reason || new DOMException("任务已取消。", "AbortError");
  }

  function retryDelayForAmazonVisit(visit) {
    const retryAt = Date.parse(visit?.retryAt || "");
    if (Number.isFinite(retryAt) && retryAt > Date.now()) return retryAt - Date.now();
    const retryAfterMs = Number(visit?.retryAfterMs);
    return Number.isFinite(retryAfterMs) && retryAfterMs > 0 ? retryAfterMs : AMAZON_RETRY_FALLBACK_MS;
  }

  function isAmazonPipelineRequestConfigurationError(error) {
    const status = Number(error?.status);
    if (Number.isFinite(status) && status >= 400 && status < 500 && ![408, 409, 429].includes(status)) return true;
    return new Set([
      "UNKNOWN_SEARCH_FIELD", "INVALID_SEARCH_PHASE", "INVALID_STORES", "INVALID_STORE",
      "MARKETPLACE_MISMATCH", "INVALID_RUN_ID", "INVALID_FILTERS", "LOCAL_PERSISTENCE_FAILED", "BODY_TOO_LARGE",
    ]).has(String(error?.code || "").toUpperCase());
  }

  async function fetchProductCandidates(stores, criteria, signal, onProgress, { allowSellerSprite = false } = {}) {
    if (currentAmazonCollectionJob() || hasOtherActiveCollection()) throw createRunError("COLLECTION_MANAGED_READ_ONLY", "本任务已由后台采集，页面不会重复发起详情请求。");
    const pipeline = ensureAmazonPipeline(stores);
    const collectedItems = new Map();
    const unresolved = [];
    let sourceMarketplace = null;
    let providerMarketplace = null;
    let providerMode = null;
    let runToolCallCount = 0;

    const pauseAmazonDetails = async (decision, chunkStates, pendingAsins) => {
      runState.amazonDetailPause = { ...decision, pendingAsins: [...(pendingAsins || [])], pausedAt: new Date().toISOString() };
      runState.completedAt = null;
      pipeline.phase = "analyze_paused";
      pipeline.updatedAt = runState.amazonDetailPause.pausedAt;
      chunkStates.forEach((entry) => {
        entry.status = "discovered";
        entry.lastCode = decision.causeCode;
        entry.retryAt = null;
      });
      updateAmazonPipelineCoverage(stores);
      await persistCurrentRunRequired(signal);
      throw createRunError("AMAZON_DETAIL_PAUSED", amazonDetailPauseMessage(decision));
    };

    const mergeAnalysisBatch = (data, chunkStates, { replaceVisits = false } = {}) => {
      const batchItems = data.items || data.products || [];
      batchItems.forEach((item) => {
        const sourceAsin = String(item.sourceAsin || item.asin || item.parentAsin || item.parent || "").trim().toUpperCase();
        const key = `${runState.marketplace}:${sourceAsin || String(item.id || `unresolved-${collectedItems.size}`)}`;
        const existing = collectedItems.get(key);
        collectedItems.set(key, existing ? mergeCandidateRecords(existing, item) : item);
      });
      mergeAnalyzedCandidateProducts(batchItems);
      if (replaceVisits) replaceAmazonStoreVisits(data.storeVisits, chunkStates);
      const completedAsins = new Set(batchItems
        .filter((item) => item?.detailStatus === "success")
        .map((item) => String(item.sourceAsin || item.asin || "").trim().toUpperCase()));
      mergeAmazonRunErrors(data.errors, new Set(), completedAsins);
      unresolved.push(...(data.unresolved || []));
      sourceMarketplace ||= data.sourceMarketplace || null;
      providerMarketplace ||= data.providerMarketplace || null;
      providerMode ||= data.providerMode || null;
      runToolCallCount = Math.max(runToolCallCount, Number(data.runToolCallCount || 0));
      return batchItems;
    };

    pipelineCycle: while (true) {
    // Enumerate every store before any product-detail or optional provider request.
    while (pipeline.stores.some((entry) => ["pending", "waiting"].includes(entry.status))) {
      const pending = pipeline.stores.filter((entry) => ["pending", "waiting"].includes(entry.status));
      const now = Date.now();
      const ready = pending
        .filter((entry) => !entry.retryAt || Date.parse(entry.retryAt) <= now)
        .sort((left, right) => {
          const leftDeferred = left.lastCode === "AMAZON_QUEUE_PAUSED" ? 1 : 0;
          const rightDeferred = right.lastCode === "AMAZON_QUEUE_PAUSED" ? 1 : 0;
          return leftDeferred - rightDeferred
            || Number(left.attempts || 0) - Number(right.attempts || 0)
            || left.index - right.index;
        });
      if (!ready.length) {
        const nextRetryAt = Math.min(...pending.map((entry) => Date.parse(entry.retryAt)).filter(Number.isFinite));
        const waitMs = Math.max(1_000, nextRetryAt - now);
        const accessRestricted = pending.some((entry) => ["AMAZON_ACCESS_CHALLENGE", "AMAZON_HTTP_429", "AMAZON_QUEUE_PAUSED"].includes(entry.lastCode));
        pipeline.phase = "cooldown";
        pipeline.updatedAt = new Date().toISOString();
        setStage(1, accessRestricted
          ? `Amazon 访问受限 · ${pending.length} 家已保存断点，约 ${Math.max(1, Math.ceil(waitMs / 60_000))} 分钟后自动继续`
          : `Amazon 分页断点已保存 · ${pending.length} 家待继续，约 ${Math.max(1, Math.ceil(waitMs / 1_000))} 秒后自动续页`, 20);
        await persistCurrentRunRequired(signal);
        await delayWithSignal(waitMs, signal);
        pipeline.phase = "discover";
        continue;
      }

      const chunkStates = ready.slice(0, AMAZON_STORE_BATCH_SIZE);
      const chunk = chunkStates.map((entry) => stores[entry.index]).filter(Boolean);
      let data;
      try {
        data = await apiRequest("/api/products/search", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            runId: runState.id,
            phase: "discover",
            marketplace: runState.marketplace,
            stores: chunk,
            inputMode: isAsinImport() ? "asins" : "stores",
            useSellerSprite: false,
            filters: {
              monthlySalesBand: criteria.monthlySalesBand,
              minReviews: criteria.minReviews,
              maxReviews: criteria.maxReviews,
              minRating: criteria.minRating,
            },
          }),
          signal,
          timeout: 30 * 60_000,
        });
      } catch (error) {
        if (signal.aborted || isAmazonPipelineRequestConfigurationError(error)) throw error;
        if (String(error?.code || "").toUpperCase() === "TASK_IN_PROGRESS") {
          setStage(1, "已有请求正在执行 · 当前断点保持不变，稍后自动继续", 20);
          await delayWithSignal(AMAZON_RETRY_FALLBACK_MS, signal);
          continue;
        }
        const retryAt = new Date(Date.now() + AMAZON_RETRY_FALLBACK_MS).toISOString();
        chunkStates.forEach((entry) => {
          entry.status = "waiting";
          entry.attempts = Number(entry.attempts || 0) + 1;
          entry.lastCode = String(error?.code || "AMAZON_REQUEST_FAILED");
          entry.retryAt = retryAt;
        });
        pipeline.updatedAt = new Date().toISOString();
        await persistCurrentRunRequired(signal);
        continue;
      }

      const completedSellerIds = new Set();
      let globalPauseUntil = 0;
      (data.storeVisits || []).forEach((visit) => {
        const entry = amazonPipelineStateForVisit(chunkStates, visit);
        if (!entry) return;
        if (visit.code !== "AMAZON_QUEUE_PAUSED") entry.attempts = Number(entry.attempts || 0) + 1;
        entry.discoveredAsins = Number(visit.discoveredAsins || 0);
        entry.lastCode = visit.code || visit.interruption?.code || null;
        if (visit.complete === true) {
          entry.status = "discovered";
          entry.retryAt = null;
          const sellerId = String(visit.sellerId || "").trim().toUpperCase();
          if (sellerId) completedSellerIds.add(sellerId);
          return;
        }
        const storeError = (data.errors || []).find((error) => error?.stage === "amazon_store"
          && String(error.sellerId || "").trim().toUpperCase() === String(visit.sellerId || "").trim().toUpperCase());
        if (visit.status === "failed" && storeError?.retryable === false) {
          entry.status = "terminal";
          entry.retryAt = null;
          return;
        }
        const delayMs = retryDelayForAmazonVisit(visit);
        entry.status = "waiting";
        entry.retryAt = new Date(Date.now() + delayMs).toISOString();
        if (["AMAZON_ACCESS_CHALLENGE", "AMAZON_HTTP_429", "AMAZON_QUEUE_PAUSED"].includes(entry.lastCode)) {
          globalPauseUntil = Math.max(globalPauseUntil, Date.parse(entry.retryAt));
        }
      });
      chunkStates.filter((entry) => entry.status === "pending").forEach((entry) => {
        entry.status = "waiting";
        entry.retryAt = new Date(Date.now() + AMAZON_RETRY_FALLBACK_MS).toISOString();
      });
      if (globalPauseUntil > Date.now()) {
        pipeline.stores.filter((entry) => ["pending", "waiting"].includes(entry.status)).forEach((entry) => {
          if (!entry.retryAt || Date.parse(entry.retryAt) < globalPauseUntil) entry.retryAt = new Date(globalPauseUntil).toISOString();
          entry.status = "waiting";
        });
      }
      mergeAnalyzedCandidateProducts(data.items || data.products || []);
      replaceAmazonStoreVisits(data.storeVisits, chunkStates);
      mergeAmazonRunErrors(data.errors, completedSellerIds);
      unresolved.push(...(data.unresolved || []));
      sourceMarketplace ||= data.sourceMarketplace || null;
      runToolCallCount = Math.max(runToolCallCount, Number(data.runToolCallCount || 0));
      pipeline.phase = "discover";
      pipeline.updatedAt = new Date().toISOString();
      const audit = updateAmazonPipelineCoverage(stores);
      if ($('[data-view="results"]')?.classList.contains("is-active")) renderResults();
      else setText("navCandidateCount", products.length);
      const completed = pipeline.stores.filter((entry) => ["discovered", "analyzed", "terminal"].includes(entry.status)).length;
      onProgress(completed, stores.length, audit);
      await persistCurrentRunRequired(signal);
    }

    pipeline.phase = "analyze";
    pipeline.updatedAt = new Date().toISOString();
    await persistCurrentRunRequired(signal);
    const analysisStates = pipeline.stores.filter((entry) => entry.status === "discovered");
    for (let index = 0; index < analysisStates.length; index += AMAZON_STORE_BATCH_SIZE) {
      const chunkStates = analysisStates.slice(index, index + AMAZON_STORE_BATCH_SIZE);
      const chunk = chunkStates.map((entry) => stores[entry.index]).filter(Boolean);
      const queuedDetailAsins = allowSellerSprite ? [] : amazonDetailAsinsForPipelineStates(chunkStates, stores);
      const totalDetailAsins = queuedDetailAsins.length;
      let data;
      let pendingDetailAsins = allowSellerSprite ? null : queuedDetailAsins.splice(0, AMAZON_DETAIL_BATCH_SIZE);
      let detailRetriesUsed = 0;
      let lastDetailRepairRequest = false;
      if (!allowSellerSprite && !pendingDetailAsins.length) {
        chunkStates.forEach((entry) => {
          entry.status = "analyzed";
          entry.retryAt = null;
        });
        pipeline.updatedAt = new Date().toISOString();
        updateAmazonPipelineCoverage(stores);
        await persistCurrentRunRequired(signal);
        continue;
      }
      while (true) {
        lastDetailRepairRequest = Array.isArray(pendingDetailAsins);
        try {
          data = await apiRequest("/api/products/search", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              runId: runState.id,
              phase: "analyze",
              marketplace: runState.marketplace,
              stores: chunk,
              inputMode: isAsinImport() ? "asins" : "stores",
              useSellerSprite: allowSellerSprite === true,
              detailAsins: pendingDetailAsins || undefined,
              filters: {
                monthlySalesBand: criteria.monthlySalesBand,
                minReviews: criteria.minReviews,
                maxReviews: criteria.maxReviews,
                minRating: criteria.minRating,
              },
            }),
            signal,
            timeout: 30 * 60_000,
          });
        } catch (error) {
          const decision = !allowSellerSprite
            ? decideAmazonDetailRetry({ retriesUsed: detailRetriesUsed, codes: [error?.code], status: error?.status }) : null;
          if (!signal.aborted && decision?.reason === "access_restricted") await pauseAmazonDetails(decision, chunkStates, pendingDetailAsins);
          if (signal.aborted || isAmazonPipelineRequestConfigurationError(error)) throw error;
          if (!allowSellerSprite) {
            if (decision.action === "pause") await pauseAmazonDetails(decision, chunkStates, pendingDetailAsins);
            detailRetriesUsed = decision.retriesUsed;
          }
          pipeline.phase = "analyze_waiting";
          pipeline.updatedAt = new Date().toISOString();
          setStage(2, allowSellerSprite
            ? `SellerSprite 分析已暂停 · 已保留 ${products.length} 个 ASIN，请重新点击后继续`
            : `Amazon 商品详情暂时中断 · 已保留 ${products.length} 个 ASIN，稍后自动继续`, 70);
          await persistCurrentRunRequired(signal);
          if (allowSellerSprite) throw error;
          await delayWithSignal(AMAZON_RETRY_FALLBACK_MS, signal);
          pipeline.phase = "analyze";
          continue;
        }

        if (data.discoveryComplete !== true) {
          const visits = data.storeVisits || [];
          let incompleteStores = 0;
          chunkStates.forEach((entry) => {
            const visit = visits.find((candidate) => amazonPipelineStateForVisit(chunkStates, candidate) === entry);
            if (visit?.complete === true) {
              entry.status = "discovered";
              entry.retryAt = null;
              return;
            }
            incompleteStores += 1;
            entry.status = visit?.status === "waiting" ? "waiting" : "pending";
            entry.lastCode = visit?.code || visit?.interruption?.code || "AMAZON_DISCOVERY_REQUIRED";
            entry.retryAt = visit?.retryAt || (entry.status === "waiting"
              ? new Date(Date.now() + retryDelayForAmazonVisit(visit)).toISOString()
              : null);
          });
          if (incompleteStores === 0) {
            chunkStates.forEach((entry) => {
              entry.status = "pending";
              entry.lastCode = "AMAZON_DISCOVERY_REQUIRED";
              entry.retryAt = null;
            });
          }
          replaceAmazonStoreVisits(visits, chunkStates);
          mergeAmazonRunErrors(data.errors);
          unresolved.push(...(data.unresolved || []));
          pipeline.phase = "discover";
          pipeline.updatedAt = new Date().toISOString();
          updateAmazonPipelineCoverage(stores);
          await persistCurrentRunRequired(signal);
          continue pipelineCycle;
        }

        const expectedAsins = Number(data.analysisAudit?.uniqueAsins ?? 0);
        const retainedAsins = Number(data.analysisAudit?.retainedSourceAsins ?? (data.items || data.products || []).length);
        const batchItems = data.items || data.products || [];
        const retryableDetailFailures = batchItems.filter((item) => {
          if (item?.detailStatus === "success" || item?.detailRetryable !== true) return false;
          const sourceAsin = String(item.sourceAsin || item.asin || "").trim().toUpperCase();
          const retainedSuccess = products.find((product) => String(product.sourceAsin || product.asin || "").trim().toUpperCase() === sourceAsin);
          return retainedSuccess?.detailStatus !== "success"
            || Number(retainedSuccess.detailParserVersion || 0) < AMAZON_DETAIL_PARSER_VERSION;
        });
        const detailRetryDecision = !allowSellerSprite ? decideAmazonDetailRetry({
          retriesUsed: detailRetriesUsed,
          codes: batchItems.filter((item) => item?.detailStatus !== "success").map((item) => item.detailErrorCode),
        }) : null;
        if ((Number.isFinite(expectedAsins) && expectedAsins > retainedAsins) || retryableDetailFailures.length
          || detailRetryDecision?.reason === "access_restricted") {
          mergeAnalysisBatch(data, chunkStates, { replaceVisits: !lastDetailRepairRequest });
          chunkStates.forEach((entry) => {
            entry.status = "discovered";
            entry.lastCode = retryableDetailFailures[0]?.detailErrorCode || "AMAZON_DETAIL_INCOMPLETE";
            entry.retryAt = new Date(Date.now() + AMAZON_RETRY_FALLBACK_MS).toISOString();
          });
          pipeline.phase = "analyze_waiting";
          pipeline.updatedAt = new Date().toISOString();
          updateAmazonPipelineCoverage(stores);
          renderResults();
          await persistCurrentRunRequired(signal);
          if (allowSellerSprite) {
            throw createRunError(
              "SELLSPRITE_ANALYSIS_INCOMPLETE",
              `SellerSprite 本批应保留 ${expectedAsins} 个 ASIN，实际返回 ${retainedAsins} 个；请重新点击后从同一断点继续。`,
            );
          }
          if (detailRetryDecision.action === "pause") await pauseAmazonDetails(detailRetryDecision, chunkStates, pendingDetailAsins);
          detailRetriesUsed = detailRetryDecision.retriesUsed;
          setStage(2, `Amazon 详情待补 ${retryableDetailFailures.length || Math.max(0, expectedAsins - retainedAsins)} 个 · 已保存断点，15 秒后自动重试`, 70);
          if (retryableDetailFailures.length) {
            pendingDetailAsins = [...new Set(retryableDetailFailures
              .map((item) => String(item.sourceAsin || item.asin || "").trim().toUpperCase())
              .filter(Boolean))];
          }
          await delayWithSignal(AMAZON_RETRY_FALLBACK_MS, signal);
          pipeline.phase = "analyze";
          chunkStates.forEach((entry) => { entry.retryAt = null; });
          continue;
        }
        if (!allowSellerSprite && queuedDetailAsins.length) {
          mergeAnalysisBatch(data, chunkStates);
          const completedDetailAsins = totalDetailAsins - queuedDetailAsins.length;
          chunkStates.forEach((entry) => {
            entry.status = "discovered";
            entry.lastCode = null;
            entry.retryAt = null;
          });
          pipeline.phase = "analyze";
          pipeline.updatedAt = new Date().toISOString();
          updateAmazonPipelineCoverage(stores);
          renderResults();
          setStage(2, `Amazon 商品详情已保存 ${completedDetailAsins}/${totalDetailAsins} 个 · 正在继续下一批`, 70);
          await persistCurrentRunRequired(signal);
          pendingDetailAsins = queuedDetailAsins.splice(0, AMAZON_DETAIL_BATCH_SIZE);
          detailRetriesUsed = 0;
          continue;
        }
        break;
      }
      mergeAnalysisBatch(data, chunkStates, { replaceVisits: !lastDetailRepairRequest });
      chunkStates.forEach((entry) => {
        entry.status = "analyzed";
        entry.retryAt = null;
      });
      pipeline.updatedAt = new Date().toISOString();
      updateAmazonPipelineCoverage(stores);
      renderResults();
      await persistCurrentRunRequired(signal);
    }

    pipeline.phase = "amazon_complete";
    pipeline.updatedAt = new Date().toISOString();
    const visitAudit = updateAmazonPipelineCoverage(stores);
    reconcileRecoveredAmazonProductErrors();
    const analysisAudit = {
      uniqueAsins: products.length,
      detailRequested: products.length,
      detailCallsStarted: products.length,
      detailCacheHits: 0,
      detailReturned: products.filter((product) => product.detailStatus === "success").length,
      detailFailed: products.filter((product) => product.detailStatus !== "success").length,
      wideCandidates: products.length,
      selectedCandidates: products.filter((product) => matchesProductCriteria(product, activeRunCriteria)).length,
      rateLimitWaits: 0,
    };
    await persistCurrentRunRequired(signal);
    return {
      items: [...collectedItems.values()],
      errors: runState.errors || [],
      unresolved,
      enrichment: null,
      storeVisits: runState.storeVisits || [],
      visitAudit,
      analysisAudit,
      sourceMarketplace: sourceMarketplace || runState.marketplace,
      providerMarketplace,
      providerMode,
      runToolCallCount,
    };
    }
  }

  function manualAmazonListingDateSnapshot(...candidates) {
    const source = candidates.find(product => product?.manualAmazonFields?.amazonFirstAvailableDate === true
      || product?.fieldSources?.amazonFirstAvailableDate === "manual");
    if (!source) return null;
    return {
      amazonFirstAvailableDate: source.amazonFirstAvailableDate,
      amazonFirstAvailableDateStatus: source.amazonFirstAvailableDateStatus,
      amazonFirstAvailableDateEvidence: source.amazonFirstAvailableDateEvidence == null ? source.amazonFirstAvailableDateEvidence : structuredClone(source.amazonFirstAvailableDateEvidence),
    };
  }

  function applyManualAmazonListingDate(product, manualDate) {
    if (!manualDate) return;
    Object.assign(product, manualDate);
    product.manualAmazonFields = { ...(product.manualAmazonFields || {}), amazonFirstAvailableDate: true };
    product.fieldSources = { ...(product.fieldSources || {}), amazonFirstAvailableDate: "manual" };
  }

  function mergeAnalyzedCandidateProducts(items) {
    if (runState.archivedAt) return;
    const byId = new Map(products.map((product) => [product.id, product]));
    (items || []).map(mapCandidateProduct).forEach((incoming) => {
      const existing = byId.get(incoming.id);
      if (isAnalysisReadOnly(existing)) return;
      if (!existing) {
        prepareProductForReview(incoming);
        byId.set(incoming.id, incoming);
        return;
      }
      const decisionBefore = [
        finiteOrNull(existing.currentPrice),
        finiteOrNull(existing.salePrice), finiteOrNull(existing.purchaseCost), finiteOrNull(getFulfillmentFee(existing)),
        finiteOrNull(existing.billingWeight), finiteOrNull(existing.targetCostCny), finiteOrNull(existing.margin),
      ];
      const manualListingDate = manualAmazonListingDateSnapshot(incoming, existing);
      const preserveManualFulfillment = existing.fulfillmentModeSource === "manual"
        || existing.manualFbaFee === true
        || existing.manualFbmFee === true;
      const preserveManualCurrentPrice = hasManualAmazonPrice(existing);
      const preserveManualMonthlySales = existing.manualAmazonFields?.sales30 === true
        || existing.fieldSources?.sales30 === "manual";
      const refreshFromSuccess = incoming.detailStatus === "success" && !hasFailedAmazonDetailAttempt(incoming);
      if (Number.isFinite(existing.currentPrice) && !existing.priceVerifiedAt) existing.priceVerifiedAt = existing.collectedAt || null;
      const refreshExisting = existing.detailStatus !== "success" && refreshFromSuccess;
      const supplierWasMissingInputs = existing.supplierSearchStatus === "missing_inputs"
        && existing.supplierSearchErrorCode === "MISSING_INPUTS";
      const refreshFields = [
        "parentAsin", "parentResolved",
        "name", "englishName", "translatedTitleZh", "price30", "sales30", "sales30Evidence", "amazonSales30Evidence", "rating", "reviews", "imageUrl",
        "productWeight", "fbaWeight", "productWeightEvidence", "packageWeightEvidence", "productInformation", "collectionQuality", "productDimensions", "fbaDimensions", "parameterSource", "fulfillment",
        "collectedAt", "dataSource", "filterMatch", "filterExclusionReasons",
        "amazonFirstAvailableDate", "amazonFirstAvailableDateEvidence", "amazonFirstAvailableDateStatus",
      ];
      refreshFields.forEach((field) => {
        if (preserveManualMonthlySales && ["sales30", "sales30Evidence", "amazonSales30Evidence"].includes(field)) return;
        if (refreshFromSuccess && ["productInformation", "collectionQuality", "amazonFirstAvailableDate", "amazonFirstAvailableDateEvidence", "amazonFirstAvailableDateStatus"].includes(field)) {
          existing[field] = incoming[field];
          return;
        }
        const missing = existing[field] === null || existing[field] === undefined || existing[field] === "";
        const incomingAvailable = incoming[field] !== null && incoming[field] !== undefined && incoming[field] !== "";
        if ((refreshFromSuccess && incomingAvailable) || missing) existing[field] = incoming[field];
      });
      mergeAmazonDetailAudit(existing, incoming);
      if (!preserveManualFulfillment && (refreshExisting || !existing.fulfillmentMode)) {
        existing.fulfillmentMode = incoming.fulfillmentMode;
        existing.fulfillmentModeSource = incoming.fulfillmentModeSource;
      }
      existing.fieldSources = refreshFromSuccess
        ? { ...(existing.fieldSources || {}), ...(incoming.fieldSources || {}) }
        : { ...(incoming.fieldSources || {}), ...(existing.fieldSources || {}) };
      if (preserveManualCurrentPrice) existing.fieldSources.currentPrice = "manual";
      if (preserveManualMonthlySales) existing.fieldSources.sales30 = "manual";
      applyManualAmazonListingDate(existing, manualListingDate);
      mergeAmazonPriceState(existing, incoming, { analysisSourceMode: runState.analysisSourceMode });
      existing.sourceAsins = [...new Set([...(existing.sourceAsins || []), ...(incoming.sourceAsins || [])])];
      existing.sourceStores = mergeSourceStores(existing.sourceStores, incoming.sourceStores);
      refreshProductWeightState(existing);
      if (!existing.manualSalePrice) existing.salePrice = calculateOurSalePrice(existing);
      refreshSupplierTarget(existing);
      if (supplierWasMissingInputs && existing.imageUrl && Number.isFinite(existing.targetCostCny)) {
        existing.supplierSearchStatus = isProductInSupplierCohort(existing.id) ? "pending" : "not_started";
        existing.supplierSearchErrorCode = null;
        existing.supplierSearchError = null;
      }
      applyAutomaticFba(existing);
      rebuildProductMissing(existing);
      updateProductComputed(existing);
      const decisionAfter = [
        finiteOrNull(existing.currentPrice),
        finiteOrNull(existing.salePrice), finiteOrNull(existing.purchaseCost), finiteOrNull(getFulfillmentFee(existing)),
        finiteOrNull(existing.billingWeight), finiteOrNull(existing.targetCostCny), finiteOrNull(existing.margin),
      ];
      const decisionChanged = decisionBefore.some((value, index) => {
        const next = decisionAfter[index];
        if (value === null || next === null) return value !== next;
        return Math.abs(value - next) > 0.0001;
      });
      if (existing.reviewStatus === "approved" && decisionChanged) existing.reviewStatus = "pending";
    });
    products = [...byId.values()];
  }

  function mergeSourceStores(left = [], right = []) {
    const unique = new Map();
    [...left, ...right].forEach((store, index) => {
      const key = `${store?.sellerId || ""}:${store?.sellerName || ""}:${store?.rowNumbers?.join(",") || index}`;
      if (!unique.has(key)) unique.set(key, store);
    });
    return [...unique.values()];
  }

  function mergeCandidateRecords(left, right) {
    const manualListingDate = manualAmazonListingDateSnapshot(right, left);
    const fields = [
      "title", "translatedTitle", "sellerId", "sellerName", "averagePrice30", "currentPrice", "sales30", "sales60",
      "salesAmount30", "sales30UpdatedAt", "sales30Evidence", "amazonSales30Evidence", "parentSales30", "parentSalesAmount30", "fbaFee", "fbaFeeSource", "primePrice", "deliveryPrice",
      "firstFbaAt", "listingAvailableAt", "rating", "reviewCount", "hasAPlus", "productWeightKg", "fbaPackageWeightKg",
      "productDimensionsCm", "fbaPackageDimensionsCm", "productWeightEvidence", "packageWeightEvidence", "productInformation", "collectionQuality", "fulfillment", "imageUrl",
      "sourceMarketplace", "providerMarketplace", "providerMode", "detailParserVersion",
      "amazonFirstAvailableDate", "amazonFirstAvailableDateEvidence", "amazonFirstAvailableDateStatus",
    ];
    const score = (item) => fields.filter((field) => item[field] !== null && item[field] !== undefined && item[field] !== "").length;
    const primary = score(right) > score(left) ? right : left;
    const secondary = primary === left ? right : left;
    const merged = { ...primary };
    fields.forEach((field) => {
      if (right.detailStatus === "success" && !hasFailedAmazonDetailAttempt(right)
        && ["productInformation", "collectionQuality", "amazonFirstAvailableDate", "amazonFirstAvailableDateEvidence", "amazonFirstAvailableDateStatus"].includes(field)) {
        merged[field] = right[field] ?? null;
        return;
      }
      const rightAvailable = right[field] !== null && right[field] !== undefined && right[field] !== "";
      if (rightAvailable) merged[field] = right[field];
      else if (merged[field] === null || merged[field] === undefined || merged[field] === "") merged[field] = secondary[field];
    });
    merged.fieldSources = { ...(left.fieldSources || {}), ...(right.fieldSources || {}) };
    if (hasManualAmazonPrice(left)) merged.fieldSources.currentPrice = "manual";
    applyManualAmazonListingDate(merged, manualListingDate);
    if (Object.prototype.hasOwnProperty.call(right, "detailStatus")) {
      // Keep successful detail/price provenance together across partial batches.
      for (const field of ["detailStatus", "detailErrorCode", "detailError", "detailRetryable", "detailParserVersion", "currentPrice", "priceEvidence", "currentPriceStatus", "priceRevalidation", "collectionLastAttempt", "lastCollectionError"]) {
        merged[field] = left[field];
      }
      merged.priceVerifiedAt = left.priceVerifiedAt || left.collectedAt || null;
      merged.lastKnownAmazonPrice = left.lastKnownAmazonPrice;
      merged.priceRefresh = left.priceRefresh;
      mergeAmazonDetailAudit(merged, right);
      mergeAmazonPriceState(merged, right, { analysisSourceMode: runState.analysisSourceMode });
    }
    const stores = [...(left.sourceStores || []), ...(right.sourceStores || [])];
    const seenStores = new Set();
    merged.sourceStores = stores.filter((store) => {
      const key = `${store.storeIndex ?? ""}:${store.sellerId || ""}:${store.sellerName || ""}:${store.rowNumbers?.join(",") || ""}`;
      if (seenStores.has(key)) return false;
      seenStores.add(key);
      return true;
    });
    merged.parentResolved = Boolean(left.parentResolved || right.parentResolved);
    if (left.competitorLookupStatus === "success" || right.competitorLookupStatus === "success") {
      const successful = left.competitorLookupStatus === "success" ? left : right;
      merged.competitorLookupStatus = "success";
      merged.competitorLookupErrorCode = null;
      merged.competitorLookupError = null;
      merged.competitorLookupCollectedAt = successful.competitorLookupCollectedAt || null;
    }
    if (left.salesTrendStatus === "enriched" || right.salesTrendStatus === "enriched") {
      const enriched = left.salesTrendStatus === "enriched" ? left : right;
      merged.salesTrendStatus = "enriched";
      merged.salesTrendMonths = enriched.salesTrendMonths || [];
    }
    return merged;
  }

  function mapCandidateProduct(item, index) {
    const sourceAsin = String(item.sourceAsin || item.asin || item.parentAsin || item.parent || "").trim().toUpperCase();
    const parentAsin = String(item.parentAsin || item.parent || "").trim().toUpperCase() || null;
    const asin = sourceAsin || parentAsin || "";
    const sellerId = String(item.sellerId || "").trim();
    const sellerName = String(item.sellerName || item.storeName || "未知店铺").trim();
    const tones = ["visual-coral", "visual-mint", "visual-blue", "visual-yellow", "visual-lilac", "visual-green"];
    const icons = ["package-search", "box", "shopping-bag", "scan-search", "package", "store"];
    const marketplace = String(item.marketplace || runState.marketplace || activeMarket.code).toUpperCase();
    const sourceMarketplace = String(item.sourceMarketplace || runState.sourceMarketplace || marketplace).toUpperCase();
    const providerMarketplace = String(item.providerMarketplace || runState.providerMarketplace || "").toUpperCase() || null;
    const providerMode = String(item.providerMode || runState.providerMode || "").toLowerCase() || null;
    const analysisSourceMode = item.analysisSourceMode || runState.analysisSourceMode || (providerMarketplace ? "amazon_sellsprite" : "amazon_only");
    const sourceContext = { marketplace, sourceMarketplace, providerMarketplace, providerMode, analysisSourceMode };
    const manualWeight = usesItemWeightOnly(item) ? resolveManualWeightOverride(item) : null;
    return {
      id: `${marketplace}:${sourceAsin || `${sellerId || "seller"}-${index}`}`,
      marketplace,
      marketplaceId: runState.marketplaceId,
      currency: runState.currency,
      amazonDomain: runState.amazonDomain,
      sourceMarketplace,
      providerMarketplace,
      providerMode,
      asin,
      sourceAsin,
      parentAsin,
      sourceAsins: Array.isArray(item.sourceAsins) ? [...new Set(item.sourceAsins.map((value) => String(value || "").trim().toUpperCase()).filter(Boolean))] : [sourceAsin].filter(Boolean),
      parentResolved: item.parentResolved !== false,
      name: item.translatedTitle || item.title || `Amazon 商品 ${asin}`,
      englishName: item.title || item.translatedTitle || "",
      translatedTitleZh: /[\u3400-\u9fff]/.test(String(item.translatedTitle || ""))
        ? String(item.translatedTitle).trim()
        : null,
      sellerId,
      storeName: sellerName,
      price30: finiteOrNull(item.averagePrice30 ?? item.avgPrice30 ?? item.averagePrice),
      currentPrice: candidateCurrentPrice(item),
      priceEvidence: item.priceEvidence ?? null,
      pageContextEvidence: item.pageContextEvidence || null,
      priceReadAttempt: item.priceReadAttempt || null,
      priceVerifiedAt: item.priceVerifiedAt || (Number.isFinite(item.currentPrice) ? item.collectedAt : null),
      priceRefresh: item.priceRefresh || null,
      lastKnownAmazonPrice: item.lastKnownAmazonPrice || null,
      currentPriceStatus: item.currentPriceStatus || (item.detailStatus === "success"
        ? candidateCurrentPrice(item) === null ? "unavailable" : "verified" : null),
      sales30: finiteOrNull(item.sales30 ?? item.units30 ?? item.amzUnit),
      sales30Evidence: item.sales30Evidence || null,
      amazonSales30Evidence: item.amazonSales30Evidence || null,
      sales60: finiteOrNull(item.sales60 ?? item.units60),
      salesAmount30: finiteOrNull(item.salesAmount30 ?? item.revenue30 ?? item.amzSales),
      sales30UpdatedAt: item.sales30UpdatedAt || null,
      parentSales30: finiteOrNull(item.parentSales30),
      parentSalesAmount30: finiteOrNull(item.parentSalesAmount30),
      purchaseCost: null,
      purchaseUnitCostCny: null,
      pieceCount: null,
      detectedPieceCount: null,
      pieceCountSource: null,
      pieceCountEvidence: null,
      pieceCountRuleVersion: TITLE_PIECE_COUNT_RULE_VERSION,
      fbaFee: finiteOrNull(item.fbaFee ?? item.fba),
      fbaFeeSource: item.fbaFeeSource || item.fieldSources?.fbaFee || null,
      primePrice: finiteOrNull(item.primePrice),
      deliveryPrice: finiteOrNull(item.deliveryPrice),
      fbmFee: null,
      billingWeight: usesItemWeightOnly(item) ? automaticProfitWeightKg(item) : finiteOrNull(item.fbaPackageWeightKg ?? item.packageWeightKg ?? item.productWeightKg ?? item.weightKg),
      productWeight: usesItemWeightOnly(item) ? automaticProductWeightKg(item) : finiteOrNull(item.productWeightKg ?? item.weightKg),
      fbaWeight: finiteOrNull(item.fbaPackageWeightKg ?? item.packageWeightKg),
      productWeightEvidence: item.productWeightEvidence ? structuredClone(item.productWeightEvidence) : null,
      packageWeightEvidence: item.packageWeightEvidence ? structuredClone(item.packageWeightEvidence) : null,
      collectionQuality: item.collectionQuality ? structuredClone(item.collectionQuality) : null,
      productInformation: item.productInformation ? structuredClone(item.productInformation) : null,
      weightSelection: item.weightSelection ? structuredClone(item.weightSelection) : null,
      collectionLastAttempt: item.collectionLastAttempt ? structuredClone(item.collectionLastAttempt) : null,
      lastCollectionError: item.lastCollectionError ? structuredClone(item.lastCollectionError) : null,
      productDimensions: formatDimensions(item.productDimensionsCm ?? item.dimensionsCm),
      fbaDimensions: formatDimensions(item.fbaPackageDimensionsCm ?? item.packageDimensionsCm),
      parameterSource: item.fbaPackageDimensionsCm || item.packageDimensionsCm
        ? "FBA 包装参数"
        : item.productDimensionsCm || item.dimensionsCm ? "商品参数回退" : "参数缺失",
      firstFba: item.firstFbaAt || item.firstFba || null,
      listingAvailableAt: item.listingAvailableAt || null,
      amazonFirstAvailableDate: normalizeISODateOnly(item.amazonFirstAvailableDate),
      amazonFirstAvailableDateEvidence: item.amazonFirstAvailableDateEvidence ? structuredClone(item.amazonFirstAvailableDateEvidence) : null,
      amazonFirstAvailableDateStatus: item.amazonFirstAvailableDateStatus || "unresolved",
      salesTrendStatus: item.salesTrendStatus || null,
      salesTrendMonths: Array.isArray(item.salesTrendMonths) ? item.salesTrendMonths : [],
      fieldSources: item.fieldSources && typeof item.fieldSources === "object" ? item.fieldSources : {},
      manualAmazonFields: item.manualAmazonFields && typeof item.manualAmazonFields === "object" ? { ...item.manualAmazonFields } : {},
      detailStatus: String(item.detailStatus || item.providerStatus || (item.providerError ? "failed" : "success")),
      detailErrorCode: String(item.detailErrorCode || item.providerError?.code || item.error?.code || "").trim() || null,
      detailError: String(item.detailError || item.providerError?.message || item.error?.message || "").trim() || null,
      detailRetryable: Boolean(item.detailRetryable ?? item.providerError?.retryable ?? item.error?.retryable),
      detailParserVersion: Number.isInteger(Number(item.detailParserVersion)) ? Number(item.detailParserVersion) : null,
      competitorLookupStatus: String(item.competitorLookupStatus || "not_requested"),
      competitorLookupErrorCode: String(item.competitorLookupErrorCode || "").trim() || null,
      competitorLookupError: String(item.competitorLookupError || "").trim() || null,
      competitorLookupCollectedAt: item.competitorLookupCollectedAt || null,
      rating: finiteOrNull(item.rating),
      reviews: finiteOrNull(item.reviewCount ?? item.reviews ?? item.ratings),
      moq: finiteOrNull(item.moq) || 100,
      risk: "实时数据待初审",
      visualIcon: icons[index % icons.length],
      visualTone: tones[index % tones.length],
      hasAPlus: typeof item.hasAPlus === "boolean" ? item.hasAPlus : null,
      missing: [],
      analysisSourceMode,
      dataSource: item.dataSource || analysisSourceLabel(sourceContext),
      dataMode: isProxyAnalysis(sourceContext) ? "proxy" : "live",
      collectedAt: item.collectedAt || new Date().toISOString(),
      imageUrl: item.imageUrl || null,
      canonicalUrl: item.canonicalUrl || null,
      fulfillment: item.fulfillment || null,
      fulfillmentMode: normalizeFulfillmentMode(item.fulfillment),
      fulfillmentModeSource: normalizeFulfillmentMode(item.fulfillment)
        ? item.fulfillmentModeSource || item.fieldSources?.fulfillmentMode || "provider"
        : null,
      sourceStores: Array.isArray(item.sourceStores) ? item.sourceStores : [],
      filterMatch: item.filterMatch !== false,
      filterExclusionReasons: Array.isArray(item.filterExclusionReasons) ? item.filterExclusionReasons : [],
      reviewStatus: "pending",
      manualSalePrice: false,
      manualFbaFee: false,
      manualFbmFee: false,
      manualPurchaseCost: false,
      ...(manualWeight ? { billingWeight: manualWeight.weightKg, manualBillingWeight: true, weightSource: manualWeight.source } : {}),
      rematchCount: 0,
      supplierSource: null,
      targetCostCny: null,
      thresholdCostCny: null,
      supplierAverageCny: null,
      supplierProfitable: null,
      roughMargin: null,
      supplierSearchStatus: "not_started",
      supplierSearchError: null,
      supplierSearchErrorCode: null,
      supplierCostMode: null,
      supplierCostConfidence: null,
      supplierSearchedAt: null,
      supplierRuleVersion: null,
      supplierSearchAudit: null,
    };
  }

  function refreshProductWeightState(product) {
    if (isAnalysisReadOnly(product)) return;
    const manualWeight = resolveManualWeightOverride(product);
    if (manualWeight) {
      product.billingWeight = manualWeight.weightKg;
      product.weightSource = manualWeight.source;
      product.manualProfitInputs = true;
      return;
    }
    if (usesItemWeightOnly(product)) {
      product.billingWeight = automaticProfitWeightKg(product);
      product.weightSource = profitWeightSourceLabel(product);
      return;
    }
    const hasValidProductWeight = Number.isFinite(product.productWeight) && product.productWeight > 0;
    const source = String(product.fieldSources?.productWeightKg || "");
    product.weightSource = hasValidProductWeight
      ? source === "amazon_package_weight_fallback" ? "Amazon 包装重量回退" : "Amazon 商品重量"
      : Number.isFinite(product.productWeight) ? "商品重量（值无效）" : "商品重量缺失";
    product.billingWeight = hasValidProductWeight ? product.productWeight : product.productWeight ?? null;
  }

  function prepareProductForReview(product) {
    if (isAnalysisReadOnly(product)) return;
    if (product.detailStatus === "success") {
      invalidateLegacyAmazonPrice(product, { analysisSourceMode: runState.analysisSourceMode });
    }
    ensureFulfillmentState(product);
    assumeFbaForWeightedProduct(product);
    refreshProductWeightState(product);
    ensureProductPieceCount(product);
    ensureProductProfitInputs(product);
    product.salePrice = calculateOurSalePrice(product);
    product.targetCostCny = calculateTargetCostCny(product);
    product.thresholdCostCny = Number.isFinite(product.targetCostCny)
      ? roundMoney(product.targetCostCny * SUPPLIER_PROFIT_THRESHOLD)
      : null;
    if (!isManualCostProduct(product)) {
      product.purchaseCost = null;
      product.purchaseUnitCostCny = null;
    }
    product.suppliers = [];
    product.supplierSource = null;
    product.supplierSearchStatus = "not_started";
    product.supplierSearchError = null;
    product.supplierSearchErrorCode = null;
    product.supplierCostMode = null;
    product.supplierCostConfidence = null;
    applyAutomaticFba(product);
    rebuildProductMissing(product);
    updateProductComputed(product);
  }

  function collectMissingFields(product) {
    const missing = [];
    const amazonOnly = product.analysisSourceMode === "amazon_only";
    if (!product.sourceAsin && !product.asin) missing.push("源 ASIN");
    if (!product.sellerId && !product.storeName) missing.push("店铺标识");
    if (!String(product.name || product.englishName || "").trim() || (/^Amazon 商品\s+/i.test(String(product.name || "")) && !product.manualAmazonFields?.title)) missing.push("商品标题");
    if (!Number.isFinite(product.currentPrice)) missing.push("当前售价");
    else if (product.currentPrice <= 0) missing.push("当前售价（值无效）");
    if (!Number.isFinite(product.rating)) missing.push("竞品评价星级");
    if (!Number.isFinite(product.reviews)) missing.push("竞品评价数量");
    if (!product.imageUrl) missing.push("商品主图");
    if (!hasAnyProductShippingSpecification(product)) missing.push("商品重量、包裹重量及尺寸均缺失");
    if (!amazonOnly) {
      if (!Number.isFinite(product.sales30)) missing.push("竞品 30 天销量");
      if (!Number.isFinite(product.sales60)) missing.push("竞品 60 天销量");
      if (typeof product.hasAPlus !== "boolean") missing.push("竞品 A+ 状态");
      if (!product.firstFba) missing.push("首次 FBA 有货时间");
      if (!normalizeFulfillmentMode(product.fulfillmentMode || product.fulfillment)) missing.push("履约方式");
    }
    return missing;
  }

  function rebuildProductMissing(product) {
    if (isAnalysisReadOnly(product)) return product.missing || [];
    const amazonMissing = collectMissingFields(product);
    const missing = [...amazonMissing];
    const profitInputs = ensureProductProfitInputs(product);
    if (!Number.isFinite(product.purchaseCost) || product.purchaseCost < 0) missing.push("采购成本");
    if (!Number.isFinite(getFulfillmentFee(product)) || getFulfillmentFee(product) < 0) {
      missing.push(fulfillmentFeeMissingLabel(product.fulfillmentMode));
    }
    if ((!Number.isFinite(profitInputs.actualWeightKg) || profitInputs.actualWeightKg <= 0)
      && !(marketDimensionalWeightKg(resolveProductDimensionsCm(product), product.marketplace || activeMarket.code) !== null)) missing.push("计费重量");
    if (!Number.isFinite(profitInputs.airFreightRateCnyPerKg) || profitInputs.airFreightRateCnyPerKg < 0) missing.push("空运单价");
    product.amazonMissing = [...new Set(amazonMissing)];
    product.missing = [...new Set(missing)];
    return product.missing;
  }

  function sellerSpriteDetailFailureLabel(product) {
    if (String(product?.detailStatus || "").toLowerCase() === "success") return null;
    const code = String(product?.detailErrorCode || "").trim().toUpperCase();
    const amazonOnly = product?.analysisSourceMode === "amazon_only";
    if (amazonOnly) {
      const labels = {
        AMAZON_DETAIL_PENDING: "Amazon 商品详情等待抓取",
        AMAZON_ACCESS_CHALLENGE: "Amazon 商品页需要人工验证",
        AMAZON_HTTP_429: "Amazon 商品页访问频率受限",
        AMAZON_PRODUCT_INVALID: "Amazon 商品页未返回可用详情",
        AMAZON_PRODUCT_DETAIL_FAILED: "Amazon 商品详情读取失败",
      };
      if (labels[code]) return labels[code];
      const amazonMessage = String(product?.detailError || "").trim();
      return amazonMessage ? `Amazon 详情失败：${amazonMessage}` : `Amazon 详情待补${code ? `（${code}）` : ""}`;
    }
    const labels = {
      ERROR_MAXIMUM_ACCESS_PER_MINUTE: "SellerSprite 达到每分钟访问上限；新任务会自动等待下一分钟并继续",
      SELLSPRITE_SESSION_LOST: "SellerSprite 授权会话已失效",
      SELLSPRITE_AUTH_REQUIRED: "SellerSprite 需要重新授权",
      INVALID_PROVIDER_ITEM: "SellerSprite 未返回可用的 ASIN 详情",
      INVALID_PROVIDER_RESPONSE: "SellerSprite 返回格式无法识别",
      SELLSPRITE_UPSTREAM_ERROR: "SellerSprite 上游服务返回错误",
    };
    if (labels[code]) return labels[code];
    const message = String(product?.detailError || "").trim();
    return message ? `SellerSprite 详情失败：${message}` : `SellerSprite 详情待补${code ? `（${code}）` : ""}`;
  }

  function sellerSpriteCompetitorLookupLabel(product) {
    const status = String(product?.competitorLookupStatus || "not_requested").toLowerCase();
    if (status === "success") return "成功 · 最近 30 天";
    if (status === "unsupported") return "当前分析站点不受查竞品接口支持";
    if (status === "empty") return "接口未返回该 ASIN";
    if (status === "not_requested") return "未执行";
    const message = String(product?.competitorLookupError || "").trim();
    return message || `失败${product?.competitorLookupErrorCode ? `（${product.competitorLookupErrorCode}）` : ""}`;
  }

  function amazonPriceStatusLabel(product) {
    if (product?.priceRefresh?.status === "pending") {
      const verifiedAt = product.priceVerifiedAt;
      const time = verifiedAt && Number.isFinite(Date.parse(verifiedAt))
        ? new Date(verifiedAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false }) : "";
      return product.priceRefresh.retained
        ? `上次核验报价 · 本次待复核${time ? `（北京时间 ${time}）` : ""}`
        : "本次未能读取报价，待复核";
    }
    if (product?.currentPriceStatus === "unavailable") {
      const reason = product.collectionQuality?.fields?.price?.reason || product.pageContextEvidence?.priceUnavailableReason;
      if (reason === "price_requires_cart" || reason === "delivery_region_unconfirmed") return "本次未能读取报价，待复核";
      if (reason === "unavailable") return "本次页面显示缺货，无有效售价";
      if (reason === "page_not_provided") return "页面无精选报价（需查看全部购买选项），无公开售价";
      return "本次页面未识别到售价";
    }
    return {
      pending_revalidation: "待重新核价",
      refresh_failed: "核价暂未成功",
      manual: "人工确认售价",
    }[product?.currentPriceStatus] || "";
  }

  function amazonCollectionFailure(product) {
    const attempt = product?.collectionLastAttempt;
    const retained = product?.lastCollectionError;
    const failed = ["failed", "error", "cancelled"].includes(String(product?.detailStatus || "").toLowerCase())
      || attempt?.status === "failed" || Boolean(retained);
    if (!failed) return null;
    const code = String(retained?.code || (attempt?.status === "failed" && attempt.code) || product.detailErrorCode || "").toUpperCase();
    const message = String(retained?.message || (attempt?.status === "failed" && attempt.message) || product.detailError || "").trim();
    const labels = {
      AMAZON_PRODUCT_ASIN_MISMATCH: Number(product.detailParserVersion) < 11
        ? "旧版 ASIN 校验未通过，待按新规则重新采集" : "上次采集记录的页面 ASIN 与输入不一致",
      AMAZON_ACCESS_CHALLENGE: message === "Amazon browser page requires access verification."
        ? "采集浏览器加载等待超时（旧版归类为访问验证），请人工核对" : "Amazon 要求验证码或访问验证，需人工处理",
      AMAZON_HTTP_429: "Amazon 限制访问频率",
      AMAZON_HTTP_404: "商品页面不存在或已移除",
      AMAZON_PRODUCT_INVALID: "页面未返回可用商品详情",
      AMAZON_DETAIL_NOT_RETURNED: "本次访问未返回该商品的详情",
      AMAZON_LOGIN_REQUIRED: "Amazon 登录已失效，需人工处理",
      AMAZON_AUTH_REQUIRED: "Amazon 登录已失效，需人工处理",
    };
    const reason = labels[code] || (/TIMEOUT|TIMED_OUT/.test(code) ? "页面访问超时，未完成读取"
      : /CONNECTION|ECONN|NETWORK|REQUEST_FAILED|NAVIGATION_FAILED/.test(code) ? "网络或页面连接中断"
        : /HTTP_5\d\d/.test(code) ? "Amazon 服务暂时未能响应"
          : message || "采集失败，未记录具体原因");
    return { code, message, reason, requiresAction: /CHALLENGE|CAPTCHA|LOGIN|AUTH_REQUIRED/.test(code) };
  }

  function hasUnavailableAmazonSpecifications(product) {
    const info = product?.productInformation;
    const inspection = info?.inspection;
    const specifications = inspection?.specifications;
    return info?.status === "incomplete" && (info.reason || inspection?.reason) === "inspection_timeout"
      && specifications?.pending === true && specifications.disabled === true && specifications.visible === false;
  }

  function amazonInformationIssue(product, field = "weight") {
    const info = product?.productInformation;
    if (!info) return "尚未完成商品信息区检查";
    if (info.inspection?.errorCode || info.inspection?.errorMessage) {
      const code = String(info.inspection.errorCode || "").toUpperCase();
      const message = String(info.inspection.errorMessage || "").trim();
      return /TIMEOUT|TIMED_OUT/.test(code) ? "浏览器检查超时，尚未完整读取商品信息"
        : /CONNECTION|ECONN|NETWORK|REQUEST_FAILED|NAVIGATION_FAILED|CLOSED|CONNECT_FAILED/.test(code) ? "浏览器连接或页面导航失败，商品信息检查未完成"
          : message ? `浏览器检查失败：${message}` : "浏览器检查失败，商品信息尚未完整读取";
    }
    if (hasUnavailableAmazonSpecifications(product)) {
      return field === "weight" ? "完整规格入口当前不可用，Item Weight 待核验" : "完整规格入口当前不可用，上架日期待核验";
    }
    const reason = info.reason || info.inspection?.reason;
    if (Number(product.detailParserVersion) < 11) {
      if (reason === "asin_mismatch") return "旧版 ASIN 校验未通过，待按新规则重新采集";
      if (field === "weight" && ["conflicting_values", "weight_value_conflict"].includes(reason)) {
        return "旧版重量核验未完成，待按 Item Weight 重新采集";
      }
    }
    return {
      conflicting_values: field === "weight" ? "重量值冲突，尚未确认有效重量" : "商品信息值冲突，尚未完成核验",
      weight_value_conflict: "重量值冲突，尚未确认有效重量",
      inspection_timeout: "商品信息区检查超时，尚未完整读取",
      asin_mismatch: "商品信息区 ASIN 不一致",
      no_information_root: "未找到商品信息区",
      no_information_rows: "商品信息区尚未加载出内容",
      unparsed_weight: "发现重量字段，但数值或单位未通过核验",
    }[reason] || (info.status !== "complete" ? "商品信息区尚未完整读取" : "重量数值或来源尚未通过核验");
  }

  function amazonFieldIssue(product, field) {
    if (field === "price" && product?.priceRefresh?.status === "pending") {
      const code = product.priceRefresh.browser?.code;
      return amazonPriceStatusLabel(product) + (code
        ? /TIMEOUT|TIMED_OUT/.test(code) ? "；浏览器核价超时" : `；浏览器核价未完成（${code}）` : "");
    }
    const quality = product?.collectionQuality?.fields?.[field];
    if (quality?.status === "verified") return null;
    const reason = quality?.reason;
    if (field === "weight") {
      if (isAmazonWeightUnavailable(product)) return "已完整检查，页面未提供重量";
      if (/product_information_|page_not_provided/.test(reason || "") || !quality) return amazonInformationIssue(product);
    }
    const labels = {
      page_not_provided: "本次页面未提供", not_collected: "尚未读取",
      price_requires_cart: "当前页面未展示可核验报价", delivery_region_unconfirmed: "当前配送会话未展示可核验报价",
      unavailable: "页面显示缺货，无有效售价", request_failed: "本次页面访问失败",
      price_revalidation_pending: "售价需要重新核验", obsolete_price_parser: "旧版价格记录需要重新核验",
      price_evidence_missing: "缺少售价来源证据", price_evidence_incomplete: "售价来源证据不完整",
      price_not_positive: "售价数值无效", price_status_conflict: "售价数值与页面状态冲突",
      price_asin_mismatch: "售价来源 ASIN 不一致", price_currency_mismatch: "售价币种与站点不一致",
      price_evidence_value_mismatch: "售价与来源证据不一致", untrusted_price_source: "售价来源未通过核验",
      weight_source_missing: "缺少重量来源证据", weight_not_positive: "重量数值无效",
      manual_value_not_collected: "人工填写值，尚未由 Amazon 页面核验",
      invalid_title: "页面标题无效", invalid_image_url: "商品图片地址无效",
    };
    if (labels[reason]) return labels[reason];
    if (quality?.status === "unavailable") return "本次页面未提供";
    if (quality?.status === "invalid") return `返回值未通过核验${reason ? `（${reason}）` : ""}`;
    return quality ? `尚未完成字段核验${reason ? `（${reason}）` : ""}` : null;
  }

  function amazonProductCollectionNote(product) {
    if (product?.analysisSourceMode !== "amazon_only") return null;
    const failure = amazonCollectionFailure(product);
    const issues = failure ? [failure.reason] : [["price", "售价"], ["weight", "重量"], ["title", "标题"], ["image", "主图"]]
      .filter(([field]) => product.collectionQuality?.fields?.[field] && product.collectionQuality.fields[field].status !== "verified")
      .map(([field, label]) => `${label}：${amazonFieldIssue(product, field)}`);
    if (!failure && !issues.length && product.amazonFirstAvailableDateStatus === "unresolved"
      && (product.productInformation?.status === "incomplete" || product.collectionRecovery?.status && product.collectionRecovery.status !== "resolved")) {
      issues.push(`上架日期：${amazonInformationIssue(product, "date")}`);
    }
    if (!issues.length) return null;
    const job = currentAmazonCollectionJob();
    const asin = String(product.sourceAsin || product.asin || "").toUpperCase();
    const task = job?.tasks?.[asin];
    const recovery = product.collectionRecovery;
    const attempts = Math.max(0, Number(recovery?.attempts) || 0);
    const maxAttempts = Math.max(0, Number(recovery?.maxAttempts) || 0);
    const exhausted = recovery?.status === "exhausted";
    const pending = ["scheduled", "waiting"].includes(recovery?.status) || task?.status === "pending";
    let followup = "";
    if (failure?.requiresAction || job?.status === "needs_attention") followup = "等待人工处理，已停止自动请求";
    else if (job?.causeCode === "SUPPLIER_MATCHING") followup = "1688 匹配占用中，补查暂存";
    else if (job?.status === "paused" || job?.causeCode === "USER_PAUSED") followup = "已暂停，保留当前结果";
    else if (exhausted) followup = `自动补查已达上限${attempts ? `（已补查 ${attempts}${maxAttempts ? ` / ${maxAttempts}` : ""} 次）` : ""}`;
    else if (pending && job?.enabled !== false && (recovery?.status === "waiting" || ["queued", "running", "cooldown"].includes(job?.status))) {
      const next = recovery?.nextRetryAt || task?.nextRetryAt;
      followup = next && Number.isFinite(Date.parse(next))
        ? `待自动补查 · ${new Date(next).toLocaleString("zh-CN", { hour12: false })}`
        : recovery?.status === "waiting" ? "等待下次巡检安排补查" : attempts || task?.attempts ? "已排队重新查找" : "已排队采集";
      if (attempts && maxAttempts) followup += `（补查 ${attempts} / ${maxAttempts}）`;
    } else if (recovery?.status === "blocked") followup = "已停止自动补查，需处理原因后再查";
    else if (job?.status === "completed" || ["failed", "partial"].includes(task?.status)) followup = "本轮已结束";
    const prefix = failure ? "Amazon 采集失败" : "Amazon 字段核验";
    const detail = [issues.join("；"), followup].filter(Boolean).join("；");
    return { text: `${prefix}：${detail}`, code: failure?.code || product.productInformation?.inspection?.errorCode || "",
      rawMessage: failure?.message || product.productInformation?.inspection?.errorMessage || "",
      tone: failure || exhausted ? "error" : "warning" };
  }

  function amazonProductCollectionNoteHtml(product) {
    const note = amazonProductCollectionNote(product);
    if (!note) return "";
    const evidence = [note.code, note.rawMessage].filter(Boolean).join(" · ");
    const action = note.code === "AMAZON_ACCESS_CHALLENGE" && currentAmazonCollectionJob()?.causeCode === "AMAZON_ACCESS_CHALLENGE"
      ? '<button type="button" class="secondary-button" data-amazon-access>人工处理访问问题</button>' : "";
    return `<div class="amazon-collection-note is-${note.tone}" role="note"${evidence ? ` title="${escapeHtml(evidence)}"` : ""}>${escapeHtml(note.text)}${note.code ? `<span class="amazon-collection-code">${escapeHtml(note.code)}</span>` : ""}${action}</div>`;
  }

  function calculateOurSalePrice(product) {
    const manualSalePrice = finiteOrNull(product?.salePrice);
    if (product?.manualSalePrice === true) {
      return manualSalePrice !== null && manualSalePrice > 0 ? roundMoney(manualSalePrice) : null;
    }
    const currentPrice = finiteOrNull(product.currentPrice);
    if (currentPrice === null || currentPrice <= 0) return null;
    return roundMoney(currentPrice * COMPETITOR_PRICE_RATIO);
  }

  function ensureProductPieceCount(product) {
    if (isAnalysisReadOnly(product)) return product.pieceCount;
    const detected = extractTitlePieceCount(product?.englishName || product?.name || "");
    const savedCount = normalizePieceCount(product?.pieceCount);
    const manual = product?.pieceCountSource === "manual" && savedCount !== null;
    product.detectedPieceCount = detected.count;
    product.pieceCountEvidence = detected.evidence;
    product.pieceCountRuleVersion = TITLE_PIECE_COUNT_RULE_VERSION;
    product.pieceCount = manual ? savedCount : detected.count;
    product.pieceCountSource = manual ? "manual" : detected.source;
    return product.pieceCount;
  }

  function pieceCountSourceLabel(product) {
    ensureProductPieceCount(product);
    if (product.pieceCountSource === "manual") {
      return product.pieceCountEvidence
        ? `人工设置 · 标题识别 ${product.detectedPieceCount} 件（${product.pieceCountEvidence}）`
        : "人工设置 · 标题未出现明确数量";
    }
    return product.pieceCountEvidence
      ? `Amazon 标题自动识别 · ${product.pieceCountEvidence}`
      : "";
  }

  function pieceCountExportSource(product) {
    ensureProductPieceCount(product);
    if (product.pieceCountSource === "manual") return "人工设置";
    if (product.pieceCountSource === "amazon_title") return "Amazon 标题自动识别";
    return "标题未识别，默认 1 件";
  }

  function totalPurchaseCostCny(unitCostCny, pieceCount) {
    return calculatePieceAdjustedPurchaseCostCny(unitCostCny, pieceCount);
  }

  function ensureProductPurchasePricing(product) {
    if (isAnalysisReadOnly(product)) return { pieceCount: product.pieceCount, unitCostCny: product.purchaseUnitCostCny, totalCostCny: product.purchaseCost };
    const pieceCount = ensureProductPieceCount(product);
    // Earlier empty quote results were coerced through Number(null) to zero.
    // Preserve an explicit manual zero, but never treat an absent quote as free stock.
    if (!isManualCostProduct(product) && finiteOrNull(product.supplierAverageCny) === null
      && !(product.suppliers || []).some(quote => Number.isFinite(quote.unitPriceCny) && quote.unitPriceCny > 0)
      && (product.purchaseCost === 0 || product.purchaseUnitCostCny === 0)) {
      product.purchaseCost = null;
      product.purchaseUnitCostCny = null;
    }
    const totalCost = finiteOrNull(product.purchaseCost);
    const supplierUnitCost = finiteOrNull(product.supplierAverageCny);
    let unitCost = finiteOrNull(product.purchaseUnitCostCny);
    if (isManualCostProduct(product)) {
      if (unitCost === null && totalCost !== null) unitCost = totalCost / pieceCount;
    } else if (supplierUnitCost !== null) {
      unitCost = supplierUnitCost;
    } else if (unitCost === null && totalCost !== null) {
      unitCost = totalCost / pieceCount;
    }
    product.purchaseUnitCostCny = unitCost;
    const resolvedTotal = totalPurchaseCostCny(product.purchaseUnitCostCny, pieceCount);
    product.purchaseCost = resolvedTotal;
    return {
      pieceCount,
      unitCostCny: product.purchaseUnitCostCny,
      totalCostCny: resolvedTotal,
    };
  }

  function resolvePurchasePriceInput(product, raw, baseline) {
    const text = String(raw ?? "").trim();
    const entered = numberOrNull(text);
    const invalid = text !== "" && (entered === null || entered < 0);
    const manuallyEdited = !invalid && text !== "" && entered !== finiteOrNull(baseline);
    const pricing = product ? ensureProductPurchasePricing(product) : { unitCostCny: null };
    return {
      unitCostCny: invalid ? null : manuallyEdited ? entered : pricing.unitCostCny,
      manuallyEdited,
      manual: isManualCostProduct(product) || manuallyEdited,
      invalid,
    };
  }

  function purchasePriceInputNote(product, pricing) {
    if (pricing.invalid) return "采购单价必须是大于或等于 0 的有效数字。";
    if (pricing.unitCostCny === null) return "暂无 1688 采购均价，可先初审，采购成本稍后补充。";
    if (pricing.manual) return "使用人工采购单价；后续 1688 报价不会覆盖。";
    return Number.isFinite(product?.supplierAverageCny)
      ? "默认使用 1688 单件采购均价；修改后使用人工单价。"
      : "沿用已保存采购单价；修改后使用人工单价。";
  }

  function calculateTargetCostCny(product) {
    const salePrice = calculateOurSalePrice(product);
    if (salePrice === null || salePrice <= 0) return null;
    const exchangeRate = ensureProductProfitInputs(product).exchangeRate;
    return roundMoney(product.marketplace === "US"
      ? salePrice * 1.4
      : (salePrice * exchangeRate) / 5);
  }

  function refreshSupplierTarget(product) {
    if (isAnalysisReadOnly(product)) return;
    product.targetCostCny = calculateTargetCostCny(product);
    product.thresholdCostCny = Number.isFinite(product.targetCostCny)
      ? roundMoney(product.targetCostCny * SUPPLIER_PROFIT_THRESHOLD)
      : null;
    const pricing = ensureProductPurchasePricing(product);
    if (!Number.isFinite(pricing.totalCostCny) || !Number.isFinite(product.targetCostCny) || product.targetCostCny <= 0) {
      product.supplierProfitable = null;
      product.roughMargin = null;
      return;
    }
    product.supplierProfitable = pricing.totalCostCny <= product.thresholdCostCny;
    product.roughMargin = ((product.targetCostCny - pricing.totalCostCny) / product.targetCostCny) * 100;
  }

  function isProductInSupplierCohort(productId) {
    return Array.isArray(runState.supplier1688Pipeline?.productIds)
      && runState.supplier1688Pipeline.productIds.includes(productId);
  }

  function getAmazonFilteredProductsFor1688() {
    return getFilteredProducts().filter((product) => {
      if (isAnalysisReadOnly(product)) return false;
      if (!product || product.dataMode === "mock" || product.reviewStatus === "rejected") return false;
      if (isManualCostProduct(product)) return false;
      if (!/^[A-Z0-9]{10}$/i.test(String(product.asin || product.sourceAsin || "").trim())) return false;
      if (!product.imageUrl) return false;
      return !["complete", "fallback_estimate", "manual_cost"].includes(String(product.supplierSearchStatus || "not_started"));
    });
  }

  function amazonCollectionCompleteForSupplier() {
    if (!runState.id || ["idle", "mock"].includes(runState.mode)) return false;
    if (currentAmazonCollectionJob()) return currentAmazonCollectionJob().status === 'completed';
    if (runState.amazonPipeline?.phase === "amazon_complete") return true;
    return Boolean(runState.completedAt) && !amazonRunNeedsResume();
  }

  async function prepareAmazonCollectionForSupplier() {
    if (runState.archivedAt) return true;
    if (!currentAmazonCollectionJob()) return true;
    if (supplierCollectionTransition || amazonCollectionControlPending) return false;
    const requestedRunId = runState.id;
    // Finish older reads before pausing, so an in-flight snapshot cannot undo
    // the final pause revision or replace the fixed supplier batch later.
    supplierCollectionTransition = true;
    if (amazonCollectionPollTimer !== null) window.clearTimeout(amazonCollectionPollTimer);
    try {
      await amazonCollectionPollPromise;
      await amazonCollectionSnapshotPromise;
      if (runState.id !== requestedRunId) return false;
      if (!isCollectionWriteLocked() && !await persistCurrentRun({ notify: true })) return false;
      amazonCollectionControlPending = true;
      clearProfitAutoCommit();
      renderAmazonCollection();
      if (amazonCollectionJob?.runId !== requestedRunId) {
        // The server tracks another run as the active background collection
        // (or none after a restart), so a direct pause would be rejected with
        // COLLECTION_NOT_ACTIVE. Adopt this run first. When the older task is
        // still actively collecting the server answers COLLECTION_BUSY; pause
        // that stale task (its checkpoint stays saved on disk) and retry, so
        // starting supplier matching always replaces the old task instead of
        // failing with "无法进行匹配".
        let adopted = null;
        let lastError = null;
        let pausedStaleTask = false;
        for (let attempt = 0; attempt < 3 && !adopted; attempt += 1) {
          try {
            adopted = await apiRequest('/api/amazon/collection/start', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ runId: requestedRunId }), timeout: 30000,
            });
          } catch (error) {
            lastError = error;
            const staleRunId = amazonCollectionJob?.runId;
            if (error?.code !== 'COLLECTION_BUSY' || !staleRunId || staleRunId === requestedRunId) throw error;
            try {
              await requestTaskControl('amazon', { runId: staleRunId, action: 'pause' }, { timeout: 60000, before: amazonCollectionJob });
              pausedStaleTask = true;
            } catch (error) {
              if (error.code === 'CONTROL_OUTCOME_UNKNOWN') throw error;
              // The start retry below surfaces a definite business rejection.
            }
            await delay(1500);
            await loadAmazonCollectionStatus().catch(() => {});
            if (runState.id !== requestedRunId) return false;
          }
        }
        if (!adopted) throw lastError;
        if (runState.id !== requestedRunId) return false;
        applyAmazonCollectionJob(adopted);
        if (pausedStaleTask) {
          showToast('已清空之前的后台采集任务（断点已保留），当前任务已设为新的后台任务。', 'info', 5200);
        }
      }
      const job = await requestTaskControl('amazon', { runId: requestedRunId, action: 'pause_for_supplier' });
      if (runState.id !== requestedRunId) return false;
      applyAmazonCollectionJob(job);
      if (!await refreshAfterTaskControl('采集让出')) return false;
      const saved = currentAmazonCollectionJob();
      if (runState.id !== requestedRunId || job.workerActive !== false
        || !['paused', 'completed', 'needs_attention'].includes(saved?.status)
        || Number(amazonCollectionRevision) !== Number(job.revision)) {
        throw createRunError('COLLECTION_NOT_SETTLED', '后台采集尚未稳定暂停，请稍后重试匹配。');
      }
      return true;
    } catch (error) {
      showToast(error.code === 'CONTROL_OUTCOME_UNKNOWN' ? error.message : `尚未开始图片匹配：${error.message}`, error.code === 'CONTROL_OUTCOME_UNKNOWN' ? 'info' : 'error', 6500);
      return false;
    } finally {
      amazonCollectionControlPending = false;
      supplierCollectionTransition = false;
      renderAmazonCollection();
      scheduleAmazonCollectionPoll();
    }
  }

  async function releaseAmazonCollectionAfterSupplier() {
    if (runState.archivedAt) return;
    if (currentAmazonCollectionJob()?.causeCode !== 'SUPPLIER_MATCHING') return;
    const requestedRunId = runState.id;
    supplierCollectionTransition = true;
    if (amazonCollectionPollTimer !== null) window.clearTimeout(amazonCollectionPollTimer);
    try {
      await amazonCollectionPollPromise;
      await amazonCollectionSnapshotPromise;
      await persistenceSaveQueue;
      if (runState.id !== requestedRunId) return;
      const job = await requestTaskControl('amazon', { runId: requestedRunId, action: 'resume_after_supplier' });
      if (runState.id === requestedRunId) applyAmazonCollectionJob(job);
    } catch (error) {
      showToast(error.code === 'CONTROL_OUTCOME_UNKNOWN' ? error.message : `供应商匹配进度已保留，Amazon 采集恢复待确认：${error.message}`, 'info', 6500);
    } finally {
      supplierCollectionTransition = false;
      scheduleAmazonCollectionPoll();
    }
  }

  function archivedSupplierMatchingEnabled() {
    const pipeline = runState.supplier1688Pipeline;
    return Boolean(runState.archivedAt && pipeline?.owner === 'server'
      && pipeline.authorizedArchivedAt === runState.archivedAt && pipeline.status !== 'cancelled');
  }

  async function startArchived1688Matching(selectedProducts, { rematch = false } = {}) {
    if (storeImportPending || taskReplacementPending || supplier1688SelectionPending || isCollectionWriteLocked()) return false;
    if (supplier1688Queue?.ratePolicy?.pausedReason || supplier1688RiskTask?.id) {
      showToast('1688 正在冷却或等待验证，请按匹配面板提示处理后继续。', 'info', 6200);
      return false;
    }
    const runId = runState.id;
    const ids = [...new Set(selectedProducts.map(product => product.id))];
    if (!ids.length) { showToast(supplierNoPendingMessage(), 'info', 6200); return false; }
    supplier1688SelectionPending = true;
    try {
      if (!await persistCurrentRun({ notify: true }) || runState.id !== runId) return false;
      const state = await requestTaskControl('supplier', { runId, action: 'select_archived',
        archivedAt: runState.archivedAt, productIds: ids, rematch,
        criteria: { monthlySalesBand: activeRunCriteria.monthlySalesBand || 'all' } });
      if (!applySupplierPipelineState(state, runId)) return false;
      if (!await refreshAfterTaskControl('历史匹配范围保存') || runState.id !== runId) return false;
      if (state.status === 'needs_attention' || state.nextRetryAt && Date.parse(state.nextRetryAt) > Date.now()) {
        showToast(state.message || '历史匹配的验证暂停或冷却仍然有效，请按匹配面板提示处理后继续。', 'info', 6200);
        return false;
      }
      if (!supplier1688LoggedIn) {
        showToast('历史匹配范围已保存，请先登录并验证 1688，再点击继续匹配。', 'info', 6200);
        await start1688Session();
        return false;
      }
      return await startServerSupplierPipeline();
    } catch (error) {
      showToast(`历史匹配暂未开始：${error.message}`, error.code === 'CONTROL_OUTCOME_UNKNOWN' ? 'info' : 'error', 6500);
      return false;
    } finally {
      supplier1688SelectionPending = false;
      renderSupplier1688Stage();
      updateStartAvailability();
    }
  }

  async function startFiltered1688Matching() {
    if (storeImportPending || taskReplacementPending) return false;
    if (runState.archivedAt) return startArchived1688Matching(getAmazonFilteredProductsFor1688());
    if (supplier1688Queue?.ratePolicy?.pausedReason || supplier1688RiskTask?.id) {
      showToast(technical1688Pause()
        ? '搜图进程中断，断点已保留，请检查服务后点击「检查后继续」。'
        : supplier1688Queue?.ratePolicy?.pausedReason === "RATE_LIMITED"
        ? "搜图正在限流冷却，等待结束后会继续，当前进度已保留。"
        : "搜图队列已暂停，请先完成图片验证，再点击「验证完成，继续搜图」。", "info", 6200);
      return false;
    }
    if (hasActive1688Work() || amazonCollectionControlPending || supplierCollectionTransition) {
      showToast("当前批次仍在处理，请等待完成后再启动新的 1688 匹配。", "info", 4200);
      return false;
    }
    if (!runState.id || ["idle", "mock"].includes(runState.mode)) {
      showToast("请先抓取 Amazon 商品，再选择要匹配的商品。", "info", 5200);
      return false;
    }
    supplier1688SelectionPending = true;
    const selectionRunId = runState.id;
    try {
      if (!await prepareAmazonCollectionForSupplier()) return false;
      const selectedProducts = getAmazonFilteredProductsFor1688();
      if (runState.supplier1688Pipeline?.productIds?.length) {
        // Extend the latest saved task on the server. Never replace its
        // revision, historical results or per-product retry/task records.
        try {
          if (selectedProducts.length) {
            supplierPipelineState = await requestTaskControl('supplier', { runId: selectionRunId, action: 'append', productIds: [...new Set(selectedProducts.map(product => product.id))] });
            applySupplierPipelineState(supplierPipelineState, selectionRunId);
          }
          if (runState.id !== selectionRunId) return false;
          if (!await refreshAfterTaskControl('续配范围保存')) return false;
          if (runState.id !== selectionRunId) return false;
        } catch (error) {
          showToast(error.code === 'CONTROL_OUTCOME_UNKNOWN' ? error.message : `续配范围尚未保存：${error.message}`, error.code === 'CONTROL_OUTCOME_UNKNOWN' ? 'info' : 'error', 6500);
          return false;
        }
        const remaining = getPending1688ResumeProducts().length;
        if (!remaining) {
          showToast(supplierNoPendingMessage(), 'info', 6200);
          return true;
        }
        if (!supplier1688LoggedIn) {
          showToast(`原任务已保存，${remaining} 个商品待继续匹配；已有结果保留，请先登录并验证 1688。`, 'info', 6200);
          await start1688Session();
          return false;
        }
        return await resumePending1688Candidates();
      }
      if (!selectedProducts.length) {
        showToast("当前已确认的 Amazon 筛选下没有可发起 1688 匹配的商品。", "info", 5200);
        return false;
      }

      const now = new Date().toISOString();
      const selectionId = typeof window.crypto?.randomUUID === "function"
        ? window.crypto.randomUUID()
        : `selection-${Date.now()}`;
      const supplier1688Pipeline = {
        version: 2,
        status: supplier1688LoggedIn ? "queued" : "paused",
        selectionId,
        scope: "confirmed_amazon_filters",
        criteria: {
          monthlySalesBand: activeRunCriteria.monthlySalesBand || "all",
          minReviews: activeRunCriteria.minReviews ?? null,
          maxReviews: activeRunCriteria.maxReviews ?? null,
          minRating: activeRunCriteria.minRating ?? null,
          amazonFirstAvailableFrom: activeRunCriteria.amazonFirstAvailableFrom || null,
        },
        productIds: selectedProducts.map((product) => product.id),
        selectedCount: selectedProducts.length,
        matchableCount: selectedProducts.length,
        processed: 0,
        remaining: selectedProducts.length,
        startedAt: now,
        updatedAt: now,
        completedAt: null,
        lastReason: supplier1688LoggedIn ? "explicit_filtered_start" : "login_required",
      };
      runState.supplier1688Pipeline = supplier1688Pipeline;
      selectedProducts.forEach((product) => {
        product.supplierSearchStatus = "pending";
        product.supplierSearchError = null;
        product.supplierSearchErrorCode = null;
      });
      renderSupplier1688Stage();
      renderResults();
      const saved = await persistCurrentRun({ notify: true });
      if (runState.id !== selectionRunId) return false;
      if (!saved) {
        supplier1688Pipeline.status = "paused";
        supplier1688Pipeline.lastReason = "checkpoint_save_failed";
        showToast(`筛选批次尚未保存：${persistenceLastError?.message || "请重试"}；保存成功后才会调用 1688。`, "error", 6200);
        return false;
      }

      if (!supplier1688LoggedIn) {
        showToast(`已保存 ${selectedProducts.length} 个筛选商品；请在专用 Edge 登录 1688，在线验证后将只继续这一批。`, "info", 6800);
        await start1688Session();
        return false;
      }
      return await resumePending1688Candidates();
    } finally {
      supplier1688SelectionPending = false;
      if (runState.id === selectionRunId) await releaseAmazonCollectionAfterSupplier();
      updateStartAvailability();
    }
  }

  function getPending1688ResumeProducts() {
    if (!runState.id || ["idle", "mock"].includes(runState.mode)) return [];
    const cohortIds = Array.isArray(runState.supplier1688Pipeline?.productIds)
      ? new Set(runState.supplier1688Pipeline.productIds)
      : null;
    if (!cohortIds?.size) return [];
    if (runState.supplier1688Pipeline?.owner === 'server'
      && Number(runState.supplier1688Pipeline.remaining) === 0) return [];
    return products.filter((product) => cohortIds.has(product.id) && isPending1688ResumeCandidate(product));
  }

  function restorePending1688RiskStatus() {
    if (!supplier1688Auth) return false;
    apply1688SessionStatus(supplier1688Auth);
    return Boolean(supplier1688RiskTask?.id && Number(supplier1688Queue?.riskBlocked || 0) > 0);
  }

  function isPending1688ResumeCandidate(product) {
    const salesCriteria = runState.supplier1688Pipeline?.criteria || activeRunCriteria;
    if (isMonthlySalesFilterRequired(currentTaskInputMode(), salesCriteria.monthlySalesBand) && !hasQualifyingMonthlySales(product, salesCriteria)) return false;
    if (runState.supplier1688Pipeline?.owner === "server"
      && ["complete", "failed", "skipped"].includes(runState.supplier1688Pipeline.tasks?.[product.id]?.status)) return false;
    if (isAnalysisReadOnly(product)) return false;
    if (!product || product.dataMode === "mock" || product.reviewStatus === "rejected") return false;
    if (isManualCostProduct(product)) return false;
    if (!/^[A-Z0-9]{10}$/i.test(String(product.asin || product.sourceAsin || "").trim())) return false;
    if (!product.imageUrl) return false;
    const status = String(product.supplierSearchStatus || "not_started");
    if (["not_started", "pending", "missing_inputs", "not_logged_in", "session_expired", "queue_waiting", "searching"].includes(status)) return true;
    if (status !== "failed") return false;

    const directCode = String(product.supplierSearchErrorCode || "").trim();
    if (directCode) return is1688SessionError({ code: directCode });
    const priorError = [...(Array.isArray(runState.errors) ? runState.errors : [])]
      .reverse()
      .find((error) => error?.stage === "1688_image_search"
        && (error?.productId === product.id || (product.asin && error?.asin === product.asin)));
    return Boolean(priorError && is1688SessionError(priorError));
  }

  function summarizeCurrent1688Audit(reason = null) {
    const cohortIds = new Set(runState.supplier1688Pipeline?.productIds || []);
    const cohortProducts = products.filter((product) => cohortIds.has(product.id));
    const statusCount = (statuses) => cohortProducts.filter((product) => statuses.includes(product.supplierSearchStatus)).length;
    const pendingCount = getPending1688ResumeProducts().length;
    return {
      attempted: statusCount(["complete", "fallback_estimate", "similarity_insufficient", "insufficient", "similarity_unverified", "failed"]),
      complete: statusCount(["complete"]),
      fallback: statusCount(["fallback_estimate"]),
      insufficient: statusCount(["similarity_insufficient", "insufficient", "similarity_unverified"]),
      failed: statusCount(["failed"]),
      skipped: statusCount(["missing_inputs", "not_started", "not_logged_in", "session_expired", "queue_waiting", "pending", "searching"]),
      pending: pendingCount,
      reason: pendingCount ? reason || "session_expired" : null,
      resumeCount: Number(runState.supplier1688Resume?.attempt || 0),
      lastResumedAt: runState.supplier1688Resume?.completedAt || null,
    };
  }

  async function resumePending1688Candidates(batchRunner = null) {
    if (storeImportPending || taskReplacementPending || (runState.archivedAt && !archivedSupplierMatchingEnabled())) return false;
    if (runState.archivedAt) return startServerSupplierPipeline();
    if (!batchRunner) return startServerSupplierPipeline();
    if (supplier1688ResumePromise) return supplier1688ResumePromise;
    if (supplier1688Queue?.ratePolicy?.pausedReason || supplier1688RiskTask?.id) return false;
    if (!supplier1688LoggedIn) return false;
    if (isCollectionWriteLocked() && !await prepareAmazonCollectionForSupplier()) return false;
    if (supplier1688ResumePromise) return supplier1688ResumePromise;
    const pendingProducts = getPending1688ResumeProducts();
    if (!pendingProducts.length) return false;
    supplier1688ResumeRequested = false;

    const resumeRunId = runState.id;
    const controller = new AbortController();
    supplier1688ResumeController = controller;
    const attempt = Number(runState.supplier1688Resume?.attempt || 0) + 1;
    const startedAt = new Date().toISOString();
    const pending = Promise.resolve().then(async () => {
      assertCurrent1688Request(controller, resumeRunId);
      runState.supplier1688Resume = {
        attempt,
        status: "running",
        total: pendingProducts.length,
        processed: 0,
        remaining: pendingProducts.length,
        startedAt,
        completedAt: null,
      };
      runState.supplier1688Pipeline = {
        ...runState.supplier1688Pipeline,
        status: "running",
        processed: Math.max(0, Number(runState.supplier1688Pipeline?.matchableCount || pendingProducts.length) - pendingProducts.length),
        remaining: pendingProducts.length,
        updatedAt: startedAt,
        completedAt: null,
        lastReason: "running",
      };
      updateStartAvailability();
      setText("supplier1688StatusText", `已重连 · 正在补做 0/${pendingProducts.length}`);
      showView("results");
      renderResults();
      try {
        await persistCurrentRunRequired(controller.signal);
        assertCurrent1688Request(controller, resumeRunId);
        const batchAudit = await batchRunner(
          pendingProducts,
          controller.signal,
          (done, total) => {
            if (runState.id !== resumeRunId || supplier1688ResumeController !== controller || controller.signal.aborted) return;
            const remaining = getPending1688ResumeProducts().length;
            runState.supplier1688Resume = {
              ...runState.supplier1688Resume,
              processed: done,
              remaining,
            };
            runState.supplier1688Pipeline = {
              ...runState.supplier1688Pipeline,
              status: "running",
              processed: Math.max(0, Number(runState.supplier1688Pipeline?.matchableCount || total) - remaining),
              remaining,
              updatedAt: new Date().toISOString(),
              lastReason: "running",
            };
            setText("supplier1688StatusText", `已重连 · 正在补做 ${done}/${total}`);
            renderResults();
            const activeProduct = products.find((product) => product.id === activeProductId);
            if (activeProduct && !byId("drawerBackdrop")?.hidden) populateDrawer(activeProduct);
          },
          () => supplier1688ResumeController === controller && !controller.signal.aborted && runState.id === resumeRunId
            ? persistCurrentRunRequired(controller.signal)
            : Promise.resolve(false),
        );
        assertCurrent1688Request(controller, resumeRunId);
        if (runState.id !== resumeRunId) throw new DOMException("任务已被替换。", "AbortError");
        const remaining = getPending1688ResumeProducts().length;
        const completedAt = new Date().toISOString();
        const settled = pendingProducts.length - remaining;
        runState.supplier1688Resume = {
          ...runState.supplier1688Resume,
          status: remaining ? "interrupted" : "complete",
          processed: settled,
          remaining,
          completedAt,
          batchAudit,
        };
        runState.supplier1688Pipeline = {
          ...runState.supplier1688Pipeline,
          status: remaining ? "paused" : "complete",
          processed: Math.max(0, Number(runState.supplier1688Pipeline?.matchableCount || pendingProducts.length) - remaining),
          remaining,
          updatedAt: completedAt,
          completedAt: remaining ? null : completedAt,
          lastReason: remaining ? batchAudit.reason || "interrupted" : "complete",
        };
        runState.supplier1688Audit = summarizeCurrent1688Audit(batchAudit.reason);
        const matchedCount = products.filter((product) => ["complete", "fallback_estimate"].includes(product.supplierSearchStatus)).length;
        if (matchedCount) {
          runState.mode = "mixed";
          runState.dataSource = `${analysisSourceLabel(runState)} + 1688 图片找厂`;
          setDataMode("mixed", "混合估算");
        }
        renderResults();
        updateHistorySummary();
        await persistCurrentRun({ notify: true });
        assertCurrent1688Request(controller, resumeRunId);
        if (runState.id !== resumeRunId) throw new DOMException("任务已被替换。", "AbortError");
        if (remaining) {
          schedule1688StatusPolling();
          showToast(`已补做 ${settled}/${pendingProducts.length} 个候选，剩余结果和断点已保留。请按状态提示处理验证或等待冷却，再点击匹配继续。`, "info", 8000);
        } else {
          stop1688StatusPolling();
          const profitCount = pendingProducts.filter((product) => Number.isFinite(product.margin) || Number.isFinite(product.roughMargin)).length;
          showToast(`1688 补做完成：${pendingProducts.length} 个候选已处理，${profitCount} 个已得出利润率。`, "success", 6200);
        }
        return !remaining;
      } catch (error) {
        if (runState.id !== resumeRunId || supplier1688ResumeController !== controller) return false;
        if (controller.signal.aborted) {
          const remaining = getPending1688ResumeProducts().length;
          runState.supplier1688Resume = {
            ...runState.supplier1688Resume,
            status: "paused",
            processed: Math.max(0, pendingProducts.length - remaining),
            remaining,
            completedAt: new Date().toISOString(),
            error: "已暂停，完成专用 Edge 验证后可继续补做。",
          };
          runState.supplier1688Pipeline = {
            ...runState.supplier1688Pipeline,
            status: "paused",
            processed: Math.max(0, Number(runState.supplier1688Pipeline?.matchableCount || pendingProducts.length) - remaining),
            remaining,
            updatedAt: new Date().toISOString(),
            lastReason: "paused_for_verification",
          };
          runState.supplier1688Audit = summarizeCurrent1688Audit("paused_for_verification");
          await persistCurrentRun({ notify: true });
        } else {
          runState.supplier1688Resume = {
            ...runState.supplier1688Resume,
            status: "failed",
            remaining: getPending1688ResumeProducts().length,
            completedAt: new Date().toISOString(),
            error: error.message || "1688 补做失败",
          };
          runState.supplier1688Pipeline = {
            ...runState.supplier1688Pipeline,
            status: "failed",
            remaining: getPending1688ResumeProducts().length,
            updatedAt: new Date().toISOString(),
            lastReason: error.code || "failed",
          };
          await persistCurrentRun({ notify: true });
          showToast(`1688 自动补做未完成：${error.message}`, "error", 6200);
        }
        return false;
      } finally {
        if (runState.id === resumeRunId && supplier1688ResumeController === controller) {
          if (supplier1688LoggedIn) {
            const remaining = getPending1688ResumeProducts().length;
            setText("supplier1688StatusText", remaining ? `已在线验证 · ${remaining} 个候选待补做` : "已在线验证 · 当前任务已补齐");
          }
          updateStartAvailability();
          renderResults();
        }
      }
    });
    supplier1688ResumePromise = pending;
    try {
      return await pending;
    } finally {
      if (supplier1688ResumePromise === pending) supplier1688ResumePromise = null;
      if (supplier1688ResumeController === controller) supplier1688ResumeController = null;
      if (!supplier1688SelectionPending && runState.id === resumeRunId) await releaseAmazonCollectionAfterSupplier();
      updateStartAvailability();
    }
  }

  function scheduleRequested1688Resume() {
    if (supplier1688Queue?.ratePolicy?.pausedReason || supplier1688RiskTask?.id) return false;
    if (!supplier1688ResumeRequested || !supplier1688LoggedIn || hasActive1688Work()) return false;
    if (!getPending1688ResumeProducts().length) {
      supplier1688ResumeRequested = false;
      return false;
    }
    supplier1688ResumeRequested = false;
    window.setTimeout(() => void resumePending1688Candidates(), 0);
    return true;
  }

  // Compatibility polling for legacy tasks is read-only, including when the queue is idle.
  let supplier1688StatusTimer = null;

  function stop1688StatusPolling() {
    if (!supplier1688StatusTimer) return;
    window.clearInterval(supplier1688StatusTimer);
    supplier1688StatusTimer = null;
  }

  async function poll1688Status() {
    if (runState.supplier1688Pipeline?.owner === 'server') {
      stop1688StatusPolling();
      await loadSupplierPipelineStatus().catch(() => {});
      return;
    }
    if (!supplier1688LoggedIn || hasActive1688Work() || supplier1688ResumePromise) return;
    const remaining = getPending1688ResumeProducts().length;
    if (!remaining) {
      stop1688StatusPolling();
      return;
    }
    let queue = null;
    try {
      const data = await apiRequest("/api/v1/runtime", { timeout: 15_000 });
      queue = data?.queue ?? null;
      apply1688SessionStatus(data?.auth, data?.queue, data?.imageSearchRecovery ?? null);
    } catch {
      return; // 服务暂时不可达，下轮再试
    }
    if (!supplier1688LoggedIn || !queue || queue.waitingLogin) return;
    const ratePolicy = queue.ratePolicy;
    if (Number(queue.riskBlocked || 0) > 0 || ratePolicy?.pausedReason) {
      setText("supplier1688StatusText", technical1688Pause(ratePolicy?.pausedReason)
        ? `搜图进程中断 · 检查服务后点击「检查后继续」 · 待补 ${remaining} 个`
        : ratePolicy?.pausedReason === "RATE_LIMITED"
        ? `搜图限流冷却中 · 待补 ${remaining} 个`
        : ratePolicy?.manualVerificationCompletedAt
        ? `图片验证已完成 · 请点击「验证完成，继续搜图」 · 待补 ${remaining} 个`
        : `账号已登录 · 搜图已暂停，等待人工验证 · 待补 ${remaining} 个`);
      return;
    }
    const nextAllowedAt = Date.parse(ratePolicy?.nextAllowedAt || "");
    if (Number.isFinite(nextAllowedAt) && nextAllowedAt > Date.now()) return;
    if (Number(queue.queued || 0) + Number(queue.running || 0) > 0) return;
    stop1688StatusPolling();
    setText("supplier1688StatusText", `已在线 · ${remaining} 个待处理，请点击匹配继续`);
    // Recovery remains an explicit user action for legacy browser-owned tasks.
  }

  function schedule1688StatusPolling() {
    if (supplier1688StatusTimer) return;
    supplier1688StatusTimer = window.setInterval(() => void poll1688Status(), 60_000);
  }

  async function run1688ImageSearchBatch(items, signal, onProgress = () => {}, onCheckpoint = async () => {}) {
    const audit = { attempted: 0, complete: 0, fallback: 0, insufficient: 0, failed: 0, skipped: 0, reason: null };
    for (let index = 0; index < items.length; index += 1) {
      const product = items[index];
      if (signal?.aborted) throw signal.reason || new DOMException("任务已取消。", "AbortError");
      if (isAnalysisReadOnly(product)) { audit.skipped += 1; onProgress(index + 1, items.length); await onCheckpoint(product, index + 1, items.length); continue; }
      if (isManualCostProduct(product)) {
        audit.skipped += 1;
        product.supplierSearchStatus = "manual_cost";
        product.supplierSearchError = "已使用人工采购成本，后台 1688 不会覆盖。";
        product.supplierSearchErrorCode = null;
        rebuildProductMissing(product);
        updateProductComputed(product);
        onProgress(index + 1, items.length);
        await onCheckpoint(product, index + 1, items.length);
        continue;
      }
      if (!product.imageUrl) {
        audit.skipped += 1;
        product.supplierSearchStatus = "missing_inputs";
        product.supplierSearchError = "商品主图缺失，无法发起 1688 图片搜索。";
        product.supplierSearchErrorCode = "MISSING_INPUTS";
        if (!isManualCostProduct(product)) product.purchaseCost = null;
        updateProductComputed(product);
        onProgress(index + 1, items.length);
        await onCheckpoint(product, index + 1, items.length);
        continue;
      }
      audit.attempted += 1;
      product.supplierSearchStatus = "searching";
      product.supplierSearchError = null;
      product.supplierSearchErrorCode = null;
      try {
        const data = await request1688ImageSearch(product, signal);
        if (signal?.aborted) throw signal.reason || new DOMException("任务已取消。", "AbortError");
        apply1688SearchResult(product, data);
        if (product.supplierSearchStatus === "complete") audit.complete += 1;
        else if (product.supplierSearchStatus === "fallback_estimate") audit.fallback += 1;
        else if (product.supplierSearchStatus === "queue_waiting") audit.skipped += 1;
        else audit.insufficient += 1;
      } catch (error) {
        if (signal?.aborted) throw error;
        audit.failed += 1;
        const queueWaiting = is1688QueueWaitError(error);
        const sessionExpired = !queueWaiting && is1688SessionError(error);
        const interrupted = queueWaiting || sessionExpired;
        const taskId = validProcurementTaskId(error?.details?.taskId);
        if (taskId) product.supplierProcurementTaskId = taskId;
        product.supplierSearchStatus = queueWaiting ? "queue_waiting" : sessionExpired ? "session_expired" : "failed";
        product.supplierSearchError = error.message || "1688 商品匹配失败";
        product.supplierSearchErrorCode = error.code || "1688_IMAGE_SEARCH_FAILED";
        updateProductComputed(product);
        if (!Array.isArray(runState.errors)) runState.errors = [];
        runState.errors.push({
          stage: "1688_image_search",
          code: error.code || "1688_IMAGE_SEARCH_FAILED",
          message: product.supplierSearchError,
          asin: product.asin,
          productId: product.id,
          taskId: taskId || null,
          recovered: false,
          createdAt: new Date().toISOString(),
        });
        if (interrupted) {
          apply1688SessionError(error);
          const remaining = items.length - index - 1;
          audit.skipped += remaining;
          audit.reason = queueWaiting ? "queue_waiting" : "session_expired";
          items.slice(index + 1).forEach((pendingProduct) => {
            if (isAnalysisReadOnly(pendingProduct)) return;
            pendingProduct.supplierSearchStatus = queueWaiting ? "queue_waiting" : "session_expired";
            pendingProduct.supplierSearchError = queueWaiting
              ? "1688 图片任务仍在队列中；已保留进度，稍后在线验证后会从当前候选继续。"
              : "1688 已断开；重新连接并在线验证后将自动继续，当前 Amazon 商品数据已保留。";
            pendingProduct.supplierSearchErrorCode = product.supplierSearchErrorCode;
            updateProductComputed(pendingProduct);
          });
          onProgress(index + 1, items.length);
          await onCheckpoint(product, index + 1, items.length);
          break;
        }
      }
      onProgress(index + 1, items.length);
      await onCheckpoint(product, index + 1, items.length);
    }
    return audit;
  }

  async function request1688ImageSearch(product, signal) {
    if (runState.archivedAt) throw createRunError("RUN_ARCHIVED", "归档任务的采集已停止，可手工编辑、初审和导出。");
    if (isAnalysisReadOnly(product)) throw createRunError("ANALYSIS_ALREADY_HANDED_OFF", "初筛资料已交接，后续厂家匹配请在采购端进行。");
    const request = () => apiRequest("/api/1688/image-search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        runId: runState.id,
        productId: product.id,
        asin: product.asin || product.sourceAsin,
        imageUrl: product.imageUrl,
        existingTaskId: validProcurementTaskId(product.supplierProcurementTaskId),
        targetCostCny: calculateTargetCostCny(product),
        moq: Number.isFinite(product.moq) && product.moq > 0 ? product.moq : 100,
        pieceCount: ensureProductPieceCount(product),
        currentPrice: product.currentPrice,
        salePrice: calculateOurSalePrice(product),
        currency: product.currency || activeMarket.currency,
        marketplace: product.marketplace || activeMarket.code,
      }),
      signal,
      timeout: 10 * 60_000,
    });
    try {
      return await request();
    } catch (error) {
      if (!new Set(["PROCUREMENT_CONSOLE_UNAVAILABLE", "PROCUREMENT_CONSOLE_START_FAILED"]).has(String(error?.code || "").toUpperCase())) throw error;
      const taskId = validProcurementTaskId(error?.details?.taskId);
      if (taskId) product.supplierProcurementTaskId = taskId;
      await ensure1688ServiceAvailable();
      // A POST without a saved task id may already have created work upstream.
      // Only replay when the same task can be resumed without duplication.
      if (taskId || validProcurementTaskId(product.supplierProcurementTaskId)) return request();
      throw error;
    }
  }

  function apply1688SearchResult(product, data = {}) {
    if (runState.archivedAt || isAnalysisReadOnly(product) || isManualCostProduct(product)) return;
    const procurementTaskId = validProcurementTaskId(data.procurementTaskId || data.audit?.procurementTaskId);
    if (procurementTaskId) product.supplierProcurementTaskId = procurementTaskId;
    const rawQuotes = Array.isArray(data.quotes) ? data.quotes : Array.isArray(data.items) ? data.items : [];
    const rawRejected = Array.isArray(data.rejectedQuotes)
      ? data.rejectedQuotes
      : Array.isArray(data.audit?.rejected)
        ? data.audit.rejected.filter((quote) => String(quote?.excludedReason || "").includes("similarity_"))
        : [];
    const normalized = [...rawQuotes, ...rawRejected]
      .map((quote, index) => normalize1688Quote(quote, index))
      .filter(Boolean)
      .sort(compare1688SupplierFallbackSimilarity);
    const similarityQualified = normalized.filter(isSupplierMatchQualified);
    const strictUnique = new Map();
    similarityQualified.forEach((quote) => {
        const key = quote.supplierId || quote.name.toLocaleLowerCase("zh-CN");
        if (!strictUnique.has(key)) strictUnique.set(key, quote);
      });
    const fallbackUnique = new Map();
    normalized
      .filter(isSupplierFallbackEligible)
      .sort(compare1688SupplierFallbackSimilarity)
      .forEach((quote) => {
        const key = quote.supplierId || quote.name.toLocaleLowerCase("zh-CN");
        if (!fallbackUnique.has(key)) fallbackUnique.set(key, quote);
      });
    const similarityPolicy = data.similarity || data.audit?.similarity || {};
    const similarityThreshold = finiteOrNull(similarityPolicy.threshold);
    const policyVerified = data.ruleVersion === SUPPLIER_RULE_VERSION
      && similarityThreshold === MIN_IMAGE_SIMILARITY_SCORE
      && similarityPolicy.operator === IMAGE_SIMILARITY_OPERATOR;
    const strictEnough = policyVerified
      && data.status === "complete"
      && data.selectionMode === SUPPLIER_COST_MODE_VERIFIED
      && data.costConfidence === "high"
      && strictUnique.size >= REQUIRED_1688_QUOTES;
    const fallbackEnough = policyVerified
      && data.status === "fallback_estimate"
      && data.selectionMode === SUPPLIER_COST_MODE_FALLBACK
      && data.costConfidence === "low"
      && fallbackUnique.size >= INCLUDED_1688_QUOTES;
    const selected = strictEnough
      ? [...strictUnique.values()].sort(compare1688SupplierSimilarity).slice(0, REQUIRED_1688_QUOTES)
      : fallbackEnough
        ? [...fallbackUnique.values()].sort(compare1688SupplierFallbackSimilarity).slice(0, INCLUDED_1688_QUOTES)
        : [...fallbackUnique.values()].sort(compare1688SupplierFallbackSimilarity).slice(0, REQUIRED_1688_QUOTES);
    const priceSorted = [...selected].sort((left, right) => left.unitPriceCny - right.unitPriceCny
      || compare1688SupplierSimilarity(left, right));
    priceSorted.forEach((quote, index) => {
      quote.priceRank = index + 1;
      quote.included = fallbackEnough || (strictEnough && index >= 2 && index < REQUIRED_1688_QUOTES - 2);
      quote.costSelectionDecision = quote.included
        ? fallbackEnough ? "included_low_confidence" : "included_verified"
        : "not_selected";
      quote.excludedReason = quote.included
        ? fallbackEnough ? "included_top_six_fallback" : "included_middle_six"
        : strictEnough ? index < 2 ? "excluded_low_outlier" : "excluded_high_outlier" : "insufficient_fallback_quotes";
      quote.price = quote.unitPriceCny;
    });
    const selectedKeys = new Set(selected.map((quote) => `${quote.supplierId}\u0000${quote.offerId}`));
    const similarityRejected = normalized
      .filter((quote) => !isSupplierMatchQualified(quote))
      .map((quote) => ({
        ...quote,
        included: false,
        excludedReason: supplierMatchFailureReason(quote),
      }));
    const outsideTopTen = normalized
      .filter((quote) => isSupplierMatchQualified(quote) && !selectedKeys.has(`${quote.supplierId}\u0000${quote.offerId}`))
      .map((quote) => ({ ...quote, included: false, excludedReason: "outside_top_10" }));
    const selectionComparator = fallbackEnough ? compare1688SupplierFallbackSimilarity : compare1688SupplierSimilarity;
    const selectedBySimilarity = [...selected].sort(selectionComparator);
    const visibleCandidates = strictEnough || fallbackEnough
      ? selectedBySimilarity
      : [...selectedBySimilarity, ...similarityRejected, ...outsideTopTen];
    const visible = visibleCandidates
      .filter((quote, index, values) => {
        const key = quote.supplierId || quote.name.toLocaleLowerCase("zh-CN");
        return values.findIndex((candidate) => (candidate.supplierId || candidate.name.toLocaleLowerCase("zh-CN")) === key) === index;
      })
      .sort(selectionComparator)
      .slice(0, REQUIRED_1688_QUOTES)
      .map((quote, index) => ({ ...quote, similarityRank: index + 1, rank: index + 1 }));
    const included = selected.filter((quote) => quote.included);
    const averageCostCny = (strictEnough || fallbackEnough) && included.length === INCLUDED_1688_QUOTES
      ? roundMoney(included.reduce((sum, quote) => sum + quote.unitPriceCny, 0) / INCLUDED_1688_QUOTES)
      : null;
    const pieceCount = ensureProductPieceCount(product);
    const totalAverageCostCny = totalPurchaseCostCny(averageCostCny, pieceCount);
    const targetCostCny = calculateTargetCostCny(product);
    const thresholdCostCny = Number.isFinite(targetCostCny) ? roundMoney(targetCostCny * SUPPLIER_PROFIT_THRESHOLD) : null;
    const profitable = Number.isFinite(totalAverageCostCny) && Number.isFinite(thresholdCostCny)
      ? totalAverageCostCny <= thresholdCostCny
      : null;
    const roughMargin = Number.isFinite(totalAverageCostCny) && Number.isFinite(targetCostCny) && targetCostCny > 0
      ? ((targetCostCny - totalAverageCostCny) / targetCostCny) * 100
      : null;

    const evaluatedCount = normalized.filter((quote) => Number.isFinite(quote.imageSimilarityScore)).length;
    const uniqueCountBy = (quotes) => new Set(quotes.map((quote) => quote.supplierId || quote.name.toLocaleLowerCase("zh-CN"))).size;
    const imageQualifiedCount = uniqueCountBy(normalized.filter((quote) => quote.imageSimilarityDecision === "passed"));
    const qualifiedCount = strictUnique.size;
    product.suppliers = visible;
    product.targetCostCny = targetCostCny;
    product.thresholdCostCny = thresholdCostCny;
    product.supplierAverageCny = averageCostCny;
    product.supplierProfitable = profitable;
    product.roughMargin = roughMargin;
    product.supplierSearchStatus = strictEnough
      ? "complete"
      : fallbackEnough
        ? "fallback_estimate"
        : policyVerified || ["similarity_insufficient", "insufficient"].includes(data.status) ? data.status : "similarity_unverified";
    product.supplierCostMode = strictEnough
      ? SUPPLIER_COST_MODE_VERIFIED
      : fallbackEnough ? SUPPLIER_COST_MODE_FALLBACK : null;
    product.supplierCostConfidence = strictEnough ? "high" : fallbackEnough ? "low" : null;
    product.supplierSearchError = strictEnough
      ? null
      : fallbackEnough
        ? "未组成 10 家图片达标样本；已按图片相似度由高到低选取 6 家真实报价并计算低置信度利润率。"
      : product.supplierSearchStatus === "similarity_unverified"
        ? "返回结果未通过当前图片选取规则复核，请重新匹配。"
        : `图片搜索目前只有 ${fallbackUnique.size} 家真实有效唯一报价，未达到计算所需的 6 家；其中图片达标 ${imageQualifiedCount} 家、标准达标 ${qualifiedCount} 家。`;
    product.supplierSearchErrorCode = null;
    product.supplierSearchedAt = data.searchedAt || new Date().toISOString();
    product.supplierRuleVersion = data.ruleVersion || null;
    product.supplierSearchAudit = data.audit && typeof data.audit === "object" ? data.audit : null;
    product.supplierSimilarity = {
      threshold: MIN_IMAGE_SIMILARITY_SCORE,
      operator: IMAGE_SIMILARITY_OPERATOR,
      evaluatedCount,
      imageQualifiedCount,
      qualifiedCount,
      fallbackCandidateCount: fallbackUnique.size,
      fallbackSelectedCount: fallbackEnough ? INCLUDED_1688_QUOTES : 0,
      method: selected[0]?.similarityMethod || normalized.find((quote) => quote.similarityMethod)?.similarityMethod || null,
      version: selected[0]?.similarityVersion || normalized.find((quote) => quote.similarityVersion)?.similarityVersion || null,
    };
    product.supplierSource = strictEnough
      ? "1688-image-search-verified"
      : fallbackEnough
        ? "1688-image-search-low-confidence"
      : `1688-${product.supplierSearchStatus}`;
    if (!isManualCostProduct(product)) {
      product.purchaseUnitCostCny = averageCostCny;
      product.purchaseCost = totalAverageCostCny;
    }
    if (["complete", "fallback_estimate"].includes(product.supplierSearchStatus)) mark1688ErrorsRecovered(product);
    rebuildProductMissing(product);
    updateProductComputed(product);
  }

  function validProcurementTaskId(value) {
    const taskId = String(value || "");
    // 兼容原版 task_ 前缀与本地桥接服务的 UUID 格式。
    const isLegacyFormat = /^task_[A-Za-z0-9][A-Za-z0-9_-]{0,122}$/.test(taskId);
    const isUuidFormat = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(taskId);
    return isLegacyFormat || isUuidFormat ? taskId : null;
  }

  function mark1688ErrorsRecovered(product) {
    if (!Array.isArray(runState.errors)) return;
    const recoveredAt = new Date().toISOString();
    runState.errors.forEach((error) => {
      if (error?.stage !== "1688_image_search" || error.recovered === true) return;
      if (error.productId === product.id || (product.asin && error.asin === product.asin)) {
        error.recovered = true;
        error.recoveredAt = recoveredAt;
      }
    });
  }

  function normalize1688Quote(quote, index) {
    if (!quote || typeof quote !== "object") return null;
    const unitPriceCny = finiteOrNull(quote.unitPriceCny ?? quote.priceCny ?? quote.price);
    if (unitPriceCny === null || unitPriceCny <= 0) return null;
    const supplierId = String(quote.supplierId || quote.companyId || "").trim();
    const name = String(quote.name || quote.supplierName || "").trim();
    if (!supplierId && !name) return null;
    const imageSimilarityScore = validMatchScore(quote.imageSimilarityScore ?? quote.similarityScore);
    const candidateImageUrl = safe1688CandidateImageUrl(quote.candidateImageUrl || quote.imageUrl);
    const similarityMethod = String(quote.similarityMethod || "").trim();
    const similarityVersion = String(quote.similarityVersion || quote.similarityModelVersion || "").trim();
    const imageEvidenceAvailable = imageSimilarityScore !== null && candidateImageUrl && similarityMethod && similarityVersion;
    const imageSimilarityDecision = !imageEvidenceAvailable
      ? "unavailable"
      : imageSimilarityScore > MIN_IMAGE_SIMILARITY_SCORE ? "passed" : "below_threshold";
    const supplierMatchDecision = imageSimilarityDecision;
    return {
      rank: Math.max(1, Math.trunc(Number(quote.rank) || index + 1)),
      searchRank: Math.max(1, Math.trunc(Number(quote.searchRank || quote.sourceRank) || Number(quote.rank) || index + 1)),
      similarityRank: finiteOrNull(quote.similarityRank),
      priceRank: finiteOrNull(quote.priceRank),
      supplierId,
      name: name || `1688 供应商 ${index + 1}`,
      offerId: String(quote.offerId || "").trim(),
      url: safeHttpUrl(quote.url),
      candidateImageUrl,
      unitPriceCny: roundMoney(unitPriceCny),
      unit: String(quote.unit || "件").trim(),
      moq: finiteOrNull(quote.moq),
      priceTier: String(quote.priceTier || "").trim(),
      spec: String(quote.spec || "").trim(),
      candidateTitle: String(quote.candidateTitle || quote.spec || "").trim(),
      factoryVerified: Boolean(quote.factoryVerified),
      included: Boolean(quote.included),
      excludedReason: String(quote.excludedReason || "").trim(),
      imageSimilarityScore,
      imageSimilarityDecision,
      similarityMethod,
      similarityVersion,
      supplierMatchDecision,
      costSelectionDecision: String(quote.costSelectionDecision || "").trim(),
      sourceImageSha256: String(quote.sourceImageSha256 || "").trim(),
      candidateImageSha256: String(quote.candidateImageSha256 || "").trim(),
      comparedAt: String(quote.comparedAt || "").trim(),
      imageSimilarityComponents: quote.imageSimilarityComponents && typeof quote.imageSimilarityComponents === "object"
        ? quote.imageSimilarityComponents
        : null,
      imageSimilarityErrorCode: String(quote.imageSimilarityErrorCode || "").trim(),
      searchSource: "image",
      searchSources: ["image"],
      sourceRanks: { image: Math.max(1, Math.trunc(Number(quote.sourceRanks?.image) || Number(quote.sourceRank) || Number(quote.rank) || index + 1)) },
    };
  }

  function validMatchScore(value) {
    const score = finiteOrNull(value);
    return score !== null && score >= 0 && score <= 1 ? score : null;
  }

  function supplierEvidenceMatchesCurrentPolicy(supplier) {
    const normalized = normalize1688Quote(supplier, 0);
    if (!normalized) return false;
    // The server policy calls a scored below-threshold match "failed";
    // the display normalizer uses "below_threshold" for the same evidence.
    // Both are eligible only for the existing low-confidence fallback policy.
    const savedMatchDecision = supplier.imageSimilarityDecision === 'below_threshold'
      && supplier.supplierMatchDecision === 'failed' ? 'below_threshold' : supplier.supplierMatchDecision;
    return normalized.imageSimilarityDecision === supplier.imageSimilarityDecision
      && normalized.supplierMatchDecision === savedMatchDecision;
  }

  function isSupplierMatchQualified(supplier) {
    return supplier?.imageSimilarityDecision === "passed"
      && supplier?.supplierMatchDecision === "passed";
  }

  function supplierMatchFailureReason(supplier) {
    if (supplier?.imageSimilarityDecision === "below_threshold") return "image_similarity_below_threshold";
    if (supplier?.imageSimilarityDecision !== "passed") return "image_similarity_unavailable";
    return "image_match_unavailable";
  }

  function compare1688SupplierSimilarity(left, right) {
    const leftScore = finiteOrNull(left?.imageSimilarityScore) ?? -1;
    const rightScore = finiteOrNull(right?.imageSimilarityScore) ?? -1;
    if (leftScore !== rightScore) return rightScore - leftScore;
    return Number(left?.searchRank || left?.rank || Number.MAX_SAFE_INTEGER)
      - Number(right?.searchRank || right?.rank || Number.MAX_SAFE_INTEGER);
  }

  function compare1688SupplierFallbackSimilarity(left, right) {
    return compare1688SupplierSimilarity(left, right);
  }

  function isSupplierFallbackEligible(supplier) {
    return Number.isFinite(supplier?.unitPriceCny)
      && supplier.unitPriceCny > 0
      && validMatchScore(supplier.imageSimilarityScore) !== null
      && ["passed", "below_threshold"].includes(supplier.imageSimilarityDecision)
      && Boolean(supplier.candidateImageUrl)
      && Boolean(supplier.similarityMethod)
      && Boolean(supplier.similarityVersion)
      && Boolean(supplier?.supplierId)
      && Boolean(supplier?.name)
      && Boolean(supplier?.offerId)
      && Boolean(supplier?.url)
      && Number.isFinite(supplier?.moq)
      && supplier.moq > 0
      && Boolean(supplier?.unit);
  }

  function is1688SessionError(error) {
    return new Set([
      "1688_LOGIN_REQUIRED",
      "1688_SESSION_EXPIRED",
      "SESSION_EXPIRED",
      "LOGIN_REQUIRED",
      "NOT_LOGGED_IN",
      "AUTH_REQUIRED",
      "LOGIN_EXPIRED",
      "WINDOW_NOT_FOUND",
      "HUMAN_VERIFICATION_REQUIRED",
      "RISK_CONTROL",
      "RISK_VERIFICATION_REQUIRED",
      "RATE_LIMITED",
      "AUTH_CHECKING",
      "VERIFICATION_FAILED",
      "PROCUREMENT_CONSOLE_UNAVAILABLE",
      "PROCUREMENT_CONSOLE_START_FAILED",
      "PROCUREMENT_CONSOLE_IDENTITY_MISMATCH",
      "PROCUREMENT_SEARCH_TIMEOUT",
      "REQUEST_TIMEOUT",
    ])
      .has(String(error?.code || "").toUpperCase());
  }

  function is1688QueueWaitError(error) {
    return ["PROCUREMENT_SEARCH_TIMEOUT", "REQUEST_TIMEOUT"]
      .includes(String(error?.code || "").toUpperCase());
  }

  function apply1688SessionError(error) {
    const code = String(error?.code || "").toUpperCase();
    if (is1688QueueWaitError(error)) {
      apply1688SessionStatus({
        ready: supplier1688LoggedIn,
        checking: false,
        reason: supplier1688LoggedIn ? "ready" : "login_required",
        message: "1688 图片任务仍在队列中，进度和任务编号已保留",
      });
    } else if (["HUMAN_VERIFICATION_REQUIRED", "RISK_CONTROL", "RISK_VERIFICATION_REQUIRED"].includes(code)) {
      apply1688SessionStatus({ ...supplier1688Auth, ready: supplier1688LoggedIn, checking: false, reason: "risk_control", message: "搜图已暂停，请在专用 Edge 中完成人工验证" });
      void load1688SessionStatus();
    } else if (code === "RATE_LIMITED") {
      apply1688SessionStatus({ ...supplier1688Auth, ready: supplier1688LoggedIn, checking: false, reason: "rate_limited", message: "1688 搜图正在限流冷却，已保留进度" });
      void load1688SessionStatus();
    } else if (["PROCUREMENT_CONSOLE_UNAVAILABLE", "PROCUREMENT_CONSOLE_IDENTITY_MISMATCH"].includes(code)) {
      apply1688SessionStatus({ ready: false, checking: false, reason: "service_unavailable", message: "1688 采购助手不可用，请重新打开找品 Agent" });
    } else if (code === "REQUEST_TIMEOUT") {
      apply1688SessionStatus({ ready: false, checking: false, reason: "verification_failed", message: "1688 请求超时；点击在线验证后继续待补商品" });
    } else if (code === "AUTH_CHECKING") {
      apply1688SessionStatus({ ready: false, checking: true, reason: "checking", message: "1688 正在在线验证，请稍后重试" });
    } else {
      apply1688SessionStatus({ ready: false, checking: false, reason: "login_required", message: "1688 登录已失效，请使用专用 Edge 重新登录" });
    }
  }

  function safeHttpUrl(value) {
    try {
      const url = new URL(String(value || ""));
      const hostname = url.hostname.toLowerCase();
      return url.protocol === "https:" && (hostname === "1688.com" || hostname.endsWith(".1688.com")) ? url.href : "";
    } catch (_) {
      return "";
    }
  }

  function safe1688CandidateImageUrl(value) {
    try {
      const url = new URL(String(value || ""));
      const hostname = url.hostname.toLowerCase();
      const allowed = ["alicdn.com", "1688.com"]
        .some((suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`));
      return url.protocol === "https:" && !url.username && !url.password && !url.port && allowed ? url.href : "";
    } catch (_) {
      return "";
    }
  }

  function safeAmazonImageUrl(value) {
    try {
      const url = new URL(String(value || ""));
      const allowed = new Set([
        "m.media-amazon.com",
        "images-na.ssl-images-amazon.com",
        "images-eu.ssl-images-amazon.com",
        "images-fe.ssl-images-amazon.com",
        "images-cn.ssl-images-amazon.com",
      ]);
      return url.protocol === "https:" && !url.username && !url.password && !url.port && allowed.has(url.hostname.toLowerCase()) ? url.href : "";
    } catch (_) {
      return "";
    }
  }

  function hydrateFallbackProducts() {
    return FALLBACK_PRODUCT_SEED.map((item) => {
      const isUs = activeMarket.code === "US";
      const currentPrice = isUs ? roundMoney(item.price30 * 0.66) : item.price30;
      const product = {
        ...item,
        id: `${activeMarket.code}:${item.asin}`,
        marketplace: activeMarket.code,
        marketplaceId: activeMarket.marketplaceId,
        currency: activeMarket.currency,
        amazonDomain: activeMarket.amazonDomain,
        sellerId: isUs ? `${item.sellerId.replace(/AU/g, "")}US` : item.sellerId,
        storeName: isUs ? item.storeName.replace(/ AU\b/g, " US") : item.storeName,
        price30: null,
        currentPrice,
        firstFba: item.id === "au-008" ? null : item.firstFba,
        fbaFee: null,
        fbmFee: null,
        fulfillmentMode: "FBA",
        fulfillmentModeSource: "demo",
        billingWeight: item.fbaWeight ?? item.productWeight ?? null,
        weightSource: item.fbaWeight ? "FBA 包装重量" : item.productWeight ? "商品重量回退" : "参数缺失",
        missing: [...item.missing],
        amazonMissing: [...item.missing],
        reviewStatus: "pending",
        manualSalePrice: false,
        manualFbaFee: false,
        manualFbmFee: false,
        manualPurchaseCost: false,
        rematchCount: 0,
        collectedAt: new Date().toISOString(),
        dataSource: "mock-demo",
        dataMode: "mock",
        supplierSource: "1688-demo",
        supplierSearchStatus: "complete",
        supplierSearchError: null,
        supplierCostMode: SUPPLIER_COST_MODE_VERIFIED,
        supplierCostConfidence: "high",
        supplierRuleVersion: SUPPLIER_RULE_VERSION,
      };
      ensureProductPieceCount(product);
      product.salePrice = calculateOurSalePrice(product);
      product.targetCostCny = calculateTargetCostCny(product);
      product.thresholdCostCny = roundMoney(product.targetCostCny * SUPPLIER_PROFIT_THRESHOLD);
      applyAutomaticFba(product);
      product.suppliers = buildDemoSuppliers(product);
      const included = product.suppliers.filter((supplier) => supplier.included);
      const qualifiedSuppliers = product.suppliers.filter(isSupplierMatchQualified);
      product.supplierSearchStatus = qualifiedSuppliers.length === REQUIRED_1688_QUOTES ? "complete" : "similarity_insufficient";
      product.supplierSearchError = product.supplierSearchStatus === "complete"
        ? null
        : `只有 ${qualifiedSuppliers.length} 家模拟厂家通过图片 >50%，未达到 10 家，不自动计算。`;
      product.supplierAverageCny = included.length === INCLUDED_1688_QUOTES
        ? roundMoney(included.reduce((sum, supplier) => sum + supplier.unitPriceCny, 0) / INCLUDED_1688_QUOTES)
        : null;
      const totalAverageCostCny = totalPurchaseCostCny(product.supplierAverageCny, product.pieceCount);
      product.supplierProfitable = Number.isFinite(totalAverageCostCny)
        ? totalAverageCostCny <= product.thresholdCostCny
        : null;
      product.roughMargin = Number.isFinite(totalAverageCostCny)
        ? ((product.targetCostCny - totalAverageCostCny) / product.targetCostCny) * 100
        : null;
      if (!isManualCostProduct(product)) {
        product.purchaseUnitCostCny = product.supplierAverageCny;
        product.purchaseCost = totalAverageCostCny;
      }
      product.supplierSimilarity = {
        threshold: MIN_IMAGE_SIMILARITY_SCORE,
        operator: IMAGE_SIMILARITY_OPERATOR,
        evaluatedCount: product.suppliers.length,
        imageQualifiedCount: product.suppliers.length,
        qualifiedCount: qualifiedSuppliers.length,
        method: "mock-demo-visual",
        version: "mock-v1",
      };
      updateProductComputed(product);
      return product;
    });
  }

  async function runDemoAnalysis() {
    if (analysisRunning || hasActive1688Work()) return;
    if (activeMarket.code === "NL") {
      showProgressError("荷兰站不提供模拟商品", "请使用荷兰店铺清单运行真实店铺访问；商品分析将明确标记为 SellerSprite DE 代理，不会伪装成 NL 实时数据。", { action: null, showDemo: false });
      return;
    }
    const criteria = getSetupCriteria();
    const validationError = validateSetupCriteria(criteria);
    if (validationError) {
      showToast(validationError, "error", 4200);
      return;
    }
    beginRun(criteria, "mock");
    currentRunController?.abort();
    const controller = new AbortController();
    currentRunController = controller;
    setDataMode("mock", "模拟数据");
    const titles = ["正在读取演示店铺", "正在生成 Amazon 演示商品", "正在生成 SellerSprite 演示字段", "正在生成 1688 演示报价", `正在计算${activeMarket.nameZh}利润`];
    try {
      for (let index = 0; index < titles.length; index += 1) {
        setStage(index, titles[index], (index + 1) * 20);
        await delay(260);
        assertCurrentTaskRequest(controller);
      }
      products = hydrateFallbackProducts();
      runState.completedAt = new Date().toISOString();
      finishRun(`模拟演示完成 · ${products.length} 个候选`, 100);
      await persistCurrentRun({ notify: true });
      assertCurrentTaskRequest(controller);
      await delay(220);
      assertCurrentTaskRequest(controller);
      showView("results");
      showToast("已明确切换为模拟数据演示；结果不可用于最终决策。", "info", 5200);
    } catch (error) {
      if (!controller.signal.aborted) throw error;
    }
  }

  function setStage(index, title, percent) {
    const stages = $$("#stageList li");
    stages.forEach((stage, stageIndex) => {
      stage.classList.toggle("is-current", stageIndex === index);
      stage.classList.toggle("is-done", stageIndex < index);
      stage.classList.remove("is-error");
    });
    setText("progressTitle", title);
    setProgress(percent);
  }

  function finishRun(title, percent) {
    $$("#stageList li").forEach((stage) => {
      stage.classList.remove("is-current", "is-error");
      stage.classList.add("is-done");
    });
    setText("progressTitle", title);
    setProgress(percent);
    analysisRunning = false;
    const button = byId("startAnalysisButton");
    button.classList.remove("is-loading");
    updateStartAvailability();
    renderResults();
    updateHistorySummary();
    initIcons();
    scheduleRequested1688Resume();
  }

  function countFailedStores(errors) {
    return new Set((errors || [])
      .filter((error) => !["sales_trend", "amazon_store", "1688_image_search"].includes(error.stage) && error.recovered !== true)
      .map((error) => error.sellerId || error.sellerName || `store-${error.storeIndex ?? "unknown"}`)).size;
  }

  function renderRunCoverage() {
    renderAmazonConnectionStatus(runState.storeVisits || []);
    const container = byId("runCoverage");
    if (!container) return;
    const coverage = runState.coverage;
    container.hidden = !coverage || runState.mode === "mock";
    if (container.hidden) return;
    setText("coverageRequestedLabel", isAsinImport() ? "输入 ASIN" : "输入店铺");
    setText("coverageQueriedLabel", isAsinImport() ? "详情成功" : "访问成功");
    setText("coverageFailedLabel", isAsinImport() ? "详情待补" : "访问失败");
    setText("coverageRequested", isAsinImport() ? importedItemCount() : coverage.requested);
    setText("coverageQueried", isAsinImport() ? coverage.detailReturned ?? 0 : coverage.queried);
    setText("coverageUnresolved", coverage.discoveredAsins);
    setText("coverageFailed", isAsinImport() ? coverage.detailFailed ?? 0 : coverage.visitFailed);
    setText("coverageParents", coverage.detailReturned ?? coverage.parentCandidates);
    setText("coverageProducts", coverage.products);
    setText("coverageProvider", analysisSourceLabel(runState));
    container.classList.toggle("has-issues", Boolean(coverage.unresolved || coverage.waitingStores || coverage.visitFailed || coverage.failed));
    renderStoreVisitAudit(isAsinImport() ? [] : amazonStoreVisitsForDisplay(runState.storeVisits || []));
  }

  function amazonStoreVisitsForDisplay(visits) {
    const states = new Map((runState.amazonPipeline?.stores || []).map((entry) => [entry.key, entry]));
    if (!states.size) return visits;
    return visits.map((visit, index) => {
      const state = states.get(amazonStorePipelineKey(visit, Number.isInteger(visit?.storeIndex) ? visit.storeIndex : index));
      if (!state || !["pending", "waiting", "terminal"].includes(state.status)) return visit;
      return {
        ...visit,
        status: state.status === "terminal" ? "failed" : state.status,
        complete: false,
        code: state.lastCode || visit.code || null,
        retryAt: state.retryAt || null,
      };
    });
  }

  function renderStoreVisitAudit(visits) {
    const details = byId("storeVisitAudit");
    const list = byId("storeVisitAuditList");
    if (!details || !list) return;
    details.hidden = !visits.length;
    if (!visits.length) {
      list.innerHTML = "";
      return;
    }
    const statusPriority = { failed: 0, waiting: 1, pending: 2, visited: 3, empty: 4, not_required: 5 };
    const ordered = [...visits].sort((left, right) => (statusPriority[left.status] ?? 9) - (statusPriority[right.status] ?? 9));
    const failed = ordered.filter((visit) => visit.status === "failed").length;
    const waiting = ordered.filter((visit) => ["waiting", "pending"].includes(visit.status)).length;
    setText("storeVisitAuditSummary", `${ordered.length} 店 · ${waiting} 个等待续跑 · ${failed} 个终止失败`);
    list.innerHTML = ordered.map((visit) => {
      const statusLabel = visit.status === "failed"
        ? "访问失败"
        : visit.status === "waiting" ? "等待续跑"
          : visit.status === "pending" ? "待继续"
        : visit.status === "empty" ? "店铺为空" : visit.status === "not_required" ? "使用预填 ASIN" : "访问成功";
      const asinCount = Number(visit.discoveredAsins || 0);
      const pageCount = Number(visit.pagesVisited || 0);
      const regionLabel = amazonDeliveryRegionLabel(visit);
      const note = visit.status === "failed"
        ? visit.message || storeVisitErrorLabel(visit.code)
        : ["waiting", "pending"].includes(visit.status)
          ? amazonStoreResumeNote(visit, pageCount, asinCount)
        : visit.status === "empty"
          ? `${pageCount} 页 · 未发现店铺商品${regionLabel ? ` · ${regionLabel}` : ""}`
          : `${pageCount} 页 · ${asinCount} ASIN${visit.interruption?.code ? ` · ${storeVisitErrorLabel(visit.interruption.code)}` : visit.truncated ? " · 达到扫描上限，可继续" : " · 已完整扫描"}${regionLabel ? ` · ${regionLabel}` : ""}`;
      return `<div class="store-visit-row is-${escapeHtml(visit.status || "unknown")}">
        <strong>${escapeHtml(visit.sellerName || visit.sellerId || `输入行 ${visit.rowNumbers?.join(",") || "--"}`)}</strong>
        <span>${statusLabel}</span>
        <small>${escapeHtml(note)}</small>
      </div>`;
    }).join("");
  }

  function amazonStoreResumeNote(visit, pageCount, asinCount) {
    const code = visit.code || visit.interruption?.code;
    const retryAt = Date.parse(visit.retryAt || "");
    const retryLabel = Number.isFinite(retryAt) && retryAt > Date.now()
      ? ` · 约 ${Math.max(1, Math.ceil((retryAt - Date.now()) / 60_000))} 分钟后续跑`
      : " · 等待续跑";
    const progress = pageCount > 0 || asinCount > 0
      ? `已保存 ${pageCount} 页、${asinCount} 个 ASIN`
      : "首屏尚未完成";
    return `${progress} · ${storeVisitErrorLabel(code)}${retryLabel}`;
  }

  function storeVisitErrorLabel(code) {
    const labels = {
      AMAZON_PAGINATION_LOOP: "Amazon 分页重复，已保存断点；当前仅为部分采集结果",
      AMAZON_DELIVERY_REGION_FAILED: "Amazon 配送区域设置失败",
      AMAZON_DELIVERY_REGION_REJECTED: "Amazon 拒绝了配送区域",
      AMAZON_ACCESS_CHALLENGE: "Amazon 要求访问验证，请稍后重试",
      AMAZON_HTTP_429: "Amazon 访问频率受限，请稍后重试",
      AMAZON_QUEUE_PAUSED: "同站点访问暂缓，本店尚未发起访问",
      AMAZON_DISCOVERY_PENDING: "Amazon 店铺访问尚未完成",
      AMAZON_HTTP_503: "Amazon 暂时不可用（HTTP 503）",
      AMAZON_FETCH_TIMEOUT: "Amazon HTTPS 请求超时",
      AMAZON_FETCH_REQUEST_FAILED: "Amazon HTTPS 连接失败",
      AMAZON_EDGE_REQUEST_FAILED: "Amazon Edge 访问失败",
      AMAZON_INVALID_STORE_PAGE: "Amazon 未返回商品结果页",
      AMAZON_REQUEST_FAILED: "Amazon 网络请求失败",
      INVALID_SELLER_ID: "Seller ID 格式无效",
    };
    return labels[code] || "Amazon 店铺访问未完成";
  }

  function amazonDeliveryRegionLabel(value) {
    if (value?.deliveryRegionReady !== true) return "";
    return value.deliveryPostalCode
      ? `配送邮编 ${value.deliveryPostalCode}`
      : value.deliveryRegionMode === "marketplace_domain" ? "站点区域已匹配" : "";
  }

  function failRun(error) {
    analysisRunning = false;
    runState.mode = "error";
    runState.resumeSellerSprite = !["NO_ACTIONABLE_STORES", "NO_STORE_ASINS", "FILTERS_EMPTY", "AMAZON_DETAIL_PAUSED"].includes(String(error?.code || "").toUpperCase());
    runState.completedAt = error?.code === "AMAZON_DETAIL_PAUSED" ? null : new Date().toISOString();
    const exactRunCalls = Number(error?.data?.runToolCallCount);
    runState.sellerSpriteCalls = Number.isFinite(exactRunCalls)
      ? Math.max(0, Math.trunc(exactRunCalls))
      : Math.max(0, (sellerSpriteCallCount ?? 0) - (runState.toolCallBaseline ?? 0));
    runState.errors.push({ code: error.code || "RUN_FAILED", message: error.message });
    const presentation = runErrorPresentation(error);
    if (presentation.connectionLost) {
      sellerSpriteStatus = "error";
      setConnectionState("error", "授权已失效");
    }
    const currentStage = $("#stageList li.is-current");
    currentStage?.classList.add("is-error");
    setDataMode(
      sellerSpriteStatus === "live" ? (activeMarket.code === "NL" ? "mixed" : "live") : sellerSpriteStatus === "idle" ? "idle" : "error",
      sellerSpriteStatus === "live" ? (activeMarket.code === "NL" ? "DE 代理待命" : "实时数据") : sellerSpriteStatus === "idle" ? "等待连接" : "数据源异常",
    );
    showProgressError(
      presentation.title,
      error.message || presentation.fallbackMessage,
      { action: presentation.action, actionLabel: presentation.actionLabel, showDemo: presentation.showDemo },
    );
    renderRunCoverage();
    const button = byId("startAnalysisButton");
    button?.classList.remove("is-loading");
    updateStartAvailability();
    renderResults();
    updateHistorySummary();
    scheduleRequested1688Resume();
  }

  function runErrorPresentation(error) {
    const code = String(error?.code || "RUN_FAILED").toUpperCase();
    if (code === "AMAZON_DETAIL_PAUSED") {
      return { title: "Amazon 详情已暂停", fallbackMessage: amazonDetailPauseMessage(runState.amazonDetailPause),
        action: "analysis", actionLabel: "继续 Amazon 详情", showDemo: false, connectionLost: false };
    }
    if (code === "LOCAL_PERSISTENCE_FAILED") {
      return {
        title: "本地历史保存失败",
        fallbackMessage: "调用记录无法安全写入，本次任务已停止。",
        action: null,
        actionLabel: null,
        showDemo: false,
        connectionLost: false,
      };
    }
    if (code === "SELLSPRITE_SESSION_LOST" || code === "SELLSPRITE_CONNECT_REQUIRED") {
      return {
        title: "SellerSprite 授权已失效",
        fallbackMessage: "请重新授权后再开始分析。",
        action: "connect",
        actionLabel: "重新授权并连接",
        showDemo: activeMarket.code !== "NL",
        connectionLost: true,
      };
    }
    if (code === "NO_STORE_ASINS") {
      return {
        title: "未从店铺发现商品",
        fallbackMessage: "SellerSprite 尚未执行商品分析。",
        action: "analysis",
        actionLabel: "重新分析店铺",
        showDemo: activeMarket.code !== "NL",
        connectionLost: false,
      };
    }
    if (code === "AMAZON_STORE_VISIT_FAILED") {
      return {
        title: "Amazon 店铺访问未完成",
        fallbackMessage: "SellerSprite 尚未执行商品分析。",
        action: "analysis",
        actionLabel: "稍后重试",
        showDemo: false,
        connectionLost: false,
      };
    }
    if (code === "FILTERS_EMPTY") {
      return {
        title: "没有符合条件的候选",
        fallbackMessage: "请调整推荐条件后重新分析。",
        action: "filters",
        actionLabel: "调整筛选条件",
        showDemo: false,
        connectionLost: false,
      };
    }
    if (code === "PROVIDER_NO_CANDIDATES") {
      return {
        title: "SellerSprite 未返回候选",
        fallbackMessage: "授权仍然有效，可按需重新分析。",
        action: "analysis",
        actionLabel: "重新分析",
        showDemo: activeMarket.code !== "NL",
        connectionLost: false,
      };
    }
    if (code === "NO_ACTIONABLE_STORES") {
      return {
        title: "店铺清单缺少有效访问键",
        fallbackMessage: "请补充 Seller ID、店铺名或 ASIN。",
        action: null,
        actionLabel: null,
        showDemo: false,
        connectionLost: false,
      };
    }
    return {
      title: "店铺分析未完成",
      fallbackMessage: "任务请求未完成，请检查店铺访问明细后重试。",
      action: "analysis",
      actionLabel: "重新分析",
      showDemo: false,
      connectionLost: false,
    };
  }

  function showProgressError(title, message, { action = "connect", actionLabel = null, showDemo = true } = {}) {
    const panel = byId("progressPanel");
    if (panel) {
      panel.hidden = false;
      panel.classList.add("is-error");
    }
    const error = byId("progressError");
    if (error) error.hidden = false;
    setText("progressErrorTitle", title);
    setText("progressErrorMessage", message);
    const retry = byId("retryConnectionButton");
    if (retry) {
      const labels = {
        connect: { text: "重新授权并连接", icon: "refresh-cw" },
        analysis: { text: "重新分析", icon: "rotate-cw" },
        filters: { text: "调整筛选条件", icon: "sliders-horizontal" },
      };
      const config = labels[action] || null;
      retry.hidden = !config;
      retry.dataset.action = action || "";
      if (config) retry.innerHTML = `<i data-lucide="${config.icon}" aria-hidden="true"></i>${escapeHtml(actionLabel || config.text)}`;
    }
    if (byId("useDemoDataButton")) byId("useDemoDataButton").hidden = !showDemo || !["AU", "US"].includes(activeMarket.code);
    initIcons();
  }

  function hideProgressError() {
    const error = byId("progressError");
    if (error) error.hidden = true;
    byId("progressPanel")?.classList.remove("is-error");
  }

  function createRunError(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
  }

  function hasSellerSpriteSessionError(errors) {
    const sessionCodes = new Set([
      "SELLSPRITE_SESSION_LOST",
      "SELLSPRITE_CONNECT_REQUIRED",
      "NOT_CONNECTED",
      "NOT_INITIALIZED",
      "CONNECTION_CLOSED",
      "CLIENT_HTTP_AUTHENTICATION",
      "CLIENT_HTTP_FORBIDDEN",
    ]);
    return (errors || []).some((item) => sessionCodes.has(String(item?.code || "").toUpperCase()));
  }

  function setProgress(percent) {
    if (byId("progressPercent")) byId("progressPercent").textContent = `${percent}%`;
    if (byId("progressBar")) byId("progressBar").style.width = `${percent}%`;
  }

  function bindResults() {
    const renderFirstPage = () => {
      resultPage = 1;
      renderResults();
    };
    ["resultSearch", "resultMinMargin", "resultsCompleteToggle"].forEach((id) => {
      const control = byId(id);
      control?.addEventListener(id === "resultSearch" ? "input" : "change", renderFirstPage);
      if (control?.type === "number") control.addEventListener("input", renderFirstPage);
    });

    byId("matchFiltered1688Button")?.addEventListener("click", () => {
      void startFiltered1688Matching();
    });
    byId("pauseSupplierPipelineButton")?.addEventListener("click", () => void pauseServerSupplierPipeline());

    byId("previousResultsPage")?.addEventListener("click", () => {
      resultPage = Math.max(1, resultPage - 1);
      renderResults();
    });
    byId("nextResultsPage")?.addEventListener("click", () => {
      resultPage += 1;
      renderResults();
    });
    // 表格结尾的翻页控件（与顶部翻页共用同一页码状态）。
    byId("previousResultsPageBottom")?.addEventListener("click", () => {
      resultPage = Math.max(1, resultPage - 1);
      renderResults();
    });
    byId("nextResultsPageBottom")?.addEventListener("click", () => {
      resultPage += 1;
      renderResults();
    });

    byId("refreshResultsButton")?.addEventListener("click", () => {
      renderResults();
      const button = byId("refreshResultsButton");
      button.classList.add("is-spinning");
      setTimeout(() => button.classList.remove("is-spinning"), 420);
      showToast("候选结果已按当前条件刷新。", "info");
    });

    byId("resetResultFilters")?.addEventListener("click", () => {
      const button = byId("resetResultFilters");
      if (button?.dataset.action === "show-incomplete") {
        byId("resultsCompleteToggle").checked = false;
        renderFirstPage();
        showToast("已显示大致数据；完整度状态会保留在列表和导出文件中。", "info", 5200);
        return;
      }
      if (button?.dataset.action === "edit-criteria") {
        byId("resultsAmazonFilters")?.scrollIntoView({ behavior: "smooth", block: "center" });
        byId("monthlySalesBand")?.focus();
        showToast("可直接调整上方 Amazon 筛选；全部候选 ASIN 始终保留。", "info", 5200);
        return;
      }
      resetResultFilters();
    });
    byId("showHiddenCandidatesButton")?.addEventListener("click", () => {
      byId("resultsCompleteToggle").checked = false;
      renderFirstPage();
      showToast("已显示大致数据；完整度状态会保留在列表和导出文件中。", "info", 5200);
    });
    const productTableBody = byId("productTableBody");
    productTableBody?.addEventListener("error", (event) => {
      const image = event.target;
      if (!image?.matches?.("[data-candidate-product-image]")) return;
      const row = image.closest("tr[data-product-id]");
      const visual = image.closest(".candidate-product-visual");
      const product = products.find((item) => item.id === row?.dataset.productId);
      if (!visual || !product) return;
      visual.classList.remove("has-product-image");
      visual.setAttribute("aria-hidden", "true");
      visual.innerHTML = candidateProductVisualFallback(product);
      initIcons();
    }, true);
    productTableBody?.addEventListener("click", (event) => {
      if (event.target.closest("[data-amazon-access]")) {
        event.preventDefault();
        byId("collectionAccessPanel")?.scrollIntoView({ behavior: "smooth", block: "center" });
        byId("collectionAccessPanel")?.focus({ preventScroll: true });
        return;
      }
      const amazonLink = event.target.closest("a.product-title-link");
      if (amazonLink) {
        event.preventDefault();
        return openAmazonLinkInEdge(amazonLink);
      }
      const button = event.target.closest("[data-open-product]");
      const row = event.target.closest("tr[data-product-id]");
      const productId = button?.dataset.openProduct || row?.dataset.productId;
      if (productId) openDrawer(productId);
    });
    productTableBody?.addEventListener("keydown", (event) => {
      if ((event.key === "Enter" || event.key === " ") && event.target.matches("tr[data-product-id]")) {
        event.preventDefault();
        openDrawer(event.target.dataset.productId);
      }
    });
    const exportMenu = byId("exportMenu");
    const exportButton = byId("exportButton");
    const exportMenuList = byId("exportMenuList");
    exportButton?.addEventListener("click", () => {
      setExportMenuOpen(exportMenuList?.hidden !== false);
    });
    exportButton?.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowDown") return;
      event.preventDefault();
      setExportMenuOpen(true, { focusFirst: true });
    });
    byId("exportAllCandidatesButton")?.addEventListener("click", () => {
      setExportMenuOpen(false, { restoreFocus: true });
      void exportProducts("all");
    });
    byId("exportApprovedProductsButton")?.addEventListener("click", () => {
      setExportMenuOpen(false, { restoreFocus: true });
      void exportProducts("approved");
    });
    byId("exportAnalysisHandoffButton")?.addEventListener("click", () => {
      setExportMenuOpen(false, { restoreFocus: true });
      void exportAnalysisHandoff();
    });
    exportMenuList?.addEventListener("keydown", (event) => {
      const items = [byId("exportAllCandidatesButton"), byId("exportApprovedProductsButton"), byId("exportAnalysisHandoffButton")].filter((item) => item && !item.disabled);
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        setExportMenuOpen(false, { restoreFocus: true });
        return;
      }
      if (!["ArrowDown", "ArrowUp"].includes(event.key) || !items.length) return;
      event.preventDefault();
      const currentIndex = Math.max(0, items.indexOf(document.activeElement));
      const direction = event.key === "ArrowDown" ? 1 : -1;
      items[(currentIndex + direction + items.length) % items.length].focus();
    });
    document.addEventListener("click", (event) => {
      if (!exportMenu?.contains(event.target)) setExportMenuOpen(false);
    });
  }

  async function openAmazonLinkInEdge(link) {
    if (link.dataset.openingEdge === "true") return;
    const url = link.getAttribute("data-amazon-url");
    if (!url) return;
    link.dataset.openingEdge = "true";
    try {
      await apiRequest("/api/amazon/open-in-edge", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }), timeout: 10000,
      });
    } catch (error) {
      if (error.status === 404 && ["NOT_FOUND", "HTTP_404"].includes(error.code)) {
        showToast("本地服务与页面版本不一致，尚未加载 Edge 打开接口。请通过项目启动器安全重启服务后刷新页面。", "error", 7000);
      } else {
        showToast(`无法在 Edge 打开 Amazon：${error.message}`, "error", 5500);
      }
    } finally {
      delete link.dataset.openingEdge;
    }
  }

  function setExportMenuOpen(open, { focusFirst = false, restoreFocus = false } = {}) {
    const menu = byId("exportMenu");
    const list = byId("exportMenuList");
    const trigger = byId("exportButton");
    if (!menu || !list || !trigger) return;
    const nextOpen = Boolean(open);
    list.hidden = !nextOpen;
    menu.classList.toggle("is-open", nextOpen);
    trigger.setAttribute("aria-expanded", String(nextOpen));
    if (nextOpen && focusFirst) requestAnimationFrame(() => byId("exportAllCandidatesButton")?.focus());
    if (!nextOpen && restoreFocus) trigger.focus();
  }

  function getExportProducts(scope = "all", candidates = getFilteredProducts()) {
    return scope === "all" ? candidates : candidates.filter(product => product.reviewStatus === "approved");
  }

  function syncExportMenuCounts(candidates = getFilteredProducts()) {
    const approved = getExportProducts("approved", candidates);
    setText("exportAllCandidateCount", candidates.length);
    setText("exportApprovedProductCount", approved.length);
    setText("analysisReviewedExportCount", approved.length);
    setExportActionsDisabled(exportRunning, candidates);
  }

  function resetResultFilters() {
    byId("resultSearch").value = "";
    byId("resultMinMargin").value = "";
    byId("resultWeightBand").value = "";
    byId("resultsCompleteToggle").checked = false;
    resultPage = 1;
    renderResults();
    showToast("结果筛选已恢复默认。", "info");
  }

  function productWeightKgForDisplay(product) {
    if (usesItemWeightOnly(product)) return resolveManualWeightOverride(product)?.weightKg ?? automaticProfitWeightKg(product);
    return [product?.productWeight, product?.fbaWeight]
      .map(finiteOrNull)
      .find((value) => value !== null && value > 0) ?? null;
  }

  function productFilterExclusionReasons(product, criteria = {}, today) {
    const reasons = productStoreCriteria(product, criteria).map((rule) => singleStoreFilterExclusionReasons(product, rule));
    const combined = reasons.some((list) => list.length === 0) ? [] : [...new Set(reasons.flat())];
    if (criteria.amazonFirstAvailableFrom) {
      const date = amazonListingDateValue(product);
      if (!matchesAmazonListingDate(date, criteria.amazonFirstAvailableFrom, today ?? todayDateOnly())) {
        combined.push(date ? "AMAZON_LISTING_DATE_OUTSIDE_RANGE" : "AMAZON_LISTING_DATE_UNKNOWN");
      }
    }
    return combined;
  }

  function amazonListingDateValue(product) {
    return product?.amazonFirstAvailableDateStatus === "found" ? normalizeISODateOnly(product.amazonFirstAvailableDate) : null;
  }

  function amazonListingDateLabel(product) {
    const value = amazonListingDateValue(product);
    if (value) return value;
    if (product?.amazonFirstAvailableDateStatus === "not_provided") return "Amazon 未提供上架日期";
    if (amazonCollectionFailure(product)) return "上架日期待核验 · 详情采集失败";
    if (product?.amazonFirstAvailableDateEvidence) return "上架日期待核验 · 日期证据尚未确认";
    if (product?.productInformation?.inspection?.errorCode) return "上架日期待核验 · 浏览器检查失败";
    if (hasUnavailableAmazonSpecifications(product)) return "上架日期待核验 · 完整规格入口当前不可用";
    if (product?.productInformation?.inspection?.reason === "inspection_timeout") return "上架日期待核验 · 商品信息区检查超时";
    if (product?.productInformation?.status === "incomplete") return "上架日期待核验 · 商品信息区尚未完整读取";
    return "上架日期待核验";
  }

  function renderAmazonListingDateCoverage() {
    let found = 0, notProvided = 0;
    for (const product of products) {
      if (amazonListingDateValue(product)) found++;
      else if (product.amazonFirstAvailableDateStatus === "not_provided") notProvided++;
    }
    const unknown = products.length - found;
    const start = activeRunCriteria.amazonFirstAvailableFrom;
    setText("amazonListingDateCoverage", `Amazon 上架日期：已取得 ${formatInteger(found)} / ${formatInteger(products.length)} · 未知 ${formatInteger(unknown)}（页面未提供 ${formatInteger(notProvided)}，待核验 ${formatInteger(unknown - notProvided)}）。${start ? `当前范围 ${start} 至 ${todayDateOnly()}，包含两端，未知日期不纳入。` : "未启用日期筛选，未知日期正常参与分析，不影响利润计算。"}`);
    const input = byId("amazonFirstAvailableFrom");
    if (input) input.max = todayDateOnly();
  }

  function productStoreCriteria(product, criteria = {}) {
    const sources = Array.isArray(product?.sourceStores) ? product.sourceStores : [];
    const stores = (storeList?.stores || []).filter((store, index) =>
      (store.sellerId && store.sellerId === product?.sellerId)
      || sources.some((source) => (source.sellerId && source.sellerId === store.sellerId)
        || (Number.isInteger(source.storeIndex) && source.storeIndex === index)
        || (source.rowNumbers || []).some((row) => (store.rowNumbers || []).includes(row))));
    if (!stores.length) return [{ ...criteria }];
    return stores.map((store) => {
      const reviewRange = intersectReviewRanges(criteria, store.criteria || {});
      return {
        ...criteria,
        ...Object.fromEntries(Object.entries(store.criteria || {}).filter(([, value]) => value !== null && value !== undefined)),
        ...reviewRange,
        sourceRows: store.rowNumbers || [],
        importBlocked: store.importBlocked === true || reviewRange.importBlocked === true,
      };
    });
  }

  function singleStoreFilterExclusionReasons(product, criteria = {}) {
    const reasons = [];
    if (criteria.importBlocked) reasons.push("STORE_IMPORT_RULE_CONFLICT");
    const enabled = (value) => value !== null && value !== undefined && value !== "";
    const detailPending = String(product?.detailStatus || "").toLowerCase() === "pending";
    if (isMonthlySalesFilterRequired(currentTaskInputMode(), criteria.monthlySalesBand)) {
      const monthlySalesBand = criteria.monthlySalesBand || "all";
      const effectiveMonthlySales = monthlySalesValue(product, criteria);
      if (effectiveMonthlySales === null) {
        reasons.push("MONTHLY_SALES_EVIDENCE_MISSING");
      } else if (effectiveMonthlySales < 50) {
        reasons.push("MONTHLY_SALES_BELOW_50");
      } else {
        if (monthlySalesBand === "50_to_100" && effectiveMonthlySales >= 100) reasons.push("MONTHLY_SALES_OUTSIDE_50_TO_100");
        if (monthlySalesBand === "100_plus" && effectiveMonthlySales < 100) reasons.push("MONTHLY_SALES_BELOW_100");
      }
    }
    reasons.push(...reviewRangeExclusionReasons(product.reviews, criteria));
    if (enabled(criteria.minRating) && (Number.isFinite(product.rating) ? product.rating < criteria.minRating : !detailPending)) reasons.push("RATING_BELOW_MINIMUM");
    if (enabled(criteria.minProfitMargin) && Number.isFinite(product.margin) && product.margin < criteria.minProfitMargin) reasons.push("PROFIT_BELOW_STORE_MINIMUM");
    return reasons;
  }

  function matchesProductCriteria(product, criteria = {}, today) {
    return productFilterExclusionReasons(product, criteria, today).length === 0;
  }

  function weightBandMatches(product, band) {
    if (!band) return true;
    const weightKg = productWeightKgForDisplay(product);
    if (weightKg === null) return false;
    const grams = weightKg * 1_000;
    if (band === "under_100") return grams < 100;
    if (band === "100_150") return grams >= 100 && grams <= 150;
    if (band === "150_250") return grams > 150 && grams <= 250;
    if (band === "250_500") return grams > 250 && grams <= 500;
    if (band === "over_500") return grams > 500;
    return true;
  }

  function getFilteredProducts({ completeOnlyOverride } = {}) {
    const query = byId("resultSearch")?.value.trim().toLowerCase() || "";
    const resultMinMargin = numberOrNull(byId("resultMinMargin")?.value);
    const resultWeightBand = byId("resultWeightBand")?.value || "";
    const completeOnly = completeOnlyOverride ?? (byId("resultsCompleteToggle")?.checked ?? false);
    const today = todayDateOnly();
    let filtered = products.filter((product) => {
      const haystack = [product.asin, product.name, product.englishName, product.storeName, product.sellerId].join(" ").toLowerCase();
      if (query && !haystack.includes(query)) return false;
      if (!matchesProductCriteria(product, activeRunCriteria, today)) return false;
      if (completeOnly && !product.complete) return false;
      if (!weightBandMatches(product, resultWeightBand)) return false;
      const margin = recommendationMargin(product);
      if (resultMinMargin !== null && (margin === null || margin < resultMinMargin)) return false;
      return true;
    });

    filtered.sort((a, b) => {
      const leftMargin = recommendationMargin(a);
      const rightMargin = recommendationMargin(b);
      if (leftMargin === null && rightMargin !== null) return 1;
      if (leftMargin !== null && rightMargin === null) return -1;
      return (rightMargin ?? -999) - (leftMargin ?? -999) || (b.currentPrice ?? -1) - (a.currentPrice ?? -1);
    });

    return filtered;
  }

  function coverageCount(value) {
    if (value === null || value === undefined || value === "") return null;
    const count = Number(value);
    return Number.isInteger(count) && count >= 0 ? count : null;
  }

  function amazonCoverageBreakdown(coverage = {}) {
    const visits = Array.isArray(runState.storeVisits) ? runState.storeVisits : [];
    const hasVisitEvidence = visits.length > 0;
    const incompleteVisits = hasVisitEvidence ? visits.filter((visit) => visit?.complete !== true) : [];
    const completedVisits = hasVisitEvidence ? visits.filter((visit) => visit?.complete === true) : [];
    const pendingEnumerationAsins = coverageCount(coverage.pendingEnumerationAsins)
      ?? (hasVisitEvidence
        ? incompleteVisits.reduce((total, visit) => total + Number(visit?.notEnumeratedAsins || 0), 0)
        : coverageCount(coverage.notEnumeratedAsins));
    const completedReportedGapAsins = coverageCount(coverage.completedReportedGapAsins)
      ?? (hasVisitEvidence
        ? completedVisits.reduce((total, visit) => total + Number(visit?.notEnumeratedAsins || 0), 0)
        : null);
    return {
      splitAvailable: hasVisitEvidence
        || coverage.pendingEnumerationAsins !== undefined
        || coverage.completedReportedGapAsins !== undefined
        || coverage.incompleteStores !== undefined,
      pendingEnumerationAsins,
      completedReportedGapAsins,
      incompleteStores: coverageCount(coverage.incompleteStores)
        ?? (hasVisitEvidence ? incompleteVisits.length : null),
      completedReportedGapStores: coverageCount(coverage.completedReportedGapStores)
        ?? (hasVisitEvidence ? completedVisits.filter((visit) => Number(visit?.notEnumeratedAsins || 0) > 0).length : null),
    };
  }

  function coverageOmissionReasons(coverage, notIncludedCount) {
    const reasonLabels = {
      AMAZON_REPORTED_TOTAL_GAP: "Amazon 页面报告的商品未全部出现在结果卡片中",
      AMAZON_PAGINATION_INCOMPLETE: "Amazon 店铺分页仍在继续",
      AMAZON_PAGINATION_NO_PROGRESS: "Amazon 分页断点未产生新数据，已停止空转",
      SOURCE_ASIN_LIMIT_REACHED: "达到单店源 ASIN 抓取上限",
      AMAZON_ACCESS_CHALLENGE: "Amazon 访问遇到验证，已保存进度并等待续跑",
      AMAZON_HTTP_429: "Amazon 访问频率受限，已保存进度并等待续跑",
      AMAZON_QUEUE_PAUSED: "同站点访问受限，尚未发起访问并等待续跑",
      AMAZON_STORE_VISIT_FAILED: "Amazon 店铺访问失败",
      AMAZON_STORE_VISIT_INTERRUPTED: "Amazon 店铺访问中断",
      AMAZON_NAVIGATION_ERROR: "Amazon 店铺页面访问失败",
    };
    const rawReasons = coverage?.omissionReasons;
    const entries = Array.isArray(rawReasons)
      ? rawReasons.map((entry) => [null, entry])
      : rawReasons && typeof rawReasons === "object"
        ? Object.entries(rawReasons)
        : rawReasons ? [[null, rawReasons]] : [];
    const hasSplitCoverage = coverage?.splitAvailable === true;
    const reasons = [];
    if (hasSplitCoverage) {
      const incompleteStores = coverageCount(coverage.incompleteStores);
      const pendingAsins = coverageCount(coverage.pendingEnumerationAsins);
      const gapAsins = coverageCount(coverage.completedReportedGapAsins);
      const gapStores = coverageCount(coverage.completedReportedGapStores);
      if (incompleteStores !== null) reasons.push(`未完成店铺：${formatInteger(incompleteStores)} 家`);
      if (pendingAsins !== null) reasons.push(`待继续枚举：约 ${formatInteger(pendingAsins)} 个 ASIN`);
      if (gapAsins) reasons.push(`已完成店铺的 Amazon 页头估算差异：${formatInteger(gapAsins)} 个${gapStores ? `（${formatInteger(gapStores)} 家）` : ""}`);
      const failedStores = coverageCount(coverage.visitFailed);
      if (failedStores !== null) reasons.push(`访问失败：${formatInteger(failedStores)} 家`);
    }
    entries.map(([key, entry]) => {
      if (typeof entry === "string") return reasonLabels[entry.trim()] || entry.trim();
      if (typeof entry === "number") return key ? `${key}：${formatInteger(entry)} 个` : "";
      if (!entry || typeof entry !== "object") return "";
      const code = String(entry.code || key || "").trim().toUpperCase();
      if (hasSplitCoverage && ["AMAZON_REPORTED_TOTAL_GAP", "AMAZON_PAGINATION_INCOMPLETE"].includes(code)) return "";
      const fallbackLabel = code.startsWith("AMAZON_")
        ? "Amazon 店铺访问未完成"
        : String(entry.label || entry.reason || entry.message || code).trim();
      const label = reasonLabels[code] || fallbackLabel;
      const count = coverageCount(entry.count ?? entry.asinCount ?? entry.total);
      return label ? `${label}${count === null ? "" : `：${formatInteger(count)} 个`}` : "";
    }).filter(Boolean).forEach((reason) => reasons.push(reason));
    if (reasons.length) return reasons;
    if (notIncludedCount === 0) return ["全部已识别店铺 ASIN 均已纳入候选"];
    if (notIncludedCount === null) return ["店铺总 ASIN 尚未确认，暂无法统计未纳入数量"];
    return ["存在未纳入 ASIN，具体原因尚未返回"];
  }

  function currentFilterExclusionReasons() {
    const labels = {
      MONTHLY_SALES_AT_OR_ABOVE_50: "Amazon 月销量不在 50 以下（旧档位，已停用）",
      MONTHLY_SALES_EVIDENCE_MISSING: "月销量未知或未核验（不等于低于 50）",
      MONTHLY_SALES_BELOW_50: "已取得的月销量低于 50",
      MONTHLY_SALES_OUTSIDE_50_TO_100: "Amazon 月销量不在 50–<100",
      MONTHLY_SALES_BELOW_100: "Amazon 月销量低于 100",
      RATING_BELOW_MINIMUM: "评价星级低于筛选值或缺失",
      REVIEWS_BELOW_MINIMUM: "评价数量低于最小值",
      REVIEWS_ABOVE_MAXIMUM: "评价数量高于最大值",
      REVIEWS_MISSING: "评价数量待核验",
      REVIEWS_UNVERIFIED: "评价数量待核验",
      AMAZON_LISTING_DATE_UNKNOWN: "Amazon 上架日期未知",
      AMAZON_LISTING_DATE_OUTSIDE_RANGE: "Amazon 上架日期不在所选起始日期至今天的范围",
    };
    const counts = new Map();
    products.forEach((product) => {
      const reasons = productFilterExclusionReasons(product, activeRunCriteria);
      reasons.forEach((reason) => {
        const code = String(reason || "").trim().toUpperCase();
        if (!code) return;
        counts.set(code, (counts.get(code) || 0) + 1);
      });
    });
    return [...counts.entries()].map(([code, count]) =>
      `筛选未显示：${labels[code] || code}：${formatInteger(count)} 个（ASIN 已保留）`);
  }

  function renderSupplier1688Stage() {
    const panel = byId("supplierStagePanel");
    const button = byId("matchFiltered1688Button");
    const summary = byId("supplierBatchSummary");
    if (!panel || !button || !summary) return;

    const amazonComplete = amazonCollectionCompleteForSupplier();
    const pipeline = runState.supplier1688Pipeline;
    const pending = getPending1688ResumeProducts();
    const matchable = getAmazonFilteredProductsFor1688();
    const excludedSalesNote = Number(pipeline?.excludedMonthlySalesCount || 0) > 0
      ? `；另有 ${pipeline.excludedMonthlySalesCount} 个因无合格月销量标识而跳过` : "";
    const pendingIds = new Set(pending.map((product) => product.id));
    const filterDiffers = pending.length > 0
      && matchable.length > 0
      && (matchable.length !== pending.length || matchable.some((product) => !pendingIds.has(product.id)));
    const running = Boolean(supplier1688ResumePromise) || pipeline?.status === "running"
      || (pipeline?.owner === 'server' && ['queued', 'cooldown'].includes(pipeline.status));
    const pauseButton = byId('pauseSupplierPipelineButton');
    if (pauseButton) { pauseButton.hidden = pipeline?.owner !== 'server' || !running; pauseButton.disabled = false; }
    const canStart = Boolean(runState.id) && !["idle", "mock"].includes(runState.mode)
      && !running && !supplier1688SelectionPending && !amazonCollectionControlPending && !supplierCollectionTransition
      && (pending.length > 0 || matchable.length > 0);
    button.disabled = !canStart;
    button.title = canStart ? "按当前列表全部筛选结果进行图片匹配，缺少售价或重量不影响找货。"
      : running ? "当前匹配批次正在处理。" : "当前没有可匹配商品，或正在保存任务状态。";
    panel.dataset.status = running ? "running" : supplier1688SelectionPending ? "saving" : canStart ? "ready" : pipeline?.status || (amazonComplete ? "ready" : "waiting_amazon");

    const buttonText = button.querySelector("span");
    if (buttonText) {
      buttonText.textContent = running
        ? `1688 匹配中 ${Number(pipeline?.processed || 0)}/${Number(pipeline?.matchableCount || pending.length)}`
        : supplier1688SelectionPending
          ? "正在保存筛选批次…"
          : !pending.length && !matchable.length
          ? "暂无待匹配商品"
          : filterDiffers
          ? `继续匹配当前筛选 ${matchable.length} 个商品`
          : pending.length
            ? `继续匹配 ${pending.length} 个商品`
            : `${pipeline?.productIds?.length ? "继续匹配当前筛选" : "匹配当前筛选"} ${matchable.length} 个商品`;
    }

    if (supplier1688SelectionPending && !running) {
      summary.textContent = "正在保存 Amazon 断点和本次选中的商品，保存成功后开始匹配。";
      return;
    }
    if (running) {
      summary.textContent = `本任务累计纳入 ${Number(pipeline?.selectedCount || 0)} 个，已处理 ${Number(pipeline?.processed || 0)} 个，剩余 ${Number(pipeline?.remaining ?? pending.length)} 个${excludedSalesNote}；取得有效报价后立即按公式计算利润并更新列表。${pipeline?.message || ''}`;
      return;
    }
    if (pipeline?.owner === 'server' && pipeline.status === 'needs_attention') {
      summary.textContent = pipeline.message || (technical1688Pause(pipeline.lastReason) || technical1688Pause()
        ? '搜图进程中断，已保留断点；检查本地服务后可继续原批次。' : '匹配已保留断点，需先处理 1688 验证，再继续原批次。');
      return;
    }
    if (pending.length) {
      summary.textContent = filterDiffers
        ? `原任务仍有 ${pending.length} 个待处理，当前筛选可匹配 ${matchable.length} 个；点击继续将追加尚未加入的商品，保留已有结果并跳过重复商品。`
        : `上次确认的固定批次仍有 ${pending.length} 个待处理；${supplier1688LoggedIn ? "点击继续，不会加入筛选范围外的商品。" : "登录 1688 后可从断点继续。"}`;
      return;
    }
    if (pipeline?.status === "complete" && !matchable.length) {
      summary.textContent = supplierNoPendingMessage(pipeline);
      return;
    }
    if (pipeline?.status === "complete" && Number(pipeline.matchableCount || 0) > 0) {
      summary.textContent = `本任务已处理 ${Number(pipeline.processed ?? pipeline.matchableCount)} 个${excludedSalesNote}，当前筛选另有 ${matchable.length} 个可匹配；继续匹配会保留已有结果。`;
      return;
    }
    const visibleCount = getFilteredProducts().length;
    const excludedCount = visibleCount - matchable.length;
    const exclusionNote = excludedCount > 0
      ? `另有 ${excludedCount} 个已匹配、手工定价、已淘汰/交接或缺少 ASIN/主图的商品不重复加入。` : '';
    const collectionNote = ['queued', 'running', 'cooldown'].includes(currentAmazonCollectionJob()?.status)
      ? '点击后暂存并暂停 Amazon 采集，匹配结束后自动续采。' : '';
    summary.textContent = `当前列表 ${visibleCount} 个，待匹配 ${matchable.length} 个（包含全部分页）。${exclusionNote}图片匹配只需 ASIN 和主图；缺少售价或重量的商品也可获取报价，参数补齐后自动计算利润。${collectionNote}${supplier1688LoggedIn ? '' : '需先在专用 Edge 登录 1688。'}`;
  }

  function renderAsinCoverageSummary(salesCoverage = summarizeMonthlySalesCoverage(products, activeRunCriteria)) {
    renderMonthlySalesAdmission();
    setText("sellerSpriteSalesCount", `当前任务月销量 ${formatInteger(salesCoverage.bySource.sellerSprite)} 个 ASIN`);
    const salesCount = byId("sellerSpriteSalesCount");
    if (salesCount) salesCount.title = "当前查看任务中，按同一 ASIN、同一站点及有效近月销量证据核验的 SellerSprite 数据数量；连接成功不等于已取得销量。";
    setText("sellerSpriteSalesUnknown", `当前任务销量未知 ${formatInteger(salesCoverage.unknown)} 个`);
    setText("monthlySalesCoverage", `月销量：已取得 ${formatInteger(salesCoverage.verified)} / ${formatInteger(salesCoverage.total)} · 达到 50：${formatInteger(salesCoverage.qualified)} · 低于 50：${formatInteger(salesCoverage.belowThreshold)} · 未知：${formatInteger(salesCoverage.unknown)}`);
    setText("monthlySalesCoverageDetail", `未知明细：页面未提供 ${formatInteger(salesCoverage.pageUnavailable)} · 待采集 ${formatInteger(salesCoverage.pending)} · 请求失败 ${formatInteger(salesCoverage.failed)} · 待核验 ${formatInteger(salesCoverage.unverified)}。来源：Amazon ${formatInteger(salesCoverage.bySource.amazon)}，SellerSprite ${formatInteger(salesCoverage.bySource.sellerSprite)}；Amazon 购买量提示为下限。`);
    const coverage = runState.coverage || {};
    const breakdown = amazonCoverageBreakdown(coverage);
    const displayCoverage = { ...coverage, ...breakdown };
    setText("sourceAsinTotalLabel", isAsinImport() ? "导入 ASIN 合计" : "Amazon 报告合计（估算）");
    setText("retainedAsinLabel", isAsinImport() ? "已纳入唯一 ASIN" : "已枚举唯一 ASIN");
    setText("pendingAsinLabel", isAsinImport() ? "尚未纳入 ASIN" : "待继续枚举（估算）");
    const storeTotal = isAsinImport() ? importedItemCount() : coverageCount(coverage.reportedTotalAsins);
    const retained = coverageCount(coverage.discoveredAsins) ?? products.length;
    const notIncluded = isAsinImport() ? Math.max(0, storeTotal - retained) : breakdown.pendingEnumerationAsins;
    setText("storeAsinCount", storeTotal === null ? "未确认" : formatInteger(storeTotal));
    setText("retainedAsinCount", formatInteger(retained));
    setText("notIncludedAsinCount", notIncluded === null ? "未确认" : formatInteger(notIncluded));
    setText("filteredAsinCount", formatInteger(products.filter((product) => !matchesProductCriteria(product, activeRunCriteria)).length));
    const reasonList = byId("notIncludedReasonList");
    if (reasonList) {
      reasonList.innerHTML = [
        ...(isAsinImport() ? [notIncluded ? `${notIncluded} 个导入 ASIN 尚未纳入后台详情采集。` : "全部导入 ASIN 已纳入任务；无需枚举店铺。"] : coverageOmissionReasons(displayCoverage, notIncluded)),
        ...currentFilterExclusionReasons(),
      ]
        .map((reason) => `<li>${escapeHtml(reason)}</li>`)
        .join("");
    }
  }

  function renderResults() {
    renderAmazonCollection();
    const body = byId("productTableBody");
    if (!body) return;
    const scrollContainer = $(".view-stack");
    const reviewScrollPosition = activeProductId && scrollContainer
      ? { top: scrollContainer.scrollTop, left: scrollContainer.scrollLeft }
      : null;
    currentVisibleProducts = getFilteredProducts();
    const pageCount = Math.max(1, Math.ceil(currentVisibleProducts.length / RESULTS_PAGE_SIZE));
    resultPage = Math.min(Math.max(1, resultPage), pageCount);
    const pageStart = (resultPage - 1) * RESULTS_PAGE_SIZE;
    const pageProducts = currentVisibleProducts.slice(pageStart, pageStart + RESULTS_PAGE_SIZE);
    body.innerHTML = pageProducts.map(renderProductRow).join("");
    byId("visibleCount").textContent = String(currentVisibleProducts.length);
    const salesCoverage = summarizeMonthlySalesCoverage(products, activeRunCriteria);
    const candidateCount = currentTaskInputMode() === "asins" ? products.length : salesCoverage.qualified;
    setText("totalCandidateCount", candidateCount);
    setText("sourceAsinCount", products.length);
    byId("navCandidateCount").textContent = String(candidateCount);
    renderAsinCoverageSummary(salesCoverage);
    renderSupplier1688Stage();
    renderAmazonListingDateCoverage();
    syncExportMenuCounts(currentVisibleProducts);
    renderAnalysisHandoffSummary(currentVisibleProducts);
    const pagination = byId("resultsPagination");
    if (pagination) pagination.hidden = currentVisibleProducts.length <= RESULTS_PAGE_SIZE;
    setText(
      "resultsPageSummary",
      currentVisibleProducts.length
        ? `第 ${resultPage} / ${pageCount} 页 · ${formatInteger(pageStart + 1)}–${formatInteger(pageStart + pageProducts.length)} 条`
        : "第 1 / 1 页",
    );
    if (byId("previousResultsPage")) byId("previousResultsPage").disabled = resultPage <= 1;
    if (byId("nextResultsPage")) byId("nextResultsPage").disabled = resultPage >= pageCount;
    // 表格结尾翻页控件与顶部保持同步。
    const paginationBottom = byId("resultsPaginationBottom");
    if (paginationBottom) paginationBottom.hidden = currentVisibleProducts.length <= RESULTS_PAGE_SIZE;
    setText(
      "resultsPageSummaryBottom",
      currentVisibleProducts.length
        ? `第 ${resultPage} / ${pageCount} 页 · ${formatInteger(pageStart + 1)}–${formatInteger(pageStart + pageProducts.length)} 条`
        : "第 1 / 1 页",
    );
    if (byId("previousResultsPageBottom")) byId("previousResultsPageBottom").disabled = resultPage <= 1;
    if (byId("nextResultsPageBottom")) byId("nextResultsPageBottom").disabled = resultPage >= pageCount;
    const empty = byId("emptyResults");
    const emptyAction = byId("resetResultFilters");
    const completeOnlyEnabled = byId("resultsCompleteToggle")?.checked ?? false;
    const visibleWithoutCompleteness = completeOnlyEnabled && products.length
      ? getFilteredProducts({ completeOnlyOverride: false })
      : [];
    const hiddenIncomplete = visibleWithoutCompleteness.filter((product) => !product.complete).length;
    const hiddenByCriteria = products.filter((product) => !matchesProductCriteria(product, activeRunCriteria)).length;
    setText("hiddenCandidateCount", hiddenIncomplete);
    const showHiddenButton = byId("showHiddenCandidatesButton");
    if (showHiddenButton) showHiddenButton.hidden = hiddenIncomplete === 0;
    if (empty) empty.hidden = currentVisibleProducts.length !== 0;
    setText(
      "emptyResultsTitle",
      hiddenIncomplete
        ? `共抓到 ${products.length} 个候选，当前隐藏 ${hiddenIncomplete} 个`
        : hiddenByCriteria
          ? `已保留 ${products.length} 个 ASIN，当前筛选隐藏 ${hiddenByCriteria} 个`
        : "没有符合当前条件的商品",
    );
    setText(
      "emptyResultsHint",
      hiddenIncomplete
        ? "这些商品已有大致数据，可手工补齐成本并初审；导出文件会明确标记完整度和缺失字段。"
        : hiddenByCriteria
          ? currentTaskInputMode() === "asins"
            ? "部分商品不符合主动选择的筛选条件；月销量选择“全部商品”时不会排除低销量或未知商品。具体原因见上方覆盖说明，ASIN 不会被删除。"
            : "月销量、评价数量、星级或上架日期未达当前条件；仅将有效月销量至少 50 且符合所选档位的商品纳入候选。具体原因见上方覆盖说明，ASIN 不会被删除。"
        : "调整筛选条件后重新查看。",
    );
    if (emptyAction) {
      emptyAction.dataset.action = hiddenIncomplete ? "show-incomplete" : hiddenByCriteria ? "edit-criteria" : "reset";
      emptyAction.classList.toggle("is-rough-data-action", Boolean(hiddenIncomplete));
      emptyAction.innerHTML = hiddenIncomplete
        ? '<i data-lucide="eye" aria-hidden="true"></i>查看大致数据'
        : hiddenByCriteria
          ? '<i data-lucide="sliders-horizontal" aria-hidden="true"></i>返回筛选条件'
        : '<i data-lucide="rotate-ccw" aria-hidden="true"></i>重置筛选';
    }
    $(".product-table").hidden = currentVisibleProducts.length === 0;
    const sourceNotice = byId("resultsSourceNotice");
    if (sourceNotice) {
      const context = products[0] || runState;
      const hasConfirmedSource = products.length > 0 || Boolean(runState.providerMarketplace);
      const amazonOnly = context?.analysisSourceMode === "amazon_only" || activeRunCriteria?.useSellerSprite === false;
      sourceNotice.hidden = !amazonOnly && activeMarket.code !== "NL" && !isProxyAnalysis(context);
      const copy = sourceNotice.querySelector("span");
      if (copy) {
        copy.textContent = amazonOnly
          ? `本次仅使用 Amazon ${activeMarket.code} 官网商品页；未授权、未调用 SellerSprite。筛选隐藏的 ASIN 仍保存在任务记录中。`
          : hasConfirmedSource
          ? `${analysisSourceLabel(context)}。利润与履约费为 ${activeMarket.currency} 临时估算值。`
          : "荷兰站商品来自 Amazon NL 店铺；SellerSprite 商品指标将通过 DE 站代理分析，并明确标记为非 NL 实时数据。";
      }
    }
    initIcons();
    if (reviewScrollPosition) {
      scrollContainer.scrollTop = reviewScrollPosition.top;
      scrollContainer.scrollLeft = reviewScrollPosition.left;
    }
  }

  function candidateFbaSummaryHtml(product) {
    ensureFulfillmentState(product);
    const productWeightKg = productWeightKgForDisplay(product);
    const weightLabel = usesItemWeightOnly(product) ? resolveManualWeightOverride(product) ? "人工重量" : /包裹重量/.test(profitWeightSourceLabel(product)) ? "包裹重量" : "Item Weight"
      : finiteOrNull(product.productWeight) > 0 ? "商品重量" : "FBA 包装重量";
    const fbaFee = finiteOrNull(product.fbaFee);
    const values = [];
    if (productWeightKg !== null && productWeightKg > 0) {
      values.push(`<span><b>${weightLabel}</b>${formatWeightKg(productWeightKg)} kg · ${escapeHtml(productWeightBandLabel(productWeightKg))}</span>`);
    }
    if (productWeightKg === null && isAmazonWeightUnavailable(product)) values.push("<span>页面未提供重量 · 可初审</span>");
    else if (productWeightKg === null) values.push("<span>商品及包裹重量待采集</span>");
    if (product.profitCalculation?.weightAssumption) values.push("<span>利润按最低档暂估 · 实际重量未知</span>");
    const estimate = product.fbaEstimate;
    if (estimate?.dimensionalWeightKg) {
      const divisor = product.marketplace === 'AU' ? 6000 : 5021.69;
      const dimensionalFee = estimate.feeCandidates?.find(candidate => candidate.source === 'dimensional')?.fee;
      values.push(`<span class="candidate-fba-explanation">体积重 ${formatWeightKg(estimate.dimensionalWeightKg)} kg（${escapeHtml(estimate.dimensionsCm.join(' × '))} cm ÷ ${divisor}）${Number.isFinite(dimensionalFee) ? ` · 对应FBA费用 ${escapeHtml(formatCurrencyWithCnyText(dimensionalFee, product.marketplace))}` : ''}</span>`);
    }
    if (product.fulfillmentMode === "FBA" && fbaFee !== null) {
      const feeLabel = !product.manualFbaFee && product.fbaEstimate?.overweightCapped ? "FBA 封顶估算"
        : product.fbaEstimate?.assumption === "missing_weight_minimum_fba_estimate" && !product.manualFbaFee ? "FBA 最低档估算" : "FBA 配送费";
      values.push(`<span class="candidate-fba-cost"><b>${feeLabel}</b>${currencyPairHtml(fbaFee, product.marketplace, { compact: true })}</span>`);
    }
    const explanation = !product.manualFbaFee && product.fulfillmentMode === 'FBA' ? fbaSelectionExplanation(estimate) : '';
    if (explanation) values.push(`<span class="candidate-fba-explanation">${escapeHtml(explanation)}</span>`);
    return values.length ? `<div class="candidate-logistics is-calculated">${values.join("")}</div>` : "";
  }

  function productWeightBandLabel(weightKg) {
    const grams = finiteOrNull(weightKg) * 1_000;
    if (!Number.isFinite(grams) || grams <= 0) return "";
    if (grams < 50) return "小于 50g";
    if (grams < 100) return "50+（50-<100g）";
    return "100+（≥100g）";
  }

  function formatWeightKg(weightKg) {
    if (!Number.isFinite(weightKg)) return "";
    return new Intl.NumberFormat("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 6 }).format(weightKg);
  }

  function visibleStoreName(value) {
    const storeName = String(value || "").trim();
    return /^(?:未知店铺|unknown store)$/i.test(storeName) ? "" : storeName;
  }

  function amazonProductUrl(product) {
    const asin = String(product.sourceAsin || product.asin || "").trim().toUpperCase();
    if (!/^[A-Z0-9]{10}$/.test(asin)) return "";
    const marketCode = String(product.sourceMarketplace || product.marketplace || "").trim().toUpperCase();
    const domain = MARKET_CONFIGS[marketCode]?.amazonDomain
      || Object.values(MARKET_CONFIGS).find((market) => market.amazonDomain === String(product.amazonDomain || "").trim().toLowerCase())?.amazonDomain;
    const importedUrl = (storeList?.stores || []).find(source =>
      (!source.marketplace || source.marketplace === marketCode) && source.asins?.includes(asin)
      && source.productUrls?.[asin])?.productUrls?.[asin];
    for (const candidate of domain ? [importedUrl, product.canonicalUrl].filter(Boolean) : []) {
      try {
        const url = new URL(candidate);
        const urlAsin = url.pathname.match(/\/(?:dp|gp\/product|gp\/aw\/d)\/([A-Z0-9]{10})(?:\/|$)/i)?.[1]?.toUpperCase();
        if (url.protocol === 'https:' && !url.username && !url.password && !url.port
          && url.hostname.replace(/^www\./, '') === domain.replace(/^www\./, '') && urlAsin === asin) return url.href;
      } catch { /* Invalid saved URLs fall back to the canonical same-market ASIN link. */ }
    }
    return domain ? `https://${domain}/dp/${asin}` : "";
  }

  function renderProductRow(product) {
    const recommendation = getRecommendation(product);
    const hasPurchaseCost = Number.isFinite(product.purchaseCost);
    const calculation = calculateProfit(product);
    const purchase = hasPurchaseCost
      ? cnyCurrencyPairHtml(product.purchaseCost, product.marketplace, { compact: true })
      : "";
    const purchaseNote = !hasPurchaseCost
      ? ""
      : isManualCostProduct(product)
      ? "人工填写"
      : product.supplierSearchStatus === "complete"
        ? `中间 6 家 · 共 10 家有效报价`
        : isLowConfidenceSupplierEstimate(product)
          ? "图片相似度最高 6 家 · 低置信度"
        : escapeHtml(product.supplierSearchError || "待手动匹配 · 点击「匹配当前筛选」发起");
    const displayedMargin = recommendationMargin(product);
    let margin = displayedMargin === null
      ? `<span class="margin-value">待计算</span><small>缺少：${escapeHtml(profitCalculationMissingReasons(product).join('、') || '有效计算参数')}；补齐后自动计算</small>`
      : `<span class="margin-value ${marginClass(displayedMargin)}">${formatPercent(displayedMargin)}</span>${currencyPairHtml(calculation?.profit, product.marketplace, { suffix: " / 件", compact: true })}${calculation?.dimensionalWeightEstimateKg ? "<small>体积重暂估 · 实际重量未知</small>" : calculation?.weightAssumption ? "<small>最低档暂估 · 实际重量未知</small>" : ""}${calculation?.purchaseCostAssumedZero ? "<small>预估利润率（未扣采购成本）</small>" : isLowConfidenceSupplierEstimate(product) ? "<small>初步利润 · 1688 低置信度参考</small>" : "<small>初步经营利润估算</small>"}`;
    if (displayedMargin !== null && !product.manualFbaFee && product.fbaEstimate?.selectionStatus === 'single_source_estimate') margin += '<small>利润率暂估 · FBA缺少交叉核验</small>';
    if (displayedMargin !== null && !product.manualFbaFee && product.fbaEstimate?.selectionStatus === 'two_weight_lower_estimate') margin += '<small>利润率暂估 · 两项重量差超过1 kg，按较小重量估费</small>';
    const targetCost = Number.isFinite(product.targetCostCny)
      ? `${cnyCurrencyPairHtml(product.targetCostCny, product.marketplace, { compact: true })}${Number.isFinite(product.thresholdCostCny) ? `<small>盈利线</small>${cnyCurrencyPairHtml(product.thresholdCostCny, product.marketplace, { label: "≤ ", compact: true, secondary: true })}` : ""}`
      : "";
    const completeness = product.complete
      ? '<span class="completeness is-complete"><i data-lucide="check" aria-hidden="true"></i>字段完整</span>'
      : "";
    const sourceAsin = product.sourceAsin || product.asin || "";
    const storeIdentity = [visibleStoreName(product.storeName), product.sellerId].filter(Boolean).join(" · ");
    const fulfillmentNote = normalizeFulfillmentMode(product.fulfillmentMode)
      ? `<small class="model-note">${escapeHtml(fulfillmentPolicyShortLabel(product))}</small>`
      : "";
    const visual = renderCandidateProductVisual(product);
    const amazonUrl = amazonProductUrl(product);
    const productTitle = amazonUrl
      ? `<a class="product-title-link" href="microsoft-edge:${escapeHtml(amazonUrl)}" data-amazon-url="${escapeHtml(amazonUrl)}" rel="noopener noreferrer" title="在 Microsoft Edge 打开亚马逊商品：${escapeHtml(product.name)}">${escapeHtml(product.name)}</a>`
      : escapeHtml(product.name);

    return `
      <tr class="product-row" data-product-id="${product.id}" tabindex="0" aria-label="查看 ${escapeHtml(product.name)} 详情">
        <td>
          <div class="product-cell">
            ${visual}
            <div class="product-copy">
              <div><strong>${productTitle}</strong><span class="recommendation-tag is-${recommendation.type}">${recommendation.label}</span></div>
              ${sourceAsin ? `<span class="asin-label">源 ASIN ${escapeHtml(sourceAsin)}${product.parentAsin ? ` · 父 ASIN ${escapeHtml(product.parentAsin)}` : ""}</span>` : ""}
              ${storeIdentity ? `<small class="store-label">${escapeHtml(storeIdentity)}</small>` : ""}
              <small class="amazon-listing-date${amazonListingDateValue(product) ? "" : " is-unknown"}">${amazonListingDateValue(product) ? "Amazon 上架：" : ""}${escapeHtml(amazonListingDateLabel(product))}${amazonListingDateValue(product) ? "" : " · 不影响利润计算"}</small>
              ${candidateFbaSummaryHtml(product)}
              ${amazonProductCollectionNoteHtml(product)}
            </div>
          </div>
        </td>
        <td class="numeric-cell price-cell">${currencyPairHtml(product.currentPrice, product.marketplace)}${amazonPriceStatusLabel(product) ? `<small>${escapeHtml(amazonPriceStatusLabel(product))}</small>` : ""}${currencyPairHtml(product.salePrice, product.marketplace, { label: "我们的售价 ", secondary: true })}</td>
        <td class="numeric-cell">${targetCost}</td>
        <td class="numeric-cell"><strong>${purchase}</strong>${purchaseNote ? `<small>${purchaseNote}</small>` : ""}</td>
        <td class="numeric-cell profit-cell">${margin}</td>
        <td><span class="completeness-stack">${completeness}${fulfillmentNote}</span></td>
        <td><span class="review-status is-${product.reviewStatus}">${product.analysisHandoff?.owner === "procurement" ? "已交接采购" : REVIEW_LABELS[product.reviewStatus]}</span></td>
        <td><button class="icon-button row-open-button" type="button" data-open-product="${product.id}" aria-label="查看 ${escapeHtml(product.name)}"><i data-lucide="chevron-right" aria-hidden="true"></i></button></td>
      </tr>`;
  }

  function candidateProductVisualFallback(product) {
    return `<i data-lucide="${escapeHtml(product.visualIcon)}" aria-hidden="true"></i><span>${escapeHtml(String(product.id).slice(-2))}</span>`;
  }

  function renderCandidateProductVisual(product) {
    const amazonImageUrl = safeAmazonImageUrl(product.imageUrl);
    if (!amazonImageUrl) {
      return `<div class="product-visual candidate-product-visual ${escapeHtml(product.visualTone)}" aria-hidden="true">${candidateProductVisualFallback(product)}</div>`;
    }
    return `<div class="product-visual candidate-product-visual has-product-image ${escapeHtml(product.visualTone)}"><img data-candidate-product-image src="${escapeHtml(amazonImageUrl)}" alt="${escapeHtml(product.name)} 竞品主图" loading="lazy" decoding="async" referrerpolicy="no-referrer" /></div>`;
  }

  function getRecommendation(product) {
    if (String(product.risk || "").includes("带电")) return { type: "pending", label: "待排除" };
    const manualCost = isManualCostProduct(product);
    if (sellerSpriteDetailFailureLabel(product) && !product.manualAmazonOverride) return { type: "incomplete", label: "待判断" };
    if (!manualCost && product.supplierSearchStatus === "similarity_insufficient") return { type: "incomplete", label: "商品匹配样本不足" };
    if (!manualCost && product.supplierSearchStatus === "similarity_unverified") return { type: "incomplete", label: "商品匹配待更新" };
    if (!manualCost && product.supplierSearchStatus === "insufficient") return { type: "incomplete", label: "供应商样本不足" };
    if (!manualCost && (product.supplierSearchStatus === "failed" || product.supplierSearchStatus === "session_expired")) return { type: "incomplete", label: "匹配失败" };
    if (!manualCost && isLowConfidenceSupplierEstimate(product)) return { type: "pending", label: "低匹配估算" };
    if (!product.complete && !Number.isFinite(product.margin)) return { type: "incomplete", label: "待判断" };
    const criteria = activeRunCriteria;
    const matchesCriteria = matchesProductCriteria(product, criteria);
    const withinLimit = isWithinRecommendationLimit(product, criteria);
    if ((manualCost || product.supplierProfitable !== false) && matchesCriteria && withinLimit) {
      if (!product.complete) return { type: "pending", label: "利润已计算" };
      return { type: "strong", label: "推荐" };
    }
    return { type: "pending", label: !matchesCriteria ? "未达筛选" : !withinLimit ? "推荐名额外" : !manualCost && product.supplierProfitable === false ? "成本偏高" : "待判断" };
  }

  function isWithinRecommendationLimit(product, criteria = {}) {
    const limit = Math.floor(Number(criteria.limit));
    if (!Number.isFinite(limit) || limit <= 0) return true;
    const storeKey = recommendationStoreKey(product);
    const ranked = products
      .filter((candidate) => recommendationStoreKey(candidate) === storeKey && matchesProductCriteria(candidate, criteria))
      .sort((left, right) => (recommendationMargin(right) ?? -999) - (recommendationMargin(left) ?? -999)
        || (right.reviews ?? -1) - (left.reviews ?? -1)
        || String(left.sourceAsin || left.asin).localeCompare(String(right.sourceAsin || right.asin)));
    const index = ranked.findIndex((candidate) => candidate.id === product.id);
    return index >= 0 && index < limit;
  }

  function recommendationStoreKey(product) {
    const storeIndex = product.sourceStores?.find((store) => Number.isInteger(store?.storeIndex))?.storeIndex;
    return Number.isInteger(storeIndex)
      ? `${product.marketplace}:store-${storeIndex}`
      : `${product.marketplace}:${product.sellerId || product.storeName || product.id}`;
  }

  function recommendationMargin(product) {
    return finiteOrNull(product.margin);
  }

  function isLowConfidenceSupplierEstimate(product) {
    return !isManualCostProduct(product)
      && product?.supplierSearchStatus === "fallback_estimate"
      && product?.supplierCostMode === SUPPLIER_COST_MODE_FALLBACK
      && product?.supplierCostConfidence === "low";
  }

  function bindDrawer() {
    byId('supplierManualUrl')?.addEventListener('input', () => {
      const product = products.find(item => item.id === activeProductId);
      if (!product) return;
      const key = supplierChoiceKey(product.id);
      supplierChoiceDrafts.set(key, { ...(supplierChoiceDrafts.get(key) || product.supplierChoice), manualUrl: byId('supplierManualUrl').value });
      setText('supplierChoiceStatus', '链接尚未保存；手动输入优先于列表选择。');
    });
    byId('supplierManualUrl')?.addEventListener('change', () => saveSupplierChoice());
    byId('saveSupplierChoiceButton')?.addEventListener('click', () => saveSupplierChoice());
    byId('supplierList')?.addEventListener('change', event => {
      const radio = event.target.closest?.('[data-supplier-choice]');
      const product = products.find(item => item.id === activeProductId);
      if (!radio || !product) return;
      const key = supplierChoiceKey(product.id);
      supplierChoiceDrafts.set(key, { ...(supplierChoiceDrafts.get(key) || product.supplierChoice),
        selectedUrl: radio.value, manualUrl: byId('supplierManualUrl').value });
      return saveSupplierChoice(product.id);
    });
    byId("newAnalysisVersionButton")?.addEventListener("click", () => { void createNewAnalysisVersion(); });
    byId("closeDrawerButton")?.addEventListener("click", closeDrawer);
    byId("drawerBackdrop")?.addEventListener("click", (event) => {
      if (event.target === byId("drawerBackdrop")) closeDrawer();
    });
    $$("[data-detail-tab]").forEach((button) => {
      button.addEventListener("click", () => setDrawerTab(button.dataset.detailTab));
      button.addEventListener("keydown", (event) => {
        if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
        event.preventDefault();
        const tabs = $$("[data-detail-tab]");
        const currentIndex = tabs.indexOf(button);
        const direction = event.key === "ArrowRight" ? 1 : -1;
        const next = tabs[(currentIndex + direction + tabs.length) % tabs.length];
        setDrawerTab(next.dataset.detailTab);
        next.focus();
      });
    });
    byId("editSalePrice")?.addEventListener("input", () => {
      const product = products.find((item) => item.id === activeProductId);
      const weight = numberOrNull(byId("editWeight")?.value);
      const salePrice = numberOrNull(byId("editSalePrice")?.value);
      if (product && product.fulfillmentMode !== "FBM" && !product.manualFbaFee && !drawerFbaTouched) {
        const estimate = estimateFbaForEditor(product, weight, salePrice);
        byId("editFbaFee").value = feeInputValue(estimate?.fee);
      }
      renderProfitPreview();
      scheduleProfitAutoCommit();
    });
    byId("editPurchaseCost")?.addEventListener("input", () => {
      drawerPurchaseInput = "unit";
      renderProfitPreview();
      scheduleProfitAutoCommit();
    });
    byId("editPurchaseTotal")?.addEventListener("input", () => {
      drawerPurchaseInput = "total";
      renderProfitPreview();
      scheduleProfitAutoCommit();
    });
    byId("editPieceCount")?.addEventListener("input", () => {
      drawerPurchaseInput = "unit";
      setText("editPieceCountSource", "人工设置");
      renderProfitPreview();
      scheduleProfitAutoCommit();
    });
    byId("editFbaFee")?.addEventListener("input", () => {
      drawerFbaTouched = true;
      renderProfitPreview();
      scheduleProfitAutoCommit();
    });
    byId("editWeight")?.addEventListener("input", () => {
      const product = products.find((item) => item.id === activeProductId);
      const weight = numberOrNull(byId("editWeight").value);
      const fulfillmentMode = normalizeFulfillmentMode(product?.fulfillmentMode);
      if (product && fulfillmentMode !== "FBM" && !product.manualFbaFee && !drawerFbaTouched && weight !== null && weight > 0) {
        const estimate = estimateFbaForEditor(product, weight, numberOrNull(byId("editSalePrice")?.value));
        byId("editFbaFee").value = feeInputValue(estimate?.fee);
      }
      renderProfitPreview();
      scheduleProfitAutoCommit();
    });
    PROFIT_EDITOR_INPUT_IDS.forEach((id) => {
      byId(id)?.addEventListener("change", () => flushProfitAutoCommit({ force: true }));
    });
    byId("saveProfitEditsButton")?.addEventListener("click", saveProfitEditor);
    byId("approveProductButton")?.addEventListener("click", approveActiveProduct);
    byId("rejectProductButton")?.addEventListener("click", rejectActiveProduct);
    byId("rematchProductButton")?.addEventListener("click", rematchActiveProduct);
  }

  function bindManualCostDialog() {
    const dialog = byId("manualCostDialog");
    const form = byId("manualCostForm");
    byId("openManualCostButton")?.addEventListener("click", openManualCostDialog);
    byId("closeManualCostDialogButton")?.addEventListener("click", () => closeManualCostDialog());
    byId("cancelManualCostButton")?.addEventListener("click", () => closeManualCostDialog());
    dialog?.addEventListener("click", (event) => {
      if (event.target === dialog) closeManualCostDialog();
    });
    form?.addEventListener("submit", (event) => {
      event.preventDefault();
      saveManualCost({ approve: false });
    });
    byId("manualCostApproveButton")?.addEventListener("click", () => saveManualCost({ approve: true }));
    byId("manualPurchaseCost")?.addEventListener("input", () => {
      if (!manualCostDraft) return;
      manualCostDraft.purchaseCost = byId("manualPurchaseCost").value.trim();
      renderManualCostPreview();
    });
    byId("manualPieceCount")?.addEventListener("input", () => {
      if (!manualCostDraft) return;
      manualCostDraft.pieceCountTouched = true;
      captureManualCostDraft();
      renderManualCostPreview();
    });
    byId("manualFulfillmentFee")?.addEventListener("input", () => {
      if (!manualCostDraft) return;
      manualCostDraft.feeTouched[manualCostDraft.activeMode] = true;
      manualCostDraft.fees[manualCostDraft.activeMode] = byId("manualFulfillmentFee").value.trim();
      renderManualCostPreview();
    });
    $$('[data-product-cost]').forEach((input) => {
      input.addEventListener("input", () => {
        if (!manualCostDraft) return;
        captureManualCostDraft();
        renderManualCostPreview();
      });
    });
    $$('[data-manual-amazon]').forEach((input) => {
      const eventName = input.tagName === "SELECT" || input.type === "date" ? "change" : "input";
      input.addEventListener(eventName, () => {
        if (!manualCostDraft) return;
        captureManualCostDraft();
        renderManualCostPreview();
      });
    });
    const fulfillmentModeInputs = $$('input[name="manualFulfillmentMode"]');
    fulfillmentModeInputs.forEach((input, index) => {
      input.addEventListener("change", () => {
        if (!input.checked || !manualCostDraft) return;
        captureManualCostDraft();
        manualCostDraft.activeMode = normalizeFulfillmentMode(input.value);
        manualCostDraft.fulfillmentModeTouched = true;
        byId("manualFulfillmentFee").value = feeInputValue(manualCostDraft.fees[manualCostDraft.activeMode]);
        syncManualDraftAutomaticFbaFee(products.find((item) => item.id === manualCostDraft.productId));
        updateManualCostModeUi();
        renderManualCostPreview();
      });
      input.addEventListener("keydown", (event) => {
        if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Enter"].includes(event.key)) return;
        event.preventDefault();
        const direction = ["ArrowLeft", "ArrowUp"].includes(event.key) ? -1 : event.key === "Enter" ? 0 : 1;
        const next = direction === 0
          ? input
          : fulfillmentModeInputs[(index + direction + fulfillmentModeInputs.length) % fulfillmentModeInputs.length];
        next.checked = true;
        next.focus();
        next.dispatchEvent(new Event("change", { bubbles: true }));
      });
    });
  }

  function openManualCostDialog() {
    if (collectionWriteBlocked()) return;
    const product = products.find((item) => item.id === activeProductId);
    const dialog = byId("manualCostDialog");
    if (!product || !dialog) return;
    if (isAnalysisReadOnly(product)) { showToast("该商品已交接采购，请在采购端修改详细成本。", "info", 4800); return; }
    if (isProductSupplierBusy(product)) {
      showToast("这个商品正在匹配 1688，完成后即可修改。", "info", 4200);
      return;
    }
    ensureFulfillmentState(product);
    assumeFbaForWeightedProduct(product);
    const purchasePricing = ensureProductPurchasePricing(product);
    const resolvedProfitInputs = ensureProductProfitInputs(product);
    const sourceProductDimensions = parseDimensionsCm(product.productDimensions) || [];
    const sourcePackageDimensions = parseDimensionsCm(product.fbaDimensions) || [];
    const activeMode = product.fulfillmentMode || "FBA";
    lastManualCostFocusedElement = document.activeElement;
    manualCostDraft = {
      productId: product.id,
      activeMode,
      purchaseCost: valueOrBlank(purchasePricing.unitCostCny),
      pieceCount: purchasePricing.pieceCount,
      pieceCountTouched: product.pieceCountSource === "manual",
      fees: {
        FBA: valueOrBlank(product.fbaFee),
        FBM: valueOrBlank(product.fbmFee),
      },
      feeTouched: { FBA: false, FBM: false },
      fulfillmentModeTouched: false,
      fbaEstimate: product.fbaEstimate || null,
      baseline: {
        fulfillmentMode: product.fulfillmentMode,
        purchaseCost: finiteOrNull(product.purchaseCost),
        purchaseUnitCostCny: finiteOrNull(purchasePricing.unitCostCny),
        pieceCount: purchasePricing.pieceCount,
        fbaFee: finiteOrNull(product.fbaFee),
        fbmFee: finiteOrNull(product.fbmFee),
        profitInputs: JSON.stringify(resolvedProfitInputs),
        profitInputsObject: { ...resolvedProfitInputs, dimensionsCm: resolvedProfitInputs.dimensionsCm ? [...resolvedProfitInputs.dimensionsCm] : null },
        amazon: JSON.stringify({
          title: product.name || "",
          currentPrice: finiteOrNull(product.currentPrice),
          sales30: finiteOrNull(product.sales30),
          sales60: finiteOrNull(product.sales60),
          rating: finiteOrNull(product.rating),
          reviews: finiteOrNull(product.reviews),
          listingAvailableAt: dateInputValue(product.listingAvailableAt),
          firstFba: dateInputValue(product.firstFba),
          hasAPlus: typeof product.hasAPlus === "boolean" ? product.hasAPlus : null,
        }),
      },
      profitInputs: { ...resolvedProfitInputs },
      productDimensionsCm: sourceProductDimensions,
      packageDimensionsCm: sourcePackageDimensions,
      amazon: {
        title: product.name || "",
        currentPrice: valueOrBlank(product.currentPrice),
        sales30: valueOrBlank(product.sales30),
        sales60: valueOrBlank(product.sales60),
        rating: valueOrBlank(product.rating),
        reviews: valueOrBlank(product.reviews),
        listingAvailableAt: dateInputValue(product.listingAvailableAt),
        firstFba: dateInputValue(product.firstFba),
        hasAPlus: typeof product.hasAPlus === "boolean" ? String(product.hasAPlus) : "",
      },
      salePrice: finiteOrNull(product.salePrice),
    };
    setText("manualCostProductAsin", product.sourceAsin || product.asin || "");
    setText("manualCostProductName", product.name || "当前商品");
    setText("manualCostDialogDescription", "手动值将用于本商品的利润重算；保存后会标记为人工来源。");
    const market = MARKET_CONFIGS[product.marketplace] || activeMarket;
    const detailFailure = sellerSpriteDetailFailureLabel(product);
    setText("manualDetailStatusBadge", detailFailure ? "" : product.manualAmazonOverride ? "人工已补" : "详情成功");
    if (byId("manualDetailStatusBadge")) {
      byId("manualDetailStatusBadge").hidden = Boolean(detailFailure);
      byId("manualDetailStatusBadge").setAttribute("data-state", "ready");
    }
    setText("manualDetailFailureReason", "");
    if (byId("manualDetailFailureReason")) byId("manualDetailFailureReason").hidden = true;
    setText("manualCostSalePriceCurrency", market.currency);
    setText("manualAmazonCurrentPriceCurrency", market.currency);
    setText("manualFulfillmentCurrency", market.currency);
    const usesAuWeightFreight = resolvedProfitInputs.airFreightActualWeightOnly === true;
    setText("manualFreightPolicyNote", usesAuWeightFreight
      ? "澳洲表格口径：商品重量 × ¥0.045/g（即 ¥45/kg）"
      : "实际重与体积重取高值");
    ["manualCartonWeightField", "manualUnitsPerCartonField"].forEach((id) => {
      if (byId(id)) byId(id).hidden = usesAuWeightFreight;
    });
    byId("manualCostSalePrice").value = valueOrBlank(product.salePrice);
    byId("manualPurchaseCost").value = manualCostDraft.purchaseCost;
    byId("manualPieceCount").value = valueOrBlank(manualCostDraft.pieceCount);
    byId("manualPurchaseTotal").value = valueOrBlank(totalPurchaseCostCny(manualCostDraft.purchaseCost, manualCostDraft.pieceCount));
    setText("manualPieceCountSource", pieceCountSourceLabel(product));
    byId("manualCostFbaMode").checked = activeMode === "FBA";
    byId("manualCostFbmMode").checked = activeMode === "FBM";
    byId("manualFulfillmentFee").value = feeInputValue(manualCostDraft.fees[activeMode]);
    const amazonValues = {
      manualAmazonTitle: manualCostDraft.amazon.title,
      manualAmazonCurrentPrice: manualCostDraft.amazon.currentPrice,
      manualAmazonSales30: manualCostDraft.amazon.sales30,
      manualAmazonSales60: manualCostDraft.amazon.sales60,
      manualAmazonRating: manualCostDraft.amazon.rating,
      manualAmazonReviews: manualCostDraft.amazon.reviews,
      manualAmazonListingDate: manualCostDraft.amazon.listingAvailableAt,
      manualAmazonFirstFba: manualCostDraft.amazon.firstFba,
      manualAmazonHasAPlus: manualCostDraft.amazon.hasAPlus,
    };
    Object.entries(amazonValues).forEach(([id, value]) => {
      if (byId(id)) byId(id).value = value ?? "";
    });
    const values = {
      manualProductLengthCm: sourceProductDimensions[0],
      manualProductWidthCm: sourceProductDimensions[1],
      manualProductHeightCm: sourceProductDimensions[2],
      manualLengthCm: sourcePackageDimensions[0],
      manualWidthCm: sourcePackageDimensions[1],
      manualHeightCm: sourcePackageDimensions[2],
      manualActualWeightKg: resolvedProfitInputs.actualWeightKg,
      manualCartonWeightKg: resolvedProfitInputs.cartonWeightKg,
      manualUnitsPerCarton: resolvedProfitInputs.unitsPerCarton,
      manualAirFreightRate: resolvedProfitInputs.airFreightRateCnyPerKg,
      manualCommissionRate: resolvedProfitInputs.commissionRate,
      manualFxLossRate: resolvedProfitInputs.fxLossRate,
      manualMarketingRate: resolvedProfitInputs.marketingRate,
      manualManagementRate: resolvedProfitInputs.managementRate,
      manualReturnsRate: resolvedProfitInputs.returnsRate,
      manualPurchaseTaxRate: resolvedProfitInputs.purchaseTaxRate,
      manualDomesticFreightRate: resolvedProfitInputs.domesticFreightRateCnyPerKg,
    };
    Object.entries(values).forEach(([id, value]) => {
      if (byId(id)) byId(id).value = valueOrBlank(value);
    });
    syncManualDraftAutomaticFbaFee(product);
    const hasParameterSource = Boolean(resolvedProfitInputs.actualWeightKg && resolvedProfitInputs.dimensionsCm);
    setText("manualSellerSpriteParameterSource", hasParameterSource ? `SellerSprite · ${resolvedProfitInputs.dimensionSource} / ${resolvedProfitInputs.weightSource}` : "");
    if (byId("manualSellerSpriteParameterSource")) {
      byId("manualSellerSpriteParameterSource").hidden = !hasParameterSource;
      byId("manualSellerSpriteParameterSource").setAttribute("data-state", "ready");
    }
    setText("manualSizeSourceBadge", resolvedProfitInputs.dimensionsCm ? resolvedProfitInputs.dimensionSource || "" : "");
    if (byId("manualSizeSourceBadge")) {
      byId("manualSizeSourceBadge").hidden = !resolvedProfitInputs.dimensionsCm;
      byId("manualSizeSourceBadge").setAttribute("data-state", "ready");
    }
    updateManualCostModeUi();
    dialog.hidden = false;
    document.body.classList.add("manual-cost-open");
    syncManualCostReadOnlyState();
    renderManualCostPreview();
    initIcons();
    requestAnimationFrame(() => byId("manualPurchaseCost")?.focus());
  }

  function updateManualCostModeUi() {
    if (!manualCostDraft) return;
    const mode = manualCostDraft.activeMode;
    const product = products.find((item) => item.id === manualCostDraft.productId);
    const automaticFba = mode === "FBA" && !product?.manualFbaFee && !manualCostDraft.feeTouched.FBA;
    const market = MARKET_CONFIGS[String(product?.marketplace || activeMarket.code).toUpperCase()] || activeMarket;
    const automaticFbaLabel = market.code === "AU" ? "澳洲标准信封自动，可覆盖" : market.code === "CA" ? "加拿大旺季信封自动，可覆盖" : "SOP 自动，可覆盖";
    setText("manualFulfillmentFeeLabel", mode === "FBA"
      ? `FBA 配送费（${automaticFba ? automaticFbaLabel : "人工"}）`
      : "FBM 履约费");
    byId("manualFulfillmentFee")?.setAttribute("aria-label", mode === "FBA" ? "FBA 配送费" : "FBM 履约费");
  }

  function syncManualDraftAutomaticFbaFee(product) {
    if (!manualCostDraft || !product || manualCostDraft.activeMode !== "FBA") return null;
    if (product.manualFbaFee || manualCostDraft.feeTouched.FBA) return manualCostDraft.fbaEstimate || null;
    const weightKg = finiteOrNull(manualCostDraft.profitInputs?.actualWeightKg);
    const estimate = estimateWeightOnlyFbaFee({
          ...product,
          fulfillmentMode: "FBA",
          productWeight: weightKg,
          billingWeight: weightKg,
          salePrice: manualCostDraft.salePrice,
          manualProfitInputs: true,
          profitInputs: manualCostDraft.profitInputs,
          weightSource: manualCostDraft.profitInputs.weightSource || "商品重量",
        });
    manualCostDraft.fbaEstimate = estimate;
    manualCostDraft.fees.FBA = estimate ? valueOrBlank(estimate.fee) : "";
    const feeInput = byId("manualFulfillmentFee");
    if (feeInput) feeInput.value = feeInputValue(manualCostDraft.fees.FBA);
    updateManualCostModeUi();
    return estimate;
  }

  function captureManualCostDraft() {
    if (!manualCostDraft) return;
    manualCostDraft.purchaseCost = byId("manualPurchaseCost")?.value.trim() || "";
    manualCostDraft.pieceCount = byId("manualPieceCount")?.value.trim() || "";
    const displayedFee = byId("manualFulfillmentFee")?.value.trim() || "";
    if (manualCostDraft.feeTouched[manualCostDraft.activeMode]
      || displayedFee !== feeInputValue(manualCostDraft.fees[manualCostDraft.activeMode])) {
      manualCostDraft.fees[manualCostDraft.activeMode] = displayedFee;
    }
    const numberValue = (id) => numberOrNull(byId(id)?.value);
    manualCostDraft.amazon = {
      title: byId("manualAmazonTitle")?.value.trim() || "",
      currentPrice: byId("manualAmazonCurrentPrice")?.value.trim() || "",
      sales30: byId("manualAmazonSales30")?.value.trim() || "",
      sales60: byId("manualAmazonSales60")?.value.trim() || "",
      rating: byId("manualAmazonRating")?.value.trim() || "",
      reviews: byId("manualAmazonReviews")?.value.trim() || "",
      listingAvailableAt: byId("manualAmazonListingDate")?.value || "",
      firstFba: byId("manualAmazonFirstFba")?.value || "",
      hasAPlus: byId("manualAmazonHasAPlus")?.value || "",
    };
    const detectedPieceCount = extractTitlePieceCount(manualCostDraft.amazon.title);
    manualCostDraft.detectedPieceCount = detectedPieceCount.count;
    manualCostDraft.pieceCountEvidence = detectedPieceCount.evidence;
    if (!manualCostDraft.pieceCountTouched) {
      manualCostDraft.pieceCount = detectedPieceCount.count;
      if (byId("manualPieceCount")) byId("manualPieceCount").value = String(detectedPieceCount.count);
    }
    setText("manualPieceCountSource", manualCostDraft.pieceCountTouched
      ? detectedPieceCount.evidence
        ? `人工设置 · 标题识别 ${detectedPieceCount.count} 件（${detectedPieceCount.evidence}）`
        : "人工设置"
      : detectedPieceCount.evidence ? `Amazon 标题自动识别 · ${detectedPieceCount.evidence}` : "");
    const draftCurrentPrice = numberOrNull(manualCostDraft.amazon.currentPrice);
    const product = products.find(item => item.id === manualCostDraft.productId);
    manualCostDraft.salePrice = product?.manualSalePrice && finiteOrNull(product.currentPrice) === draftCurrentPrice
      ? product.salePrice
      : draftCurrentPrice !== null && draftCurrentPrice > 0
        ? roundMoney(draftCurrentPrice * COMPETITOR_PRICE_RATIO)
        : null;
    manualCostDraft.productDimensionsCm = [numberValue("manualProductLengthCm"), numberValue("manualProductWidthCm"), numberValue("manualProductHeightCm")];
    manualCostDraft.packageDimensionsCm = [numberValue("manualLengthCm"), numberValue("manualWidthCm"), numberValue("manualHeightCm")];
    manualCostDraft.profitInputs = {
      ...manualCostDraft.profitInputs,
      formulaVersion: PROFIT_FORMULA_VERSION,
      actualWeightKg: numberValue("manualActualWeightKg"),
      cartonWeightKg: numberValue("manualCartonWeightKg"),
      unitsPerCarton: numberValue("manualUnitsPerCarton"),
      airFreightRateCnyPerKg: numberValue("manualAirFreightRate"),
      commissionRate: numberValue("manualCommissionRate"),
      fxLossRate: numberValue("manualFxLossRate"),
      marketingRate: numberValue("manualMarketingRate"),
      managementRate: numberValue("manualManagementRate"),
      returnsRate: numberValue("manualReturnsRate"),
      purchaseTaxRate: numberValue("manualPurchaseTaxRate"),
      domesticFreightRateCnyPerKg: numberValue("manualDomesticFreightRate"),
    };
    const packageComplete = manualCostDraft.packageDimensionsCm.every((value) => value !== null && value > 0);
    const productComplete = manualCostDraft.productDimensionsCm.every((value) => value !== null && value > 0);
    manualCostDraft.profitInputs.dimensionsCm = packageComplete
      ? [...manualCostDraft.packageDimensionsCm]
      : productComplete ? [...manualCostDraft.productDimensionsCm] : null;
    const baselineInputs = manualCostDraft.baseline.profitInputsObject || {};
    const sameDimensions = JSON.stringify(manualCostDraft.profitInputs.dimensionsCm) === JSON.stringify(baselineInputs.dimensionsCm || null);
    manualCostDraft.profitInputs.dimensionSource = sameDimensions
      ? baselineInputs.dimensionSource || "参数缺失"
      : packageComplete ? "产品人工包装参数" : productComplete ? "产品人工商品参数回退" : "参数缺失";
    manualCostDraft.profitInputs.weightSource = manualCostDraft.profitInputs.actualWeightKg === baselineInputs.actualWeightKg
      ? baselineInputs.weightSource || "参数缺失"
      : manualCostDraft.profitInputs.actualWeightKg ? "产品人工覆盖" : "参数缺失";
    manualCostDraft.profitInputs.purchaseTaxRateSource = manualCostDraft.profitInputs.purchaseTaxRate === baselineInputs.purchaseTaxRate
      ? baselineInputs.purchaseTaxRateSource || "default_4_percent"
      : "product_manual";
    manualCostDraft.profitInputs.domesticFreightSource = manualCostDraft.profitInputs.domesticFreightRateCnyPerKg === baselineInputs.domesticFreightRateCnyPerKg
      ? baselineInputs.domesticFreightSource || "product_weight_rate_estimate"
      : "product_manual_weight_rate";
    manualCostDraft.profitInputs.airFreightRateSource = manualCostDraft.profitInputs.airFreightRateCnyPerKg === baselineInputs.airFreightRateCnyPerKg
      ? baselineInputs.airFreightRateSource || (manualCostDraft.profitInputs.airFreightActualWeightOnly ? "au_workbook_45_cny_per_kg" : "market_default_air_freight")
      : "product_manual";
  }

  function comparableManualNumber(value) {
    if (String(value ?? "").trim() === "") return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : `invalid:${value}`;
  }

  function isManualCostDirty() {
    if (!manualCostDraft) return false;
    captureManualCostDraft();
    const baseline = manualCostDraft.baseline;
    const product = products.find(item => item.id === manualCostDraft.productId);
    const pricing = resolvePurchasePriceInput(product, manualCostDraft.purchaseCost, baseline.purchaseUnitCostCny);
    return manualCostDraft.activeMode !== baseline.fulfillmentMode
      || pricing.invalid || pricing.manuallyEdited
      || comparableManualNumber(manualCostDraft.pieceCount) !== baseline.pieceCount
      || comparableManualNumber(manualCostDraft.fees.FBA) !== baseline.fbaFee
      || comparableManualNumber(manualCostDraft.fees.FBM) !== baseline.fbmFee
      || JSON.stringify(manualCostDraft.profitInputs) !== baseline.profitInputs
      || JSON.stringify({
        title: manualCostDraft.amazon.title,
        currentPrice: numberOrNull(manualCostDraft.amazon.currentPrice),
        sales30: numberOrNull(manualCostDraft.amazon.sales30),
        sales60: numberOrNull(manualCostDraft.amazon.sales60),
        rating: numberOrNull(manualCostDraft.amazon.rating),
        reviews: numberOrNull(manualCostDraft.amazon.reviews),
        listingAvailableAt: manualCostDraft.amazon.listingAvailableAt,
        firstFba: manualCostDraft.amazon.firstFba,
        hasAPlus: manualCostDraft.amazon.hasAPlus === "" ? null : manualCostDraft.amazon.hasAPlus === "true",
      }) !== baseline.amazon;
  }

  function closeManualCostDialog({ force = false, restoreFocus = true } = {}) {
    const dialog = byId("manualCostDialog");
    if (!dialog || dialog.hidden) return true;
    if (!force && isManualCostDirty() && !window.confirm("当前成本尚未保存，确定关闭吗？")) return false;
    dialog.hidden = true;
    document.body.classList.remove("manual-cost-open");
    manualCostDraft = null;
    if (restoreFocus && lastManualCostFocusedElement?.isConnected) lastManualCostFocusedElement.focus();
    lastManualCostFocusedElement = null;
    return true;
  }

  function syncManualCostReadOnlyState() {
    const product = products.find((item) => item.id === (manualCostDraft?.productId || activeProductId));
    const productBusy = isProductSupplierBusy(product) || isAnalysisReadOnly(product) || isCollectionWriteLocked();
    const openButton = byId("openManualCostButton");
    if (openButton) openButton.disabled = Boolean(productBusy);
    ["manualCostFbaMode", "manualCostFbmMode", "manualPurchaseCost", "manualPieceCount", "manualFulfillmentFee", "saveManualCostButton", "manualCostApproveButton"].forEach((id) => {
      const control = byId(id);
      if (control) control.disabled = Boolean(productBusy);
    });
    $$('[data-product-cost], [data-manual-amazon]').forEach((control) => { control.disabled = Boolean(productBusy); });
    const form = byId("manualCostForm");
    if (form) form.setAttribute("aria-busy", String(Boolean(productBusy)));
  }

  function setManualCostError(message = "") {
    const error = byId("manualCostError");
    if (!error) return;
    error.textContent = message;
    error.hidden = !message;
  }

  function resetManualCostProfitPreview() {
    setText("manualCostProfitMargin", "");
    setText("manualCostProfitValue", "");
    const preview = byId("manualCostProfitPreview");
    if (preview) {
      delete preview.dataset.tone;
      preview.hidden = true;
    }
    if (byId("manualProfitFormulaNote")) byId("manualProfitFormulaNote").hidden = true;
    const approveButton = byId("manualCostApproveButton");
    if (approveButton) {
      const product = products.find(item => item.id === manualCostDraft?.productId);
      const reason = preliminaryReviewBlockingReason(product, manualCostDraft?.profitInputs?.actualWeightKg, manualCostDraft?.activeMode);
      approveButton.disabled = !product || isCollectionWriteLocked() || isAnalysisReadOnly(product) || isProductSupplierBusy(product) || Boolean(reason);
      approveButton.title = reason || "保存并初审；完整利润可后续计算";
    }
  }

  function validateManualProfitInputs(profitInputs, product = null, mode = product?.fulfillmentMode) {
    const rawWeight = String(byId("manualActualWeightKg")?.value ?? "").trim();
    if (rawWeight && (numberOrNull(rawWeight) === null || numberOrNull(rawWeight) <= 0)) {
      return { id: "manualActualWeightKg", message: "实际重量必须是大于 0 的有效数字。" };
    }
    const percentageFields = [
      ["commissionRate", "manualCommissionRate", "Amazon 佣金"],
      ["fxLossRate", "manualFxLossRate", "汇率折损"],
      ["marketingRate", "manualMarketingRate", "营销费"],
      ["managementRate", "manualManagementRate", "管理费"],
      ["returnsRate", "manualReturnsRate", "退货预留"],
      ["purchaseTaxRate", "manualPurchaseTaxRate", "采购税费预留"],
    ];
    for (const [key, id, label] of percentageFields) {
      const value = profitInputs?.[key];
      if (!Number.isFinite(value) || value < 0 || value > 100) {
        return { id, message: `${label}必须是 0-100% 的有效数字。` };
      }
    }
    const weightAssumption = applyMissingWeightProfitAssumption({ ...profitInputs, fulfillmentMode: mode }, product?.marketplace || activeMarket.code, product);
    const missingMass = profitInputs?.actualWeightKg == null || profitInputs.actualWeightKg === "";
    if (!(missingMass && normalizeFulfillmentMode(mode) === "FBA") && !weightAssumption.weightAssumption
      && !weightAssumption.dimensionalWeightEstimateKg && (!Number.isFinite(profitInputs?.actualWeightKg) || profitInputs.actualWeightKg <= 0)) {
      return { id: "manualActualWeightKg", message: "请填写有效实际重量；缺少计算依据时可保存草稿，利润保持待计算。" };
    }
    if (!Number.isFinite(profitInputs?.airFreightRateCnyPerKg) || profitInputs.airFreightRateCnyPerKg < 0) {
      return { id: "manualAirFreightRate", message: "空运单价必须是大于或等于 0 的有效数字。" };
    }
    if (!Number.isFinite(profitInputs?.domesticFreightRateCnyPerKg)
      || profitInputs.domesticFreightRateCnyPerKg < DOMESTIC_FREIGHT_RATE_RANGE_CNY_PER_KG.min
      || profitInputs.domesticFreightRateCnyPerKg > DOMESTIC_FREIGHT_RATE_RANGE_CNY_PER_KG.max) {
      return {
        id: "manualDomesticFreightRate",
        message: `国内运费单价必须在 ¥${DOMESTIC_FREIGHT_RATE_RANGE_CNY_PER_KG.min}-${DOMESTIC_FREIGHT_RATE_RANGE_CNY_PER_KG.max}/kg 之间。`,
      };
    }
    return null;
  }

  function renderManualCostPreview() {
    if (!manualCostDraft) return;
    captureManualCostDraft();
    const product = products.find((item) => item.id === manualCostDraft.productId);
    if (!product) return;
    const setManualSummary = (id, content, { html = false } = {}) => {
      const output = byId(id);
      if (!output) return;
      if (html) output.innerHTML = content || "";
      else output.textContent = content || "";
      const row = output.closest("div");
      if (row) row.hidden = !content;
    };
    syncManualDraftAutomaticFbaFee(product);
    const mode = manualCostDraft.activeMode;
    const purchaseRaw = manualCostDraft.purchaseCost;
    const pieceCount = normalizePieceCount(manualCostDraft.pieceCount);
    const feeRaw = manualCostDraft.fees[mode];
    const purchasePricing = resolvePurchasePriceInput(product, purchaseRaw, manualCostDraft.baseline.purchaseUnitCostCny);
    const purchaseUnitCostCny = purchasePricing.unitCostCny;
    setText("manualPurchaseCostSource", purchasePriceInputNote(product, purchasePricing));
    const purchaseCost = totalPurchaseCostCny(purchaseUnitCostCny, pieceCount);
    const fulfillmentFee = numberOrNull(feeRaw);
    const draftCurrentPrice = numberOrNull(manualCostDraft.amazon.currentPrice);
    const salePrice = manualCostDraft.salePrice;
    if (byId("manualCostSalePrice")) byId("manualCostSalePrice").value = valueOrBlank(salePrice);
    setCurrencyConversionOutput("manualAmazonCurrentPriceCny", draftCurrentPrice, product.marketplace);
    setCurrencyConversionOutput("manualCostSalePriceCny", salePrice, product.marketplace);
    setCurrencyConversionOutput("manualFulfillmentFeeCny", fulfillmentFee, product.marketplace);
    if (byId("manualPurchaseTotal")) byId("manualPurchaseTotal").value = valueOrBlank(purchaseCost);
    ["manualVolumetricWeightKg", "manualChargeableWeightKg", "manualAirFreightCny", "manualPurchaseTaxCny", "manualDomesticFreightCny"].forEach((id) => setManualSummary(id, ""));
    resetManualCostProfitPreview();
    if (purchaseUnitCostCny === null || pieceCount === null || feeRaw === "") {
      setManualCostError(`填写1688单件采购价、标题件数和 ${mode} ${mode === "FBA" ? "配送费" : "履约费"}后立即显示利润。`);
      return;
    }
    if (draftCurrentPrice === null || draftCurrentPrice <= 0) {
      setManualCostError("补填有效的竞品当前售价后，我们的售价将与竞品当前售价相同，并自动计算利润。");
      return;
    }
    if (purchaseUnitCostCny === null || purchaseUnitCostCny < 0 || purchaseCost === null || fulfillmentFee === null || fulfillmentFee < 0) {
      setManualCostError("1688单件采购价、标题件数和履约费必须是有效数字。");
      return;
    }
    const inputError = validateManualProfitInputs(manualCostDraft.profitInputs, product, mode);
    if (inputError) {
      setManualCostError(inputError.message);
      return;
    }
    const calculation = calculateProfit({
      salePrice,
      purchaseCost,
      fulfillmentMode: mode,
      fbaFee: mode === "FBA" ? fulfillmentFee : finiteOrNull(manualCostDraft.fees.FBA),
      fbmFee: mode === "FBM" ? fulfillmentFee : finiteOrNull(manualCostDraft.fees.FBM),
      billingWeight: manualCostDraft.profitInputs.actualWeightKg,
      actualWeightKg: manualCostDraft.profitInputs.actualWeightKg,
      dimensionsCm: manualCostDraft.profitInputs.dimensionsCm,
      cartonWeightKg: manualCostDraft.profitInputs.cartonWeightKg,
      unitsPerCarton: manualCostDraft.profitInputs.unitsPerCarton,
      resolvedProfitInputs: manualCostDraft.profitInputs,
      marketplace: product.marketplace,
    }, product);
    setManualSummary("manualVolumetricWeightKg", Number.isFinite(calculation?.airFreight?.volumetricWeightKg) ? `${formatNumber(calculation.airFreight.volumetricWeightKg)} kg` : "");
    setManualSummary("manualChargeableWeightKg", Number.isFinite(calculation?.airFreight?.chargeableWeightKg) ? `${formatNumber(calculation.airFreight.chargeableWeightKg)} kg` : "");
    setManualSummary("manualAirFreightCny", calculation ? cnyCurrencyPairHtml(calculation.airFreight.airFreightCny, product.marketplace, { compact: true }) : "", { html: true });
    setManualSummary("manualPurchaseTaxCny", calculation ? cnyCurrencyPairHtml(calculation.purchaseTaxCny, product.marketplace, { compact: true }) : "", { html: true });
    setManualSummary("manualDomesticFreightCny", calculation ? cnyCurrencyPairHtml(calculation.domesticFreightCny, product.marketplace, { compact: true }) : "", { html: true });
    if (!calculation) {
      const reason = !Number.isFinite(salePrice) || salePrice <= 0
        ? "销售价格缺失，暂时无法预览利润；成本仍可保存。"
        : !Number.isFinite(manualCostDraft.profitInputs.actualWeightKg) || manualCostDraft.profitInputs.actualWeightKg <= 0
          ? "重量缺失：FBA 可按最低档暂估；请补齐其他利润参数。"
          : "当前利润参数不完整，暂时无法预览。";
      setManualCostError(reason);
      return;
    }
    setManualCostError();
    setText("manualCostProfitMargin", `${formatPercent(calculation.margin)}${calculation.weightAssumption ? " · 最低档暂估" : ""}`);
    const profitValue = byId("manualCostProfitValue");
    const salePriceCny = convertCurrencyToCny(calculation.salePrice, product.marketplace);
    const totalCostCny = convertCurrencyToCny(calculation.totalCost, product.marketplace);
    const profitCny = convertCurrencyToCny(calculation.profit, product.marketplace);
    if (profitValue) profitValue.innerHTML = cnyCurrencyPairHtml(profitCny, product.marketplace, { suffix: " / 件", compact: true });
    const formulaNote = byId("manualProfitFormulaNote");
    if (formulaNote) {
      formulaNote.hidden = false;
      formulaNote.textContent = `经营利润率 =（${formatCny(salePriceCny)} - ${formatCny(totalCostCny)}）÷ ${formatCny(salePriceCny)} × 100% = ${formatPercent(calculation.margin)}`;
    }
    const preview = byId("manualCostProfitPreview");
    if (preview) {
      preview.hidden = false;
      preview.dataset.tone = calculation.margin < 0 ? "danger" : calculation.margin < 15 ? "warning" : "strong";
    }
    const approveButton = byId("manualCostApproveButton");
    if (approveButton) {
      const reason = preliminaryReviewBlockingReason(product, manualCostDraft.profitInputs.actualWeightKg, manualCostDraft.activeMode);
      approveButton.disabled = isProductSupplierBusy(product) || Boolean(reason);
      approveButton.title = reason || "保存当前成本并初审通过";
    }
    const confidence = byId("manualCostConfidenceNote");
    if (confidence) {
      const productWeightFormula = calculation.airFreight.source === "product_weight";
      const fallback = !productWeightFormula && calculation.airFreight.source !== "carton";
      confidence.dataset.confidence = calculation.weightAssumption || fallback ? "low" : "standard";
      const title = confidence.querySelector("strong");
      const description = confidence.querySelector("span");
      if (title) title.textContent = calculation.weightAssumption ? "最低档暂估 · 实际重量待核验" : productWeightFormula ? "澳洲表格公式" : fallback ? "低置信度" : "外箱公式已启用";
      if (description) description.textContent = calculation.weightAssumption
        ? `实际重量未知；国内运费按最低信封档假设重量 ${formatNumber(calculation.assumedWeightKg * 1_000)}g 暂估，头程计费重 ${formatNumber(calculation.airFreight.chargeableWeightKg)}kg（${calculation.airFreight.source === "carton" ? "外箱重量 ÷ 装箱数" : calculation.airFreight.source === "minimum_envelope_assumption" ? "最低档假设" : "假设重量与体积重取高"}）。取得真实 Item Weight 后自动重算。`
        : productWeightFormula
        ? `商品重量 ${formatNumber(calculation.airFreight.actualWeightKg * 1_000)}g × ${formatCny(calculation.airFreight.airFreightRateCnyPerGram)}/g；再按汇率换算为 AUD。`
        : fallback
          ? "当前按 SellerSprite 单件实际重与体积重取高值估算。"
          : "单件头程 = 外箱重量 × 空运单价 ÷ 装箱数；利润仅影响当前商品。";
    }
  }

  function parseOptionalManualFee(value, label) {
    if (String(value ?? "").trim() === "") return { value: null };
    const number = numberOrNull(value);
    if (number === null || number < 0) return { error: `${label}必须是大于或等于 0 的有效数字。` };
    return { value: roundMoney(number) };
  }

  function getApprovalFeedback(product, { costSaved = false } = {}) {
    const prefix = costSaved ? `${product.asin} 已保存成本并初审通过` : `${product.asin} 已初审通过`;
    if (product.dataMode === "mock" || runState.mode === "mock") {
      return {
        message: `${prefix}；模拟数据仅用于演示，不会进入运营表。`,
        type: "info",
      };
    }
    if (product.profitCalculation?.dimensionalWeightEstimateKg) return { message: `${prefix}；实重未知，当前按体积重估算利润，取得实重后重新比较 FBA 费用。`, type: "info" };
    if (product.profitCalculation?.weightAssumption || (product.fbaEstimate?.assumption === "missing_weight_minimum_fba_estimate" && !product.manualFbaFee)) return { message: `${prefix}；实际重量${isAmazonWeightUnavailable(product) ? "页面未提供" : "待核验"}，利润按最低档估算；真实重量保持未知，取得 Item Weight 后自动重算。`, type: "info" };
    if (!product.profitCalculation || product.profitCalculation.purchaseCostAssumedZero) return { message: `${prefix}；利润参数可后续补充，当前尚无完整利润。`, type: "info" };
    if (isLowConfidenceSupplierEstimate(product)) {
      return {
        message: `${prefix}；当前利润来自图片相似度最高 6 家真实报价的低置信度估算，其中可能包含低相似商品，运营导出前请复核。`,
        type: "info",
      };
    }
    if (product.complete) {
      return {
        message: `${prefix}，可进入运营导出表。`,
        type: "success",
      };
    }
    return {
      message: `${prefix}；未采集信息将在导出表中说明。`,
      type: "info",
    };
  }

  function saveManualCost({ approve = false, allowIncomplete = approve } = {}) {
    if (collectionWriteBlocked()) return;
    if (!manualCostDraft) return;
    captureManualCostDraft();
    const product = products.find((item) => item.id === manualCostDraft.productId);
    if (isAnalysisReadOnly(product)) { setManualCostError("该商品的初筛资料已交接，请在采购端核实和修改详细成本。"); return; }
    if (!product) {
      setManualCostError("当前商品已不存在，请关闭窗口后重新打开。");
      return;
    }
    syncManualDraftAutomaticFbaFee(product);
    if (isProductSupplierBusy(product)) {
      setManualCostError("这个商品正在匹配 1688，完成后即可保存。其他商品仍可补填。");
      return;
    }
    const amazon = manualCostDraft.amazon;
    const currentPrice = numberOrNull(amazon.currentPrice);
    if ((!allowIncomplete || String(amazon.currentPrice).trim()) && (currentPrice === null || currentPrice <= 0)) {
      setManualCostError("竞品当前售价必须是大于 0 的有效数字；我们的售价会自动与其保持一致。");
      byId("manualAmazonCurrentPrice")?.focus();
      return;
    }
    const optionalAmazonNumbers = [
      ["manualAmazonSales30", amazon.sales30, "竞品 30 天销量", null],
      ["manualAmazonSales60", amazon.sales60, "竞品 60 天销量", null],
      ["manualAmazonRating", amazon.rating, "评价星级", 5],
      ["manualAmazonReviews", amazon.reviews, "评价数量", null],
    ];
    for (const [id, raw, label, maximum] of optionalAmazonNumbers) {
      if (String(raw).trim() === "") continue;
      const value = numberOrNull(raw);
      if (value === null || value < 0 || (maximum !== null && value > maximum)) {
        setManualCostError(`${label}不是有效数字${maximum !== null ? `，允许范围为 0-${maximum}` : ""}。`);
        byId(id)?.focus();
        return;
      }
    }
    const purchasePricing = resolvePurchasePriceInput(product, manualCostDraft.purchaseCost, manualCostDraft.baseline.purchaseUnitCostCny);
    const purchaseUnitCostCny = purchasePricing.unitCostCny;
    const pieceCount = normalizePieceCount(manualCostDraft.pieceCount);
    const purchaseCost = totalPurchaseCostCny(purchaseUnitCostCny, pieceCount);
    const activeFee = numberOrNull(manualCostDraft.fees[manualCostDraft.activeMode]);
    if (purchasePricing.invalid || (!allowIncomplete && purchaseUnitCostCny === null)) {
      setManualCostError("1688单件采购价不能为空，且必须是大于或等于 0 的有效数字。");
      byId("manualPurchaseCost")?.focus();
      return;
    }
    if (pieceCount === null) {
      setManualCostError("Amazon标题件数必须是 1-10000 的整数。");
      byId("manualPieceCount")?.focus();
      return;
    }
    if ((!allowIncomplete || manualCostDraft.fees[manualCostDraft.activeMode] !== "") && (manualCostDraft.fees[manualCostDraft.activeMode] === "" || activeFee === null || activeFee < 0)) {
      setManualCostError(`${manualCostDraft.activeMode} ${manualCostDraft.activeMode === "FBA" ? "配送费" : "履约费"}不能为空，且必须是大于或等于 0 的有效数字。`);
      byId("manualFulfillmentFee")?.focus();
      return;
    }
    const parsedFba = parseOptionalManualFee(manualCostDraft.fees.FBA, "FBA 配送费");
    const parsedFbm = parseOptionalManualFee(manualCostDraft.fees.FBM, "FBM 履约费");
    if (parsedFba.error || parsedFbm.error) {
      setManualCostError(parsedFba.error || parsedFbm.error);
      return;
    }
    const resolvedInputs = manualCostDraft.profitInputs;
    const inputError = validateManualProfitInputs(resolvedInputs, product, manualCostDraft.activeMode);
    if (inputError) {
      setManualCostError(inputError.message);
      byId(inputError.id)?.focus();
      return;
    }
    if (!Number.isFinite(resolvedInputs.airFreightRateCnyPerKg) || resolvedInputs.airFreightRateCnyPerKg < 0) {
      setManualCostError("空运单价必须是大于或等于 0 的有效数字。");
      byId("manualAirFreightRate")?.focus();
      return;
    }
    if (!Number.isFinite(resolvedInputs.purchaseTaxRate) || resolvedInputs.purchaseTaxRate < 0 || resolvedInputs.purchaseTaxRate > 100) {
      setManualCostError("采购税费预留必须是 0-100% 的有效数字。");
      byId("manualPurchaseTaxRate")?.focus();
      return;
    }
    if (!Number.isFinite(resolvedInputs.domesticFreightRateCnyPerKg)
      || resolvedInputs.domesticFreightRateCnyPerKg < DOMESTIC_FREIGHT_RATE_RANGE_CNY_PER_KG.min
      || resolvedInputs.domesticFreightRateCnyPerKg > DOMESTIC_FREIGHT_RATE_RANGE_CNY_PER_KG.max) {
      setManualCostError(`国内运费单价必须在 ¥${DOMESTIC_FREIGHT_RATE_RANGE_CNY_PER_KG.min}-${DOMESTIC_FREIGHT_RATE_RANGE_CNY_PER_KG.max}/kg 之间。`);
      byId("manualDomesticFreightRate")?.focus();
      return;
    }
    if (resolvedInputs.unitsPerCarton !== null && resolvedInputs.unitsPerCarton <= 0) {
      setManualCostError("装箱数必须大于 0，或留空使用单件包装回退。");
      byId("manualUnitsPerCarton")?.focus();
      return;
    }
    const currentPriceChanged = finiteOrNull(product.currentPrice) !== currentPrice;
    const nextSalePrice = product.manualSalePrice && !currentPriceChanged ? product.salePrice : currentPrice === null ? null : roundMoney(currentPrice * COMPETITOR_PRICE_RATIO);
    const automaticFbaEstimate = estimateWeightOnlyFbaFee({
      ...product,
      fulfillmentMode: "FBA",
      productWeight: resolvedInputs.actualWeightKg,
      billingWeight: resolvedInputs.actualWeightKg,
      salePrice: nextSalePrice,
      manualProfitInputs: true,
      profitInputs: resolvedInputs,
      weightSource: resolvedInputs.weightSource || "商品重量",
    });
    const manualFbaOverride = Boolean(product.manualFbaFee || manualCostDraft.feeTouched.FBA)
      && Number.isFinite(parsedFba.value);
    const next = {
      salePrice: nextSalePrice,
      fulfillmentMode: manualCostDraft.activeMode,
      purchaseUnitCostCny,
      pieceCount,
      purchaseCost: totalPurchaseCostCny(purchaseUnitCostCny, pieceCount),
      fbaFee: manualFbaOverride ? parsedFba.value : automaticFbaEstimate?.fee ?? parsedFba.value,
      fbmFee: parsedFbm.value,
      profitInputs: { ...resolvedInputs, updatedAt: new Date().toISOString() },
    };
    const sales30Changed = finiteOrNull(product.sales30) !== numberOrNull(amazon.sales30);
    if (approve) {
      const reviewProduct = sales30Changed ? { ...product, sales30Evidence: null, amazonSales30Evidence: null } : product;
      const reason = preliminaryReviewBlockingReason(reviewProduct, resolvedInputs.actualWeightKg, manualCostDraft.activeMode);
      if (reason) { setManualCostError(reason); return; }
    }
    const baseline = manualCostDraft.baseline;
    const changed = (before, after) => before !== after;
    const purchaseUnitCostChanged = purchasePricing.manuallyEdited;
    const decisionInputsChanged = changed(baseline.fulfillmentMode, next.fulfillmentMode)
      || changed(finiteOrNull(product.salePrice), next.salePrice)
      || changed(baseline.purchaseUnitCostCny, next.purchaseUnitCostCny)
      || baseline.pieceCount !== next.pieceCount
      || changed(baseline.purchaseCost, next.purchaseCost)
      || changed(baseline.fbaFee, next.fbaFee)
      || changed(baseline.fbmFee, next.fbmFee)
      || baseline.profitInputs !== JSON.stringify(resolvedInputs)
      || baseline.amazon !== JSON.stringify({
        title: amazon.title,
        currentPrice,
        sales30: numberOrNull(amazon.sales30),
        sales60: numberOrNull(amazon.sales60),
        rating: numberOrNull(amazon.rating),
        reviews: numberOrNull(amazon.reviews),
        listingAvailableAt: amazon.listingAvailableAt,
        firstFba: amazon.firstFba,
        hasAPlus: amazon.hasAPlus === "" ? null : amazon.hasAPlus === "true",
      });
    const approvalInvalidated = product.reviewStatus === "approved" && decisionInputsChanged;
    product.name = amazon.title || product.name || `Amazon 商品 ${product.asin}`;
    if (amazon.title) product.englishName = amazon.title;
    const detectedPieceCount = extractTitlePieceCount(product.englishName || product.name || "");
    product.detectedPieceCount = detectedPieceCount.count;
    product.pieceCountEvidence = detectedPieceCount.evidence;
    product.pieceCountRuleVersion = TITLE_PIECE_COUNT_RULE_VERSION;
    product.pieceCount = next.pieceCount;
    product.pieceCountSource = manualCostDraft.pieceCountTouched ? "manual" : detectedPieceCount.source;
    product.currentPrice = currentPrice;
    if (currentPriceChanged && currentPrice !== null) {
      product.currentPriceStatus = "manual";
      product.priceEvidence = null;
      if (product.priceRevalidation) product.priceRevalidation.status = "manual";
    }
    if (sales30Changed && product.sales30Evidence) {
      product.sales30EvidenceHistory = [...(product.sales30EvidenceHistory || []), { ...structuredClone(product.sales30Evidence), supersededAt: new Date().toISOString(), reason: "manual_sales_override" }];
      product.sales30Evidence = null;
    }
    product.sales30 = numberOrNull(amazon.sales30);
    product.sales60 = numberOrNull(amazon.sales60);
    product.rating = numberOrNull(amazon.rating);
    product.reviews = numberOrNull(amazon.reviews);
    product.listingAvailableAt = amazon.listingAvailableAt || null;
    product.firstFba = amazon.firstFba || null;
    product.hasAPlus = amazon.hasAPlus === "" ? null : amazon.hasAPlus === "true";
    product.salePrice = next.salePrice;
    if (currentPriceChanged) product.manualSalePrice = false;
    product.manualAmazonOverride = true;
    product.manualAmazonFields = {
      title: Boolean(amazon.title),
      currentPrice: product.manualAmazonFields?.currentPrice || (currentPriceChanged && currentPrice !== null),
      sales30: product.manualAmazonFields?.sales30 || sales30Changed,
      sales60: String(amazon.sales60).trim() !== "",
      rating: String(amazon.rating).trim() !== "",
      reviews: String(amazon.reviews).trim() !== "",
      listingAvailableAt: Boolean(amazon.listingAvailableAt),
      firstFba: Boolean(amazon.firstFba),
      hasAPlus: amazon.hasAPlus !== "",
    };
    product.fieldSources = { ...(product.fieldSources || {}) };
    Object.entries(product.manualAmazonFields).forEach(([field, manuallySet]) => {
      if (manuallySet) product.fieldSources[field] = "manual";
    });
    product.fulfillmentMode = next.fulfillmentMode;
    if (manualCostDraft.fulfillmentModeTouched) {
      product.fulfillmentModeSource = "manual";
    } else if (!product.fulfillmentModeSource && next.fulfillmentMode === "FBA") {
      product.fulfillmentModeSource = "assumed_fba_for_estimate";
    }
    product.purchaseUnitCostCny = next.purchaseUnitCostCny;
    product.purchaseCost = next.purchaseCost;
    product.fbaFee = next.fbaFee;
    product.fbmFee = next.fbmFee;
    product.profitInputs = next.profitInputs;
    product.billingWeight = next.profitInputs.actualWeightKg;
    product.weightSource = next.profitInputs.weightSource;
    product.manualProfitInputs = true;
    product.manualPurchaseCost = Boolean(isManualCostProduct(product) || purchaseUnitCostChanged);
    if (manualCostDraft.productDimensionsCm.every((value) => Number.isFinite(value) && value > 0)) {
      product.productDimensions = formatDimensions(manualCostDraft.productDimensionsCm);
    }
    if (manualCostDraft.packageDimensionsCm.every((value) => Number.isFinite(value) && value > 0)) {
      product.fbaDimensions = formatDimensions(manualCostDraft.packageDimensionsCm);
    }
    product.fbaEstimate = automaticFbaEstimate;
    product.manualFbaFee = manualFbaOverride;
    if (product.manualFbaFee) {
      product.fbaFeeSource = "manual";
      product.fieldSources.fbaFee = "manual";
    } else if (automaticFbaEstimate) {
      product.fbaFee = automaticFbaEstimate.fee;
      product.fbaFeeSource = automaticFbaFeeSource(product);
      product.fieldSources.fbaFee = automaticFbaFeeSource(product);
    } else {
      product.fbaFeeSource = null;
      delete product.fieldSources.fbaFee;
    }
    if (next.fulfillmentMode === "FBM" || changed(baseline.fbmFee, next.fbmFee)) product.manualFbmFee = Number.isFinite(next.fbmFee);
    if (isManualCostProduct(product)) {
      if (!product.supplierSource) product.supplierSource = product.dataMode === "mock" ? "manual-demo-cost" : "manual-product-cost";
      product.costSource = "manual";
    }
    refreshSupplierTarget(product);
    rebuildProductMissing(product);
    updateProductComputed(product);
    if (approvalInvalidated) product.reviewStatus = "pending";
    if (approve) product.reviewStatus = "approved";
    if (product.dataMode !== "mock") {
      runState.mode = "mixed";
      runState.dataSource = "SellerSprite MCP + 人工 Amazon 数据、采购成本与利润参数";
      setDataMode("mixed", "混合估算");
    }
    renderResults();
    populateDrawer(product);
    setDrawerTab("profit");
    updateHistorySummary();
    void persistCurrentRun();
    closeManualCostDialog({ force: true });
    if (approve) {
      const feedback = getApprovalFeedback(product, { costSaved: true });
      showToast(feedback.message, feedback.type, 5600);
    } else {
      showToast(
        approvalInvalidated
          ? "成本已保存并实时重算，原初审通过状态已撤回。"
          : `${next.fulfillmentMode} 成本已保存，利润结果已重新计算。`,
        approvalInvalidated ? "info" : "success",
        4400,
      );
    }
  }

  function openDrawer(productId) {
    const product = products.find((item) => item.id === productId);
    if (!product) return;
    const transitionId = ++drawerTransitionId;
    clearProfitAutoCommit();
    lastFocusedElement = document.activeElement;
    const resultRows = $$("#productTableBody tr[data-product-id]");
    const scrollContainer = $(".view-stack");
    drawerReturnPosition = {
      rowIndex: resultRows.findIndex((row) => row.dataset.productId === productId),
      scrollTop: scrollContainer?.scrollTop ?? 0,
      scrollLeft: scrollContainer?.scrollLeft ?? 0,
    };
    activeProductId = productId;
    drawerFbaTouched = false;
    drawerPurchaseInput = "unit";
    drawerProfitSaveVersion += 1;
    drawerProfitDraft = null;
    drawerProfitBaseline = null;
    setProfitEditorStatus("修改后自动保存，也可点击保存修改。");
    populateDrawer(product);
    setDrawerTab("amazon");
    const backdrop = byId("drawerBackdrop");
    backdrop.hidden = false;
    requestAnimationFrame(() => {
      if (transitionId === drawerTransitionId) backdrop.classList.add("is-open");
    });
    document.body.classList.add("drawer-open");
    byId("closeDrawerButton")?.focus({ preventScroll: true });
  }

  function closeDrawer() {
    const backdrop = byId("drawerBackdrop");
    if (!backdrop || backdrop.hidden) return;
    const transitionId = ++drawerTransitionId;
    const closingProductId = activeProductId;
    const returnPosition = drawerReturnPosition;
    const returnElement = lastFocusedElement;
    flushProfitAutoCommit();
    drawerProfitDraft = null;
    drawerProfitSaveVersion += 1;
    backdrop.classList.remove("is-open");
    document.body.classList.remove("drawer-open");
    setTimeout(() => {
      if (transitionId !== drawerTransitionId || activeProductId !== closingProductId) return;
      backdrop.hidden = true;
      activeProductId = null;
      // Approving and editing replace the table DOM; resolve the current row again.
      const rows = $$("#productTableBody tr[data-product-id]");
      const row = rows.find((item) => item.dataset.productId === closingProductId)
        || rows[Math.min(Math.max(0, returnPosition?.rowIndex ?? 0), rows.length - 1)];
      const focusTarget = row || (returnElement?.isConnected ? returnElement : byId("exportButton"));
      const scrollContainer = $(".view-stack");
      if (scrollContainer && returnPosition) {
        scrollContainer.scrollTop = returnPosition.scrollTop;
        scrollContainer.scrollLeft = returnPosition.scrollLeft;
      }
      focusTarget?.focus({ preventScroll: true });
      drawerReturnPosition = null;
    }, 180);
  }

  function setDrawerTab(tabName) {
    $$("[data-detail-tab]").forEach((button) => {
      const active = button.dataset.detailTab === tabName;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-selected", String(active));
      button.tabIndex = active ? 0 : -1;
    });
    $$("[data-detail-panel]").forEach((panel) => {
      const active = panel.dataset.detailPanel === tabName;
      panel.classList.toggle("is-active", active);
      panel.setAttribute("aria-hidden", String(!active));
    });
    const content = $(".drawer-content");
    if (content) content.scrollTop = 0;
  }

  function renderProductInformation(product) {
    const target = byId("amazonProductInformation");
    if (!target) return;
    const info = product.productInformation;
    const asin = String(product.sourceAsin || product.asin || "").trim().toUpperCase();
    const matches = info?.version === 1 && info.asin === asin;
    const sections = matches && Array.isArray(info.sections) ? info.sections : [];
    const count = sections.reduce((sum, section) => sum + (Array.isArray(section.rows) ? section.rows.length : 0), 0);
    target.hidden = product.analysisSourceMode !== "amazon_only" && !matches;
    const state = matches && info.status === "complete" ? `已完整读取 ${count} 项` : count ? `已读取 ${count} 项，信息区尚未完整` : "尚未完整读取，不能确认页面是否缺少重量";
    target.innerHTML = `<summary>Product information · ${escapeHtml(state)}</summary>` + sections.map(section =>
      `<h4>${escapeHtml(section.heading || "商品信息")}</h4><dl class="metric-list">${(section.rows || []).map(row =>
        `<div><dt>${escapeHtml(row.label)}</dt><dd>${escapeHtml(row.value)}</dd></div>`).join("")}</dl>`).join("");
  }

  function populateDrawer(product) {
    ensureFulfillmentState(product);
    const purchasePricing = ensureProductPurchasePricing(product);
    const market = MARKET_CONFIGS[String(product.marketplace || activeMarket.code).toUpperCase()] || activeMarket;
    const isAu = market.code === "AU";
    const sourceAsin = product.sourceAsin || product.asin || "";
    byId("drawerAsin").textContent = sourceAsin ? `源 ASIN ${sourceAsin}` : "";
    byId("drawerProductName").textContent = product.name || "";
    const sourceStoreCount = Math.max(1, product.sourceStores?.length || 0);
    const storeIdentity = [visibleStoreName(product.storeName), product.sellerId].filter(Boolean).join(" · ");
    byId("drawerStore").textContent = `${storeIdentity}${storeIdentity && sourceStoreCount > 1 ? ` · 共 ${sourceStoreCount} 个来源店铺` : ""}`;
    const visual = byId("drawerVisual");
    const amazonImageUrl = safeAmazonImageUrl(product.imageUrl);
    visual.className = `product-visual large ${product.visualTone}${amazonImageUrl ? " has-product-image" : ""}`;
    visual.innerHTML = amazonImageUrl
      ? `<img src="${escapeHtml(amazonImageUrl)}" alt="Amazon 商品主图" referrerpolicy="no-referrer" />`
      : `<i data-lucide="${product.visualIcon}" aria-hidden="true"></i><span>${String(product.id).slice(-2)}</span>`;
    byId("drawerFlags").innerHTML = [
      product.complete ? '<span class="flag-chip is-success">数据完整</span>' : "",
      product.parameterSource && !/(?:缺失|未获取)/.test(product.parameterSource) ? `<span class="flag-chip is-muted">${escapeHtml(product.parameterSource)}</span>` : "",
      product.risk ? `<span class="flag-chip ${product.risk === "低风险" ? "is-success" : "is-warning"}">${escapeHtml(product.risk)}</span>` : "",
      normalizeFulfillmentMode(product.fulfillmentMode) ? `<span class="flag-chip is-warning">${escapeHtml(fulfillmentPolicyShortLabel(product))}</span>` : "",
      ...(isLowConfidenceSupplierEstimate(product) ? ['<span class="flag-chip is-warning">1688 低匹配度估算</span>'] : []),
    ].filter(Boolean).join("");

    const isFbm = product.fulfillmentMode === "FBM";
    const isFba = product.fulfillmentMode === "FBA";
    const moneyMetric = (value, note = "") => Number.isFinite(value) ? ({ type: "currency", value, note }) : null;
    const cnyMoneyMetric = (value, note = "") => Number.isFinite(value) ? ({ type: "cny-currency", value, note }) : null;
    const amazonOnly = product.analysisSourceMode === "amazon_only";
    const auditedMissing = (field) => {
      const status = product.collectionQuality?.fields?.[field]?.status;
      return status === "unavailable" ? "页面未提供" : status === "invalid" ? "返回值异常，待核验" : "尚未采集或核验";
    };
    const fbaFeeMetric = isFba && Number.isFinite(product.fbaFee)
      ? moneyMetric(product.fbaFee, fulfillmentFeeSource(product))
      : null;
    const fulfillmentMetrics = isFbm ? [
      ["履约方式", "FBM · 卖家配送"],
      ["履约方式来源", fulfillmentModeSourceLabel(product)],
      ["FBM 履约费", moneyMetric(product.fbmFee, "人工输入")],
    ] : isFba ? [
      ["履约方式", isAssumedFba(product) ? "FBA 假设" : "FBA · 亚马逊配送"],
      ["履约方式来源", fulfillmentModeSourceLabel(product)],
    ] : [];
    const ratingAndReviews = [
      Number.isFinite(product.rating) ? `${product.rating.toFixed(1)} 星` : amazonOnly ? `评分：${auditedMissing("rating")}` : "",
      Number.isFinite(product.reviews) ? `${formatInteger(product.reviews)} 条评价` : amazonOnly ? `评论数：${auditedMissing("reviews")}` : "",
    ].filter(Boolean).join(" / ");
    const detailSucceeded = !sellerSpriteDetailFailureLabel(product)
      && (product.detailStatus === "success" || product.manualAmazonOverride || Number.isFinite(product.currentPrice));
    const parameterSource = product.parameterSource && !/(?:缺失|未获取)/.test(product.parameterSource)
      ? product.parameterSource
      : null;
    const displayedProductWeight = usesItemWeightOnly(product) ? productWeightKgForDisplay(product) : finiteOrNull(product.productWeight);
    const metrics = [
      ["源 ASIN", sourceAsin || null],
      ["父 ASIN", product.parentAsin || null],
      [product.analysisSourceMode === "amazon_only" ? "Amazon 官网详情" : "SellerSprite 详情", detailSucceeded ? (product.manualAmazonOverride ? "成功 · 含人工覆盖" : "成功") : null],
      ["Amazon 采集说明", amazonOnly ? amazonProductCollectionNote(product)?.text || null : null],
      ["Amazon 失败代码", amazonOnly ? amazonProductCollectionNote(product)?.code || null : null],
      ["SellerSprite 查竞品", !amazonOnly && product.competitorLookupStatus === "success" ? "成功" : null],
      ["竞品当前售价", moneyMetric(product.currentPrice)],
      ["售价核验状态", amazonPriceStatusLabel(product) || null],
      ["我们的售价", moneyMetric(product.salePrice, product.manualSalePrice ? "人工覆盖" : "与竞品售价相同")],
      ["Amazon 标题件数", product.pieceCountSource === "default" ? null : `${product.pieceCount} 件 · ${pieceCountSourceLabel(product)}`],
      ["竞品 30 天销量", monthlySalesValue(product) !== null ? `${formatInteger(monthlySalesValue(product))}${monthlySalesEvidence(product)?.kind === "lower_bound" ? "+" : ""} pcs · ${monthlySalesEvidence(product)?.source === "sellsprite_api" ? "SellerSprite 子体近 30 天估算销量" : "Amazon 月购买量提示"}` : "未知 · 尚无有效月销量，不等于低于 50"],
      ["竞品 60 天销量", Number.isFinite(product.sales60) ? `${formatInteger(product.sales60)} pcs` : null],
      ["竞品 30 天销售额", moneyMetric(product.salesAmount30, amazonOnly ? "数据来源见字段核验" : "SellerSprite 最近 30 天口径") || (amazonOnly ? `${auditedMissing("salesAmount30")}（准确销售额）` : null)],
      ["销量更新日期", product.sales30UpdatedAt || null],
      ["目标采购成本", cnyMoneyMetric(product.targetCostCny)],
      ["1688 盈利线", cnyMoneyMetric(product.thresholdCostCny, "最高可接受采购成本")],
      ["评分与评价", ratingAndReviews || null],
      ["A+ 页面", typeof product.hasAPlus === "boolean" ? (product.hasAPlus ? "有" : "无") : null],
      ["首次 FBA 有货", product.firstFba || null],
      ["Amazon 上架日期", amazonListingDateLabel(product)],
      ["上架日期说明", amazonListingDateValue(product) ? null : "日期仅用于展示和已启用的日期筛选，不影响利润计算及正常分析"],
      ["SellerSprite 上架日期", !amazonOnly ? product.listingAvailableAt || null : null],
      ["商品参数", product.productDimensions || null],
      ["FBA 包装参数", product.fbaDimensions || null],
      ["页面商品重量（Item Weight）", automaticProductWeightKg(product) !== null ? `${formatWeightKg(automaticProductWeightKg(product))} kg` : null],
      ["页面包裹重量", automaticPackageWeightKg(product) !== null ? `${formatWeightKg(automaticPackageWeightKg(product))} kg` : null],
      ["利润计算重量", displayedProductWeight !== null ? `${formatWeightKg(displayedProductWeight)} kg · ${productWeightBandLabel(displayedProductWeight)} · ${profitWeightSourceLabel(product)}` : isFba && product.fbaEstimate?.assumption === "missing_weight_minimum_fba_estimate" ? `${isAmazonWeightUnavailable(product) ? "页面未提供" : "Item Weight 待核验"} · 利润按最低档暂估` : amazonOnly ? amazonFieldIssue(product, "weight") : null],
      ["商品尺寸（cm）", resolveProductDimensionsCm(product)?.map(value => formatNumber(value)).join(" × ") || null],
      ["体积重", product.fbaEstimate?.dimensionalWeightKg ? `${formatWeightKg(product.fbaEstimate.dimensionalWeightKg)} kg（长×宽×高 cm ÷ ${product.marketplace === 'AU' ? 6000 : 5021.69}）` : null],
      ["FBA 费用采用依据", product.manualFbaFee ? "人工费用覆盖" : fbaSelectionExplanation(product.fbaEstimate) || null],
      [isAu ? "FBA 配送费（澳洲重量档）" : "FBA 配送费（按所选重量）", fbaFeeMetric],
      ["FBA 封顶估费重量", !product.manualFbaFee && product.fbaEstimate?.overweightCapped ? `${product.fbaEstimate.feeWeightG} g · 国内运费与空运头程按实际重量` : null],
      ...(!isAu ? [
        ["FBA 计费输入", Number.isFinite(product.billingWeight) ? `${product.billingWeight.toFixed(2)} kg${product.weightSource && !/(?:缺失|未获取)/.test(product.weightSource) ? ` · ${product.weightSource}` : ""}` : product.fbaEstimate?.assumption === "missing_weight_minimum_fba_estimate" ? "实际重量未知 · FBA 配送费按最低档估算" : null],
        ["FBA 计费重", Number.isFinite(product.fbaEstimate?.billableWeightLb) ? `${product.fbaEstimate.billableWeightLb.toFixed(2)} lb` : null],
      ] : []),
      ["FBA 包装重量", Number.isFinite(product.fbaWeight) ? `${formatWeightKg(product.fbaWeight)} kg · ${productWeightBandLabel(product.fbaWeight)}` : null],
      ...(!isAu ? [
        ["FBA 估费档位", product.fbaEstimate?.tierLabel || null],
        ["FBA 来源置信度", product.fbaEstimate ? `${product.fbaEstimate.confidence} · 仅按${product.fbaEstimate.weightSource}` : null],
      ] : []),
      ...fulfillmentMetrics,
      ["参数口径", parameterSource],
      ["采集 / 分析来源", analysisSourceLabel(product)],
      ["数据采集时间", product.collectedAt ? formatCollectedAt(product.collectedAt) : null],
      ["数据模式", amazonOnly
        ? `Amazon ${product.sourceMarketplace || product.marketplace} 官网${isManualCostProduct(product) ? " + 人工成本" : product.supplierSource ? " + 1688 图片匹配" : ""}`
        : isProxyAnalysis(product)
          ? `SellerSprite ${product.providerMarketplace} 代理分析（非 ${product.sourceMarketplace} 实时）${isManualCostProduct(product) ? " + 人工成本" : product.supplierSource ? " + 1688 图片匹配" : ""}`
          : product.dataMode === "mock"
            ? "模拟演示"
            : isManualCostProduct(product)
              ? "SellerSprite 实时 + 人工成本"
              : product.supplierSource ? "SellerSprite 实时 + 1688 图片匹配" : "SellerSprite 实时"],
    ].filter(([, value]) => value !== null && value !== undefined && value !== "");
    byId("amazonMetrics").innerHTML = metrics.map(([term, value]) => {
      const renderedValue = value?.type === "currency"
        ? `${currencyPairHtml(value.value, product.marketplace)}${value.note ? `<small class="metric-value-note">${escapeHtml(value.note)}</small>` : ""}`
        : value?.type === "cny-currency"
          ? `${cnyCurrencyPairHtml(value.value, product.marketplace)}${value.note ? `<small class="metric-value-note">${escapeHtml(value.note)}</small>` : ""}`
        : escapeHtml(value);
      return `<div><dt>${term}</dt><dd>${renderedValue}</dd></div>`;
    }).join("");

    renderProductInformation(product);
    const sourceNote = byId("sellerSpriteSourceNote");
    if (sourceNote) {
      const mode = product.dataMode === "mock" ? "mock" : isProxyAnalysis(product) || product.supplierSource ? "mixed" : "live";
      sourceNote.dataset.mode = mode;
      const sourceText = product.dataMode === "mock"
        ? "数据来源：模拟数据 · 仅用于演示，不可用于最终决策"
        : `数据来源：${analysisSourceLabel(product)}${product.collectedAt ? ` · 更新于 ${formatCollectedAt(product.collectedAt)}` : ""}${isManualCostProduct(product) ? "；采购成本与履约费为人工输入" : product.supplierSource ? "；采购报价来自 1688 图片匹配" : ""}`;
      const span = sourceNote.querySelector("span");
      if (span) span.textContent = sourceText;
    }

    renderSupplierList(product);
    drawerPurchaseInput = "unit";
    byId("editSalePrice").value = valueOrBlank(product.salePrice);
    byId("editPurchaseCost").value = valueOrBlank(purchasePricing.unitCostCny);
    byId("editPurchaseCost").dataset.purchaseBaseline = valueOrBlank(purchasePricing.unitCostCny);
    byId("editPieceCount").value = valueOrBlank(purchasePricing.pieceCount);
    byId("editPurchaseTotal").value = valueOrBlank(purchasePricing.totalCostCny);
    setText("editPieceCountSource", pieceCountSourceLabel(product));
    const purchaseInputLabel = byId("editPurchaseCost")?.closest("label")?.querySelector(":scope > span:first-child");
    if (purchaseInputLabel) purchaseInputLabel.textContent = isManualCostProduct(product) ? "1688 单件采购价（人工）" : "1688 单件采购均价";
    byId("editFbaFee").value = feeInputValue(getFulfillmentFee(product));
    const fbaInputLabel = byId("editFbaFee")?.closest("label")?.querySelector(":scope > span:first-child");
    if (fbaInputLabel) {
      fbaInputLabel.textContent = product.fulfillmentMode === "FBA"
        ? `FBA 配送费（${isAu && !product.manualFbaFee ? "澳洲标准信封自动，可覆盖" : isAssumedFba(product) ? "假设估算，可覆盖" : "可覆盖"}）`
        : product.fulfillmentMode === "FBM" ? "FBM 履约费（可覆盖）" : "FBA 配送费（输入重量后自动估算，可覆盖）";
    }
    byId("editWeight").value = valueOrBlank(product.billingWeight);
    drawerFbaTouched = false;
    drawerProfitBaseline = profitEditorInputValues();
    renderProfitPreview();
    const handedOff = isAnalysisReadOnly(product);
    const editingLocked = handedOff || isCollectionWriteLocked();
    byId("rejectProductButton").disabled = editingLocked || product.reviewStatus === "rejected";
    byId("rematchProductButton").disabled = editingLocked || analysisRunning || isProductSupplierBusy(product)
      || Boolean(runState.archivedAt && (isManualCostProduct(product) || product.reviewStatus === 'rejected'));
    if (byId("openManualCostButton")) byId("openManualCostButton").disabled = editingLocked || isProductSupplierBusy(product);
    PROFIT_EDITOR_INPUT_IDS.forEach((id) => { if (byId(id)) byId(id).disabled = editingLocked || isProductSupplierBusy(product); });
    syncProfitEditorSaveButton(product);
    const handoffNotice = byId("drawerAnalysisHandoffNote");
    if (handoffNotice) handoffNotice.hidden = !handedOff;
    renderAnalysisVersionActions(product);
    const editReason = isCollectionWriteLocked() ? "采集管理期间可查看和筛选，完成后可编辑。" : handedOff ? "已交接快照受保护；点击“创建新的分析版本”后可继续编辑和匹配。" : "手工补齐Amazon信息与采购成本，并实时重算本次初步利润。";
    byId("openManualCostButton").title = isProductSupplierBusy(product) ? "当前商品正在匹配，完成后可手工编辑。" : editReason;
    byId("rematchProductButton").title = editingLocked ? editReason : runState.archivedAt && isManualCostProduct(product) ? "已使用人工采购成本，保留人工数据。" : analysisRunning || isProductSupplierBusy(product) ? "当前分析或匹配进行中，完成后可重新匹配。" : "使用原共享1688服务，为当前商品重新匹配参考厂家。";
    initIcons();
  }

  function renderSupplierList(product) {
    renderSupplierChoice(product);
    const purchasePricing = ensureProductPurchasePricing(product);
    const suppliers = product.suppliers || [];
    const included = suppliers.filter((supplier) => supplier.included);
    const qualified = suppliers.filter(isSupplierMatchQualified);
    const fallbackEstimate = isLowConfidenceSupplierEstimate(product);
    const waitingForSupplier = ["not_started", "pending", "searching", "queue_waiting", "session_expired", "not_logged_in"].includes(product.supplierSearchStatus);
    const availableSupplierCount = new Set(suppliers
      .filter((supplier) => Number.isFinite(supplier.unitPriceCny) && supplier.unitPriceCny > 0)
      .map((supplier) => supplier.supplierId || supplier.name)).size;
    const summaryBox = byId("supplierSummaryBox");
    if (summaryBox) summaryBox.dataset.confidence = fallbackEstimate ? "low" : "standard";
    setText("supplierSummaryLabel", product.supplierSearchStatus === "complete" ? "中间 6 家单件均价" : fallbackEstimate ? "图片相似度最高 6 家单件均价" : "图片匹配厂家");
    const supplierSummary = byId("supplierSummary");
    if (supplierSummary) {
      supplierSummary.innerHTML = waitingForSupplier
        ? escapeHtml(isProductSupplierBusy(product) ? "匹配中" : "待处理")
        : ["complete", "fallback_estimate"].includes(product.supplierSearchStatus) && Number.isFinite(product.supplierAverageCny)
          ? cnyCurrencyPairHtml(product.supplierAverageCny, product.marketplace, { compact: true })
          : escapeHtml(`${availableSupplierCount} / ${INCLUDED_1688_QUOTES} 家`);
    }
    setText("supplierSummaryNote", product.supplierSearchStatus === "complete"
      ? `10 家图片相似度均 >50% · ${formatCny(purchasePricing.unitCostCny)}/件 × ${purchasePricing.pieceCount} 件 = ${formatCny(purchasePricing.totalCostCny)} · 粗算利润率 ${formatPercent(product.roughMargin)}`
      : fallbackEstimate
        ? `未满足标准 10 家样本 · ${formatCny(purchasePricing.unitCostCny)}/件 × ${purchasePricing.pieceCount} 件 = ${formatCny(purchasePricing.totalCostCny)} · 低置信度 · 粗算利润率 ${formatPercent(product.roughMargin)}`
      : product.supplierSearchError || "需 10 家图片相似度 >50% 的有效唯一报价，才能计算中间 6 家均价");
    if (!suppliers.length) {
      const messages = {
        not_started: ["尚未加入 1688 批次", "确认 Amazon 筛选后，可在结果页单独启动这一批商品的匹配。"],
        not_logged_in: ["1688 未登录", "该商品所在批次已保存；连接并在线验证后只会继续原批次。"],
        session_expired: ["1688 登录已失效", "重新连接并在线验证后将继续已确认批次；当前 Amazon 商品数据已保留。"],
        queue_waiting: ["1688 队列等待中", "原任务编号和当前商品数据已保留；在线验证后会从这里继续，不需要重新分析店铺。"],
        pending: ["待手动匹配", "该商品在已确认的固定批次中；1688 匹配完全由手动控制，点击「匹配当前筛选」按钮才会发起。"],
        failed: ["1688 商品匹配失败", product.supplierSearchError || "可重试或手工填写采购成本。"],
        missing_inputs: ["未发起 1688 搜索", product.supplierSearchError || "请补齐当前售价和商品主图。"],
        manual_cost: ["已使用人工成本", "后台 1688 已跳过这个商品，不会覆盖人工输入。"],
        searching: ["正在匹配商品", "正在获取图片候选并计算图片相似度。"],
        similarity_insufficient: ["图片报价不足 6 家", product.supplierSearchError || "图片搜索仍未找到 6 家具备有效图片分和报价的供应商。"],
        similarity_unverified: ["历史匹配待更新", product.supplierSearchError || "旧规则结果不再用于自动成本，请重新进行图片匹配。"],
      };
      const message = messages[product.supplierSearchStatus] || ["暂无有效报价", product.supplierSearchError || "可登录 1688 后退回匹配，或手工填写采购成本。"];
      byId("supplierList").innerHTML = `<div class="drawer-empty"><strong>${escapeHtml(message[0])}</strong><span>${escapeHtml(message[1])}</span></div>`;
      return;
    }
    byId("supplierList").innerHTML = suppliers.map((supplier, index) => `
      <article class="supplier-card ${supplier.included ? fallbackEstimate ? "is-fallback-included" : "is-included" : "is-excluded"} is-similarity-${escapeHtml(supplier.supplierMatchDecision || "unavailable")}">
        ${supplier.candidateImageUrl ? `<img class="supplier-product-image" src="${escapeHtml(supplier.candidateImageUrl)}" alt="${escapeHtml(supplier.name)} 的 1688 候选商品图" loading="lazy" referrerpolicy="no-referrer" />` : '<div class="supplier-product-image is-missing" aria-label="候选图片不可用"><i data-lucide="image-off" aria-hidden="true"></i></div>'}
        <div class="supplier-head"><span>${String(supplier.rank || index + 1).padStart(2, "0")}</span><strong>${escapeHtml(supplier.name)}</strong><em>${supplier.factoryVerified ? "验厂" : "未验厂"}</em></div>
        <div class="supplier-meta"><span class="supplier-source is-image">图片候选</span><span class="supplier-similarity is-${escapeHtml(supplier.imageSimilarityDecision || "unavailable")}">${similarityScoreLabel(supplier.imageSimilarityScore)}</span><span>MOQ ${formatInteger(supplier.moq ?? product.moq)}</span><span>${escapeHtml(supplier.priceTier || "当前阶梯")}</span><span>${escapeHtml(supplier.spec || "同规格待确认")}</span></div>
        <div class="supplier-price"><strong>${cnyCurrencyPairHtml(supplier.unitPriceCny ?? supplier.price, product.marketplace, { compact: true })}</strong><span class="supplier-decision is-${supplier.included ? "included" : "excluded"}">${escapeHtml(supplierReasonLabel(supplier.excludedReason, supplier))}</span></div>
        ${supplier.url ? `<div class="supplier-offer-actions"><a class="supplier-offer-link" href="${escapeHtml(supplier.url)}" target="_blank" rel="noopener noreferrer">查看报价 <i data-lucide="arrow-up-right" aria-hidden="true"></i></a>
          ${normalizeSupplierChoiceUrl(supplier.url) ? `<label class="supplier-choice-radio"><input type="radio" name="supplier-choice" data-supplier-choice value="${escapeHtml(normalizeSupplierChoiceUrl(supplier.url))}" ${normalizeSupplierChoiceUrl((supplierChoiceDrafts.get(supplierChoiceKey(product.id)) || product.supplierChoice)?.selectedUrl) === normalizeSupplierChoiceUrl(supplier.url) ? 'checked' : ''} ${isAnalysisReadOnly(product) || isCollectionWriteLocked() || isProductSupplierBusy(product) ? 'disabled' : ''} />选择此厂家</label>` : ''}</div>` : ""}
      </article>`).join("");
    if (included.length !== INCLUDED_1688_QUOTES && ["complete", "fallback_estimate"].includes(product.supplierSearchStatus)) {
      setText("supplierSummaryNote", "报价分组不完整，未形成采购成本。请重新匹配或手工填写成本。");
    }
  }

  function supplierChoiceKey(productId) { return `${runState.id}\u0000${productId}`; }

  function renderSupplierChoice(product) {
    const choice = supplierChoiceDrafts.get(supplierChoiceKey(product.id)) || product.supplierChoice || {};
    const input = byId('supplierManualUrl');
    if (input) {
      input.value = choice.manualUrl || '';
      input.disabled = isAnalysisReadOnly(product) || isCollectionWriteLocked() || isProductSupplierBusy(product);
    }
    const button = byId('saveSupplierChoiceButton');
    if (button) button.disabled = input?.disabled || false;
    const chosen = chosenSupplierUrl({ supplierChoice: choice });
    setText('supplierChoiceStatus', supplierChoiceDrafts.has(supplierChoiceKey(product.id)) ? '链接尚未保存。'
      : chosen ? `导出链接（${choice.manualUrl ? '手动输入' : '列表选择'}）：${chosen}` : '可选择下方厂家，或粘贴 1688 链接；手动输入优先。');
  }

  async function saveSupplierChoice(productId = activeProductId) {
    const key = supplierChoiceKey(productId);
    const savedRunId = runState.id;
    while (supplierChoiceSaves.has(key)) await supplierChoiceSaves.get(key);
    if (savedRunId !== runState.id) return false;
    const draft = supplierChoiceDrafts.get(key);
    if (!draft) return true;
    const product = products.find(item => item.id === productId);
    if (!product || isAnalysisReadOnly(product) || isCollectionWriteLocked() || isProductSupplierBusy(product)) {
      showToast('当前商品暂不可修改厂家链接，请等待匹配结束或创建新的分析版本。', 'info', 5200);
      return false;
    }
    const manualUrl = String(draft.manualUrl || '').trim();
    if (manualUrl && !normalizeSupplierChoiceUrl(manualUrl)) {
      setText('supplierChoiceStatus', '请输入有效的 1688 链接（http 或 https）。');
      showToast('厂家链接尚未保存：请输入有效的 1688 链接。', 'error', 4800);
      return false;
    }
    const previous = product.supplierChoice;
    const choice = { selectedUrl: normalizeSupplierChoiceUrl(draft.selectedUrl), manualUrl: normalizeSupplierChoiceUrl(manualUrl) };
    product.supplierChoice = choice;
    profitEditorPendingSaves += 1;
    profitEditorPersistenceEpoch += 1;
    let settled = false;
    const settle = () => { if (!settled) { settled = true; profitEditorPendingSaves -= 1; profitEditorPersistenceEpoch += 1; } };
    const pending = (async () => {
      let saved = false;
      try { saved = await persistCurrentRun({ notify: true, onSettled: settle }); }
      finally {
        settle();
        if (saved && supplierChoiceDrafts.get(key) === draft) supplierChoiceDrafts.delete(key);
        if (!saved && product.supplierChoice === choice) product.supplierChoice = previous;
        if (runState.id === savedRunId && activeProductId === productId) {
          renderSupplierChoice(products.find(item => item.id === productId) || product);
          if (!saved) setText('supplierChoiceStatus', '厂家链接未保存，请点击保存重试。');
        }
        flushDeferredProfitEditorSnapshot();
      }
      return saved;
    })();
    supplierChoiceSaves.set(key, pending);
    try { return await pending; }
    finally { if (supplierChoiceSaves.get(key) === pending) supplierChoiceSaves.delete(key); }
  }

  async function flushSupplierChoices() {
    const runId = runState.id;
    for (const product of products) {
      const key = supplierChoiceKey(product.id);
      if ((supplierChoiceSaves.has(key) || supplierChoiceDrafts.has(key)) && !await saveSupplierChoice(product.id)) return false;
      if (runState.id !== runId) return false;
    }
    return true;
  }

  function supplierReasonLabel(reason, supplier = null) {
    const labels = {
      included_middle_six: "纳入中间 6 家",
      included_top_six_fallback: "纳入图片相似度最高 6 家 · 低置信度",
      excluded_low_outlier: "剔除 · 最低 2 家",
      excluded_high_outlier: "剔除 · 最高 2 家",
      insufficient_valid_quotes: "供应商样本不足 · 不纳入",
      image_match_unavailable: "图片匹配无法核验 · 不纳入",
      image_similarity_below_threshold: "图片未高于 50% · 不纳入",
      image_similarity_unavailable: "图片无法核验 · 不纳入",
      image_similarity_unverified: "历史未核验 · 不纳入",
      outside_top_10: "达标但超出前 10 家",
      outside_top_6_fallback: "低匹配候选 · 未进入前 6 家",
      insufficient_fallback_quotes: "真实报价不足 6 家 · 暂不计算",
    };
    return labels[String(reason || "")] || "不纳入均价";
  }

  function similarityScoreLabel(score) {
    const value = finiteOrNull(score);
    return value !== null && value >= 0 && value <= 1
      ? `图片相似度 ${(value * 100).toFixed(1)}%`
      : "图片相似度未核验";
  }

  function feeInputValue(value) {
    const fee = finiteOrNull(value);
    return fee === null ? "" : fee.toFixed(2);
  }

  function getEditorValues() {
    const product = products.find((item) => item.id === activeProductId);
    const weightRaw = String(byId("editWeight").value).trim();
    const billingWeight = weightRaw ? numberOrNull(weightRaw) : finiteOrNull(product?.billingWeight);
    const pieceCount = normalizePieceCount(byId("editPieceCount")?.value);
    let purchasePricing = resolvePurchasePriceInput(product, byId("editPurchaseCost").value, byId("editPurchaseCost").dataset.purchaseBaseline ?? product?.purchaseUnitCostCny);
    if (drawerPurchaseInput === "total") {
      const rawTotal = String(byId("editPurchaseTotal").value).trim();
      const enteredTotal = numberOrNull(rawTotal);
      if (rawTotal) {
        const invalid = enteredTotal === null || enteredTotal < 0;
        // Keep the quotient at full precision: e.g. 10 / 3 must still total 10 after reload.
        const unitCostCny = !invalid && pieceCount !== null ? roundMoney(enteredTotal) / pieceCount : null;
        purchasePricing = { unitCostCny, invalid, manuallyEdited: unitCostCny !== null, manual: true };
      }
    }
    const purchaseUnitCostCny = purchasePricing.unitCostCny;
    const feeRaw = String(byId("editFbaFee").value);
    let fulfillmentFee = numberOrNull(feeRaw);
    const salePrice = numberOrNull(byId("editSalePrice").value);
    const savedFulfillmentMode = normalizeFulfillmentMode(product?.fulfillmentMode);
    const fulfillmentMode = savedFulfillmentMode || ((billingWeight !== null && billingWeight > 0) || fulfillmentFee !== null ? "FBA" : null);
    if (product && fulfillmentMode === "FBA" && !drawerFbaTouched && !product.manualFbaFee) {
      // The displayed cents must never replace the full-precision automatic fee.
      fulfillmentFee = estimateFbaForEditor(product, billingWeight, salePrice)?.fee ?? null;
    } else if (product && !drawerFbaTouched && feeRaw === feeInputValue(getFulfillmentFee(product))) {
      fulfillmentFee = getFulfillmentFee(product);
    }
    const profitInputs = product ? ensureProductProfitInputs(product) : getDefaultProfitInputs();
    return {
      salePrice,
      purchaseUnitCostCny,
      purchasePricing,
      pieceCount,
      purchaseCost: totalPurchaseCostCny(purchaseUnitCostCny, pieceCount),
      fulfillmentMode,
      fulfillmentFee,
      fbaFee: fulfillmentMode === "FBA" ? fulfillmentFee : finiteOrNull(product?.fbaFee),
      fbmFee: fulfillmentMode === "FBM" ? fulfillmentFee : finiteOrNull(product?.fbmFee),
      billingWeight,
      actualWeightKg: billingWeight,
      dimensionsCm: profitInputs.dimensionsCm,
      resolvedProfitInputs: profitInputs,
      marketplace: product?.marketplace || activeMarket.code,
    };
  }

  function clearProfitAutoCommit() {
    if (profitAutoCommitTimer === null) return;
    clearTimeout(profitAutoCommitTimer);
    profitAutoCommitTimer = null;
  }

  function setProfitEditorStatus(message, state = "") {
    const status = byId("profitEditorStatus");
    if (status) { status.textContent = message; status.dataset.state = state; }
  }

  function syncProfitEditorSaveButton(product) {
    const button = byId("saveProfitEditsButton");
    if (button) button.disabled = !product || isCollectionWriteLocked() || isAnalysisReadOnly(product) || isProductSupplierBusy(product);
    if (isCollectionWriteLocked()) setProfitEditorStatus("后台任务执行中；暂停并等待当前请求结束后可编辑。");
    else if (isAnalysisReadOnly(product)) setProfitEditorStatus("已交接资料受保护；创建新的分析版本后可编辑。");
    else if (isProductSupplierBusy(product)) setProfitEditorStatus("当前商品正在匹配，完成后可编辑。");
  }

  function profitEditorInputValues() {
    return Object.fromEntries(PROFIT_EDITOR_INPUT_IDS.map((id) => [id, String(byId(id)?.value ?? "")]));
  }

  function isCurrentProfitEditorDraft(draft) {
    return Boolean(draft && draft.runId === runState.id && draft.productId === activeProductId
      && draft.transitionId === drawerTransitionId && draft.version === drawerProfitSaveVersion);
  }

  function captureProfitEditorDraft() {
    if (!activeProductId) return null;
    const previous = drawerProfitDraft?.runId === runState.id && drawerProfitDraft.productId === activeProductId
      && drawerProfitDraft.transitionId === drawerTransitionId ? drawerProfitDraft : null;
    const inputs = profitEditorInputValues();
    const changedInputs = new Set(previous?.changedInputs || []);
    if (drawerPurchaseInput === "total") changedInputs.delete("editPurchaseCost");
    else if (previous?.purchaseInput === "total" && changedInputs.delete("editPurchaseTotal")) changedInputs.add("editPurchaseCost");
    for (const id of PROFIT_EDITOR_INPUT_IDS) {
      if (id === "editPurchaseTotal" && drawerPurchaseInput !== "total") continue;
      if (id === "editPurchaseCost" && drawerPurchaseInput === "total") continue;
      // Automatic fee updates are derived from the latest price/weight, never a manual override.
      if (id === "editFbaFee" && !drawerFbaTouched) continue;
      if (inputs[id] !== String(drawerProfitBaseline?.[id] ?? "")) changedInputs.add(id);
    }
    if (!changedInputs.size) return null;
    return {
      runId: runState.id, productId: activeProductId, transitionId: drawerTransitionId,
      version: drawerProfitSaveVersion, inputs, changedInputs: [...changedInputs],
      purchaseInput: drawerPurchaseInput, fbaTouched: drawerFbaTouched,
      purchaseBaseline: previous?.purchaseBaseline ?? byId("editPurchaseCost").dataset.purchaseBaseline,
    };
  }

  function restoreProfitEditorDraft(draft) {
    if (!isCurrentProfitEditorDraft(draft)) return;
    const product = products.find((item) => item.id === draft.productId);
    if (!product) return;
    // Keep the new canonical snapshot intact; only restore pending editor fields for a normal retry.
    for (const id of draft.changedInputs) byId(id).value = draft.inputs[id];
    drawerPurchaseInput = draft.purchaseInput;
    drawerFbaTouched = draft.fbaTouched;
    if (draft.changedInputs.includes("editPurchaseCost") || draft.changedInputs.includes("editPurchaseTotal")) {
      byId("editPurchaseCost").dataset.purchaseBaseline = draft.purchaseBaseline;
    }
    if (!drawerFbaTouched && !product.manualFbaFee && product.fulfillmentMode !== "FBM") {
      const values = getEditorValues();
      const estimate = estimateFbaForEditor(product, values.billingWeight, values.salePrice);
      byId("editFbaFee").value = feeInputValue(estimate?.fee);
    }
    drawerProfitDraft = draft;
    renderProfitPreview();
    drawerProfitDraft = captureProfitEditorDraft();
    setProfitEditorStatus("修改尚未保存；后台数据已更新，请点击保存修改重试。", "error");
    syncProfitEditorSaveButton(product);
  }

  function flushDeferredProfitEditorSnapshot() {
    if (!profitEditorSnapshotDeferred || profitEditorPendingSaves || amazonCollectionSnapshotPromise) return;
    profitEditorSnapshotDeferred = false;
    snapshotRefreshPending = true;
    void flushSnapshotUpdate();
  }

  async function persistProfitEditorEdits(productId) {
    const version = ++drawerProfitSaveVersion;
    const savedRunId = runState.id;
    const transitionId = drawerTransitionId;
    if (drawerProfitDraft) drawerProfitDraft.version = version;
    setProfitEditorStatus("正在保存修改…");
    profitEditorPendingSaves += 1;
    profitEditorPersistenceEpoch += 1;
    let settled = false;
    const settleSave = () => {
      if (settled) return;
      settled = true;
      profitEditorPendingSaves -= 1;
      profitEditorPersistenceEpoch += 1;
    };
    let saved;
    try { saved = await persistCurrentRun({ notify: true, onSettled: settleSave }); }
    finally { settleSave(); flushDeferredProfitEditorSnapshot(); }
    if (runState.id === savedRunId && activeProductId === productId && transitionId === drawerTransitionId && version === drawerProfitSaveVersion) {
      if (saved) { drawerProfitDraft = null; drawerProfitBaseline = profitEditorInputValues(); }
      setProfitEditorStatus(saved ? "修改已保存，利润按当前参数重算。" : "修改尚未保存，请查看提示后点击保存修改重试。", saved ? "saved" : "error");
      syncProfitEditorSaveButton(products.find((product) => product.id === productId));
    }
    return saved;
  }

  async function saveProfitEditor() {
    clearProfitAutoCommit();
    if (!commitProfitEdits(false, { preserveEditor: true, persist: false })) return false;
    return persistProfitEditorEdits(activeProductId);
  }

  function scheduleProfitAutoCommit() {
    if (isCollectionWriteLocked()) { clearProfitAutoCommit(); return; }
    clearProfitAutoCommit();
    drawerProfitSaveVersion += 1;
    drawerProfitDraft = captureProfitEditorDraft();
    setProfitEditorStatus("修改待保存…");
    const productId = activeProductId;
    if (!productId) return;
    profitAutoCommitTimer = setTimeout(() => {
      profitAutoCommitTimer = null;
      if (activeProductId !== productId) return;
      commitProfitEdits(false, { preserveEditor: true, silentInvalid: true });
    }, 300);
  }

  function flushProfitAutoCommit({ force = false } = {}) {
    const hadPendingCommit = profitAutoCommitTimer !== null;
    clearProfitAutoCommit();
    if (!hadPendingCommit && !force) return;
    renderProfitPreview();
    commitProfitEdits(false, { preserveEditor: true, silentInvalid: true });
  }

  function renderProfitPreview() {
    const product = products.find((item) => item.id === activeProductId);
    if (!product) return;
    const market = MARKET_CONFIGS[String(product.marketplace || activeMarket.code).toUpperCase()] || activeMarket;
    const isAu = market.code === "AU";
    const values = getEditorValues();
    setText("editPurchaseCostSource", purchasePriceInputNote(product, values.purchasePricing));
    if (drawerPurchaseInput === "total") {
      if (!values.purchasePricing.invalid && values.purchaseUnitCostCny !== null) byId("editPurchaseCost").value = valueOrBlank(values.purchaseUnitCostCny);
    } else if (byId("editPurchaseTotal")) byId("editPurchaseTotal").value = valueOrBlank(values.purchaseCost);
    syncProfitEditorSaveButton(product);
    setCurrencyConversionOutput("editSalePriceCny", values.salePrice, product.marketplace);
    setCurrencyConversionOutput("editFbaFeeCny", values.fulfillmentFee, product.marketplace);
    const calculation = isAnalysisReadOnly(product) ? calculateProfit(product) : calculateProfit(values, product);
    syncDrawerApprovalButton(product, values, calculation);
    const profitResult = byId("drawerProfitMargin")?.closest(".profit-result");
    if (!calculation) {
      const estimate = estimateFbaForEditor(product, values.billingWeight, values.salePrice);
      byId("costBreakdown").innerHTML = estimate?.assumption === "missing_weight_minimum_fba_estimate" && !product.manualFbaFee
        ? '<div class="fba-calculation-note"><strong>实际重量未知 · 可初审</strong><p>FBA 配送费暂按最低档 ' + escapeHtml(formatCurrencyWithCnyText(estimate.fee, product.marketplace)) + ' 估算。补齐售价等其余参数后，利润按最低档假设重量暂估。</p></div>'
        : '<div class="fba-calculation-note">利润参数尚未齐全，可先完成候选初审。</div>';
      if (profitResult) profitResult.hidden = true;
      return;
    }
    if (profitResult) profitResult.hidden = false;
    const isFbm = values.fulfillmentMode === "FBM";
    const estimate = isFbm ? null : estimateFbaForEditor(product, values.billingWeight, values.salePrice);
    const isManualFba = !isFbm && (product.manualFbaFee || drawerFbaTouched || !estimate || Math.abs(values.fulfillmentFee - estimate.fee) > 0.005);
    const automaticFbaLabel = isAu ? "澳洲标准信封费率" : market.code === "CA" ? "加拿大旺季信封费率" : "FBA SOP 商品重量估算";
    const supplierCostLabel = calculation.purchaseCostAssumedZero
      ? "采购成本（待匹配，暂按 0 计算）"
      : values.purchasePricing.manual
      ? "整套采购成本（人工单价 × 件数）"
      : isLowConfidenceSupplierEstimate(product) ? "1688 整套采购成本（低置信度）" : "1688 整套采购成本";
    const exchangeRate = calculation.exchangeRate;
    const salePriceCny = convertCurrencyToCny(calculation.salePrice, product.marketplace);
    const fulfillmentCny = convertCurrencyToCny(calculation.fulfillment, product.marketplace);
    const commissionCny = convertCurrencyToCny(calculation.commission, product.marketplace);
    const fxLossCny = convertCurrencyToCny(calculation.fxLoss, product.marketplace);
    const marketingCny = convertCurrencyToCny(calculation.marketing, product.marketplace);
    const managementCny = convertCurrencyToCny(calculation.management, product.marketplace);
    const returnsCny = convertCurrencyToCny(calculation.returns, product.marketplace);
    const totalCostCny = convertCurrencyToCny(calculation.totalCost, product.marketplace);
    const profitCny = convertCurrencyToCny(calculation.profit, product.marketplace);
    const includedSupplierPrices = (product.suppliers || [])
      .filter((supplier) => supplier.included)
      .map((supplier) => finiteOrNull(supplier.unitPriceCny ?? supplier.price))
      .filter((value) => value !== null);
    const supplierFormula = calculation.purchaseCostAssumedZero
      ? "采购成本尚未填写，仅预估时按 0；有效报价回填后自动重算"
      : values.purchasePricing.manual
      ? `${formatCny(values.purchaseUnitCostCny)} × ${values.pieceCount} 件 = ${formatCny(calculation.purchaseCostCny)}`
      : includedSupplierPrices.length
        ? `（${includedSupplierPrices.map(formatCny).join(" + ")}）÷ ${includedSupplierPrices.length} 家 = ${formatCny(values.purchaseUnitCostCny)}/件；${formatCny(values.purchaseUnitCostCny)} × ${values.pieceCount} 件 = ${formatCny(calculation.purchaseCostCny)}`
        : `${formatCny(values.purchaseUnitCostCny)}/件 × ${values.pieceCount} 件 = ${formatCny(calculation.purchaseCostCny)}`;
    const fulfillmentFormula = estimate?.assumption === "missing_weight_minimum_fba_estimate" && !isManualFba
      ? `最低信封档暂估 · ${estimate.tierLabel} · ${estimate.priceBandLabel || "美国 SOP 参考"} = ${formatCurrency(calculation.fulfillment, product.marketplace)} ${market.currency}${estimate.rateModel === "us_sop_nominal_proxy" ? "（美国 SOP 名义参考费，非本站官方费率）" : ""}`
      : isAu && estimate && !isManualFba
      ? `${estimate.priceBandLabel} · ${estimate.tierLabel}${estimate.dimensionsAssumption ? "（尺寸待核验）" : ""} · ${estimate.billableWeightG}g（${estimate.weightBand}）= ${formatCurrency(calculation.fulfillment, product.marketplace)} AUD；${formatCurrency(calculation.fulfillment, product.marketplace)} AUD × 汇率 ${formatNumber(exchangeRate)} = ${formatCny(fulfillmentCny)}`
      : market.code === "CA" && estimate && !isManualFba
        ? `${estimate.weightSource || "实重"} · ${formatWeightKg(estimate.calculationWeightKg ?? estimate.actualWeightKg)} kg；（${formatCurrency(estimate.baseFee, product.marketplace)} − ${formatCurrency(estimate.discount, product.marketplace)}）×1.035 = ${formatCurrency(calculation.fulfillment, product.marketplace)} CAD（显示值；计算保留完整精度）`
      : `${formatCurrency(calculation.fulfillment, product.marketplace)} ${MARKET_CONFIGS[product.marketplace]?.currency || activeMarket.currency} × 汇率 ${formatNumber(exchangeRate)} = ${formatCny(fulfillmentCny)}`;
    const airFreightFormula = calculation.weightAssumption
      ? `实际重量未知，最低档假设 ${formatNumber(calculation.assumedWeightKg * 1_000)} g；头程计费重 ${formatNumber(calculation.airFreight.chargeableWeightKg)} kg（${calculation.airFreight.source === "carton" ? "外箱重量 ÷ 装箱数" : calculation.airFreight.source === "minimum_envelope_assumption" ? "最低档假设" : "假设重量与体积重取高"}）× ${formatCny(calculation.rates.airFreightRateCnyPerKg)}/kg = ${formatCny(calculation.airFreight.airFreightCny)}；取得商品或包裹重量后重算`
      : calculation.airFreight.source === "product_weight"
      ? `${formatNumber(calculation.airFreight.actualWeightKg * 1_000)} g × ${formatCny(calculation.airFreight.airFreightRateCnyPerGram)}/g = ${formatCny(calculation.airFreight.airFreightCny)}；${formatCny(calculation.airFreight.airFreightCny)} ÷ 汇率 ${formatNumber(exchangeRate)} = ${formatCurrency(calculation.parts.freight, product.marketplace)} ${MARKET_CONFIGS[product.marketplace]?.currency || activeMarket.currency}`
      : calculation.airFreight.source === "carton"
        ? `${formatNumber(calculation.airFreight.cartonWeightKg)} kg ÷ ${formatNumber(calculation.airFreight.unitsPerCarton)} 件 × ${formatCny(calculation.rates.airFreightRateCnyPerKg)}/kg`
        : `计费重 ${formatNumber(calculation.airFreight.chargeableWeightKg)} kg × ${formatCny(calculation.rates.airFreightRateCnyPerKg)}/kg（实际重与体积重取高）`;
    const percentageFormula = (rate, amountCny) => `${formatCny(salePriceCny)} × ${formatNumber(rate)}% = ${formatCny(amountCny)}`;
    const totalComponentsCny = [
      calculation.landedPurchaseCny,
      commissionCny,
      fulfillmentCny,
      calculation.airFreight.airFreightCny,
      fxLossCny,
      marketingCny,
      managementCny,
      returnsCny,
    ];
    const costRows = [
      { label: supplierCostLabel, formula: supplierFormula, amountCny: calculation.purchaseCostCny },
      { label: "采购税费", formula: `${formatCny(calculation.purchaseCostCny)} × ${formatNumber(calculation.rates.purchaseTaxRate)}% = ${formatCny(calculation.purchaseTaxCny)}`, amountCny: calculation.purchaseTaxCny },
      { label: calculation.dimensionalWeightEstimateKg ? "国内运费 / 件（体积重暂估）" : calculation.weightAssumption ? "国内运费 / 件（最低档暂估）" : "国内运费 / 件", formula: `${calculation.weightAssumption ? "假设重量 " : ""}${formatNumber(calculation.domesticFreightWeightKg)} kg × ${formatCny(calculation.rates.domesticFreightRateCnyPerKg)}/kg = ${formatCny(calculation.domesticFreightCny)}；参考范围 ${formatCny(calculation.domesticFreightMinCny)}-${formatCny(calculation.domesticFreightMaxCny)}`, amountCny: calculation.domesticFreightCny },
      { label: "落地采购成本", formula: `${formatCny(calculation.purchaseCostCny)} + ${formatCny(calculation.purchaseTaxCny)} + ${formatCny(calculation.domesticFreightCny)} = ${formatCny(calculation.landedPurchaseCny)}`, amountCny: calculation.landedPurchaseCny, className: "is-subtotal" },
      { label: "Amazon 佣金", formula: percentageFormula(calculation.rates.commissionRate, commissionCny), amountCny: commissionCny },
      { label: isFbm ? "FBM 履约费（人工输入）" : `FBA 配送费（${isManualFba ? "人工输入" : automaticFbaLabel}）`, formula: fulfillmentFormula, amountCny: fulfillmentCny },
      { label: calculation.weightAssumption ? "空运头程（最低档暂估）" : calculation.airFreight.source === "product_weight" ? `空运头程（${/包裹重量/.test(profitWeightSourceLabel(product)) ? "包裹重量" : "商品重量"}公式）` : `空运头程（${calculation.airFreight.source === "carton" ? "外箱公式" : "单件参数回退"}）`, formula: calculation.weightAssumption || calculation.airFreight.source === "product_weight" ? airFreightFormula : `${airFreightFormula} = ${formatCny(calculation.airFreight.airFreightCny)}`, amountCny: calculation.airFreight.airFreightCny },
      { label: "汇损预留", formula: percentageFormula(calculation.rates.fxLossRate, fxLossCny), amountCny: fxLossCny },
      { label: "Marketing", formula: percentageFormula(calculation.rates.marketingRate, marketingCny), amountCny: marketingCny },
      { label: "管理费", formula: percentageFormula(calculation.rates.managementRate, managementCny), amountCny: managementCny },
      { label: "退货预留", formula: percentageFormula(calculation.rates.returnsRate, returnsCny), amountCny: returnsCny },
      { label: "全部成本", formula: `${totalComponentsCny.map(formatCny).join(" + ")} = ${formatCny(totalCostCny)}`, amountCny: totalCostCny, className: "cost-line-total" },
    ];
    byId("costBreakdown").innerHTML = costRows.map((row) => `
      <div class="cost-line${row.className ? ` ${row.className}` : ""}">
        <span class="cost-line-copy"><strong>${escapeHtml(row.label)}</strong><small>${escapeHtml(row.formula)}</small></span>
        ${cnyCurrencyPairHtml(row.amountCny, product.marketplace, { compact: true })}
      </div>`).join("");
    if (isLowConfidenceSupplierEstimate(product)) {
      byId("costBreakdown").insertAdjacentHTML("afterbegin", '<div class="supplier-cost-warning"><strong>低置信度估算</strong><span>当前采购均价来自图片相似度最高的 6 家真实报价；其中可能包含低相似度候选，请在初审前核对厂家与报价。</span></div>');
    }
    if (estimate && !isAu) {
      byId("costBreakdown").insertAdjacentHTML("afterbegin", `
        <div class="fba-calculation-note">
          <span><b>${market.code === "CA" ? "加拿大档位" : "美国档位"}</b>${escapeHtml(estimate.tierLabel)}</span>
          <span><b>计费重量</b>${estimate.assumption === "missing_weight_minimum_fba_estimate" ? "最低档假设 · 实际重量未知" : market.code === "CA" ? `${estimate.billableWeightG} g` : Number.isFinite(estimate.billableWeightLb) ? `${estimate.billableWeightLb.toFixed(2)} lb` : "--"}</span>
          <span><b>参数置信度</b>${escapeHtml(estimate.confidence)}</span>
          <small>仅按${escapeHtml(estimate.weightSource)} · ${escapeHtml(fbaPolicyDetail(MARKET_CONFIGS[product.marketplace] || activeMarket))}${isManualFba ? ` · 自动值 ${escapeHtml(formatCurrencyWithCnyText(estimate.fee, product.marketplace))}` : ""}</small>
        </div>`);
    }
    byId("drawerProfitMargin").textContent = formatPercent(calculation.margin);
    byId("drawerProfitMargin").className = marginClass(calculation.margin);
    byId("drawerProfitValue").innerHTML = `${cnyCurrencyPairHtml(profitCny, product.marketplace, { suffix: " / 件", compact: true })}${calculation.dimensionalWeightEstimateKg ? "<small>体积重暂估 · 实际重量未知</small>" : calculation.weightAssumption ? "<small>最低档暂估 · 实际重量未知</small>" : ""}${calculation.purchaseCostAssumedZero ? "<small>预估利润率（未扣采购成本）</small>" : ""}<small class="profit-formula">经营利润率 =（${escapeHtml(formatCny(salePriceCny))} - ${escapeHtml(formatCny(totalCostCny))}）÷ ${escapeHtml(formatCny(salePriceCny))} × 100% = ${escapeHtml(formatPercent(calculation.margin))}</small>`;
  }

  function preliminaryReviewBlockingReason(product, weightKg = fbaEstimationWeightKg(product), mode = product?.fulfillmentMode) {
    if (isMonthlySalesFilterRequired(currentTaskInputMode(), activeRunCriteria.monthlySalesBand) && product?.dataMode !== "mock" && !hasQualifyingMonthlySales(product)) return "需取得当前商品同站点的有效月销量（至少 50），才可初审；未知销量不能视为不达标。";
    const assumption = applyMissingWeightProfitAssumption({ actualWeightKg: weightKg, fulfillmentMode: mode }, product?.marketplace || activeMarket.code, product);
    // Initial review remains separate from a complete profit estimate.
    if (weightKg == null && normalizeFulfillmentMode(mode) === "FBA" && !hasInvalidProductWeight(product)) return "";
    if (!(Number.isFinite(weightKg) && weightKg > 0) && !assumption.weightAssumption && !assumption.dimensionalWeightEstimateKg) return "重量尚未核验；请完成商品详情采集或填写真实重量。";
    return "";
  }

  function editorValidationMessage(product, values, preliminaryReview = false) {
    for (const [id, label, positive] of [["editSalePrice", "售价", true], ["editPurchaseCost", "1688 单件采购价", false], ["editPurchaseTotal", "整套采购成本", false], ["editFbaFee", "履约费用", false], ["editWeight", "重量", true]]) {
      const input = byId(id);
      const raw = String(input?.value ?? "").trim();
      const number = numberOrNull(raw);
      if (input?.validity?.badInput || (raw && (number === null || (positive ? number <= 0 : number < 0)))) return label + "必须是有效数字。";
    }
    if (values.pieceCount === null) return "标题件数必须是 1-10000 的整数。";
    // Saving a draft is independent of eligibility for initial review and complete profit.
    return preliminaryReview ? preliminaryReviewBlockingReason(product, values.billingWeight, values.fulfillmentMode) : "";
  }

  function syncDrawerApprovalButton(product, values, calculation) {
    const button = byId("approveProductButton");
    if (!button) return;
    if (isCollectionWriteLocked()) { button.disabled = true; button.title = "采集管理期间可查看和筛选，完成后可编辑"; return; }
    if (isAnalysisReadOnly(product)) { button.disabled = true; button.title = "初筛资料已交接，请在采购端继续确认"; return; }
    const changed = (before, after) => before !== after && (before == null || after == null || Math.abs(before - after) > 0.0001);
    const decisionInputsChanged = (
      changed(product.salePrice, values.salePrice)
      || changed(product.purchaseCost, values.purchaseCost)
      || normalizePieceCount(product.pieceCount, 1) !== values.pieceCount
      || changed(getFulfillmentFee(product), values.fulfillmentFee)
      || changed(product.billingWeight, values.billingWeight)
    );
    const alreadyApproved = product.reviewStatus === "approved" && !decisionInputsChanged;
    const productBusy = isProductSupplierBusy(product);
    const validationMessage = editorValidationMessage(product, values, true);
    button.disabled = productBusy || Boolean(validationMessage) || alreadyApproved;
    button.title = productBusy
      ? "这个商品正在匹配 1688，完成后可初审"
      : validationMessage
        ? validationMessage
        : alreadyApproved
          ? "当前商品已初审通过"
          : product.reviewStatus === "approved" ? "保存修改并重新初审通过" : "初审通过；未齐全的利润参数可后续补充";
  }

  function commitProfitEdits(showConfirmation, { preserveEditor = false, silentInvalid = false, preliminaryReview = false, persist = true } = {}) {
    if (collectionWriteBlocked({ notify: !silentInvalid })) return false;
    const product = products.find((item) => item.id === activeProductId);
    if (!product) return false;
    if (isAnalysisReadOnly(product)) return false;
    if (isProductSupplierBusy(product)) {
      if (!silentInvalid) showToast("这个商品正在匹配 1688，完成后即可修改。", "info", 4200);
      return false;
    }
    const values = getEditorValues();
    const validationMessage = editorValidationMessage(product, values, preliminaryReview);
    if (validationMessage) {
      setProfitEditorStatus("修改未保存：" + validationMessage, "error");
      if (!silentInvalid) showToast(validationMessage, "error");
      return false;
    }
    drawerProfitDraft = captureProfitEditorDraft();
    const normalized = {
      salePrice: values.salePrice === null ? null : roundMoney(values.salePrice),
      purchaseUnitCostCny: values.purchaseUnitCostCny,
      pieceCount: values.pieceCount,
      purchaseCost: totalPurchaseCostCny(values.purchaseUnitCostCny, values.pieceCount),
      fulfillmentFee: values.fulfillmentFee,
      billingWeight: values.billingWeight,
    };
    const changed = (before, after) => before !== after && (before == null || after == null || Math.abs(before - after) > 0.0001);
    const salePriceChanged = changed(product.salePrice, normalized.salePrice);
    const purchaseUnitCostChanged = changed(product.purchaseUnitCostCny, normalized.purchaseUnitCostCny);
    const purchaseManuallyEdited = values.purchasePricing.manuallyEdited;
    const pieceCountChanged = normalizePieceCount(product.pieceCount, 1) !== normalized.pieceCount;
    const purchaseCostChanged = changed(product.purchaseCost, normalized.purchaseCost);
    const weightChanged = changed(product.billingWeight, normalized.billingWeight);
    const previousFulfillmentFee = getFulfillmentFee(product);
    const fulfillmentFeeChanged = changed(previousFulfillmentFee, normalized.fulfillmentFee);
    const decisionInputsChanged = salePriceChanged || purchaseUnitCostChanged || pieceCountChanged || purchaseCostChanged || weightChanged || fulfillmentFeeChanged;
    const approvalInvalidated = product.reviewStatus === "approved" && decisionInputsChanged;
    product.salePrice = normalized.salePrice;
    product.purchaseUnitCostCny = normalized.purchaseUnitCostCny;
    product.pieceCount = normalized.pieceCount;
    if (pieceCountChanged) product.pieceCountSource = "manual";
    product.purchaseCost = normalized.purchaseCost;
    if (!normalizeFulfillmentMode(product.fulfillmentMode) && values.fulfillmentMode === "FBA") {
      product.fulfillmentMode = "FBA";
      product.fulfillmentModeSource = "assumed_fba_for_estimate";
    }
    if (product.fulfillmentMode === "FBM") product.fbmFee = normalized.fulfillmentFee;
    product.billingWeight = normalized.billingWeight;
    if (weightChanged) {
      product.weightSource = "产品手工覆盖";
      const profitInputs = ensureProductProfitInputs(product);
      profitInputs.actualWeightKg = normalized.billingWeight;
      profitInputs.weightSource = "产品手工覆盖";
      profitInputs.updatedAt = new Date().toISOString();
      product.manualProfitInputs = true;
      product.manualBillingWeight = true;
    }
    product.manualSalePrice = product.manualSalePrice || salePriceChanged;
    if (purchaseManuallyEdited) {
      product.manualPurchaseCost = true;
      product.costSource = "manual";
      if (!product.supplierSource) product.supplierSource = product.dataMode === "mock" ? "manual-demo-cost" : "manual-product-cost";
    }
    refreshSupplierTarget(product);
    const automaticEstimate = product.fulfillmentMode === "FBA" ? estimateFbaForEditor(product, values.billingWeight) : null;
    const manualFbaOverride = product.fulfillmentMode === "FBA" && Boolean(product.manualFbaFee || drawerFbaTouched);
    product.fbaEstimate = automaticEstimate;
    if (product.fulfillmentMode === "FBA") {
      if (manualFbaOverride) {
        product.fbaFee = normalized.fulfillmentFee;
        product.manualFbaFee = true;
        product.fbaFeeSource = "manual";
        product.fieldSources = { ...(product.fieldSources || {}), fbaFee: "manual" };
      } else if (automaticEstimate) {
        product.fbaFee = automaticEstimate.fee;
        product.manualFbaFee = false;
        product.fbaFeeSource = automaticFbaFeeSource(product);
        product.fieldSources = { ...(product.fieldSources || {}), fbaFee: automaticFbaFeeSource(product) };
      } else {
        product.fbaFee = null;
        product.manualFbaFee = false;
        product.fbaFeeSource = null;
        if (product.fieldSources) delete product.fieldSources.fbaFee;
      }
    } else if (product.fulfillmentMode === "FBM") {
      product.manualFbmFee = true;
    }
    rebuildProductMissing(product);
    updateProductComputed(product);
    const manualFulfillmentFeeChanged = product.fulfillmentMode === "FBM"
      ? fulfillmentFeeChanged
      : manualFbaOverride && fulfillmentFeeChanged;
    if (purchaseManuallyEdited) {
      if (product.dataMode !== "mock") {
        runState.mode = "mixed";
        runState.dataSource = "SellerSprite MCP + 人工采购成本与利润参数";
        setDataMode("mixed", "混合估算");
        updateHistorySummary();
      }
    } else {
      if ((manualFulfillmentFeeChanged || weightChanged || pieceCountChanged) && product.dataMode !== "mock") {
        runState.mode = "mixed";
        runState.dataSource = manualFulfillmentFeeChanged
          ? "SellerSprite MCP + 人工履约费"
          : pieceCountChanged
            ? "SellerSprite MCP + 人工采购件数"
            : "SellerSprite MCP + 人工商品重量 + FBA SOP 自动费";
        setDataMode("mixed", "混合估算");
        updateHistorySummary();
      }
    }
    if (approvalInvalidated) product.reviewStatus = "pending";
    byId("editPurchaseCost").dataset.purchaseBaseline = valueOrBlank(product.purchaseUnitCostCny);
    renderResults();
    if (preserveEditor) renderProfitPreview();
    else {
      populateDrawer(product);
      setDrawerTab("profit");
    }
    if (showConfirmation) {
      showToast(approvalInvalidated ? "成本已更新，原初审通过状态已撤回。" : "商品成本已更新，利润结果已重新计算。", approvalInvalidated ? "info" : "success");
    }
    if (persist) void persistProfitEditorEdits(product.id);
    return true;
  }

  function approveActiveProduct() {
    if (collectionWriteBlocked()) return;
    const product = products.find((item) => item.id === activeProductId);
    if (!product) return;
    if (isAnalysisReadOnly(product)) return;
    if (isProductSupplierBusy(product)) {
      showToast("这个商品正在匹配 1688，完成后即可初审。", "info", 4200);
      return;
    }
    clearProfitAutoCommit();
    if (!commitProfitEdits(false, { preliminaryReview: true })) return;
    product.reviewStatus = "approved";
    renderResults();
    void persistCurrentRun();
    const feedback = getApprovalFeedback(product);
    showToast(feedback.message, feedback.type, 5600);
    closeDrawer();
  }

  function rejectActiveProduct() {
    if (collectionWriteBlocked()) return;
    const product = products.find((item) => item.id === activeProductId);
    if (!product) return;
    if (isAnalysisReadOnly(product)) return;
    product.reviewStatus = "rejected";
    renderResults();
    void persistCurrentRun();
    showToast(`${product.asin} 已标记为淘汰。`, "info");
    closeDrawer();
  }

  async function rematchActiveProduct() {
    if (collectionWriteBlocked()) return;
    const product = products.find((item) => item.id === activeProductId);
    if (!product) return;
    if (isAnalysisReadOnly(product)) return;
    if (runState.archivedAt) return startArchived1688Matching([product], { rematch: true });
    if (!supplier1688LoggedIn) {
      showToast("请先登录 1688，再退回重新匹配。当前商品和手工成本不会丢失。", "error", 5200);
      return;
    }
    if (!product.imageUrl) {
      showToast("商品主图缺失，无法发起 1688 图片搜索。", "error", 5200);
      return;
    }
    if (analysisRunning) return;
    product.rematchCount += 1;
    product.reviewStatus = "rematch";
    product.supplierSearchStatus = "searching";
    product.supplierSearchErrorCode = null;
    populateDrawer(product);
    setDrawerTab("suppliers");
    try {
      const data = await request1688ImageSearch(product);
      apply1688SearchResult(product, data);
      runState.mode = "mixed";
      runState.dataSource = isManualCostProduct(product)
        ? "SellerSprite MCP + 1688 图片找厂 + 人工采购成本"
        : "SellerSprite MCP + 1688 图片找厂";
      setDataMode("mixed", "混合估算");
      updateHistorySummary();
      updateProductComputed(product);
      populateDrawer(product);
      setDrawerTab("suppliers");
      renderResults();
      void persistCurrentRun();
      showToast(
        product.supplierSearchStatus === "complete"
          ? `已刷新 10 家 1688 报价；${isManualCostProduct(product) ? "人工采购成本已保留。" : "已重算中间 6 家均价。"}`
          : product.supplierSearchStatus === "fallback_estimate"
            ? `未组成标准 10 家样本，已取图片相似度最高的 6 家并重算低置信度利润率。`
          : product.supplierSearchError,
        product.supplierSearchStatus === "complete" ? "success" : "info",
        5200,
      );
    } catch (error) {
      const queueWaiting = is1688QueueWaitError(error);
      const sessionExpired = !queueWaiting && is1688SessionError(error);
      const taskId = validProcurementTaskId(error?.details?.taskId);
      if (taskId) product.supplierProcurementTaskId = taskId;
      product.supplierSearchStatus = queueWaiting ? "queue_waiting" : sessionExpired ? "session_expired" : "failed";
      product.supplierSearchError = queueWaiting
        ? "1688 图片任务仍在队列中；原任务编号已保留，在线验证后将从这里继续。"
        : sessionExpired
          ? "1688 已断开；重新连接并在线验证后将自动继续，当前 Amazon 商品数据已保留。"
        : error.message || "1688 商品匹配失败";
      product.supplierSearchErrorCode = error.code || "1688_IMAGE_SEARCH_FAILED";
      if (queueWaiting || sessionExpired) apply1688SessionError(error);
      populateDrawer(product);
      renderResults();
      void persistCurrentRun();
      showToast(`1688 重新匹配失败：${product.supplierSearchError}`, "error", 5200);
    }
  }

  function normalizeFulfillmentMode(value) {
    const normalized = String(value || "").trim().toUpperCase();
    if (/(?:FBM|MFN|MERCHANT)/.test(normalized)) return "FBM";
    if (/(?:FBA|AMZ|AMAZON)/.test(normalized)) return "FBA";
    return null;
  }

  function ensureFulfillmentState(product) {
    if (isAnalysisReadOnly(product)) return product;
    product.fulfillmentMode = normalizeFulfillmentMode(product.fulfillmentMode || product.fulfillment);
    product.fbaFee = finiteOrNull(product.fbaFee);
    product.fbmFee = finiteOrNull(product.fbmFee);
    product.manualFbaFee = hasManualFulfillmentFee(product, "FBA");
    product.manualFbmFee = hasManualFulfillmentFee(product, "FBM");
    const savedSource = String(product.fulfillmentModeSource || "").trim().toLowerCase();
    if (savedSource) {
      product.fulfillmentModeSource = savedSource;
    } else if (product.fulfillmentMode && normalizeFulfillmentMode(product.fulfillment) === product.fulfillmentMode) {
      product.fulfillmentModeSource = "provider";
    } else if ((product.fulfillmentMode === "FBA" && product.manualFbaFee)
      || (product.fulfillmentMode === "FBM" && product.manualFbmFee)) {
      product.fulfillmentModeSource = "manual";
    } else if (product.fulfillmentMode === "FBA") {
      product.fulfillmentModeSource = "assumed_fba_for_estimate";
    } else if (product.fulfillmentMode) {
      product.fulfillmentModeSource = "legacy_unknown";
    } else {
      product.fulfillmentModeSource = null;
    }
    return product;
  }

  function fbaEstimationWeightKg(product) {
    if (usesItemWeightOnly(product)) return resolveManualWeightOverride(product)?.weightKg ?? automaticProfitWeightKg(product);
    const candidate = product?.manualProfitInputs
      ? product.billingWeight
      : product?.productWeight ?? product?.billingWeight;
    const weightKg = Number(candidate);
    return Number.isFinite(weightKg) && weightKg > 0 ? weightKg : null;
  }

  function assumeFbaForWeightedProduct(product) {
    if (isAnalysisReadOnly(product)) return false;
    ensureFulfillmentState(product);
    // Fulfillment may be estimated independently while full profit inputs are pending.
    if (product.fulfillmentMode) return false;
    product.fulfillmentMode = "FBA";
    product.fulfillmentModeSource = "assumed_fba_for_estimate";
    return true;
  }

  function isAssumedFba(product) {
    return product?.fulfillmentMode === "FBA"
      && product?.fulfillmentModeSource === "assumed_fba_for_estimate";
  }

  function fulfillmentModeSourceLabel(product) {
    if (product?.fulfillmentModeSource === "manual") return "人工选择";
    if (isAssumedFba(product)) return "按 FBA 假设估算（未获取履约方式）";
    if (product?.fulfillmentModeSource === "provider") return "Amazon / SellerSprite 返回";
    if (product?.fulfillmentModeSource === "demo") return "演示数据";
    return product?.fulfillmentMode ? "历史来源未记录" : "履约方式未获取";
  }

  function getFulfillmentFee(product) {
    ensureFulfillmentState(product);
    return product.fulfillmentMode === "FBM" ? product.fbmFee : product.fulfillmentMode === "FBA" ? product.fbaFee : null;
  }

  function fulfillmentFeeMissingLabel(mode) {
    const normalized = normalizeFulfillmentMode(mode);
    return normalized === "FBM" ? "FBM 履约费" : normalized === "FBA" ? "FBA 配送费" : "履约方式";
  }

  function fulfillmentFeeSource(product) {
    ensureFulfillmentState(product);
    if (product.fulfillmentMode === "FBM") return product.manualFbmFee ? "人工输入" : "未填写";
    if (product.fulfillmentMode === "FBA") {
      if (product.manualFbaFee) return "人工输入";
      if (product.fbaEstimate?.overweightCapped) return `FBA 超重封顶估算 · ${product.fbaEstimate.priceBandLabel}`;
      const market = MARKET_CONFIGS[product.marketplace] || activeMarket;
      if (market.code === "AU" && product.fbaEstimate) return `澳洲标准信封 · ${product.fbaEstimate.priceBandLabel}`;
      if (market.code === "CA" && product.fbaEstimate) return `加拿大旺季信封 · ${product.fbaEstimate.priceBandLabel} · 含3.5%附加费`;
      if (isAssumedFba(product) && product.fbaEstimate) return "按 FBA 假设估算 · FBA SOP 商品重量";
      return product.fbaEstimate ? "FBA SOP 商品重量自动估算" : "未计算";
    }
    return "履约方式未获取";
  }

  function isManualCostProduct(product) {
    return Boolean(product.manualPurchaseCost || product.costSource === "manual" || String(product.supplierSource || "").startsWith("manual"));
  }

  function fulfillmentPolicyShortLabel(product) {
    ensureFulfillmentState(product);
    if (product.fulfillmentMode === "FBM") return "FBM 履约费 · 人工输入";
    if (product.fulfillmentMode === "FBA") {
      if (product.manualFbaFee) return "FBA 配送费 · 人工输入";
      if (product.fbaEstimate?.overweightCapped) return "FBA 超重封顶估算 · 头程按实际重量";
      const market = MARKET_CONFIGS[product.marketplace] || activeMarket;
      if (isAssumedFba(product) && market.code !== "AU") return `按 FBA 假设估算 · ${/包裹重量/.test(profitWeightSourceLabel(product)) ? "包裹重量" : "商品重量"}`;
      return fbaPolicyShortLabel(market);
    }
    return "履约方式待补";
  }

  function fulfillmentPolicyDetail(product) {
    ensureFulfillmentState(product);
    if (product.fulfillmentMode === "FBM") return "FBM 履约费为人工输入，不套用美国 FBA 费率档位";
    if (product.fulfillmentMode === "FBA") {
      if (product.manualFbaFee) return "FBA 配送费为产品人工输入值";
      if (product.fbaEstimate?.overweightCapped) return `FBA 配送费按 ${product.fbaEstimate.weightCapG} g 最高档封顶估算；商品实际重量 ${product.fbaEstimate.actualWeightKg} kg 保留，国内运费与空运头程仍按实际重量计算。此估费不代表实际配送费或信封尺寸合规。`;
      if (isAssumedFba(product)) return `Amazon / SellerSprite 未返回履约方式；${fbaPolicyDetail(MARKET_CONFIGS[product.marketplace] || activeMarket)}`;
      return fbaPolicyDetail(MARKET_CONFIGS[product.marketplace] || activeMarket);
    }
    return "SellerSprite 未返回履约方式，需由产品人员选择 FBA 或 FBM";
  }

  function ensureProductProfitInputs(product, defaultsOverride = null) {
    if (isAnalysisReadOnly(product)) return product.profitInputs || {};
    const defaults = { ...(defaultsOverride || getDefaultProfitInputs(product.marketplace)) };
    const existing = product.profitInputs && typeof product.profitInputs === "object" ? product.profitInputs : {};
    const packageDimensions = parseDimensionsCm(product.fbaDimensions);
    const productDimensions = parseDimensionsCm(product.productDimensions);
    const dimensionsCm = resolveProductDimensionsCm(product);
    const automaticWeight = usesItemWeightOnly(product) ? automaticProfitWeightKg(product) : [product.productWeight, product.billingWeight]
      .map(finiteOrNull)
      .find((value) => value !== null && value > 0) ?? null;
    const formulaChanged = existing.formulaVersion !== PROFIT_FORMULA_VERSION;
    const previousVersionHasCurrentSharedRates = [
      "profit-workbook-airfreight-us2023-domestic-v3",
      "profit-workbook-au-weight-freight-us2023-domestic-v4",
      "profit-workbook-au-flat-fba-rates-v5",
      "profit-workbook-au-2026-weight-fba-rates-v6",
      "profit-workbook-au-2026-smallest-envelope-fba-v7",
      "profit-workbook-au-weight-only-fba-v8",
      "profit-workbook-au-weight-only-fba-v9",
      "profit-workbook-au-ca-envelope-fba-v10",
      "profit-workbook-au-ca-envelope-capped-fba-v11",
    ].includes(existing.formulaVersion);
    const previousVersionHasOnlyFbaMigration = [
      "profit-workbook-au-2026-weight-fba-rates-v6",
      "profit-workbook-au-2026-smallest-envelope-fba-v7",
      "profit-workbook-au-weight-only-fba-v9",
      "profit-workbook-au-ca-envelope-fba-v10",
      "profit-workbook-au-ca-envelope-capped-fba-v11",
    ].includes(existing.formulaVersion);
    const marketplace = String(product.marketplace || activeMarket.code).toUpperCase();
    const rateKeys = ["exchangeRate", "commissionRate", "fxLossRate", "marketingRate", "managementRate", "returnsRate", "purchaseTaxRate", "domesticFreightRateCnyPerKg", "airFreightRateCnyPerKg", "volumetricDivisor"];
    const resolved = { ...existing };
    for (const key of rateKeys) {
      const value = finiteOrNull(existing[key]);
      const resetAuAirFreight = formulaChanged
        && !previousVersionHasOnlyFbaMigration
        && (marketplace === "AU" || marketplace === "CA")
        && key === "airFreightRateCnyPerKg"
        && existing.airFreightRateSource !== "product_manual"
        && (value === null || value === DEFAULT_PROFIT_RATES.airFreightRateCnyPerKg || value === 60);
      const resetAuOperatingRate = formulaChanged
        && !previousVersionHasOnlyFbaMigration
        && (marketplace === "AU" || marketplace === "CA")
        && ((key === "managementRate" && (value === null || value === DEFAULT_PROFIT_RATES.managementRate))
          || (key === "returnsRate" && (value === null || value === DEFAULT_PROFIT_RATES.returnsRate))
          || (key === "commissionRate" && marketplace === "AU" && (value === null || value === DEFAULT_PROFIT_RATES.commissionRate)));
      const resetSharedRate = formulaChanged
        && !previousVersionHasCurrentSharedRates
        && ["purchaseTaxRate", "domesticFreightRateCnyPerKg"].includes(key);
      const resetForNewPolicy = resetSharedRate
        || resetAuAirFreight
        || resetAuOperatingRate;
      resolved[key] = !resetForNewPolicy && value !== null && value >= 0 ? value : defaults[key];
    }
    delete resolved.domesticFreightCny;
    resolved.formulaVersion = PROFIT_FORMULA_VERSION;
    resolved.purchaseTaxRateSource = formulaChanged && !previousVersionHasOnlyFbaMigration ? "default_4_percent" : existing.purchaseTaxRateSource || "default_4_percent";
    resolved.domesticFreightSource = formulaChanged && !previousVersionHasOnlyFbaMigration ? "product_weight_rate_estimate" : existing.domesticFreightSource || "product_weight_rate_estimate";
    resolved.airFreightActualWeightOnly = defaults.airFreightActualWeightOnly === true;
    resolved.airFreightRateSource = existing.airFreightRateSource === "product_manual"
      ? "product_manual"
      : resolved.airFreightRateCnyPerKg === defaults.airFreightRateCnyPerKg
        ? resolved.airFreightActualWeightOnly ? "au_workbook_45_cny_per_kg" : existing.airFreightRateSource || "market_default_air_freight"
        : existing.airFreightRateSource || "legacy_custom";
    const existingWeightKg = finiteOrNull(existing.actualWeightKg);
    const manualWeight = resolveManualWeightOverride(product);
    resolved.actualWeightKg = manualWeight
      ? manualWeight.weightKg
      : usesItemWeightOnly(product) ? automaticWeight : automaticWeight ?? existingWeightKg;
    if (resolved.actualWeightKg === null && hasInvalidProductWeight({ actualWeightKg: existing.actualWeightKg })) resolved.actualWeightKg = existing.actualWeightKg;
    resolved.dimensionsCm = dimensionsCm;
    resolved.dimensionSource = existing.dimensionSource || (packageDimensions ? "SellerSprite FBA 包装参数" : productDimensions ? "SellerSprite 商品参数回退" : "参数缺失");
    resolved.weightSource = manualWeight
      ? manualWeight.source
      : automaticWeight !== null
        ? product.weightSource || "商品重量"
        : usesItemWeightOnly(product) ? "Item Weight 尚未采集" : existing.weightSource || "商品重量缺失";
    resolved.cartonWeightKg = finiteOrNull(existing.cartonWeightKg);
    resolved.unitsPerCarton = finiteOrNull(existing.unitsPerCarton);
    resolved.updatedAt ||= product.collectedAt || new Date().toISOString();
    const weightPolicy = applyMissingWeightProfitAssumption({ ...resolved, fulfillmentMode: product.fulfillmentMode }, marketplace, product);
    for (const key of ["assumedWeightKg", "weightAssumption", "weightAssumptionMarket"]) {
      if (weightPolicy[key] !== undefined) resolved[key] = weightPolicy[key];
      else delete resolved[key];
    }
    product.profitInputs = resolved;
    return resolved;
  }

  function updateProductComputed(product) {
    if (isAnalysisReadOnly(product)) return;
    if (!Array.isArray(product.missing)) product.missing = [];
    product.complete = product.missing.length === 0;
    const calculation = calculateProfit(product);
    if (!calculation) {
      product.profitPendingReasons = profitCalculationMissingReasons(product);
      if (product.complete) {
        product.complete = false;
        if (!product.missing.includes("利润计算参数")) product.missing.push("利润计算参数");
      }
      product.margin = null;
      product.profitValue = null;
      product.totalCost = null;
      product.profitCalculation = null;
      return;
    }
    product.margin = calculation?.margin ?? null;
    product.profitPendingReasons = [];
    product.profitValue = calculation?.profit ?? null;
    product.totalCost = calculation?.totalCost ?? null;
    product.profitCalculation = {
      ...calculation,
      calculatedAt: new Date().toISOString(),
      parameterConfidence: calculation.airFreight?.confidence || "low",
    };
  }

  function profitCalculationMissingReasons(product) {
    const inputs = ensureProductProfitInputs(product);
    const reasons = [];
    if (!Number.isFinite(product.salePrice) || product.salePrice <= 0) reasons.push('售价');
    if (product.purchaseCost != null && product.purchaseCost !== '' && (!Number.isFinite(product.purchaseCost) || product.purchaseCost < 0)) reasons.push('有效采购成本');
    const weight = usesItemWeightOnly(product) ? resolveManualWeightOverride(product)?.weightKg ?? automaticProfitWeightKg(product)
      : finiteOrNull((product.manualProfitInputs ? inputs.actualWeightKg ?? product.billingWeight : null)
      ?? product.actualWeightKg
      ?? (inputs.airFreightActualWeightOnly ? product.productWeight : product.billingWeight)
      ?? inputs.actualWeightKg ?? product.billingWeight);
    const mode = normalizeFulfillmentMode(product.fulfillmentMode);
    const weightAssumption = applyMissingWeightProfitAssumption({ actualWeightKg: weight, fulfillmentMode: mode }, product.marketplace || activeMarket.code, product);
    if ((weight === null || weight <= 0) && !weightAssumption.weightAssumption && !weightAssumption.dimensionalWeightEstimateKg) reasons.push('商品重量或包裹重量');
    if (!mode) reasons.push('履约方式');
    const fee = product.fulfillmentFee ?? (mode === 'FBM' ? product.fbmFee : mode === 'FBA' ? product.fbaFee : null);
    if (!Number.isFinite(fee) || fee < 0) reasons.push(mode === 'FBA' ? product.fbaEstimate?.selectionStatus === 'fee_conflict' ? 'FBA费用差异过大，需核验规格' : 'FBA 配送费' : '配送费');
    if (!Number.isFinite(inputs.exchangeRate) || inputs.exchangeRate <= 0) reasons.push('汇率');
    return reasons;
  }

  function calculateProfit(subject = {}, weightSourceProduct = subject) {
    if (isAnalysisReadOnly(subject) && subject.profitCalculation) return subject.profitCalculation;
    const inputs = subject.profitInputs && typeof subject.profitInputs === "object"
      ? ensureProductProfitInputs(subject)
      : { ...getDefaultProfitInputs(subject.marketplace || activeMarket.code), ...(subject.resolvedProfitInputs || {}) };
    const mode = normalizeFulfillmentMode(subject.fulfillmentMode);
    const selectedFulfillmentFee = subject.fulfillmentFee ?? (mode === "FBM" ? subject.fbmFee : mode === "FBA" ? subject.fbaFee : null);
    const dimensionsCm = resolveProductDimensionsCm(subject);
    const actualWeightKg = usesItemWeightOnly(subject) ? resolveManualWeightOverride(subject)?.weightKg ?? automaticProfitWeightKg(subject)
      : finiteOrNull((subject.manualProfitInputs ? inputs.actualWeightKg ?? subject.billingWeight : null)
      ?? subject.actualWeightKg
      ?? (inputs.airFreightActualWeightOnly ? subject.productWeight : subject.billingWeight)
      ?? inputs.actualWeightKg
      ?? subject.billingWeight);
    const purchaseCostAssumedZero = subject.purchaseCost == null || subject.purchaseCost === '';
    const calculation = calculateProductProfit(applyMissingWeightProfitAssumption({
      ...inputs,
      salePrice: subject.salePrice,
      purchaseCostCny: purchaseCostAssumedZero ? 0 : subject.purchaseCost,
      fulfillmentMode: mode,
      fulfillmentFee: selectedFulfillmentFee,
      actualWeightKg,
      dimensionsCm,
      cartonWeightKg: subject.cartonWeightKg ?? inputs.cartonWeightKg,
      unitsPerCarton: subject.unitsPerCarton ?? inputs.unitsPerCarton,
    }, subject.marketplace || activeMarket.code, weightSourceProduct));
    return calculation ? { ...calculation, purchaseCostAssumedZero } : null;
  }

  function automaticFbaFeeSource(product) {
    if (product.fbaEstimate?.assumption === 'missing_weight_minimum_fba_estimate') return 'missing_weight_minimum_fba_estimate';
    const market = MARKET_CONFIGS[String(product?.marketplace || activeMarket.code).toUpperCase()] || activeMarket;
    return market.code === "AU" ? "au_standard_envelope_price_rate" : market.code === "CA" ? "ca_peak_envelope_price_rate" : "fba_sop_product_weight";
  }

  function applyAutomaticFba(product) {
    if (isAnalysisReadOnly(product)) return;
    ensureFulfillmentState(product);
    assumeFbaForWeightedProduct(product);
    if (product.fulfillmentMode !== "FBA") return;
    const market = MARKET_CONFIGS[String(product.marketplace || activeMarket.code).toUpperCase()] || activeMarket;
    if (product.manualFbaFee) {
      product.fbaEstimate = estimateWeightOnlyFbaFee(product);
      return;
    }
    const estimate = estimateWeightOnlyFbaFee(product);
    product.fbaEstimate = estimate;
    product.fieldSources = { ...(product.fieldSources || {}) };
    if (Number.isFinite(estimate?.fee)) {
      product.fbaFee = estimate.fee;
      product.fbaFeeSource = automaticFbaFeeSource(product);
      product.fieldSources.fbaFee = automaticFbaFeeSource(product);
    } else if (product.fbaFeeSource !== "manual") {
      product.fbaFee = null;
      product.fbaFeeSource = null;
      delete product.fieldSources.fbaFee;
    }
  }

  function estimateFbaForEditor(product, weightKg, salePrice = product.salePrice) {
    if (normalizeFulfillmentMode(product.fulfillmentMode) === "FBM") return null;
    if (weightKg === null && hasInvalidProductWeight(product)) return null;
    const sameWeight = product.billingWeight === weightKg || (Number.isFinite(product.billingWeight) && Number.isFinite(weightKg) && Math.abs(product.billingWeight - weightKg) < 0.0001);
    return estimateWeightOnlyFbaFee({
      ...product,
      productWeight: weightKg,
      billingWeight: weightKg,
      salePrice,
      weightSource: sameWeight ? product.weightSource : "产品手工覆盖",
      profitInputs: { ...product.profitInputs, actualWeightKg: weightKg,
        weightSource: sameWeight ? product.profitInputs?.weightSource : "product_manual" },
    });
  }

  function estimateWeightOnlyFbaFee(product) {
    const market = MARKET_CONFIGS[String(product?.marketplace || activeMarket.code).toUpperCase()] || activeMarket;
    const weightKg = fbaEstimationWeightKg(product);
    const dimensionsCm = resolveProductDimensionsCm(product);
    if (market.code === "AU" || market.code === "CA") {
      return estimateFbaByAvailableSpecifications(product, { marketplace: market.code, actualWeightKg: weightKg, dimensionsCm });
    }
    if (weightKg === null) return hasInvalidProductWeight(product) ? null
      : estimateMinimumFbaFee({ marketplace: product?.marketplace || activeMarket.code, salePrice: product.salePrice, dimensionsCm });
    const weightSource = product.weightSource || "商品重量";
    const estimate = estimateUs2023FbaFeeByProductWeight({
      actualWeightKg: weightKg,
      standardSizePolicy: FBA_WEIGHT_STANDARD_SIZE_POLICY,
    });
    if (!estimate) return null;
    return {
      ...estimate,
      weightSource,
      confidence: estimate.confidence === "standard" ? "标准" : "低",
      rateApplicability: market.code === "US" ? "美国站 SOP 重量代理" : "非美国站按美国 SOP 费率名义估算",
      fbaPromoApplied: false,
    };
  }

  function parseDimensionsCm(value) {
    return parseProductDimensionsCm(value);
  }

  function buildDemoSuppliers(product) {
    if (!Number.isFinite(product.purchaseCost)) return [];
    const available = Math.min(product.supplierAvailable ?? REQUIRED_1688_QUOTES, REQUIRED_1688_QUOTES, SUPPLIER_NAMES.length);
    const enough = available === REQUIRED_1688_QUOTES;
    const offsets = [-0.11, -0.075, -0.05, -0.025, -0.01, 0.01, 0.03, 0.055, 0.075, 0.105];
    return Array.from({ length: available }, (_, index) => {
      return {
        rank: index + 1,
        supplierId: `demo-supplier-${index + 1}`,
        name: SUPPLIER_NAMES[index],
        offerId: `demo-offer-${index + 1}`,
        url: "",
        unitPriceCny: roundMoney(product.purchaseCost * (1 + offsets[index])),
        price: roundMoney(product.purchaseCost * (1 + offsets[index])),
        unit: "件",
        moq: product.moq,
        priceTier: `MOQ ${product.moq}`,
        spec: "同规格演示",
        factoryVerified: index % 3 !== 2,
        candidateImageUrl: "",
        imageSimilarityScore: 0.88 + ((index % 5) * 0.02),
        imageSimilarityDecision: "passed",
        similarityMethod: "mock-demo-visual",
        similarityVersion: "mock-v1",
        supplierMatchDecision: "passed",
        included: enough && index >= 2 && index < REQUIRED_1688_QUOTES - 2,
        excludedReason: enough
          ? index < 2 ? "excluded_low_outlier" : index >= REQUIRED_1688_QUOTES - 2 ? "excluded_high_outlier" : "included_middle_six"
          : "insufficient_valid_quotes",
      };
    });
  }

  function bindDialogs() {
    const dialog = byId("contextDialog");
    byId("helpButton")?.addEventListener("click", () => {
      lastDialogFocusedElement = document.activeElement;
      dialog.hidden = false;
      requestAnimationFrame(() => dialog.classList.add("is-open"));
      byId("closeContextButton")?.focus();
    });
    byId("closeContextButton")?.addEventListener("click", closeContextDialog);
    dialog?.addEventListener("click", (event) => {
      if (event.target === dialog) closeContextDialog();
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Tab") {
        const drawer = byId("drawerBackdrop");
        const manualCostDialog = byId("manualCostDialog");
        const activeModal = manualCostDialog && !manualCostDialog.hidden
          ? byId("manualCostForm")
          : drawer && !drawer.hidden
          ? $(".detail-drawer", drawer)
          : dialog && !dialog.hidden ? $(":scope > div", dialog) : null;
        if (activeModal) trapModalFocus(event, activeModal);
        return;
      }
      if (event.key === "Escape") {
        const manualCostDialog = byId("manualCostDialog");
        if (manualCostDialog && !manualCostDialog.hidden) {
          closeManualCostDialog();
          return;
        }
        if (dialog && !dialog.hidden) {
          closeContextDialog();
          return;
        }
        closeDrawer();
        closeMobileMenu();
      }
    });
  }

  function trapModalFocus(event, modal) {
    const focusable = $$('button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])', modal)
      .filter((element) => !element.hidden && element.getClientRects().length > 0);
    if (!focusable.length) {
      event.preventDefault();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!modal.contains(document.activeElement)) {
      event.preventDefault();
      first.focus();
    } else if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function closeContextDialog() {
    const dialog = byId("contextDialog");
    if (!dialog || dialog.hidden) return;
    dialog.classList.remove("is-open");
    setTimeout(() => {
      dialog.hidden = true;
      if (lastDialogFocusedElement?.isConnected) lastDialogFocusedElement.focus();
    }, 160);
  }

  function bindHistory() {
    byId("historyList")?.addEventListener("click", (event) => {
      const folderButton = event.target.closest("[data-history-folder-run-id]");
      if (folderButton) {
        void openHistoryRunFolder(folderButton.dataset.historyFolderRunId, folderButton);
        return;
      }
      const button = event.target.closest("[data-history-run-id]");
      if (button) void loadHistoryRun(button.dataset.historyRunId, button);
    });
  }

  function updateHistorySummary() {
    renderHistoryList();
  }

  function renderHistoryList() {
    const list = byId("historyList");
    if (!list) return;
    if (!runHistory.length) {
      list.innerHTML = '<div class="history-empty-line"><span></span><p>暂无已保存任务</p><span></span></div>';
      return;
    }
    list.innerHTML = runHistory.map((summary) => {
      const market = MARKET_CONFIGS[summary.marketplace] || MARKET_CONFIGS.NL;
      const timestamp = summary.completedAt || summary.startedAt || summary.updatedAt;
      const time = timestamp ? new Date(timestamp) : null;
      const validTime = time && !Number.isNaN(time.getTime());
      const dateLabel = validTime ? time.toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" }) : "--";
      const timeLabel = validTime ? time.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false }) : "--:--";
      const statusLabel = summary.archivedAt || summary.status === "cancelled"
        ? "已归档 · 可编辑初审" : summary.status === "paused" ? "已暂停" : summary.status === "running" ? "采集中" : summary.status === "failed"
        ? "未完成"
        : summary.status === "collecting" ? "已采集" : summary.mode === "mock" ? "模拟数据" : summary.mode === "mixed" ? "混合估算" : "已完成";
      const statusState = summary.status === "failed" ? "error" : summary.mode || "live";
      const callsByTool = Object.entries(summary.sellerSpriteCallsByTool || {})
        .map(([tool, count]) => `${tool} ${count}`)
        .join(" · ");
      const callTitle = callsByTool ? `SellerSprite：${callsByTool}` : "SellerSprite：本任务未调用商品工具";
      const canOpen = summary.hasSnapshot !== false;
      return `<article class="history-item${summary.id === runState.id ? " is-current" : ""}">
        <div class="history-time"><strong>${escapeHtml(dateLabel)}</strong><span>${escapeHtml(timeLabel)}</span></div>
        <div class="history-main">
          <span class="status-label" data-state="${escapeHtml(statusState)}">${escapeHtml(statusLabel)}</span>
          <h2>${escapeHtml(market.nameZh)}${summary.inputMode === "asins" ? " ASIN 批次" : "竞品店铺"} · ${summary.productCount} 个候选</h2>
          <p>${summary.inputMode === "asins" ? `${summary.importedAsinCount ?? summary.productCount} 个导入 ASIN` : `${summary.storeCount} 个店铺`} · ${summary.completeCount} 个数据完整 · ${summary.approvedCount} 个初审通过 · <b title="${escapeHtml(callTitle)}">SellerSprite ${summary.sellerSpriteCalls} 次</b></p>
        </div>
        <div class="history-actions">
          <button class="history-action" type="button"${canOpen ? ` data-history-run-id="${escapeHtml(summary.id)}"` : " disabled"} aria-label="${canOpen ? `查看该任务的 ${summary.productCount} 个候选商品` : "任务快照尚未完成"}" title="${canOpen ? "查看结果" : "任务快照尚未完成"}"><i data-lucide="arrow-up-right" aria-hidden="true"></i><span>查看结果</span></button>
          <button class="history-action history-folder" type="button" data-history-folder-run-id="${escapeHtml(summary.id)}" aria-label="打开该任务的记录文件夹" title="打开文件夹"><i data-lucide="folder-open" aria-hidden="true"></i><span>打开文件夹</span></button>
        </div>
      </article>`;
    }).join("");
    initIcons();
  }

  function exportTaskIdForProduct(product) {
    const batchId = String(runState.id || "").trim();
    const productId = String(product?.id || product?.sourceAsin || product?.asin || "").trim();
    return [batchId, productId].filter(Boolean).join(":");
  }

  function setExportActionsDisabled(disabled, candidates) {
    const locked = Boolean(disabled || isCollectionWriteLocked());
    if (locked) {
      for (const id of ["exportAllCandidatesButton", "exportApprovedProductsButton", "exportAnalysisHandoffButton"]) {
        const button = byId(id);
        if (button) button.disabled = true;
      }
      return;
    }
    candidates ??= getFilteredProducts();
    const approved = getExportProducts("approved", candidates);
    for (const [id, rows] of [["exportAllCandidatesButton", candidates], ["exportApprovedProductsButton", approved], ["exportAnalysisHandoffButton", approved]]) {
      const button = byId(id);
      if (button) button.disabled = locked || rows.length === 0;
    }
  }

  async function requestSpreadsheetExport(payload) {
    const response = await fetch("/api/exports/xlsx", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      cache: "no-store",
      signal: AbortSignal.timeout(15 * 60_000),
    });
    if (!response.ok) {
      let message = `Excel 导出失败（HTTP ${response.status}）。`;
      try {
        const body = await response.json();
        message = body?.error?.message || message;
      } catch (_) {
        // Keep the HTTP fallback when the server response is not JSON.
      }
      throw new Error(message);
    }
    const body = await response.json();
    const savedFilePath = String(body?.data?.savedFilePath || "").trim();
    if (!body?.ok || !savedFilePath) throw new Error("Excel 已生成，但本地服务未返回保存位置。");
    return {
      savedFilePath,
      savedFileName: String(body.data.savedFileName || "").trim(),
      exportDirectory: String(body.data.exportDirectory || "").trim(),
      embeddedImageCount: Number(body.data.imageAudit?.embedded) || 0,
      missingImageCount: Number(body.data.imageAudit?.missing) || 0,
      failedImageCount: Number(body.data.imageAudit?.failed) || 0,
    };
  }

  function isProductSupplierBusy(product) {
    return (!runState.archivedAt || archivedSupplierMatchingEnabled()) && product?.supplierSearchStatus === "searching";
  }

  function isAnalysisReadOnly(product) {
    return product?.analysisHandoff?.owner === "procurement" || analysisHandoffPendingIds.has(product?.id) || analysisVersionPendingIds.has(product?.id);
  }

  function analysisVersionBlockedReason(product) {
    if (isCollectionWriteLocked()) return "采集管理期间可查看和筛选，完成后可编辑。";
    if (analysisVersionPendingIds.has(product?.id)) return "新的分析版本正在保存，请稍候。";
    if (exportRunning || analysisHandoffPendingIds.has(product?.id)) return "当前交接文件正在保存，完成后可创建新的分析版本。";
    if (analysisRunning || hasActive1688Work()) return "当前采集或匹配正在进行，完成后可创建新的分析版本。";
    return "";
  }

  function buildNewAnalysisVersion(product, createdAt) {
    if (product?.analysisHandoff?.owner !== "procurement") return null;
    const prior = structuredClone(product);
    delete prior.analysisHistory;
    const version = Number.isSafeInteger(product.analysisDraft?.version) && product.analysisDraft.version > 0 ? product.analysisDraft.version : 1;
    const draft = structuredClone(product);
    draft.analysisHistory = [...(draft.analysisHistory || []), { version, archivedAt: createdAt, product: prior }];
    draft.analysisDraft = { version: version + 1, createdAt, basedOnRevision: product.analysisHandoff.revision };
    // Keep the last receipt as the real predecessor while returning this draft to analysis.
    draft.analysisHandoff = { ...draft.analysisHandoff, owner: "analysis" };
    draft.reviewStatus = "pending";
    delete draft.analysisProfitInputs;
    delete draft.resolvedProfitInputs;
    return draft;
  }

  function renderAnalysisVersionActions(product) {
    const button = byId("newAnalysisVersionButton");
    const hint = byId("analysisVersionActionHint");
    if (!button || !hint) return;
    const canStart = product.analysisHandoff?.owner === "procurement" || analysisVersionPendingIds.has(product.id);
    button.hidden = !canStart;
    const reason = analysisVersionBlockedReason(product);
    button.disabled = Boolean(reason);
    button.title = reason || "保留已交接快照，创建可编辑的本地分析版本；不会自动抓取或匹配。";
    hint.hidden = !canStart && !product.analysisDraft;
    hint.textContent = reason || (canStart
      ? "可创建新的分析版本，继续手工编辑、筛选和匹配。已交接资料保留，采购端正式详细利润继续由采购端维护。"
      : `当前为第 ${product.analysisDraft?.version} 版独立初步分析，可继续编辑、筛选和匹配；之前的交接快照已保留。`);
    const history = byId("analysisVersionHistory");
    if (!history) return;
    const records = Array.isArray(product.analysisHistory) ? product.analysisHistory : [];
    history.hidden = !records.length;
    history.innerHTML = records.length ? `<summary>已保留 ${records.length} 份交接快照</summary>${records.map((entry) => {
      const snapshot = entry.product || {};
      const calculation = snapshot.profitCalculation;
      return `<div class="analysis-version-snapshot"><strong>第 ${escapeHtml(entry.version)} 版 · ${escapeHtml(snapshot.asin || "")}</strong><span>初步利润率 ${formatPercent(calculation?.margin ?? snapshot.margin)}</span><small>交接时间 ${escapeHtml(snapshot.analysisHandoff?.exportedAt || entry.archivedAt || "")}</small><small>资料版本 ${escapeHtml(snapshot.analysisHandoff?.revision || "")}</small></div>`;
    }).join("")}` : "";
  }

  async function createNewAnalysisVersion() {
    const original = products.find((product) => product.id === activeProductId);
    if (!original || original.analysisHandoff?.owner !== "procurement") return;
    const reason = analysisVersionBlockedReason(original);
    if (reason) { showToast(reason, "info", 4800); return; }
    const originalRunId = runState.id;
    const draft = buildNewAnalysisVersion(original, new Date().toISOString());
    clearProfitAutoCommit();
    analysisVersionPendingIds.add(original.id);
    products = products.map((product) => product === original ? draft : product);
    renderAnalysisVersionActions(draft);
    try {
      if (!await persistCurrentRun({ notify: true })) {
        products = products.map((product) => product === draft ? original : product);
        showToast("新版本未保存，原交接快照仍受保护，请稍后重试。", "error", 5500);
        return;
      }
      showToast(`已创建第 ${draft.analysisDraft.version} 版初步分析；可继续编辑、筛选或重新匹配。`, "success", 5500);
    } finally {
      analysisVersionPendingIds.delete(original.id);
      if (runState.id === originalRunId) {
        renderResults();
        if (activeProductId === original.id) populateDrawer(products.find((product) => product.id === original.id));
      }
    }
  }

  function productSourceStoreCriteria(product) {
    const sources = Array.isArray(product?.sourceStores) ? product.sourceStores : [];
    return (storeList?.stores || []).flatMap((store, index) => {
      const matches = (store.sellerId && store.sellerId === product?.sellerId)
        || sources.some((source) => (source.sellerId && source.sellerId === store.sellerId)
          || (Number.isInteger(source.storeIndex) && source.storeIndex === index)
          || (source.rowNumbers || []).some((row) => (store.rowNumbers || []).includes(row)));
      return matches ? [{ sellerId: store.sellerId || null, sellerName: store.sellerName || null, marketplace: store.marketplace || runState.marketplace, storeIndex: index, rowNumbers: store.rowNumbers || [], importBlocked: store.importBlocked === true, criteria: store.criteria || {}, criteriaSource: store.criteriaSource || null, rawCriteria: store.rawCriteria || store.criteriaSource?.rows?.map((row) => ({ rowNumber: row.rowNumber, ...row.rawCriteria })) || null }] : [];
    });
  }

  function buildAnalysisHandoffInput({ selectedProducts = products } = {}) {
    const criteria = { amazon: { ...activeRunCriteria }, results: { query: byId("resultSearch")?.value.trim() || "", minMargin: numberOrNull(byId("resultMinMargin")?.value), completeOnly: byId("resultsCompleteToggle")?.checked === true } };
    const prepared = selectedProducts.map((product) => {
      const copy = structuredClone(product);
      copy.profitInputs = { ...ensureProductProfitInputs(copy) };
      copy.storeCriteria = productStoreCriteria(product, activeRunCriteria);
      copy.sourceStoreCriteria = productSourceStoreCriteria(product);
      return copy;
    });
    const coverage = buildCurrentAnalysisCoverage();
    return { runState: { ...runState, inputMode: currentTaskInputMode(), analysisCoverage: coverage }, products: prepared, criteria };
  }

  function buildCurrentAnalysisCoverage() {
    const sourceTimes = [runState.startedAt, ...products.map((product) => product.collectedAt), ...(runState.storeVisits || []).flatMap((visit) => [visit.collectedAt, visit.coverageEvidence?.collectedAt, ...(visit.pageAudit || []).map((page) => page.collectedAt)])]
      .map((value) => Date.parse(value || "")).filter(Number.isFinite);
    const snapshotAt = sourceTimes.length ? new Date(sourceTimes.reduce((latest, time) => Math.max(latest, time), 0)).toISOString() : null;
    const coverage = summarizeAnalysisCoverage({ stores: storeList?.stores || [], storeVisits: runState.storeVisits || [], products, inputMode: currentTaskInputMode(), marketplace: runState.marketplace, createdAt: snapshotAt });
    runState.analysisCoverage = coverage;
    return coverage;
  }

  function renderStoreImportWarnings() {
    const blocked = (storeList?.stores || []).filter((store) => store.importBlocked === true);
    const otherMarkets = (storeList?.rejectedRows || []).filter((row) => row.code === "MARKETPLACE_MISMATCH");
    const notes = [];
    if (blocked.length) notes.push(`${blocked.length} 个店铺的重复行筛选条件冲突，已暂停这些店铺的采集，请核对源表行号`);
    if (otherMarkets.length) notes.push(`${otherMarkets.length} 行属于其他站点，未导入当前 ${activeMarket.code} 批次，请切换对应站点单独导入`);
    const element = byId("storeImportWarnings");
    if (element) { element.hidden = !notes.length; element.textContent = notes.join("；") + (notes.length ? "。" : ""); }
    return notes;
  }

  function renderAnalysisHandoffSummary(candidates = getFilteredProducts()) {
    if (!byId("analysisStageSummary")) return;
    const coverage = buildCurrentAnalysisCoverage();
    const counts = coverage.counts;
    setText("analysisCoverageStatus", coverage.status === "not_started" ? "尚未采集" : coverage.status === "visible_scope_complete" ? "可见范围已采集" : "部分完成");
    setText("analysisCoverageDetail", isAsinImport()
      ? `导入 ${importedItemCount()} 个 ASIN · 已纳入 ${products.length} 个 · 详情成功 ${coverage.detail_counts.success}/${products.length}。按导入清单采集，未枚举店铺或自动扩展商品范围。`
      : `店铺 ${counts.visited_stores}/${counts.requested_stores} · 已访问 ${counts.pages_visited} 页 · 详情成功 ${coverage.detail_counts.success}/${products.length}${counts.known_missing_asins ? ` · 逐店待枚举约 ${counts.known_missing_asins} 个` : ""}。Amazon 可见结果和全部变体范围不同，当前不声明全店全部采集完成。`);
    const button = byId("exportAnalysisHandoffButton");
    if (button) {
      const reviewed = getExportProducts("approved", candidates);
      const updating = reviewed.some((product) => isProductSupplierBusy(product));
      const disabledReason = isCollectionWriteLocked() ? "后台采集完成后可编辑、初审和导出。" : exportRunning ? "导出正在保存，请等待完成。" : analysisVersionPendingIds.size ? "新的分析版本正在保存，请等待完成。" : !runState.id ? "请先导入店铺或 ASIN 并开始分析任务。" : runState.mode === "mock" ? "演示数据仅用于体验，不能导出采购交接资料。" : !reviewed.length ? "请先人工初审通过需要导出的商品。" : updating ? "已初审商品的报价正在更新，结束后即可导出。" : "";
      button.disabled = Boolean(disabledReason);
      button.title = disabledReason || "可选：仅将您已人工初审的商品保存为Excel及JSON；资料缺项保留并标记草稿。";
      setText("analysisExportAvailability", disabledReason || "可选协同仅使用已人工初审范围，资料缺项会保留并标记草稿。");
    }
    renderStoreImportWarnings();
  }

  async function exportAnalysisHandoff() {
    if (collectionWriteBlocked()) return;
    if (exportRunning || analysisVersionPendingIds.size) return;
    if (!runState.id || runState.mode === "idle" || runState.mode === "mock") { showToast("请先完成真实店铺采集和初步利润分析。", "info", 4800); return; }
    if (manualCostDraft && isManualCostDirty()) {
      saveManualCost({ allowIncomplete: true });
      if (manualCostDraft && isManualCostDirty()) { showToast("请先保存正在填写的成本，再导出交接资料。", "info", 4800); return; }
    }
    if (profitAutoCommitTimer !== null) {
      clearProfitAutoCommit();
      if (!commitProfitEdits(false, { preserveEditor: true })) return;
    }
    if (!await flushSupplierChoices() || collectionWriteBlocked() || exportRunning) return;
    const exportRunId = runState.id;
    const market = MARKET_CONFIGS[runState.marketplace];
    const exportRows = getExportProducts("approved");
    if (!exportRows.length) { showToast(isMonthlySalesFilterRequired(currentTaskInputMode(), activeRunCriteria.monthlySalesBand) ? "暂无具备有效月销量至少 50 且已初审通过的商品。" : "暂无已初审通过的商品。", "info", 4800); return; }
    if (!market || exportRows.some((product) => product.marketplace !== market.code)) { showToast("已初审商品存在站点不一致，未导出。", "error", 4800); return; }
    if (exportRows.some((product) => isProductSupplierBusy(product))) { showToast("已初审商品的报价正在更新，结束后即可导出。", "info", 4800); return; }
    // Freeze the user's manual selection once; workbook and JSON share this same snapshot.
    const selectedSnapshot = exportRows.map((product) => structuredClone(product));
    const worksheet = createSpreadsheetExportPayload(selectedSnapshot, market, "已初审产品");
    const input = buildAnalysisHandoffInput({ selectedProducts: selectedSnapshot });
    const reviewedRecords = selectManuallyReviewedProducts(input);
    const originals = new Map(products.map((product) => [product.id, product]));
    exportRunning = true;
    exportRows.forEach((product) => analysisHandoffPendingIds.add(product.id));
    setExportActionsDisabled(true);
    if (activeProductId) populateDrawer(originals.get(activeProductId));
    showToast(`正在保存您已初审的 ${exportRows.length} 个商品及可选交接资料…`, "info", 15 * 60_000);
    try {
      if (!await persistCurrentRun({ notify: true })) throw new Error("当前任务尚未保存，已停止交接导出。");
      const response = await apiRequest("/api/exports/analysis-handoff", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...input, worksheet }), timeout: 15 * 60_000 });
      if (runState.id !== exportRunId) throw new Error(`交接文件已保存到 ${response.savedFilePath}，当前任务已切换，请重新载入原任务核对交接状态。`);
      if (!response?.savedFilePath || !response?.packageId || !Array.isArray(response.products)) throw new Error("服务未返回完整交接回执，请核对导出目录。");
      const expected = new Set(exportRows.map((product) => product.id));
      if (response.products.length !== expected.size || response.products.some((item) => !expected.has(item.product_id) || !item.revision || !item.facts_revision || !item.screening_revision || !item.source_version)) throw new Error("交接回执与本次人工初审范围不一致，未改变商品归属，请核对导出文件。");
      for (const record of response.products) {
        const product = originals.get(record.product_id);
        const preliminary = reviewedRecords.find((item) => item.product_id === record.product_id).preliminary_profit;
        product.profitInputs = { ...product.profitInputs, ...preliminary.inputs, formulaVersion: preliminary.formula_version };
        product.profitCalculation = preliminary.result ? { ...preliminary.result } : null;
        product.margin = preliminary.result?.margin ?? null; product.profitValue = preliminary.result?.profit ?? null; product.totalCost = preliminary.result?.totalCost ?? null;
        product.analysisHandoff = { owner: "procurement", packageId: response.packageId, revision: record.revision, facts_revision: record.facts_revision, screening_revision: record.screening_revision, source_version: { ...record.source_version }, exportedAt: response.createdAt, savedFilePath: response.savedFilePath };
      }
      const persisted = await persistCurrentRun({ notify: true });
      const outputs = [response.savedFilePath, response.workbook?.savedFilePath].filter(Boolean).join("；");
      const draftNote = response.readiness?.draft ? `其中 ${response.readiness.draft_count} 条资料需补充或核对，交接包已标记草稿，仍保留您的全部选择。` : "可选交接文件已保存到本机。";
      showToast(`已保存您初审的 ${exportRows.length} 个商品：${outputs}。${response.workbookError || draftNote}${persisted ? "" : "交接状态尚未保存，请保留本页并重试保存。"}`, response.workbookError || !persisted || response.readiness?.draft ? "info" : "success", 12000);
    } catch (error) { showToast(error?.message || "交接导出失败，当前商品已保留。", "error", 8000); }
    finally {
      analysisHandoffPendingIds.clear(); exportRunning = false; setExportActionsDisabled(false); renderResults();
      if (activeProductId && originals.has(activeProductId)) populateDrawer(originals.get(activeProductId));
    }
  }

  async function exportProducts(scope = "approved") {
    if (collectionWriteBlocked()) return;
    if (exportRunning) {
      showToast("Excel 正在生成，请等待当前导出完成。", "info", 3600);
      return;
    }
    if (runState.mode === "mock") {
      showToast("模拟演示数据不可导出为运营终审表，请先完成店铺分析任务。", "error", 4800);
      return;
    }
    if (!await flushSupplierChoices() || collectionWriteBlocked() || exportRunning) return;
    const exportScope = scope === "all" ? "all" : "approved";
    const exportRows = getExportProducts(exportScope);
    if (!exportRows.length) {
      showToast(
        exportScope === "all" ? "当前任务暂无候选产品。" : "暂无已初审通过的产品，请先完成产品初审。",
        "error",
        4800,
      );
      return;
    }
    const exportMarket = MARKET_CONFIGS[runState.marketplace];
    if (!exportMarket || exportRows.some((product) => product.marketplace !== exportMarket.code)) {
      showToast("检测到跨站商品，已阻止导出。请重新运行当前站点任务。", "error", 5200);
      return;
    }
    const exportLabel = exportScope === "all" ? "当前筛选候选产品" : "当前筛选已初审产品";
    exportRunning = true;
    setExportActionsDisabled(true);
    showToast(`正在生成 ${exportRows.length} 个商品的 Excel，并保存到 ${EXPORT_DIRECTORY_LABEL}…`, "info", 15 * 60_000);
    try {
      const fileName = `Scout_${exportMarket.code}_${exportLabel}_${formatDateForFile(new Date())}.xlsx`;
      const payload = {
        ...createSpreadsheetExportPayload(exportRows, exportMarket, exportLabel),
        fileName,
      };
      const result = await requestSpreadsheetExport(payload);
      const incompleteCount = exportRows.filter((product) => !product.complete).length;
      const lowConfidenceCount = exportRows.filter(isLowConfidenceSupplierEstimate).length;
      const imageIssueCount = result.missingImageCount + result.failedImageCount;
      const notes = [
        `已嵌入 ${result.embeddedImageCount} 张竞品图片`,
        imageIssueCount ? `${imageIssueCount} 张图片未嵌入，原因已写入表格` : "",
        incompleteCount ? `${incompleteCount} 个商品存在缺失字段` : "",
        lowConfidenceCount ? `${lowConfidenceCount} 个商品使用 1688 低匹配度估算` : "",
      ].filter(Boolean);
      showToast(`已保存 ${exportRows.length} 个${exportLabel}，文件位置：${result.savedFilePath}。${notes.join("；")}。`, imageIssueCount || incompleteCount || lowConfidenceCount ? "info" : "success", 8000);
    } catch (error) {
      showToast(error?.message || "Excel 导出失败。", "error", 6200);
    } finally {
      exportRunning = false;
      setExportActionsDisabled(false);
    }
  }

  function supplierImageAuditForExport(product) {
    return (Array.isArray(product?.suppliers) ? product.suppliers : []).map((supplier) => {
      const components = supplier?.imageSimilarityComponents && typeof supplier.imageSimilarityComponents === "object"
        ? supplier.imageSimilarityComponents
        : {};
      return {
        rank: supplier.rank ?? null,
        supplierId: supplier.supplierId || "",
        name: supplier.name || "",
        offerId: supplier.offerId || "",
        url: supplier.url || "",
        candidateImageUrl: supplier.candidateImageUrl || "",
        unitPriceCny: finiteOrNull(supplier.unitPriceCny ?? supplier.price),
        unit: supplier.unit || "",
        moq: finiteOrNull(supplier.moq),
        priceTier: supplier.priceTier || "",
        spec: supplier.spec || "",
        factoryVerified: Boolean(supplier.factoryVerified),
        included: Boolean(supplier.included),
        excludedReason: supplier.excludedReason || "",
        imageSimilarityScore: finiteOrNull(supplier.imageSimilarityScore),
        imageSimilarityDecision: supplier.imageSimilarityDecision || "not_evaluated",
        similarityMethod: supplier.similarityMethod || "",
        similarityVersion: supplier.similarityVersion || "",
        imageSimilarityComponents: {
          perceptualHash: finiteOrNull(components.perceptualHash),
          differenceHash: finiteOrNull(components.differenceHash),
          structuralSimilarity: finiteOrNull(components.structuralSimilarity),
          colorHistogram: finiteOrNull(components.colorHistogram),
        },
        imageSimilarityErrorCode: supplier.imageSimilarityErrorCode || "",
        costSelectionDecision: supplier.costSelectionDecision || "",
        priceRank: supplier.priceRank ?? null,
        sourceImageSha256: supplier.sourceImageSha256 || "",
        candidateImageSha256: supplier.candidateImageSha256 || "",
        comparedAt: supplier.comparedAt || "",
      };
    });
  }

  function exportMissingFields(product) {
    const missing = new Map();
    const add = (field, reason, { blocking = false } = {}) => {
      if (!field || !reason || missing.has(field)) return;
      missing.set(field, `${field}：${reason}${blocking ? "（影响利润计算）" : ""}`);
    };
    const hasNumber = (value) => Number.isFinite(value);
    const amazonOnly = product.analysisSourceMode === "amazon_only";
    const isAu = String(product.marketplace || "").toUpperCase() === "AU";
    const detailFailure = sellerSpriteDetailFailureLabel(product);
    const competitorFailure = product.competitorLookupStatus === "success"
      ? ""
      : sellerSpriteCompetitorLookupLabel(product);
    const sellerSpriteReason = amazonOnly
      ? "本次未接入 SellerSprite"
      : detailFailure || competitorFailure || "SellerSprite 接口未返回";
    const amazonReason = detailFailure || "Amazon 商品页未返回";

    (Array.isArray(product.missing) ? product.missing : []).forEach((field) => {
      add(field, "利润分析必需数据未获取", { blocking: true });
    });

    if (!(product.sourceAsin || product.asin)) add("源 ASIN", "未获取", { blocking: true });
    if (!product.name && !product.englishName) add("商品标题", amazonReason);
    const savedPieceCount = Number(product.pieceCount);
    if ((!Number.isInteger(savedPieceCount) || savedPieceCount < 1) && product.pieceCountSource !== "amazon_title" && product.pieceCountSource !== "manual") {
      add("Amazon 标题件数", "标题未出现明确数量单位，当前按 1 件估算");
    } else if (product.pieceCountSource === "default") {
      add("Amazon 标题件数", "标题未出现明确数量单位，当前按 1 件估算");
    }
    if (!visibleStoreName(product.storeName)) add("店铺名称", "Amazon 店铺页未返回");
    if (!product.sellerId) add("Seller ID", "Amazon 店铺页未返回");
    if (!product.imageUrl) add("商品主图", amazonReason);
    if (!hasNumber(product.currentPrice) || product.currentPrice <= 0) add("竞品当前售价", amazonReason, { blocking: true });
    if (!hasNumber(product.salePrice) || product.salePrice <= 0) add("我们的售价", "竞品当前售价不可用，无法生成同价售价", { blocking: true });
    if (!hasNumber(product.rating)) add("评分", amazonReason);
    if (!hasNumber(product.reviews)) add("评价数", amazonReason);

    if (!hasNumber(product.sales30)) add("竞品 30 天销量", amazonOnly ? (product.collectionQuality?.fields?.sales30?.status === "unavailable" ? "Amazon 商品页未提供近月购买量" : "尚未采集或核验近月购买量") : sellerSpriteReason);
    if (!hasNumber(product.sales60)) {
      add("竞品 60 天销量", amazonOnly ? "本次未接入 SellerSprite" : "SellerSprite 查竞品接口不提供");
    }
    if (!hasNumber(product.salesAmount30)) add("竞品 30 天销售额", amazonOnly ? (product.collectionQuality?.fields?.salesAmount30?.status === "unavailable" ? "Amazon 商品页未公开准确销售额" : "尚未采集或核验销售额来源") : sellerSpriteReason);
    if (!product.sales30UpdatedAt) add("销量更新日期", sellerSpriteReason);
    if (typeof product.hasAPlus !== "boolean") add("A+ 页面", sellerSpriteReason);
    if (!product.firstFba) add("首次 FBA 有货", sellerSpriteReason);
    if (!product.listingAvailableAt) add("SellerSprite 上架日期", sellerSpriteReason);

    const effectiveWeight = usesItemWeightOnly(product) ? productWeightKgForDisplay(product) : null;
    const hasProductWeight = usesItemWeightOnly(product) ? effectiveWeight > 0 : hasNumber(product.productWeight) && product.productWeight > 0;
    const hasFbaWeight = hasNumber(product.fbaWeight) && product.fbaWeight > 0;
    const hasBillingWeight = usesItemWeightOnly(product) ? effectiveWeight > 0 : hasNumber(product.billingWeight) && product.billingWeight > 0;
    if (usesItemWeightOnly(product) ? !hasProductWeight : !hasProductWeight && !hasFbaWeight && !hasBillingWeight) add("商品重量", amazonReason, { blocking: !hasAnyProductShippingSpecification(product) });
    if (!product.productDimensions) add("商品参数", amazonReason);
    if (!product.fbaDimensions) add("FBA 包装参数", product.fbaEstimate ? (isAu ? "未获取；按用户指定标准信封暂估，尺寸待核验" : "未获取，已用商品重量代理") : sellerSpriteReason);
    if (!hasFbaWeight && product.fulfillmentMode === "FBA") {
      add("FBA 包装重量", product.fbaEstimate ? (isAu ? "未获取；已采用商品重量" : "未获取，已用商品重量代理") : sellerSpriteReason);
    }

    if (!hasNumber(product.purchaseCost)) {
      add("采购成本", product.supplierSearchError || (amazonOnly && !product.supplierSource ? "1688 未形成有效报价且未人工填写" : "1688 未形成有效报价"), { blocking: true });
    }
    const fulfillmentMode = normalizeFulfillmentMode(product.fulfillmentMode);
    if (!fulfillmentMode) add("履约方式", "Amazon / SellerSprite 未返回且未人工选择", { blocking: true });
    if (fulfillmentMode === "FBA" && !hasNumber(product.fbaFee)) add("FBA 配送费", isAu ? "请补齐售价和重量，或核实尺寸是否超出标准信封范围（≤33×23×2.5cm）；超重已按最高重量档估费" : product.marketplace === "CA" ? "请补齐售价和重量；超过500g已按加拿大旺季信封最高重量档估费" : "无法根据有效商品重量套用 FBA SOP", { blocking: true });
    if (fulfillmentMode === "FBM" && !hasNumber(product.fbmFee)) add("FBM 履约费", "未人工填写", { blocking: true });

    const profitInputs = product.profitInputs && typeof product.profitInputs === "object" ? product.profitInputs : {};
    if (usesItemWeightOnly(product) ? !hasBillingWeight : !hasNumber(profitInputs.actualWeightKg) && !hasBillingWeight) add("利润实际重", "未获取", { blocking: true });
    if (profitInputs.airFreightActualWeightOnly !== true) {
      if (!hasNumber(profitInputs.cartonWeightKg) || profitInputs.cartonWeightKg <= 0) add("外箱重量", "未填写，头程将使用单件参数回退");
      if (!hasNumber(profitInputs.unitsPerCarton) || profitInputs.unitsPerCarton <= 0) add("装箱数", "未填写，头程将使用单件参数回退");
    }
    if (!calculateProfit(product)) add("利润计算", "售价、采购成本、履约费或计费重量不完整", { blocking: true });

    return [...missing.values()];
  }

  function spreadsheetListingDate(product) {
    const date = product.amazonFirstAvailableDateStatus === "found"
      ? normalizeISODateOnly(product.amazonFirstAvailableDate) : null;
    if (!date) return "";
    // Excel stores calendar dates as numbers, independent of the user's timezone.
    const parsed = new Date(`${date}T00:00:00.000Z`);
    const serial = (parsed.getTime() - Date.UTC(1899, 11, 30)) / 86400000;
    return serial > 0 ? serial - (date < "1900-03-01" ? 1 : 0) : "";
  }

  function createSpreadsheetExportPayload(rows, exportMarket, worksheetName = "运营确认表") {
    const headers = [
      "商品 ID", "竞品图片", "源 ASIN", "商品名称", "生效采购件数",
      `竞品当前售价 (${exportMarket.currency})`, "竞品当前售价 (CNY)",
      `我们的售价 (${exportMarket.currency})`, "我们的售价 (CNY)",
      "评分", "评价数", "竞品 30 天销量", "利润计算重量 (kg)", "商品上架时间",
      "整套采购成本 (CNY)", "采购税率 (%)", "采购税费 (CNY)", "落地采购成本 (CNY)",
      "履约方式", `FBA 配送费 (${exportMarket.currency})`, "FBA 配送费 (CNY)",
      "空运单价 (CNY/kg)", "单件空运头程 (CNY)",
      "Amazon 佣金率 (%)", "汇损率 (%)", "营销费率 (%)", "管理费率 (%)", "退货预留率 (%)",
      `预估总成本 (${exportMarket.currency})`, "预估总成本 (CNY)",
      `预估单件利润 (${exportMarket.currency})`, "预估单件利润 (CNY)",
      "预估经营利润率 (%)", "数据采集时间", "重量来源",
      ...operationsColumnHeaders(exportMarket.currency),
    ];
    const dataRows = rows.map((product) => {
      // Export the saved analysis; choosing a factory must not recalculate costs.
      const calculation = product.profitCalculation;
      const profitInputs = product.profitInputs || {};
      const mode = product.fulfillmentMode || calculation?.fulfillmentMode;
      const isFba = mode === "FBA";
      const weightKg = resolveManualWeightOverride(product)?.weightKg
        ?? (usesItemWeightOnly(product) ? automaticProfitWeightKg(product) : product.productWeight);
      const savedMoney = value => Number.isFinite(value) ? roundMoney(value) : "";
      return [
        product.id || "", "", product.sourceAsin || product.asin || "", product.name || product.englishName || "", product.pieceCount ?? "",
        product.currentPrice ?? "", convertCurrencyToCny(product.currentPrice, exportMarket) ?? "",
        product.salePrice ?? "", convertCurrencyToCny(product.salePrice, exportMarket) ?? "",
        product.rating ?? OPERATIONS_MISSING, product.reviews ?? "", product.sales30 ?? "", weightKg ?? "", spreadsheetListingDate(product),
        product.purchaseCost ?? "", profitInputs.purchaseTaxRate,
        savedMoney(calculation?.purchaseTaxCny), savedMoney(calculation?.landedPurchaseCny),
        mode || "未获取",
        isFba ? product.fbaFee ?? "" : "", isFba ? convertCurrencyToCny(product.fbaFee, exportMarket) ?? "" : "",
        profitInputs.airFreightRateCnyPerKg, calculation?.airFreight?.airFreightCny ?? "",
        profitInputs.commissionRate, profitInputs.fxLossRate, profitInputs.marketingRate, profitInputs.managementRate, profitInputs.returnsRate,
        savedMoney(calculation?.totalCost), calculation ? convertCurrencyToCny(calculation.totalCost, exportMarket) : "",
        savedMoney(calculation?.profit), calculation ? convertCurrencyToCny(calculation.profit, exportMarket) : "",
        savedMoney(calculation?.margin), product.collectedAt || "", profitWeightSourceLabel(product),
        ...operationsColumnValues(product, { amazonUrl: amazonProductUrl(product), weightKg }),
      ];
    });
    return {
      worksheetName,
      layout: "reviewed-products-v1",
      headers,
      columnFormats: headers.map(header => header === "商品上架时间" ? "yyyy-mm-dd"
        : /（(?:CAD|AUD|USD|EUR|RMB|%)）$/.test(header) || header.startsWith('采购成本（含提货入库配置费，') ? "0.00" : "General"),
      rows: dataRows,
      imageColumnIndex: headers.indexOf("竞品图片"),
      images: rows.map((product) => ({
        url: safeAmazonImageUrl(product.imageUrl),
        alt: String(product.name || product.englishName || product.sourceAsin || product.asin || "竞品图片"),
      })),
    };
  }

  function formatSourceStores(product) {
    const stores = product.sourceStores || [];
    if (!stores.length) return [visibleStoreName(product.storeName), product.sellerId].filter(Boolean).join(" / ");
    return stores.map((store) => [visibleStoreName(store.sellerName), store.sellerId].filter(Boolean).join(" / ") || `输入行 ${store.rowNumbers?.join(",") || "--"}`).join("；");
  }

  function showToast(message, type = "success", duration = 3000) {
    const toast = byId("toast");
    if (!toast) return;
    clearTimeout(toastTimer);
    toast.classList.remove("is-success", "is-info", "is-error", "is-visible");
    toast.classList.add(`is-${type}`);
    byId("toastMessage").textContent = message;
    const currentIcon = $("[data-lucide], svg", toast);
    if (currentIcon) {
      const replacement = document.createElement("i");
      replacement.setAttribute("data-lucide", type === "error" ? "circle-alert" : type === "info" ? "info" : "check-circle-2");
      replacement.setAttribute("aria-hidden", "true");
      currentIcon.replaceWith(replacement);
    }
    toast.hidden = false;
    initIcons();
    requestAnimationFrame(() => toast.classList.add("is-visible"));
    toastTimer = setTimeout(() => {
      toast.classList.remove("is-visible");
      setTimeout(() => { toast.hidden = true; }, 180);
    }, duration);
  }

  function initIcons() {
    if (window.lucide && typeof window.lucide.createIcons === "function") {
      try {
        window.lucide.createIcons({ attrs: { "stroke-width": 1.8 } });
      } catch (_) {
        // Text labels and CSS visuals keep every action usable without the CDN.
      }
      return;
    }
    const fallbackSymbols = {
      menu: "≡", x: "×", "chevron-right": "›", "arrow-up-right": "↗", download: "↓",
      upload: "↑", play: "▶", "circle-help": "?", "refresh-cw": "↻", "rotate-cw": "↻",
      list: "≡", "chevron-down": "⌄", "trash-2": "×", store: "□",
      check: "✓", "check-circle-2": "✓", "circle-alert": "!", "triangle-alert": "!", info: "i",
      save: "↓", shuffle: "↝", search: "⌕", "arrow-down": "↓", terminal: ">_", "log-in": "→",
    };
    $$('[data-lucide]').forEach((icon) => {
      if (icon.textContent) return;
      icon.textContent = fallbackSymbols[icon.dataset.lucide] || "·";
      icon.classList.add("icon-fallback");
    });
  }

  function marginClass(margin) {
    if (margin >= 15) return "is-strong";
    if (margin >= 10) return "is-mid";
    return "is-low";
  }

  function numberOrNull(value) {
    if (value === "" || value === null || value === undefined) return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function finiteOrNull(value) {
    return numberOrNull(value);
  }

  function formatDimensions(value) {
    if (!value) return null;
    if (Array.isArray(value)) {
      const dimensions = value.slice(0, 3).map(Number);
      return dimensions.length === 3 && dimensions.every((number) => Number.isFinite(number) && number > 0)
        ? `${dimensions.join(" × ")} cm`
        : null;
    }
    if (typeof value === "object") {
      const dimensions = [value.length ?? value.longest, value.width ?? value.median, value.height ?? value.shortest].map(Number);
      return dimensions.every((number) => Number.isFinite(number) && number > 0) ? `${dimensions.join(" × ")} cm` : null;
    }
    const text = String(value).trim();
    if (!text) return null;
    const matches = text.match(/\d+(?:\.\d+)?/g);
    if (!matches || matches.length < 3) return text;
    return /\bcm\b/i.test(text) ? text : `${matches.slice(0, 3).join(" × ")} cm`;
  }

  function formatCollectedAt(value) {
    if (!value) return "数据缺失";
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return String(value);
    return new Intl.DateTimeFormat("zh-CN", {
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
    }).format(date);
  }

  function valueOrBlank(value) {
    return Number.isFinite(value) ? String(value) : "";
  }

  function dateInputValue(value) {
    const text = String(value || "").trim();
    if (!text) return "";
    const direct = text.match(/^\d{4}-\d{2}-\d{2}/)?.[0];
    if (direct) return direct;
    const date = new Date(text);
    return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : "";
  }

  function formatCurrency(value, market = activeMarket) {
    if (!Number.isFinite(value)) return "--";
    const config = typeof market === "string" ? MARKET_CONFIGS[market] || activeMarket : market;
    return new Intl.NumberFormat(config.locale, { style: "currency", currency: config.currency, minimumFractionDigits: 2 }).format(value);
  }

  function currencyExchangeRate(market = activeMarket) {
    const config = typeof market === "string" ? MARKET_CONFIGS[market] || activeMarket : market;
    if (config.currency === "CNY") return 1;
    if (config.code === activeMarket.code && Number.isFinite(taskExchangeRate) && taskExchangeRate > 0) {
      return taskExchangeRate;
    }
    if (runState?.marketplace === config.code && Number.isFinite(runState.exchangeRate) && runState.exchangeRate > 0) {
      return runState.exchangeRate;
    }
    return Number.isFinite(config.defaultExchangeRate) && config.defaultExchangeRate > 0 ? config.defaultExchangeRate : null;
  }

  function convertCurrencyToCny(value, market = activeMarket) {
    const amount = finiteOrNull(value);
    const rate = currencyExchangeRate(market);
    if (amount === null || rate === null) return null;
    const converted = amount * rate;
    return Math.round((converted + Math.sign(converted) * 1e-9) * 100) / 100;
  }

  function formatCny(value) {
    if (!Number.isFinite(value)) return "--";
    return new Intl.NumberFormat("zh-CN", {
      style: "currency",
      currency: "CNY",
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(value);
  }

  function formatCnyEquivalent(value, market = activeMarket, suffix = "") {
    const converted = convertCurrencyToCny(value, market);
    return converted === null ? "人民币 --" : `约 ${formatCny(converted)} RMB${suffix}`;
  }

  function currencyPairHtml(value, market = activeMarket, { label = "", suffix = "", secondary = false, compact = false } = {}) {
    if (!Number.isFinite(value)) return "";
    const config = typeof market === "string" ? MARKET_CONFIGS[market] || activeMarket : market;
    const converted = convertCurrencyToCny(value, config);
    if (converted === null) return "";
    const classes = ["currency-pair", secondary ? "is-secondary" : "", compact ? "is-compact" : ""].filter(Boolean).join(" ");
    const primary = `${label}${formatCny(converted)} RMB${suffix}`;
    const marketAmount = `${formatCurrency(value, config)} ${config.currency}${suffix}`;
    return `<span class="${classes}"><span class="currency-primary">${escapeHtml(primary)}</span><small class="currency-market">${escapeHtml(marketAmount)}</small></span>`;
  }

  function cnyCurrencyPairHtml(value, market = activeMarket, { label = "", suffix = "", secondary = false, compact = false } = {}) {
    const amount = finiteOrNull(value);
    const rate = currencyExchangeRate(market);
    if (amount === null) return "";
    const config = typeof market === "string" ? MARKET_CONFIGS[market] || activeMarket : market;
    const classes = ["currency-pair", secondary ? "is-secondary" : "", compact ? "is-compact" : ""].filter(Boolean).join(" ");
    const primary = `${label}${formatCny(amount)} RMB${suffix}`;
    const marketAmount = rate === null ? "" : `${formatCurrency(amount / rate, config)} ${config.currency}${suffix}`;
    return `<span class="${classes}"><span class="currency-primary">${escapeHtml(primary)}</span>${marketAmount ? `<small class="currency-market">${escapeHtml(marketAmount)}</small>` : ""}</span>`;
  }

  function formatCurrencyWithCnyText(value, market = activeMarket) {
    if (!Number.isFinite(value)) return "--";
    const config = typeof market === "string" ? MARKET_CONFIGS[market] || activeMarket : market;
    const converted = convertCurrencyToCny(value, config);
    return converted === null ? "--" : `${formatCny(converted)} RMB（${formatCurrency(value, config)} ${config.currency}）`;
  }

  function setCurrencyConversionOutput(outputId, value, market = activeMarket) {
    setText(outputId, formatCnyEquivalent(value, market));
  }

  function renderFilterCurrencyConversions() {
    setCurrencyConversionOutput("minPriceCny", numberOrNull(byId("minPrice")?.value), activeMarket);
    setCurrencyConversionOutput("maxPriceCny", numberOrNull(byId("maxPrice")?.value), activeMarket);
    setCurrencyConversionOutput("minFbaFeeCny", numberOrNull(byId("minFbaFee")?.value), activeMarket);
    setCurrencyConversionOutput("maxFbaFeeCny", numberOrNull(byId("maxFbaFee")?.value), activeMarket);
  }

  function formatNumber(value) {
    if (!Number.isFinite(value)) return "--";
    return new Intl.NumberFormat("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
  }

  function formatInteger(value) {
    return Number.isFinite(value) ? new Intl.NumberFormat("zh-CN").format(value) : "--";
  }

  function formatPercent(value) {
    return Number.isFinite(value) ? `${value.toFixed(1)}%` : "--";
  }

  function roundMoney(value) {
    return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
  }

  function formatDateForFile(date) {
    const pad = (value) => String(value).padStart(2, "0");
    return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}_${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  }

  function delay(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }

  function delayWithSignal(milliseconds, signal) {
    if (!signal) return delay(milliseconds);
    if (signal.aborted) return Promise.reject(signal.reason || new DOMException("任务已取消。", "AbortError"));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", abort);
        resolve();
      }, Math.max(0, milliseconds));
      const abort = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        reject(signal.reason || new DOMException("任务已取消。", "AbortError"));
      };
      signal.addEventListener("abort", abort, { once: true });
    });
  }

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>'"]/g, (character) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
    })[character]);
  }

})();
