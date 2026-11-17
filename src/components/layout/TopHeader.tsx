'use client';

import React from 'react';
import {
  SUPPORTED_LOCALES,
  type SupportedLocale,
  type TranslationKey,
} from '../../i18n/translations.ts';

export type WorkspaceStep = 'fleet' | 'pricing';

export interface TopHeaderProps {
  isAuthenticated: boolean;
  userDisplayName?: string | null;
  activeEnvLabel: string;
  activeCustomerName?: string | null;
  locale: SupportedLocale;
  onLocaleChange: (locale: SupportedLocale) => void;
  onOpenAccountModal: () => void;
  activeStep?: WorkspaceStep;
  onStepChange?: (step: WorkspaceStep) => void;
  showStepper?: boolean;
  totalMachinesCount?: number;
  selectedMachinesCount?: number;
  t: (key: TranslationKey) => string;
}

/** Corporate top header bar with connection/customer pills, locale switcher, account modal trigger, and 2-step workflow stepper. */
export function TopHeader({
  isAuthenticated,
  userDisplayName,
  activeEnvLabel,
  activeCustomerName,
  locale,
  onLocaleChange,
  onOpenAccountModal,
  activeStep = 'fleet',
  onStepChange,
  showStepper,
  totalMachinesCount,
  selectedMachinesCount = 0,
  t,
}: TopHeaderProps) {
  const shouldRenderStepper =
    isAuthenticated && Boolean(onStepChange) && (showStepper ?? true);

  return (
    <>
      <header className="top-bar">
        <div className="brand-group">
          <div className="brand-badge">REX-ROYAL</div>
          <div>
            <h1 className="app-title">{t('appTitle')}</h1>
            <p className="app-subtitle">{t('appSubtitle')}</p>
          </div>
        </div>

        <div className="top-bar-controls">
          <span className={`status-pill ${isAuthenticated ? 'status-live' : 'status-demo'}`}>
            {isAuthenticated
              ? `${userDisplayName || 'Connected'} (${activeEnvLabel})`
              : 'Not Signed In'}
          </span>

          {isAuthenticated && activeCustomerName && (
            <span className="status-pill status-demo" title={activeCustomerName}>
              {activeCustomerName}
            </span>
          )}

          <label className="visually-hidden" htmlFor="locale-select">
            Language
          </label>
          <select
            id="locale-select"
            className="select-control"
            value={locale}
            onChange={(e) => onLocaleChange(e.target.value as SupportedLocale)}
          >
            {SUPPORTED_LOCALES.map((loc) => (
              <option key={loc} value={loc}>
                {loc}
              </option>
            ))}
          </select>

          <button type="button" className="btn btn-primary" onClick={onOpenAccountModal}>
            {isAuthenticated ? 'Account / Server' : t('signInBtn')}
          </button>
        </div>
      </header>

      {shouldRenderStepper && onStepChange && (
        <nav aria-label="Workflow steps" className="workspace-stepper">
          <div className="workspace-stepper-inner">
            <button
              type="button"
              className={`btn btn-sm ${
                activeStep === 'fleet' ? 'btn-primary' : 'btn-secondary'
              }`}
              aria-current={activeStep === 'fleet' ? 'step' : undefined}
              onClick={() => onStepChange('fleet')}
            >
              {totalMachinesCount !== undefined
                ? `1. Select Machines (${totalMachinesCount} available · ${selectedMachinesCount} selected)`
                : `1. Select Machines (${selectedMachinesCount} selected)`}
            </button>

            <span aria-hidden="true" className="workspace-stepper-arrow">
              →
            </span>

            <button
              type="button"
              className={`btn btn-sm ${
                activeStep === 'pricing' ? 'btn-primary' : 'btn-secondary'
              }`}
              aria-current={activeStep === 'pricing' ? 'step' : undefined}
              disabled={selectedMachinesCount === 0}
              onClick={() => onStepChange('pricing')}
            >
              2. Configure &amp; Push Prices ({selectedMachinesCount} selected)
            </button>
          </div>
        </nav>
      )}
    </>
  );
}
