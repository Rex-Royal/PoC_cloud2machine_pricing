/**
 * Pure Functional Pricing Engine (TypeScript).
 * Transforms `MachineLayout <-> PriceListJson` and applies dynamic pricing rules
 * (Happy Hour %, Peak Surge +/-, Employee Tiers PL2/PL3, 5-Rappen coin rounding).
 */

import {
  BeverageFilter,
  PriceListGroup,
  PricingPresetId,
  PricingRuleMode,
  type ChangedSlotSummary,
  type DynamicPricingRule,
  type MachineLayout,
  type PriceListJson,
  type PriceListProductEntry,
  type PriceParamCode,
  type PriceParamsRecord,
  type PricingDiffSummary,
  type ProductSlot,
  type SlotParamChange,
} from './types.ts';
import { PRICE_PARAM_SPECS } from './layout-engine.ts';

export const MILK_PRESET_IDS: ReadonlySet<number> = new Set([5, 6, 7, 8, 9, 14, 15, 16, 20, 24]);

function buildPl1Mapping(
  targetGroup: PriceListGroup
): ReadonlyMap<PriceParamCode, PriceParamCode> {
  const targetByKey = new Map<string, PriceParamCode>();
  for (const spec of PRICE_PARAM_SPECS) {
    if (spec.group === targetGroup) {
      targetByKey.set(`${spec.grinder}:${spec.cupSize}`, spec.paramId);
    }
  }
  const map = new Map<PriceParamCode, PriceParamCode>();
  for (const spec of PRICE_PARAM_SPECS) {
    if (spec.group === PriceListGroup.PL1) {
      const targetId = targetByKey.get(`${spec.grinder}:${spec.cupSize}`);
      if (targetId) {
        map.set(spec.paramId, targetId);
      }
    }
  }
  return map;
}

const PL1_TO_PL2_MAP = buildPl1Mapping(PriceListGroup.PL2);
const PL1_TO_PL3_MAP = buildPl1Mapping(PriceListGroup.PL3);
const VALID_PRICE_PARAM_CODES: ReadonlySet<string> = new Set(
  PRICE_PARAM_SPECS.map((s) => s.paramId)
);
export const ALL_PRICE_PARAM_CODES: readonly PriceParamCode[] = Object.freeze(
  PRICE_PARAM_SPECS.filter((s) => s.isPrice).map((s) => s.paramId)
);

export const DYNAMIC_PRICING_PRESETS: readonly DynamicPricingRule[] = Object.freeze([
  {
    id: PricingPresetId.HappyHour20Off,
    mode: PricingRuleMode.PercentChange,
    percentChange: -20,
    targetPriceLists: [PriceListGroup.PL1, PriceListGroup.PL2, PriceListGroup.PL3],
    targetBeverageFilter: BeverageFilter.All,
    roundStep: 5,
  },
  {
    id: PricingPresetId.MorningMilkSurge,
    mode: PricingRuleMode.FlatOffset,
    flatOffsetMinor: 30,
    targetPriceLists: [PriceListGroup.PL1],
    targetBeverageFilter: BeverageFilter.MilkDrinks,
    roundStep: 5,
  },
  {
    id: PricingPresetId.EmployeeSubsidizedTiers,
    mode: PricingRuleMode.TierPriceList2And3,
    pl2Ratio: 0.75,
    pl3Ratio: 0.5,
    targetPriceLists: [PriceListGroup.PL2, PriceListGroup.PL3],
    targetBeverageFilter: BeverageFilter.All,
    roundStep: 5,
  },
  {
    id: PricingPresetId.FreeVendEvent,
    mode: PricingRuleMode.FreeVend,
    targetPriceLists: [PriceListGroup.PL1, PriceListGroup.PL2, PriceListGroup.PL3],
    targetBeverageFilter: BeverageFilter.All,
    roundStep: 1,
  },
]);

export function findDynamicPricingPreset(presetId: string): DynamicPricingRule | null {
  return DYNAMIC_PRICING_PRESETS.find((p) => p.id === presetId) || null;
}

export function roundAndClampPrice(
  rawMinorValue: number,
  roundStep = 5,
  min = 0,
  max = 65000
): number {
  const step = Math.max(1, Number.parseInt(String(roundStep), 10) || 1);
  const rounded = Math.round(rawMinorValue / step) * step;
  return Math.max(min, Math.min(max, rounded));
}

export function formatMinorPrice(minorValue: number | string | undefined, decimals = 2): string {
  const num = Number(minorValue) || 0;
  if (decimals === 0) {
    return String(Math.round(num));
  }
  return (num / 10 ** decimals).toFixed(decimals);
}

export function parseDecimalToMinorPrice(decimalInput: string | number, decimals = 2): number {
  const parsed = Number.parseFloat(String(decimalInput).replace(',', '.'));
  if (Number.isNaN(parsed)) {
    return 0;
  }
  const factor = 10 ** decimals;
  return roundAndClampPrice(Math.round(parsed * factor), 1);
}

function matchesBeverageFilter(
  productSlot: ProductSlot,
  filterType?: BeverageFilter
): boolean {
  if (!filterType || filterType === BeverageFilter.All) {
    return true;
  }
  if (filterType === BeverageFilter.MilkDrinks) {
    return (
      MILK_PRESET_IDS.has(productSlot.product) ||
      /milk|macchiato|cappuccino|chociatto|schoko|latte/i.test(
        `${productSlot.productTypeKey || ''} ${productSlot.name || ''}`
      )
    );
  }
  return true;
}

function applyRuleToSlotParams(
  slot: ProductSlot,
  rule: DynamicPricingRule,
  targetLists: ReadonlySet<PriceListGroup>,
  roundStep: number
): PriceParamsRecord {
  const nextParams: PriceParamsRecord = { ...slot.params };

  switch (rule.mode) {
    case PricingRuleMode.TierPriceList2And3: {
      const pl2Ratio = Number(rule.pl2Ratio ?? 0.75);
      const pl3Ratio = Number(rule.pl3Ratio ?? 0.5);
      if (targetLists.has(PriceListGroup.PL2)) {
        for (const [pl1Key, pl2Key] of PL1_TO_PL2_MAP) {
          nextParams[pl2Key] = roundAndClampPrice(
            (nextParams[pl1Key] || 0) * pl2Ratio,
            roundStep
          );
        }
      }
      if (targetLists.has(PriceListGroup.PL3)) {
        for (const [pl1Key, pl3Key] of PL1_TO_PL3_MAP) {
          nextParams[pl3Key] = roundAndClampPrice(
            (nextParams[pl1Key] || 0) * pl3Ratio,
            roundStep
          );
        }
      }
      return nextParams;
    }

    case PricingRuleMode.FreeVend:
      for (const spec of PRICE_PARAM_SPECS) {
        if (spec.isPrice && targetLists.has(spec.group)) {
          nextParams[spec.paramId] = 0;
        }
      }
      return nextParams;

    case PricingRuleMode.PercentChange: {
      const factor = 1 + Number(rule.percentChange ?? 0) / 100;
      for (const spec of PRICE_PARAM_SPECS) {
        if (!spec.isPrice || !targetLists.has(spec.group)) continue;
        const currentVal = nextParams[spec.paramId] || 0;
        nextParams[spec.paramId] =
          currentVal > 0 ? roundAndClampPrice(currentVal * factor, roundStep) : 0;
      }
      return nextParams;
    }

    case PricingRuleMode.FlatOffset: {
      const delta = Number(rule.flatOffsetMinor ?? 0);
      for (const spec of PRICE_PARAM_SPECS) {
        if (!spec.isPrice || !targetLists.has(spec.group)) continue;
        const currentVal = nextParams[spec.paramId] || 0;
        nextParams[spec.paramId] =
          currentVal > 0 ? roundAndClampPrice(currentVal + delta, roundStep) : 0;
      }
      return nextParams;
    }
  }
}

export function applyDynamicPricingRule(
  machineLayout: MachineLayout,
  rule: DynamicPricingRule
): MachineLayout {
  const roundStep = Number(rule.roundStep) || 5;
  const targetLists = new Set<PriceListGroup>(
    rule.targetPriceLists || [PriceListGroup.PL1, PriceListGroup.PL2, PriceListGroup.PL3]
  );
  const filterType = rule.targetBeverageFilter || BeverageFilter.All;

  const updatedProducts = machineLayout.products.map((slot) => {
    if (!matchesBeverageFilter(slot, filterType)) {
      return slot;
    }
    return {
      ...slot,
      params: applyRuleToSlotParams(slot, rule, targetLists, roundStep),
    };
  });

  return {
    ...machineLayout,
    products: updatedProducts,
  };
}

// Intentional asymmetry: editing PL1 Gr1 Single ('47') syncs both Single & Double grinders,
// whereas editing PL1 Gr1 Double ('50') syncs only Double grinders.
const LINKED_GRINDER_PARAMS: Readonly<
  Partial<Record<PriceParamCode, readonly PriceParamCode[]>>
> = Object.freeze({
  '47': ['47', '48', '91', '49', '50', '51', '92', '52'],
  '50': ['50', '51', '92', '52'],
  '53': ['53', '54', '93', '55'],
  '56': ['56', '57', '94', '58'],
  '59': ['59', '60', '95', '61'],
  '62': ['62', '63', '96', '64'],
});

export function updateSingleProductParam(
  machineLayout: MachineLayout,
  productId: number | string,
  paramId: PriceParamCode | string,
  newMinorValue: number | string,
  options: { syncGrinders?: boolean } = {}
): MachineLayout {
  const targetId = Number.parseInt(String(productId), 10);
  const clamped = roundAndClampPrice(Number(newMinorValue) || 0, 1);
  const key = String(paramId);
  const syncGrinders = Boolean(options.syncGrinders);

  const updatedProducts = machineLayout.products.map((slot) => {
    if (slot.id !== targetId) {
      return slot;
    }
    const nextParams: PriceParamsRecord = { ...slot.params };
    if (VALID_PRICE_PARAM_CODES.has(key)) {
      nextParams[key as PriceParamCode] = clamped;
    }
    const linked = syncGrinders ? LINKED_GRINDER_PARAMS[key as PriceParamCode] : undefined;
    if (linked) {
      for (const linkedKey of linked) {
        nextParams[linkedKey] = clamped;
      }
    }
    return {
      ...slot,
      params: nextParams,
    };
  });

  return {
    ...machineLayout,
    products: updatedProducts,
  };
}

/**
 * Sets a single uniform minor-unit price across all 24 price parameters (`47..64`, `91..96`:
 * PL1/PL2/PL3 × Gr1/Gr2/Gr3/Decaf × Single/Double) for a product slot, while preserving
 * non-price Payment / MDB / PLU selection codes (`65..70`, `97..98`).
 */
export function updateProductPrice(
  machineLayout: MachineLayout,
  productId: number | string,
  newMinorValue: number | string
): MachineLayout {
  const targetId = Number.parseInt(String(productId), 10);
  const clamped = roundAndClampPrice(Number(newMinorValue) || 0, 1);

  const updatedProducts = machineLayout.products.map((slot) => {
    if (slot.id !== targetId) {
      return slot;
    }
    const nextParams: PriceParamsRecord = { ...slot.params };
    for (const code of ALL_PRICE_PARAM_CODES) {
      nextParams[code] = clamped;
    }
    return {
      ...slot,
      params: nextParams,
    };
  });

  return {
    ...machineLayout,
    products: updatedProducts,
  };
}

export function exportToPriceListJson(
  machineLayout: MachineLayout,
  options: { ignoreRecipeMatch?: boolean } = {}
): PriceListJson {
  const ignoreFlag = options.ignoreRecipeMatch ?? machineLayout.ignoreRecipeMatch;
  const ignoreRecipeMatch: 0 | 1 = ignoreFlag ? 1 : 0;

  const products: PriceListProductEntry[] = machineLayout.products.map((slot) => {
    const entry: PriceListProductEntry = {
      id: slot.id,
      product: slot.product,
    };
    for (const spec of PRICE_PARAM_SPECS) {
      entry[spec.paramId] = Number(slot.params[spec.paramId] ?? 0);
    }
    return entry;
  });

  return {
    rows: machineLayout.rows,
    columns: machineLayout.columns,
    categories: machineLayout.categories,
    ignoreRecipeMatch,
    products,
  };
}

export function computePricingDiff(
  originalLayout: MachineLayout,
  currentLayout: MachineLayout
): PricingDiffSummary {
  const origById = new Map<number, ProductSlot>(
    originalLayout.products.map((p) => [p.id, p])
  );
  const changedSlots: ChangedSlotSummary[] = [];
  let totalChangedFields = 0;

  for (const currSlot of currentLayout.products) {
    const origSlot = origById.get(currSlot.id);
    if (!origSlot) continue;

    const paramChanges: SlotParamChange[] = [];
    for (const spec of PRICE_PARAM_SPECS) {
      const beforeVal = origSlot.params[spec.paramId] ?? 0;
      const afterVal = currSlot.params[spec.paramId] ?? 0;
      if (beforeVal !== afterVal) {
        totalChangedFields += 1;
        paramChanges.push({
          paramId: spec.paramId,
          enumName: spec.enumName,
          group: spec.group,
          variant: spec.variant,
          before: beforeVal,
          after: afterVal,
        });
      }
    }

    if (paramChanges.length > 0) {
      changedSlots.push({
        id: currSlot.id,
        name: currSlot.name,
        product: currSlot.product,
        changes: paramChanges,
      });
    }
  }

  return {
    changedSlotCount: changedSlots.length,
    totalChangedFields,
    changedSlots,
  };
}
