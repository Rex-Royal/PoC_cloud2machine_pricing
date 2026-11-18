/**
 * Minimal Headless ERP / Backend Reference Script (Rex-Royal Dynamic Pricing V1).
 *
 * Run offline demo (no credentials needed):
 *   npm run example
 *
 * Run against a live ThingsBoard + FtpProxy tenant:
 *   TB_BASE_URL=https://iot.rex-royal.ch \
 *   FTP_BASE_URL=https://iot.rex-royal.ch:8787 \
 *   TB_USERNAME=you@example.com TB_PASSWORD=... \
 *   CUSTOMER_ID=<uuid> DEVICE_ID=<uuid> NEW_PRICE_MINOR=420 \
 *   node --experimental-transform-types examples/minimal-price-push.ts
 */

import { AuthService } from '#cloud-client';
import {
  appendCommandToCmdStack,
  buildApplyPricingRpcCommand,
  createPartialPricingBackupZip,
  exportToPriceListJson,
  parseMachineConfig,
  SAMPLE_LAYOUT_3X5,
  updateProductPrice,
  validatePriceListAgainstMachine,
} from '#firmware-core';
import { CoffeeMachineService } from '#fleet-sync';

const isDemo = process.argv.includes('--demo') || !process.env.TB_USERNAME;

async function main(): Promise<void> {
  const newPriceMinor = Number.parseInt(
    process.env.NEW_PRICE_MINOR || process.env.NEW_SINGLE_MINOR || '420',
    10
  );

  if (isDemo) {
    const customerId = '00000000-0000-4000-8000-000000000001';
    const layout = parseMachineConfig(SAMPLE_LAYOUT_3X5);
    const updated = updateProductPrice(layout, 1, newPriceMinor);

    const priceList = exportToPriceListJson(updated, { ignoreRecipeMatch: false });
    const validation = validatePriceListAgainstMachine(priceList, layout);
    if (!validation.valid) throw new Error(validation.abortReason || 'Layout check failed');

    const pkg = createPartialPricingBackupZip(priceList, `add_priceList_${layout.layoutKey}.zip`);
    const cmd = buildApplyPricingRpcCommand(customerId, pkg.fileName);
    const cmdStackLine = appendCommandToCmdStack('', cmd);

    console.log('[DEMO 1/4] Parsed layout:', layout.layoutKey, `(${layout.products.length} slots)`);
    console.log('[DEMO 2/4] Validated compatibility:', validation);
    console.log(`[DEMO 3/4] Packaged ${pkg.fileName} (${pkg.byteLength} bytes, priceList.json at ZIP root)`);
    console.log(`[DEMO 4/4] Built RPC / offline cmdStack entry (${cmdStackLine.length} chars):`, cmd.method, cmd.params);
    return;
  }

  const tbBaseUrl = process.env.TB_BASE_URL || 'https://iot.rex-royal.ch';
  const ftpBaseUrl = process.env.FTP_BASE_URL || 'https://iot.rex-royal.ch:8787';
  const username = process.env.TB_USERNAME!;
  const password = process.env.TB_PASSWORD || '';
  const deviceId = process.env.DEVICE_ID;
  if (!deviceId) throw new Error('Set DEVICE_ID (and optionally CUSTOMER_ID) when running live.');

  // 1. Direct server-to-cloud auth (disable Next.js browser CORS proxy)
  AuthService.configure({ tbBaseUrl, ftpBaseUrl, useLocalCorsProxy: false });
  await AuthService.login(username, password);
  const user = await AuthService.getCurrentUser();
  const customerId = process.env.CUSTOMER_ID || user.customerId?.id;
  if (!customerId) throw new Error('Set CUSTOMER_ID or sign in with a customer user.');

  // 2. Download Config/{deviceId}/config.json and validate price update
  const rawConfig = await CoffeeMachineService.downloadConfigJson(deviceId);
  const layout = parseMachineConfig(rawConfig);
  const updated = updateProductPrice(layout, 1, newPriceMinor);
  const priceList = exportToPriceListJson(updated);
  const validation = validatePriceListAgainstMachine(priceList, layout);
  if (!validation.valid) throw new Error(validation.abortReason || 'Layout mismatch');

  // 3. Stage add_priceList_*.zip in Backup/{customerId}/
  const pkg = createPartialPricingBackupZip(priceList, `add_priceList_${layout.layoutKey}.zip`);
  await CoffeeMachineService.uploadCustomerBackupZip(customerId, pkg);

  // 4. Smart dual-path delivery (2-way getTermInfo ping -> live applyBackup OR offline cmdStack.json)
  const isAwake = await CoffeeMachineService.probeMachineLiveRpc(deviceId, 2500);
  if (isAwake) {
    await CoffeeMachineService.removeBackupFromCmdStack(deviceId, pkg.fileName);
    await CoffeeMachineService.sendApplyBackupRpc(deviceId, customerId, pkg.fileName);
    console.log(`[LIVE] Sent single-shot applyBackup RPC to ${deviceId} (${pkg.fileName})`);
  } else {
    await CoffeeMachineService.enqueueOfflineCmdStack(deviceId, customerId, pkg.fileName);
    console.log(`[OFFLINE] Queued ${pkg.fileName} in Config/${deviceId}/cmdStack.json`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
