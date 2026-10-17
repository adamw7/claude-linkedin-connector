import { UserInputError } from '../errors.js';

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
  if (Buffer.isBuffer(data) && data.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) {
    throw new UserInputError('This is the zip archive LinkedIn sent. Extract Connections.csv from it and pass that file instead.');
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
