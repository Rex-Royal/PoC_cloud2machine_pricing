import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import zlib from 'node:zlib';
import { AuthService, forwardUpstreamRequest, FtpService, getDebugLogs, HttpError, NULL_UUID, TbService } from '#cloud-client';
import {
  applyDynamicPricingRule,
  buildConfigFromBackupZipEntries,
  DYNAMIC_PRICING_PRESETS,
  EntityType,
  evaluateDueScheduleAction,
  FtpResourceType,
  isSyntheticSampleConfig,
  MachineConfigFile,
  parseMachineConfig,
  PriceListGroup,
  PriceScheduleStatus,
  PricingPresetId,
  PricingRuleMode,
  readZipArchiveAsync,
  SAMPLE_LAYOUT_3X5,
  SAMPLE_LAYOUT_4X6,
  ScheduleRecurrence,
} from '#firmware-core';
import { resolveMachineOnlineStatus } from '#fleet-sync';
import {
  makeRawConfig,
  makeScheduleJob,
  makeUnsignedTestJwt,
  resetCloudConnectionState,
} from './fixtures.ts';

afterEach(() => resetCloudConnectionState());

interface CustomZipEntryInput {
  name: string;
  content: string | Uint8Array;
  method: 0 | 8;
}

function buildCustomZipArchive(
  entriesInput: readonly CustomZipEntryInput[],
  options: {
    includeCentralDir?: boolean;
    useDataDescriptorInLocalHeader?: boolean;
  } = {}
): Uint8Array {
  const { includeCentralDir = true, useDataDescriptorInLocalHeader = false } = options;
  const encoder = new TextEncoder();

  const prepared = entriesInput.map((item) => {
    const nameBytes = encoder.encode(item.name);
    const rawBytes =
      item.content instanceof Uint8Array ? item.content : encoder.encode(item.content);
    const compBytes =
      item.method === 8 ? new Uint8Array(zlib.deflateRawSync(rawBytes)) : rawBytes;
    const crc = zlib.crc32(rawBytes) >>> 0;
    return {
      nameBytes,
      rawBytes,
      compBytes,
      crc,
      method: item.method,
    };
  });

  const localChunks: Uint8Array[] = [];
  const localOffsets: number[] = [];
  let offset = 0;

  for (const entry of prepared) {
    localOffsets.push(offset);
    const header = new Uint8Array(30 + entry.nameBytes.length);
    const view = new DataView(header.buffer);
    view.setUint32(0, 0x04034b50, true);
    view.setUint16(4, 20, true);
    view.setUint16(6, useDataDescriptorInLocalHeader ? 0x0808 : 0x0800, true);
    view.setUint16(8, entry.method, true);
    view.setUint16(10, 0x4000, true);
    view.setUint16(12, 0x56a9, true);
    view.setUint32(14, useDataDescriptorInLocalHeader ? 0 : entry.crc, true);
    view.setUint32(18, useDataDescriptorInLocalHeader ? 0 : entry.compBytes.length, true);
    view.setUint32(22, useDataDescriptorInLocalHeader ? 0 : entry.rawBytes.length, true);
    view.setUint16(26, entry.nameBytes.length, true);
    view.setUint16(28, 0, true);
    header.set(entry.nameBytes, 30);

    localChunks.push(header, entry.compBytes);
    offset += header.length + entry.compBytes.length;

    if (useDataDescriptorInLocalHeader) {
      const dd = new Uint8Array(16);
      const ddView = new DataView(dd.buffer);
      ddView.setUint32(0, 0x08074b50, true);
      ddView.setUint32(4, entry.crc, true);
      ddView.setUint32(8, entry.compBytes.length, true);
      ddView.setUint32(12, entry.rawBytes.length, true);
      localChunks.push(dd);
      offset += dd.length;
    }
  }

  const cdChunks: Uint8Array[] = [];
  let centralDirSize = 0;
  const centralDirOffset = offset;

  if (includeCentralDir) {
    for (let i = 0; i < prepared.length; i += 1) {
      const entry = prepared[i];
      const cd = new Uint8Array(46 + entry.nameBytes.length);
      const view = new DataView(cd.buffer);
      view.setUint32(0, 0x02014b50, true);
      view.setUint16(4, 20, true);
      view.setUint16(6, 20, true);
      view.setUint16(8, useDataDescriptorInLocalHeader ? 0x0808 : 0x0800, true);
      view.setUint16(10, entry.method, true);
      view.setUint16(12, 0x4000, true);
      view.setUint16(14, 0x56a9, true);
      view.setUint32(16, entry.crc, true);
      view.setUint32(20, entry.compBytes.length, true);
      view.setUint32(24, entry.rawBytes.length, true);
      view.setUint16(28, entry.nameBytes.length, true);
      view.setUint16(42, localOffsets[i], true);
      cd.set(entry.nameBytes, 46);
      cdChunks.push(cd);
      centralDirSize += cd.length;
    }

    const eocd = new Uint8Array(22);
    const eocdView = new DataView(eocd.buffer);
    eocdView.setUint32(0, 0x06054b50, true);
    eocdView.setUint16(8, prepared.length, true);
    eocdView.setUint16(10, prepared.length, true);
    eocdView.setUint32(12, centralDirSize, true);
    eocdView.setUint32(16, centralDirOffset, true);
    cdChunks.push(eocd);
  }

  const all = [...localChunks, ...cdChunks];
  const totalLen = all.reduce((sum, c) => sum + c.length, 0);
  const out = new Uint8Array(totalLen);
  let pos = 0;
  for (const chunk of all) {
    out.set(chunk, pos);
    pos += chunk.length;
  }
  return out;
}

describe('Core Codecs & Layout Backup Reconstruction', () => {
  it('readZipArchiveAsync extracts DEFLATE streaming ZIPs via Central Directory and falls back to Local File Headers when CD is absent', async () => {
    const priceListJson = JSON.stringify({ rows: 3, columns: 4, products: [{ id: 1, product: 4 }] });
    const recipeCsv = '1;4;Espresso;ico_esp.png\n990;0;Hot Drinks;\n';
    const productXml = '<ProductConfig><Schema>3 x 4</Schema></ProductConfig>';

    // 1. Streaming DEFLATE ZIP (local header compSize = 0 with Data Descriptor, Central Directory has real sizes)
    const streamingDeflateZip = buildCustomZipArchive(
      [
        { name: 'priceList.json', content: priceListJson, method: 8 },
        { name: 'Machine/RecipeConfig.csv', content: recipeCsv, method: 8 },
        { name: 'Config/ProductConfig.xml', content: productXml, method: 8 },
        { name: 'Assets/icon.png', content: new Uint8Array([0x89, 0x50, 0x4e, 0x47]), method: 8 },
      ],
      { includeCentralDir: true, useDataDescriptorInLocalHeader: true }
    );

    const extractedStreaming = await readZipArchiveAsync(streamingDeflateZip);
    assert.equal(extractedStreaming['priceList.json'], priceListJson);
    assert.equal(extractedStreaming['Machine/RecipeConfig.csv'], recipeCsv);
    assert.equal(extractedStreaming['Config/ProductConfig.xml'], productXml);
    assert.equal('Assets/icon.png' in extractedStreaming, false);

    // 2. Fallback path: no Central Directory / EOCD (findEocdOffset returns -1), walks Local File Headers directly
    const localOnlyZip = buildCustomZipArchive(
      [
        { name: 'priceList.json', content: priceListJson, method: 8 },
        { name: 'notes.txt', content: 'backup-ok', method: 0 },
      ],
      { includeCentralDir: false, useDataDescriptorInLocalHeader: false }
    );

    const extractedFallback = await readZipArchiveAsync(localOnlyZip);
    assert.equal(extractedFallback['priceList.json'], priceListJson);
    assert.equal(extractedFallback['notes.txt'], 'backup-ok');
  });

  it('buildConfigFromBackupZipEntries parses CSV + ProductConfig.xml and isSyntheticSampleConfig distinguishes real vs sample payloads', () => {
    const built = buildConfigFromBackupZipEntries({
      // Synthetic config.json in backup must be ignored in favor of priceList.json
      'Config/config.json': JSON.stringify(SAMPLE_LAYOUT_3X5),
      'priceList.json': JSON.stringify({
        rows: 3,
        columns: 5,
        categories: 2,
        ignoreRecipeMatch: 0,
        products: [
          { id: 1, product: 4, '47': 350, '50': 500, '65': 101 },
          { id: 2, product: 14, '47': 450, '65': 102 },
          { id: 3, product: 41, '47': 0 }, // EMPTY_PRESET_ID -> excluded
          { id: 4, product: 0, '47': 0 }, // unassigned -> excluded
          { id: 13, product: 2, '47': 380 }, // posInCat = 13 > 12 (3x4 XML schema) -> excluded
          { id: 25, product: 2, '47': 390, '65': 201 }, // catIdx = 1, posInCat = 1 -> kept
        ],
      }),
      'Machine/RecipeConfig.csv': [
        '1;4;Espresso<br/>Single;ico_esp.png',
        '2;14;Cappuccino;ico_cap.png',
        '25;2;Café Crème;ico_creme.png',
        '990;0;Hot Classics;',
        '991;0;Coffee;', // Generic 'Coffee' label is suppressed
      ].join('\n'),
      'Config/ProductConfig.xml': '<ProductConfig><Schema>3 x 4</Schema></ProductConfig>',
    });

    assert.ok(built);
    assert.equal(built.fromBackupZip, true);
    assert.equal(built.prodCatArray?.length, 2);

    const cat0 = built.prodCatArray![0];
    assert.equal(cat0.name, 'Hot Classics');
    assert.equal(cat0.products?.length, 2);
    assert.equal(cat0.products?.[0].name, 'Espresso Single');
    assert.equal(cat0.products?.[0]['47'], 350);
    assert.equal(
      cat0.products?.[0].attributes?.find((a) => a.name === 'FileName')?.value,
      'ico_esp.png'
    );

    const cat1 = built.prodCatArray![1];
    assert.equal(cat1.name, undefined);
    assert.equal(cat1.products?.length, 1);
    assert.equal(cat1.products?.[0].id, 25);
    assert.equal(cat1.products?.[0].name, 'Café Crème');

    // Direct non-synthetic config.json short-circuits priceList.json reconstruction
    const realConfig = makeRawConfig();
    const direct = buildConfigFromBackupZipEntries({
      'Config/config.json': JSON.stringify(realConfig),
      'priceList.json': '{}',
    });
    assert.deepEqual(direct, realConfig);

    // isSyntheticSampleConfig checks
    assert.equal(isSyntheticSampleConfig(SAMPLE_LAYOUT_3X5), true);
    assert.equal(isSyntheticSampleConfig(SAMPLE_LAYOUT_4X6), true);
    assert.equal(
      isSyntheticSampleConfig({
        rows: 4,
        columns: 6,
        categories: 1,
        prodCatArray: [{ id: 0, name: 'Gastro Selection', products: [{ id: 1, name: 'Espresso' }] }],
      }),
      true
    );
    assert.equal(isSyntheticSampleConfig(null), false);
    assert.equal(isSyntheticSampleConfig(built), false);
    assert.equal(isSyntheticSampleConfig(realConfig), false);
    assert.equal(
      isSyntheticSampleConfig({ ...SAMPLE_LAYOUT_3X5, extendedCupSize: [] }),
      false
    );
  });
});

describe('HttpClient Auth Refresh, *OrNull Error Semantics & Proxy Bridge', () => {
  it('auto-refreshes JWT via POST /api/auth/token on 401 and retries with the new token', async (t) => {
    const validExp = Math.floor((Date.now() + 3_600_000) / 1000);
    const oldJwt = makeUnsignedTestJwt(validExp);
    const freshJwt = makeUnsignedTestJwt(validExp + 3600);

    AuthService.configure({
      tbBaseUrl: 'https://iot.rex-royal.ch',
      ftpBaseUrl: 'https://iot.rex-royal.ch:8787',
      jwtToken: oldJwt,
      refreshToken: 'refresh-old',
      useLocalCorsProxy: false,
    });

    const notified: Array<{ jwtToken: string | null; refreshToken: string | null }> = [];
    const unsubscribe = AuthService.subscribeTokens((tokens) => notified.push(tokens));

    const calls: Array<{ url: string; authHeader: string | null }> = [];
    let ftpAttempt = 0;

    t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const headers = new Headers(init?.headers);

      if (url === 'https://iot.rex-royal.ch/api/auth/token') {
        calls.push({ url, authHeader: headers.get('X-Authorization') });
        assert.deepEqual(JSON.parse(String(init?.body)), { refreshToken: 'refresh-old' });
        return new Response(
          JSON.stringify({ token: freshJwt, refreshToken: 'refresh-new' }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }

      if (url === 'https://iot.rex-royal.ch:8787/api/v2/download/Config/dev-1/config.json') {
        calls.push({ url, authHeader: headers.get('Authorization') });
        ftpAttempt += 1;
        if (ftpAttempt === 1) {
          return new Response('Unauthorized', { status: 401 });
        }
        return new Response(JSON.stringify({ rows: 3, columns: 5 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (url === 'https://iot.rex-royal.ch/api/auth/login') {
        return new Response(
          JSON.stringify({ token: freshJwt, refreshToken: 'refresh-login' }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }

      return new Response('Not Found', { status: 404 });
    });

    try {
      const res = await FtpService.downloadJson<{ rows: number; columns: number }>(
        FtpResourceType.Config,
        'dev-1',
        MachineConfigFile.ConfigJson
      );
      assert.deepEqual(res, { rows: 3, columns: 5 });
      assert.equal(calls.length, 3);
      assert.equal(calls[0].authHeader, `Bearer ${oldJwt}`);
      assert.equal(calls[1].url, 'https://iot.rex-royal.ch/api/auth/token');
      assert.equal(calls[2].authHeader, `Bearer ${freshJwt}`);
      assert.equal(notified.length, 1);
      assert.equal(notified[0].jwtToken, freshJwt);
      assert.equal(notified[0].refreshToken, 'refresh-new');

      await AuthService.login('user@example.com', 'super-secret-pw');
      const serializedLogs = JSON.stringify(getDebugLogs());
      assert.equal(serializedLogs.includes('super-secret-pw'), false, 'Debug log must never capture plaintext password');
      assert.equal(serializedLogs.includes(freshJwt), false, 'Debug log must never capture issued JWT');
      assert.equal(serializedLogs.includes('refresh-login'), false, 'Debug log must never capture refresh token');
    } finally {
      unsubscribe();
    }
  });

  it('FtpService *OrNull methods return null on 404 but propagate HttpError on 401 and 500', async (t) => {
    AuthService.configure({
      tbBaseUrl: 'https://iot.rex-royal.ch',
      ftpBaseUrl: 'https://iot.rex-royal.ch:8787',
      jwtToken: 'jwt-no-refresh',
      refreshToken: null,
      useLocalCorsProxy: false,
    });

    let nextStatus = 404;
    t.mock.method(globalThis, 'fetch', async () => {
      return new Response('error', { status: nextStatus });
    });

    nextStatus = 404;
    assert.equal(
      await FtpService.downloadTextOrNull(FtpResourceType.Config, 'dev-1', MachineConfigFile.CmdStackJson),
      null
    );
    assert.equal(
      await FtpService.downloadBytesOrNull(FtpResourceType.Backup, 'cust-1', 'missing.zip'),
      null
    );

    nextStatus = 401;
    await assert.rejects(
      () => FtpService.downloadTextOrNull(FtpResourceType.Config, 'dev-1', MachineConfigFile.ConfigHashJson),
      (err: unknown) => err instanceof HttpError && err.status === 401
    );
    await assert.rejects(
      () => FtpService.downloadBytesOrNull(FtpResourceType.Backup, 'cust-1', 'b.zip'),
      (err: unknown) => err instanceof HttpError && err.status === 401
    );

    nextStatus = 500;
    await assert.rejects(
      () => FtpService.downloadTextOrNull(FtpResourceType.Config, 'dev-1', MachineConfigFile.ConfigHashJson),
      (err: unknown) => err instanceof HttpError && err.status === 500
    );
    await assert.rejects(
      () => FtpService.downloadBytesOrNull(FtpResourceType.Backup, 'cust-1', 'b.zip'),
      (err: unknown) => err instanceof HttpError && err.status === 500
    );
  });

  it('forwardUpstreamRequest forwards whitelisted headers, body, and query string and maps upstream network errors to 502', async (t) => {
    let capturedUrl = '';
    let capturedInit: RequestInit | undefined;

    t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
      capturedUrl = String(input);
      capturedInit = init;
      return new Response(JSON.stringify({ ok: true, id: 'dev-99' }), {
        status: 201,
        headers: {
          'Content-Type': 'application/json',
          'X-Upstream-Internal': 'should-not-leak',
        },
      });
    });

    const postReq = new Request('http://localhost:4173/api-bridge/tb/api/device/dev-99?active=true', {
      method: 'POST',
      headers: {
        'x-target-origin': 'https://iot.rex-royal.ch/edge',
        'x-authorization': 'Bearer tb-tok',
        authorization: 'Bearer ftp-tok',
        'content-type': 'application/json',
        accept: 'application/json',
        cookie: 'session=secret',
      },
      body: JSON.stringify({ cmd: 'ping' }),
    });

    const postRes = await forwardUpstreamRequest(postReq, ['api', 'device', 'dev-99']);
    assert.equal(capturedUrl, 'https://iot.rex-royal.ch/edge/api/device/dev-99?active=true');
    assert.equal(capturedInit?.method, 'POST');
    const forwardedHeaders = new Headers(capturedInit?.headers);
    assert.equal(forwardedHeaders.get('x-authorization'), 'Bearer tb-tok');
    assert.equal(forwardedHeaders.get('authorization'), 'Bearer ftp-tok');
    assert.equal(forwardedHeaders.get('content-type'), 'application/json');
    assert.equal(forwardedHeaders.get('accept'), 'application/json');
    assert.equal(forwardedHeaders.get('cookie'), null);
    assert.equal(forwardedHeaders.get('x-target-origin'), null);
    assert.equal(
      new TextDecoder().decode(capturedInit?.body as ArrayBuffer),
      JSON.stringify({ cmd: 'ping' })
    );
    assert.equal(postRes.status, 201);
    assert.equal(postRes.headers.get('x-upstream-internal'), null);
    assert.deepEqual(await postRes.json(), { ok: true, id: 'dev-99' });

    // GET request omits body
    const getReq = new Request('http://localhost:4173/api-bridge/tb/api/auth/user', {
      method: 'GET',
      headers: { 'x-target-base-url': 'https://iot.rex-royal.ch' },
    });
    await forwardUpstreamRequest(getReq, ['api', 'auth', 'user']);
    assert.equal(capturedUrl, 'https://iot.rex-royal.ch/api/auth/user');
    assert.equal(capturedInit?.body, undefined);

    // 502 error handling when upstream fetch rejects
    t.mock.method(globalThis, 'fetch', async () => {
      throw new Error('ECONNREFUSED');
    });
    const failRes = await forwardUpstreamRequest(getReq, ['api', 'auth', 'user']);
    assert.equal(failRes.status, 502);
    const failBody = (await failRes.json()) as {
      error: string;
      targetUrl: string;
      details: string;
    };
    assert.equal(failBody.error, 'Upstream connection failed');
    assert.equal(failBody.targetUrl, 'https://iot.rex-royal.ch/api/auth/user');
    assert.equal(failBody.details, 'ECONNREFUSED');
  });
});

describe('Machine Online Precedence, Customer Hierarchy & Remaining Scheduler/Pricing Modes', () => {
  it('resolveMachineOnlineStatus resolves timestamp precedence between cmConnected, lastConnectTime, and lastDisconnectTime', () => {
    // Stale TIME_SERIES cmConnected=false (ts=1000) superseded by newer lastConnectTime (2000)
    assert.equal(
      resolveMachineOnlineStatus({
        TIME_SERIES: { cmConnected: { value: false, ts: 1000 } },
        SERVER_ATTRIBUTE: {
          lastConnectTime: { value: 2000 },
          lastDisconnectTime: { value: 1500 },
        },
      }),
      true
    );

    // Newer TIME_SERIES cmConnected=false (ts=3000) after lastConnectTime (2000)
    assert.equal(
      resolveMachineOnlineStatus({
        TIME_SERIES: { cmConnected: { value: false, ts: 3000 } },
        SERVER_ATTRIBUTE: { lastConnectTime: { value: 2000 } },
      }),
      false
    );

    // Stale cmConnected=true (ts=1000) overridden by newer lastDisconnectTime (2500 > 1000)
    assert.equal(
      resolveMachineOnlineStatus({
        TIME_SERIES: { cmConnected: { value: true, ts: 1000 } },
        SERVER_ATTRIBUTE: {
          lastConnectTime: { value: 1000 },
          lastDisconnectTime: { value: 2500 },
        },
      }),
      false
    );

    // Attribute fallback when TIME_SERIES is missing
    assert.equal(
      resolveMachineOnlineStatus({
        ATTRIBUTE: { ss_cmConnected: { value: '1', ts: 3000 } },
        SERVER_ATTRIBUTE: { lastDisconnectTime: { value: 2000 } },
      }),
      true
    );

    // Pure lastConnectTime > lastDisconnectTime fallback
    assert.equal(
      resolveMachineOnlineStatus({
        SERVER_ATTRIBUTE: {
          lastConnectTime: { value: 5000 },
          lastDisconnectTime: { value: 4000 },
        },
      }),
      true
    );
  });

  it('AuthService.getAvailableCustomers builds TENANT_ADMIN breadcrumb paths and handles CUSTOMER_USER + fallback', async (t) => {
    AuthService.configure({
      tbBaseUrl: 'https://iot.rex-royal.ch',
      jwtToken: 'jwt-cust',
      useLocalCorsProxy: false,
    });

    const parentId = 'aaaaaaaa-1111-2222-3333-444444444444';
    const childId = 'bbbbbbbb-1111-2222-3333-444444444444';

    // 1. TENANT_ADMIN hierarchy with Parent › Child, UUID suffix cleaning, @AutoCreated cleanup, and NULL_UUID exclusion
    t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/api/customers?')) {
        return new Response(
          JSON.stringify({
            data: [
              { id: { id: NULL_UUID }, title: 'System Null' },
              {
                id: { id: parentId },
                title: `Rex-Royal AG ${parentId}`,
              },
              {
                id: { id: childId },
                title: `Simulators@AutoCreatedHierachyGroupForSubCustomers ${parentId}`,
                parentCustomerId: { id: parentId },
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (url.endsWith('/api/rr/customer/owners/available')) {
        return new Response(
          JSON.stringify([
            { id: { id: childId, entityType: EntityType.Customer }, name: 'Branch B' },
            { id: { id: childId, entityType: EntityType.Customer }, name: 'Branch B Duplicate' },
            { id: { id: 'dev-ignored', entityType: EntityType.Device }, name: 'Not a customer' },
            { id: { id: parentId, entityType: EntityType.Customer }, name: `Branch A ${parentId}` },
          ]),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return new Response('Not Found', { status: 404 });
    });

    const tenantCustomers = await AuthService.getAvailableCustomers({
      authority: 'TENANT_ADMIN',
    });
    assert.equal(tenantCustomers.length, 2);
    assert.equal(tenantCustomers[0].name, 'Rex-Royal AG');
    assert.equal(tenantCustomers[1].name, 'Rex-Royal AG › Simulators (Auto)');
    assert.equal(tenantCustomers[1].parentCustomerId, parentId);

    // 2. CUSTOMER_USER uses /api/rr/customer/owners/available and deduplicates/sorts
    const userCustomers = await AuthService.getAvailableCustomers({
      authority: 'CUSTOMER_USER',
      customerId: { id: childId },
    });
    assert.deepEqual(
      userCustomers.map((c) => ({ id: c.id, name: c.name })),
      [
        { id: parentId, name: 'Branch A' },
        { id: childId, name: 'Branch B' },
      ]
    );

    // 3. Fallback to user's own customerId when endpoints fail
    t.mock.method(globalThis, 'fetch', async () => new Response('Server Error', { status: 500 }));
    const fallbackCustomers = await AuthService.getAvailableCustomers({
      authority: 'CUSTOMER_USER',
      customerId: { id: childId },
      customerTitle: 'Own Cafe Zurich',
    });
    assert.deepEqual(fallbackCustomers, [
      {
        id: childId,
        entityType: EntityType.Customer,
        name: 'Own Cafe Zurich',
        rawName: 'Own Cafe Zurich',
        parentCustomerId: null,
      },
    ]);
  });

  it('evaluateDueScheduleAction handles ScheduleRecurrence.Once, Weekends, and Paused/Completed states', () => {
    const onceJob = makeScheduleJob({
      id: 'once-1',
      recurrence: ScheduleRecurrence.Once,
      startAtIso: '2026-11-14T10:00:00.000Z',
      endAtIso: '2026-11-14T12:00:00.000Z',
    });

    assert.equal(
      evaluateDueScheduleAction(onceJob, new Date('2026-11-14T09:59:00.000Z')),
      null
    );
    assert.deepEqual(
      evaluateDueScheduleAction(onceJob, new Date('2026-11-14T10:05:00.000Z')),
      { type: 'apply', windowKey: 'once:once-1' }
    );

    const triggeredOnce = { ...onceJob, lastTriggeredWindowKey: 'once:once-1' };
    assert.equal(
      evaluateDueScheduleAction(triggeredOnce, new Date('2026-11-14T11:00:00.000Z')),
      null
    );
    assert.deepEqual(
      evaluateDueScheduleAction(triggeredOnce, new Date('2026-11-14T12:00:00.000Z')),
      { type: 'revert', windowKey: 'once:once-1' }
    );
    assert.equal(
      evaluateDueScheduleAction(
        { ...triggeredOnce, lastRevertedWindowKey: 'once:once-1' },
        new Date('2026-11-14T12:30:00.000Z')
      ),
      null
    );

    // Weekends recurrence: skips Wednesday, applies Saturday inside window, reverts after endTimeHm
    const weekendJob = makeScheduleJob({
      id: 'wknd-1',
      recurrence: ScheduleRecurrence.Weekends,
      startTimeHm: '09:00',
      endTimeHm: '18:00',
    });
    // Wednesday 2026-11-11 10:00 local -> null
    assert.equal(evaluateDueScheduleAction(weekendJob, new Date(2026, 10, 11, 10, 0)), null);
    // Saturday 2026-11-14 10:00 local -> apply
    assert.deepEqual(evaluateDueScheduleAction(weekendJob, new Date(2026, 10, 14, 10, 0)), {
      type: 'apply',
      windowKey: '2026-11-14:09:00',
    });
    // Saturday 2026-11-14 18:05 local while ActiveWindow -> revert
    assert.deepEqual(
      evaluateDueScheduleAction(
        {
          ...weekendJob,
          status: PriceScheduleStatus.ActiveWindow,
          lastTriggeredWindowKey: '2026-11-14:09:00',
        },
        new Date(2026, 10, 14, 18, 5)
      ),
      { type: 'revert', windowKey: '2026-11-14:09:00' }
    );

    // Paused and Completed schedules never fire
    assert.equal(
      evaluateDueScheduleAction(
        { ...weekendJob, status: PriceScheduleStatus.Paused },
        new Date(2026, 10, 14, 10, 0)
      ),
      null
    );
    assert.equal(
      evaluateDueScheduleAction(
        { ...weekendJob, status: PriceScheduleStatus.Completed },
        new Date(2026, 10, 14, 10, 0)
      ),
      null
    );
  });

  it('applyDynamicPricingRule handles TierPriceList2And3 and FreeVend modes while preserving PLU codes', () => {
    const baseLayout = parseMachineConfig(makeRawConfig());

    // 1. TierPriceList2And3 (EmployeeSubsidizedTiers: PL2 = 75%, PL3 = 50%, 5-Rappen rounding)
    const tierRule = DYNAMIC_PRICING_PRESETS.find(
      (p) => p.id === PricingPresetId.EmployeeSubsidizedTiers
    )!;
    const tieredLayout = applyDynamicPricingRule(baseLayout, tierRule);
    const espressoTiered = tieredLayout.products.find((p) => p.id === 1)!;
    assert.equal(espressoTiered.params['47'], 350, 'PL1 Gr1 Single must stay unchanged');
    assert.equal(espressoTiered.params['50'], 520, 'PL1 Gr1 Double must stay unchanged');
    assert.equal(espressoTiered.params['53'], 265, 'PL2 Gr1 Single: 350 * 0.75 = 262.5 -> 265');
    assert.equal(espressoTiered.params['56'], 390, 'PL2 Gr1 Double: 520 * 0.75 = 390');
    assert.equal(espressoTiered.params['59'], 175, 'PL3 Gr1 Single: 350 * 0.50 = 175');
    assert.equal(espressoTiered.params['62'], 260, 'PL3 Gr1 Double: 520 * 0.50 = 260');
    assert.equal(espressoTiered.params['65'], 11, 'PLU code must be preserved');

    // 2. FreeVend across all price lists zeroes all prices but keeps PLU codes intact
    const freeVendRule = DYNAMIC_PRICING_PRESETS.find(
      (p) => p.id === PricingPresetId.FreeVendEvent
    )!;
    const freeVendLayout = applyDynamicPricingRule(baseLayout, freeVendRule);
    const espressoFree = freeVendLayout.products.find((p) => p.id === 1)!;
    assert.equal(espressoFree.params['47'], 0);
    assert.equal(espressoFree.params['50'], 0);
    assert.equal(espressoFree.params['53'], 0);
    assert.equal(espressoFree.params['59'], 0);
    assert.equal(espressoFree.params['65'], 11, 'PLU code must stay intact during FreeVend');

    // 3. FreeVend targeted only to PL2 zeroes PL2 while keeping PL1 intact
    const pl2FreeLayout = applyDynamicPricingRule(tieredLayout, {
      mode: PricingRuleMode.FreeVend,
      targetPriceLists: [PriceListGroup.PL2],
    });
    const espressoPl2Free = pl2FreeLayout.products.find((p) => p.id === 1)!;
    assert.equal(espressoPl2Free.params['47'], 350);
    assert.equal(espressoPl2Free.params['53'], 0);
    assert.equal(espressoPl2Free.params['59'], 175);
  });
});
