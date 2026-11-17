/**
 * Optional Legacy Backup ZIP Fallback Parser.
 *
 * Reconstructs a `RawMachineConfigJson` layout from full/partial machine backup
 * archives (`Backup_MN*.zip` containing `priceList.json`, `Machine/RecipeConfig.csv`,
 * and `Config/ProductConfig.xml`) when `Config/{deviceId}/config.json` has not yet
 * been published by the coffee machine, and filters synthetic demo sample payloads.
 */

import {
  cleanRecipeDisplayName,
  CSV_CATEGORY_ROW_MIN,
  EMPTY_PRESET_ID,
  EXTENDED_SLOT_ID_OFFSET,
  PRICE_PARAM_SPECS,
  PRODUCT_PRESET_NAMES,
  SLOTS_PER_CATEGORY,
} from './layout-engine.ts';
import type {
  PriceListJson,
  RawConfigAttribute,
  RawConfigCategoryNode,
  RawConfigProductNode,
  RawMachineConfigJson,
} from './types.ts';

/**
 * Detects whether a `config.json` payload is a truncated 3-product (`Gastro Selection`)
 * or 6-product (`Coffee Classics`) synthetic demo payload rather than a full machine export.
 */
export function isLegacyPartialSampleConfig(
  rawConfig: RawMachineConfigJson | null | undefined
): boolean {
  if (!rawConfig || typeof rawConfig !== 'object') return false;
  const firstCat = Array.isArray(rawConfig.prodCatArray) ? rawConfig.prodCatArray[0] : null;
  if (!firstCat) return false;
  const catName = String((firstCat as { name?: string }).name || '');
  const prods = Array.isArray(firstCat.products) ? firstCat.products : [];
  if (catName === 'Gastro Selection' && prods.length <= 4) {
    return true;
  }
  if (catName === 'Coffee Classics' && prods.length <= 6) {
    return true;
  }
  const rows = Number(rawConfig.rows || 0);
  const cols = Number(rawConfig.columns || 0);
  if (rows === 4 && cols === 6 && prods.length === 3) {
    return true;
  }
  if (rows === 3 && cols === 5 && prods.length === 6) {
    return true;
  }
  return false;
}

/**
 * Detects whether a `config.json` payload is an in-memory simulator fixture
 * (`SAMPLE_LAYOUT_3X5` or `SAMPLE_LAYOUT_4X6`) rather than real hardware `config.json`
 * or `Backup_MN*.zip` configuration data.
 */
export function isSyntheticSampleConfig(
  rawConfig: RawMachineConfigJson | null | undefined
): boolean {
  if (!rawConfig || typeof rawConfig !== 'object') return false;
  if (isLegacyPartialSampleConfig(rawConfig)) return true;
  if ((rawConfig as { fromBackupZip?: boolean }).fromBackupZip) return false;
  if (Array.isArray(rawConfig.extendedCupSize)) return false;

  const cats = Array.isArray(rawConfig.prodCatArray) ? rawConfig.prodCatArray : [];
  if (cats.length !== 1) return false;
  const prods = Array.isArray(cats[0]?.products) ? cats[0].products : [];
  const p0 = prods[0]?.name;
  const p1 = prods[1]?.name;
  const pLast = prods[prods.length - 1]?.name;

  if (
    prods.length === SLOTS_PER_CATEGORY &&
    p0 === 'Ristretto' &&
    p1 === 'Espresso' &&
    pLast === 'Hot Water Special'
  ) {
    return true;
  }
  if (
    prods.length === 15 &&
    p0 === 'Ristretto' &&
    p1 === 'Espresso' &&
    pLast === 'Hot Water Portion'
  ) {
    return true;
  }
  return false;
}

export interface RecipeCsvMeta {
  readonly product: number;
  readonly name: string;
  readonly iconFile: string;
}

export function parseRecipeCsvMetadata(
  entries: Readonly<Record<string, string>>,
  entryKeys: readonly string[]
): {
  recipeMetaById: Map<number, RecipeCsvMeta>;
  categoryNameByIndex: Map<number, string>;
} {
  const recipeMetaById = new Map<number, RecipeCsvMeta>();
  const categoryNameByIndex = new Map<number, string>();

  const recipeCsvKey = entryKeys.find((k) => {
    const lower = k.toLowerCase();
    return lower.endsWith('recipeconfig.csv') || lower.endsWith('p_data.csv');
  });
  if (!recipeCsvKey || !entries[recipeCsvKey]) {
    return { recipeMetaById, categoryNameByIndex };
  }

  for (const line of entries[recipeCsvKey].split(/\r?\n/)) {
    if (!line) continue;
    const cols = line.split(';');
    if (cols.length < 3) continue;
    const id = Number.parseInt(String(cols[0] ?? '').trim(), 10);
    if (!Number.isFinite(id) || id <= 0) continue;
    const product = Number.parseInt(String(cols[1] ?? '').trim(), 10) || 0;
    const rawName = String(cols[2] ?? '').trim();
    const iconFile = String(cols[3] ?? '').trim();

    if (id >= CSV_CATEGORY_ROW_MIN && id <= 999) {
      const cleanedCat = cleanRecipeDisplayName(rawName);
      if (cleanedCat && cleanedCat.toLowerCase() !== 'coffee') {
        categoryNameByIndex.set(id - CSV_CATEGORY_ROW_MIN, cleanedCat);
      }
    } else if (id >= 1 && id < CSV_CATEGORY_ROW_MIN) {
      recipeMetaById.set(id, { product, name: rawName, iconFile });
    }
  }

  return { recipeMetaById, categoryNameByIndex };
}

export function inferActiveSlotsPerCategory(
  entries: Readonly<Record<string, string>>,
  entryKeys: readonly string[],
  rows: number,
  columns: number,
  categories: number
): number {
  const productConfigXmlKey = entryKeys.find((k) =>
    k.toLowerCase().endsWith('productconfig.xml')
  );
  if (productConfigXmlKey && entries[productConfigXmlKey]) {
    const schemaMatch = /<Schema>[^<]*?(\d+)\s*[x×]\s*(\d+)[^<]*<\/Schema>/i.exec(
      entries[productConfigXmlKey]
    );
    if (schemaMatch) {
      const schemaRows = Number.parseInt(schemaMatch[1], 10);
      const schemaCols = Number.parseInt(schemaMatch[2], 10);
      if (
        schemaRows > 0 &&
        schemaCols > 0 &&
        schemaRows * schemaCols <= SLOTS_PER_CATEGORY
      ) {
        return schemaRows * schemaCols;
      }
    }
  }

  if (rows === 2 && columns === 5 && categories === 2) {
    return 12;
  }
  if (rows > 0 && columns > 0 && rows * columns <= SLOTS_PER_CATEGORY) {
    return rows * columns;
  }
  return SLOTS_PER_CATEGORY;
}

export function buildCategoryBucketsFromPriceList(
  priceList: PriceListJson,
  activeSlotsPerCat: number,
  recipeMetaById: ReadonlyMap<number, RecipeCsvMeta>,
  categoryNameByIndex: ReadonlyMap<number, string>
): RawConfigCategoryNode[] {
  const catBuckets = new Map<number, RawConfigProductNode[]>();

  for (const item of priceList.products) {
    const id = Number.parseInt(String(item.id), 10);
    if (!Number.isFinite(id) || id <= 0) continue;

    const catIdx =
      id < EXTENDED_SLOT_ID_OFFSET ? Math.floor((id - 1) / SLOTS_PER_CATEGORY) : 0;
    const posInCat =
      id < EXTENDED_SLOT_ID_OFFSET ? ((id - 1) % SLOTS_PER_CATEGORY) + 1 : id;
    if (id < EXTENDED_SLOT_ID_OFFSET && posInCat > activeSlotsPerCat) {
      continue;
    }

    const csvMeta = recipeMetaById.get(id);
    const presetNum =
      Number.parseInt(String(item.product ?? csvMeta?.product ?? 0), 10) || 0;
    const rawName = csvMeta?.name || PRODUCT_PRESET_NAMES[presetNum] || `Recipe #${id}`;
    const cleanedName = cleanRecipeDisplayName(rawName);

    if (
      cleanedName.toLowerCase() === 'not used' ||
      presetNum === EMPTY_PRESET_ID ||
      presetNum === 0
    ) {
      continue;
    }

    const catTitle = categoryNameByIndex.get(catIdx);
    const attributes: RawConfigAttribute[] = [
      { name: 'RecipeID', value: String(id) },
      { name: 'M0801', value: String(presetNum) },
      { name: 'ProdName', value: cleanedName },
    ];
    if (csvMeta?.iconFile) {
      attributes.push({ name: 'FileName', value: csvMeta.iconFile });
    }

    const node: RawConfigProductNode = {
      id,
      product: presetNum,
      productType: String(presetNum),
      name: cleanedName,
      categoryName: catTitle,
      attributes,
    };

    for (const spec of PRICE_PARAM_SPECS) {
      const val = Number(item[spec.paramId] ?? 0);
      node[spec.paramId] = val;
      if (spec.configNames[0]) {
        attributes.push({ name: spec.configNames[0], value: String(val) });
      }
    }

    if (!catBuckets.has(catIdx)) {
      catBuckets.set(catIdx, []);
    }
    catBuckets.get(catIdx)!.push(node);
  }

  return Array.from(catBuckets.entries())
    .sort(([a], [b]) => a - b)
    .map(([catIdx, products]) => ({
      id: catIdx,
      name: categoryNameByIndex.get(catIdx) || undefined,
      products,
    }));
}

/**
 * Reconstructs a `RawMachineConfigJson` from the extracted text entries of a machine backup `.zip`
 * (`Backup_MN*.zip`), combining `priceList.json`, `Machine/RecipeConfig.csv`, and `Config/ProductConfig.xml`.
 */
export function buildConfigFromBackupZipEntries(
  entries: Record<string, string>
): RawMachineConfigJson | null {
  if (!entries || typeof entries !== 'object') return null;

  const entryKeys = Object.keys(entries);
  const configJsonKey = entryKeys.find(
    (k) => k.toLowerCase().endsWith('config.json') && !k.toLowerCase().includes('optionsconfig')
  );
  if (configJsonKey && entries[configJsonKey]) {
    try {
      const parsed = JSON.parse(entries[configJsonKey]) as RawMachineConfigJson;
      if (parsed && !isSyntheticSampleConfig(parsed)) {
        return parsed;
      }
    } catch {
      // Fall through to priceList.json
    }
  }

  const priceListKey = entryKeys.find((k) => k.toLowerCase().endsWith('pricelist.json'));
  if (!priceListKey || !entries[priceListKey]) {
    return null;
  }

  let priceList: PriceListJson;
  try {
    priceList = JSON.parse(entries[priceListKey]) as PriceListJson;
  } catch {
    return null;
  }
  if (!priceList || !Array.isArray(priceList.products) || priceList.products.length === 0) {
    return null;
  }

  const rows = Number.parseInt(String(priceList.rows ?? 3), 10) || 3;
  const columns = Number.parseInt(String(priceList.columns ?? 4), 10) || 4;
  const categories = Number.parseInt(String(priceList.categories ?? 1), 10) || 1;

  const { recipeMetaById, categoryNameByIndex } = parseRecipeCsvMetadata(entries, entryKeys);
  const activeSlotsPerCat = inferActiveSlotsPerCategory(
    entries,
    entryKeys,
    rows,
    columns,
    categories
  );
  const prodCatArray = buildCategoryBucketsFromPriceList(
    priceList,
    activeSlotsPerCat,
    recipeMetaById,
    categoryNameByIndex
  );

  if (prodCatArray.length === 0) {
    return null;
  }

  return {
    rows,
    columns,
    categories,
    selfService: '1',
    fromBackupZip: true,
    prodCatArray,
  };
}
