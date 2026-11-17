'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  DeployFeedback,
} from '../components/pricing/ProductsPricingTable.tsx';
import type {
  GroupScheduleState,
  PricingGroupCluster,
} from '../components/pricing/PricingGroupsPanel.tsx';
import {
  isSyntheticSampleConfig,
  parseMachineConfig,
  SAMPLE_LAYOUT_3X5,
  validatePriceListAgainstMachine,
} from '#firmware-core';
import {
  exportToPriceListJson,
  parseDecimalToMinorPrice,
  updateSingleProductParam,
} from '#firmware-core';
import type { TranslationKey } from '../i18n/translations.ts';
import { DynamicPricingService } from '#fleet-sync';
import {
  PriceScheduleStatus,
  ScheduleRecurrence,
  type FleetMachine,
  type MachineLayout,
  type MachineSyncState,
  type PriceParamCode,
  type ScheduledPricingJob,
  type TrackedDeploymentBatch,
} from '#firmware-core';
import {
  readSavedWorkspaceState,
  stripConfigCache,
  writeSavedWorkspaceState,
} from '../utils/dashboardStorage.ts';
import { useLatestRef } from './useLatestRef.ts';

export interface UsePricingGroupsOptions {
  jwtToken: string | null;
  selectedCustomerId: string;
  selectedMachines: readonly FleetMachine[];
  configuredMachines: readonly FleetMachine[];
  activeWorkspaceView: 'fleet' | 'pricing';
  onRestoreWorkspaceView?: (view: 'fleet' | 'pricing') => void;
  loadConfigsForMachines: (
    targetMachines: FleetMachine[],
    options?: { quietStatus?: boolean; forceLiveRefresh?: boolean }
  ) => Promise<void>;
  setMachines: React.Dispatch<React.SetStateAction<FleetMachine[]>>;
  setMachineStatesById: React.Dispatch<React.SetStateAction<Record<string, MachineSyncState>>>;
  setFleetStatusMessage: React.Dispatch<React.SetStateAction<string>>;
  getGroupScheduleState: (cluster: PricingGroupCluster | null) => GroupScheduleState;
  onSaveScheduledJob: (job: ScheduledPricingJob, groupKey: string) => void;
  onAppendDeploymentBatch: (batch: TrackedDeploymentBatch) => void;
  onTriggerQueueCheck: () => void;
  t: (key: TranslationKey) => string;
}

export function usePricingGroups(options: UsePricingGroupsOptions) {
  const {
    jwtToken,
    selectedCustomerId,
    selectedMachines,
    configuredMachines,
    activeWorkspaceView,
    loadConfigsForMachines,
    setMachines,
    setMachineStatesById,
    setFleetStatusMessage,
    t,
  } = options;

  const [activeClusterIndex, setActiveClusterIndex] = useState(0);
  const [referenceMachineIdByCluster, setReferenceMachineIdByCluster] = useState<
    Record<string, string>
  >({});
  const [editedLayoutByGroup, setEditedLayoutByGroup] = useState<Record<string, MachineLayout>>({});
  const [groupByMachineId, setGroupByMachineId] = useState<Record<string, string>>({});
  const [deployFeedbackByGroup, setDeployFeedbackByGroup] = useState<
    Record<string, DeployFeedback>
  >({});
  const [isDispatching, setIsDispatching] = useState(false);

  const groupCounterRef = useRef<number>(1);

  const onRestoreWorkspaceViewRef = useLatestRef(options.onRestoreWorkspaceView);
  const getGroupScheduleStateRef = useLatestRef(options.getGroupScheduleState);
  const onSaveScheduledJobRef = useLatestRef(options.onSaveScheduledJob);
  const onAppendDeploymentBatchRef = useLatestRef(options.onAppendDeploymentBatch);
  const onTriggerQueueCheckRef = useLatestRef(options.onTriggerQueueCheck);

  // Restore persisted workspace grouping & active cluster/view on mount
  useEffect(() => {
    const savedWorkspace = readSavedWorkspaceState();
    if (savedWorkspace.groupByMachineId) {
      setGroupByMachineId(savedWorkspace.groupByMachineId);
      const maxNum = Object.values(savedWorkspace.groupByMachineId).reduce((max, key) => {
        const match = /^group-(\d+)$/.exec(key);
        return match ? Math.max(max, Number(match[1])) : max;
      }, 1);
      groupCounterRef.current = maxNum;
    }
    if (savedWorkspace.activeWorkspaceView) {
      onRestoreWorkspaceViewRef.current?.(savedWorkspace.activeWorkspaceView);
    }
    if (typeof savedWorkspace.activeClusterIndex === 'number') {
      setActiveClusterIndex(savedWorkspace.activeClusterIndex);
    }
  }, [onRestoreWorkspaceViewRef]);

  // Persist workspace grouping, active view, and active cluster index
  useEffect(() => {
    writeSavedWorkspaceState({
      groupByMachineId,
      activeWorkspaceView,
      activeClusterIndex,
    });
  }, [groupByMachineId, activeWorkspaceView, activeClusterIndex]);

  const getEffectiveMachineLayout = useCallback((m: FleetMachine): MachineLayout => {
    if (m.rawConfigJson && !isSyntheticSampleConfig(m.rawConfigJson)) {
      return parseMachineConfig(m.rawConfigJson, m.rawProductLibraryJson);
    }
    if (m.layout) {
      return m.layout;
    }
    if (m.rawConfigJson) {
      return parseMachineConfig(m.rawConfigJson, m.rawProductLibraryJson);
    }
    return parseMachineConfig(SAMPLE_LAYOUT_3X5);
  }, []);

  const clusters = useMemo<PricingGroupCluster[]>(() => {
    if (configuredMachines.length === 0) return [];
    const sortedMachines = [...configuredMachines].sort((a, b) =>
      `${a.serialNumber || ''} ${a.name || ''} ${a.id}`.localeCompare(
        `${b.serialNumber || ''} ${b.name || ''} ${b.id}`,
        undefined,
        { numeric: true }
      )
    );

    const byGroupKey = new Map<string, FleetMachine[]>();
    for (const m of sortedMachines) {
      const mLayout = getEffectiveMachineLayout(m);
      const gKey = groupByMachineId[m.id] || `auto-${mLayout.layoutKey}`;
      if (!byGroupKey.has(gKey)) {
        byGroupKey.set(gKey, []);
      }
      byGroupKey.get(gKey)!.push(m);
    }

    const sortedEntries = Array.from(byGroupKey.entries()).sort(([keyA], [keyB]) =>
      keyA.localeCompare(keyB, undefined, { numeric: true })
    );

    const result: PricingGroupCluster[] = [];
    for (const [gKey, groupMachines] of sortedEntries) {
      const firstMachine = groupMachines[0];
      const refLayout = getEffectiveMachineLayout(firstMachine);
      const refPriceList = exportToPriceListJson(refLayout, { ignoreRecipeMatch: false });
      const mismatchByMachineId: Record<string, string> = {};

      for (const m of groupMachines) {
        const mLayout = getEffectiveMachineLayout(m);
        const fwCheck = validatePriceListAgainstMachine(refPriceList, mLayout);
        if (!fwCheck.check1GridMatch) {
          mismatchByMachineId[m.id] =
            `Grid ${mLayout.rows}×${mLayout.columns}×${mLayout.categories} ≠ Group ${refLayout.rows}×${refLayout.columns}×${refLayout.categories}`;
        } else if (!fwCheck.check2RecipeMatch) {
          mismatchByMachineId[m.id] =
            `${fwCheck.mismatchedSlots.length} product slot(s) differ (${mLayout.products.length} vs ${refLayout.products.length} products)`;
        } else if (mLayout.layoutKey !== refLayout.layoutKey) {
          mismatchByMachineId[m.id] =
            `Product names or categories differ (${mLayout.signatureHash} ≠ ${refLayout.signatureHash})`;
        }
      }

      const hasLayoutMismatch = Object.keys(mismatchByMachineId).length > 0;
      const safeKey = gKey.replace(/[^a-zA-Z0-9_-]/g, '_');
      result.push({
        layoutKey: gKey,
        signatureHash: refLayout.signatureHash,
        rows: refLayout.rows,
        columns: refLayout.columns,
        categories: refLayout.categories,
        zipFileName: `add_priceList_${refLayout.layoutKey}_${safeKey}.zip`,
        referenceLayout: refLayout,
        machines: groupMachines,
        hasLayoutMismatch,
        mismatchByMachineId,
      });
    }
    return result;
  }, [configuredMachines, groupByMachineId, getEffectiveMachineLayout]);

  const safeActiveClusterIndex = activeClusterIndex < clusters.length ? activeClusterIndex : 0;
  const activeCluster = clusters[safeActiveClusterIndex] || clusters[0] || null;
  const activeLayoutKey = activeCluster?.layoutKey || '';

  const referenceMachine = useMemo(() => {
    if (!activeCluster) return null;
    const preferredId = referenceMachineIdByCluster[activeCluster.layoutKey];
    if (preferredId) {
      const found = activeCluster.machines.find((m) => m.id === preferredId);
      if (found) return found;
    }
    return activeCluster.machines[0] || null;
  }, [activeCluster, referenceMachineIdByCluster]);

  const baselineLayoutByGroup = useMemo<Record<string, MachineLayout>>(() => {
    const map: Record<string, MachineLayout> = {};
    for (const cluster of clusters) {
      const preferredId = referenceMachineIdByCluster[cluster.layoutKey];
      const refMachine =
        (preferredId ? cluster.machines.find((m) => m.id === preferredId) : null) ||
        cluster.machines[0] ||
        null;
      let resolved: MachineLayout = cluster.referenceLayout;
      if (refMachine && (refMachine.layout || refMachine.rawConfigJson)) {
        try {
          resolved = getEffectiveMachineLayout(refMachine);
        } catch {
          resolved = cluster.referenceLayout;
        }
      }
      map[cluster.layoutKey] = resolved;
    }
    return map;
  }, [clusters, referenceMachineIdByCluster, getEffectiveMachineLayout]);

  const baselineLayout = useMemo<MachineLayout | null>(() => {
    if (!activeCluster) return null;
    return baselineLayoutByGroup[activeCluster.layoutKey] || activeCluster.referenceLayout || null;
  }, [activeCluster, baselineLayoutByGroup]);

  const currentEditedLayout = useMemo<MachineLayout | null>(() => {
    if (!baselineLayout) return null;
    const edited = editedLayoutByGroup[activeLayoutKey];
    if (!edited || edited.layoutKey !== baselineLayout.layoutKey) {
      return {
        ...baselineLayout,
        ignoreRecipeMatch: false,
      };
    }
    return {
      ...edited,
      ignoreRecipeMatch: false,
    };
  }, [baselineLayout, editedLayoutByGroup, activeLayoutKey]);

  const handleMoveMachineToNewGroup = useCallback((machineId: string) => {
    groupCounterRef.current += 1;
    const newGroupKey = `group-${groupCounterRef.current}`;
    setGroupByMachineId((prev) => ({
      ...prev,
      [machineId]: newGroupKey,
    }));
  }, []);

  const handleMoveMachineToGroup = useCallback(
    (machineId: string, targetGroupKey: string, targetIdx: number) => {
      setGroupByMachineId((prev) => {
        const next = { ...prev };
        const targetCluster = clusters[targetIdx];
        if (targetCluster) {
          for (const existingM of targetCluster.machines) {
            next[existingM.id] = targetGroupKey;
          }
        }
        next[machineId] = targetGroupKey;
        return next;
      });
      setActiveClusterIndex(targetIdx);
    },
    [clusters]
  );

  const handleResetPrices = useCallback(() => {
    if (!activeLayoutKey) return;
    setEditedLayoutByGroup((prev) => {
      const next = { ...prev };
      delete next[activeLayoutKey];
      return next;
    });
  }, [activeLayoutKey]);

  const handleCellPriceChange = useCallback(
    (slotId: number, paramCode: PriceParamCode, decimalText: string) => {
      if (!currentEditedLayout || !activeLayoutKey) return;
      setDeployFeedbackByGroup((prev) => {
        if (!prev[activeLayoutKey]) return prev;
        const next = { ...prev };
        delete next[activeLayoutKey];
        return next;
      });
      const minorValue = parseDecimalToMinorPrice(decimalText);
      const nextLayout = updateSingleProductParam(
        currentEditedLayout,
        slotId,
        paramCode,
        String(minorValue),
        { syncGrinders: true }
      );
      setEditedLayoutByGroup((prev) => ({
        ...prev,
        [activeLayoutKey]: nextLayout,
      }));
    },
    [currentEditedLayout, activeLayoutKey]
  );

  /**
   * Consolidated single sync/fetch action for PricingGroupsPanel ("Sync Current Price Lists")
   * and ProductsPricingTable ("Fetch Current Price List").
   */
  const handleSyncPriceLists = useCallback(
    async (syncOptions?: { cluster?: PricingGroupCluster | null; forceLiveRefresh?: boolean }) => {
      const targetCluster = syncOptions?.cluster ?? null;
      const forceLiveRefresh = syncOptions?.forceLiveRefresh ?? Boolean(targetCluster);

      if (targetCluster) {
        const groupKey = targetCluster.layoutKey;
        setDeployFeedbackByGroup((prev) => {
          if (!prev[groupKey]) return prev;
          const next = { ...prev };
          delete next[groupKey];
          return next;
        });
        await loadConfigsForMachines(targetCluster.machines.map(stripConfigCache), {
          forceLiveRefresh,
        });
        return;
      }

      if (selectedMachines.length === 0) return;
      await loadConfigsForMachines(selectedMachines.map(stripConfigCache), {
        forceLiveRefresh,
      });
    },
    [selectedMachines, loadConfigsForMachines]
  );

  const handleDispatchCluster = useCallback(async () => {
    if (!activeCluster || !currentEditedLayout || !jwtToken) return;
    const groupKey = activeCluster.layoutKey;
    const groupLabel = `Group ${safeActiveClusterIndex + 1} (${activeCluster.rows}×${activeCluster.columns})`;
    const groupSched = getGroupScheduleStateRef.current(activeCluster);

    // Scheduled Mode: Save & Deploy on Schedule
    if (groupSched.enabled) {
      const parsedMs = Date.parse(groupSched.runAtLocal);
      if (!groupSched.runAtLocal || !Number.isFinite(parsedMs)) {
        setDeployFeedbackByGroup((prev) => ({
          ...prev,
          [groupKey]: { ok: false, message: 'Please pick a valid schedule date & time.' },
        }));
        return;
      }

      const startAtIso = new Date(parsedMs).toISOString();
      const shortId = Math.random().toString(36).slice(2, 7);
      const safeZip = `add_priceList_${currentEditedLayout.layoutKey}_sched_${shortId}.zip`;

      const scheduledJob: ScheduledPricingJob = {
        id: `sched-${Date.now()}-${shortId}`,
        name: groupLabel,
        customerId: selectedCustomerId || activeCluster.machines[0]?.customerId || '',
        groupKey,
        groupLabel,
        signatureHash: activeCluster.signatureHash,
        zipFileName: safeZip,
        machineIds: activeCluster.machines.map((m) => m.id),
        targetLayout: structuredClone(currentEditedLayout),
        revertLayout: null,
        ignoreRecipeMatch: false,
        recurrence: ScheduleRecurrence.Once,
        startAtIso,
        endAtIso: null,
        startTimeHm: '00:00',
        endTimeHm: null,
        status: PriceScheduleStatus.Scheduled,
        createdAtIso: new Date().toISOString(),
        lastTriggeredWindowKey: null,
        lastRevertedWindowKey: null,
        lastTriggeredAtIso: null,
        lastRevertedAtIso: null,
        lastResultSummary: null,
      };

      onSaveScheduledJobRef.current(scheduledJob, groupKey);

      const formattedWhen = new Date(parsedMs).toLocaleString([], {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
      const msg = `✓ ${t('scheduledForBadge')} ${formattedWhen}`;
      setDeployFeedbackByGroup((prev) => ({
        ...prev,
        [groupKey]: { ok: true, message: msg },
      }));
      setFleetStatusMessage(
        `⏱ ${groupLabel}: ${msg} (${activeCluster.machines.length} machine(s)).`
      );
      return;
    }

    // Immediate Mode: Save & Deploy Now
    setIsDispatching(true);
    setDeployFeedbackByGroup((prev) => {
      const next = { ...prev };
      delete next[groupKey];
      return next;
    });

    const customerId = selectedCustomerId || activeCluster.machines[0]?.customerId;
    setFleetStatusMessage(
      `Uploading ${activeCluster.zipFileName} and deploying updated recipe prices to ${activeCluster.machines.length} machine(s)...`
    );

    try {
      const result = await DynamicPricingService.deployPricingToLayoutGroup({
        customerId,
        cluster: activeCluster,
        editedLayout: currentEditedLayout,
        ignoreRecipeMatch: false,
        groupLabel,
      });

      onAppendDeploymentBatchRef.current(result.trackedBatch);

      if (result.updatedMachinesById.size > 0) {
        setMachines((prev) => prev.map((m) => result.updatedMachinesById.get(m.id) || m));
      }
      setEditedLayoutByGroup((prev) => {
        const next = { ...prev };
        delete next[groupKey];
        return next;
      });
      setMachineStatesById((prev) => ({ ...prev, ...result.syncStatesById }));

      // Probe quickly (~1.8s) so genuinely online machines confirm `config.json` & delete `.zip` almost immediately
      setTimeout(() => {
        onTriggerQueueCheckRef.current();
      }, 1800);

      const deliveryDesc =
        result.onlineDispatched > 0 && result.offlineQueued > 0
          ? `${result.onlineDispatched} live-ACKed via MQTT RPC, ${result.offlineQueued} queued in cmdStack.json (offline/unreachable)`
          : result.onlineDispatched > 0
            ? `live-ACKed via MQTT RPC on ${result.onlineDispatched} machine(s)`
            : `queued in cmdStack.json for ${result.offlineQueued} offline/unreachable machine(s)`;
      const msg = `✓ Deployed (${deliveryDesc}). Backup .zip auto-deletes after download/confirmation.`;
      setDeployFeedbackByGroup((prev) => ({
        ...prev,
        [groupKey]: { ok: true, message: msg },
      }));
      setFleetStatusMessage(msg);
    } catch (err) {
      const errMsg = `Deployment failed: ${err instanceof Error ? err.message : String(err)}`;
      setDeployFeedbackByGroup((prev) => ({
        ...prev,
        [groupKey]: { ok: false, message: errMsg },
      }));
      setFleetStatusMessage(errMsg);
    } finally {
      setIsDispatching(false);
    }
  }, [
    activeCluster,
    currentEditedLayout,
    jwtToken,
    safeActiveClusterIndex,
    selectedCustomerId,
    setMachines,
    setMachineStatesById,
    setFleetStatusMessage,
    t,
    getGroupScheduleStateRef,
    onSaveScheduledJobRef,
    onAppendDeploymentBatchRef,
    onTriggerQueueCheckRef,
  ]);

  const resetPricingOnCustomerChange = useCallback(() => {
    setEditedLayoutByGroup({});
    setReferenceMachineIdByCluster({});
  }, []);

  const resetPricingOnLogout = useCallback(() => {
    setEditedLayoutByGroup({});
    setDeployFeedbackByGroup({});
    setReferenceMachineIdByCluster({});
  }, []);

  return {
    groupByMachineId,
    clusters,
    activeCluster,
    activeClusterIndex: safeActiveClusterIndex,
    setActiveClusterIndex,
    editedLayoutByGroup,
    setEditedLayoutByGroup,
    baselineLayoutByGroup,
    baselineLayout,
    currentEditedLayout,
    referenceMachine,
    deployFeedbackByGroup,
    setDeployFeedbackByGroup,
    isDispatching,
    getEffectiveMachineLayout,
    handleCellPriceChange,
    handleResetPrices,
    handleMoveMachineToGroup,
    handleMoveMachineToNewGroup,
    handleDispatchCluster,
    handleSyncPriceLists,
    resetPricingOnCustomerChange,
    resetPricingOnLogout,
  };
}
