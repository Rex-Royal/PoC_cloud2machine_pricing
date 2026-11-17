'use client';

import React, { useMemo, useState } from 'react';
import { BACKUP_DOWNLOAD_GRACE_MS } from '#firmware-core';
import type { TranslationKey } from '../../i18n/translations.ts';
import {
  BackupCleanupStatus,
  type FleetMachine,
  type TrackedDeploymentBatch,
} from '#firmware-core';

export interface OfflineQueuePanelProps {
  deploymentBatches: readonly TrackedDeploymentBatch[];
  machines: readonly FleetMachine[];
  isCheckingQueue: boolean;
  onCheckQueueNow: () => void;
  onClearCompletedBatches: () => void;
  onRestoreBatchBaseline: (batch: TrackedDeploymentBatch) => void;
  onCancelAndDeleteBatch: (batch: TrackedDeploymentBatch) => void;
  onRemoveBatchRow: (batchId: string) => void;
  onCancelQueuedMachine: (batchId: string, machineId: string, zipFileName: string) => void;
  t: (key: TranslationKey) => string;
}

interface DeploymentBatchCardProps {
  batch: TrackedDeploymentBatch;
  machines: readonly FleetMachine[];
  isCheckingQueue: boolean;
  onRestoreBatchBaseline: (batch: TrackedDeploymentBatch) => void;
  onCancelAndDeleteBatch: (batch: TrackedDeploymentBatch) => void;
  onRemoveBatchRow: (batchId: string) => void;
  onCancelQueuedMachine: (batchId: string, machineId: string, zipFileName: string) => void;
  t: (key: TranslationKey) => string;
}

function DeploymentBatchCard({
  batch,
  machines,
  isCheckingQueue,
  onRestoreBatchBaseline,
  onCancelAndDeleteBatch,
  onRemoveBatchRow,
  onCancelQueuedMachine,
  t,
}: DeploymentBatchCardProps) {
  const syncedCount = batch.machines.filter(
    (m) => !m.hasPendingCmdStack && Boolean(m.syncedAtIso)
  ).length;
  const totalCount = batch.machines.length;
  const graceRemainingSec =
    batch.backupCleanupStatus === BackupCleanupStatus.WaitingDownloadGrace &&
    batch.allMachinesSyncedAtIso
      ? Math.max(
          0,
          Math.ceil(
            (BACKUP_DOWNLOAD_GRACE_MS -
              (Date.now() - Date.parse(batch.allMachinesSyncedAtIso))) /
              1000
          )
        )
      : 0;
  const hasBaseline = Boolean(
    batch.baselineLayoutsByMachineId && Object.keys(batch.baselineLayoutsByMachineId).length > 0
  );

  return (
    <div className="queue-batch-card">
      <div className="queue-batch-header">
        <div className="queue-batch-meta">
          <strong style={{ fontSize: '0.84rem' }} title={`Package: ${batch.zipFileName}`}>
            {batch.groupLabel}
          </strong>
          <span style={{ fontSize: '0.74rem', color: 'var(--text-muted)' }}>
            ({syncedCount}/{totalCount} synced)
          </span>
        </div>

        <div className="queue-batch-actions">
          {batch.backupCleanupStatus === BackupCleanupStatus.Deleted ? (
            <span
              className="validation-pill valid-ok"
              style={{ fontSize: '0.74rem' }}
              title={`Cleaned up archive: ${batch.zipFileName}`}
            >
              ✓ {t('backupStatusDeleted')}
              {batch.backupDeletedAtIso
                ? ` (${new Date(batch.backupDeletedAtIso).toLocaleTimeString()})`
                : ''}
            </span>
          ) : batch.backupCleanupStatus === BackupCleanupStatus.WaitingDownloadGrace ? (
            <span
              className="sync-badge sync-pending"
              style={{ fontSize: '0.74rem' }}
              title={`Pending cleanup of ${batch.zipFileName}`}
            >
              ⏳ {t('backupStatusWaitingGrace')}{' '}
              {graceRemainingSec > 0 ? `(${graceRemainingSec}s)` : ''}
            </span>
          ) : batch.backupCleanupStatus === BackupCleanupStatus.DeleteFailed ? (
            <span
              className="validation-pill valid-err"
              style={{ fontSize: '0.74rem' }}
              title={`Failed deleting ${batch.zipFileName}`}
            >
              ⚠ {t('backupStatusDeleteFailed')}
            </span>
          ) : (
            <span
              className="sync-badge sync-pending"
              style={{ fontSize: '0.74rem' }}
              title={`Waiting on machines for ${batch.zipFileName}`}
            >
              ⏳ {t('backupStatusWaitingQueue')} ({totalCount - syncedCount} remaining)
            </span>
          )}

          {hasBaseline && (
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              style={{ padding: '0.16rem 0.45rem', fontSize: '0.72rem' }}
              onClick={() => onRestoreBatchBaseline(batch)}
            >
              ↩ {t('offlineQueueRestoreBaselineBtn')}
            </button>
          )}

          {batch.backupCleanupStatus !== BackupCleanupStatus.Deleted ? (
            <button
              type="button"
              className="btn btn-secondary btn-sm btn-danger-outline"
              disabled={isCheckingQueue}
              onClick={() => onCancelAndDeleteBatch(batch)}
            >
              🗑 {t('offlineQueueDeleteBatchBtn')}
            </button>
          ) : (
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              style={{ padding: '0.16rem 0.45rem', fontSize: '0.72rem' }}
              onClick={() => onRemoveBatchRow(batch.batchId)}
            >
              ✕ {t('offlineQueueRemoveHistoryBtn')}
            </button>
          )}
        </div>
      </div>

      <div className="queue-machine-chips">
        {batch.machines.map((item) => {
          const liveMachine = machines.find((m) => m.id === item.machineId);
          const isOnlineNow = liveMachine ? liveMachine.cmConnected : item.cmConnected;
          const isPending = item.hasPendingCmdStack || !item.syncedAtIso;

          return (
            <div
              key={`${batch.batchId}-${item.machineId}`}
              className={`queue-machine-chip ${isPending ? 'queue-machine-chip-pending' : ''}`}
            >
              <span style={{ fontWeight: 600 }}>{item.machineLabel}</span>
              <span
                style={{
                  color: isOnlineNow ? 'var(--status-green)' : 'var(--text-muted)',
                  fontWeight: 600,
                }}
              >
                {isOnlineNow ? `● ${t('statusOnline')}` : `○ ${t('statusOffline')}`}
              </span>
              <span
                style={{
                  color: isPending ? '#b45309' : 'var(--status-green)',
                  fontWeight: 600,
                }}
              >
                {isPending
                  ? isOnlineNow && item.lastRpcAttemptAtIso
                    ? `⏳ ${t('offlineQueueVerifyingBadge')}`
                    : `⏳ ${t('offlineQueueQueuedBadge')}`
                  : item.confirmedByConfigJson
                    ? `✓ ${t('offlineQueueConfirmedConfigBadge')}`
                    : item.deliveryMode === 'online_rpc'
                      ? '✓ Applied (MQTT RPC)'
                      : '✓ Picked up & Synced'}
              </span>
              {isPending && (
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  style={{ padding: '0.1rem 0.35rem', fontSize: '0.7rem' }}
                  disabled={isCheckingQueue}
                  onClick={() =>
                    onCancelQueuedMachine(batch.batchId, item.machineId, batch.zipFileName)
                  }
                >
                  ✕ {t('offlineQueueCancelItemBtn')}
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Step 2d Panel 3: Offline Sync Queue & Backup Cleanup panel.
 * Displays active/pending deployment batches prominently at the top and collapses
 * completed (`Deleted`) batches under a toggleable summary.
 */
export function OfflineQueuePanel({
  deploymentBatches,
  machines,
  isCheckingQueue,
  onCheckQueueNow,
  onClearCompletedBatches,
  onRestoreBatchBaseline,
  onCancelAndDeleteBatch,
  onRemoveBatchRow,
  onCancelQueuedMachine,
  t,
}: OfflineQueuePanelProps) {
  const [showCompleted, setShowCompleted] = useState(false);

  const { activeBatches, completedBatches, pendingOfflineCount } = useMemo(() => {
    const active: TrackedDeploymentBatch[] = [];
    const completed: TrackedDeploymentBatch[] = [];
    let pending = 0;

    for (const batch of deploymentBatches) {
      if (batch.backupCleanupStatus === BackupCleanupStatus.Deleted) {
        completed.push(batch);
      } else {
        active.push(batch);
        pending += batch.machines.filter((m) => m.hasPendingCmdStack || !m.syncedAtIso).length;
      }
    }

    return {
      activeBatches: active,
      completedBatches: completed,
      pendingOfflineCount: pending,
    };
  }, [deploymentBatches]);

  return (
    <section className="panel" aria-label={t('offlineQueueTitle')}>
      <div className="panel-header" style={{ flexWrap: 'wrap' }}>
        <div>
          <h2 style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
            <span>{t('offlineQueueTitle')}</span>
            {pendingOfflineCount > 0 ? (
              <span className="sync-badge sync-pending">
                {pendingOfflineCount} offline machine(s) queued
              </span>
            ) : (
              <span className="sync-badge sync-synced">0 pending</span>
            )}
          </h2>
          <p className="panel-desc">{t('offlineQueueDesc')}</p>
        </div>

        <div style={{ display: 'flex', gap: '0.45rem', flexWrap: 'wrap' }}>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={isCheckingQueue}
            onClick={onCheckQueueNow}
          >
            {isCheckingQueue ? 'Checking...' : `↻ ${t('offlineQueueCheckNowBtn')}`}
          </button>
          {completedBatches.length > 0 && (
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={onClearCompletedBatches}
            >
              {t('offlineQueueClearHistoryBtn')}
            </button>
          )}
        </div>
      </div>

      {deploymentBatches.length === 0 ? (
        <div className="queue-empty-box">{t('offlineQueueEmpty')}</div>
      ) : (
        <div className="queue-batch-list">
          {activeBatches.map((batch) => (
            <DeploymentBatchCard
              key={batch.batchId}
              batch={batch}
              machines={machines}
              isCheckingQueue={isCheckingQueue}
              onRestoreBatchBaseline={onRestoreBatchBaseline}
              onCancelAndDeleteBatch={onCancelAndDeleteBatch}
              onRemoveBatchRow={onRemoveBatchRow}
              onCancelQueuedMachine={onCancelQueuedMachine}
              t={t}
            />
          ))}

          {completedBatches.length > 0 && (
            <div
              className={`completed-batches-section ${
                activeBatches.length > 0 ? 'completed-batches-section-divided' : ''
              }`}
            >
              <button
                type="button"
                className={`btn btn-secondary btn-sm completed-batches-toggle ${
                  showCompleted ? 'completed-batches-toggle-open' : ''
                }`}
                aria-expanded={showCompleted}
                onClick={() => setShowCompleted((prev) => !prev)}
              >
                <span>{showCompleted ? '▾' : '▸'}</span>
                <span>Completed Deployments ({completedBatches.length})</span>
              </button>

              {showCompleted && (
                <div className="queue-batch-list">
                  {completedBatches.map((batch) => (
                    <DeploymentBatchCard
                      key={batch.batchId}
                      batch={batch}
                      machines={machines}
                      isCheckingQueue={isCheckingQueue}
                      onRestoreBatchBaseline={onRestoreBatchBaseline}
                      onCancelAndDeleteBatch={onCancelAndDeleteBatch}
                      onRemoveBatchRow={onRemoveBatchRow}
                      onCancelQueuedMachine={onCancelQueuedMachine}
                      t={t}
                    />
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
