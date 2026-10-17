import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { UserInputError } from '../errors.js';
import { safeFetch } from '../net/safe-fetch.js';

export type MediaKind = 'image' | 'document';

export const MAX_BYTES: Record<MediaKind, number> = {
  image: 20 * 1024 * 1024,
  document: 100 * 1024 * 1024,
};

export interface LoadedMedia {
  data: Buffer;
  mimeType: string;
  /** File name from the path or URL, when there is one. */
  filename?: string;
}

export interface MediaSourceOptions {
  /** Read local file paths (stdio mode only: a remote server must never read its own disk). */
  allowLocalFiles: boolean;
  allowPrivateNetwork?: boolean;
  cwd?: string;
}

const DOCUMENT_TYPES = 'PDF, DOC, DOCX, PPT or PPTX';

/** Identifies the image formats LinkedIn accepts from their magic bytes. */
export function sniffImage(data: Uint8Array): string | undefined {
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg';
  if (data.length >= 8 && Buffer.from(data.subarray(0, 8)).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png';
  }
  const head = Buffer.from(data.subarray(0, 6)).toString('latin1');
  if (head === 'GIF87a' || head === 'GIF89a') return 'image/gif';
  return undefined;
}

/** Identifies the document formats LinkedIn accepts from their content. */
export function sniffDocument(data: Uint8Array): string | undefined {
  const buffer = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (buffer.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  if (buffer.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))) {
    // Legacy binary Office (DOC/PPT); LinkedIn determines which on its side.
    return 'application/x-ole-storage';
  }
  if (buffer.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])) && buffer.includes('[Content_Types].xml')) {
    if (buffer.includes('word/')) return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    if (buffer.includes('ppt/')) return 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
  }
  return undefined;
}

function expandHome(path: string): string {
  return path === '~' || path.startsWith('~/') || path.startsWith('~\\') ? homedir() + path.slice(1) : path;
}

async function readSource(source: string, kind: MediaKind, options: MediaSourceOptions): Promise<{ data: Buffer; filename?: string }> {
  const maxBytes = MAX_BYTES[kind];
  const trimmed = source.trim();

  const dataUri = /^data:([^;,]*)(;base64)?,(.*)$/s.exec(trimmed);
  if (dataUri) {
    if (!dataUri[2]) throw new UserInputError('Only base64-encoded data: URIs are supported.');
    const data = Buffer.from(dataUri[3]!, 'base64');
    if (data.length > maxBytes) throw new UserInputError(`The ${kind} is larger than ${maxBytes / 1024 / 1024} MB.`);
    return { data };
  }

  if (/^https?:\/\//i.test(trimmed)) {
    const result = await safeFetch(trimmed, {
      maxBytes,
      timeoutMs: 60_000,
      ...(options.allowPrivateNetwork ? { allowPrivateNetwork: true } : {}),
    });
    const name = basename(new URL(result.url).pathname);
    return { data: result.data, ...(name ? { filename: decodeURIComponent(name) } : {}) };
  }

  if (!options.allowLocalFiles) {
    throw new UserInputError(`"${source}" is not an http(s) URL or base64 data: URI. Local files cannot be read by a remote connector.`);
  }
  const path = trimmed.startsWith('file://') ? fileURLToPath(trimmed) : expandHome(trimmed);
  const absolute = isAbsolute(path) ? path : resolve(options.cwd ?? process.cwd(), path);
  let size: number;
  try {
    const info = await stat(absolute);
    if (!info.isFile()) throw new UserInputError(`${absolute} is not a file.`);
    size = info.size;
  } catch (error) {
    if (error instanceof UserInputError) throw error;
    throw new UserInputError(`Cannot read ${absolute}: ${(error as Error).message}`);
  }
  if (size > maxBytes) throw new UserInputError(`${absolute} is larger than ${maxBytes / 1024 / 1024} MB.`);
  return { data: await readFile(absolute), filename: basename(absolute) };
}

/**
 * Loads an image or document from a local path (stdio mode), an http(s) URL
 * or a base64 data: URI, and verifies from its bytes that it is a format
 * LinkedIn accepts, so arbitrary files can never be uploaded.
 */
export async function loadMedia(source: string, kind: MediaKind, options: MediaSourceOptions): Promise<LoadedMedia> {
  const { data, filename } = await readSource(source, kind, options);
  const mimeType = kind === 'image' ? sniffImage(data) : sniffDocument(data);
  if (!mimeType) {
    const expected = kind === 'image' ? 'JPEG, PNG or GIF image' : `${DOCUMENT_TYPES} document`;
    throw new UserInputError(`"${shorten(source)}" is not a ${expected}.`);
  }
  return { data, mimeType, ...(filename ? { filename } : {}) };
}

function shorten(source: string): string {
  return source.length > 80 ? `${source.slice(0, 77)}...` : source;
}
