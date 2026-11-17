'use client';

import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  GroupScheduleState,
  PricingGroupCluster,
} from '../components/pricing/PricingGroupsPanel.tsx';
import type { DeployFeedback } from '../components/pricing/ProductsPricingTable.tsx';
import {
  doesRawConfigMatchTargetPrices,
  parseMachineConfig,
} from '#firmware-core';
import {
  evaluateDueScheduleAction,
  filterSchedulesForGroup,
  resolveClusterForScheduledJob,
} from '#firmware-core';
import type { TranslationKey } from '../i18n/translations.ts';
import { AuthService } from '#cloud-client';
import { CoffeeMachineService } from '#fleet-sync';
import { DynamicPricingService } from '#fleet-sync';
import {
  BackupCleanupStatus,
  MachineSyncState,
  PriceScheduleStatus,
  type FleetMachine,
  type LayoutCluster,
  type MachineLayout,
  type ScheduledPricingJob,
  type TrackedDeploymentBatch,
} from '#firmware-core';
import {
  formatDateToLocalInput,
  MAX_STORED_BATCHES,
  readSavedDeploymentBatches,
  readSavedScheduledJobs,
  writeSavedDeploymentBatches,
  writeSavedScheduledJobs,
} from '../utils/dashboardStorage.ts';
import { useLatestRef } from './useLatestRef.ts';

export interface UseOfflineQueueAndSchedulesOptions {
  jwtToken: string | null;
  selectedCustomerId: string;
  machines: readonly FleetMachine[];
  clusters: readonly PricingGroupCluster[];
  activeCluster: PricingGroupCluster | null;
  unreachableTrackerRef: React.RefObject<
    Map<string, { lastConnectMs: number; lastProbedAtMs: number }>
  >;
  setMachines: React.Dispatch<React.SetStateAction<FleetMachine[]>>;
  setMachineStatesById: React.Dispatch<React.SetStateAction<Record<string, MachineSyncState>>>;
  setFleetStatusMessage: React.Dispatch<React.SetStateAction<string>>;
  setEditedLayoutByGroup: React.Dispatch<React.SetStateAction<Record<string, MachineLayout>>>;
  setActiveClusterIndex: React.Dispatch<React.SetStateAction<number>>;
  setDeployFeedbackByGroup: React.Dispatch<React.SetStateAction<Record<string, DeployFeedback>>>;
  t: (key: TranslationKey) => string;
}

export function useOfflineQueueAndSchedules(options: UseOfflineQueueAndSchedulesOptions) {
  const {
    jwtToken,
    selectedCustomerId,
    machines,
    clusters,
    activeCluster,
    unreachableTrackerRef,
    setMachines,
    setMachineStatesById,
    setFleetStatusMessage,
    setEditedLayoutByGroup,
    setActiveClusterIndex,
    setDeployFeedbackByGroup,
    t,
  } = options;

  const [deploymentBatches, setDeploymentBatches] = useState<TrackedDeploymentBatch[]>([]);
  const [isCheckingQueue, setIsCheckingQueue] = useState(false);
  const [scheduledJobs, setScheduledJobs] = useState<ScheduledPricingJob[]>([]);
  const [scheduleDraftByGroup, setScheduleDraftByGroup] = useState<
    Record<string, { enabled: boolean; runAtLocal: string }>
  >({});

  const isPollingQueueRef = useRef<boolean>(false);
  const isRunningScheduleRef = useRef<boolean>(false);
  const preRefreshedScheduleIdsRef = useRef<Set<string>>(new Set());

  const deploymentBatchesRef = useLatestRef(deploymentBatches);
  const scheduledJobsRef = useLatestRef(scheduledJobs);
  const machinesRef = useLatestRef(machines);
  const clustersRef = useLatestRef(clusters);

  // Restore saved batches & scheduled jobs on mount
  useEffect(() => {
    setDeploymentBatches(readSavedDeploymentBatches());
    const savedSchedules = readSavedScheduledJobs().filter(
      (j) => j.status === PriceScheduleStatus.Scheduled
    );
    setScheduledJobs(savedSchedules);

    if (savedSchedules.length > 0) {
      const drafts: Record<string, { enabled: boolean; runAtLocal: string }> = {};
      const restoredLayouts: Record<string, MachineLayout> = {};
      for (const job of savedSchedules) {
        drafts[job.groupKey] = {
          enabled: true,
          runAtLocal: formatDateToLocalInput(job.startAtIso),
        };
        if (job.targetLayout) {
          restoredLayouts[job.groupKey] = job.targetLayout;
        }
      }
      setScheduleDraftByGroup(drafts);
      setEditedLayoutByGroup((prev) => ({ ...restoredLayouts, ...prev }));
    }
  }, [setEditedLayoutByGroup]);

  const recoverBatchesFromCmdStacks = useCallback(
    (updatedArray: FleetMachine[], cmdStacksById: Record<string, string>) => {
      setDeploymentBatches((prevBatches) => {
        const recovered = DynamicPricingService.buildRecoveredBatchesFromCmdStacks(
          updatedArray,
          cmdStacksById,
          prevBatches
        );
        if (recovered.length === 0) return prevBatches;
        const merged = [...recovered, ...prevBatches].slice(0, MAX_STORED_BATCHES);
        deploymentBatchesRef.current = merged;
        writeSavedDeploymentBatches(merged);
        return merged;
      });
    },
    [deploymentBatchesRef]
  );

  const promoteConfirmedBatchRows = useCallback(
    (refreshedMachinesById: Map<string, FleetMachine>) => {
      if (refreshedMachinesById.size === 0 || deploymentBatchesRef.current.length === 0) return;
      let batchUpdated = false;
      const nextBatches = deploymentBatchesRef.current.map((batch) => {
        if (!batch.targetLayout) return batch;
        let rowChanged = false;
        const nextItems = batch.machines.map((item) => {
          if (item.confirmedByConfigJson) return item;
          const refreshed = refreshedMachinesById.get(item.machineId);
          if (
            refreshed?.rawConfigJson &&
            doesRawConfigMatchTargetPrices(refreshed.rawConfigJson, batch.targetLayout!)
          ) {
            rowChanged = true;
            return { ...item, confirmedByConfigJson: true };
          }
          return item;
        });
        if (!rowChanged) return batch;
        batchUpdated = true;
        return { ...batch, machines: nextItems };
      });

      if (batchUpdated) {
        setDeploymentBatches(nextBatches);
        deploymentBatchesRef.current = nextBatches;
        writeSavedDeploymentBatches(nextBatches);
      }
    },
    [deploymentBatchesRef]
  );

  const appendDeploymentBatch = useCallback(
    (trackedBatch: TrackedDeploymentBatch) => {
      setDeploymentBatches((prev) => {
        const next = [trackedBatch, ...prev].slice(0, MAX_STORED_BATCHES);
        deploymentBatchesRef.current = next;
        writeSavedDeploymentBatches(next);
        return next;
      });
    },
    [deploymentBatchesRef]
  );

  const saveScheduledJob = useCallback(
    (scheduledJob: ScheduledPricingJob, groupKey: string) => {
      setScheduledJobs((prev) => {
        const withoutCurrentGroup = prev.filter((j) => {
          const owner = resolveClusterForScheduledJob(j, clustersRef.current);
          return (owner ? owner.layoutKey : j.groupKey) !== groupKey;
        });
        const next = [scheduledJob, ...withoutCurrentGroup];
        writeSavedScheduledJobs(next);
        return next;
      });
    },
    [clustersRef]
  );

  /**
   * Polls offline queue (`cmdStack.json` + live `cmConnected`) and automatically deletes
   * `Backup/{customerId}/add_priceList_*.zip` once all queued machines sync + 15s download grace elapses.
   */
  const handleCheckOfflineQueueNow = useCallback(
    async (checkOptions: { manual?: boolean } = {}) => {
      if (!jwtToken || isPollingQueueRef.current) return;
      const currentBatches = deploymentBatchesRef.current;
      const hasActiveWork = currentBatches.some(
        (b) => b.backupCleanupStatus !== BackupCleanupStatus.Deleted
      );
      if (!hasActiveWork && !checkOptions.manual) return;

      isPollingQueueRef.current = true;
      if (checkOptions.manual) {
        setIsCheckingQueue(true);
      }

      try {
        const {
          batches: updatedBatches,
          newlySyncedMachineIds,
          confirmedConfigsById,
          confirmedConfigHashesById,
          liveOnlineById,
          deletedZipFiles,
        } = await DynamicPricingService.syncOfflineQueueAndCleanupBackups(currentBatches);

        setDeploymentBatches(updatedBatches);
        deploymentBatchesRef.current = updatedBatches;
        writeSavedDeploymentBatches(updatedBatches);

        if (
          Object.keys(liveOnlineById).length > 0 ||
          Object.keys(confirmedConfigsById).length > 0
        ) {
          setMachines((prev) =>
            prev.map((m) => {
              const rawOnline = m.id in liveOnlineById ? liveOnlineById[m.id] : m.cmConnected;
              const unreachable = unreachableTrackerRef.current.get(m.id);
              const nextOnline =
                rawOnline &&
                unreachable &&
                unreachable.lastConnectMs === (m.lastConnectMs ?? 0)
                  ? false
                  : rawOnline;
              const confirmedCfg = confirmedConfigsById[m.id];
              const confirmedHash = confirmedConfigHashesById[m.id];
              if (confirmedCfg) {
                try {
                  const parsed = parseMachineConfig(confirmedCfg, m.rawProductLibraryJson);
                  return {
                    ...m,
                    cmConnected: nextOnline,
                    rawConfigJson: confirmedCfg,
                    layout: parsed,
                    configLoaded: true,
                    configHash: confirmedHash ?? m.configHash,
                    configSource: 'ftp',
                    unavailableReason: undefined,
                  };
                } catch {
                  // Fall through to online-only update
                }
              }
              return nextOnline !== m.cmConnected ? { ...m, cmConnected: nextOnline } : m;
            })
          );
        }

        if (newlySyncedMachineIds.length > 0) {
          setMachineStatesById((prev) => {
            const next = { ...prev };
            for (const id of newlySyncedMachineIds) {
              next[id] = MachineSyncState.Synced;
            }
            return next;
          });
        }

        if (deletedZipFiles.length > 0) {
          setFleetStatusMessage(
            `✓ Machine sync confirmed — automatically deleted ${deletedZipFiles.join(', ')} from FtpProxy Backup/.`
          );
        }
      } catch {
        // Ignore transient polling error; next tick will retry
      } finally {
        isPollingQueueRef.current = false;
        if (checkOptions.manual) {
          setIsCheckingQueue(false);
        }
      }
    },
    [
      jwtToken,
      deploymentBatchesRef,
      unreachableTrackerRef,
      setMachines,
      setMachineStatesById,
      setFleetStatusMessage,
    ]
  );

  // Automatic background watcher for Offline Sync Queue & Backup Zip Cleanup (every 4s while active)
  const hasActiveQueueOrCleanup = useMemo(
    () => deploymentBatches.some((b) => b.backupCleanupStatus !== BackupCleanupStatus.Deleted),
    [deploymentBatches]
  );

  useQuery({
    queryKey: ['offline-queue-poll', selectedCustomerId],
    enabled: Boolean(jwtToken && hasActiveQueueOrCleanup),
    queryFn: async () => {
      await handleCheckOfflineQueueNow();
      return true;
    },
    refetchInterval: 4_000,
  });

  const handleCancelAndDeleteBatch = useCallback(
    async (batch: TrackedDeploymentBatch) => {
      if (!jwtToken) return;
      setIsCheckingQueue(true);
      try {
        const { remainingBatches, deletedZip } =
          await DynamicPricingService.cancelAndDeleteDeploymentBatch(
            batch,
            deploymentBatchesRef.current
          );
        setDeploymentBatches(remainingBatches);
        deploymentBatchesRef.current = remainingBatches;
        writeSavedDeploymentBatches(remainingBatches);
        setMachineStatesById((prev) => {
          const next = { ...prev };
          for (const m of batch.machines) {
            next[m.machineId] = MachineSyncState.Synced;
          }
          return next;
        });
        setFleetStatusMessage(
          deletedZip
            ? `✓ Canceled deployment & deleted ${batch.zipFileName} (+ cmdStack.json) from FTP.`
            : `✓ Canceled deployment ${batch.zipFileName} and cleared cmdStack.json.`
        );
      } catch (err) {
        setFleetStatusMessage(
          `Failed to cancel deployment: ${err instanceof Error ? err.message : String(err)}`
        );
      } finally {
        setIsCheckingQueue(false);
      }
    },
    [jwtToken, deploymentBatchesRef, setMachineStatesById, setFleetStatusMessage]
  );

  const handleCancelQueuedMachine = useCallback(
    async (batchId: string, machineId: string, zipFileName: string) => {
      if (!jwtToken) return;
      const targetBatch = deploymentBatchesRef.current.find((b) => b.batchId === batchId);
      if (targetBatch && targetBatch.machines.length <= 1) {
        await handleCancelAndDeleteBatch(targetBatch);
        return;
      }

      setIsCheckingQueue(true);
      try {
        await CoffeeMachineService.removeBackupFromCmdStack(machineId, zipFileName);
        const nowIso = new Date().toISOString();
        const updated = deploymentBatchesRef.current.map((b) => {
          if (b.batchId !== batchId) return b;
          const remainingMachines = b.machines.filter((m) => m.machineId !== machineId);
          const allSynced = remainingMachines.every(
            (m) => !m.hasPendingCmdStack && Boolean(m.syncedAtIso)
          );
          return {
            ...b,
            machines: remainingMachines,
            allMachinesSyncedAtIso: allSynced ? b.allMachinesSyncedAtIso || nowIso : null,
            backupCleanupStatus: allSynced
              ? BackupCleanupStatus.WaitingDownloadGrace
              : BackupCleanupStatus.WaitingOfflineQueue,
          };
        });
        setDeploymentBatches(updated);
        deploymentBatchesRef.current = updated;
        writeSavedDeploymentBatches(updated);
        setTimeout(() => {
          void handleCheckOfflineQueueNow();
        }, 500);

        setMachineStatesById((prev) => ({
          ...prev,
          [machineId]: MachineSyncState.Synced,
        }));
        setFleetStatusMessage(
          `Removed ${zipFileName} from cmdStack.json for machine ${machineId.slice(0, 8)}…`
        );
      } catch (err) {
        setFleetStatusMessage(
          `Failed to cancel queued update: ${err instanceof Error ? err.message : String(err)}`
        );
      } finally {
        setIsCheckingQueue(false);
      }
    },
    [
      jwtToken,
      deploymentBatchesRef,
      handleCancelAndDeleteBatch,
      handleCheckOfflineQueueNow,
      setMachineStatesById,
      setFleetStatusMessage,
    ]
  );

  const handleRemoveBatchRow = useCallback(
    (batchId: string) => {
      setDeploymentBatches((prev) => {
        const next = prev.filter((b) => b.batchId !== batchId);
        deploymentBatchesRef.current = next;
        writeSavedDeploymentBatches(next);
        return next;
      });
    },
    [deploymentBatchesRef]
  );

  const handleRestoreBatchBaseline = useCallback(
    (batch: TrackedDeploymentBatch) => {
      if (!batch.baselineLayoutsByMachineId) return;
      const firstBaseline = Object.values(batch.baselineLayoutsByMachineId)[0];
      if (!firstBaseline) return;
      const matchingIdx = clusters.findIndex((c) => c.layoutKey === batch.groupKey);
      const targetGroupKey =
        matchingIdx >= 0 ? clusters[matchingIdx].layoutKey : activeCluster?.layoutKey;
      if (!targetGroupKey) return;
      if (matchingIdx >= 0) {
        setActiveClusterIndex(matchingIdx);
      }
      setEditedLayoutByGroup((prev) => ({
        ...prev,
        [targetGroupKey]: structuredClone(firstBaseline),
      }));
      setFleetStatusMessage(
        `↩ Loaded pre-deploy prices for ${batch.groupLabel} into the pricing editor.`
      );
    },
    [clusters, activeCluster, setActiveClusterIndex, setEditedLayoutByGroup, setFleetStatusMessage]
  );

  const handleClearCompletedBatches = useCallback(() => {
    setDeploymentBatches((prev) => {
      const kept = prev.filter((b) => b.backupCleanupStatus !== BackupCleanupStatus.Deleted);
      deploymentBatchesRef.current = kept;
      writeSavedDeploymentBatches(kept);
      return kept;
    });
  }, [deploymentBatchesRef]);

  const getGroupScheduleState = useCallback(
    (cluster: PricingGroupCluster | null): GroupScheduleState => {
      if (!cluster) return { enabled: false, runAtLocal: '', savedJob: null };
      const savedJob =
        filterSchedulesForGroup(cluster, clusters, scheduledJobs).find(
          (j) => j.status === PriceScheduleStatus.Scheduled
        ) || null;
      const draft = scheduleDraftByGroup[cluster.layoutKey];
      if (draft) {
        return { enabled: draft.enabled, runAtLocal: draft.runAtLocal, savedJob };
      }
      if (savedJob) {
        return {
          enabled: true,
          runAtLocal: formatDateToLocalInput(savedJob.startAtIso),
          savedJob,
        };
      }
      return { enabled: false, runAtLocal: '', savedJob: null };
    },
    [clusters, scheduledJobs, scheduleDraftByGroup]
  );

  const handleToggleGroupSchedule = useCallback(
    (cluster: PricingGroupCluster, idx: number, checked: boolean) => {
      setActiveClusterIndex(idx);
      if (!checked) {
        setScheduleDraftByGroup((prev) => ({
          ...prev,
          [cluster.layoutKey]: {
            enabled: false,
            runAtLocal: prev[cluster.layoutKey]?.runAtLocal || formatDateToLocalInput(undefined, 15),
          },
        }));
        setScheduledJobs((prev) => {
          const next = prev.filter((j) => {
            const owner = resolveClusterForScheduledJob(j, clusters);
            return (owner ? owner.layoutKey : j.groupKey) !== cluster.layoutKey;
          });
          writeSavedScheduledJobs(next);
          return next;
        });
        setDeployFeedbackByGroup((prev) => {
          if (!prev[cluster.layoutKey]) return prev;
          const next = { ...prev };
          delete next[cluster.layoutKey];
          return next;
        });
        return;
      }

      setScheduleDraftByGroup((prev) => ({
        ...prev,
        [cluster.layoutKey]: {
          enabled: true,
          runAtLocal: prev[cluster.layoutKey]?.runAtLocal || formatDateToLocalInput(undefined, 15),
        },
      }));
    },
    [clusters, setActiveClusterIndex, setDeployFeedbackByGroup]
  );

  const handleChangeGroupScheduleTime = useCallback(
    (cluster: PricingGroupCluster, idx: number, nextLocal: string) => {
      setActiveClusterIndex(idx);
      setScheduleDraftByGroup((prev) => ({
        ...prev,
        [cluster.layoutKey]: {
          enabled: true,
          runAtLocal: nextLocal,
        },
      }));
    },
    [setActiveClusterIndex]
  );

  /**
   * Executes a group-bound `ScheduledPricingJob` when its scheduled timestamp arrives.
   * Dynamically resolves the Group's current member machines and refreshes live `cmConnected`
   * right before dispatch so online machines switch immediately via MQTT RPC.
   */
  const executeScheduledJobAction = useCallback(
    async (job: ScheduledPricingJob) => {
      if (!jwtToken || isRunningScheduleRef.current) return;

      const liveCluster = resolveClusterForScheduledJob(job, clustersRef.current);
      if (liveCluster?.hasLayoutMismatch) {
        return;
      }

      const layoutToDeploy = job.targetLayout;
      if (!layoutToDeploy) return;

      const resolvedGroupKey = liveCluster?.layoutKey || job.groupKey;
      isRunningScheduleRef.current = true;

      try {
        // Ensure a freshly renewed JWT right before executing the scheduled deployment
        await AuthService.ensureFreshToken({ minValidityMs: 10 * 60_000, force: true });

        const dynamicGroupMachineIds = liveCluster
          ? liveCluster.machines.map((m) => m.id)
          : [...job.machineIds];

        const liveFetched = await CoffeeMachineService.getMachinesByIds(dynamicGroupMachineIds);
        const liveOnlineMap = new Map(liveFetched.map((m) => [m.id, m.cmConnected]));
        const localById = new Map(machinesRef.current.map((m) => [m.id, m]));

        const targetMachines: FleetMachine[] = [];
        for (const mId of dynamicGroupMachineIds) {
          const existing = localById.get(mId);
          if (existing && (existing.layout || existing.rawConfigJson)) {
            targetMachines.push({
              ...existing,
              cmConnected: liveOnlineMap.has(mId)
                ? Boolean(liveOnlineMap.get(mId))
                : existing.cmConnected,
            });
          } else {
            const liveStub = liveFetched.find((d) => d.id === mId);
            if (liveStub) {
              const loaded = await DynamicPricingService.fetchMachinePricingAndRecipes(liveStub);
              if (loaded.machine.layout || loaded.machine.rawConfigJson) {
                targetMachines.push(loaded.machine);
              }
            }
          }
        }

        if (targetMachines.length === 0) {
          throw new Error('No eligible machines with FTP configuration available in this group.');
        }

        const activeGroupIdx = liveCluster
          ? clustersRef.current.findIndex((c) => c.layoutKey === liveCluster.layoutKey)
          : -1;
        const resolvedGroupLabel =
          activeGroupIdx >= 0 && liveCluster
            ? `Group ${activeGroupIdx + 1} (${liveCluster.rows}×${liveCluster.columns})`
            : job.groupLabel;

        const syntheticCluster: LayoutCluster = {
          layoutKey: resolvedGroupKey,
          signatureHash: layoutToDeploy.signatureHash,
          rows: layoutToDeploy.rows,
          columns: layoutToDeploy.columns,
          categories: layoutToDeploy.categories,
          zipFileName: job.zipFileName,
          referenceLayout: layoutToDeploy,
          machines: targetMachines,
        };

        const summary = await DynamicPricingService.deployPricingToLayoutGroup({
          customerId:
            liveCluster?.machines[0]?.customerId || job.customerId || selectedCustomerId,
          cluster: syntheticCluster,
          editedLayout: layoutToDeploy,
          ignoreRecipeMatch: job.ignoreRecipeMatch,
          groupLabel: `${resolvedGroupLabel} (Scheduled)`,
        });

        appendDeploymentBatch(summary.trackedBatch);

        if (summary.updatedMachinesById.size > 0) {
          setMachines((prev) => prev.map((m) => summary.updatedMachinesById.get(m.id) || m));
        }
        setMachineStatesById((prev) => ({ ...prev, ...summary.syncStatesById }));

        setTimeout(() => {
          void handleCheckOfflineQueueNow();
        }, 1800);

        setEditedLayoutByGroup((prev) => {
          const next = { ...prev };
          delete next[resolvedGroupKey];
          return next;
        });

        // Clear completed schedule so the Group returns cleanly to immediate mode
        setScheduledJobs((prev) => {
          const next = prev.filter((j) => j.id !== job.id);
          writeSavedScheduledJobs(next);
          return next;
        });
        setScheduleDraftByGroup((prev) => ({
          ...prev,
          [resolvedGroupKey]: {
            enabled: false,
            runAtLocal: formatDateToLocalInput(undefined, 15),
          },
        }));

        const timeStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        const msg = `✓ Deployed on schedule at ${timeStr} (${summary.onlineDispatched} online MQTT RPC, ${summary.offlineQueued} offline queued)`;
        setDeployFeedbackByGroup((prev) => ({
          ...prev,
          [resolvedGroupKey]: { ok: true, message: msg },
        }));
        setFleetStatusMessage(`⏱ ${resolvedGroupLabel}: ${msg}.`);
      } catch (err) {
        const errNote = `Scheduled deploy failed: ${err instanceof Error ? err.message : String(err)}`;
        setDeployFeedbackByGroup((prev) => ({
          ...prev,
          [resolvedGroupKey]: { ok: false, message: errNote },
        }));
      } finally {
        isRunningScheduleRef.current = false;
      }
    },
    [
      jwtToken,
      selectedCustomerId,
      clustersRef,
      machinesRef,
      appendDeploymentBatch,
      setMachines,
      setMachineStatesById,
      handleCheckOfflineQueueNow,
      setEditedLayoutByGroup,
      setDeployFeedbackByGroup,
      setFleetStatusMessage,
    ]
  );

  // Automatic 1s local clock check so scheduled group deployments fire right on time
  // (also pre-refreshes the JWT token 60s before the scheduled timestamp arrives)
  useEffect(() => {
    if (!jwtToken || scheduledJobs.length === 0) return undefined;
    const checkSchedules = () => {
      if (isRunningScheduleRef.current) return;
      const now = new Date();
      const nowMs = now.getTime();
      for (const job of scheduledJobsRef.current) {
        const startMs = Date.parse(job.startAtIso);
        if (
          Number.isFinite(startMs) &&
          startMs - nowMs <= 60_000 &&
          startMs > nowMs &&
          !preRefreshedScheduleIdsRef.current.has(job.id)
        ) {
          preRefreshedScheduleIdsRef.current.add(job.id);
          void AuthService.ensureFreshToken({ force: true });
        }
        const due = evaluateDueScheduleAction(job, now);
        if (due?.type === 'apply') {
          void executeScheduledJobAction(job);
          break;
        }
      }
    };
    checkSchedules();
    const intervalId = setInterval(checkSchedules, 1_000);
    return () => clearInterval(intervalId);
  }, [jwtToken, scheduledJobs.length, scheduledJobsRef, executeScheduledJobAction]);

  return {
    deploymentBatches,
    isCheckingQueue,
    scheduledJobs,
    scheduleDraftByGroup,
    recoverBatchesFromCmdStacks,
    promoteConfirmedBatchRows,
    appendDeploymentBatch,
    saveScheduledJob,
    handleCheckOfflineQueueNow,
    handleCancelQueuedMachine,
    handleCancelAndDeleteBatch,
    handleRemoveBatchRow,
    handleRestoreBatchBaseline,
    handleClearCompletedBatches,
    getGroupScheduleState,
    handleToggleGroupSchedule,
    handleChangeGroupScheduleTime,
    executeScheduledJobAction,
  };
}
