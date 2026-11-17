/**
 * Encoder, decoder, and state machine for the device asynchronous command queue
 * (`Config/{deviceId}/cmdStack.json`), formatted as `<base64(JSON)>||` entries
 * executed by the machine on connect/boot.
 */

import {
  FtpResourceType,
  MachineRpcMethod,
  MachineSyncState,
  type ApplyBackupRpcCommand,
  type DecodedCmdStackToken,
} from './types.ts';
import { ensureSafePartialBackupFilename } from './zip-codec.ts';

export function encodeUtf8ToBase64(text: string): string {
  const bytes = new TextEncoder().encode(String(text));
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes).toString('base64');
  }
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

export function decodeBase64ToUtf8(base64Str: string): string {
  const cleaned = String(base64Str).trim();
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(cleaned, 'base64').toString('utf8');
  }
  const binary = atob(cleaned);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new TextDecoder().decode(bytes);
}

/**
 * Constructs the MQTT / `cmdStack.json` RPC command payload for applying a partial pricing backup zip.
 */
export function buildApplyPricingRpcCommand(
  customerId: string,
  zipFileName: string
): ApplyBackupRpcCommand {
  const safeFile = ensureSafePartialBackupFilename(zipFileName);
  return Object.freeze({
    method: MachineRpcMethod.ApplyBackup,
    params: Object.freeze({
      customer: String(customerId),
      sourceFile: safeFile,
      type: FtpResourceType.Backup,
    }),
  });
}

export function encodeCommandForCmdStack(
  commandObj: ApplyBackupRpcCommand | Record<string, unknown>
): string {
  return encodeUtf8ToBase64(JSON.stringify(commandObj));
}

function splitCmdStackTokens(rawContent: string): string[] {
  const text = String(rawContent || '').trim();
  if (!text) {
    return [];
  }
  return text
    .split('||')
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

function serializeCmdStackTokens(tokens: readonly string[]): string {
  const clean = tokens.map((t) => t.trim()).filter((t) => t.length > 0);
  return clean.length > 0 ? `${clean.join('||')}||` : '';
}

function asApplyBackupParams(
  command: DecodedCmdStackToken['command']
): { customerId: string; sourceFile: string } | null {
  if (!command || typeof command !== 'object') {
    return null;
  }
  const cmd = command as Partial<ApplyBackupRpcCommand>;
  if (
    cmd.method !== MachineRpcMethod.ApplyBackup ||
    !cmd.params ||
    typeof cmd.params !== 'object'
  ) {
    return null;
  }
  const sourceFile = String(cmd.params.sourceFile || '').trim();
  if (!sourceFile) {
    return null;
  }
  return {
    customerId: String(cmd.params.customer || '').trim(),
    sourceFile,
  };
}

export function appendCommandToCmdStack(
  existingContent: string,
  commandObj: ApplyBackupRpcCommand | Record<string, unknown>
): string {
  const tokens = splitCmdStackTokens(existingContent);
  tokens.push(encodeCommandForCmdStack(commandObj));
  return serializeCmdStackTokens(tokens);
}

export function parseCmdStackContent(rawContent: string): readonly DecodedCmdStackToken[] {
  const tokens = splitCmdStackTokens(rawContent);
  return tokens.map((token, idx): DecodedCmdStackToken => {
    try {
      const decodedJson = token.startsWith('{') ? token : decodeBase64ToUtf8(token);
      const parsed = JSON.parse(decodedJson) as ApplyBackupRpcCommand;
      return Object.freeze({
        index: idx,
        rawToken: token,
        decodedJson,
        command: parsed,
        valid: Boolean(parsed && parsed.method),
      });
    } catch (err) {
      return Object.freeze({
        index: idx,
        rawToken: token,
        decodedJson: null,
        command: null,
        valid: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });
}

/**
 * Extracts all `applyBackup` entries (`customer` + `sourceFile`) currently queued inside `cmdStack.json`.
 */
export function extractQueuedBackupEntriesFromCmdStack(
  rawContent: string
): ReadonlyArray<{ customerId: string; sourceFile: string }> {
  const decoded = parseCmdStackContent(rawContent);
  const results: Array<{ customerId: string; sourceFile: string }> = [];
  for (const item of decoded) {
    if (!item.valid) continue;
    const params = asApplyBackupParams(item.command);
    if (params) {
      results.push(Object.freeze(params));
    }
  }
  return results;
}

/**
 * Removes all commands targeting `sourceFile` from `cmdStack.json` content, returning the remaining serialized stack.
 */
export function removeBackupFileFromCmdStack(
  rawContent: string,
  sourceFile: string
): string {
  const decoded = parseCmdStackContent(rawContent);
  const keptTokens = decoded
    .filter((item) => {
      if (!item.valid) return true;
      const params = asApplyBackupParams(item.command);
      return !params || params.sourceFile !== sourceFile;
    })
    .map((item) => item.rawToken);

  return serializeCmdStackTokens(keptTokens);
}

export interface SyncEvaluationInput {
  hasUnsavedChanges: boolean;
  hasCmdStackOnFtp: boolean;
  wasDispatched: boolean;
  pricesMatchTarget: boolean;
  timedOut?: boolean;
}

export function evaluateMachineSyncState({
  hasUnsavedChanges,
  hasCmdStackOnFtp,
  wasDispatched,
  pricesMatchTarget,
  timedOut = false,
}: SyncEvaluationInput): MachineSyncState {
  if (hasCmdStackOnFtp) {
    return MachineSyncState.Pending;
  }
  if (wasDispatched && !pricesMatchTarget) {
    return timedOut ? MachineSyncState.Failed : MachineSyncState.Processing;
  }
  if (hasUnsavedChanges || !pricesMatchTarget) {
    return MachineSyncState.Desync;
  }
  return MachineSyncState.Synced;
}
