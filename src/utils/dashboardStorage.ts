import { isSyntheticSampleConfig } from '#firmware-core';
import { SESSION_STORAGE_KEY } from '#cloud-client';
import type {
  FleetMachine,
  ScheduledPricingJob,
  TrackedDeploymentBatch,
} from '#firmware-core';

export { SESSION_STORAGE_KEY };

export interface EnvironmentPreset {
  id: 'iot' | 'custom';
  label: string;
  tbUrl: string;
  ftpUrl: string;
}

const DEFAULT_TB_URL = process.env.NEXT_PUBLIC_TB_BASE_URL || 'https://iot.rex-royal.ch';
const DEFAULT_FTP_URL = process.env.NEXT_PUBLIC_FTP_BASE_URL || 'https://iot.rex-royal.ch:8787';

export const ENVIRONMENT_PRESETS: readonly EnvironmentPreset[] = [
  {
    id: 'iot',
    label: 'Rex-Royal Cloud (iot.rex-royal.ch)',
    tbUrl: DEFAULT_TB_URL,
    ftpUrl: DEFAULT_FTP_URL,
  },
  {
    id: 'custom',
    label: 'Custom Server URLs',
    tbUrl: '',
    ftpUrl: '',
  },
];

export const SELECTION_STORAGE_KEY = 'rr_dynamic_pricing_selected_machines_v1';
export const MACHINE_SNAPSHOTS_STORAGE_KEY = 'rr_dynamic_pricing_machine_snapshots_v5';
export const WORKSPACE_STATE_STORAGE_KEY = 'rr_dynamic_pricing_workspace_state_v3';
export const DEPLOYMENT_BATCHES_STORAGE_KEY = 'rr_dynamic_pricing_batches_v1';
export const SCHEDULED_JOBS_STORAGE_KEY = 'rr_dynamic_pricing_schedules_v1';
export const MAX_STORED_BATCHES = 25;

export const DEFAULT_SELECTED_MACHINE_IDS: readonly string[] = [];

export interface SavedSessionState {
  envPreset?: EnvironmentPreset['id'];
  tbBaseUrl?: string;
  ftpBaseUrl?: string;
  jwtToken?: string;
  refreshToken?: string | null;
  selectedCustomerId?: string;
}

export interface PersistedWorkspaceState {
  groupByMachineId?: Record<string, string>;
  activeWorkspaceView?: 'fleet' | 'pricing';
  activeClusterIndex?: number;
}

/** Reset cached config/layout metadata on a fleet machine so it can be freshly fetched. */
export function stripConfigCache(machine: FleetMachine): FleetMachine {
  return {
    ...machine,
    rawConfigJson: null,
    layout: null,
    configLoaded: false,
    configSource: undefined,
    unavailableReason: undefined,
  };
}

/** Return the primary human-readable identifier for a fleet machine (`serialNumber || name || id`). */
export function formatMachineLabel(machine: FleetMachine): string {
  return machine.serialNumber || machine.name || machine.id;
}

/** Return the composite display label (`serial · name`) with model/id fallback. */
export function formatMachineReadableLabel(machine: FleetMachine): string {
  return (
    [machine.serialNumber, machine.name].filter(Boolean).join(' · ') ||
    `${machine.modelTypeDisplay} (${machine.id.slice(0, 6)})`
  );
}

/**
 * Format a `Date` or ISO date string into a `YYYY-MM-DDTHH:mm` local `<input type="datetime-local">` value.
 * When `input` is omitted or invalid, defaults to 15 minutes from now.
 */
export function formatDateToLocalInput(
  input?: Date | string,
  defaultOffsetMinutes = 15
): string {
  const fallback = () => new Date(Date.now() + defaultOffsetMinutes * 60_000);
  let date: Date;

  if (input instanceof Date) {
    date = Number.isFinite(input.getTime()) ? input : fallback();
  } else if (typeof input === 'string') {
    const ms = Date.parse(input);
    date = Number.isFinite(ms) ? new Date(ms) : fallback();
  } else {
    date = fallback();
  }

  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  const hh = String(date.getHours()).padStart(2, '0');
  const min = String(date.getMinutes()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}T${hh}:${min}`;
}

function readJson<T>(kind: 'local' | 'session', key: string, fallback: T): T {
  if (typeof window === 'undefined') return fallback;
  try {
    const raw = (kind === 'local' ? localStorage : sessionStorage).getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(kind: 'local' | 'session', key: string, value: unknown): void {
  if (typeof window === 'undefined') return;
  try {
    (kind === 'local' ? localStorage : sessionStorage).setItem(key, JSON.stringify(value));
  } catch {
    // Ignore storage quota errors
  }
}

export function readSavedSessionState(): SavedSessionState | null {
  return readJson<SavedSessionState | null>('session', SESSION_STORAGE_KEY, null);
}

export function writeSavedSessionState(state: SavedSessionState): void {
  writeJson('session', SESSION_STORAGE_KEY, state);
}

export function clearSavedSessionStorage(): void {
  if (typeof window === 'undefined') return;
  try {
    sessionStorage.removeItem(SESSION_STORAGE_KEY);
  } catch {
    // Ignore storage errors
  }
}

export function readSavedSelectionForCustomer(customerId: string): Set<string> {
  if (!customerId || typeof window === 'undefined') return new Set();
  try {
    const raw =
      localStorage.getItem(SELECTION_STORAGE_KEY) ||
      sessionStorage.getItem(SELECTION_STORAGE_KEY);
    if (!raw) return new Set();
    const map = JSON.parse(raw) as Record<string, string[]>;
    const list = Array.isArray(map?.[customerId]) ? map[customerId] : [];
    return new Set(list);
  } catch {
    return new Set();
  }
}

export function writeSavedSelectionForCustomer(
  customerId: string,
  selectedSet: Set<string>
): void {
  if (!customerId || typeof window === 'undefined') return;
  const map = readJson<Record<string, string[]>>(
    'local',
    SELECTION_STORAGE_KEY,
    readJson<Record<string, string[]>>('session', SELECTION_STORAGE_KEY, {})
  );
  map[customerId] = Array.from(selectedSet || []);
  writeJson('local', SELECTION_STORAGE_KEY, map);
  writeJson('session', SELECTION_STORAGE_KEY, map);
}

export function sanitizeMachineSnapshot(snap: FleetMachine): FleetMachine {
  if (
    snap &&
    (isSyntheticSampleConfig(snap.rawConfigJson) ||
      snap.configSource === 'sample' ||
      snap.configSource === 'unavailable')
  ) {
    return stripConfigCache(snap);
  }
  return snap;
}

export function readSavedDeploymentBatches(): TrackedDeploymentBatch[] {
  const parsed = readJson<TrackedDeploymentBatch[]>('local', DEPLOYMENT_BATCHES_STORAGE_KEY, []);
  return Array.isArray(parsed) ? parsed.slice(0, MAX_STORED_BATCHES) : [];
}

export function writeSavedDeploymentBatches(
  batches: readonly TrackedDeploymentBatch[]
): void {
  writeJson('local', DEPLOYMENT_BATCHES_STORAGE_KEY, batches.slice(0, MAX_STORED_BATCHES));
}

export function readSavedScheduledJobs(): ScheduledPricingJob[] {
  const parsed = readJson<ScheduledPricingJob[]>('local', SCHEDULED_JOBS_STORAGE_KEY, []);
  return Array.isArray(parsed) ? parsed : [];
}

export function writeSavedScheduledJobs(jobs: readonly ScheduledPricingJob[]): void {
  writeJson('local', SCHEDULED_JOBS_STORAGE_KEY, jobs);
}

export function readSavedMachineSnapshots(): Record<string, FleetMachine> {
  if (typeof window === 'undefined') return {};
  try {
    localStorage.removeItem('rr_dynamic_pricing_machine_snapshots_v3');
    localStorage.removeItem('rr_dynamic_pricing_machine_snapshots_v4');
  } catch {
    // Ignore storage errors
  }
  const parsed = readJson<Record<string, FleetMachine>>('local', MACHINE_SNAPSHOTS_STORAGE_KEY, {});
  const clean: Record<string, FleetMachine> = {};
  for (const [id, snap] of Object.entries(parsed)) {
    if (snap?.id) clean[id] = sanitizeMachineSnapshot(snap);
  }
  return clean;
}

export function writeSavedMachineSnapshots(machinesList: readonly FleetMachine[]): void {
  if (typeof window === 'undefined') return;
  const existing = readSavedMachineSnapshots();
  for (const m of machinesList) {
    if (m?.id) existing[m.id] = sanitizeMachineSnapshot(m);
  }
  writeJson('local', MACHINE_SNAPSHOTS_STORAGE_KEY, existing);
}

export function readSavedWorkspaceState(): PersistedWorkspaceState {
  if (typeof window === 'undefined') return {};
  try {
    localStorage.removeItem('rr_dynamic_pricing_workspace_state_v1');
    localStorage.removeItem('rr_dynamic_pricing_workspace_state_v2');
  } catch {
    // Ignore storage errors
  }
  return readJson<PersistedWorkspaceState>('local', WORKSPACE_STATE_STORAGE_KEY, {});
}

export function writeSavedWorkspaceState(state: PersistedWorkspaceState): void {
  writeJson('local', WORKSPACE_STATE_STORAGE_KEY, state);
}
