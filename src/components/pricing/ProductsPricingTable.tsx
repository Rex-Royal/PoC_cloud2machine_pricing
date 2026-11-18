'use client';

import React from 'react';
import {
  ALL_PRICE_PARAM_CODES,
  formatMinorPrice,
  PRICE_PARAM_PL1_SINGLE,
  type FleetMachine,
  type MachineLayout,
  type ProductSlot,
} from '#firmware-core';
import type { TranslationKey } from '../../i18n/translations.ts';
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
  onProductPriceChange: (slotId: number, decimalText: string) => void;
  onResetPrices: () => void;
  onDeployCluster: () => void;
  onFetchClusterPriceList?: () => void;
  t: (key: TranslationKey) => string;
}

interface PriceCellProps {
  prod: ProductSlot;
  baseProd: ProductSlot | undefined;
  currency: string;
  onChange: (slotId: number, decimalText: string) => void;
}

function PriceCell({ prod, baseProd, currency, onChange }: PriceCellProps) {
  const rawMinor = Number(prod.params[PRICE_PARAM_PL1_SINGLE] ?? 0);
  const baseMinor = Number(baseProd?.params?.[PRICE_PARAM_PL1_SINGLE] ?? rawMinor);
  const hasAnyPriceParamChanged =
    baseProd !== undefined &&
    ALL_PRICE_PARAM_CODES.some(
      (code) => Number(prod.params[code] ?? 0) !== Number(baseProd.params[code] ?? 0)
    );
  const isModified = rawMinor !== baseMinor || hasAnyPriceParamChanged;

  return (
    <td className={isModified ? 'cell-modified' : ''}>
      <input
        type="number"
        name={`price-${prod.id}`}
        inputMode="decimal"
        step="0.05"
        min="0"
        className="price-input"
        aria-label={`${prod.displayName} Price (${currency})`}
        value={formatMinorPrice(rawMinor)}
        onChange={(e) => onChange(prod.id, e.target.value)}
      />
      {rawMinor !== baseMinor && (
        <span className="cell-was">was {formatMinorPrice(baseMinor)}</span>
      )}
    </td>
  );
}

/**
 * Step 2c Panel 2: Products & Prices matrix table for the active Pricing Group,
 * supporting single-input product pricing across all 24 price fields, changed-cell highlights,
 * Reset to Baseline, and Deploy.
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
  onProductPriceChange,
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
                  <th scope="col" style={{ width: '160px' }}>
                    Price ({currency})
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
                        currency={currency}
                        onChange={onProductPriceChange}
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
