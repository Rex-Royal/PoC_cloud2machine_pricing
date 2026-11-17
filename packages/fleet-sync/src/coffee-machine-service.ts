/**
 * Fleet discovery, FtpProxy V2 Config/Backup I/O, and MQTT RPC / cmdStack.json transport.
 */

import { cleanCustomerTitle, FtpService, NULL_UUID, TbService } from '#cloud-client';
import {
  appendCommandToCmdStack,
  buildApplyPricingRpcCommand,
  buildConfigFromBackupZipEntries,
  EntityType,
  FtpResourceType,
  isSyntheticSampleConfig,
  MachineConfigFile,
  MimeType,
  readZipArchiveAsync,
  removeBackupFileFromCmdStack,
  type ApplyBackupRpcCommand,
  type DeviceGroup,
  type FleetMachine,
  type PartialBackupZipPackage,
  type RawMachineConfigJson,
  type RawProductLibraryJson,
} from '#firmware-core';

export const ALL_CUSTOMERS_ID = 'ALL_CUSTOMERS';

export const ENTITY_QUERY_FIELDS = [
  { type: 'ENTITY_FIELD', key: 'name' },
  { type: 'ENTITY_FIELD', key: 'label' },
  { type: 'ENTITY_FIELD', key: 'type' },
] as const;

export const ENTITY_QUERY_LATEST_VALUES = [
  { type: 'TIME_SERIES', key: 'cmConnected' },
  { type: 'SERVER_ATTRIBUTE', key: 'active' },
  { type: 'SERVER_ATTRIBUTE', key: 'lastConnectTime' },
  { type: 'SERVER_ATTRIBUTE', key: 'lastDisconnectTime' },
  { type: 'ATTRIBUTE', key: 'cmConnected' },
  { type: 'ATTRIBUTE', key: 'serialNumber' },
  { type: 'ATTRIBUTE', key: 'name' },
  { type: 'ATTRIBUTE', key: 'machineModel' },
  { type: 'ATTRIBUTE', key: 'machineType' },
  { type: 'ATTRIBUTE', key: 'location' },
  { type: 'ATTRIBUTE', key: 'currencySymbol' },
] as const;

const isRealCustomerId = (id?: string): id is string =>
  Boolean(id && id !== ALL_CUSTOMERS_ID && id !== 'ALL' && id !== NULL_UUID);

export function isInternalHexToken(value: unknown): boolean {
  const str = String(value || '').trim();
  return /^[0-9a-f]{32}$/i.test(str) || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str);
}

export function isMachineOnline(cmConnectedVal: unknown): boolean {
  if (cmConnectedVal === null || cmConnectedVal === undefined || cmConnectedVal === '') return false;
  if (typeof cmConnectedVal === 'boolean') return cmConnectedVal;
  if (typeof cmConnectedVal === 'number') return cmConnectedVal > 0;
  const s = String(cmConnectedVal).toLowerCase().trim();
  if (s === '1' || s === 'true' || s === '1.0') return true;
  const num = Number(s);
  return !Number.isNaN(num) && num > 0;
}

export function resolveMachineOnlineStatus(latest: Record<string, any> = {}): boolean {
  const { TIME_SERIES: ts = {}, SERVER_ATTRIBUTE: sa = {}, CLIENT_ATTRIBUTE: ca = {}, ATTRIBUTE: ga = {} } = latest;
  const pick = (...entries: any[]) => entries.find((e) => e && e.value !== undefined && e.value !== null && String(e.value) !== '');

  const lastConnectMs = Number(pick(sa.lastConnectTime, ga.lastConnectTime)?.value || 0);
  const lastDisconnectMs = Number(pick(sa.lastDisconnectTime, ga.lastDisconnectTime)?.value || 0);
  const disconnectedLater = (tsMs: number) => lastDisconnectMs > lastConnectMs && lastDisconnectMs > tsMs;

  const evalEntry = (entry: any): boolean | null => {
    if (entry === undefined) return null;
    const online = isMachineOnline(entry.value);
    const tsMs = Number(entry.ts || 0);
    if (!online && tsMs >= lastConnectMs) return false;
    if (online && !disconnectedLater(tsMs)) return true;
    return null;
  };

  const fromTs = evalEntry(pick(ts.cmConnected));
  if (fromTs !== null) return fromTs;

  const fromAttr = evalEntry(pick(sa.cmConnected, ga.cmConnected, ca.cmConnected, ga.ss_cmConnected, ga.cs_cmConnected, ga.connectionStatus));
  if (fromAttr !== null) return fromAttr;

  const activeEntry = pick(sa.active, ga.active);
  const activeStr = String(activeEntry?.value ?? '').toLowerCase().trim();
  if ((activeStr === 'true' || activeStr === '1') && !disconnectedLater(Number(activeEntry?.ts || 0))) {
    return true;
  }
  return lastConnectMs > 0 && lastConnectMs > lastDisconnectMs;
}

export async function queryDeviceEntities(params: {
  entityFilter: Record<string, unknown>;
  pageSize: number;
  textSearch?: string;
  sortOrder?: Record<string, unknown>;
  maxPages?: number;
}): Promise<Record<string, any>[]> {
  const { entityFilter, pageSize, textSearch, sortOrder, maxPages = 20 } = params;
  const bodyFor = (page: number) => ({
    entityFilter,
    pageLink: { pageSize, page, ...(textSearch ? { textSearch } : {}), ...(sortOrder ? { sortOrder } : {}) },
    entityFields: ENTITY_QUERY_FIELDS,
    latestValues: ENTITY_QUERY_LATEST_VALUES,
  });

  const first = await TbService.post<{ data?: Record<string, any>[]; totalPages?: number }>('/entitiesQuery/find', bodyFor(0));
  const rows: Record<string, any>[] = Array.isArray(first?.data) ? [...first.data] : [];
  const totalPages = Math.min(Number(first?.totalPages || 1), maxPages);
  if (totalPages <= 1) return rows;

  const extra = await Promise.all(
    Array.from({ length: totalPages - 1 }, (_, i) =>
      TbService.post<{ data?: Record<string, any>[] }>('/entitiesQuery/find', bodyFor(i + 1)).catch(() => ({ data: [] }))
    )
  );
  for (const page of extra) if (Array.isArray(page?.data)) rows.push(...page.data);
  return rows;
}

export function mapEntityRowToFleetMachine(row: Record<string, any>, customerId: string): FleetMachine | null {
  const deviceId = row?.entityId?.id as string | undefined;
  if (!deviceId) return null;

  const latest = row.latest || {};
  const ef = latest.ENTITY_FIELD || {};
  const pickAttr = (...keys: string[]): string => {
    for (const key of keys) {
      for (const bucket of [latest.ATTRIBUTE, latest.CLIENT_ATTRIBUTE, latest.SERVER_ATTRIBUTE, latest.TIME_SERIES]) {
        const val = String(bucket?.[key]?.value ?? '').trim();
        if (val && val !== 'undefined' && val !== 'null') return val;
      }
    }
    return '';
  };

  const rawSerial = pickAttr('serialNumber', 'ss_serialNumber', 'cs_serialNumber');
  const serialNumber = rawSerial && rawSerial !== '0' && !isInternalHexToken(rawSerial) ? rawSerial : '';
  const rawLabel = cleanCustomerTitle(String(ef.label?.value ?? '').trim());
  const rawEfName = String(ef.name?.value ?? '').trim();
  const machineName =
    pickAttr('name', 'ss_name', 'cs_name') ||
    (!isInternalHexToken(rawLabel) ? rawLabel : '') ||
    (!isInternalHexToken(rawEfName) ? rawEfName : '');

  const rawEfType = String(ef.type?.value ?? '').trim();
  const machineModel = pickAttr('machineModel', 'ss_machineModel', 'cs_machineModel') || (rawEfType && rawEfType !== 'default' ? rawEfType : '');
  const machineType = pickAttr('machineType', 'ss_machineType', 'cs_machineType');
  const location = pickAttr('location') || [pickAttr('address'), pickAttr('city'), pickAttr('country')].filter(Boolean).join(', ');
  const customerName = cleanCustomerTitle(
    String(ef.customerTitle?.value || (ef.ownerType?.value === 'CUSTOMER' ? ef.ownerName?.value : '') || ef.ownerName?.value || '').trim()
  );
  const lastConnectMs = Number(latest?.SERVER_ATTRIBUTE?.lastConnectTime?.value || latest?.ATTRIBUTE?.lastConnectTime?.value || 0) || undefined;

  return {
    id: deviceId,
    deviceToken: rawEfName,
    customerId,
    customerName: customerName || undefined,
    serialNumber,
    name: machineName,
    machineModel,
    machineType,
    modelTypeDisplay: [machineModel, machineType].filter(Boolean).join(' · ') || '—',
    location,
    currencySymbol: pickAttr('currencySymbol') || 'CHF',
    cmConnected: resolveMachineOnlineStatus(latest),
    lastConnectMs,
    isConfiguredIdentity: Boolean(serialNumber || machineName),
    rawConfigJson: null,
    rawProductLibraryJson: null,
    layout: null,
    configLoaded: false,
  };
}

export const normalizeRealMachineConfig = (
  config: RawMachineConfigJson | null | undefined
): RawMachineConfigJson | null => (!config || isSyntheticSampleConfig(config) ? null : config);

function isMatchingCustomerBackupZip(
  filename: string,
  machine: Pick<FleetMachine, 'id' | 'serialNumber'>,
  excludeFilenames?: ReadonlySet<string>
): boolean {
  if (excludeFilenames?.has(filename)) return false;
  const lower = filename.toLowerCase();
  if (!lower.endsWith('.zip') || lower.startsWith('add_pricelist')) return false;
  const serial = String(machine.serialNumber || '').trim().toLowerCase();
  const id = String(machine.id || '').trim().toLowerCase();
  return (Boolean(serial) && lower.includes(serial)) || (Boolean(id) && lower.includes(id));
}

function parseFtpTimestampMs(entry: { filename?: string; created?: string }): number {
  if (entry.created) {
    const iso = entry.created.endsWith('Z') || /[+-]\d{2}:\d{2}$/.test(entry.created) ? entry.created : `${entry.created}Z`;
    const parsed = Date.parse(iso);
    if (Number.isFinite(parsed)) return parsed;
  }
  const m = /(\d{4})-(\d{2})-(\d{2})[_T](\d{2})-(\d{2})-(\d{2})/.exec(String(entry.filename || ''));
  if (!m) return 0;
  const ms = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

export class CoffeeMachineService {
  static async getCustomerDeviceGroups(customerId: string): Promise<DeviceGroup[]> {
    if (!isRealCustomerId(customerId)) return [];
    try {
      const data = await TbService.get<DeviceGroup[]>(`/entityGroups/${EntityType.Customer}/${customerId}/${EntityType.Device}`);
      return Array.isArray(data) ? data : [];
    } catch {
      return [];
    }
  }

  static async listCustomerMachines(customerId: string, entityGroupId: string | null = null, textSearch = ''): Promise<FleetMachine[]> {
    const isAll = !customerId || customerId === ALL_CUSTOMERS_ID || customerId === 'ALL';
    const entityFilter =
      !isAll && entityGroupId && entityGroupId !== 'ALL'
        ? { type: 'entityGroup', resolveMultiple: true, groupType: EntityType.Device, entityGroup: entityGroupId }
        : isAll
          ? { type: 'entityType', resolveMultiple: true, entityType: EntityType.Device }
          : { type: 'entitiesByGroupName', resolveMultiple: true, groupStateEntity: false, ownerId: { id: String(customerId), entityType: EntityType.Customer }, groupType: EntityType.Device, entityGroupNameFilter: 'All' };

    const rows = await queryDeviceEntities({
      entityFilter,
      pageSize: 1000,
      textSearch: textSearch.trim() || undefined,
      sortOrder: { key: { type: 'ATTRIBUTE', key: 'serialNumber' }, direction: 'ASC' },
    });

    const seen = new Set<string>();
    const list: FleetMachine[] = [];
    for (const row of rows) {
      const m = mapEntityRowToFleetMachine(row, customerId);
      if (m && !seen.has(m.id)) {
        seen.add(m.id);
        list.push(m);
      }
    }
    return list.sort((a, b) => {
      if (a.isConfiguredIdentity !== b.isConfiguredIdentity) return a.isConfiguredIdentity ? -1 : 1;
      if (a.cmConnected !== b.cmConnected) return a.cmConnected ? -1 : 1;
      return (a.serialNumber || a.name || a.id).localeCompare(b.serialNumber || b.name || b.id, undefined, { numeric: true, sensitivity: 'base' });
    });
  }

  static async getMachinesByIds(deviceIds: string[]): Promise<FleetMachine[]> {
    const cleanIds = Array.from(new Set(deviceIds.filter(Boolean)));
    if (cleanIds.length === 0) return [];
    try {
      const rows = await queryDeviceEntities({
        entityFilter: { type: 'entityList', resolveMultiple: true, entityType: EntityType.Device, entityList: cleanIds },
        pageSize: cleanIds.length,
        maxPages: 1,
      });
      return rows.map((r) => mapEntityRowToFleetMachine(r, ALL_CUSTOMERS_ID)).filter((m): m is FleetMachine => Boolean(m));
    } catch {
      return [];
    }
  }

  static async resolveMachineCustomerId(deviceId: string, fallbackCustomerId?: string): Promise<string> {
    if (isRealCustomerId(fallbackCustomerId) && fallbackCustomerId !== 'ALL') return fallbackCustomerId;
    try {
      const dev = await TbService.get<{ ownerId?: { id?: string }; customerId?: { id?: string } }>(`/device/${deviceId}`);
      if (isRealCustomerId(dev?.ownerId?.id)) return dev.ownerId!.id!;
      if (isRealCustomerId(dev?.customerId?.id)) return dev.customerId!.id!;
    } catch {
      // Ignore lookup failure
    }
    return fallbackCustomerId || '';
  }

  static downloadConfigJson = (deviceId: string): Promise<RawMachineConfigJson> =>
    FtpService.downloadJson<RawMachineConfigJson>(FtpResourceType.Config, deviceId, MachineConfigFile.ConfigJson);

  static async downloadConfigHash(deviceId: string): Promise<string | null> {
    const raw = await FtpService.downloadTextOrNull(FtpResourceType.Config, deviceId, MachineConfigFile.ConfigHashJson);
    if (!raw?.trim()) return null;
    try {
      const parsed = JSON.parse(raw) as { hash?: string; sha256?: string; md5?: string };
      const c = parsed?.hash || parsed?.sha256 || parsed?.md5;
      if (typeof c === 'string' && c.trim()) return c.trim();
    } catch {
      // Plain text hash
    }
    return raw.trim();
  }

  static deleteConfigFile = (deviceId: string, fileName: MachineConfigFile | string): Promise<boolean> =>
    FtpService.deleteFile(FtpResourceType.Config, deviceId, fileName);

  private static async extractRealConfigFromBackupZip(customerId: string, filename: string): Promise<RawMachineConfigJson | null> {
    const zipBytes = await FtpService.downloadBytesOrNull(FtpResourceType.Backup, customerId, filename);
    if (!zipBytes) return null;
    return normalizeRealMachineConfig(buildConfigFromBackupZipEntries(await readZipArchiveAsync(zipBytes)));
  }

  static async findLatestCustomerBackup(
    machine: FleetMachine,
    options: { excludeFilenames?: ReadonlySet<string>; resolvedCustomerId?: string } = {}
  ): Promise<{ configJson: RawMachineConfigJson; filename: string; createdMs: number } | null> {
    try {
      const customerId = options.resolvedCustomerId || (await CoffeeMachineService.resolveMachineCustomerId(machine.id, machine.customerId));
      if (!isRealCustomerId(customerId)) return null;
      const files = await FtpService.listFiles(FtpResourceType.Backup, customerId);
      const matches = files
        .filter((f) => isMatchingCustomerBackupZip(f.filename, machine, options.excludeFilenames))
        .sort((a, b) => parseFtpTimestampMs(b) - parseFtpTimestampMs(a) || String(b.filename).localeCompare(String(a.filename)));

      for (const candidate of matches.slice(0, 3)) {
        const configJson = await CoffeeMachineService.extractRealConfigFromBackupZip(customerId, candidate.filename);
        if (configJson) return { configJson, filename: candidate.filename, createdMs: parseFtpTimestampMs(candidate) };
      }
      return null;
    } catch {
      return null;
    }
  }

  static async fetchMostRecentFtpConfig(
    machine: FleetMachine,
    resolvedCustomerId?: string
  ): Promise<{ configJson: RawMachineConfigJson | null; productLibraryJson: RawProductLibraryJson | null; fromNewerBackupZip: boolean }> {
    try {
      const downloaded = await CoffeeMachineService.downloadConfigJson(machine.id);
      const normalized = normalizeRealMachineConfig(downloaded);
      if (normalized) {
        return {
          configJson: normalized,
          productLibraryJson: await CoffeeMachineService.downloadProductLibraryJson(machine.id),
          fromNewerBackupZip: false,
        };
      }
    } catch (err) {
      if (err && typeof err === 'object' && 'status' in err && (err as { status: number }).status === 401) throw err;
    }

    const latestBackup = await CoffeeMachineService.findLatestCustomerBackup(machine, { resolvedCustomerId });
    return latestBackup
      ? { configJson: latestBackup.configJson, productLibraryJson: null, fromNewerBackupZip: true }
      : { configJson: null, productLibraryJson: null, fromNewerBackupZip: false };
  }

  static async requestConfigFromOnlineMachine(
    machine: FleetMachine,
    options: { preferFreshBackup?: boolean } = {}
  ): Promise<{ configJson: RawMachineConfigJson | null; productLibraryJson: RawProductLibraryJson | null; isFreshMachineExport: boolean; fromBackupZip?: boolean }> {
    const empty = { configJson: null, productLibraryJson: null, isFreshMachineExport: false, fromBackupZip: false };
    if (!machine.cmConnected) return empty;
    try {
      const customerId = await CoffeeMachineService.resolveMachineCustomerId(machine.id, machine.customerId);
      const hasValidCust = isRealCustomerId(customerId);
      const existingZipNames = new Set(hasValidCust ? (await FtpService.listFiles(FtpResourceType.Backup, customerId)).map((f) => f.filename) : []);

      let beforeCfgMs = 0;
      try {
        const cfgEntry = (await FtpService.listFiles(FtpResourceType.Config, machine.id)).find(
          (f) => f.filename.toLowerCase() === MachineConfigFile.ConfigJson.toLowerCase()
        );
        if (cfgEntry) beforeCfgMs = parseFtpTimestampMs(cfgEntry);
      } catch {
        // Ignore
      }

      await CoffeeMachineService.deleteConfigFile(machine.id, MachineConfigFile.ConfigHashJson);
      if (hasValidCust) {
        await TbService.post(`/rpc/oneway/${machine.id}`, {
          method: 'createBackup',
          timeout: 2500,
          params: { customer: customerId, fullBackup: false },
        }).catch(() => undefined);
      }

      const seenSizes = new Map<string, number>();
      const maxAttempts = options.preferFreshBackup ? 8 : 6;
      for (let i = 0; i < maxAttempts; i += 1) {
        await new Promise((r) => setTimeout(r, 1250));
        try {
          const cfgEntry = (await FtpService.listFiles(FtpResourceType.Config, machine.id)).find(
            (f) => f.filename.toLowerCase() === MachineConfigFile.ConfigJson.toLowerCase()
          );
          const curMs = cfgEntry ? parseFtpTimestampMs(cfgEntry) : 0;
          if ((!options.preferFreshBackup && cfgEntry) || (curMs > 0 && curMs > beforeCfgMs)) {
            const cfg = normalizeRealMachineConfig(await CoffeeMachineService.downloadConfigJson(machine.id));
            if (cfg) {
              return {
                configJson: cfg,
                productLibraryJson: await CoffeeMachineService.downloadProductLibraryJson(machine.id),
                isFreshMachineExport: curMs > beforeCfgMs,
                fromBackupZip: false,
              };
            }
          }
        } catch {
          // Not uploaded yet
        }

        if (hasValidCust) {
          const newZips = (await FtpService.listFiles(FtpResourceType.Backup, customerId)).filter((f) =>
            isMatchingCustomerBackupZip(f.filename, machine, existingZipNames)
          );
          for (const candidate of newZips) {
            const curSize = Number.parseInt(String(candidate.size ?? '0'), 10) || 0;
            const prevSize = seenSizes.get(candidate.filename) ?? -1;
            seenSizes.set(candidate.filename, curSize);
            if (curSize > 0 && curSize === prevSize) {
              const built = await CoffeeMachineService.extractRealConfigFromBackupZip(customerId, candidate.filename);
              if (built) {
                await FtpService.deleteFile(FtpResourceType.Backup, customerId, candidate.filename).catch(() => undefined);
                return { configJson: built, productLibraryJson: null, isFreshMachineExport: true, fromBackupZip: true };
              }
            }
          }
        }
      }
    } catch {
      // Ignore RPC errors
    }
    return empty;
  }

  static downloadProductLibraryJson = (deviceId: string): Promise<RawProductLibraryJson | null> =>
    FtpService.downloadJsonOrNull<RawProductLibraryJson>(FtpResourceType.Config, deviceId, MachineConfigFile.ProductLibraryJson);

  static async getCmdStack(deviceId: string): Promise<{ exists: boolean; content: string }> {
    const content = await FtpService.downloadTextOrNull(FtpResourceType.Config, deviceId, MachineConfigFile.CmdStackJson);
    return { exists: Boolean(content?.trim().length), content: content || '' };
  }

  static uploadCustomerBackupZip = (customerId: string, zipPackage: PartialBackupZipPackage): Promise<unknown> =>
    FtpService.upload({ uid: customerId, type: FtpResourceType.Backup, fileId: `pricing-${Date.now()}`, fileName: zipPackage.fileName, content: zipPackage.zipBytes, contentType: MimeType.Zip });

  static uploadConfigFile = (deviceId: string, fileName: MachineConfigFile | string, content: string | Uint8Array, contentType: MimeType = MimeType.Json): Promise<unknown> =>
    FtpService.upload({
      uid: deviceId,
      type: FtpResourceType.Config,
      fileId: `${String(fileName).replace(/\.[^.]+$/, '').toLowerCase() || 'config'}-${Date.now()}`,
      fileName,
      content,
      contentType,
    });

  static async probeMachineLiveRpc(deviceId: string, timeoutMs = 2500, options: { silentLog?: boolean } = {}): Promise<boolean> {
    try {
      const res = await TbService.post<{ ok?: boolean }>(`/rpc/twoway/${deviceId}`, { method: 'getTermInfo', params: {}, persistent: false, timeout: timeoutMs }, options);
      return Boolean(res && typeof res === 'object');
    } catch {
      return false;
    }
  }

  static async sendApplyBackupRpc(deviceId: string, customerId: string, zipFileName: string): Promise<ApplyBackupRpcCommand> {
    const rpcCommand = buildApplyPricingRpcCommand(customerId, zipFileName);
    await TbService.post(`/rpc/oneway/${deviceId}`, rpcCommand);
    return rpcCommand;
  }

  static async enqueueOfflineCmdStack(deviceId: string, customerId: string, zipFileName: string): Promise<{ queuedContent: string; rpcCommand: ApplyBackupRpcCommand }> {
    const rpcCommand = buildApplyPricingRpcCommand(customerId, zipFileName);
    const existing = await CoffeeMachineService.getCmdStack(deviceId);
    const queuedContent = appendCommandToCmdStack(existing.content, rpcCommand);
    await CoffeeMachineService.uploadConfigFile(deviceId, MachineConfigFile.CmdStackJson, queuedContent);
    return { queuedContent, rpcCommand };
  }

  static async deleteCustomerBackupZip(customerId: string, zipFileName: string): Promise<boolean> {
    if (!customerId || !zipFileName) return false;
    if (await FtpService.deleteFile(FtpResourceType.Backup, customerId, zipFileName)) return true;
    const files = await FtpService.listFiles(FtpResourceType.Backup, customerId);
    return !files.some((f) => f.filename === zipFileName);
  }

  static async removeBackupFromCmdStack(deviceId: string, zipFileName: string): Promise<{ remainingContent: string }> {
    const existing = await CoffeeMachineService.getCmdStack(deviceId);
    if (!existing.exists) return { remainingContent: '' };
    const remainingContent = removeBackupFileFromCmdStack(existing.content, zipFileName);
    if (!remainingContent) await CoffeeMachineService.deleteConfigFile(deviceId, MachineConfigFile.CmdStackJson);
    else await CoffeeMachineService.uploadConfigFile(deviceId, MachineConfigFile.CmdStackJson, remainingContent);
    return { remainingContent };
  }
}
