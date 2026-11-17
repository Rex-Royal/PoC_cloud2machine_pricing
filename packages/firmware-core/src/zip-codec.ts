/**
 * PKZIP archive adapter for Rex-Royal partial pricing backups (`add_*.zip`)
 * and machine backup extraction (`Backup_MN*.zip`), backed by `fflate`.
 */

import { inflateSync, unzipSync, zipSync } from 'fflate';
import {
  MachineConfigFile,
  type PartialBackupZipPackage,
  type PriceListJson,
} from './types.ts';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const isTargetTextFile = (name: string): boolean => /\.(json|txt|csv|xml)$/i.test(name);

/**
 * Normalizes a partial backup filename to begin with `add_` (unless `import_` is already used).
 * Golden Guardrail #1: omitting `add_` / `import_` causes coffee machine firmware to perform
 * a full restore that deletes custom icons, videos, and layout XML files.
 */
export function ensureSafePartialBackupFilename(rawName?: string): string {
  const base = String(rawName || 'add_priceListCustom.zip').trim().replace(/^.*[\\/]/, '');
  const prefixed = base.startsWith('add_') || base.startsWith('import_') ? base : `add_${base}`;
  return prefixed.endsWith('.zip') ? prefixed : `${prefixed}.zip`;
}

export function buildZipArchive(filesMap: Record<string, string | Uint8Array>): Uint8Array {
  const fflateInput: Record<string, Uint8Array> = {};
  for (const [name, content] of Object.entries(filesMap)) {
    fflateInput[name] = content instanceof Uint8Array ? content : encoder.encode(String(content));
  }
  return zipSync(fflateInput, { level: 0 });
}

/**
 * Packages `priceList.json` at the root of an `add_priceList_*.zip` partial backup archive.
 */
export function createPartialPricingBackupZip(
  priceListObject: PriceListJson | Record<string, unknown>,
  desiredFilename = 'add_priceListCustom.zip'
): PartialBackupZipPackage {
  const safeFileName = ensureSafePartialBackupFilename(desiredFilename);
  const jsonContent = JSON.stringify(priceListObject, null, 2);
  const zipBytes = buildZipArchive({ [MachineConfigFile.PriceListJson]: jsonContent });

  return Object.freeze({
    fileName: safeFileName,
    jsonContent,
    zipBytes,
    byteLength: zipBytes.byteLength,
  });
}

function decodeZipEntries(
  bytes: Uint8Array,
  filterFn: (name: string) => boolean
): Record<string, string> {
  const raw = unzipSync(bytes, { filter: (file) => filterFn(file.name) });
  const out: Record<string, string> = {};
  for (const [name, data] of Object.entries(raw)) {
    out[name] = decoder.decode(data);
  }
  return out;
}

/** Fallback walker for stripped ZIPs without an End-of-Central-Directory record. */
function readLocalFileHeadersFallback(bytes: Uint8Array): Record<string, string> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const extracted: Record<string, string> = {};
  let offset = 0;

  while (offset + 30 <= bytes.byteLength && view.getUint32(offset, true) === 0x04034b50) {
    const method = view.getUint16(offset + 8, true);
    const compSize = view.getUint32(offset + 18, true);
    const nameLen = view.getUint16(offset + 26, true);
    const extraLen = view.getUint16(offset + 28, true);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLen + extraLen;
    const nextOffset = dataStart + compSize;
    if (compSize === 0 || nextOffset > bytes.byteLength) break;

    const fileName = decoder.decode(bytes.subarray(nameStart, nameStart + nameLen));
    if (isTargetTextFile(fileName)) {
      const slice = bytes.subarray(dataStart, nextOffset);
      if (method === 0) extracted[fileName] = decoder.decode(slice);
      else if (method === 8) extracted[fileName] = decoder.decode(inflateSync(slice));
    }
    offset = nextOffset;
  }

  return extracted;
}

export function readStoredZipArchive(zipBytes: Uint8Array | ArrayBuffer): Record<string, string> {
  const bytes = zipBytes instanceof Uint8Array ? zipBytes : new Uint8Array(zipBytes);
  try {
    return decodeZipEntries(bytes, () => true);
  } catch {
    return readLocalFileHeadersFallback(bytes);
  }
}

export async function readZipArchiveAsync(
  zipBytes: Uint8Array | ArrayBuffer
): Promise<Record<string, string>> {
  const bytes = zipBytes instanceof Uint8Array ? zipBytes : new Uint8Array(zipBytes);
  try {
    const entries = decodeZipEntries(bytes, isTargetTextFile);
    if (Object.keys(entries).length > 0) return entries;
  } catch {
    // Fallback below when Central Directory / EOCD is absent
  }
  return readLocalFileHeadersFallback(bytes);
}
