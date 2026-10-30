import { describe, expect, it } from 'vitest';
import { UserInputError } from '../src/errors.js';
import { mkdir, mkdtemp, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  countCompanies,
  findConnectionsExports,
  foldText,
  matchesWordStart,
  NoConnectionsCsvError,
  parseConnectedOn,
  parseConnections,
  parseCsv,
  type Connection,
} from '../src/linkedin/connections.js';
import { CONNECTIONS_CSV } from './helpers/connections.js';
import { zipArchive } from './helpers/zip.js';

describe('parseCsv', () => {
  it('handles quotes, escaped quotes, embedded line breaks and a missing final newline', () => {
    expect(parseCsv('a,"b,c","d ""e""\nf"\r\n1,2,3')).toEqual([
      ['a', 'b,c', 'd "e"\nf'],
      ['1', '2', '3'],
    ]);
  });
});

describe('parseConnectedOn', () => {
  it('reads the export date formats', () => {
    expect(parseConnectedOn('15 Oct 2026')).toBe('2026-10-15');
    expect(parseConnectedOn('3-Feb-24')).toBe('2024-02-03');
    expect(parseConnectedOn('2024-02-03')).toBe('2024-02-03');
    expect(parseConnectedOn('31 Feb 2024')).toBeUndefined();
    expect(parseConnectedOn('yesterday')).toBeUndefined();
  });

  it('reads month names however long, and refuses ones that are not months', () => {
    expect(parseConnectedOn('5 September 2025')).toBe('2025-09-05');
    expect(parseConnectedOn(' 5 Sept. 2025 ')).toBe('2025-09-05');
    expect(parseConnectedOn('29 FEB 2024')).toBe('2024-02-29');
    expect(parseConnectedOn('5 Foo 2025')).toBeUndefined();
    expect(parseConnectedOn('5 Sep 202')).toBeUndefined();
    expect(parseConnectedOn('2025-13-01')).toBeUndefined();
  });
});

describe('parseConnections', () => {
  it('skips the notes preamble and blank rows', () => {
    const connections = parseConnections(Buffer.from(CONNECTIONS_CSV));
    expect(connections).toHaveLength(3);
    expect(connections[0]).toEqual({
      firstName: 'Ada',
      lastName: 'Lovelace',
      name: 'Ada Lovelace',
      profileUrl: 'https://www.linkedin.com/in/ada',
      email: 'ada@example.com',
      company: 'Analytical Engines',
      position: 'Engineer, Lead',
      connectedOn: '2026-10-15',
    });
    expect(connections[1]).toMatchObject({ email: undefined, position: 'Rear Admiral "Amazing Grace"', connectedOn: '2024-02-03' });
    expect(connections[2]!.connectedOn).toBe('2023-06-12');
  });

  it('finds columns by name and keeps unrecognized dates as written', () => {
    const [connection] = parseConnections('Connected On,Last Name,First Name\nsometime,Doe,Jane');
    expect(connection).toMatchObject({ name: 'Jane Doe', connectedOn: 'sometime', company: undefined });
  });

  it('rejects other files without revealing their content', () => {
    expect(() => parseConnections('secret=hunter2\n')).toThrow(UserInputError);
    expect(() => parseConnections('secret=hunter2\n')).not.toThrow(/hunter2/);
  });

  it("reads Connections.csv from LinkedIn's export archive", () => {
    const archive = zipArchive({ 'Profile.csv': 'First Name,Last Name\nNot,This', 'Connections.csv': CONNECTIONS_CSV });
    expect(parseConnections(archive).map((connection) => connection.name)).toEqual(['Ada Lovelace', 'Grace Hopper', 'Alan Turing']);
    expect(() => parseConnections(zipArchive({ 'Profile.csv': 'x' }))).toThrow(
      'This zip archive has no Connections.csv. Request your data again on LinkedIn under Settings → Data privacy → Get a copy of your data, and include Connections.',
    );
    expect(() => parseConnections(zipArchive({ 'Profile.csv': 'x' }))).toThrow(NoConnectionsCsvError);
  });

  it('refuses files larger than 20 MB', () => {
    expect(() => parseConnections(Buffer.alloc(20 * 1024 * 1024 + 1))).toThrow('The file is larger than 20 MB.');
  });
});

describe('findConnectionsExports', () => {
  const at = async (path: string, minutesAgo: number, content = 'x') => {
    await writeFile(path, content);
    const time = new Date(Date.now() - minutesAgo * 60_000);
    await utimes(path, time, time);
  };

  it('finds export archives, Connections.csv files and extracted export folders, newest first', async () => {
    const downloads = await mkdtemp(join(tmpdir(), 'linkedin-downloads-'));
    const desktop = await mkdtemp(join(tmpdir(), 'linkedin-desktop-'));
    expect(await findConnectionsExports([downloads, desktop, join(downloads, 'missing')])).toEqual([]);

    await at(join(downloads, 'report.zip'), 0);
    await at(join(downloads, 'Basic_LinkedInDataExport_01-02-2026.zip'), 30);
    expect(await findConnectionsExports([downloads, desktop])).toEqual([join(downloads, 'Basic_LinkedInDataExport_01-02-2026.zip')]);

    await at(join(desktop, 'connections.csv'), 20);
    expect(await findConnectionsExports([downloads, desktop])).toEqual([join(desktop, 'connections.csv'), join(downloads, 'Basic_LinkedInDataExport_01-02-2026.zip')]);

    const extracted = join(downloads, 'Complete_LinkedInDataExport_03-04-2026');
    await mkdir(extracted);
    expect(await findConnectionsExports([downloads, desktop])).toHaveLength(2);
    await at(join(extracted, 'Connections.csv'), 10);
    expect(await findConnectionsExports([downloads, desktop])).toEqual([
      join(extracted, 'Connections.csv'),
      join(desktop, 'connections.csv'),
      join(downloads, 'Basic_LinkedInDataExport_01-02-2026.zip'),
    ]);
  });
});

describe('foldText', () => {
  it('ignores case, accents and spacing, including letters Unicode does not decompose', () => {
    expect(foldText('  ŁÓDŹ  Software  ')).toBe('lodz software');
    expect(foldText('Zażółć gęślą jaźń')).toBe('zazolc gesla jazn');
    expect(foldText('Øresund Straße Æther Œuvre')).toBe('oresund strasse aether oeuvre');
    expect(foldText('Société Générale')).toBe('societe generale');
  });
});

describe('matchesWordStart', () => {
  it('matches the start of a word, not the middle of one', () => {
    expect(matchesWordStart('ing bank', 'ing')).toBe(true);
    expect(matchesWordStart('boeing', 'ing')).toBe(false);
    expect(matchesWordStart('digital marketing agency', 'ing')).toBe(false);
    expect(matchesWordStart('ey', 'ey')).toBe(true);
    expect(matchesWordStart('disney', 'ey')).toBe(false);
    // A later occurrence can still start a word.
    expect(matchesWordStart('boeing ing', 'ing')).toBe(true);
    expect(matchesWordStart('jane doe', 'doe')).toBe(true);
    expect(matchesWordStart('google llc', 'goo')).toBe(true);
    expect(matchesWordStart('https://www.linkedin.com/in/jane-doe', 'jane-doe')).toBe(true);
    expect(matchesWordStart('jane@gmail.com', 'gmail')).toBe(true);
    expect(matchesWordStart('acme', 'acme corp')).toBe(false);
  });

  it('lets a term that starts with a symbol match anywhere', () => {
    expect(matchesWordStart('jane@gmail.com', '@gmail')).toBe(true);
    expect(matchesWordStart('jane@gmail.com', '@yahoo')).toBe(false);
  });
});

describe('countCompanies', () => {
  const at = (company?: string): Connection => ({ firstName: 'A', lastName: 'B', name: 'A B', company });

  it('groups spellings that differ in case or accents, most connections first', () => {
    const counts = countCompanies([at('Łódź Labs'), at('Lodz Labs'), at('Łódź Labs'), at('Acme'), at('Beta'), at(), at('Acme')]);
    expect(counts).toEqual([
      { company: 'Łódź Labs', count: 3 },
      { company: 'Acme', count: 2 },
      { company: 'Beta', count: 1 },
    ]);
  });

  it('shows a company under its most common spelling, whichever came first, and breaks ties by name', () => {
    const counts = countCompanies([at('ACME'), at('Acme'), at('Acme'), at('Zeta'), at('Beta'), at('acme'), at('Acme')]);
    expect(counts).toEqual([
      { company: 'Acme', count: 5 },
      { company: 'Beta', count: 1 },
      { company: 'Zeta', count: 1 },
    ]);
    // Equally common spellings: the first one seen.
    expect(countCompanies([at('Łódź Labs'), at('Lodz Labs')])).toEqual([{ company: 'Łódź Labs', count: 2 }]);
  });
});
