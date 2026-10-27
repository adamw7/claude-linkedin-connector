import { zipArchive } from '../../test/helpers/zip.js';

/** LinkedIn caps a member's 1st-degree connections at 30,000, so no Connections.csv is larger. */
export const MAX_CONNECTIONS = 30_000;

const FIRST_NAMES = ['Ada', 'Grace', 'Alan', 'Zoë', 'José', 'Łukasz', 'Małgorzata', 'Søren', 'Chloé', 'Mohammed', 'Wei', 'Priya', 'Olumide', 'Anna', 'Jan', 'Ingrid'];
const LAST_NAMES = ['Lovelace', 'Hopper', 'Turing', 'Nowak', 'Kowalski', 'Müller', 'García', 'Ødegaard', 'Dubois', 'Chen', 'Patel', 'Okafor', 'Smith', 'Jansen', "O'Brien"];
/** Most connections work at a few companies; some names need quoting, and "ING" is a word start in one but not in "Boeing". */
const COMPANIES = ['ING Bank', 'Analytical Engines', 'Boeing', 'Société Générale', 'Acme, Inc.', 'Siemens', 'Allegro', 'Zalando', 'Northwind Traders', 'Contoso'];
const POSITIONS = ['Software Engineer', 'Engineering Manager', 'Product Manager, Payments', 'Head of "Growth"', 'Data Scientist', 'Recruiter', 'Founder & CEO'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** A seeded pseudo-random number generator (mulberry32), so every run benchmarks the same file. */
function random(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const field = (value: string) => (/[",\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value);

/** A Connections.csv with `count` connections, newest first, as LinkedIn's data export writes it. */
export function connectionsCsv(count: number): string {
  const next = random(count);
  const pick = <T>(items: T[], skew = 1) => items[Math.floor(next() ** skew * items.length)]!;
  const lines = [
    '﻿Notes:',
    '"When exporting your connection data, you may notice that some of the email addresses are missing. You will only see email addresses for connections who have allowed their connections to see or download their email address."',
    '',
    'First Name,Last Name,URL,Email Address,Company,Position,Connected On',
  ];
  // Four connections a day, going back from 1 October 2026: 30,000 reach back to 2006.
  const newest = Date.UTC(2026, 9, 1);
  for (let index = 0; index < count; index++) {
    const first = pick(FIRST_NAMES);
    const last = pick(LAST_NAMES);
    const handle = `${first}-${last}-${index}`.normalize('NFKD').replace(/[^A-Za-z0-9-]/g, '').toLowerCase();
    const email = next() < 0.1 ? `${handle}@example.com` : '';
    const company = next() < 0.05 ? '' : pick(COMPANIES, 2);
    const date = new Date(newest - Math.floor((index * 86_400_000) / 4));
    const connectedOn = `${String(date.getUTCDate()).padStart(2, '0')} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
    lines.push([first, last, `https://www.linkedin.com/in/${handle}`, email, company, pick(POSITIONS), connectedOn].map(field).join(','));
  }
  return lines.join('\n');
}

/** LinkedIn's data export archive: Connections.csv among the other files, here about a megabyte of messages. */
export function exportArchive(csv: string): Buffer {
  const message = 'CONVERSATION ID,FROM,TO,DATE,CONTENT\n' + 'abc,Ada Lovelace,Grace Hopper,2026-10-01 09:00:00 UTC,"Shall we meet at the conference?"\n'.repeat(12_000);
  return zipArchive({ 'Profile.csv': 'First Name,Last Name\nAda,Lovelace\n', 'messages.csv': message, 'Connections.csv': csv });
}
