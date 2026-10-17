import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { UserInputError } from '../src/errors.js';
import { loadMedia, sniffDocument, sniffImage } from '../src/linkedin/media.js';
import { PDF, PNG, startServer, type TestServer } from './helpers/http.js';

describe('file type detection', () => {
  it('recognizes LinkedIn image formats', () => {
    expect(sniffImage(PNG)).toBe('image/png');
    expect(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]))).toBe('image/jpeg');
    expect(sniffImage(Buffer.from('GIF89a......'))).toBe('image/gif');
    expect(sniffImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeUndefined();
  });

  it('recognizes LinkedIn document formats', () => {
    expect(sniffDocument(PDF)).toBe('application/pdf');
    const docx = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('....[Content_Types].xml....word/document.xml')]);
    expect(sniffDocument(docx)).toMatch(/wordprocessingml/);
    const zip = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('....secrets.txt')]);
    expect(sniffDocument(zip)).toBeUndefined();
    expect(sniffDocument(Buffer.from('plain text'))).toBeUndefined();
  });
});

describe('loadMedia', () => {
  let dir: string;
  let server: TestServer;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'linkedin-media-'));
    await writeFile(join(dir, 'pixel.png'), PNG);
    await writeFile(join(dir, 'notes.txt'), 'not an image');
    server = await startServer((req, res) => {
      if (req.url === '/deck.pdf' || req.url === '/100%.pdf') res.end(PDF);
      else res.writeHead(404).end();
    });
  });
  afterAll(() => server.close());

  it('reads local files in local mode', async () => {
    const media = await loadMedia(join(dir, 'pixel.png'), 'image', { allowLocalFiles: true });
    expect(media).toMatchObject({ mimeType: 'image/png', filename: 'pixel.png' });
    expect(media.data.equals(PNG)).toBe(true);
    const relative = await loadMedia('pixel.png', 'image', { allowLocalFiles: true, cwd: dir });
    expect(relative.mimeType).toBe('image/png');
  });

  it('never reads local files in remote mode', async () => {
    await expect(loadMedia(join(dir, 'pixel.png'), 'image', { allowLocalFiles: false })).rejects.toThrow(/Local files cannot be read/);
  });

  it('rejects files that are not the expected type', async () => {
    await expect(loadMedia(join(dir, 'notes.txt'), 'image', { allowLocalFiles: true })).rejects.toThrow(UserInputError);
    await expect(loadMedia(join(dir, 'pixel.png'), 'document', { allowLocalFiles: true })).rejects.toThrow(/is not a PDF/);
    await expect(loadMedia(join(dir, 'missing.png'), 'image', { allowLocalFiles: true })).rejects.toThrow(
      `Cannot read ${join(dir, 'missing.png')}: the file does not exist.`,
    );
  });

  it('suggests an absolute path when a relative one is not found', async () => {
    await expect(loadMedia('missing.png', 'image', { allowLocalFiles: true, cwd: dir })).rejects.toThrow(
      `"missing.png" was resolved against ${dir}; pass an absolute path instead.`,
    );
  });

  it('decodes base64 data URIs', async () => {
    const media = await loadMedia(`data:image/png;base64,${PNG.toString('base64')}`, 'image', { allowLocalFiles: false });
    expect(media.mimeType).toBe('image/png');
  });

  it('accepts data URIs whose media type has parameters', async () => {
    const media = await loadMedia(`data:application/pdf;name=deck.pdf;base64,${PDF.toString('base64')}`, 'document', { allowLocalFiles: false });
    expect(media.mimeType).toBe('application/pdf');
    await expect(loadMedia('data:image/png;charset=utf-8,abc', 'image', { allowLocalFiles: false })).rejects.toThrow(/Only base64/);
  });

  it('downloads URLs', async () => {
    const media = await loadMedia(`${server.url}/deck.pdf`, 'document', { allowLocalFiles: false, allowPrivateNetwork: true });
    expect(media).toMatchObject({ mimeType: 'application/pdf', filename: 'deck.pdf' });
  });

  it('keeps file names that are not valid percent-encoding', async () => {
    const media = await loadMedia(`${server.url}/100%.pdf`, 'document', { allowLocalFiles: false, allowPrivateNetwork: true });
    expect(media).toMatchObject({ mimeType: 'application/pdf', filename: '100%.pdf' });
  });
});
