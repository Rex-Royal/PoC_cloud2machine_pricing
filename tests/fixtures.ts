import {
  forEachConfigProductNode,
  parseMachineConfig,
  PRICE_PARAM_SPECS,
  SAMPLE_LAYOUT_3X5,
} from '#firmware-core';
import { AuthService, clearDebugLogs } from '#cloud-client';
import {
  PriceScheduleStatus,
  ScheduleRecurrence,
  type FleetMachine,
  type LayoutCluster,
  type MachineLayout,
  type ProductSlot,
  type RawConfigProductNode,
  type RawMachineConfigJson,
  type ScheduledPricingJob,
} from '#firmware-core';

export const DEFAULT_TB_BASE_URL = 'https://iot.rex-royal.ch';
export const DEFAULT_FTP_BASE_URL = 'https://iot.rex-royal.ch:8787';

/**
 * Restores `HttpClient` / `AuthService` shared global connection state between tests.
 */
export function resetCloudConnectionState(): void {
  AuthService.configure({
    tbBaseUrl: DEFAULT_TB_BASE_URL,
    ftpBaseUrl: DEFAULT_FTP_BASE_URL,
    jwtToken: null,
    refreshToken: null,
    useLocalCorsProxy: true,
  });
  clearDebugLogs();
}

export function makeUnsignedTestJwt(expSeconds: number): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ exp: expSeconds })).toString('base64url');
  return `${header}.${payload}.`;
}

export function makeRawConfig(
  overrides: Partial<RawMachineConfigJson> & {
    products?: RawConfigProductNode[];
    categoryName?: string;
  } = {}
): RawMachineConfigJson {
  const { products, categoryName, ...rest } = overrides;
  const defaultProducts: RawConfigProductNode[] = [
    {
      id: 1,
      name: 'Espresso',
      productType: '4',
      attributes: [
        { name: 'RecipeID', value: '1' },
        { name: 'M0801', value: '4' },
        { name: 'ProdName', value: 'Espresso' },
        { name: 'M1401', value: '350' },
        { name: 'M1406', value: '520' },
        { name: 'M1601', value: '11' },
      ],
    },
    {
      id: 2,
      name: 'Cappuccino',
      productType: '14',
      attributes: [
        { name: 'RecipeID', value: '2' },
        { name: 'M0801', value: '14' },
        { name: 'ProdName', value: 'Cappuccino' },
        { name: 'M1401', value: '450' },
        { name: 'M1406', value: '650' },
        { name: 'M1601', value: '12' },
      ],
    },
  ];

  return {
    rows: 3,
    columns: 5,
    categories: 1,
    selfService: '1',
    prodCatArray: [
      {
        id: 0,
        ...(categoryName ? { name: categoryName } : {}),
        products: products ?? defaultProducts,
      },
    ],
    ...rest,
  };
}

export function makeStubMachine(overrides: Partial<FleetMachine> = {}): FleetMachine {
  return {
    id: '11111111-2222-3333-4444-555555555555',
    deviceToken: 'tok',
    customerId: '00000000-0000-4000-8000-000000000001',
    serialNumber: 'SN-100101',
    name: 'Offline Machine Test',
    machineModel: 'S2',
    machineType: 'CT',
    modelTypeDisplay: 'S2 · CT',
    location: 'Zurich',
    currencySymbol: 'CHF',
    cmConnected: false,
    isConfiguredIdentity: true,
    rawConfigJson: null,
    rawProductLibraryJson: null,
    layout: null,
    configLoaded: false,
    ...overrides,
  };
}

export function makeCluster(
  machines: readonly FleetMachine[],
  overrides: Partial<LayoutCluster> = {}
): LayoutCluster {
  const referenceLayout: MachineLayout =
    overrides.referenceLayout ??
    machines[0]?.layout ??
    parseMachineConfig(SAMPLE_LAYOUT_3X5);

  return {
    layoutKey: `auto-${referenceLayout.layoutKey}`,
    signatureHash: referenceLayout.signatureHash,
    rows: referenceLayout.rows,
    columns: referenceLayout.columns,
    categories: referenceLayout.categories,
    zipFileName: `add_priceList_${referenceLayout.layoutKey}.zip`,
    referenceLayout,
    machines,
    ...overrides,
  };
}

export function makeScheduleJob(
  overrides: Partial<ScheduledPricingJob> = {}
): ScheduledPricingJob {
  const defaultLayout = overrides.targetLayout ?? parseMachineConfig(SAMPLE_LAYOUT_3X5);
  return {
    id: 'sched-1',
    name: 'Afternoon Happy Hour',
    customerId: 'cust-1',
    groupKey: 'group-1',
    groupLabel: 'Group 1',
    signatureHash: defaultLayout.signatureHash,
    zipFileName: 'add_priceList_sched_1.zip',
    machineIds: ['1'],
    targetLayout: defaultLayout,
    revertLayout: defaultLayout,
    ignoreRecipeMatch: false,
    recurrence: ScheduleRecurrence.Weekdays,
    startAtIso: '2026-11-11T14:00:00.000Z',
    endAtIso: null,
    startTimeHm: '14:00',
    endTimeHm: '17:00',
    status: PriceScheduleStatus.Scheduled,
    createdAtIso: '2026-11-11T09:00:00.000Z',
    lastTriggeredWindowKey: null,
    lastRevertedWindowKey: null,
    lastTriggeredAtIso: null,
    lastRevertedAtIso: null,
    lastResultSummary: null,
    ...overrides,
  };
}

export interface FakeCloudFetchState {
  ftpFiles: Map<string, string | Uint8Array>;
  machinesOnlineById: Record<string, boolean>;
  liveTwoWayAckById: Record<string, boolean>;
  rpcCalls: Array<{ deviceId: string; method: string; body: Record<string, unknown> }>;
  uploadedFiles: Array<{ uid: string; type: string; fileName: string; byteLength: number }>;
  deletedFiles: Array<{ uid: string; type: string; file: string }>;
  requests: Array<{ method: string; url: string }>;
}

/**
 * Creates a fake `globalThis.fetch` handler that routes ThingsBoard (`/api/...`)
 * and FtpProxy (`/api/v2/...`) requests against an in-memory file store & machine map.
 */
export function createCloudFetchRouter(options: {
  initialFtpFiles?: Record<string, string | Uint8Array>;
  machinesOnlineById?: Record<string, boolean>;
  liveTwoWayAckById?: Record<string, boolean>;
  customHandler?: (
    method: string,
    pathname: string,
    url: URL,
    init?: RequestInit
  ) => Promise<Response | null> | Response | null;
} = {}): {
  fetch: typeof globalThis.fetch;
  state: FakeCloudFetchState;
} {
  const state: FakeCloudFetchState = {
    ftpFiles: new Map(Object.entries(options.initialFtpFiles ?? {})),
    machinesOnlineById: { ...(options.machinesOnlineById ?? {}) },
    liveTwoWayAckById: { ...(options.liveTwoWayAckById ?? {}) },
    rpcCalls: [],
    uploadedFiles: [],
    deletedFiles: [],
    requests: [],
  };

  const jsonResponse = (data: unknown, status = 200): Response =>
    new Response(JSON.stringify(data), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });

  const fakeFetch: typeof globalThis.fetch = async (
    input: string | URL | Request,
    init?: RequestInit
  ): Promise<Response> => {
    const urlStr = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const url = new URL(urlStr);
    const method = (init?.method ?? 'GET').toUpperCase();
    const pathname = url.pathname;
    state.requests.push({ method, url: urlStr });

    if (options.customHandler) {
      const handled = await options.customHandler(method, pathname, url, init);
      if (handled) return handled;
    }

    // FtpProxy: GET /api/v2/download/{type}/{uid}/{fileName}
    if (method === 'GET' && pathname.startsWith('/api/v2/download/')) {
      const key = pathname.slice('/api/v2/download/'.length);
      const entry = state.ftpFiles.get(key);
      if (entry === undefined) {
        return new Response('Not Found', { status: 404 });
      }
      if (typeof entry === 'string') {
        return new Response(entry, { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(new Uint8Array(entry), {
        status: 200,
        headers: { 'Content-Type': 'application/octet-stream' },
      });
    }

    // FtpProxy: GET /api/v2/list/{uid}/{type}
    if (method === 'GET' && pathname.startsWith('/api/v2/list/')) {
      const rest = pathname.slice('/api/v2/list/'.length);
      const [uid, type] = rest.split('/');
      const prefix = `${type}/${uid}/`;
      const data = Array.from(state.ftpFiles.entries())
        .filter(([k]) => k.startsWith(prefix))
        .map(([k, val]) => ({
          filename: k.slice(prefix.length),
          size: String(typeof val === 'string' ? val.length : val.byteLength),
        }));
      return jsonResponse({ data });
    }

    // FtpProxy: POST /api/v2/upload
    if (method === 'POST' && pathname === '/api/v2/upload') {
      const form = init?.body as FormData;
      const meta = JSON.parse(String(form.get('json') ?? '{}')) as {
        uid: string;
        type: string;
      };
      const file = form.get('file') as File;
      const bytes = new Uint8Array(await file.arrayBuffer());
      const storedValue =
        file.name.endsWith('.zip') ? bytes : new TextDecoder().decode(bytes);
      state.ftpFiles.set(`${meta.type}/${meta.uid}/${file.name}`, storedValue);
      state.uploadedFiles.push({
        uid: meta.uid,
        type: meta.type,
        fileName: file.name,
        byteLength: bytes.byteLength,
      });
      return jsonResponse({ ok: true });
    }

    // FtpProxy: DELETE /api/v2/delete
    if (method === 'DELETE' && pathname === '/api/v2/delete') {
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        uid: string;
        type: string;
        file: string;
      };
      state.ftpFiles.delete(`${body.type}/${body.uid}/${body.file}`);
      state.deletedFiles.push(body);
      return jsonResponse({ ok: true });
    }

    // ThingsBoard: POST /api/entitiesQuery/find
    if (method === 'POST' && pathname === '/api/entitiesQuery/find') {
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        entityFilter?: { entityList?: string[] };
      };
      const ids = body.entityFilter?.entityList ?? Object.keys(state.machinesOnlineById);
      const data = ids.map((id) => ({
        entityId: { id, entityType: 'DEVICE' },
        latest: {
          TIME_SERIES: {
            cmConnected: { value: Boolean(state.machinesOnlineById[id]), ts: Date.now() },
          },
        },
      }));
      return jsonResponse({ data, totalPages: 1, totalElements: data.length });
    }

    // ThingsBoard: POST /api/rpc/twoway/{deviceId}
    if (method === 'POST' && pathname.startsWith('/api/rpc/twoway/')) {
      const deviceId = pathname.slice('/api/rpc/twoway/'.length);
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      state.rpcCalls.push({ deviceId, method: String(body.method ?? ''), body });
      if (!state.liveTwoWayAckById[deviceId]) {
        return new Response('Device offline', { status: 504 });
      }
      return jsonResponse({ ok: true });
    }

    // ThingsBoard: POST /api/rpc/oneway/{deviceId}
    if (method === 'POST' && pathname.startsWith('/api/rpc/oneway/')) {
      const deviceId = pathname.slice('/api/rpc/oneway/'.length);
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      state.rpcCalls.push({ deviceId, method: String(body.method ?? ''), body });
      return jsonResponse({});
    }

    return new Response(`Unhandled fake fetch: ${method} ${pathname}`, { status: 404 });
  };

  return { fetch: fakeFetch, state };
}

/**
 * Test-only helper simulating firmware updating `Config/{deviceId}/config.json`
 * after applying an `add_priceList_*.zip` partial backup.
 */
export function applyEditedPricesToRawConfigJson(
  rawConfigJson: RawMachineConfigJson,
  editedLayout: MachineLayout
): RawMachineConfigJson {
  if (!rawConfigJson || typeof rawConfigJson !== 'object' || !editedLayout) {
    return rawConfigJson;
  }
  const cloned = structuredClone(rawConfigJson);
  const editedById = new Map<number, ProductSlot>(
    (editedLayout.products || []).map((p) => [Number(p.id), p])
  );

  forEachConfigProductNode(cloned, ({ node, resolvedId }) => {
    const editedSlot = editedById.get(resolvedId);
    if (!editedSlot) return;
    const attrs = Array.isArray(node.attributes) ? node.attributes : [];
    for (const spec of PRICE_PARAM_SPECS) {
      const newVal = Number(editedSlot.params[spec.paramId] ?? 0);
      if (spec.paramId in node) node[spec.paramId] = newVal;
      const candidates = new Set<string>([spec.paramId, spec.enumName, ...spec.configNames]);
      let matchedAttr = false;
      for (const attr of attrs) {
        if (attr && ((attr.name && candidates.has(attr.name)) || (attr.id && candidates.has(attr.id)))) {
          attr.value = String(newVal);
          matchedAttr = true;
        }
      }
      if (!matchedAttr && attrs.length > 0 && spec.configNames[0]) {
        attrs.push({ name: spec.configNames[0], value: String(newVal) });
      }
    }
  });

  return cloned;
}
