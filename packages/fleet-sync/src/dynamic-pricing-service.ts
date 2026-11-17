/**
 * Fleet Dynamic Pricing Orchestration: config loading, layout validation/packaging,
 * single-shot live vs offline cmdStack dispatch, queue reconciliation, and backup cleanup.
 */

import { HttpError } from '#cloud-client';
import {
  BackupCleanupStatus,
  clusterMachinesByLayout,
  createPartialPricingBackupZip,
  doesRawConfigMatchTargetPrices,
  ensureSafePartialBackupFilename,
  evaluateMachineSyncState,
  exportToPriceListJson,
  extractQueuedBackupEntriesFromCmdStack,
  isBatchReadyForBackupDeletion,
  MachineSyncState,
  parseMachineConfig,
  SAMPLE_LAYOUT_3X5,
  SAMPLE_LAYOUT_4X6,
  validatePriceListAgainstMachine,
  type ClusterMachineValidation,
  type FleetMachine,
  type LayoutCluster,
  type MachineLayout,
  type PricingDeploymentPackage,
  type PricingDeploymentSummary,
  type QueuedMachineSyncItem,
  type RawMachineConfigJson,
  type TrackedDeploymentBatch,
} from '#firmware-core';
import {
  ALL_CUSTOMERS_ID,
  CoffeeMachineService,
  normalizeRealMachineConfig,
} from './coffee-machine-service.ts';

export const formatMachineLabel = (
  machine: Pick<FleetMachine, 'id' | 'serialNumber' | 'name' | 'modelTypeDisplay'> | undefined,
  fallbackId = ''
): string =>
  !machine
    ? fallbackId.slice(0, 8)
    : [machine.serialNumber, machine.name].filter(Boolean).join(' · ') || `${machine.modelTypeDisplay} (${machine.id.slice(0, 6)})`;

export type PendingMachineTransitionResult =
  | { kind: 'confirmed_by_config'; nextItem: QueuedMachineSyncItem; shouldClearCmdStack: boolean; confirmedConfig: RawMachineConfigJson; confirmedConfigHash: string | null }
  | { kind: 'already_dispatched'; nextItem: QueuedMachineSyncItem }
  | { kind: 'picked_up_from_cmdstack'; nextItem: QueuedMachineSyncItem }
  | { kind: 'probe_reconnect'; customerId: string; stillQueued: boolean; liveConnected: boolean; nextLastRpcAttemptAtIso: string }
  | { kind: 'stay_pending'; nextItem: QueuedMachineSyncItem };

export function evaluatePendingMachineTransition(params: {
  item: QueuedMachineSyncItem;
  batchCustomerId: string;
  targetLayout?: MachineLayout | null;
  liveConnected: boolean;
  stillQueued: boolean;
  liveConfig: RawMachineConfigJson | null;
  liveConfigHash: string | null;
  nowMs: number;
  nowIso: string;
}): PendingMachineTransitionResult {
  const { item, batchCustomerId, targetLayout, liveConnected, stillQueued, liveConfig, liveConfigHash, nowMs, nowIso } = params;

  const realLiveConfig = normalizeRealMachineConfig(liveConfig);
  const rawMatchesTarget = Boolean(targetLayout && realLiveConfig && doesRawConfigMatchTargetPrices(realLiveConfig, targetLayout));
  const hashChanged = liveConfigHash !== null && liveConfigHash !== (item.preDeployConfigHash ?? null);
  const configConfirmed = rawMatchesTarget && (!item.preDeployAlreadyMatchedTarget || hashChanged || !stillQueued);

  if (configConfirmed && realLiveConfig) {
    return {
      kind: 'confirmed_by_config',
      nextItem: { ...item, cmConnected: liveConnected, hasPendingCmdStack: false, syncedAtIso: item.syncedAtIso || nowIso, confirmedByConfigJson: true },
      shouldClearCmdStack: stillQueued,
      confirmedConfig: realLiveConfig,
      confirmedConfigHash: liveConfigHash,
    };
  }

  // Never re-send `applyBackup` once live-ACKed or already synced (prevents SX-App V1 reboot loop).
  if (item.rpcAckedLive || (!item.hasPendingCmdStack && item.syncedAtIso)) {
    return { kind: 'already_dispatched', nextItem: { ...item, cmConnected: liveConnected } };
  }

  if (!stillQueued && item.hasPendingCmdStack) {
    return {
      kind: 'picked_up_from_cmdstack',
      nextItem: { ...item, cmConnected: liveConnected, hasPendingCmdStack: false, syncedAtIso: item.syncedAtIso || nowIso, confirmedByConfigJson: false },
    };
  }

  const prevAttemptIso = item.lastRpcAttemptAtIso ?? null;
  const lastRpcMs = prevAttemptIso ? Date.parse(prevAttemptIso) : 0;
  const shouldAttemptProbe = liveConnected && ((!item.cmConnected && liveConnected) || !lastRpcMs || nowMs - lastRpcMs >= 15_000);
  const targetCust = item.customerId || batchCustomerId;

  if (shouldAttemptProbe && targetCust && targetCust !== ALL_CUSTOMERS_ID) {
    return { kind: 'probe_reconnect', customerId: targetCust, stillQueued, liveConnected, nextLastRpcAttemptAtIso: nowIso };
  }

  return {
    kind: 'stay_pending',
    nextItem: { ...item, cmConnected: liveConnected, hasPendingCmdStack: stillQueued, lastRpcAttemptAtIso: shouldAttemptProbe ? nowIso : prevAttemptIso },
  };
}

export async function dispatchLiveApplyBackupIfReachable(params: {
  machineId: string;
  customerId: string;
  zipFileName: string;
  probeTimeoutMs?: number;
  shouldProbe?: boolean;
  reEnqueueOnRpcFailure?: boolean;
}): Promise<{ dispatched: true } | { dispatched: false; reason: 'offline_or_unreachable' | 'rpc_failed'; reEnqueued: boolean }> {
  const { machineId, customerId, zipFileName, probeTimeoutMs = 2500, shouldProbe = true, reEnqueueOnRpcFailure = true } = params;
  const isLiveAck = shouldProbe ? await CoffeeMachineService.probeMachineLiveRpc(machineId, probeTimeoutMs) : false;
  if (!isLiveAck) return { dispatched: false, reason: 'offline_or_unreachable', reEnqueued: false };

  await CoffeeMachineService.removeBackupFromCmdStack(machineId, zipFileName).catch(() => {});
  try {
    await CoffeeMachineService.sendApplyBackupRpc(machineId, customerId, zipFileName);
    return { dispatched: true };
  } catch {
    let reEnqueued = false;
    if (reEnqueueOnRpcFailure) {
      try {
        await CoffeeMachineService.enqueueOfflineCmdStack(machineId, customerId, zipFileName);
        reEnqueued = true;
      } catch {
        // Caller preserves pending state
      }
    }
    return { dispatched: false, reason: 'rpc_failed', reEnqueued };
  }
}

export class DynamicPricingService {
  static async fetchMachinePricingAndRecipes(
    machine: FleetMachine,
    options: { forceLiveRefresh?: boolean } = {}
  ): Promise<{ machine: FleetMachine; cmdStackContent: string; syncState: MachineSyncState }> {
    const forceLiveRefresh = Boolean(options.forceLiveRefresh);
    let liveConnected = machine.cmConnected;
    let liveLastConnectMs = machine.lastConnectMs;
    if (forceLiveRefresh) {
      const [freshDevice] = await CoffeeMachineService.getMachinesByIds([machine.id]);
      if (freshDevice) {
        liveConnected = freshDevice.cmConnected;
        liveLastConnectMs = freshDevice.lastConnectMs ?? liveLastConnectMs;
      }
      if (liveConnected) liveConnected = await CoffeeMachineService.probeMachineLiveRpc(machine.id, 2500);
    }

    const machineWithLive: FleetMachine = { ...machine, cmConnected: liveConnected, lastConnectMs: liveLastConnectMs };
    let configJson = forceLiveRefresh ? null : normalizeRealMachineConfig(machine.rawConfigJson);
    let productLibraryJson = machine.rawProductLibraryJson;
    let configSource: FleetMachine['configSource'] = configJson ? machine.configSource || 'ftp' : undefined;
    let unavailableReason: FleetMachine['unavailableReason'] = undefined;
    let parsedLayout = configJson ? machine.layout || null : null;

    const tryRequestOnline = async (preferFreshBackup: boolean) => {
      const requested = await CoffeeMachineService.requestConfigFromOnlineMachine(machineWithLive, preferFreshBackup ? { preferFreshBackup: true } : {});
      if (requested.configJson) {
        configJson = requested.configJson;
        productLibraryJson = requested.productLibraryJson || productLibraryJson;
        configSource = 'ftp';
      }
    };

    if (!configJson) {
      if (forceLiveRefresh && liveConnected) await tryRequestOnline(true);

      if (!configJson) {
        try {
          const recent = await CoffeeMachineService.fetchMostRecentFtpConfig(machineWithLive);
          if (recent.configJson) {
            configJson = recent.configJson;
            productLibraryJson = recent.productLibraryJson || productLibraryJson;
            configSource = 'ftp';
          }
        } catch (err) {
          if (err instanceof HttpError && err.status === 401) throw new Error('Authentication expired (HTTP 401). Please sign in again.');
          configJson = null;
        }
      }

      if (!configJson && !forceLiveRefresh && liveConnected) await tryRequestOnline(false);

      // Offline Eligibility Gate — NEVER fabricate a sample layout for offline or non-simulator machines
      if (!configJson) {
        const isOnlineSimulator = liveConnected && /\b(sim|simulator|virtual)\b|^sim[-_]/i.test(`${machine.serialNumber || ''} ${machine.name || ''}`);
        if (isOnlineSimulator) {
          const isS300OrLarger = /s300|s500/i.test(`${machine.machineModel} ${machine.machineType} ${machine.name} ${machine.serialNumber}`);
          configJson = structuredClone(isS300OrLarger ? SAMPLE_LAYOUT_4X6 : SAMPLE_LAYOUT_3X5);
          configSource = 'sample';
        } else {
          parsedLayout = null;
          configSource = 'unavailable';
          unavailableReason = liveConnected ? 'no_ftp_data' : 'offline_no_ftp_data';
        }
      }
    }

    let configHash: string | null = machine.configHash ?? null;
    if (configJson && configSource === 'ftp') {
      const [fetchedLib, fetchedHash] = await Promise.all([
        productLibraryJson ? Promise.resolve(productLibraryJson) : CoffeeMachineService.downloadProductLibraryJson(machine.id),
        CoffeeMachineService.downloadConfigHash(machine.id).catch(() => null),
      ]);
      productLibraryJson = fetchedLib;
      configHash = fetchedHash ?? '';
    }

    const cmdStackInfo = await CoffeeMachineService.getCmdStack(machine.id).catch(() => ({ exists: false, content: '' }));
    if (configJson && !parsedLayout) {
      try {
        parsedLayout = parseMachineConfig(configJson, productLibraryJson);
      } catch {
        parsedLayout = null;
      }
    }

    return {
      machine: {
        ...machineWithLive,
        rawConfigJson: configJson,
        rawProductLibraryJson: productLibraryJson,
        layout: parsedLayout,
        configLoaded: Boolean(parsedLayout),
        configHash,
        configSource,
        unavailableReason,
      },
      cmdStackContent: cmdStackInfo.content || '',
      syncState: evaluateMachineSyncState({ hasUnsavedChanges: false, hasCmdStackOnFtp: cmdStackInfo.exists, wasDispatched: false, pricesMatchTarget: true }),
    };
  }

  static async loadFleetPricingAndRecipes(targetMachines: readonly FleetMachine[], options: { forceLiveRefresh?: boolean } = {}) {
    const results = await Promise.all(targetMachines.map((m) => DynamicPricingService.fetchMachinePricingAndRecipes(m, options)));
    const updatedById = new Map<string, FleetMachine>();
    const cmdStacksById: Record<string, string> = {};
    const machineStatesById: Record<string, MachineSyncState> = {};

    for (const res of results) {
      updatedById.set(res.machine.id, res.machine);
      cmdStacksById[res.machine.id] = res.cmdStackContent;
      machineStatesById[res.machine.id] = res.syncState;
    }

    const loaded = Array.from(updatedById.values());
    return {
      updatedById,
      cmdStacksById,
      machineStatesById,
      syncStatesById: machineStatesById,
      loadedCount: loaded.filter((m) => m.layout).length,
      totalRecipes: loaded.reduce((sum, m) => sum + (m.layout?.products?.length || 0), 0),
    };
  }

  static groupMachinesByLayout = (machines: readonly Partial<FleetMachine>[]): readonly LayoutCluster[] =>
    clusterMachinesByLayout(machines);

  static validateClusterCompatibility(
    cluster: LayoutCluster | null,
    editedLayout: MachineLayout | null,
    options: { ignoreRecipeMatch?: boolean | number } = {}
  ): ClusterMachineValidation[] {
    if (!cluster || !editedLayout) return [];
    const candidateJson = exportToPriceListJson(editedLayout, { ignoreRecipeMatch: Boolean(options.ignoreRecipeMatch) });
    return cluster.machines.map((m) => ({
      machine: m,
      validation: validatePriceListAgainstMachine(candidateJson, m.layout || parseMachineConfig(m.rawConfigJson!, m.rawProductLibraryJson)),
    }));
  }

  static buildPricingDeploymentPackage(
    editedLayout: MachineLayout,
    zipFileName: string,
    options: { ignoreRecipeMatch?: boolean | number } = {}
  ): PricingDeploymentPackage {
    const priceListJson = exportToPriceListJson(editedLayout, { ignoreRecipeMatch: Boolean(options.ignoreRecipeMatch) });
    const zipPackage = createPartialPricingBackupZip(priceListJson, zipFileName);
    return { priceListJson, zipPackage, safeFileName: ensureSafePartialBackupFilename(zipPackage.fileName) };
  }

  static async deployPricingToLayoutGroup(params: {
    customerId: string;
    cluster: LayoutCluster;
    editedLayout: MachineLayout;
    ignoreRecipeMatch?: boolean | number;
    groupLabel?: string;
  }): Promise<PricingDeploymentSummary> {
    const { cluster, editedLayout, ignoreRecipeMatch = false } = params;
    const first = cluster.machines[0];
    const resolvedCustomerId = first
      ? await CoffeeMachineService.resolveMachineCustomerId(first.id, params.customerId || first.customerId)
      : params.customerId;

    const { priceListJson, zipPackage, safeFileName } = DynamicPricingService.buildPricingDeploymentPackage(editedLayout, cluster.zipFileName, { ignoreRecipeMatch });
    await CoffeeMachineService.uploadCustomerBackupZip(resolvedCustomerId, zipPackage);

    const createdAtIso = new Date().toISOString();
    const machineStatesById: Record<string, MachineSyncState> = {};
    const cmdStacksById: Record<string, string> = {};
    const updatedMachinesById = new Map<string, FleetMachine>();
    const baselineLayoutsByMachineId: Record<string, MachineLayout> = {};
    const queuedItems: QueuedMachineSyncItem[] = [];
    let onlineDispatched = 0;
    let offlineQueued = 0;

    for (const machine of cluster.machines) {
      const mLayout = machine.layout || parseMachineConfig(machine.rawConfigJson!, machine.rawProductLibraryJson);
      if (!validatePriceListAgainstMachine(priceListJson, mLayout).valid) {
        machineStatesById[machine.id] = MachineSyncState.Failed;
        continue;
      }

      baselineLayoutsByMachineId[machine.id] = structuredClone(mLayout);
      const machineLabel = formatMachineLabel(machine);
      const preDeployConfigHash = machine.configHash !== undefined ? machine.configHash : await CoffeeMachineService.downloadConfigHash(machine.id).catch(() => null);
      const realPreCfg = normalizeRealMachineConfig(machine.rawConfigJson);
      const preDeployAlreadyMatchedTarget = Boolean(realPreCfg && doesRawConfigMatchTargetPrices(realPreCfg, editedLayout));

      const dispatch = await dispatchLiveApplyBackupIfReachable({
        machineId: machine.id,
        customerId: resolvedCustomerId,
        zipFileName: safeFileName,
        shouldProbe: machine.cmConnected,
        reEnqueueOnRpcFailure: false,
      });

      if (dispatch.dispatched) {
        updatedMachinesById.set(machine.id, { ...machine, cmConnected: true, layout: structuredClone(editedLayout), configLoaded: true });
        machineStatesById[machine.id] = MachineSyncState.Synced;
        onlineDispatched += 1;
        queuedItems.push({
          machineId: machine.id,
          machineLabel,
          serialNumber: machine.serialNumber || '',
          customerId: resolvedCustomerId,
          zipFileName: safeFileName,
          queuedAtIso: createdAtIso,
          deliveryMode: 'online_rpc',
          cmConnected: true,
          hasPendingCmdStack: false,
          rpcAckedLive: true,
          rpcAckedAtIso: createdAtIso,
          syncedAtIso: createdAtIso,
          lastRpcAttemptAtIso: createdAtIso,
          confirmedByConfigJson: false,
          preDeployConfigHash,
          preDeployAlreadyMatchedTarget,
        });
        continue;
      }

      updatedMachinesById.set(machine.id, { ...machine, cmConnected: false });
      try {
        const res = await CoffeeMachineService.enqueueOfflineCmdStack(machine.id, resolvedCustomerId, safeFileName);
        cmdStacksById[machine.id] = res.queuedContent;
        machineStatesById[machine.id] = MachineSyncState.Pending;
        offlineQueued += 1;
        queuedItems.push({
          machineId: machine.id,
          machineLabel,
          serialNumber: machine.serialNumber || '',
          customerId: resolvedCustomerId,
          zipFileName: safeFileName,
          queuedAtIso: createdAtIso,
          deliveryMode: 'offline_cmdstack',
          cmConnected: false,
          hasPendingCmdStack: true,
          rpcAckedLive: false,
          rpcAckedAtIso: null,
          syncedAtIso: null,
          lastRpcAttemptAtIso: machine.cmConnected ? createdAtIso : null,
          confirmedByConfigJson: false,
          preDeployConfigHash,
          preDeployAlreadyMatchedTarget,
        });
      } catch {
        machineStatesById[machine.id] = MachineSyncState.Failed;
      }
    }

    const allSynced = queuedItems.length > 0 && queuedItems.every((m) => !m.hasPendingCmdStack && Boolean(m.syncedAtIso));
    const trackedBatch: TrackedDeploymentBatch = {
      batchId: `batch-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      customerId: resolvedCustomerId,
      groupKey: cluster.layoutKey,
      groupLabel: params.groupLabel || cluster.layoutKey,
      zipFileName: safeFileName,
      createdAtIso,
      machines: queuedItems,
      targetLayout: structuredClone(editedLayout),
      baselineLayoutsByMachineId,
      allMachinesSyncedAtIso: allSynced ? createdAtIso : null,
      backupCleanupStatus: allSynced ? BackupCleanupStatus.WaitingDownloadGrace : BackupCleanupStatus.WaitingOfflineQueue,
      backupDeletedAtIso: null,
    };

    return { safeFileName, priceListJson, zipPackage, onlineDispatched, offlineQueued, machineStatesById, syncStatesById: machineStatesById, cmdStacksById, updatedMachinesById, trackedBatch };
  }

  static buildRecoveredBatchesFromCmdStacks(
    machines: readonly FleetMachine[],
    cmdStacksById: Readonly<Record<string, string>>,
    existingBatches: readonly TrackedDeploymentBatch[]
  ): TrackedDeploymentBatch[] {
    const tracked = new Set<string>();
    for (const batch of existingBatches) {
      if (batch.backupCleanupStatus === BackupCleanupStatus.Deleted) continue;
      for (const m of batch.machines) {
        if (m.hasPendingCmdStack || !m.syncedAtIso) tracked.add(`${m.machineId}::${batch.zipFileName}`);
      }
    }

    const machineById = new Map(machines.map((m) => [m.id, m]));
    const grouped = new Map<string, { customerId: string; zipFileName: string; items: QueuedMachineSyncItem[] }>();
    const nowIso = new Date().toISOString();

    for (const [machineId, rawStack] of Object.entries(cmdStacksById)) {
      if (!rawStack?.trim()) continue;
      const machine = machineById.get(machineId);
      const machineLabel = formatMachineLabel(machine, machineId);
      for (const entry of extractQueuedBackupEntriesFromCmdStack(rawStack)) {
        const dedupeKey = `${machineId}::${entry.sourceFile}`;
        if (tracked.has(dedupeKey)) continue;
        tracked.add(dedupeKey);

        const cust = entry.customerId || (machine?.customerId && machine.customerId !== ALL_CUSTOMERS_ID ? machine.customerId : '');
        const grpKey = `${cust}::${entry.sourceFile}`;
        const bucket = grouped.get(grpKey) ?? { customerId: cust, zipFileName: entry.sourceFile, items: [] };
        grouped.set(grpKey, bucket);
        bucket.items.push({
          machineId,
          machineLabel,
          serialNumber: machine?.serialNumber || '',
          customerId: cust,
          zipFileName: entry.sourceFile,
          queuedAtIso: nowIso,
          deliveryMode: 'offline_cmdstack',
          cmConnected: Boolean(machine?.cmConnected),
          hasPendingCmdStack: true,
          syncedAtIso: null,
        });
      }
    }

    return Array.from(grouped.values()).map((grp) => ({
      batchId: `recovered-${grp.zipFileName}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      customerId: grp.customerId,
      groupKey: grp.zipFileName,
      groupLabel: grp.zipFileName.replace(/^add_priceList_|\.zip$/g, ''),
      zipFileName: grp.zipFileName,
      createdAtIso: nowIso,
      machines: grp.items,
      allMachinesSyncedAtIso: null,
      backupCleanupStatus: BackupCleanupStatus.WaitingOfflineQueue,
      backupDeletedAtIso: null,
    }));
  }

  static async syncOfflineQueueAndCleanupBackups(batches: readonly TrackedDeploymentBatch[]) {
    const pendingById = new Map<string, QueuedMachineSyncItem[]>();
    for (const batch of batches) {
      if (batch.backupCleanupStatus === BackupCleanupStatus.Deleted) continue;
      for (const item of batch.machines) {
        if (!item.hasPendingCmdStack && item.syncedAtIso && item.confirmedByConfigJson) continue;
        const list = pendingById.get(item.machineId);
        if (list) list.push(item);
        else pendingById.set(item.machineId, [item]);
      }
    }

    const pendingIds = Array.from(pendingById.keys());
    const liveOnlineById: Record<string, boolean> = {};
    const cmdStackById: Record<string, string> = {};
    const liveConfigById: Record<string, RawMachineConfigJson | null> = {};
    const liveConfigHashById: Record<string, string | null> = {};

    if (pendingIds.length > 0) {
      const [liveDevices, stackEntries, hashEntries] = await Promise.all([
        CoffeeMachineService.getMachinesByIds(pendingIds),
        Promise.all(pendingIds.map(async (id) => [id, await CoffeeMachineService.getCmdStack(id).catch(() => ({ exists: true, content: '' }))] as const)),
        Promise.all(pendingIds.map(async (id) => [id, await CoffeeMachineService.downloadConfigHash(id).catch(() => null)] as const)),
      ]);
      for (const dev of liveDevices) liveOnlineById[dev.id] = dev.cmConnected;
      for (const [id, stack] of stackEntries) cmdStackById[id] = stack.exists ? stack.content : '';
      for (const [id, hash] of hashEntries) liveConfigHashById[id] = hash;

      const needConfigIds = pendingIds.filter((id) => {
        const liveHash = liveConfigHashById[id] ?? null;
        return liveHash === null || (pendingById.get(id) ?? []).some((item) => liveHash !== (item.preDeployConfigHash ?? null));
      });
      await Promise.all(
        needConfigIds.map(async (id) => {
          liveConfigById[id] = await CoffeeMachineService.downloadConfigJson(id).catch(() => null);
        })
      );
    }

    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const newlySyncedSet = new Set<string>();
    const confirmedConfigsById: Record<string, RawMachineConfigJson> = {};
    const confirmedConfigHashesById: Record<string, string> = {};

    const updatedBatches: TrackedDeploymentBatch[] = await Promise.all(
      batches.map(async (batch) => {
        if (batch.backupCleanupStatus === BackupCleanupStatus.Deleted) return batch;
        const nextMachines = await Promise.all(
          batch.machines.map(async (item): Promise<QueuedMachineSyncItem> => {
            if (!item.hasPendingCmdStack && item.syncedAtIso && item.confirmedByConfigJson) return item;
            const liveConnected = item.machineId in liveOnlineById ? liveOnlineById[item.machineId] : item.cmConnected;
            const stillQueued = extractQueuedBackupEntriesFromCmdStack(cmdStackById[item.machineId] ?? '').some((q) => q.sourceFile === item.zipFileName);
            const tr = evaluatePendingMachineTransition({
              item,
              batchCustomerId: batch.customerId,
              targetLayout: batch.targetLayout,
              liveConnected,
              stillQueued,
              liveConfig: liveConfigById[item.machineId] ?? null,
              liveConfigHash: liveConfigHashById[item.machineId] ?? null,
              nowMs,
              nowIso,
            });

            if (tr.kind === 'confirmed_by_config') {
              if (tr.shouldClearCmdStack) await CoffeeMachineService.removeBackupFromCmdStack(item.machineId, item.zipFileName).catch(() => {});
              confirmedConfigsById[item.machineId] = tr.confirmedConfig;
              if (tr.confirmedConfigHash !== null) confirmedConfigHashesById[item.machineId] = tr.confirmedConfigHash;
              newlySyncedSet.add(item.machineId);
              return tr.nextItem;
            }
            if (tr.kind === 'picked_up_from_cmdstack') newlySyncedSet.add(item.machineId);
            if (tr.kind !== 'probe_reconnect') return tr.nextItem;

            const dispatch = await dispatchLiveApplyBackupIfReachable({ machineId: item.machineId, customerId: tr.customerId, zipFileName: item.zipFileName, reEnqueueOnRpcFailure: true });
            if (dispatch.dispatched) {
              liveOnlineById[item.machineId] = true;
              newlySyncedSet.add(item.machineId);
              return { ...item, deliveryMode: 'online_rpc', cmConnected: true, hasPendingCmdStack: false, rpcAckedLive: true, rpcAckedAtIso: nowIso, syncedAtIso: nowIso, lastRpcAttemptAtIso: tr.nextLastRpcAttemptAtIso };
            }
            if (dispatch.reason === 'offline_or_unreachable') {
              liveOnlineById[item.machineId] = false;
              return { ...item, cmConnected: false, hasPendingCmdStack: tr.stillQueued, lastRpcAttemptAtIso: tr.nextLastRpcAttemptAtIso };
            }
            return { ...item, cmConnected: tr.liveConnected, hasPendingCmdStack: dispatch.reEnqueued ? true : tr.stillQueued, lastRpcAttemptAtIso: tr.nextLastRpcAttemptAtIso };
          })
        );

        const allSynced = nextMachines.length > 0 && nextMachines.every((m) => !m.hasPendingCmdStack && Boolean(m.syncedAtIso));
        return {
          ...batch,
          machines: nextMachines,
          allMachinesSyncedAtIso: allSynced ? batch.allMachinesSyncedAtIso || nowIso : null,
          backupCleanupStatus: allSynced ? BackupCleanupStatus.WaitingDownloadGrace : BackupCleanupStatus.WaitingOfflineQueue,
        };
      })
    );

    const deletedZipFiles: string[] = [];
    const deletionByKey = new Map<string, Promise<boolean>>();
    const finalBatches = await Promise.all(
      updatedBatches.map(async (batch): Promise<TrackedDeploymentBatch> => {
        if (!isBatchReadyForBackupDeletion(batch, updatedBatches, nowMs)) return batch;
        if (!batch.customerId || batch.customerId === ALL_CUSTOMERS_ID) {
          return { ...batch, backupCleanupStatus: BackupCleanupStatus.Deleted, backupDeletedAtIso: nowIso };
        }
        const zipKey = `${batch.customerId}::${batch.zipFileName}`;
        let delPromise = deletionByKey.get(zipKey);
        if (!delPromise) {
          delPromise = CoffeeMachineService.deleteCustomerBackupZip(batch.customerId, batch.zipFileName);
          deletionByKey.set(zipKey, delPromise);
        }
        if (await delPromise) {
          if (!deletedZipFiles.includes(batch.zipFileName)) deletedZipFiles.push(batch.zipFileName);
          return { ...batch, backupCleanupStatus: BackupCleanupStatus.Deleted, backupDeletedAtIso: nowIso };
        }
        return { ...batch, backupCleanupStatus: BackupCleanupStatus.DeleteFailed };
      })
    );

    return { batches: finalBatches, newlySyncedMachineIds: Array.from(newlySyncedSet), confirmedConfigsById, confirmedConfigHashesById, liveOnlineById, deletedZipFiles };
  }

  static async reconcileFleetLiveStatusAndConfigHashes(
    machines: readonly FleetMachine[],
    options: { unreachableTracker?: Map<string, { lastConnectMs: number; lastProbedAtMs: number }>; probeTimeoutMs?: number; retryDelayMs?: number } = {}
  ) {
    const liveOnlineById: Record<string, boolean> = {};
    const liveLastConnectMsById: Record<string, number | undefined> = {};
    const refreshedMachinesById = new Map<string, FleetMachine>();
    if (machines.length === 0) return { liveOnlineById, liveLastConnectMsById, refreshedMachinesById };

    const { unreachableTracker, probeTimeoutMs = 1800, retryDelayMs = 500 } = options;
    const machineById = new Map(machines.map((m) => [m.id, m]));
    const hashCandidates = machines.filter((m) => m.configLoaded && m.configSource !== 'sample' && m.configSource !== 'unavailable');

    const [liveDevices, hashEntries] = await Promise.all([
      CoffeeMachineService.getMachinesByIds(machines.map((m) => m.id)).catch(() => [] as FleetMachine[]),
      Promise.all(hashCandidates.map(async (m) => [m, await CoffeeMachineService.downloadConfigHash(m.id).catch(() => null)] as const)),
    ]);

    const nowMs = Date.now();
    await Promise.all(
      liveDevices.map(async (dev) => {
        liveLastConnectMsById[dev.id] = dev.lastConnectMs;
        if (!dev.cmConnected) {
          unreachableTracker?.delete(dev.id);
          liveOnlineById[dev.id] = false;
          return;
        }
        if (machineById.get(dev.id)?.configSource === 'sample') {
          liveOnlineById[dev.id] = true;
          return;
        }
        const curConnMs = dev.lastConnectMs ?? 0;
        const prev = unreachableTracker?.get(dev.id);
        if (prev && prev.lastConnectMs === curConnMs && nowMs - prev.lastProbedAtMs < 25_000) {
          liveOnlineById[dev.id] = false;
          return;
        }
        let isAlive = await CoffeeMachineService.probeMachineLiveRpc(dev.id, probeTimeoutMs, { silentLog: true });
        if (!isAlive && !prev) {
          if (retryDelayMs > 0) await new Promise((r) => setTimeout(r, retryDelayMs));
          isAlive = await CoffeeMachineService.probeMachineLiveRpc(dev.id, probeTimeoutMs, { silentLog: true });
        }
        if (isAlive) {
          unreachableTracker?.delete(dev.id);
          liveOnlineById[dev.id] = true;
        } else {
          unreachableTracker?.set(dev.id, { lastConnectMs: curConnMs, lastProbedAtMs: Date.now() });
          liveOnlineById[dev.id] = false;
        }
      })
    );

    await Promise.all(
      hashEntries.map(async ([machine, liveHash]) => {
        if (liveHash === null || machine.configHash === liveHash) return;
        const freshCfg = normalizeRealMachineConfig(await CoffeeMachineService.downloadConfigJson(machine.id).catch(() => null));
        if (!freshCfg) return;
        try {
          refreshedMachinesById.set(machine.id, {
            ...machine,
            cmConnected: machine.id in liveOnlineById ? liveOnlineById[machine.id] : machine.cmConnected,
            lastConnectMs: machine.id in liveLastConnectMsById ? liveLastConnectMsById[machine.id] : machine.lastConnectMs,
            rawConfigJson: freshCfg,
            layout: parseMachineConfig(freshCfg, machine.rawProductLibraryJson),
            configLoaded: true,
            configHash: liveHash,
            configSource: 'ftp',
            unavailableReason: undefined,
          });
        } catch {
          // Ignore malformed transient config.json
        }
      })
    );

    return { liveOnlineById, liveLastConnectMsById, refreshedMachinesById };
  }

  static async cancelAndDeleteDeploymentBatch(batch: TrackedDeploymentBatch, allBatches: readonly TrackedDeploymentBatch[]) {
    await Promise.all(
      batch.machines.map((m) => CoffeeMachineService.removeBackupFromCmdStack(m.machineId, batch.zipFileName).catch(() => {}))
    );
    const remainingBatches = allBatches.filter((b) => b.batchId !== batch.batchId);
    const shared = remainingBatches.some(
      (o) => o.customerId === batch.customerId && o.zipFileName === batch.zipFileName && o.backupCleanupStatus !== BackupCleanupStatus.Deleted
    );
    const deletedZip =
      batch.backupCleanupStatus !== BackupCleanupStatus.Deleted && !shared && Boolean(batch.customerId) && batch.customerId !== ALL_CUSTOMERS_ID
        ? await CoffeeMachineService.deleteCustomerBackupZip(batch.customerId, batch.zipFileName).catch(() => false)
        : false;
    return { remainingBatches, deletedZip };
  }
}
