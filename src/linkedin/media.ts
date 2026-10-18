import { readFile, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
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
  /**
   * Folders local file paths may point into (stdio mode only: a remote server must never read its own disk).
   * Undefined forbids local files altogether.
   */
  localFileDirs?: string[];
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

/** A `%` that doesn't start an escape (e.g. `100%.png`) is kept as is rather than failing the download. */
function decodeFilename(name: string): string {
  try {
    return decodeURIComponent(name);
  } catch {
    return name;
  }
}

export function expandHome(path: string): string {
  return path === '~' || path.startsWith('~/') || path.startsWith('~\\') ? homedir() + path.slice(1) : path;
}

/** Whether `path` is `dir` or lies somewhere below it. */
export function isInside(dir: string, path: string): boolean {
  const rel = relative(dir, path);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** Whether `path` (already resolved) lies in one of `dirs`, comparing real paths so symlinks can't lead outside. */
async function inAllowedDir(path: string, dirs: string[]): Promise<boolean> {
  for (const dir of dirs) {
    const real = await realpath(dir).catch(() => undefined);
    if (real !== undefined && isInside(real, path)) return true;
  }
  return false;
}

/** Reads up to `maxBytes` from a local path (when allowed), an http(s) URL or a base64 data: URI. */
export async function readSource(
  source: string,
  maxBytes: number,
  noun: string,
  options: MediaSourceOptions,
): Promise<{ data: Buffer; filename?: string }> {
  const trimmed = source.trim();

  // The media type may carry parameters (`data:text/csv;charset=utf-8;base64,…`); `;base64` comes last.
  const dataUri = /^data:([^,]*?)(;base64)?,(.*)$/s.exec(trimmed);
  if (dataUri) {
    if (!dataUri[2]) throw new UserInputError('Only base64-encoded data: URIs are supported.');
    const data = Buffer.from(dataUri[3]!, 'base64');
    if (data.length > maxBytes) throw new UserInputError(`The ${noun} is larger than ${maxBytes / 1024 / 1024} MB.`);
    return { data };
  }

  if (/^https?:\/\//i.test(trimmed)) {
    const result = await safeFetch(trimmed, { maxBytes, timeoutMs: 60_000, allowPrivateNetwork: options.allowPrivateNetwork });
    const name = basename(new URL(result.url).pathname);
    return { data: result.data, filename: name ? decodeFilename(name) : undefined };
  }

  const dirs = options.localFileDirs;
  if (dirs === undefined) {
    throw new UserInputError(`"${source}" is not an http(s) URL or base64 data: URI. Local files cannot be read by a remote connector.`);
  }
  const path = trimmed.startsWith('file://') ? fileURLToPath(trimmed) : expandHome(trimmed);
  const relativePath = !isAbsolute(path);
  const absolute = relativePath ? resolve(options.cwd ?? process.cwd(), path) : path;
  const outside = () =>
    new UserInputError(
      `${absolute} is outside the folders this connector may read files from (${dirs.join(', ') || 'none'}). ` +
        'Move the file into one of them, or add its folder to LINKEDIN_FILE_DIRS.',
    );
  let real: string;
  let size: number;
  try {
    real = await realpath(absolute);
    // Checked before anything else about the file, so a path outside the folders reveals nothing about it.
    if (!(await inAllowedDir(real, dirs))) throw outside();
    const info = await stat(real);
    if (!info.isFile()) throw new UserInputError(`${absolute} is not a file.`);
    size = info.size;
  } catch (error) {
    if (error instanceof UserInputError) throw error;
    // Not even whether it exists.
    if (!dirs.some((dir) => isInside(resolve(dir), absolute))) throw outside();
    const { code, message } = error as NodeJS.ErrnoException;
    const reason = code === 'ENOENT' ? 'the file does not exist' : code === 'EACCES' ? 'permission denied' : message;
    // The server's working directory is rarely the user's (Claude Desktop starts it in /).
    const hint = relativePath ? ` "${path}" was resolved against ${dirname(absolute)}; pass an absolute path instead.` : '';
    throw new UserInputError(`Cannot read ${absolute}: ${reason}.${hint}`);
  }
  if (size > maxBytes) throw new UserInputError(`${absolute} is larger than ${maxBytes / 1024 / 1024} MB.`);
  return { data: await readFile(real), filename: basename(absolute) };
}

/**
 * Loads an image or document from a local path (stdio mode), an http(s) URL
 * or a base64 data: URI, and verifies from its bytes that it is a format
 * LinkedIn accepts, so arbitrary files can never be uploaded.
 */
export async function loadMedia(source: string, kind: MediaKind, options: MediaSourceOptions): Promise<LoadedMedia> {
  const { data, filename } = await readSource(source, MAX_BYTES[kind], kind, options);
  const mimeType = kind === 'image' ? sniffImage(data) : sniffDocument(data);
  if (!mimeType) {
    const expected = kind === 'image' ? 'JPEG, PNG or GIF image' : `${DOCUMENT_TYPES} document`;
    const actual = identifyUnsupported(data, kind);
    throw new UserInputError(`"${shorten(source)}" is ${actual ? `${actual.what}, ` : ''}not a ${expected}.${actual ? ` ${actual.fix}` : ''}`);
  }
  return { data, mimeType, filename };
}

const CONVERT = 'Convert it to JPEG or PNG first (on a Mac, open it in Preview and choose File → Export).';
const EXPORT_PDF = 'Export it as PDF first.';
const NAMES: Record<string, string> = {
  'image/jpeg': 'a JPEG image',
  'image/png': 'a PNG image',
  'image/gif': 'a GIF image',
  'application/pdf': 'a PDF',
  'application/x-ole-storage': 'an Office document',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'a Word document',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'a PowerPoint presentation',
};

/** Recognizes files people often try to post that LinkedIn won't take, so the error can say what to do instead. */
function identifyUnsupported(data: Buffer, kind: MediaKind): { what: string; fix: string } | undefined {
  const other = kind === 'image' ? sniffDocument(data) : sniffImage(data);
  if (other) return { what: NAMES[other]!, fix: kind === 'image' ? "Attach it as the post's document instead." : 'Attach it under images instead.' };
  const head = data.subarray(0, 1024).toString('latin1');
  // ISO media files (HEIC, AVIF, MP4, MOV) name their format in the `ftyp` box.
  const brand = head.slice(4, 8) === 'ftyp' ? head.slice(8, 12) : '';
  if (/<!doctype html|<html[\s>]/i.test(head)) {
    return {
      what: 'a web page',
      fix: 'Pass a link to the file itself: for a picture on a web page, right-click it and copy the image address. Share links from cloud drives usually lead to a page.',
    };
  }
  if (/^(heic|heix|hevc|hevx|heim|heis|mif1|msf1)$/.test(brand)) return { what: 'a HEIC image', fix: CONVERT };
  if (/^avi[fs]$/.test(brand)) return { what: 'an AVIF image', fix: CONVERT };
  if (/^(isom|iso\d|mp4[12]|avc1|qt {2}|M4V |3gp\d|mmp4|dash)$/.test(brand)) return { what: 'a video', fix: 'Video posts are not supported yet.' };
  if (head.startsWith('RIFF') && head.slice(8, 12) === 'WEBP') return { what: 'a WebP image', fix: CONVERT };
  if (head.startsWith('II*\0') || head.startsWith('MM\0*')) return { what: 'a TIFF image', fix: CONVERT };
  if (head.startsWith('BM') && data.length >= 6 && data.readUInt32LE(2) === data.length) return { what: 'a BMP image', fix: CONVERT };
  if (/<svg[\s>]/i.test(head)) return { what: 'an SVG image', fix: 'Convert it to PNG first.' };
  if (head.startsWith('PK\x03\x04')) {
    if (data.includes('Index/Document.iwa')) return { what: 'a Keynote, Pages or Numbers file', fix: EXPORT_PDF };
    if (head.slice(30, 38) === 'mimetype' && head.includes('application/vnd.oasis.opendocument')) {
      return { what: 'an OpenDocument file', fix: EXPORT_PDF };
    }
    if (data.includes('[Content_Types].xml') && data.includes('xl/')) return { what: 'an Excel spreadsheet', fix: EXPORT_PDF };
    return { what: 'a zip archive', fix: 'Extract the file from it first.' };
  }
  return undefined;
}

/** Keeps the start of a long data: URI (its media type) and the end of a long path or URL (the file name). */
function shorten(source: string): string {
  if (source.length <= 80) return source;
  return source.startsWith('data:') ? `${source.slice(0, 77)}...` : `...${source.slice(-77)}`;
}
