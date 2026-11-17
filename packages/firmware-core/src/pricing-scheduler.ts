/**
 * Pure Functional Engine for Offline Backup Cleanup Grace Windows & Scheduled Dynamic Pricing.
 *
 * Contains zero I/O or DOM side effects so it is portable across client and server runtimes.
 */

import {
  BackupCleanupStatus,
  PriceScheduleStatus,
  ScheduleRecurrence,
  type FleetMachine,
  type LayoutCluster,
  type ScheduledPricingJob,
  type TrackedDeploymentBatch,
} from './types.ts';

/**
 * Dynamically resolves the active `LayoutCluster` (and its current member machines)
 * for a group-bound `ScheduledPricingJob` rather than relying on a static per-machine snapshot.
 */
export function resolveClusterForScheduledJob<T extends LayoutCluster>(
  job: Pick<ScheduledPricingJob, 'groupKey' | 'signatureHash' | 'machineIds'>,
  clusters: readonly T[]
): T | null {
  const exactByKey = clusters.find((c) => c.layoutKey === job.groupKey);
  if (exactByKey) {
    return exactByKey;
  }
  const sameSigWithMemberOverlap = clusters.find(
    (c) =>
      c.signatureHash === job.signatureHash &&
      c.machines.some((m) => job.machineIds.includes(m.id))
  );
  if (sameSigWithMemberOverlap) {
    return sameSigWithMemberOverlap;
  }
  const uniqueSameSig = clusters.filter((c) => c.signatureHash === job.signatureHash);
  return uniqueSameSig.length === 1 ? uniqueSameSig[0] : null;
}

/**
 * Returns the schedules belonging to `cluster` in `Pricing Groups`.
 */
export function filterSchedulesForGroup<T extends LayoutCluster>(
  cluster: T,
  allClusters: readonly T[],
  jobs: readonly ScheduledPricingJob[]
): ScheduledPricingJob[] {
  return jobs.filter((job) => {
    const owner = resolveClusterForScheduledJob(job, allClusters);
    return owner ? owner.layoutKey === cluster.layoutKey : job.groupKey === cluster.layoutKey;
  });
}

/**
 * Download grace window (15 seconds) after the last machine's MQTT RPC dispatch or
 * `cmdStack.json` pickup so the coffee machine finishes streaming the `.zip` archive
 * before `DELETE /api/v2/delete` removes it from `Backup/`.
 */
export const BACKUP_DOWNLOAD_GRACE_MS = 15_000;

export interface OnlineReadinessReport {
  readonly totalCount: number;
  readonly onlineCount: number;
  readonly offlineCount: number;
  readonly allOnline: boolean;
  readonly offlineMachineLabels: readonly string[];
}

export function evaluateGroupOnlineReadiness(
  machines: readonly Pick<FleetMachine, 'id' | 'serialNumber' | 'name' | 'cmConnected'>[]
): OnlineReadinessReport {
  const offline = machines.filter((m) => !m.cmConnected);
  return {
    totalCount: machines.length,
    onlineCount: machines.length - offline.length,
    offlineCount: offline.length,
    allOnline: machines.length > 0 && offline.length === 0,
    offlineMachineLabels: offline.map(
      (m) => [m.serialNumber, m.name].filter(Boolean).join(' · ') || m.id.slice(0, 8)
    ),
  };
}

function hasPendingMachines(batch: TrackedDeploymentBatch): boolean {
  return batch.machines.some((m) => !m.syncedAtIso || m.hasPendingCmdStack);
}

export function isBatchReadyForBackupDeletion(
  batch: TrackedDeploymentBatch,
  allBatches: readonly TrackedDeploymentBatch[],
  nowMs = Date.now()
): boolean {
  if (batch.backupCleanupStatus === BackupCleanupStatus.Deleted) {
    return false;
  }
  if (hasPendingMachines(batch) || !batch.allMachinesSyncedAtIso) {
    return false;
  }

  // Ensure no OTHER newer/parallel batch referencing the exact same zipFileName still has pending machines or grace window
  const hasOtherPendingBatchForSameZip = allBatches.some((other) => {
    if (other.batchId === batch.batchId) return false;
    if (
      other.customerId !== batch.customerId ||
      other.zipFileName !== batch.zipFileName ||
      other.backupCleanupStatus === BackupCleanupStatus.Deleted
    ) {
      return false;
    }
    if (hasPendingMachines(other)) {
      return true;
    }
    const otherSyncedMs = other.allMachinesSyncedAtIso
      ? Date.parse(other.allMachinesSyncedAtIso)
      : nowMs;
    return nowMs - otherSyncedMs < BACKUP_DOWNLOAD_GRACE_MS;
  });

  if (hasOtherPendingBatchForSameZip) {
    return false;
  }

  // When every machine has already uploaded its updated `config.json` to FTP, the `.zip` archive
  // has already been downloaded and applied on-device — safe to delete immediately.
  if (
    batch.machines.length > 0 &&
    batch.machines.every((m) => m.confirmedByConfigJson === true)
  ) {
    return true;
  }

  const allSyncedMs = Date.parse(batch.allMachinesSyncedAtIso);
  if (!Number.isFinite(allSyncedMs)) {
    return false;
  }
  return nowMs - allSyncedMs >= BACKUP_DOWNLOAD_GRACE_MS;
}

function parseHmToMinutes(hm: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(hm || '').trim());
  if (!match) return null;
  const hh = Number(match[1]);
  const mm = Number(match[2]);
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;
  return hh * 60 + mm;
}

function formatLocalDateKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function matchesRecurrenceDay(recurrence: ScheduleRecurrence, date: Date): boolean {
  const dow = date.getDay(); // 0 = Sun, 6 = Sat
  if (recurrence === ScheduleRecurrence.Daily) return true;
  if (recurrence === ScheduleRecurrence.Weekdays) return dow >= 1 && dow <= 5;
  if (recurrence === ScheduleRecurrence.Weekends) return dow === 0 || dow === 6;
  return false;
}

export type DueScheduleAction =
  | { readonly type: 'apply'; readonly windowKey: string }
  | { readonly type: 'revert'; readonly windowKey: string }
  | null;

function evaluateOnceSchedule(job: ScheduledPricingJob, nowMs: number): DueScheduleAction {
  const startMs = Date.parse(job.startAtIso);
  const endMs = job.endAtIso ? Date.parse(job.endAtIso) : null;
  const onceKey = `once:${job.id}`;

  if (
    endMs !== null &&
    Number.isFinite(endMs) &&
    nowMs >= endMs &&
    job.revertLayout &&
    job.lastTriggeredWindowKey === onceKey &&
    job.lastRevertedWindowKey !== onceKey
  ) {
    return { type: 'revert', windowKey: onceKey };
  }

  if (
    Number.isFinite(startMs) &&
    nowMs >= startMs &&
    (endMs === null || !Number.isFinite(endMs) || nowMs < endMs) &&
    job.lastTriggeredWindowKey !== onceKey
  ) {
    return { type: 'apply', windowKey: onceKey };
  }

  return null;
}

function evaluateRecurringSchedule(job: ScheduledPricingJob, nowDate: Date): DueScheduleAction {
  const startMinutes = parseHmToMinutes(job.startTimeHm);
  if (startMinutes === null) return null;

  const endMinutes = job.endTimeHm ? parseHmToMinutes(job.endTimeHm) : null;
  const currentMinutes = nowDate.getHours() * 60 + nowDate.getMinutes();
  const dateKey = formatLocalDateKey(nowDate);
  const todayKey = `${dateKey}:${job.startTimeHm}`;
  const isDayMatch = matchesRecurrenceDay(job.recurrence, nowDate);

  if (endMinutes !== null && endMinutes > startMinutes) {
    const insideWindow =
      isDayMatch && currentMinutes >= startMinutes && currentMinutes < endMinutes;
    if (insideWindow && job.lastTriggeredWindowKey !== todayKey) {
      return { type: 'apply', windowKey: todayKey };
    }
    if (
      !insideWindow &&
      job.revertLayout &&
      job.status === PriceScheduleStatus.ActiveWindow &&
      job.lastTriggeredWindowKey &&
      job.lastRevertedWindowKey !== job.lastTriggeredWindowKey &&
      (currentMinutes >= endMinutes || !job.lastTriggeredWindowKey.startsWith(dateKey))
    ) {
      return { type: 'revert', windowKey: job.lastTriggeredWindowKey };
    }
    return null;
  }

  if (isDayMatch && currentMinutes >= startMinutes && job.lastTriggeredWindowKey !== todayKey) {
    return { type: 'apply', windowKey: todayKey };
  }

  return null;
}

/**
 * Purely evaluates whether a `ScheduledPricingJob` should fire `'apply'` or `'revert'` at `nowDate`.
 */
export function evaluateDueScheduleAction(
  job: ScheduledPricingJob,
  nowDate = new Date()
): DueScheduleAction {
  if (
    job.status === PriceScheduleStatus.Paused ||
    job.status === PriceScheduleStatus.Completed
  ) {
    return null;
  }

  if (job.recurrence === ScheduleRecurrence.Once) {
    return evaluateOnceSchedule(job, nowDate.getTime());
  }

  return evaluateRecurringSchedule(job, nowDate);
}
