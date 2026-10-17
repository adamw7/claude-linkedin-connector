import { describe, expect, it } from 'vitest';
import { UserInputError } from '../src/errors.js';
import { parseConnectedOn, parseConnections, parseCsv } from '../src/linkedin/connections.js';
import { CONNECTIONS_CSV } from './helpers/connections.js';

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
    expect(() => parseConnections(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0]))).toThrow(/zip archive/);
  });
});
