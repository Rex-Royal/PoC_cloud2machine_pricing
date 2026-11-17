/**
 * Firmware Layout & Compatibility Engine (TypeScript).
 *
 * Models Rex-Royal coffee machine pricing configuration parsing (`Config/{deviceId}/config.json`),
 * deterministic menu grouping, and the two strict firmware validation rules enforced before
 * importing `priceList.json` from an `add_priceList_*.zip` partial backup:
 * 1. Exact grid geometry match (`rows`, `columns`, `categories`).
 * 2. Exact per-slot beverage preset (`M0801`) match unless `ignoreRecipeMatch=1`.
 *
 * Slot IDs use a 24-slot stride per category (`slotId = pos + 24 * categoryIndex`), and
 * prices are integer minor currency units (e.g. `350` = `3.50 CHF/EUR`).
 */

import {
  PriceListGroup,
  type FirmwareValidationResult,
  type FleetMachine,
  type LayoutCluster,
  type MachineLayout,
  type MismatchedSlotInfo,
  type PriceCupSize,
  type PriceGrinderKey,
  type PriceListJson,
  type PriceParamCode,
  type PriceParamSpec,
  type PriceParamsRecord,
  type ProductSlot,
  type RawConfigAttribute,
  type RawConfigProductNode,
  type RawMachineConfigJson,
  type RawProductLibraryJson,
} from './types.ts';

export { SAMPLE_LAYOUT_3X5, SAMPLE_LAYOUT_4X6 } from './sample-layouts.ts';

/** Category slot stride (`slotId = positionInCategory + 24 * categoryIndex`). */
export const SLOTS_PER_CATEGORY = 24;
export const EXTENDED_SLOT_ID_OFFSET = 100;
export const CSV_CATEGORY_ROW_MIN = 990;
export const EMPTY_PRESET_ID = 41;
/** Price List 1 Single (`M1401`) parameter ID in `priceList.json`. */
export const PRICE_PARAM_PL1_SINGLE: PriceParamCode = '47';
/** Price List 1 Double (`M1406`) parameter ID in `priceList.json`. */
export const PRICE_PARAM_PL1_DOUBLE: PriceParamCode = '50';

export const PRODUCT_PRESET_NAMES: Readonly<Record<number, string>> = Object.freeze({
  0: 'Unassigned',
  1: 'Water / Rinse',
  2: 'Crème / Coffee',
  3: 'Ristretto',
  4: 'Espresso',
  5: 'Espresso Macchiato',
  6: 'Café au Lait',
  7: 'Moccacino',
  8: 'Chocolate / Black Coffee',
  9: 'Milk / Decanter',
  10: 'Hot Water',
  14: 'Cappuccino',
  15: 'Latte Macchiato',
  16: 'Chociatto',
  17: 'Americano',
  18: 'Double Espresso',
  19: 'Double Coffee',
  20: 'Flat White',
  24: 'Cold Foam Latte',
  31: 'Tea / Hot Water Portion',
  37: 'Hot Water Special',
});

interface CompactParamSpecRow {
  readonly paramId: PriceParamCode;
  readonly mCode: string;
  readonly group: PriceListGroup;
  readonly grinder: PriceGrinderKey;
  readonly cupSize: PriceCupSize;
}

/**
 * Complete 32-parameter mapping between `priceList.json` numeric keys (`'47'..'70', '91'..'98'`)
 * and `config.json` firmware attribute codes (`M1401..M1429` prices, `M1601..M1609` PLU/MDB codes).
 */
const COMPACT_PRICE_PARAM_TABLE: readonly CompactParamSpecRow[] = [
  // Price List 1 — Single
  { paramId: '47', mCode: '1401', group: PriceListGroup.PL1, grinder: 'Gr1', cupSize: 'Single' },
  { paramId: '48', mCode: '1402', group: PriceListGroup.PL1, grinder: 'Gr2', cupSize: 'Single' },
  { paramId: '91', mCode: '1403', group: PriceListGroup.PL1, grinder: 'Gr3', cupSize: 'Single' },
  { paramId: '49', mCode: '1404', group: PriceListGroup.PL1, grinder: 'Decaf', cupSize: 'Single' },
  // Price List 1 — Double
  { paramId: '50', mCode: '1406', group: PriceListGroup.PL1, grinder: 'Gr1', cupSize: 'Double' },
  { paramId: '51', mCode: '1407', group: PriceListGroup.PL1, grinder: 'Gr2', cupSize: 'Double' },
  { paramId: '92', mCode: '1408', group: PriceListGroup.PL1, grinder: 'Gr3', cupSize: 'Double' },
  { paramId: '52', mCode: '1409', group: PriceListGroup.PL1, grinder: 'Decaf', cupSize: 'Double' },
  // Price List 2 — Single
  { paramId: '53', mCode: '1411', group: PriceListGroup.PL2, grinder: 'Gr1', cupSize: 'Single' },
  { paramId: '54', mCode: '1412', group: PriceListGroup.PL2, grinder: 'Gr2', cupSize: 'Single' },
  { paramId: '93', mCode: '1413', group: PriceListGroup.PL2, grinder: 'Gr3', cupSize: 'Single' },
  { paramId: '55', mCode: '1414', group: PriceListGroup.PL2, grinder: 'Decaf', cupSize: 'Single' },
  // Price List 2 — Double
  { paramId: '56', mCode: '1416', group: PriceListGroup.PL2, grinder: 'Gr1', cupSize: 'Double' },
  { paramId: '57', mCode: '1417', group: PriceListGroup.PL2, grinder: 'Gr2', cupSize: 'Double' },
  { paramId: '94', mCode: '1418', group: PriceListGroup.PL2, grinder: 'Gr3', cupSize: 'Double' },
  { paramId: '58', mCode: '1419', group: PriceListGroup.PL2, grinder: 'Decaf', cupSize: 'Double' },
  // Price List 3 — Single
  { paramId: '59', mCode: '1421', group: PriceListGroup.PL3, grinder: 'Gr1', cupSize: 'Single' },
  { paramId: '60', mCode: '1422', group: PriceListGroup.PL3, grinder: 'Gr2', cupSize: 'Single' },
  { paramId: '95', mCode: '1423', group: PriceListGroup.PL3, grinder: 'Gr3', cupSize: 'Single' },
  { paramId: '61', mCode: '1424', group: PriceListGroup.PL3, grinder: 'Decaf', cupSize: 'Single' },
  // Price List 3 — Double
  { paramId: '62', mCode: '1426', group: PriceListGroup.PL3, grinder: 'Gr1', cupSize: 'Double' },
  { paramId: '63', mCode: '1427', group: PriceListGroup.PL3, grinder: 'Gr2', cupSize: 'Double' },
  { paramId: '96', mCode: '1428', group: PriceListGroup.PL3, grinder: 'Gr3', cupSize: 'Double' },
  { paramId: '64', mCode: '1429', group: PriceListGroup.PL3, grinder: 'Decaf', cupSize: 'Double' },
  // Payment / MDB / PLU Codes
  { paramId: '65', mCode: '1601', group: PriceListGroup.PLU, grinder: 'Gr1', cupSize: 'Single' },
  { paramId: '68', mCode: '1606', group: PriceListGroup.PLU, grinder: 'Gr1', cupSize: 'Double' },
  { paramId: '66', mCode: '1602', group: PriceListGroup.PLU, grinder: 'Gr2', cupSize: 'Single' },
  { paramId: '69', mCode: '1607', group: PriceListGroup.PLU, grinder: 'Gr2', cupSize: 'Double' },
  { paramId: '97', mCode: '1603', group: PriceListGroup.PLU, grinder: 'Gr3', cupSize: 'Single' },
  { paramId: '98', mCode: '1608', group: PriceListGroup.PLU, grinder: 'Gr3', cupSize: 'Double' },
  { paramId: '67', mCode: '1604', group: PriceListGroup.PLU, grinder: 'Decaf', cupSize: 'Single' },
  { paramId: '70', mCode: '1609', group: PriceListGroup.PLU, grinder: 'Decaf', cupSize: 'Double' },
];

function expandParamSpec({
  paramId,
  mCode,
  group,
  grinder,
  cupSize,
}: CompactParamSpecRow): PriceParamSpec {
  const isPrice = group !== PriceListGroup.PLU;
  const cupLower = cupSize.toLowerCase();
  const label = isPrice
    ? `PrLi ${group.slice(2)} ${grinder} ${cupLower}`
    : `Code ${grinder} ${cupLower}`;
  const configNames =
    grinder === 'Gr3' ? [label, `M${mCode}`, mCode] : [`M${mCode}`, label];

  return Object.freeze({
    paramId,
    enumName: isPrice
      ? `C_${group}${grinder}_${cupSize}`
      : `C_Code${grinder}_${cupSize}`,
    configNames: Object.freeze(configNames),
    group,
    grinder,
    cupSize,
    variant: isPrice ? `${grinder} ${cupSize}` : `Code ${grinder} ${cupSize}`,
    isPrice,
  });
}

export const PRICE_PARAM_SPECS: readonly PriceParamSpec[] = Object.freeze(
  COMPACT_PRICE_PARAM_TABLE.map(expandParamSpec)
);

const PRICE_ONLY_PARAM_SPECS = PRICE_PARAM_SPECS.filter((s) => s.isPrice);

export function computeDeterministicHash(input: string): string {
  let hash1 = 0x811c9dc5;
  const str = String(input);
  for (let i = 0; i < str.length; i += 1) {
    const ch = str.charCodeAt(i);
    hash1 ^= ch;
    hash1 = Math.imul(hash1, 0x01000193) >>> 0;
  }
  return hash1.toString(16).padStart(8, '0');
}

function findProductAttribute(
  attributes: readonly RawConfigAttribute[] | undefined,
  candidateKeys: readonly string[],
  preferLastNonZero = false
): string | number | undefined {
  if (!Array.isArray(attributes)) {
    return undefined;
  }
  for (const candidate of candidateKeys) {
    const matches = attributes.filter(
      (attr) =>
        attr &&
        (attr.name === candidate || attr.id === candidate) &&
        attr.value !== undefined
    );
    if (matches.length > 0) {
      if (preferLastNonZero) {
        const nonZero = [...matches]
          .reverse()
          .find((m) => String(m.value) !== '0' && String(m.value) !== '');
        if (nonZero) return nonZero.value;
      }
      return matches[0].value;
    }
  }
  return undefined;
}

function parseConfigParamValue(rawVal: unknown, isPrice = true): number {
  if (rawVal === undefined || rawVal === null || rawVal === '') {
    return 0;
  }
  const str = String(rawVal).trim();
  if (isPrice && str.includes('.')) {
    const floatVal = Number.parseFloat(str);
    return Number.isNaN(floatVal) ? 0 : Math.round(floatVal * 100);
  }
  return Number.parseInt(str, 10) || 0;
}

export function cleanRecipeDisplayName(rawName: unknown): string {
  return String(rawName || '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface ConfigProductNodeContext {
  readonly node: RawConfigProductNode;
  readonly resolvedId: number;
  readonly fallbackId: number;
  readonly categoryIndex: number;
  readonly isExtended: boolean;
  readonly categoryName?: string;
}

export function resolveConfigNodeId(
  node: RawConfigProductNode,
  fallbackId: number
): number {
  const attrs = Array.isArray(node.attributes) ? node.attributes : undefined;
  const rawId =
    node.id ??
    findProductAttribute(attrs, ['RecipeID', 'C_EnumKey', 'Pos']) ??
    fallbackId;
  return Number.parseInt(String(rawId), 10) || fallbackId;
}

export function forEachConfigProductNode(
  rawConfig: RawMachineConfigJson,
  visitor: (ctx: ConfigProductNodeContext) => void
): void {
  let visitedAny = false;

  if (Array.isArray(rawConfig.prodCatArray)) {
    rawConfig.prodCatArray.forEach((cat, catIdx) => {
      const catNumber =
        Number.parseInt(String(cat.id ?? cat.catNumber ?? catIdx), 10) || catIdx;
      const catTitle = typeof cat.name === 'string' ? cat.name : undefined;
      const catProducts = Array.isArray(cat.products) ? cat.products : [];

      catProducts.forEach((prod, posIdx) => {
        if (!prod || typeof prod !== 'object') return;
        const defaultId = posIdx + 1 + SLOTS_PER_CATEGORY * catNumber;
        const resolvedId = resolveConfigNodeId(prod, defaultId);
        visitedAny = true;
        visitor({
          node: prod,
          resolvedId,
          fallbackId: defaultId,
          categoryIndex: catNumber,
          isExtended: false,
          categoryName: catTitle,
        });

        if (Array.isArray(prod.extendedCupSize)) {
          prod.extendedCupSize.forEach((extProd, extIdx) => {
            if (!extProd || typeof extProd !== 'object') return;
            const extFallbackId = resolvedId + EXTENDED_SLOT_ID_OFFSET * (extIdx + 1);
            const extResolvedId = resolveConfigNodeId(extProd, extFallbackId);
            visitedAny = true;
            visitor({
              node: extProd,
              resolvedId: extResolvedId,
              fallbackId: extFallbackId,
              categoryIndex: catNumber,
              isExtended: true,
              categoryName: catTitle,
            });
          });
        }
      });
    });
  }

  if (Array.isArray(rawConfig.extendedCupSize)) {
    rawConfig.extendedCupSize.forEach((extProd, extIdx) => {
      if (
        extProd &&
        typeof extProd === 'object' &&
        (extProd.id !== undefined || Array.isArray(extProd.attributes))
      ) {
        const fallbackId = EXTENDED_SLOT_ID_OFFSET + 1 + extIdx;
        const resolvedId = resolveConfigNodeId(extProd, fallbackId);
        visitedAny = true;
        visitor({
          node: extProd,
          resolvedId,
          fallbackId,
          categoryIndex: 0,
          isExtended: true,
        });
      }
    });
  }

  if (!visitedAny && Array.isArray(rawConfig.products)) {
    rawConfig.products.forEach((prod, idx) => {
      if (!prod || typeof prod !== 'object') return;
      const fallbackId = idx + 1;
      const resolvedId = resolveConfigNodeId(prod, fallbackId);
      const catNumber =
        resolvedId < EXTENDED_SLOT_ID_OFFSET
          ? Math.floor((resolvedId - 1) / SLOTS_PER_CATEGORY)
          : 0;
      visitedAny = true;
      visitor({
        node: prod,
        resolvedId,
        fallbackId: resolvedId,
        categoryIndex: catNumber,
        isExtended: resolvedId >= EXTENDED_SLOT_ID_OFFSET,
      });
    });
  }
}

function normalizeProductNode(
  rawProduct: RawConfigProductNode,
  id: number,
  categoryIndex: number,
  isExtended = false,
  categoryName?: string
): ProductSlot {
  const attrs = Array.isArray(rawProduct.attributes) ? rawProduct.attributes : [];

  const rawPreset =
    rawProduct.product !== undefined
      ? rawProduct.product
      : rawProduct.productType !== undefined &&
          !Number.isNaN(Number.parseInt(String(rawProduct.productType), 10))
        ? rawProduct.productType
        : findProductAttribute(attrs, ['M0801', 'C_ProductRecipe']) ?? 2;
  const productPreset = Number.parseInt(String(rawPreset), 10) || 0;

  const productTypeKey =
    typeof rawProduct.productType === 'string' &&
    Number.isNaN(Number.parseInt(rawProduct.productType, 10))
      ? rawProduct.productType
      : String(
          findProductAttribute(attrs, ['M0801'], true) ||
            PRODUCT_PRESET_NAMES[productPreset] ||
            'coffee'
        );

  const rawName =
    rawProduct.name ||
    findProductAttribute(attrs, ['ProdName', 'Product name', 'C_ProductName'], true) ||
    PRODUCT_PRESET_NAMES[productPreset] ||
    `Recipe #${id}`;
  const displayName = cleanRecipeDisplayName(rawName) || `Recipe #${id}`;

  const params: Partial<PriceParamsRecord> = {};
  for (const spec of PRICE_PARAM_SPECS) {
    const rawVal =
      rawProduct[spec.paramId] ??
      rawProduct[spec.enumName] ??
      findProductAttribute(attrs, [spec.paramId, spec.enumName, ...spec.configNames]);
    params[spec.paramId] = parseConfigParamValue(rawVal, spec.isPrice);
  }

  const isLocked =
    productTypeKey.toLowerCase() === 'locked' ||
    displayName.toLowerCase() === 'not used';

  const resolvedCategoryName =
    cleanRecipeDisplayName(rawProduct.categoryName || categoryName || '') || undefined;

  return {
    id,
    categoryIndex,
    product: productPreset,
    productTypeKey,
    name: displayName,
    displayName,
    isExtended,
    isLocked,
    params: params as PriceParamsRecord,
    categoryName: resolvedCategoryName,
  };
}

/**
 * Parses `Config/{deviceId}/config.json` (or `priceList.json`) into a normalized `MachineLayout`
 * with deterministic FNV-1a layout signature and 32 minor-unit parameter values per slot.
 */
export function parseMachineConfig(
  rawConfig: RawMachineConfigJson | PriceListJson,
  _rawProductLibrary: RawProductLibraryJson | null = null
): MachineLayout {
  if (!rawConfig || typeof rawConfig !== 'object') {
    throw new Error('Invalid machine configuration payload');
  }

  const configObj = rawConfig as RawMachineConfigJson;
  const rows = Number.parseInt(String(configObj.rows ?? 3), 10) || 3;
  const columns = Number.parseInt(String(configObj.columns ?? 5), 10) || 5;
  const categories = Number.parseInt(String(configObj.categories ?? 1), 10) || 1;
  const selfService = String(configObj.selfService ?? '0');

  const productsById = new Map<number, ProductSlot>();
  forEachConfigProductNode(configObj, ({ node, resolvedId, categoryIndex, isExtended, categoryName }) => {
    const normalized = normalizeProductNode(
      node,
      resolvedId,
      categoryIndex,
      isExtended,
      categoryName
    );
    productsById.set(normalized.id, normalized);
  });

  const sortedProducts = Array.from(productsById.values()).sort((a, b) => a.id - b.id);
  const canonicalSpec = [
    `grid:${rows}x${columns}x${categories}`,
    `count:${sortedProducts.length}`,
    ...sortedProducts.map(
      (p) => `${p.id}:${p.categoryIndex}:${p.product}:${p.displayName.toLowerCase()}`
    ),
  ].join('|');
  const signatureHash = computeDeterministicHash(canonicalSpec);
  const layoutKey = `${rows}x${columns}x${categories}_${signatureHash}`;

  return {
    rows,
    columns,
    categories,
    selfService,
    products: sortedProducts,
    signatureHash,
    layoutKey,
  };
}

/**
 * Verifies whether a live `Config/{deviceId}/config.json` downloaded from FtpProxy
 * has actually applied all price parameters from `targetLayout`.
 *
 * Used as ground-truth confirmation so "zombie-online" machines (closed without clean
 * MQTT DISCONNECT while ThingsBoard still reports `cmConnected = 1`) are never falsely
 * marked synced until the coffee machine itself uploads its updated `config.json`.
 */
export function doesRawConfigMatchTargetPrices(
  rawConfig: RawMachineConfigJson | null | undefined,
  targetLayout: MachineLayout | null | undefined
): boolean {
  if (!rawConfig || !targetLayout || !Array.isArray(targetLayout.products)) {
    return false;
  }

  let liveLayout: MachineLayout;
  try {
    liveLayout = parseMachineConfig(rawConfig);
  } catch {
    return false;
  }

  if (
    liveLayout.rows !== targetLayout.rows ||
    liveLayout.columns !== targetLayout.columns ||
    liveLayout.categories !== targetLayout.categories
  ) {
    return false;
  }

  const targetSlotsById = new Map<number, ProductSlot>(
    targetLayout.products.map((slot) => [slot.id, slot])
  );

  // Collect raw non-extended nodes by slotId so we only enforce price parameters emitted in config.json
  const rawNodesById = new Map<number, RawConfigProductNode>();
  forEachConfigProductNode(rawConfig, ({ node, resolvedId, isExtended }) => {
    if (!isExtended) {
      rawNodesById.set(resolvedId, node);
    }
  });

  let checkedPriceCells = 0;

  for (const liveSlot of liveLayout.products) {
    if (liveSlot.isExtended || liveSlot.isLocked) continue;
    const targetSlot = targetSlotsById.get(liveSlot.id);
    if (!targetSlot || targetSlot.isLocked) continue;

    const rawNode = rawNodesById.get(liveSlot.id);
    const attrs = rawNode && Array.isArray(rawNode.attributes) ? rawNode.attributes : [];

    for (const spec of PRICE_ONLY_PARAM_SPECS) {
      const existsInRaw =
        rawNode !== undefined &&
        (spec.paramId in rawNode ||
          spec.enumName in rawNode ||
          findProductAttribute(attrs, [spec.paramId, spec.enumName, ...spec.configNames]) !==
            undefined);

      if (!existsInRaw) continue;
      checkedPriceCells += 1;
      const liveVal = Number(liveSlot.params[spec.paramId] ?? 0);
      const targetVal = Number(targetSlot.params[spec.paramId] ?? 0);
      if (liveVal !== targetVal) {
        return false;
      }
    }
  }

  return checkedPriceCells > 0;
}

/**
 * Enforces the two firmware compatibility checks before importing `priceList.json`:
 * Check 1 — exact `rows × columns × categories` grid match.
 * Check 2 — exact per-slot `M0801` recipe preset match (unless `ignoreRecipeMatch=1`).
 */
export function validatePriceListAgainstMachine(
  priceListJson: PriceListJson,
  machineLayout: MachineLayout
): FirmwareValidationResult {
  const plRows = Number.parseInt(String(priceListJson.rows), 10);
  const plCols = Number.parseInt(String(priceListJson.columns), 10);
  const plCats = Number.parseInt(String(priceListJson.categories), 10);

  const check1GridMatch =
    plRows === machineLayout.rows &&
    plCols === machineLayout.columns &&
    plCats === machineLayout.categories;

  if (!check1GridMatch) {
    return {
      valid: false,
      check1GridMatch: false,
      check2RecipeMatch: false,
      ignoreRecipeMatch: Boolean(Number(priceListJson.ignoreRecipeMatch) > 0),
      mismatchedSlots: [],
      abortReason: `Price list layout setup (${plRows}x${plCols}, ${plCats} cat) is not equal to machine (${machineLayout.rows}x${machineLayout.columns}, ${machineLayout.categories} cat), abort import`,
    };
  }

  const ignoreRecipeMatch = Number(priceListJson.ignoreRecipeMatch) > 0;
  const machineSlotsById = new Map<number, ProductSlot>(
    machineLayout.products.map((p) => [p.id, p])
  );
  const mismatchedSlots: MismatchedSlotInfo[] = [];

  const incomingProducts = Array.isArray(priceListJson.products) ? priceListJson.products : [];
  const incomingIds = new Set<number>();
  for (const item of incomingProducts) {
    const slotId = Number.parseInt(String(item.id), 10);
    const incomingPreset = Number.parseInt(String(item.product), 10);
    incomingIds.add(slotId);
    const machineSlot = machineSlotsById.get(slotId);

    if (!machineSlot || machineSlot.product !== incomingPreset) {
      mismatchedSlots.push({
        id: slotId,
        expectedProduct: machineSlot ? machineSlot.product : null,
        expectedName: machineSlot ? machineSlot.name : 'Missing Slot',
        incomingProduct: incomingPreset,
      });
    }
  }

  for (const machineSlot of machineLayout.products) {
    if (!incomingIds.has(machineSlot.id)) {
      mismatchedSlots.push({
        id: machineSlot.id,
        expectedProduct: machineSlot.product,
        expectedName: machineSlot.name,
        incomingProduct: -1,
      });
    }
  }

  const check2RecipeMatch = mismatchedSlots.length === 0;
  const valid = check1GridMatch && (check2RecipeMatch || ignoreRecipeMatch);

  return {
    valid,
    check1GridMatch,
    check2RecipeMatch,
    ignoreRecipeMatch,
    mismatchedSlots,
    abortReason: valid
      ? null
      : `PriceListImport: aborted due to ${mismatchedSlots.length} non matching product(s) [set ignoreRecipeMatch=1 to force]`,
  };
}

export function clusterMachinesByLayout(
  machines: readonly Partial<FleetMachine>[]
): readonly LayoutCluster[] {
  const clustersMap = new Map<
    string,
    {
      layoutKey: string;
      signatureHash: string;
      rows: number;
      columns: number;
      categories: number;
      zipFileName: string;
      referenceLayout: MachineLayout;
      machines: FleetMachine[];
    }
  >();

  for (const machine of machines) {
    let mLayout = machine.layout || null;
    if (!mLayout && machine.rawConfigJson) {
      try {
        mLayout = parseMachineConfig(
          machine.rawConfigJson,
          machine.rawProductLibraryJson || null
        );
      } catch {
        mLayout = null;
      }
    }
    if (!mLayout) {
      continue;
    }

    const { layoutKey, rows, columns, categories, signatureHash } = mLayout;
    if (!clustersMap.has(layoutKey)) {
      clustersMap.set(layoutKey, {
        layoutKey,
        signatureHash,
        rows,
        columns,
        categories,
        zipFileName: `add_priceList_${layoutKey}.zip`,
        referenceLayout: mLayout,
        machines: [],
      });
    }
    clustersMap.get(layoutKey)!.machines.push({
      ...(machine as FleetMachine),
      layout: mLayout,
    });
  }

  return Array.from(clustersMap.values());
}
