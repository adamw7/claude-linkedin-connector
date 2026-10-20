import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { UserInputError } from '../errors.js';
import { extractZipEntry, isZip } from './zip.js';

/** One row of the Connections.csv file in LinkedIn's "Get a copy of your data" export. */
export interface Connection {
  firstName: string;
  lastName: string;
  name: string;
  profileUrl?: string;
  email?: string;
  company?: string;
  position?: string;
  /** YYYY-MM-DD, or the export's own text when it is not a recognizable date. */
  connectedOn?: string;
}

export const MAX_CONNECTIONS_BYTES = 20 * 1024 * 1024;
/** The largest export archive read whole, to take Connections.csv out of it; the complete export holds much more. */
export const MAX_EXPORT_BYTES = 100 * 1024 * 1024;

const isConnectionsCsv = (path: string) => /(^|\/)connections\.csv$/i.test(path);
/** LinkedIn names its archives Basic_LinkedInDataExport_MM-DD-YYYY.zip and Complete_LinkedInDataExport_….zip. */
const EXPORT_NAME = /linkedindataexport/i;

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

const COLUMNS = {
  firstName: ['first name'],
  lastName: ['last name'],
  profileUrl: ['url', 'profile url'],
  email: ['email address', 'email'],
  company: ['company'],
  position: ['position'],
  connectedOn: ['connected on'],
} satisfies Record<keyof Omit<Connection, 'name'>, string[]>;

/** Splits CSV text into rows of cells (RFC 4180: quoted fields may hold commas, quotes and line breaks). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (quoted) {
      if (char !== '"') cell += char;
      else if (text[i + 1] === '"') {
        cell += '"';
        i++;
      } else quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === ',') {
      row.push(cell);
      cell = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += char;
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

/** Converts the export's dates ("15 Oct 2026", or "15-Oct-26" in older exports) to YYYY-MM-DD. */
export function parseConnectedOn(value: string): string | undefined {
  const match = /^(\d{1,2})[ -]([a-z]{3})[a-z]*\.?[ -](\d{4}|\d{2})$/i.exec(value.trim());
  if (match) {
    const month = MONTHS.indexOf(match[2]!.toLowerCase());
    if (month < 0) return undefined;
    const year = match[3]!.length === 2 ? 2000 + Number(match[3]) : Number(match[3]);
    return isoDate(year, month + 1, Number(match[1]));
  }
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  return iso ? isoDate(Number(iso[1]), Number(iso[2]), Number(iso[3])) : undefined;
}

function isoDate(year: number, month: number, day: number): string | undefined {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return undefined;
  return date.toISOString().slice(0, 10);
}

/**
 * Parses LinkedIn's Connections.csv. The export starts with a few "Notes" lines before the header row,
 * so the header is located by its column names rather than assumed to be first.
 */
export function parseConnections(data: Buffer | string): Connection[] {
  if (Buffer.isBuffer(data) && isZip(data)) {
    const csv = extractZipEntry(data, isConnectionsCsv, MAX_CONNECTIONS_BYTES);
    if (!csv) {
      throw new UserInputError(
        'This zip archive has no Connections.csv. Request your data again on LinkedIn under Settings → Data privacy → Get a copy of your data, and include Connections.',
      );
    }
    data = csv;
  } else if (data.length > MAX_CONNECTIONS_BYTES) {
    throw new UserInputError(`The file is larger than ${MAX_CONNECTIONS_BYTES / 1024 / 1024} MB.`);
  }
  const text = (Buffer.isBuffer(data) ? data.toString('utf8') : data).replace(/^﻿/, '');
  const rows = parseCsv(text);
  const headerIndex = rows.findIndex((row) => {
    const cells = row.map(normalize);
    return cells.includes('first name') && cells.includes('last name');
  });
  if (headerIndex < 0) {
    // Never echo the content: in local mode this may be any file on the user's disk.
    throw new UserInputError(
      'This is not a LinkedIn Connections.csv: no "First Name,Last Name,..." header row was found. Download it from LinkedIn under Settings → Data privacy → Get a copy of your data.',
    );
  }
  const header = rows[headerIndex]!.map(normalize);
  const column = (names: string[]) => header.findIndex((cell) => names.includes(cell));
  const indexes = Object.fromEntries(Object.entries(COLUMNS).map(([key, names]) => [key, column(names)])) as Record<
    keyof typeof COLUMNS,
    number
  >;

  const connections: Connection[] = [];
  for (const row of rows.slice(headerIndex + 1)) {
    const get = (key: keyof typeof COLUMNS) => {
      const value = indexes[key] >= 0 ? row[indexes[key]]?.trim() : undefined;
      return value || undefined;
    };
    const firstName = get('firstName') ?? '';
    const lastName = get('lastName') ?? '';
    const profileUrl = get('profileUrl');
    if (!firstName && !lastName && !profileUrl) continue;
    const connectedOn = get('connectedOn');
    connections.push({
      firstName,
      lastName,
      name: [firstName, lastName].filter(Boolean).join(' '),
      profileUrl,
      email: get('email'),
      company: get('company'),
      position: get('position'),
      connectedOn: connectedOn && (parseConnectedOn(connectedOn) ?? connectedOn),
    });
  }
  return connections;
}

function normalize(cell: string): string {
  return cell.trim().toLowerCase();
}

// Letters that Unicode does not decompose into a base letter plus an accent.
const UNDECOMPOSED: Record<string, string> = { ł: 'l', đ: 'd', ø: 'o', ß: 'ss', æ: 'ae', œ: 'oe', ı: 'i', þ: 'th' };

/** Lowercases text and strips accents ("Łódź" → "lodz") so searches match however names are typed. */
export function foldText(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/[łđøßæœıþ]/g, (char) => UNDECOMPOSED[char]!)
    .replace(/\s+/g, ' ')
    .trim();
}

const WORD_CHARACTER = /[\p{L}\p{N}]/u;

/**
 * Whether `term` starts a word in `text` (both folded): "ing" finds "ing bank" but not "boeing", and "ey" finds "ey"
 * but not "disney", which plain substring matching would. A term that starts with a symbol ("@gmail") may match anywhere.
 */
export function matchesWordStart(text: string, term: string): boolean {
  for (let index = text.indexOf(term); index >= 0; index = text.indexOf(term, index + 1)) {
    if (index === 0 || !WORD_CHARACTER.test(text[index - 1]!) || !WORD_CHARACTER.test(term[0]!)) return true;
  }
  return false;
}

export interface CompanyCount {
  company: string;
  count: number;
}

/**
 * Counts connections per company, most first. Spellings that differ only in case, accents or spacing are
 * one company, shown under its most common spelling. Connections without a company are not counted.
 */
export function countCompanies(connections: Connection[]): CompanyCount[] {
  const groups = new Map<string, { count: number; spellings: Map<string, number> }>();
  for (const { company } of connections) {
    if (!company) continue;
    const key = foldText(company);
    const group = groups.get(key) ?? { count: 0, spellings: new Map<string, number>() };
    group.count += 1;
    group.spellings.set(company, (group.spellings.get(company) ?? 0) + 1);
    groups.set(key, group);
  }
  return [...groups.values()]
    .map(({ count, spellings }) => ({
      company: [...spellings].reduce((best, entry) => (entry[1] > best[1] ? entry : best))[0],
      count,
    }))
    .sort((a, b) => b.count - a.count || a.company.localeCompare(b.company));
}

/**
 * Finds the newest LinkedIn export in these folders: a Connections.csv or export archive directly in one, or the
 * Connections.csv in an extracted export folder. Returns its path, or undefined when there is none.
 */
export async function findConnectionsExport(dirs: string[]): Promise<string | undefined> {
  const candidates: string[] = [];
  for (const dir of dirs) {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isFile() && (isConnectionsCsv(entry.name) || (EXPORT_NAME.test(entry.name) && /\.zip$/i.test(entry.name)))) {
        candidates.push(path);
      } else if (entry.isDirectory() && EXPORT_NAME.test(entry.name)) {
        candidates.push(join(path, 'Connections.csv'));
      }
    }
  }
  let newest: { path: string; modified: number } | undefined;
  for (const path of candidates) {
    const info = await stat(path).catch(() => undefined);
    if (info?.isFile() && (!newest || info.mtimeMs > newest.modified)) newest = { path, modified: info.mtimeMs };
  }
  return newest?.path;
}
