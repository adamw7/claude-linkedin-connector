import { describe, expect, it } from 'vitest';
import { UserInputError } from '../src/errors.js';
import { extractZipEntry, isZip } from '../src/linkedin/zip.js';
import { zipArchive } from './helpers/zip.js';

const isCsv = (path: string) => path.endsWith('Connections.csv');

describe('extractZipEntry', () => {
  it('extracts deflated and stored entries by path', () => {
    const files = { 'Profile.csv': 'profile', 'export/Connections.csv': 'First Name,Last Name\nAda,Lovelace' };
    for (const stored of [false, true]) {
      const archive = zipArchive(files, { stored });
      expect(isZip(archive)).toBe(true);
      expect(extractZipEntry(archive, isCsv, 1024)?.toString()).toBe('First Name,Last Name\nAda,Lovelace');
    }
    expect(extractZipEntry(zipArchive({ 'Profile.csv': 'profile' }), isCsv, 1024)).toBeUndefined();
    expect(isZip(Buffer.from('First Name'))).toBe(false);
  });

  it('refuses entries that would expand beyond the limit', () => {
    const archive = zipArchive({ 'Connections.csv': 'x'.repeat(10_000) });
    expect(() => extractZipEntry(archive, isCsv, 1024)).toThrow('Connections.csv in this zip archive is larger than 0.0009765625 MB.');
    // A forged size in the directory doesn't get past the cap on the output.
    archive.writeUInt32LE(10, archive.length - 22 - 46 - 'Connections.csv'.length + 24);
    expect(() => extractZipEntry(archive, isCsv, 1024)).toThrow(/larger than/);
  });

  it.each([
    ['damaged', (archive: Buffer) => archive.subarray(0, archive.length - 10), 'This zip archive is damaged or incomplete. Download it from LinkedIn again.'],
    ['corrupt', (archive: Buffer) => (archive[50] = archive[50]! ^ 0xff, archive), 'This zip archive is damaged or incomplete. Download it from LinkedIn again.'],
  ])('reports a %s archive', (_, damage, message) => {
    const archive = zipArchive({ 'Connections.csv': 'First Name,Last Name\nAda,Lovelace' }, { stored: true });
    expect(() => extractZipEntry(damage(archive), isCsv, 1024)).toThrow(new UserInputError(message));
  });

  it('finds the directory behind an archive comment of up to 65535 bytes', () => {
    const archive = zipArchive({ 'Connections.csv': 'Ada' }, { stored: true });
    expect(extractZipEntry(Buffer.concat([archive, Buffer.alloc(0xffff)]), isCsv, 1024)?.toString()).toBe('Ada');
    expect(() => extractZipEntry(Buffer.concat([archive, Buffer.alloc(0x10000)]), isCsv, 1024)).toThrow(/damaged/);
  });

  it('tells an empty archive from a file too short to be one', () => {
    expect(extractZipEntry(zipArchive({}), isCsv, 1024)).toBeUndefined();
    expect(() => extractZipEntry(zipArchive({}).subarray(0, 21), isCsv, 1024)).toThrow(/damaged/);
  });

  it('explains entries it cannot read', () => {
    expect(() => extractZipEntry(zipArchive({ 'Connections.csv': 'x' }, { flags: 1 }), isCsv, 1024)).toThrow(
      'Connections.csv in this zip archive is encrypted. Extract it yourself and pass the file instead.',
    );
    expect(() => extractZipEntry(zipArchive({ 'Connections.csv': 'x' }, { method: 12 }), isCsv, 1024)).toThrow(
      'Connections.csv in this zip archive uses a compression method this connector cannot read. Extract it and pass the file instead.',
    );
  });
});
