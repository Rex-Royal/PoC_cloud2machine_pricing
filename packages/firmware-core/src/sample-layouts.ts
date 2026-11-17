/**
 * Synthetic Sample Machine Layouts (`3×5` S2 & `4×6` S300/S500) used only for online simulators.
 */

import type {
  RawConfigProductNode,
  RawMachineConfigJson,
} from './types.ts';

function buildSampleProductSlot(
  id: number,
  name: string,
  productType: number,
  singlePriceMinor: number,
  doublePriceMinor: number,
  pluBase = 100
): RawConfigProductNode {
  const pl2Single = Math.round((singlePriceMinor * 0.8) / 5) * 5;
  const pl3Single = Math.round((singlePriceMinor * 0.6) / 5) * 5;
  const pluCode = String(pluBase + id);
  return {
    id,
    name,
    productType: String(productType),
    attributes: [
      { name: 'RecipeID', value: String(id) },
      { name: 'M0801', value: String(productType) },
      { name: 'ProdName', value: name },
      { name: 'M1401', value: String(singlePriceMinor) },
      { name: 'M1406', value: String(doublePriceMinor) },
      { name: 'M1411', value: String(pl2Single) },
      { name: 'M1421', value: String(pl3Single) },
      { name: 'M1404', value: String(singlePriceMinor) },
      { name: 'M1601', value: pluCode },
    ],
  };
}

/**
 * Full Rex-Royal S2 3x5 Self-Service Layout (15 grid products = 3 rows × 5 columns).
 */
export const SAMPLE_LAYOUT_3X5: RawMachineConfigJson = {
  rows: 3,
  columns: 5,
  categories: 1,
  selfService: '1',
  prodCatArray: [
    {
      id: 0,
      products: [
        buildSampleProductSlot(1, 'Ristretto', 3, 340, 500, 100),
        buildSampleProductSlot(2, 'Espresso', 4, 350, 520, 100),
        buildSampleProductSlot(3, 'Café Crème', 2, 380, 560, 100),
        buildSampleProductSlot(4, 'Americano', 17, 390, 570, 100),
        buildSampleProductSlot(5, 'Espresso Macchiato', 5, 400, 580, 100),
        buildSampleProductSlot(6, 'Cappuccino', 14, 450, 650, 100),
        buildSampleProductSlot(7, 'Latte Macchiato', 15, 480, 680, 100),
        buildSampleProductSlot(8, 'Flat White', 20, 470, 670, 100),
        buildSampleProductSlot(9, 'Café au Lait', 6, 440, 640, 100),
        buildSampleProductSlot(10, 'Moccacino', 7, 490, 690, 100),
        buildSampleProductSlot(11, 'Chociatto', 16, 460, 660, 100),
        buildSampleProductSlot(12, 'Choco', 8, 420, 600, 100),
        buildSampleProductSlot(13, 'Warm Milk', 9, 320, 480, 100),
        buildSampleProductSlot(14, 'Hot Water', 10, 250, 380, 100),
        buildSampleProductSlot(15, 'Hot Water Portion', 31, 280, 420, 100),
      ],
    },
  ],
};

/**
 * Full Rex-Royal S300/S500 4x6 Layout (24 grid products = 4 rows × 6 columns).
 */
export const SAMPLE_LAYOUT_4X6: RawMachineConfigJson = {
  rows: 4,
  columns: 6,
  categories: 1,
  selfService: '1',
  prodCatArray: [
    {
      id: 0,
      products: [
        buildSampleProductSlot(1, 'Ristretto', 3, 340, 500, 200),
        buildSampleProductSlot(2, 'Espresso', 4, 350, 520, 200),
        buildSampleProductSlot(3, 'Double Espresso', 18, 520, 720, 200),
        buildSampleProductSlot(4, 'Café Crème', 2, 380, 560, 200),
        buildSampleProductSlot(5, 'Double Coffee', 19, 560, 760, 200),
        buildSampleProductSlot(6, 'Americano', 17, 390, 570, 200),
        buildSampleProductSlot(7, 'Espresso Macchiato', 5, 400, 580, 200),
        buildSampleProductSlot(8, 'Cappuccino', 14, 450, 650, 200),
        buildSampleProductSlot(9, 'Cappuccino Grande', 14, 520, 740, 200),
        buildSampleProductSlot(10, 'Latte Macchiato', 15, 480, 680, 200),
        buildSampleProductSlot(11, 'Flat White', 20, 470, 670, 200),
        buildSampleProductSlot(12, 'Café au Lait', 6, 440, 640, 200),
        buildSampleProductSlot(13, 'Cold Foam Latte', 24, 540, 760, 200),
        buildSampleProductSlot(14, 'Cold Foam Cappuccino', 24, 530, 750, 200),
        buildSampleProductSlot(15, 'Moccacino', 7, 490, 690, 200),
        buildSampleProductSlot(16, 'Chociatto', 16, 460, 660, 200),
        buildSampleProductSlot(17, 'Choco', 8, 420, 600, 200),
        buildSampleProductSlot(18, 'Choco Grande', 8, 490, 690, 200),
        buildSampleProductSlot(19, 'Warm Milk', 9, 320, 480, 200),
        buildSampleProductSlot(20, 'Cold Milk Foam', 9, 340, 500, 200),
        buildSampleProductSlot(21, 'Steam Milk', 9, 320, 480, 200),
        buildSampleProductSlot(22, 'Hot Water', 10, 250, 380, 200),
        buildSampleProductSlot(23, 'Hot Water Tea', 31, 280, 420, 200),
        buildSampleProductSlot(24, 'Hot Water Special', 37, 300, 450, 200),
      ],
    },
  ],
};
