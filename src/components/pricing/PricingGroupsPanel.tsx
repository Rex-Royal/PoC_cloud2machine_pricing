'use client';

import React, { useState } from 'react';
import { evaluateGroupOnlineReadiness } from '#firmware-core';
import type { TranslationKey } from '../../i18n/translations.ts';
import type {
  FleetMachine,
  LayoutCluster,
  MachineLayout,
  ScheduledPricingJob,
} from '#firmware-core';

function getMachineLabel(m: FleetMachine): string {
  return (
    [m.serialNumber, m.name].filter(Boolean).join(' · ') ||
    `${m.modelTypeDisplay} (${m.id.slice(0, 6)})`
  );
}

export interface PricingGroupCluster extends LayoutCluster {
  readonly hasLayoutMismatch: boolean;
  readonly mismatchByMachineId: Readonly<Record<string, string>>;
}

export interface GroupScheduleState {
  readonly enabled: boolean;
  readonly runAtLocal: string;
  readonly savedJob: ScheduledPricingJob | null;
}

export interface PricingGroupsPanelProps {
  clusters: readonly PricingGroupCluster[];
  selectedMachinesCount: number;
  activeClusterIndex: number;
  isLoadingConfigs: boolean;
  onSelectCluster: (index: number) => void;
  onMoveMachineToGroup: (machineId: string, targetGroupKey: string, targetIndex: number) => void;
  onMoveMachineToNewGroup: (machineId: string) => void;
  onSyncPriceLists: () => void;
  onBackToFleet?: () => void;
  getEffectiveMachineLayout: (machine: FleetMachine) => MachineLayout;
  getGroupScheduleState: (cluster: PricingGroupCluster) => GroupScheduleState;
  onToggleGroupSchedule: (cluster: PricingGroupCluster, index: number, enabled: boolean) => void;
  onChangeGroupScheduleTime: (cluster: PricingGroupCluster, index: number, nextLocal: string) => void;
  t: (key: TranslationKey) => string;
}

/**
 * Step 2b Panel 1: Drag-and-drop Pricing Groups cards with machine readiness badges,
 * manual group reassignment / "+ New Group", single group-sync action, and per-group Schedule toggle.
 */
export function PricingGroupsPanel({
  clusters,
  selectedMachinesCount,
  activeClusterIndex,
  isLoadingConfigs,
  onSelectCluster,
  onMoveMachineToGroup,
  onMoveMachineToNewGroup,
  onSyncPriceLists,
  onBackToFleet,
  getEffectiveMachineLayout,
  getGroupScheduleState,
  onToggleGroupSchedule,
  onChangeGroupScheduleTime,
  t,
}: PricingGroupsPanelProps) {
  const [draggedMachineId, setDraggedMachineId] = useState<string | null>(null);
  const [dragOverGroupKey, setDragOverGroupKey] = useState<string | null>(null);

  const safeActiveIndex = activeClusterIndex < clusters.length ? activeClusterIndex : 0;
  const hasAnyActiveSchedule = clusters.some(
    (cluster) => !cluster.hasLayoutMismatch && getGroupScheduleState(cluster).enabled
  );

  return (
    <section className="panel">
      <div className="panel-header" style={{ flexWrap: 'wrap' }}>
        <div>
          <h2>Pricing Groups ({selectedMachinesCount} Machines)</h2>
          <p className="panel-desc">
            Each group is verified against the machine&apos;s current price list &amp; layout (
            <code>rows × columns × categories</code> + product slots). Drag a machine to{' '}
            <strong>+ New Group</strong> to separate incompatible layouts.
          </p>
        </div>

        <div style={{ display: 'flex', gap: '0.45rem', flexWrap: 'wrap' }}>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={isLoadingConfigs || selectedMachinesCount === 0}
            onClick={onSyncPriceLists}
            title="Reload current price list and layout for all selected machines"
          >
            {isLoadingConfigs ? 'Loading...' : '↻ Sync Current Price Lists'}
          </button>
          {onBackToFleet && (
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={onBackToFleet}
            >
              + Select Machines
            </button>
          )}
        </div>
      </div>

      {hasAnyActiveSchedule && (
        <div role="note" className="schedule-warning-note">
          ⏱ {t('scheduleBrowserPocWarning')}
        </div>
      )}

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
          gap: '0.85rem',
          alignItems: 'stretch',
        }}
      >
        {clusters.map((cluster, idx) => {
          const isActive = idx === safeActiveIndex;
          const isDragTarget = dragOverGroupKey === cluster.layoutKey;
          const groupSchedule = getGroupScheduleState(cluster);
          const groupReadiness = evaluateGroupOnlineReadiness(cluster.machines);

          return (
            <div
              id={`pricing-group-card-${cluster.layoutKey}`}
              key={cluster.layoutKey}
              onClick={() => onSelectCluster(idx)}
              onDragOver={(e) => {
                e.preventDefault();
                setDragOverGroupKey(cluster.layoutKey);
              }}
              onDragLeave={() => {
                if (dragOverGroupKey === cluster.layoutKey) {
                  setDragOverGroupKey(null);
                }
              }}
              onDrop={(e) => {
                e.preventDefault();
                setDragOverGroupKey(null);
                const droppedId = draggedMachineId || e.dataTransfer.getData('text/plain');
                if (droppedId) {
                  onMoveMachineToGroup(droppedId, cluster.layoutKey, idx);
                  setDraggedMachineId(null);
                }
              }}
              style={{
                padding: '0.85rem',
                borderRadius: '6px',
                cursor: 'pointer',
                background: isDragTarget
                  ? 'rgba(37, 99, 235, 0.06)'
                  : cluster.hasLayoutMismatch
                    ? 'rgba(220, 38, 38, 0.04)'
                    : 'var(--bg-surface)',
                border: cluster.hasLayoutMismatch
                  ? '2px solid var(--status-red)'
                  : isActive
                    ? '2px solid var(--text-primary)'
                    : '1px solid var(--border-color)',
                display: 'flex',
                flexDirection: 'column',
                gap: '0.6rem',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  gap: '0.5rem',
                }}
              >
                <strong style={{ fontSize: '0.92rem' }}>Group {idx + 1}</strong>
                {cluster.hasLayoutMismatch ? (
                  <span className="validation-pill valid-err">✗ Layout Mismatch</span>
                ) : (
                  <span className="validation-pill valid-ok">
                    ✓ {cluster.rows}×{cluster.columns} · {cluster.categories} cat (
                    {cluster.referenceLayout.products.length} products)
                  </span>
                )}
              </div>

              {cluster.hasLayoutMismatch && (
                <div
                  style={{
                    fontSize: '0.78rem',
                    color: 'var(--status-red)',
                    fontWeight: 600,
                    padding: '0.4rem 0.55rem',
                    background: 'rgba(220, 38, 38, 0.08)',
                    borderRadius: '4px',
                  }}
                >
                  Cannot group machines with different layouts. Every machine in a group must match{' '}
                  <code>rows × columns × categories</code> and product slots. Drag a machine to{' '}
                  <strong>+ New Group</strong>.
                </div>
              )}

              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.45rem' }}>
                {cluster.machines.map((m) => {
                  const mLayout =
                    m.layout || m.rawConfigJson ? getEffectiveMachineLayout(m) : null;
                  const mismatchReason = cluster.mismatchByMachineId?.[m.id];
                  const isMismatchInGroup = Boolean(mismatchReason);
                  const machineLabel = getMachineLabel(m);

                  return (
                    <div
                      key={m.id}
                      draggable
                      onDragStart={(e) => {
                        e.dataTransfer.effectAllowed = 'move';
                        e.dataTransfer.setData('text/plain', m.id);
                        setDraggedMachineId(m.id);
                      }}
                      onDragEnd={() => {
                        setDraggedMachineId(null);
                        setDragOverGroupKey(null);
                      }}
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        gap: '0.5rem',
                        padding: '0.5rem 0.65rem',
                        background: 'var(--bg-subtle)',
                        border: isMismatchInGroup
                          ? '1px solid var(--status-red)'
                          : '1px solid var(--border-color)',
                        borderRadius: '4px',
                        cursor: 'grab',
                      }}
                    >
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: '0.45rem',
                          minWidth: 0,
                        }}
                      >
                        <span
                          style={{
                            color: 'var(--text-muted)',
                            fontSize: '0.9rem',
                            userSelect: 'none',
                          }}
                          title="Drag to move to another group"
                        >
                          ⠿
                        </span>
                        <div style={{ minWidth: 0 }}>
                          <div
                            style={{
                              fontWeight: 600,
                              fontSize: '0.82rem',
                              whiteSpace: 'nowrap',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                            }}
                          >
                            {machineLabel}
                          </div>
                          <div
                            style={{
                              fontSize: '0.72rem',
                              color: isMismatchInGroup
                                ? 'var(--status-red)'
                                : 'var(--text-muted)',
                              fontWeight: isMismatchInGroup ? 600 : 400,
                              display: 'flex',
                              flexWrap: 'wrap',
                              alignItems: 'center',
                              gap: '0.35rem',
                            }}
                          >
                            <span>
                              {mLayout
                                ? `${mLayout.rows}×${mLayout.columns} · ${mLayout.categories} cat · ${mLayout.products.length} products`
                                : 'Loading...'}
                            </span>
                            <span>·</span>
                            <span
                              style={{
                                color: m.cmConnected ? 'var(--status-green)' : '#b45309',
                                fontWeight: 600,
                              }}
                              title={
                                m.cmConnected
                                  ? 'Machine is online and ready for immediate updates'
                                  : 'Machine is offline; updates are queued via cloud command stack (cmdStack.json) until reconnect'
                              }
                            >
                              {m.cmConnected
                                ? `● ${t('statusOnline')}`
                                : `○ ${t('statusOffline')} · ${t('offlineReadyBadge')}`}
                            </span>
                          </div>
                          {mismatchReason && (
                            <div
                              style={{
                                fontSize: '0.7rem',
                                color: 'var(--status-red)',
                                fontWeight: 600,
                                marginTop: '0.15rem',
                              }}
                            >
                              ✗ {mismatchReason}
                            </div>
                          )}
                        </div>
                      </div>

                      <div
                        style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', flexShrink: 0 }}
                        onClick={(e) => e.stopPropagation()}
                      >
                        {clusters.length > 1 && (
                          <select
                            className="select-control"
                            aria-label={`Move ${machineLabel} to group`}
                            value={cluster.layoutKey}
                            onChange={(e) => {
                              const nextKey = e.target.value;
                              if (nextKey === '__NEW__') {
                                onMoveMachineToNewGroup(m.id);
                                return;
                              }
                              const targetIdx = clusters.findIndex((c) => c.layoutKey === nextKey);
                              if (targetIdx !== -1 && targetIdx !== idx) {
                                onMoveMachineToGroup(m.id, nextKey, targetIdx);
                              }
                            }}
                            style={{ padding: '0.18rem 0.35rem', fontSize: '0.72rem' }}
                          >
                            {clusters.map((targetCluster, targetIdx) => (
                              <option key={targetCluster.layoutKey} value={targetCluster.layoutKey}>
                                Group {targetIdx + 1}
                              </option>
                            ))}
                            {cluster.machines.length > 1 && (
                              <option value="__NEW__">+ New Group</option>
                            )}
                          </select>
                        )}
                        {cluster.machines.length > 1 && (
                          <button
                            type="button"
                            className="btn btn-secondary btn-sm"
                            onClick={() => onMoveMachineToNewGroup(m.id)}
                            title="Move machine to a new group"
                          >
                            → New Group
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Streamlined Per-Group Schedule Toggle */}
              {!cluster.hasLayoutMismatch && (
                <div
                  onClick={(e) => e.stopPropagation()}
                  style={{
                    marginTop: '0.1rem',
                    paddingTop: '0.5rem',
                    borderTop: '1px solid var(--border-color)',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '0.35rem',
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '0.5rem',
                      minWidth: 0,
                    }}
                  >
                    <label
                      className="checkbox-inline"
                      style={{
                        marginLeft: 0,
                        fontSize: '0.78rem',
                        fontWeight: 600,
                        flexShrink: 0,
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={groupSchedule.enabled}
                        onChange={(e) =>
                          onToggleGroupSchedule(cluster, idx, e.target.checked)
                        }
                      />
                      <span>⏱ {t('groupScheduleToggle')}</span>
                    </label>

                    {groupSchedule.enabled && (
                      <input
                        type="datetime-local"
                        aria-label={`Schedule date and time for Group ${idx + 1}`}
                        value={groupSchedule.runAtLocal}
                        onChange={(e) =>
                          onChangeGroupScheduleTime(cluster, idx, e.target.value)
                        }
                        style={{
                          flex: 1,
                          minWidth: 0,
                          width: '100%',
                          fontSize: '0.76rem',
                          padding: '0.24rem 0.4rem',
                        }}
                      />
                    )}
                  </div>

                  {groupSchedule.enabled && groupSchedule.savedJob && (
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        flexWrap: 'wrap',
                        gap: '0.35rem',
                        fontSize: '0.72rem',
                      }}
                    >
                      <span style={{ color: 'var(--status-green)', fontWeight: 600 }}>
                        ✓ {t('scheduledForBadge')}{' '}
                        {new Date(groupSchedule.savedJob.startAtIso).toLocaleString([], {
                          month: 'short',
                          day: 'numeric',
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </span>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
                        {!groupReadiness.allOnline && (
                          <span style={{ color: '#b45309', fontWeight: 600 }}>
                            ⚠ {groupReadiness.offlineCount}/{groupReadiness.totalCount} offline
                          </span>
                        )}
                        <button
                          type="button"
                          className="btn btn-secondary btn-sm"
                          style={{ padding: '0.08rem 0.35rem', fontSize: '0.68rem' }}
                          onClick={() => onToggleGroupSchedule(cluster, idx, false)}
                        >
                          ✕ {t('scheduleDeleteBtn')}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}

        {/* + New Group Drop Target */}
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragOverGroupKey('NEW_GROUP');
          }}
          onDragLeave={() => {
            if (dragOverGroupKey === 'NEW_GROUP') {
              setDragOverGroupKey(null);
            }
          }}
          onDrop={(e) => {
            e.preventDefault();
            setDragOverGroupKey(null);
            const droppedId = draggedMachineId || e.dataTransfer.getData('text/plain');
            if (droppedId) {
              onMoveMachineToNewGroup(droppedId);
              setDraggedMachineId(null);
            }
          }}
          style={{
            minHeight: '120px',
            padding: '1rem',
            borderRadius: '6px',
            border:
              dragOverGroupKey === 'NEW_GROUP'
                ? '2px dashed var(--text-primary)'
                : '2px dashed var(--border-strong)',
            background:
              dragOverGroupKey === 'NEW_GROUP' ? 'rgba(37, 99, 235, 0.06)' : 'transparent',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            textAlign: 'center',
            color: 'var(--text-secondary)',
            gap: '0.25rem',
          }}
        >
          <strong style={{ fontSize: '0.92rem' }}>+ New Group</strong>
          <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>
            Drag &amp; drop a machine here to create a new layout group
          </span>
        </div>
      </div>
    </section>
  );
}
