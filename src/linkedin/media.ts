import { readFile, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { UserInputError } from '../errors.js';
import { safeFetch } from '../net/safe-fetch.js';
import { expandHome, isInside } from '../paths.js';

export type MediaKind = 'image' | 'document';

const MAX_BYTES: Record<MediaKind, number> = {
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
  home?: string;
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

/** The local path a file: URL names; one with a host (a network share) or an encoded slash names none. */
function fileUrlPath(url: string): string {
  try {
    return fileURLToPath(url);
  } catch (error) {
    throw new UserInputError(`"${url}" is not a local file URL (${(error as Error).message}). Pass the file's path instead.`);
  }
}

/** Whether `path` (already resolved) lies in one of `dirs`, comparing real paths so symlinks can't lead outside. */
async function inAllowedDir(path: string, dirs: string[]): Promise<boolean> {
  for (const dir of dirs) {
    const real = await realpath(dir).catch(() => undefined);
    if (real !== undefined && isInside(real, path)) return true;
  }
  return false;
}

/**
 * The file a relative path such as "photo.jpg" or "Downloads/photo.jpg" names. The working directory comes first, as
 * Claude Code starts the server in the project; but Claude Desktop starts it in /, so otherwise the one file by that
 * path in the allowed folders, or under the home folder, is meant. Nothing outside the folders is looked at.
 */
async function locate(path: string, dirs: string[], cwd: string, home: string, folders: string): Promise<string> {
  /** The real path of an existing candidate inside the folders. */
  const existing = async (candidate: string) =>
    dirs.some((dir) => isInside(resolve(dir), candidate)) ? realpath(candidate).catch(() => undefined) : undefined;
  const inCwd = resolve(cwd, path);
  if ((await existing(inCwd)) !== undefined) return inCwd;
  // By real path, so a folder listed twice, or linked from another, doesn't make the file look ambiguous.
  const found = new Map<string, string>();
  for (const candidate of [home, ...dirs].map((base) => resolve(base, path))) {
    const real = await existing(candidate);
    if (real !== undefined && !found.has(real)) found.set(real, candidate);
  }
  const matches = [...found.values()];
  if (matches.length === 0) throw new UserInputError(`Cannot find "${path}" in ${folders}. If it is somewhere else, pass its full path.`);
  if (matches.length > 1) {
    throw new UserInputError(`"${path}" matches more than one file: ${matches.join(', ')}. Pass the full path of the one you mean.`);
  }
  return matches[0]!;
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
  const path = trimmed.startsWith('file://') ? fileUrlPath(trimmed) : expandHome(trimmed);
  const folders = `the folders this connector may read files from (${dirs.join(', ') || 'none'})`;
  const home = options.home ?? homedir();
  const absolute = isAbsolute(path) ? path : await locate(path, dirs, options.cwd ?? process.cwd(), home, folders);
  const lexicallyInside = dirs.some((dir) => isInside(resolve(dir), absolute));
  const folder = dirname(absolute);
  /** `link`: the path lies in an allowed folder but leads out of it, so allowing its folder wouldn't help. */
  const outside = (link: boolean) => {
    if (link) return new UserInputError(`${absolute} links to a file outside ${folders}. Move or copy the file itself into one of them.`);
    // Allowing the home folder, or one holding it such as /, would let a page Claude reads get any of the user's files posted.
    if (isInside(folder, home)) {
      return new UserInputError(
        `${absolute} is outside ${folders}. Move or copy the file into one of them: allowing ${folder} would let the connector read every file in your home folder.`,
      );
    }
    return new UserInputError(
      `${absolute} is outside ${folders}. Move the file into one of them, or allow its folder by setting ` +
        `"Folders for local files" (LINKEDIN_FILE_DIRS) to ${[...dirs, folder].join(',')}: ` +
        'the setting replaces the folders allowed now rather than adding to them, so this keeps them.',
    );
  };
  let real: string;
  let size: number;
  try {
    real = await realpath(absolute);
    // Checked before anything else about the file, so a path outside the folders reveals nothing about it.
    if (!(await inAllowedDir(real, dirs))) throw outside(lexicallyInside);
    const info = await stat(real);
    if (!info.isFile()) throw new UserInputError(`${absolute} is not a file.`);
    size = info.size;
  } catch (error) {
    if (error instanceof UserInputError) throw error;
    // Not even whether it exists.
    if (!lexicallyInside) throw outside(false);
    const { code, message } = error as NodeJS.ErrnoException;
    const reason = code === 'ENOENT' ? 'the file does not exist' : code === 'EACCES' ? 'permission denied' : message;
    throw new UserInputError(`Cannot read ${absolute}: ${reason}.`);
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
