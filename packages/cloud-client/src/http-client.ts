/**
 * HTTP transport for ThingsBoard (`TbService` -> `/api`) and FtpProxy V2 (`FtpService` -> `/api/v2`),
 * with HMR-safe shared state, automatic 401 JWT refresh, and debug log subscription.
 */

import {
  ApiBasePath,
  AuthHeader,
  decodeBase64ToUtf8,
  FtpResourceType,
  MachineConfigFile,
  MimeType,
  ProxyRoutePrefix,
} from '#firmware-core';

export const SESSION_STORAGE_KEY = 'rr_dynamic_pricing_session_v1';

export interface CloudConnectionConfig {
  tbBaseUrl?: string;
  ftpBaseUrl?: string;
  jwtToken?: string | null;
  refreshToken?: string | null;
  useLocalCorsProxy?: boolean;
}

export interface MultipartUploadParams {
  uid: string;
  type: FtpResourceType;
  fileId: string;
  fileName: MachineConfigFile | string;
  content: string | Uint8Array;
  contentType: MimeType;
}

export interface DebugLogEntry {
  id: number;
  timestamp: string;
  target: 'TB' | 'FTP';
  method: string;
  path: string;
  status: number | 'ERR';
  durationMs: number;
  summary: string;
  requestDetail?: string;
  requestTotalChars?: number;
  responseDetail?: string;
  responseTotalChars?: number;
}

type DebugLogListener = (logs: readonly DebugLogEntry[]) => void;
type TokenRefreshListener = (tokens: { jwtToken: string | null; refreshToken: string | null }) => void;

const MAX_DEBUG_LOGS = 150;
const MAX_LOG_CHARS = 2_000_000;

export class HttpError extends Error {
  readonly status: number;
  readonly path: string;
  constructor(status: number, path: string, message: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.path = path;
  }
}

interface InternalConnectionState {
  tbOrigin: string;
  ftpOrigin: string;
  jwtToken: string | null;
  refreshToken: string | null;
  useLocalCorsProxy: boolean;
  debugLogsBuffer: DebugLogEntry[];
  nextLogId: number;
  debugListeners: Set<DebugLogListener>;
  tokenListeners: Set<TokenRefreshListener>;
}

const DEFAULT_TB_ORIGIN =
  (typeof process !== 'undefined' && process.env?.NEXT_PUBLIC_TB_BASE_URL) ||
  'https://iot.rex-royal.ch';
const DEFAULT_FTP_ORIGIN =
  (typeof process !== 'undefined' && process.env?.NEXT_PUBLIC_FTP_BASE_URL) ||
  'https://iot.rex-royal.ch:8787';

const g = globalThis as unknown as { __rrCloudConnectionState?: InternalConnectionState };
const state: InternalConnectionState =
  g.__rrCloudConnectionState ??
  (g.__rrCloudConnectionState = {
    tbOrigin: DEFAULT_TB_ORIGIN,
    ftpOrigin: DEFAULT_FTP_ORIGIN,
    jwtToken: null,
    refreshToken: null,
    useLocalCorsProxy: true,
    debugLogsBuffer: [],
    nextLogId: 1,
    debugListeners: new Set(),
    tokenListeners: new Set(),
  });
state.debugLogsBuffer ??= [];
state.nextLogId ??= 1;
state.debugListeners ??= new Set();
state.tokenListeners ??= new Set();

function notifyListeners<T>(listeners: ReadonlySet<(v: T) => void>, value: T): void {
  for (const fn of listeners) {
    try {
      fn(value);
    } catch {
      // Ignore listener errors
    }
  }
}

function capturePayload(str: string): { text: string; totalChars: number } {
  return str.length <= MAX_LOG_CHARS
    ? { text: str, totalChars: str.length }
    : { text: str.slice(0, MAX_LOG_CHARS), totalChars: str.length };
}

function appendDebugLog(entry: Omit<DebugLogEntry, 'id' | 'timestamp'>): void {
  const d = new Date();
  const pad = (n: number, len = 2) => String(n).padStart(len, '0');
  const timestamp = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
  state.debugLogsBuffer = [
    { id: state.nextLogId++, timestamp, ...entry },
    ...state.debugLogsBuffer.slice(0, MAX_DEBUG_LOGS - 1),
  ];
  notifyListeners(state.debugListeners, state.debugLogsBuffer);
}

export const getDebugLogs = (): readonly DebugLogEntry[] => state.debugLogsBuffer;
export const clearDebugLogs = (): void => {
  state.debugLogsBuffer = [];
  notifyListeners(state.debugListeners, state.debugLogsBuffer);
};
export function subscribeDebugLogs(listener: DebugLogListener): () => void {
  state.debugListeners.add(listener);
  listener(state.debugLogsBuffer);
  return () => state.debugListeners.delete(listener);
}

export function subscribeCloudTokens(listener: TokenRefreshListener): () => void {
  state.tokenListeners.add(listener);
  return () => state.tokenListeners.delete(listener);
}

const stripBearer = (token: string | null | undefined): string | null =>
  token ? token.trim().replace(/^Bearer\s+/i, '') || null : null;

function hydrateSession(): void {
  if (state.jwtToken || typeof window === 'undefined') return;
  try {
    const raw = window.sessionStorage.getItem(SESSION_STORAGE_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw) as CloudConnectionConfig;
    if (saved.tbBaseUrl) state.tbOrigin = saved.tbBaseUrl.trim().replace(/\/+$/, '');
    if (saved.ftpBaseUrl) state.ftpOrigin = saved.ftpBaseUrl.trim().replace(/\/+$/, '');
    if (saved.jwtToken) state.jwtToken = stripBearer(saved.jwtToken);
    if (saved.refreshToken) state.refreshToken = saved.refreshToken.trim();
  } catch {
    // Ignore storage errors
  }
}

function persistSessionTokens(): void {
  if (typeof window === 'undefined') return;
  try {
    const raw = window.sessionStorage.getItem(SESSION_STORAGE_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw) as Record<string, unknown>;
    saved.jwtToken = state.jwtToken;
    if (state.refreshToken) saved.refreshToken = state.refreshToken;
    window.sessionStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(saved));
  } catch {
    // Ignore storage errors
  }
}

export function getJwtExpirationMs(jwtToken: string | null | undefined): number | null {
  const clean = stripBearer(jwtToken);
  const payloadSeg = clean?.split('.')[1];
  if (!payloadSeg) return null;
  try {
    const b64 = payloadSeg.replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    const { exp } = JSON.parse(decodeBase64ToUtf8(padded)) as { exp?: number };
    return typeof exp === 'number' && Number.isFinite(exp) ? exp * 1000 : null;
  } catch {
    return null;
  }
}

type ServiceTarget = 'TB' | 'FTP';
interface EndpointSpec {
  target: ServiceTarget;
  origin: string;
  apiBasePath: ApiBasePath;
  proxyPrefix: ProxyRoutePrefix | null;
  authHeader: AuthHeader;
}

const getSpec = (target: ServiceTarget): EndpointSpec =>
  target === 'TB'
    ? {
        target,
        origin: state.tbOrigin,
        apiBasePath: ApiBasePath.ThingsBoard,
        proxyPrefix: state.useLocalCorsProxy ? ProxyRoutePrefix.ThingsBoard : null,
        authHeader: AuthHeader.ThingsBoard,
      }
    : {
        target,
        origin: state.ftpOrigin,
        apiBasePath: ApiBasePath.FtpV2,
        proxyPrefix: state.useLocalCorsProxy ? ProxyRoutePrefix.FtpV2 : null,
        authHeader: AuthHeader.FtpV2,
      };

function buildRequest(spec: EndpointSpec, relativePath: string): { url: string; headers: Record<string, string> } {
  hydrateSession();
  const cleanPath = relativePath.startsWith('/') ? relativePath : `/${relativePath}`;
  const headers: Record<string, string> = state.jwtToken
    ? { [spec.authHeader]: `Bearer ${state.jwtToken}` }
    : {};
  if (spec.proxyPrefix && typeof window !== 'undefined') {
    headers['X-Target-Origin'] = spec.origin;
    return { url: `${spec.proxyPrefix}${cleanPath}`, headers };
  }
  return { url: `${spec.origin}${spec.apiBasePath}${cleanPath}`, headers };
}

let refreshPromise: Promise<boolean> | null = null;

async function tryRefreshJwtToken(): Promise<boolean> {
  hydrateSession();
  if (!state.refreshToken) return false;
  if (refreshPromise) return refreshPromise;

  refreshPromise = (async () => {
    try {
      const data = await executeRequest<{ token?: string; refreshToken?: string }>('TB', 'POST', '/auth/token', {
        body: { refreshToken: state.refreshToken },
        acceptJson: true,
        summary: 'Refresh JWT access token',
        redactRequestLog: true,
        responseDetailOverride: 'Token refreshed',
      });
      if (!data?.token) return false;
      state.jwtToken = data.token;
      if (data.refreshToken) state.refreshToken = data.refreshToken;
      persistSessionTokens();
      notifyListeners(state.tokenListeners, { jwtToken: state.jwtToken, refreshToken: state.refreshToken });
      return true;
    } catch {
      return false;
    } finally {
      refreshPromise = null;
    }
  })();

  return refreshPromise;
}

export async function ensureFreshCloudJwtToken(
  options: { minValidityMs?: number; force?: boolean; nowMs?: number } = {}
): Promise<{ refreshed: boolean; token: string | null; refreshToken: string | null }> {
  hydrateSession();
  const { minValidityMs = 5 * 60_000, force = false, nowMs = Date.now() } = options;
  if (!state.refreshToken) return { refreshed: false, token: state.jwtToken, refreshToken: null };
  const expMs = getJwtExpirationMs(state.jwtToken);
  if (!force && expMs !== null && expMs - nowMs > minValidityMs) {
    return { refreshed: false, token: state.jwtToken, refreshToken: state.refreshToken };
  }
  const refreshed = await tryRefreshJwtToken();
  return { refreshed, token: state.jwtToken, refreshToken: state.refreshToken };
}

function summarizeRequest(method: string, fullPath: string, body?: unknown): string {
  const b = (body && typeof body === 'object' ? body : {}) as { method?: string; file?: string; params?: { file?: string } };
  if (fullPath.includes('/rpc/twoway/')) return `MQTT 2-way RPC ${b.method || 'rpc'} → ${(fullPath.split('/rpc/twoway/')[1] || '').slice(0, 8)}…`;
  if (fullPath.includes('/rpc/oneway/')) {
    const file = b.params?.file ? ` (${b.params.file})` : '';
    return `MQTT RPC ${b.method || 'rpc'}${file} → ${(fullPath.split('/rpc/oneway/')[1] || '').slice(0, 8)}…`;
  }
  if (fullPath.includes('/entitiesQuery/find')) return 'Query fleet machines & live MQTT attributes';
  if (fullPath.includes('/download/')) return `Download ${fullPath.split('/download/')[1] || fullPath}`;
  if (fullPath.includes('/list/')) return `List directory ${fullPath.split('/list/')[1] || fullPath}`;
  if (fullPath.includes('/delete')) return `Delete ${b.file || fullPath}`;
  return `${method} ${fullPath}`;
}

interface ExecuteOptions {
  body?: unknown;
  formDataFactory?: () => FormData;
  responseType?: 'json' | 'text' | 'bytes';
  nullOnNotFound?: boolean;
  acceptJson?: boolean;
  silentLog?: boolean;
  summary?: string;
  requestDetailOverride?: string;
  responseDetailOverride?: string;
  redactRequestLog?: boolean;
  includeErrorBody?: boolean;
  errorLabel?: string;
}

async function executeRequest<T>(
  target: ServiceTarget,
  method: 'GET' | 'POST' | 'DELETE',
  relativePath: string,
  opts: ExecuteOptions = {}
): Promise<T> {
  const spec = getSpec(target);
  const cleanPath = relativePath.startsWith('/') ? relativePath : `/${relativePath}`;
  const fullPath = `${spec.apiBasePath}${cleanPath}`;
  const reqBodyStr = opts.body !== undefined ? JSON.stringify(opts.body) : undefined;
  const summary = opts.summary ?? summarizeRequest(method, fullPath, opts.body);
  const isAuthCall = cleanPath === '/auth/login' || cleanPath === '/auth/token';

  const reqCapture =
    reqBodyStr && !opts.redactRequestLog && !isAuthCall ? capturePayload(reqBodyStr) : null;
  const reqLogFields =
    opts.requestDetailOverride !== undefined
      ? { requestDetail: opts.requestDetailOverride }
      : isAuthCall
        ? { requestDetail: '[Redacted auth request]' }
        : reqCapture
          ? { requestDetail: reqCapture.text, requestTotalChars: reqCapture.totalChars }
          : {};

  const send = () => {
    const { url, headers } = buildRequest(spec, cleanPath);
    if (opts.acceptJson) headers.Accept = MimeType.Json;
    let body: BodyInit | undefined;
    if (opts.formDataFactory) body = opts.formDataFactory();
    else if (reqBodyStr !== undefined) {
      headers['Content-Type'] = MimeType.Json;
      body = reqBodyStr;
    }
    return fetch(url, { method, cache: 'no-store', headers, ...(body !== undefined ? { body } : {}) });
  };

  const expMs = getJwtExpirationMs(state.jwtToken);
  if (!isAuthCall && expMs !== null && expMs - Date.now() <= 60_000 && state.refreshToken) {
    await tryRefreshJwtToken();
  }

  const startMs = Date.now();
  let response = await send();
  if (!isAuthCall && (response.status === 401 || response.status === 403) && (await tryRefreshJwtToken())) {
    response = await send();
  }
  const durationMs = Date.now() - startMs;

  const log = (
    status: number,
    resFields: Pick<DebugLogEntry, 'responseDetail' | 'responseTotalChars'>,
    summaryText = summary
  ) => {
    if (!opts.silentLog) {
      appendDebugLog({ target, method, path: fullPath, status, durationMs, summary: summaryText, ...reqLogFields, ...resFields });
    }
  };

  if (!response.ok) {
    if (opts.nullOnNotFound && response.status === 404) {
      log(response.status, { responseDetail: 'HTTP 404 (absent)' });
      return null as T;
    }
    const errText = opts.includeErrorBody ? await response.text().catch(() => '') : '';
    const errCap = capturePayload(errText || `HTTP ${response.status}`);
    log(response.status, { responseDetail: errCap.text, ...(errText ? { responseTotalChars: errCap.totalChars } : {}) });
    const label = opts.errorLabel ? ` (${opts.errorLabel})` : '';
    throw new HttpError(response.status, fullPath, `${method} ${fullPath}${label} failed (HTTP ${response.status})${errText ? `: ${errText}` : ''}`);
  }

  if (opts.responseType === 'bytes') {
    const bytes = new Uint8Array(await response.arrayBuffer());
    const sizeText = bytes.byteLength.toLocaleString();
    log(response.status, { responseDetail: `Binary archive (${sizeText} bytes)` }, `${summary} (${sizeText} bytes)`);
    return bytes as T;
  }

  const text = await response.text();
  if (opts.responseDetailOverride !== undefined) {
    log(response.status, { responseDetail: opts.responseDetailOverride });
  } else if (isAuthCall) {
    log(response.status, { responseDetail: '[Redacted auth tokens]' });
  } else {
    const resCap = capturePayload(text || (method !== 'GET' ? 'OK' : ''));
    log(response.status, { responseDetail: resCap.text, responseTotalChars: resCap.totalChars });
  }

  return (opts.responseType === 'text' ? text : text ? JSON.parse(text) : {}) as T;
}

/**
 * Configures process-level Rex-Royal cloud endpoints and JWT credentials.
 * Intended for browser tabs or single-tenant CLI scripts; multi-tenant backend
 * servers should isolate credentials per request rather than sharing globals.
 */
export function configureCloudConnection(config: CloudConnectionConfig): void {
  if (config.tbBaseUrl?.trim()) state.tbOrigin = config.tbBaseUrl.trim().replace(/\/+$/, '');
  if (config.ftpBaseUrl?.trim()) state.ftpOrigin = config.ftpBaseUrl.trim().replace(/\/+$/, '');
  if (config.jwtToken !== undefined) state.jwtToken = stripBearer(config.jwtToken);
  if (config.refreshToken !== undefined) state.refreshToken = config.refreshToken?.trim() || null;
  if (config.useLocalCorsProxy !== undefined) state.useLocalCorsProxy = config.useLocalCorsProxy;
}

export function setCloudJwtToken(token: string | null, refreshToken: string | null = null): void {
  state.jwtToken = stripBearer(token);
  if (refreshToken !== null) state.refreshToken = refreshToken?.trim() || null;
  else if (token === null) state.refreshToken = null;
}

export class TbService {
  static readonly basePath = ApiBasePath.ThingsBoard;

  static get<T = unknown>(relativePath: string): Promise<T> {
    return executeRequest<T>('TB', 'GET', relativePath, { acceptJson: true });
  }

  static post<T = unknown>(relativePath: string, body: unknown, options: { silentLog?: boolean } = {}): Promise<T> {
    return executeRequest<T>('TB', 'POST', relativePath, {
      body,
      acceptJson: true,
      includeErrorBody: true,
      silentLog: options.silentLog,
    });
  }
}

export class FtpService {
  static readonly basePath = ApiBasePath.FtpV2;

  static get<T = unknown>(relativePath: string): Promise<T> {
    return executeRequest<T>('FTP', 'GET', relativePath, { acceptJson: true });
  }

  static downloadJson<T = unknown>(type: FtpResourceType, uid: string, fileName: MachineConfigFile | string): Promise<T> {
    return FtpService.get<T>(`/download/${type}/${uid}/${fileName}`);
  }

  static downloadJsonOrNull<T = unknown>(type: FtpResourceType, uid: string, fileName: MachineConfigFile | string): Promise<T | null> {
    return executeRequest<T | null>('FTP', 'GET', `/download/${type}/${uid}/${fileName}`, {
      nullOnNotFound: true,
      acceptJson: true,
    });
  }

  static downloadTextOrNull(type: FtpResourceType, uid: string, fileName: MachineConfigFile | string): Promise<string | null> {
    return executeRequest<string | null>('FTP', 'GET', `/download/${type}/${uid}/${fileName}`, {
      responseType: 'text',
      nullOnNotFound: true,
    });
  }

  static downloadBytesOrNull(type: FtpResourceType, uid: string, fileName: MachineConfigFile | string): Promise<Uint8Array | null> {
    return executeRequest<Uint8Array | null>('FTP', 'GET', `/download/${type}/${uid}/${fileName}`, {
      responseType: 'bytes',
      nullOnNotFound: true,
    });
  }

  static async listFiles(type: FtpResourceType, uid: string): Promise<Array<{ filename: string; created?: string; size?: string }>> {
    try {
      const resp = await FtpService.get<{ data?: Array<{ filename?: string; name?: string; created?: string; size?: string } | string> }>(`/list/${uid}/${type}`);
      return (Array.isArray(resp?.data) ? resp.data : [])
        .map((item) =>
          typeof item === 'string'
            ? { filename: item }
            : { filename: String(item?.filename || item?.name || '').trim(), created: item?.created, size: item?.size }
        )
        .filter((item) => Boolean(item.filename));
    } catch {
      return [];
    }
  }

  static async deleteFile(type: FtpResourceType, uid: string, fileName: MachineConfigFile | string): Promise<boolean> {
    try {
      await executeRequest('FTP', 'DELETE', '/delete', {
        body: { uid, type, file: fileName },
        acceptJson: true,
        includeErrorBody: true,
      });
      return true;
    } catch {
      return false;
    }
  }

  static upload<T = unknown>(params: MultipartUploadParams): Promise<T> {
    const byteSize = typeof params.content === 'string' ? params.content.length : params.content.byteLength;
    const jsonMeta = { uid: params.uid, type: params.type, fileId: params.fileId, forceUpload: true };
    return executeRequest<T>('FTP', 'POST', '/upload', {
      formDataFactory: () => {
        const fd = new FormData();
        fd.append('json', JSON.stringify(jsonMeta));
        fd.append('file', new Blob([params.content as BlobPart], { type: params.contentType }), params.fileName);
        return fd;
      },
      summary: `Upload ${params.type}/${params.uid.slice(0, 8)}…/${params.fileName} (${byteSize.toLocaleString()} B)`,
      requestDetailOverride: JSON.stringify({ ...jsonMeta, fileName: params.fileName, byteSize }),
      errorLabel: params.fileName,
    });
  }
}
