'use client';

import React from 'react';
import type { TranslationKey } from '../../i18n/translations.ts';
import type { FleetMachine } from '#firmware-core';

function getMachineLabel(m: FleetMachine): string {
  return (
    [m.serialNumber, m.name].filter(Boolean).join(' · ') ||
    `${m.modelTypeDisplay} (${m.id.slice(0, 6)})`
  );
}

export interface UnavailableMachinesBannerProps {
  machines: readonly FleetMachine[];
  isRefreshing: boolean;
  onRecheckStatus: () => void | Promise<void>;
  onImportMachineConfig: (machineId: string) => void;
  onRemoveMachine: (machineId: string) => void;
  onBackToSelection?: () => void;
  t: (key: TranslationKey) => string;
}

/**
 * Step 2a Banner: Lists selected machines blocked from pricing edits due to missing
 * FTP configuration data, with actions to retry refresh, import config, remove, or return to Step 1.
 */
export function UnavailableMachinesBanner({
  machines,
  isRefreshing,
  onRecheckStatus,
  onImportMachineConfig,
  onRemoveMachine,
  onBackToSelection,
  t,
}: UnavailableMachinesBannerProps) {
  if (machines.length === 0) {
    return null;
  }

  return (
    <section className="panel alert-warning-panel">
      <div className="panel-header" style={{ flexWrap: 'wrap', marginBottom: '0.45rem' }}>
        <div>
          <h2 className="alert-warning-title">
            ⚠ {t('offlineUnavailableTitle')} ({machines.length})
          </h2>
          <p className="panel-desc alert-warning-desc">
            {t('offlineUnavailableDesc')}
          </p>
        </div>

        <div style={{ display: 'flex', gap: '0.45rem', flexWrap: 'wrap' }}>
          {onBackToSelection && (
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={onBackToSelection}
            >
              ← Back to Machine Selection
            </button>
          )}
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={isRefreshing}
            onClick={() => {
              void onRecheckStatus();
            }}
          >
            {isRefreshing ? 'Checking...' : `↻ ${t('recheckStatusBtn')}`}
          </button>
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.45rem', marginTop: '0.6rem' }}>
        {machines.map((m) => (
          <div
            key={m.id}
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              justifyContent: 'space-between',
              alignItems: 'center',
              gap: '0.5rem',
              padding: '0.5rem 0.7rem',
              background: 'var(--bg-surface)',
              border: '1px solid rgba(217, 119, 6, 0.35)',
              borderRadius: '4px',
            }}
          >
            <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '0.5rem' }}>
              <strong style={{ fontSize: '0.83rem' }}>{getMachineLabel(m)}</strong>
              <span
                className={`conn-dot ${m.cmConnected ? 'dot-online' : 'dot-offline'}`}
                style={{ fontSize: '0.75rem' }}
              >
                {m.cmConnected ? `● ${t('statusOnline')}` : `○ ${t('statusOffline')}`}
              </span>
              <span className="validation-pill valid-err" style={{ fontSize: '0.72rem' }}>
                {m.unavailableReason === 'offline_no_ftp_data' || !m.cmConnected
                  ? t('offlineNoFtpBadge')
                  : t('onlineNoFtpBadge')}
              </span>
            </div>

            <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => onImportMachineConfig(m.id)}
              >
                {t('importFileBtn')}
              </button>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => onRemoveMachine(m.id)}
              >
                ✕ {t('removeFromSelectionBtn')}
              </button>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
