'use client';

import React from 'react';
import type { TranslationKey } from '../../i18n/translations.ts';
import {
  ENVIRONMENT_PRESETS,
  type EnvironmentPreset,
} from '../../utils/dashboardStorage.ts';

export interface AuthFormProps {
  mode: 'login' | 'modal';
  presets?: readonly EnvironmentPreset[];
  selectedPresetId: EnvironmentPreset['id'];
  tbBaseUrl: string;
  ftpBaseUrl: string;
  username: string;
  password: string;
  bearerTokenInput: string;
  showBearerInput: boolean;
  authError: string;
  isLoggingIn: boolean;
  isAuthenticated: boolean;
  currentUserEmail?: string | null;
  t: (key: TranslationKey) => string;
  onPresetChange: (presetId: EnvironmentPreset['id']) => void;
  onTbUrlChange: (value: string) => void;
  onFtpUrlChange: (value: string) => void;
  onUsernameChange: (value: string) => void;
  onPasswordChange: (value: string) => void;
  onBearerChange: (value: string) => void;
  onToggleBearerInput: (showBearer: boolean) => void;
  onSubmit: (e: React.FormEvent<HTMLFormElement>) => void | Promise<void>;
  onBearerSubmit?: (e: React.FormEvent<HTMLFormElement>) => void | Promise<void>;
  onLogout?: () => void;
  onCloseModal?: () => void;
}

/** Shared authentication and server configuration form for inline login and account modal. */
export function AuthForm({
  mode,
  presets = ENVIRONMENT_PRESETS,
  selectedPresetId,
  tbBaseUrl,
  ftpBaseUrl,
  username,
  password,
  bearerTokenInput,
  showBearerInput,
  authError,
  isLoggingIn,
  isAuthenticated,
  currentUserEmail,
  t,
  onPresetChange,
  onTbUrlChange,
  onFtpUrlChange,
  onUsernameChange,
  onPasswordChange,
  onBearerChange,
  onToggleBearerInput,
  onSubmit,
  onBearerSubmit,
  onLogout,
  onCloseModal,
}: AuthFormProps) {
  const idPrefix = mode === 'modal' ? 'modal' : 'main';
  const handleFormSubmit = showBearerInput && onBearerSubmit ? onBearerSubmit : onSubmit;

  const bearerToggleControl = (
    <label className="checkbox-inline" style={{ marginLeft: 0 }}>
      <input
        type="checkbox"
        checked={showBearerInput}
        onChange={(e) => onToggleBearerInput(e.target.checked)}
      />
      <span>
        {mode === 'modal' ? 'Sign in with Bearer JWT token' : 'Sign in with Bearer token'}
      </span>
    </label>
  );

  return (
    <form onSubmit={handleFormSubmit} className="auth-form">
      {mode === 'modal' && isAuthenticated && currentUserEmail && (
        <div>
          <span className="status-pill status-live">{currentUserEmail}</span>
        </div>
      )}

      <div className="form-field">
        <label htmlFor={`${idPrefix}-env-preset`}>Environment</label>
        <select
          id={`${idPrefix}-env-preset`}
          className="select-control"
          value={selectedPresetId}
          onChange={(e) => onPresetChange(e.target.value as EnvironmentPreset['id'])}
        >
          {presets.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
      </div>

      {selectedPresetId === 'custom' && (
        <>
          <div className="form-field">
            <label htmlFor={`${idPrefix}-tb-url`}>{t('tbUrlLabel')}</label>
            <input
              id={`${idPrefix}-tb-url`}
              type="url"
              required
              value={tbBaseUrl}
              onChange={(e) => onTbUrlChange(e.target.value)}
            />
          </div>

          <div className="form-field">
            <label htmlFor={`${idPrefix}-ftp-url`}>{t('ftpUrlLabel')}</label>
            <input
              id={`${idPrefix}-ftp-url`}
              type="url"
              required
              value={ftpBaseUrl}
              onChange={(e) => onFtpUrlChange(e.target.value)}
            />
          </div>
        </>
      )}

      {mode === 'modal' && bearerToggleControl}

      {!showBearerInput ? (
        <>
          <div className="form-field">
            <label htmlFor={`${idPrefix}-username`}>{t('emailLabel')}</label>
            <input
              id={`${idPrefix}-username`}
              type="email"
              required
              autoComplete="username"
              value={username}
              onChange={(e) => onUsernameChange(e.target.value)}
            />
          </div>

          <div className="form-field">
            <label htmlFor={`${idPrefix}-password`}>{t('passwordLabel')}</label>
            <input
              id={`${idPrefix}-password`}
              type="password"
              required
              autoComplete="current-password"
              value={password}
              onChange={(e) => onPasswordChange(e.target.value)}
            />
          </div>
        </>
      ) : (
        <div className="form-field">
          <label htmlFor={`${idPrefix}-raw-jwt`}>Bearer Token (JWT)</label>
          <input
            id={`${idPrefix}-raw-jwt`}
            type="text"
            required
            placeholder="eyJhbGciOiJIUzUxMiJ9..."
            value={bearerTokenInput}
            onChange={(e) => onBearerChange(e.target.value)}
          />
        </div>
      )}

      {mode === 'login' && (
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}
        >
          {bearerToggleControl}
          <button type="submit" className="btn btn-primary" disabled={isLoggingIn}>
            {isLoggingIn ? 'Signing in...' : t('signInBtn')}
          </button>
        </div>
      )}

      {authError && <div className="auth-error-banner">{authError}</div>}

      {mode === 'modal' && (
        <div className="dialog-actions">
          {isAuthenticated && onLogout && (
            <button type="button" className="btn btn-secondary" onClick={onLogout}>
              Sign Out
            </button>
          )}
          {onCloseModal && (
            <button type="button" className="btn btn-secondary" onClick={onCloseModal}>
              {t('dialogCloseBtn')}
            </button>
          )}
          <button type="submit" className="btn btn-primary" disabled={isLoggingIn}>
            {isLoggingIn ? 'Signing in...' : t('signInBtn')}
          </button>
        </div>
      )}
    </form>
  );
}
