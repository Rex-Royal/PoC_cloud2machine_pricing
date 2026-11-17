'use client';

import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useState } from 'react';
import { AuthService } from '#cloud-client';
import type { UserProfile } from '#firmware-core';
import {
  clearSavedSessionStorage,
  ENVIRONMENT_PRESETS,
  readSavedSessionState,
  writeSavedSessionState,
  type EnvironmentPreset,
  type SavedSessionState,
} from '../utils/dashboardStorage.ts';
import { useLatestRef } from './useLatestRef.ts';

export interface UseAuthSessionOptions {
  /** Called during mount session restore once profile is verified; returns void or resolves fleet state. */
  onSessionRestored?: (profile: UserProfile, saved: SavedSessionState) => Promise<void> | void;
  /** Called after interactive login succeeds; returns the initial selectedCustomerId to persist. */
  onLoginSuccess?: (profile: UserProfile) => Promise<string> | string;
  /** Called right after logout clears credentials so downstream hooks can reset their state. */
  onLoggedOut?: () => void;
  /** Called after login completes so the account modal can close. */
  onCloseModal?: () => void;
}

export function useAuthSession(options: UseAuthSessionOptions = {}) {
  const [envPreset, setEnvPreset] = useState<EnvironmentPreset['id']>('iot');
  const [tbBaseUrl, setTbBaseUrl] = useState(ENVIRONMENT_PRESETS[0].tbUrl);
  const [ftpBaseUrl, setFtpBaseUrl] = useState(ENVIRONMENT_PRESETS[0].ftpUrl);
  const [usernameInput, setUsernameInput] = useState('');
  const [passwordInput, setPasswordInput] = useState('');
  const [rawTokenInput, setRawTokenInput] = useState('');
  const [useRawTokenMode, setUseRawTokenMode] = useState(false);

  const [jwtToken, setJwtToken] = useState<string | null>(null);
  const [refreshToken, setRefreshToken] = useState<string | null>(null);
  const [userProfile, setUserProfile] = useState<UserProfile | null>(null);
  const [authError, setAuthError] = useState('');
  const [isAuthenticating, setIsAuthenticating] = useState(false);

  const onSessionRestoredRef = useLatestRef(options.onSessionRestored);
  const onLoginSuccessRef = useLatestRef(options.onLoginSuccess);
  const onLoggedOutRef = useLatestRef(options.onLoggedOut);
  const onCloseModalRef = useLatestRef(options.onCloseModal);

  const envPresetRef = useLatestRef(envPreset);
  const tbBaseUrlRef = useLatestRef(tbBaseUrl);
  const ftpBaseUrlRef = useLatestRef(ftpBaseUrl);
  const jwtTokenRef = useLatestRef(jwtToken);
  const refreshTokenRef = useLatestRef(refreshToken);

  // Keep static TbService (/api) and FtpService (/api/v2) synced with current URLs & JWT/refreshToken
  useEffect(() => {
    AuthService.configure({
      tbBaseUrl,
      ftpBaseUrl,
      jwtToken,
      ...(refreshToken ? { refreshToken } : {}),
      useLocalCorsProxy: true,
    });
  }, [tbBaseUrl, ftpBaseUrl, jwtToken, refreshToken]);

  // Keep React token state synced whenever HttpClient renews JWT via POST /api/auth/token (guard against no-op loops)
  useEffect(() => {
    return AuthService.subscribeTokens(({ jwtToken: nextJwt, refreshToken: nextRefresh }) => {
      if (nextJwt) {
        setJwtToken((prev) => (prev === nextJwt ? prev : nextJwt));
      }
      if (nextRefresh) {
        setRefreshToken((prev) => (prev === nextRefresh ? prev : nextRefresh));
      }
    });
  }, []);

  // Proactively renew JWT 5 minutes before expiry so long-lived browser sessions & schedules never expire
  useQuery({
    queryKey: ['auth-keepalive', jwtToken],
    enabled: Boolean(jwtToken),
    queryFn: async () => {
      await AuthService.ensureFreshToken({ minValidityMs: 5 * 60_000 });
      return true;
    },
    refetchInterval: 30_000,
    refetchIntervalInBackground: true,
  });

  // Restore saved session on mount
  useEffect(() => {
    let cancelled = false;
    const saved = readSavedSessionState();
    if (!saved) return undefined;

    if (saved.tbBaseUrl) setTbBaseUrl(saved.tbBaseUrl);
    if (saved.ftpBaseUrl) setFtpBaseUrl(saved.ftpBaseUrl);
    if (saved.envPreset === 'iot' || saved.envPreset === 'custom') {
      setEnvPreset(saved.envPreset);
    } else if (saved.envPreset) {
      setEnvPreset('custom');
    }
    if (saved.refreshToken) setRefreshToken(saved.refreshToken);

    if (saved.jwtToken) {
      setJwtToken(saved.jwtToken);
      AuthService.configure({
        tbBaseUrl: saved.tbBaseUrl,
        ftpBaseUrl: saved.ftpBaseUrl,
        jwtToken: saved.jwtToken,
        refreshToken: saved.refreshToken || null,
        useLocalCorsProxy: true,
      });

      (async () => {
        try {
          await AuthService.ensureFreshToken({ minValidityMs: 5 * 60_000 });
          const profile = await AuthService.getCurrentUser();
          if (cancelled) return;
          setUserProfile(profile);
          await onSessionRestoredRef.current?.(profile, saved);
        } catch {
          if (cancelled) return;
          clearSavedSessionStorage();
          setJwtToken(null);
          setRefreshToken(null);
          AuthService.setToken(null);
        }
      })();
    }

    return () => {
      cancelled = true;
    };
  }, [onSessionRestoredRef]);

  const handlePresetChange = useCallback((presetId: EnvironmentPreset['id']) => {
    setEnvPreset(presetId);
    const found = ENVIRONMENT_PRESETS.find((p) => p.id === presetId);
    if (found && presetId !== 'custom') {
      setTbBaseUrl(found.tbUrl);
      setFtpBaseUrl(found.ftpUrl);
    }
  }, []);

  const persistSelectedCustomerId = useCallback(
    (selectedCustomerId: string) => {
      if (!jwtTokenRef.current) return;
      writeSavedSessionState({
        envPreset: envPresetRef.current,
        tbBaseUrl: tbBaseUrlRef.current.trim(),
        ftpBaseUrl: ftpBaseUrlRef.current.trim(),
        jwtToken: jwtTokenRef.current,
        refreshToken: refreshTokenRef.current,
        selectedCustomerId,
      });
    },
    [envPresetRef, tbBaseUrlRef, ftpBaseUrlRef, jwtTokenRef, refreshTokenRef]
  );

  const handleLogin = useCallback(
    async (e: React.FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      setAuthError('');
      setIsAuthenticating(true);

      try {
        AuthService.configure({
          tbBaseUrl,
          ftpBaseUrl,
          jwtToken: null,
          refreshToken: null,
          useLocalCorsProxy: true,
        });

        let activeToken = rawTokenInput.trim().replace(/^Bearer\s+/i, '');
        let activeRefreshToken: string | null = null;

        if (!useRawTokenMode) {
          const authData = await AuthService.login(usernameInput.trim(), passwordInput);
          activeToken = authData.token;
          activeRefreshToken = authData.refreshToken || null;
        } else {
          if (!activeToken) {
            throw new Error('Please paste a valid Bearer JWT token.');
          }
          AuthService.setToken(activeToken);
        }

        setJwtToken(activeToken);
        setRefreshToken(activeRefreshToken);
        const profile = await AuthService.getCurrentUser();
        setUserProfile(profile);

        const selectedCustomerId = (await onLoginSuccessRef.current?.(profile)) ?? '';

        writeSavedSessionState({
          envPreset,
          tbBaseUrl: tbBaseUrl.trim(),
          ftpBaseUrl: ftpBaseUrl.trim(),
          jwtToken: activeToken,
          refreshToken: activeRefreshToken,
          selectedCustomerId,
        });

        onCloseModalRef.current?.();
      } catch (err) {
        setAuthError(err instanceof Error ? err.message : String(err));
      } finally {
        setIsAuthenticating(false);
      }
    },
    [
      envPreset,
      tbBaseUrl,
      ftpBaseUrl,
      usernameInput,
      passwordInput,
      rawTokenInput,
      useRawTokenMode,
      onLoginSuccessRef,
      onCloseModalRef,
    ]
  );

  const handleLogout = useCallback(() => {
    clearSavedSessionStorage();
    AuthService.setToken(null);
    setJwtToken(null);
    setRefreshToken(null);
    setUserProfile(null);
    onLoggedOutRef.current?.();
  }, [onLoggedOutRef]);

  return {
    envPreset,
    activeEnvLabel: envPreset.toUpperCase(),
    tbBaseUrl,
    setTbBaseUrl,
    ftpBaseUrl,
    setFtpBaseUrl,
    usernameInput,
    setUsernameInput,
    passwordInput,
    setPasswordInput,
    rawTokenInput,
    setRawTokenInput,
    useRawTokenMode,
    setUseRawTokenMode,
    jwtToken,
    refreshToken,
    userProfile,
    userDisplayName: userProfile?.email || userProfile?.name || null,
    authError,
    isAuthenticating,
    handlePresetChange,
    handleLogin,
    handleLogout,
    persistSelectedCustomerId,
  };
}
