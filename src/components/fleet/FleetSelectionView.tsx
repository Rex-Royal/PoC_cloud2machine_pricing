'use client';

import React, { useEffect, useMemo, useState } from 'react';
import type { TranslationKey } from '../../i18n/translations.ts';
import { ALL_CUSTOMERS_ID } from '#fleet-sync';
import {
  MachineSyncState,
  type CustomerOption,
  type DeviceGroup,
  type FleetMachine,
} from '#firmware-core';
import { CustomerCombobox } from './CustomerCombobox.tsx';

function getMachineLabel(m: FleetMachine): string {
  return (
    [m.serialNumber, m.name].filter(Boolean).join(' · ') ||
    `${m.modelTypeDisplay} (${m.id.slice(0, 6)})`
  );
}

function getSyncBadgeClass(syncState?: MachineSyncState): string {
  if (syncState === MachineSyncState.Pending) return 'sync-pending';
  if (syncState === MachineSyncState.Failed) return 'sync-failed';
  if (syncState === MachineSyncState.Desync) return 'sync-desync';
  return 'sync-synced';
}

export interface FleetSelectionViewProps {
  customers: readonly CustomerOption[];
  selectedCustomerId: string;
  onSelectCustomer: (customerId: string) => void;
  groups: readonly DeviceGroup[];
  selectedGroupId: string;
  onSelectGroup: (groupId: string) => void;
  fleetStatusMessage?: string;
  filteredMachines: readonly FleetMachine[];
  selectedMachines: readonly FleetMachine[];
  selectedMachineIds: ReadonlySet<string>;
  machineStatesById: Readonly<Record<string, MachineSyncState>>;
  machineFilterText: string;
  onMachineFilterTextChange: (value: string) => void;
  hideUnconfiguredDevices: boolean;
  onHideUnconfiguredDevicesChange: (checked: boolean) => void;
  isLoadingFleet: boolean;
  isLoadingConfigs: boolean;
  onRefreshFleet: () => void;
  onToggleMachineSelection: (machineId: string) => void;
  onSelectAllFiltered: (checked: boolean) => void;
  onClearSelection?: () => void;
  onLoadSingleMachineConfig: (machine: FleetMachine) => void;
  onImportMachineConfig: (machineId: string) => void;
  onProceedToPricing: () => void;
  t: (key: TranslationKey) => string;
}

/**
 * Step 1 View: Customer/Group scope selector, search & filter controls,
 * quick-selection chips, paginated Fleet Selection Table, and single primary CTA to Step 2.
 */
export function FleetSelectionView({
  customers,
  selectedCustomerId,
  onSelectCustomer,
  groups,
  selectedGroupId,
  onSelectGroup,
  fleetStatusMessage,
  filteredMachines,
  selectedMachines,
  selectedMachineIds,
  machineStatesById,
  machineFilterText,
  onMachineFilterTextChange,
  hideUnconfiguredDevices,
  onHideUnconfiguredDevicesChange,
  isLoadingFleet,
  isLoadingConfigs,
  onRefreshFleet,
  onToggleMachineSelection,
  onSelectAllFiltered,
  onClearSelection,
  onLoadSingleMachineConfig,
  onImportMachineConfig,
  onProceedToPricing,
  t,
}: FleetSelectionViewProps) {
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);

  useEffect(() => {
    setCurrentPage(1);
  }, [selectedCustomerId, selectedGroupId, machineFilterText, hideUnconfiguredDevices]);

  const totalFilteredMachines = filteredMachines.length;
  const totalPages = Math.max(1, Math.ceil(totalFilteredMachines / pageSize));
  const safeCurrentPage = Math.min(currentPage, totalPages);
  const pageStartIndex = (safeCurrentPage - 1) * pageSize;
  const pageEndIndex = Math.min(pageStartIndex + pageSize, totalFilteredMachines);

  const paginatedMachines = useMemo(
    () => filteredMachines.slice(pageStartIndex, pageEndIndex),
    [filteredMachines, pageStartIndex, pageEndIndex]
  );

  const onlineFilteredCount = useMemo(
    () => filteredMachines.filter((m) => m.cmConnected).length,
    [filteredMachines]
  );

  const allFilteredSelected =
    filteredMachines.length > 0 &&
    filteredMachines.every((m) => selectedMachineIds.has(m.id));

  const handleClearAll = () => {
    if (onClearSelection) {
      onClearSelection();
    } else {
      onSelectAllFiltered(false);
    }
  };

  return (
    <>
      {/* Customer & Machine Group Scope Selector */}
      <section className="panel">
        <div className="scope-toolbar">
          <div className="form-field">
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                gap: '0.5rem',
              }}
            >
              <label htmlFor="customer-combobox-input" style={{ marginBottom: 0 }}>
                {t('customerSelectLabel')}{' '}
                <span style={{ fontWeight: 400, color: 'var(--text-muted)' }}>
                  ({customers.length} {t('customersAvailableCount')})
                </span>
              </label>
              {selectedCustomerId !== ALL_CUSTOMERS_ID && (
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => onSelectCustomer(ALL_CUSTOMERS_ID)}
                  title="Load and search across all customers in the fleet"
                >
                  ★ Search All Customers (Entire Fleet)
                </button>
              )}
            </div>

            <CustomerCombobox
              customers={customers}
              selectedCustomerId={selectedCustomerId}
              onSelectCustomer={onSelectCustomer}
              t={t}
            />
          </div>

          {groups.length > 0 && (
            <div className="form-field">
              <label htmlFor="group-select">{t('fleetGroupSelect')}</label>
              <select
                id="group-select"
                className="select-control"
                value={selectedGroupId}
                disabled={isLoadingFleet}
                onChange={(e) => onSelectGroup(e.target.value)}
              >
                <option value="ALL">{t('allMachinesGroup')}</option>
                {groups.map((g) => (
                  <option key={g.id?.id || g.name} value={g.id?.id}>
                    {g.name}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>

        {fleetStatusMessage && (
          <div
            style={{
              marginTop: '0.75rem',
              paddingTop: '0.65rem',
              borderTop: '1px solid var(--border-color)',
              fontSize: '0.82rem',
              color: 'var(--text-secondary)',
            }}
          >
            {fleetStatusMessage}
          </div>
        )}
      </section>

      {/* Paginated Machine Selection Table */}
      {selectedCustomerId && (
        <section className="panel">
          <div className="machines-toolbar">
            <div className="machines-toolbar-left">
              <h2>
                {t('machinesTitle')} ({totalFilteredMachines} ·{' '}
                <span style={{ color: 'var(--status-green)', fontWeight: 600 }}>
                  {onlineFilteredCount} {t('statusOnline')}
                </span>
                )
              </h2>

              <div className="machine-search-wrap">
                <input
                  id="machine-filter-input"
                  type="text"
                  className="machine-search-input"
                  aria-label={t('filterMachinesPlaceholder')}
                  placeholder={t('filterMachinesPlaceholder')}
                  value={machineFilterText}
                  onChange={(e) => onMachineFilterTextChange(e.target.value)}
                />
                {machineFilterText && (
                  <button
                    type="button"
                    className="machine-search-clear"
                    aria-label="Clear machine search"
                    onClick={() => onMachineFilterTextChange('')}
                  >
                    ✕
                  </button>
                )}
              </div>

              <label className="checkbox-inline" style={{ marginLeft: 0 }}>
                <input
                  type="checkbox"
                  checked={hideUnconfiguredDevices}
                  onChange={(e) => onHideUnconfiguredDevicesChange(e.target.checked)}
                />
                <span>{t('hideUnconfiguredLabel')}</span>
              </label>
            </div>

            <div className="machines-toolbar-right">
              <button
                type="button"
                className="btn btn-secondary"
                disabled={isLoadingFleet}
                onClick={onRefreshFleet}
                title="Refresh machine status"
              >
                ↻ Refresh
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={selectedMachineIds.size === 0 || isLoadingConfigs}
                onClick={onProceedToPricing}
              >
                {isLoadingConfigs
                  ? 'Loading...'
                  : `Next: Pricing Groups (${selectedMachineIds.size}) →`}
              </button>
            </div>
          </div>

          {selectedMachines.length > 0 && (
            <div
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                alignItems: 'center',
                gap: '0.45rem',
                padding: '0.55rem 0.75rem',
                marginBottom: '0.75rem',
                background: 'var(--bg-subtle)',
                border: '1px solid var(--border-color)',
                borderRadius: '4px',
              }}
            >
              <span
                style={{
                  fontSize: '0.78rem',
                  fontWeight: 600,
                  color: 'var(--text-secondary)',
                }}
              >
                Selected ({selectedMachines.length}):
              </span>
              {selectedMachines.map((m) => {
                const label = getMachineLabel(m);
                return (
                  <span
                    key={m.id}
                    className="slot-badge"
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: '0.35rem',
                      fontWeight: 600,
                      padding: '0.2rem 0.5rem',
                    }}
                  >
                    <span>{label}</span>
                    <button
                      type="button"
                      onClick={() => onToggleMachineSelection(m.id)}
                      aria-label={`Remove ${label}`}
                      style={{
                        border: 'none',
                        background: 'transparent',
                        cursor: 'pointer',
                        padding: 0,
                        fontSize: '0.78rem',
                        color: 'var(--text-muted)',
                      }}
                    >
                      ✕
                    </button>
                  </span>
                );
              })}
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={handleClearAll}
                style={{ marginLeft: 'auto' }}
              >
                Clear
              </button>
            </div>
          )}

          <div className="table-container" style={{ marginBottom: 0 }}>
            <table>
              <thead>
                <tr>
                  <th scope="col" style={{ width: '42px' }}>
                    <input
                      type="checkbox"
                      aria-label="Select all machines"
                      checked={allFilteredSelected}
                      onChange={(e) => onSelectAllFiltered(e.target.checked)}
                    />
                  </th>
                  <th scope="col">{t('colSerialNumber')}</th>
                  <th scope="col">{t('colMachineName')}</th>
                  <th scope="col">{t('colModelType')}</th>
                  <th scope="col">{t('colLocation')}</th>
                  <th scope="col">{t('colConnection')}</th>
                  <th scope="col">{t('colConfiguration')}</th>
                </tr>
              </thead>
              <tbody>
                {paginatedMachines.length === 0 ? (
                  <tr>
                    <td
                      colSpan={7}
                      style={{
                        textAlign: 'center',
                        padding: '1.25rem',
                        color: 'var(--text-muted)',
                      }}
                    >
                      {isLoadingFleet ? (
                        t('loadingMachines')
                      ) : (
                        <div
                          style={{
                            display: 'flex',
                            flexDirection: 'column',
                            alignItems: 'center',
                            gap: '0.6rem',
                          }}
                        >
                          <span>{t('noMachinesMatch')}</span>
                          {selectedCustomerId !== ALL_CUSTOMERS_ID && (
                            <button
                              type="button"
                              className="btn btn-primary btn-sm"
                              onClick={() => onSelectCustomer(ALL_CUSTOMERS_ID)}
                            >
                              ★ Search {machineFilterText ? `"${machineFilterText}"` : 'All Machines'}{' '}
                              Across All Customers (Entire Fleet) →
                            </button>
                          )}
                        </div>
                      )}
                    </td>
                  </tr>
                ) : (
                  paginatedMachines.map((m) => {
                    const isChecked = selectedMachineIds.has(m.id);
                    const syncState = machineStatesById[m.id];
                    const mLayout = m.layout;
                    const machineLabel = getMachineLabel(m);
                    return (
                      <tr
                        key={m.id}
                        onClick={() => onToggleMachineSelection(m.id)}
                        style={{ cursor: 'pointer' }}
                      >
                        <td onClick={(e) => e.stopPropagation()}>
                          <input
                            type="checkbox"
                            checked={isChecked}
                            onChange={() => onToggleMachineSelection(m.id)}
                            aria-label={`Select ${machineLabel}`}
                          />
                        </td>
                        <td style={{ fontWeight: 600, fontFamily: 'var(--font-mono)' }}>
                          {m.serialNumber || '—'}
                        </td>
                        <td>
                          <div>
                            {m.name || (
                              <span style={{ color: 'var(--text-muted)' }}>
                                Unconfigured ({m.id.slice(0, 8)})
                              </span>
                            )}
                          </div>
                          {m.customerName && (
                            <div
                              style={{
                                fontSize: '0.72rem',
                                color: 'var(--text-muted)',
                                marginTop: '0.1rem',
                              }}
                            >
                              Customer: {m.customerName}
                            </div>
                          )}
                        </td>
                        <td>{m.modelTypeDisplay}</td>
                        <td>{m.location || '—'}</td>
                        <td>
                          <span
                            className={`conn-dot ${m.cmConnected ? 'dot-online' : 'dot-offline'}`}
                          >
                            {m.cmConnected
                              ? `● ${t('statusOnline')}`
                              : `○ ${t('statusOffline')}`}
                          </span>
                        </td>
                        <td onClick={(e) => e.stopPropagation()}>
                          <div
                            style={{
                              display: 'flex',
                              flexWrap: 'wrap',
                              alignItems: 'center',
                              gap: '0.45rem',
                            }}
                          >
                            {mLayout ? (
                              <>
                                <span
                                  className="slot-badge"
                                  style={{ fontWeight: 600, color: 'var(--text-primary)' }}
                                >
                                  {mLayout.rows}×{mLayout.columns} · {mLayout.categories}{' '}
                                  {t('categoriesCountLabel')} · {mLayout.products.length}{' '}
                                  {t('recipesCountLabel')}
                                </span>
                                <span className={`sync-badge ${getSyncBadgeClass(syncState)}`}>
                                  {syncState
                                    ? t(`syncState_${syncState}`)
                                    : m.configSource === 'sample'
                                      ? 'Sample Layout'
                                      : !m.cmConnected && m.configSource === 'ftp'
                                        ? t('offlineReadyBadge')
                                        : t('configLoaded')}
                                </span>
                              </>
                            ) : m.configSource === 'unavailable' ? (
                              <>
                                <span
                                  className="validation-pill valid-err"
                                  style={{ fontSize: '0.72rem' }}
                                  title={t('offlineUnavailableDesc')}
                                >
                                  ⚠{' '}
                                  {m.unavailableReason === 'offline_no_ftp_data' || !m.cmConnected
                                    ? t('offlineNoFtpBadge')
                                    : t('onlineNoFtpBadge')}
                                </span>
                                <button
                                  type="button"
                                  className="btn btn-secondary btn-sm"
                                  disabled={isLoadingConfigs}
                                  onClick={() => onLoadSingleMachineConfig(m)}
                                  title={t('recheckStatusBtn')}
                                >
                                  ↻ {t('recheckStatusBtn')}
                                </button>
                              </>
                            ) : (
                              <button
                                type="button"
                                className="btn btn-primary btn-sm"
                                disabled={isLoadingConfigs}
                                onClick={() => onLoadSingleMachineConfig(m)}
                              >
                                {t('loadMachineBtn')}
                              </button>
                            )}
                            <button
                              type="button"
                              className="btn btn-secondary btn-sm"
                              onClick={() => onImportMachineConfig(m.id)}
                            >
                              {t('importFileBtn')}
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>

          {/* Pagination Footer Bar */}
          <div className="pagination-bar">
            <div className="pagination-info">
              <span>
                {t('paginationShowing')}{' '}
                <strong>
                  {totalFilteredMachines === 0 ? 0 : pageStartIndex + 1}–{pageEndIndex}
                </strong>{' '}
                {t('paginationOf')} <strong>{totalFilteredMachines}</strong>{' '}
                {t('clusterMachinesCount')}
              </span>
              <span>·</span>
              <span>
                <strong>{selectedMachineIds.size}</strong> {t('paginationSelected')}
              </span>
            </div>

            <div className="pagination-controls">
              <label htmlFor="page-size-select" style={{ fontSize: '0.78rem' }}>
                {t('rowsPerPageLabel')}
              </label>
              <select
                id="page-size-select"
                className="select-control"
                style={{ padding: '0.25rem 0.45rem', fontSize: '0.78rem' }}
                value={pageSize}
                onChange={(e) => {
                  setPageSize(Number(e.target.value));
                  setCurrentPage(1);
                }}
              >
                {[10, 25, 50, 100].map((size) => (
                  <option key={size} value={size}>
                    {size}
                  </option>
                ))}
              </select>

              <button
                type="button"
                className="btn btn-secondary btn-sm"
                disabled={safeCurrentPage <= 1}
                onClick={() => setCurrentPage(1)}
                aria-label="First page"
              >
                «
              </button>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                disabled={safeCurrentPage <= 1}
                onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
              >
                ‹ {t('paginationPrev')}
              </button>

              <span className="pagination-page-indicator">
                {t('paginationPage')} {safeCurrentPage} {t('paginationOf')} {totalPages}
              </span>

              <button
                type="button"
                className="btn btn-secondary btn-sm"
                disabled={safeCurrentPage >= totalPages}
                onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
              >
                {t('paginationNext')} ›
              </button>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                disabled={safeCurrentPage >= totalPages}
                onClick={() => setCurrentPage(totalPages)}
                aria-label="Last page"
              >
                »
              </button>
            </div>
          </div>
        </section>
      )}
    </>
  );
}
