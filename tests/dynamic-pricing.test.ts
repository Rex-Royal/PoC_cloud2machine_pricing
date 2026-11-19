/**
 * Automated Unit & Integration Tests for the Rex-Royal Dynamic Pricing Next.js App (TypeScript).
 * Run with: npm test (or node --test tests/dynamic-pricing.test.ts)
 */

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { AuthService, FtpService, parseUpstreamBaseUrl, TbService } from '#cloud-client';
import {
  ALL_PRICE_PARAM_CODES,
  ApiBasePath,
  appendCommandToCmdStack,
  applyDynamicPricingRule,
  buildApplyPricingRpcCommand,
  buildPricingDownloadArtifact,
  clusterMachinesByLayout,
  computePricingDiff,
  createPartialPricingBackupZip,
  DYNAMIC_PRICING_PRESETS,
  ensureSafePartialBackupFilename,
  evaluateMachineSyncState,
  exportToPriceListJson,
  findDynamicPricingPreset,
  FtpResourceType,
  MachineConfigFile,
  MachineSyncState,
  MimeType,
  parseCmdStackContent,
  parseMachineConfig,
  PricingPresetId,
  readStoredZipArchive,
  updateProductPrice,
  updateSingleProductParam,
  validatePriceListAgainstMachine,
} from '#firmware-core';
import { DynamicPricingService } from '#fleet-sync';
import { POST as tbRoutePost } from '../src/app/api-bridge/tb/[...path]/route.ts';
import { SUPPORTED_LOCALES, TRANSLATIONS, translate } from '../src/i18n/translations.ts';
import {
  applyEditedPricesToRawConfigJson,
  makeRawConfig,
  resetCloudConnectionState,
} from './fixtures.ts';

const SAMPLE_CONFIG_3X5 = makeRawConfig();

const SAMPLE_CONFIG_4X6 = makeRawConfig({
  rows: 4,
  columns: 6,
  categories: 2,
  products: [
    {
      id: 1,
      name: 'Coffee',
      productType: '2',
      attributes: [
        { name: 'RecipeID', value: '1' },
        { name: 'M0801', value: '2' },
        { name: 'ProdName', value: 'Coffee' },
        { name: 'M1401', value: '380' },
        { name: 'M1406', value: '550' },
        { name: 'M1601', value: '21' },
      ],
    },
  ],
});

afterEach(() => resetCloudConnectionState());

describe('Dynamic Pricing — Firmware Layout & Clustering Engine', () => {
  it('parses config.json and groups heterogeneous machines into distinct layout clusters', () => {
    const machines = [
      { id: 'm1', layout: parseMachineConfig(SAMPLE_CONFIG_3X5) },
      { id: 'm2', layout: parseMachineConfig(SAMPLE_CONFIG_3X5) },
      { id: 'm3', layout: parseMachineConfig(SAMPLE_CONFIG_4X6) },
    ];

    const clusters = clusterMachinesByLayout(machines);
    assert.equal(clusters.length, 2, 'Expected 2 distinct layout clusters (3x5 and 4x6)');
    assert.equal(clusters[0].machines.length, 2);
    assert.equal(clusters[1].machines.length, 1);
  });

  it('enforces Firmware Check 1 (grid geometry equality) and Check 2 (M0801 slot recipe match)', () => {
    const layout3x5 = parseMachineConfig(SAMPLE_CONFIG_3X5);
    const layout4x6 = parseMachineConfig(SAMPLE_CONFIG_4X6);

    const priceList3x5 = exportToPriceListJson(layout3x5, { ignoreRecipeMatch: false });

    const validCheck = validatePriceListAgainstMachine(priceList3x5, layout3x5);
    assert.equal(validCheck.valid, true);
    assert.equal(validCheck.check1GridMatch, true);
    assert.equal(validCheck.check2RecipeMatch, true);

    const mismatchGridCheck = validatePriceListAgainstMachine(priceList3x5, layout4x6);
    assert.equal(mismatchGridCheck.valid, false);
    assert.equal(mismatchGridCheck.check1GridMatch, false);

    const mutatedRecipePriceList = structuredClone(priceList3x5);
    mutatedRecipePriceList.products[0].product = 99;
    const mismatchRecipeCheck = validatePriceListAgainstMachine(mutatedRecipePriceList, layout3x5);
    assert.equal(mismatchRecipeCheck.valid, false);
    assert.equal(mismatchRecipeCheck.check1GridMatch, true);
    assert.equal(mismatchRecipeCheck.check2RecipeMatch, false);

    mutatedRecipePriceList.ignoreRecipeMatch = 1;
    const overrideCheck = validatePriceListAgainstMachine(mutatedRecipePriceList, layout3x5);
    assert.equal(overrideCheck.valid, true);
  });
});

describe('Dynamic Pricing — Pricing Rules & 32-Parameter Export', () => {
  it('applies discount (-20%), milk adjustment (+0.30), and single-cell edits with 5-Rappen rounding', () => {
    const baseLayout = parseMachineConfig(SAMPLE_CONFIG_3X5);

    const happyHourRule = DYNAMIC_PRICING_PRESETS.find(
      (p) => p.id === PricingPresetId.HappyHour20Off
    )!;
    const discountedLayout = applyDynamicPricingRule(baseLayout, happyHourRule);
    const diff = computePricingDiff(baseLayout, discountedLayout);
    assert.ok(diff.changedSlotCount > 0);
    assert.ok(diff.totalChangedFields > 0);

    for (const slot of discountedLayout.products) {
      assert.equal(slot.params['47'] % 5, 0, 'Price must be rounded to nearest 5 Rappen');
    }

    const editedLayout = updateSingleProductParam(discountedLayout, 1, '47', 425);
    assert.equal(editedLayout.products.find((s) => s.id === 1)?.params['47'], 425);

    const priceListJson = exportToPriceListJson(editedLayout, { ignoreRecipeMatch: false });
    assert.equal(priceListJson.products.length, baseLayout.products.length);
    assert.equal(priceListJson.products[0]['47'], 425);
    assert.ok('98' in priceListJson.products[0]);
  });

  it('clusters machines directly from rawConfigJson, syncs grinder prices, and writes edited prices back into config.json', () => {
    const rawMachines = [
      { id: 'sim-1', rawConfigJson: SAMPLE_CONFIG_3X5 },
      { id: 'sim-2', rawConfigJson: SAMPLE_CONFIG_3X5 },
    ];
    const clusters = clusterMachinesByLayout(rawMachines);
    assert.equal(clusters.length, 1);
    assert.equal(clusters[0].machines.length, 2);

    const preset = findDynamicPricingPreset('HAPPY_HOUR_20_OFF');
    assert.ok(preset, 'Must resolve preset by UI alias HAPPY_HOUR_20_OFF');

    const syncedLayout = updateSingleProductParam(
      clusters[0].referenceLayout,
      1,
      '47',
      '480',
      { syncGrinders: true }
    );
    const slot1 = syncedLayout.products.find((p) => p.id === 1)!;
    assert.equal(slot1.params['47'], 480);
    assert.equal(slot1.params['48'], 480, 'Grinder 2 single must sync with Grinder 1 single');
    assert.equal(slot1.params['91'], 480, 'Grinder 3 single must sync with Grinder 1 single');

    const updatedRaw = applyEditedPricesToRawConfigJson(SAMPLE_CONFIG_3X5, syncedLayout);
    const reparsed = parseMachineConfig(updatedRaw);
    assert.equal(reparsed.products.find((p) => p.id === 1)?.params['47'], 480);
    assert.equal(reparsed.products.find((p) => p.id === 1)?.params['48'], 480);
  });

  it('updateProductPrice sets all 24 price fields (47..64, 91..96) while preserving PLU/MDB codes (65..70, 97..98)', () => {
    const configWithPluCodes = makeRawConfig({
      products: [
        {
          id: 1,
          name: 'Coffee',
          productType: '2',
          attributes: [
            { name: 'RecipeID', value: '1' },
            { name: 'M0801', value: '2' },
            { name: 'ProdName', value: 'Coffee' },
            { name: 'M1401', value: '350' },
            { name: 'M1406', value: '520' },
            { name: 'M1411', value: '0' },
            { name: 'M1601', value: '1' },
            { name: 'M1602', value: '1' },
            { name: 'M1603', value: '1' },
            { name: 'M1604', value: '1' },
            { name: 'M1606', value: '1' },
            { name: 'M1607', value: '1' },
            { name: 'M1608', value: '1' },
            { name: 'M1609', value: '1' },
          ],
        },
        {
          id: 2,
          name: 'Espresso',
          productType: '4',
          attributes: [
            { name: 'RecipeID', value: '2' },
            { name: 'M0801', value: '4' },
            { name: 'ProdName', value: 'Espresso' },
            { name: 'M1401', value: '400' },
            { name: 'M1406', value: '550' },
            { name: 'M1601', value: '2' },
          ],
        },
      ],
    });

    assert.equal(ALL_PRICE_PARAM_CODES.length, 24);

    const layout = parseMachineConfig(configWithPluCodes);
    const updated = updateProductPrice(layout, 1, 900);
    const exported = exportToPriceListJson(updated, { ignoreRecipeMatch: false });

    const expectedPriceKeys = [
      '47', '48', '49', '50', '51', '52',
      '53', '54', '55', '56', '57', '58',
      '59', '60', '61', '62', '63', '64',
      '91', '92', '93', '94', '95', '96',
    ] as const;
    for (const key of expectedPriceKeys) {
      assert.equal(exported.products[0][key], 900, `Price key "${key}" must be 900`);
    }

    const expectedPluKeys = ['65', '66', '67', '68', '69', '70', '97', '98'] as const;
    for (const key of expectedPluKeys) {
      assert.equal(exported.products[0][key], 1, `PLU/MDB code "${key}" must remain 1`);
    }

    assert.equal(exported.products[1]['47'], 400, 'Other product slots must remain unchanged');
    assert.equal(exported.products[1]['50'], 550);
    assert.equal(exported.products[1]['65'], 2);
  });
});

describe('Dynamic Pricing — Partial Backup ZIP & Async cmdStack.json Codecs', () => {
  it('enforces add_ prefix and packages priceList.json at the root of the ZIP archive', () => {
    assert.equal(
      ensureSafePartialBackupFilename('priceList_3x5.zip'),
      'add_priceList_3x5.zip',
      'Must prepend add_ so MachineController::restoreBackup preserves custom layouts'
    );
    assert.equal(
      ensureSafePartialBackupFilename('import_custom.zip'),
      'import_custom.zip',
      'Must preserve existing import_ prefix'
    );

    const samplePriceList = {
      rows: 2,
      columns: 4,
      categories: 1,
      ignoreRecipeMatch: 0,
      products: [{ id: 1, product: 2, '47': 350 }],
    };

    const zipPkg = createPartialPricingBackupZip(samplePriceList, 'priceList_test.zip');
    assert.equal(zipPkg.fileName, 'add_priceList_test.zip');
    assert.ok(zipPkg.byteLength > 60);

    const extracted = readStoredZipArchive(zipPkg.zipBytes);
    assert.ok('priceList.json' in extracted);

    const decodedJson = JSON.parse(extracted['priceList.json']);
    assert.deepEqual(decodedJson, samplePriceList);
  });

  it('encodes and decodes cmdStack.json commands matching cmdStack framing', () => {
    const customerId = '00000000-0000-4000-8000-000000000001';
    const cmd1 = buildApplyPricingRpcCommand(customerId, 'add_priceList_3x5.zip');
    const cmd2 = buildApplyPricingRpcCommand(customerId, 'add_priceList_4x6.zip');

    let rawStack = '';
    rawStack = appendCommandToCmdStack(rawStack, cmd1);
    rawStack = appendCommandToCmdStack(rawStack, cmd2);

    assert.ok(rawStack.endsWith('||'), 'Each entry in cmdStack.json must be terminated by ||');
    const decodedCommands = parseCmdStackContent(rawStack);
    assert.equal(decodedCommands.length, 2);
    assert.deepEqual(decodedCommands[0].command, cmd1);
    assert.deepEqual(decodedCommands[1].command, cmd2);

    const pendingState = evaluateMachineSyncState({
      hasUnsavedChanges: false,
      hasCmdStackOnFtp: true,
      wasDispatched: true,
      pricesMatchTarget: false,
    });
    assert.equal(pendingState, MachineSyncState.Pending);
  });

  it('buildPricingDownloadArtifact exports safe add_priceList_*.zip and priceList.json downloads', () => {
    const baseLayout = parseMachineConfig(SAMPLE_CONFIG_3X5);
    const updated = updateProductPrice(baseLayout, 1, 490);
    const groupZipName = 'add_priceList_3x5x1_abc_group-1.zip';

    const zipArtifact = buildPricingDownloadArtifact(updated, groupZipName, 'zip', {
      ignoreRecipeMatch: false,
    });
    assert.equal(zipArtifact.fileName, groupZipName);
    assert.equal(zipArtifact.mimeType, MimeType.Zip);
    assert.ok(zipArtifact.content instanceof Uint8Array);
    const extracted = readStoredZipArchive(zipArtifact.content);
    assert.ok('priceList.json' in extracted);
    const zipJson = JSON.parse(extracted['priceList.json']);
    assert.equal(zipJson.products[0]['47'], 490);
    assert.equal(zipJson.products[0]['96'], 490);

    const jsonArtifact = buildPricingDownloadArtifact(updated, groupZipName, 'json', {
      ignoreRecipeMatch: false,
    });
    assert.equal(jsonArtifact.fileName, 'priceList.json');
    assert.equal(jsonArtifact.mimeType, MimeType.Json);
    assert.equal(typeof jsonArtifact.content, 'string');
    const rawJson = JSON.parse(jsonArtifact.content as string);
    assert.equal(rawJson.products[0]['47'], 490);
    assert.equal(rawJson.products[0]['96'], 490);
  });
});

describe('Dynamic Pricing — Service Responsibilities & Multi-Locale Parity', () => {
  it('maintains 100% translation key parity across en_US, de_DE, and fr_FR', () => {
    const enKeys = Object.keys(TRANSLATIONS.en_US).sort();
    const deKeys = Object.keys(TRANSLATIONS.de_DE).sort();
    const frKeys = Object.keys(TRANSLATIONS.fr_FR).sort();

    assert.deepEqual(deKeys, enKeys, 'de_DE keys must match en_US keys');
    assert.deepEqual(frKeys, enKeys, 'fr_FR keys must match en_US keys');
    assert.equal(SUPPORTED_LOCALES.length, 3);
    assert.ok(translate('de_DE', 'appTitle').length > 0);
  });

  it('validates X-Target-Origin / X-Target-Base-Url and enforces SSRF host allowlist in proxy bridge', async () => {
    assert.equal(parseUpstreamBaseUrl(null), null);
    assert.equal(parseUpstreamBaseUrl('ftp://invalid-protocol.ch'), null);
    assert.equal(
      parseUpstreamBaseUrl('https://iot.rex-royal.ch')?.origin,
      'https://iot.rex-royal.ch'
    );

    const badRequest = new Request('http://localhost:4173/api-bridge/tb/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({}),
    });

    const badResponse = await tbRoutePost(badRequest, {
      params: Promise.resolve({ path: ['api', 'auth', 'login'] }),
    });
    assert.equal(badResponse.status, 400);

    for (const blockedOrigin of ['http://169.254.169.254', 'https://evil.example.com']) {
      const ssrfReq = new Request('http://localhost:4173/api-bridge/tb/api/auth/user', {
        method: 'GET',
        headers: { 'x-target-origin': blockedOrigin },
      });
      const ssrfRes = await tbRoutePost(ssrfReq, {
        params: Promise.resolve({ path: ['api', 'auth', 'user'] }),
      });
      assert.equal(ssrfRes.status, 403, `Must block SSRF origin ${blockedOrigin}`);
    }
  });

  it('exposes static TbService (/api), FtpService (/api/v2), and DynamicPricingService helpers with strict enums', () => {
    AuthService.configure({
      tbBaseUrl: 'https://iot.rex-royal.ch',
      ftpBaseUrl: 'https://iot.rex-royal.ch:8787',
      jwtToken: 'test-token',
    });

    assert.equal(TbService.basePath, ApiBasePath.ThingsBoard);
    assert.equal(FtpService.basePath, ApiBasePath.FtpV2);
    assert.equal(FtpResourceType.Config, 'Config');
    assert.equal(FtpResourceType.Backup, 'Backup');
    assert.equal(MachineConfigFile.ConfigJson, 'config.json');

    const machines = [
      { id: 'sim-5', rawConfigJson: SAMPLE_CONFIG_3X5 },
      { id: 'sim-6', rawConfigJson: SAMPLE_CONFIG_3X5 },
    ];
    const clusters = DynamicPricingService.groupMachinesByLayout(machines);
    assert.equal(clusters.length, 1);

    const validation = DynamicPricingService.validateClusterCompatibility(
      clusters[0],
      clusters[0].referenceLayout
    );
    assert.equal(validation.length, 2);
    assert.equal(validation[0].validation.valid, true);

    const pkg = DynamicPricingService.buildPricingDeploymentPackage(
      clusters[0].referenceLayout,
      clusters[0].zipFileName
    );
    assert.ok(pkg.safeFileName.startsWith('add_priceList_'));
    assert.ok(pkg.zipPackage.byteLength > 60);
  });
});
