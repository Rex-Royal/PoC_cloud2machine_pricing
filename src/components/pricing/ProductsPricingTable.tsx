'use client';

import React from 'react';
import { formatMinorPrice } from '#firmware-core';
import type { TranslationKey } from '../../i18n/translations.ts';
import type {
  FleetMachine,
  MachineLayout,
  PriceParamCode,
  ProductSlot,
} from '#firmware-core';
import type { PricingGroupCluster } from './PricingGroupsPanel.tsx';

function getMachineLabel(m: FleetMachine): string {
  return (
    [m.serialNumber, m.name].filter(Boolean).join(' · ') ||
    `${m.modelTypeDisplay} (${m.id.slice(0, 6)})`
  );
}

export interface DeployFeedback {
  readonly ok: boolean;
  readonly message: string;
}

export interface ProductsPricingTableProps {
  cluster: PricingGroupCluster;
  clusterIndex: number;
  editedLayout: MachineLayout;
  baselineLayout: MachineLayout | null;
  referenceMachine: FleetMachine | null;
  scheduleEnabled: boolean;
  deployFeedback?: DeployFeedback | null;
  isLoadingConfigs: boolean;
  isDispatching: boolean;
  onCellPriceChange: (slotId: number, paramCode: PriceParamCode, decimalText: string) => void;
  onResetPrices: () => void;
  onDeployCluster: () => void;
  onFetchClusterPriceList?: () => void;
  t: (key: TranslationKey) => string;
}

interface PriceCellProps {
  prod: ProductSlot;
  baseProd: ProductSlot | undefined;
  paramCode: PriceParamCode;
  ariaLabel: string;
  onChange: (slotId: number, paramCode: PriceParamCode, decimalText: string) => void;
}

function PriceCell({ prod, baseProd, paramCode, ariaLabel, onChange }: PriceCellProps) {
  const rawMinor = Number(prod.params[paramCode] ?? 0);
  const baseMinor = Number(baseProd?.params?.[paramCode] ?? rawMinor);
  const isModified = rawMinor !== baseMinor;

  return (
    <td className={isModified ? 'cell-modified' : ''}>
      <input
        type="number"
        step="0.05"
        min="0"
        className="price-input"
        aria-label={ariaLabel}
        value={formatMinorPrice(rawMinor)}
        onChange={(e) => onChange(prod.id, paramCode, e.target.value)}
      />
      {isModified && <span className="cell-was">was {formatMinorPrice(baseMinor)}</span>}
    </td>
  );
}

/**
 * Step 2c Panel 2: Products & Prices matrix table for the active Pricing Group,
 * supporting PL1 Single/Double edits, changed-cell highlights, Reset to Baseline, and Deploy.
 */
export function ProductsPricingTable({
  cluster,
  clusterIndex,
  editedLayout,
  baselineLayout,
  referenceMachine,
  scheduleEnabled,
  deployFeedback,
  isLoadingConfigs,
  isDispatching,
  onCellPriceChange,
  onResetPrices,
  onDeployCluster,
  onFetchClusterPriceList,
  t,
}: ProductsPricingTableProps) {
  const currency = referenceMachine?.currencySymbol || 'CHF';
  const hasSampleConfig = cluster.machines.some((m) => m.configSource === 'sample');

  return (
    <section className="panel">
      {cluster.hasLayoutMismatch ? (
        <div className="alert-error-box">
          ✗ Cannot edit or deploy prices for this group while it contains machines with different
          layouts. Drag one of the machines above to <strong>+ New Group</strong>.
        </div>
      ) : (
        <>
          <div className="panel-header" style={{ flexWrap: 'wrap' }}>
            <div>
              <h2>
                Products &amp; Prices — Group {clusterIndex + 1} ({cluster.rows}×{cluster.columns}{' '}
                · {cluster.categories} cat · {editedLayout.products.length} products)
              </h2>
              <p className="panel-desc">
                {cluster.machines.map((m) => getMachineLabel(m)).join(' · ')} · Layout signature{' '}
                <code>#{cluster.signatureHash}</code>
              </p>
            </div>

            <div
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                gap: '0.45rem',
                alignItems: 'center',
              }}
            >
              {deployFeedback && (
                <span className={`validation-pill ${deployFeedback.ok ? 'valid-ok' : 'valid-err'}`}>
                  {deployFeedback.message}
                </span>
              )}
              {onFetchClusterPriceList && (
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  disabled={isLoadingConfigs}
                  onClick={onFetchClusterPriceList}
                  title="Pull live price list from machine, update Config/config.json, and auto-delete temporary backup .zip"
                >
                  {isLoadingConfigs ? 'Fetching from machine...' : '↻ Fetch Current Price List'}
                </button>
              )}
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={onResetPrices}
              >
                Reset
              </button>
              <button
                type="button"
                className="btn btn-primary btn-sm"
                disabled={isDispatching}
                onClick={onDeployCluster}
              >
                {isDispatching
                  ? 'Deploying...'
                  : scheduleEnabled
                    ? `${t('saveAndDeployOnScheduleBtn')} (${cluster.machines.length})`
                    : `${t('saveAndDeployBtn')} (${cluster.machines.length})`}
              </button>
            </div>
          </div>

          {hasSampleConfig && (
            <div className="alert-warning-box">
              <strong>Note:</strong> Live recipe configuration was not found on the file server yet.
              Use <strong>Fetch Current Price List</strong> above to pull the current layout from
              the machine.
            </div>
          )}

          <div className="table-container" style={{ marginBottom: 0 }}>
            <table>
              <thead>
                <tr>
                  <th scope="col" style={{ width: '88px' }}>
                    Slot / Recipe
                  </th>
                  <th scope="col">Product</th>
                  <th scope="col">Category</th>
                  <th scope="col" style={{ width: '150px' }}>
                    PL1 Single ({currency})
                  </th>
                  <th scope="col" style={{ width: '150px' }}>
                    PL1 Double ({currency})
                  </th>
                </tr>
              </thead>
              <tbody>
                {editedLayout.products.map((prod) => {
                  const baseProd = baselineLayout?.products?.find((p) => p.id === prod.id);
                  return (
                    <tr key={prod.id}>
                      <td
                        style={{
                          fontWeight: 600,
                          fontFamily: 'var(--font-mono)',
                          color: 'var(--text-secondary)',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        #{prod.id}
                        <span
                          style={{
                            marginLeft: '0.35rem',
                            fontSize: '0.7rem',
                            color: 'var(--text-muted)',
                            fontWeight: 400,
                          }}
                          title={`Recipe ID ${prod.product}`}
                        >
                          R{prod.product}
                        </span>
                      </td>
                      <td style={{ fontWeight: 600 }}>{prod.displayName}</td>
                      <td style={{ color: 'var(--text-secondary)' }}>
                        {prod.categoryName || 'Beverage'}
                      </td>
                      <PriceCell
                        prod={prod}
                        baseProd={baseProd}
                        paramCode="47"
                        ariaLabel={`${prod.displayName} PL1 Single Price`}
                        onChange={onCellPriceChange}
                      />
                      <PriceCell
                        prod={prod}
                        baseProd={baseProd}
                        paramCode="50"
                        ariaLabel={`${prod.displayName} PL1 Double Price`}
                        onChange={onCellPriceChange}
                      />
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
