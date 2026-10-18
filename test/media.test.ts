import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
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
  let outside: string;
  let server: TestServer;

  beforeAll(async () => {
    const root = await mkdtemp(join(tmpdir(), 'linkedin-media-'));
    dir = join(root, 'allowed');
    outside = join(root, 'private');
    await mkdir(dir);
    await mkdir(outside);
    await writeFile(join(outside, 'secret.png'), PNG);
    await writeFile(join(dir, '..pixel.png'), PNG);
    await symlink(join(outside, 'secret.png'), join(dir, 'link.png'));
    await symlink(outside, join(dir, 'private-folder'));
    await writeFile(join(dir, 'pixel.png'), PNG);
    await writeFile(join(dir, 'notes.txt'), 'not an image');
    server = await startServer((req, res) => {
      if (req.url === '/deck.pdf' || req.url === '/100%.pdf') res.end(PDF);
      else res.writeHead(404).end();
    });
  });
  afterAll(() => server.close());

  it('reads local files in local mode', async () => {
    const media = await loadMedia(join(dir, 'pixel.png'), 'image', { localFileDirs: [dir] });
    expect(media).toMatchObject({ mimeType: 'image/png', filename: 'pixel.png' });
    expect(media.data.equals(PNG)).toBe(true);
    const relative = await loadMedia('pixel.png', 'image', { localFileDirs: [dir], cwd: dir });
    expect(relative.mimeType).toBe('image/png');
  });

  it('only reads local files inside the allowed folders', async () => {
    const message = /outside the folders this connector may read files from .*LINKEDIN_FILE_DIRS/;
    await expect(loadMedia(join(outside, 'secret.png'), 'image', { localFileDirs: [dir] })).rejects.toThrow(message);
    await expect(loadMedia(join(dir, '..', 'private', 'secret.png'), 'image', { localFileDirs: [dir] })).rejects.toThrow(message);
    await expect(loadMedia('../private/secret.png', 'image', { localFileDirs: [dir], cwd: dir })).rejects.toThrow(message);
    await expect(loadMedia(join(outside, 'secret.png'), 'image', { localFileDirs: [] })).rejects.toThrow(/\(none\)/);
    // A file name that merely starts with two dots is still inside.
    expect((await loadMedia(join(dir, '..pixel.png'), 'image', { localFileDirs: [dir] })).mimeType).toBe('image/png');
  });

  it('does not follow symlinks out of the allowed folders', async () => {
    const message = /outside the folders/;
    await expect(loadMedia(join(dir, 'link.png'), 'image', { localFileDirs: [dir] })).rejects.toThrow(message);
    await expect(loadMedia(join(dir, 'private-folder', 'secret.png'), 'image', { localFileDirs: [dir] })).rejects.toThrow(message);
  });

  it('does not reveal whether files outside the allowed folders exist', async () => {
    await expect(loadMedia(join(outside, 'missing.png'), 'image', { localFileDirs: [dir] })).rejects.toThrow(/outside the folders/);
  });

  it('never reads local files in remote mode', async () => {
    await expect(loadMedia(join(dir, 'pixel.png'), 'image', {})).rejects.toThrow(/Local files cannot be read/);
  });

  it('rejects files that are not the expected type', async () => {
    await expect(loadMedia(join(dir, 'notes.txt'), 'image', { localFileDirs: [dir] })).rejects.toThrow(UserInputError);
    await expect(loadMedia(join(dir, 'notes.txt'), 'document', { localFileDirs: [dir] })).rejects.toThrow(
      `"${join(dir, 'notes.txt')}" is not a PDF, DOC, DOCX, PPT or PPTX document.`,
    );
    await expect(loadMedia(join(dir, 'missing.png'), 'image', { localFileDirs: [dir] })).rejects.toThrow(
      `Cannot read ${join(dir, 'missing.png')}: the file does not exist.`,
    );
  });

  it.each([
    ['photo.heic', Buffer.from('\0\0\0\x18ftypheic\0\0\0\0mif1heic'), 'image', 'is a HEIC image, not a JPEG, PNG or GIF image. Convert it to JPEG or PNG first (on a Mac, open it in Preview and choose File → Export).'],
    ['photo.avif', Buffer.from('\0\0\0\x1cftypavif\0\0\0\0'), 'image', 'is an AVIF image, not a JPEG'],
    ['photo.webp', Buffer.from('RIFF\x24\0\0\0WEBPVP8 '), 'image', 'is a WebP image, not a JPEG'],
    ['scan.tif', Buffer.from('II*\0\x08\0\0\0'), 'image', 'is a TIFF image, not a JPEG'],
    ['scan.tiff', Buffer.from('MM\0*\0\0\0\x08'), 'image', 'is a TIFF image, not a JPEG'],
    ['old.bmp', Buffer.from('BM\x0a\0\0\0\0\0\0\0'), 'image', 'is a BMP image, not a JPEG'],
    ['logo.svg', Buffer.from('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"/>'), 'image', 'is an SVG image, not a JPEG, PNG or GIF image. Convert it to PNG first.'],
    ['clip.mp4', Buffer.from('\0\0\0\x20ftypisom\0\0\x02\0'), 'image', 'is a video, not a JPEG, PNG or GIF image. Video posts are not supported yet.'],
    ['clip.mov', Buffer.from('\0\0\0\x14ftypqt  \0\0\0\0'), 'document', 'is a video, not a PDF, DOC, DOCX, PPT or PPTX document. Video posts are not supported yet.'],
    ['camera.mp4', Buffer.from('\0\0\0\x18ftypiso2\0\0\0\0'), 'image', 'is a video, not a JPEG'],
    ['phone.mp4', Buffer.from('\0\0\0\x18ftypmp42\0\0\0\0'), 'image', 'is a video, not a JPEG'],
    ['old-phone.3gp', Buffer.from('\0\0\0\x18ftyp3gp4\0\0\0\0'), 'image', 'is a video, not a JPEG'],
    ['page.html', Buffer.from('\n<!DOCTYPE html><html><body><img src="x.png"></body></html>'), 'image', 'is a web page, not a JPEG, PNG or GIF image. Pass a link to the file itself: for a picture on a web page, right-click it and copy the image address. Share links from cloud drives usually lead to a page.'],
    ['deck.pdf', PDF, 'image', `is a PDF, not a JPEG, PNG or GIF image. Attach it as the post's document instead.`],
    ['pixel.png', PNG, 'document', 'is a PNG image, not a PDF, DOC, DOCX, PPT or PPTX document. Attach it under images instead.'],
    ['talk.key', Buffer.from('PK\x03\x04....Index/Document.iwa....'), 'document', 'is a Keynote, Pages or Numbers file, not a PDF, DOC, DOCX, PPT or PPTX document. Export it as PDF first.'],
    ['talk.odp', Buffer.from(`PK\x03\x04${'.'.repeat(26)}mimetypeapplication/vnd.oasis.opendocument.presentation`), 'document', 'is an OpenDocument file, not a PDF'],
    ['sheet.xlsx', Buffer.from('PK\x03\x04....[Content_Types].xml....xl/workbook.xml'), 'document', 'is an Excel spreadsheet, not a PDF, DOC, DOCX, PPT or PPTX document. Export it as PDF first.'],
    ['photos.zip', Buffer.from('PK\x03\x04....photo.jpg'), 'image', 'is a zip archive, not a JPEG, PNG or GIF image. Extract the file from it first.'],
  ] as const)('says what %s is and what to do instead', async (name, data, kind, message) => {
    await expect(loadMedia(`data:application/octet-stream;base64,${data.toString('base64')}`, kind, {})).rejects.toThrow(message);
  });

  it('keeps the file name of a long path in errors, and the media type of a long data: URI', async () => {
    const deep = join(dir, 'a-folder-with-a-rather-long-name', 'and-another-folder-inside-it-that-is-long-too');
    await mkdir(deep, { recursive: true });
    await writeFile(join(deep, 'IMG_0001.HEIC'), Buffer.from('\0\0\0\x18ftypheic\0\0\0\0mif1heic'));
    const path = join(deep, 'IMG_0001.HEIC');
    await expect(loadMedia(path, 'image', { localFileDirs: [dir] })).rejects.toThrow(`"...${path.slice(-77)}" is a HEIC image`);
    const dataUri = `data:text/plain;base64,${Buffer.from('x'.repeat(100)).toString('base64')}`;
    await expect(loadMedia(dataUri, 'image', {})).rejects.toThrow(`"${dataUri.slice(0, 77)}..." is not a JPEG`);
  });

  const zip = (...entries: string[]) => Buffer.from(`PK\x03\x04....${entries.join('....')}`);
  const ole = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0]);

  it.each([
    ['a Word document', zip('[Content_Types].xml', 'word/document.xml'), 'image', "Attach it as the post's document instead."],
    ['a PowerPoint presentation', zip('[Content_Types].xml', 'ppt/presentation.xml'), 'image', "Attach it as the post's document instead."],
    ['an Office document', ole, 'image', "Attach it as the post's document instead."],
    ['a JPEG image', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]), 'document', 'Attach it under images instead.'],
    ['a GIF image', Buffer.from('GIF87a......'), 'document', 'Attach it under images instead.'],
  ] as const)('names %s given in the wrong place', async (what, data, kind, fix) => {
    const expected = kind === 'image' ? 'JPEG, PNG or GIF image' : 'PDF, DOC, DOCX, PPT or PPTX document';
    await expect(loadMedia(`data:;base64,${data.toString('base64')}`, kind, {})).rejects.toThrow(`is ${what}, not a ${expected}. ${fix}`);
  });

  it.each([
    ['an HTML page without a doctype', Buffer.from('<html lang="en"><head><title>Photo</title></head></html>'), 'a web page'],
    ['an HTML page with only a doctype', Buffer.from('<!doctype html>\n<title>Photo</title>'), 'a web page'],
    ['a bare SVG', Buffer.from('<svg viewBox="0 0 1 1"></svg>'), 'an SVG image'],
    ['the smallest BMP header', Buffer.from('BM\x06\0\0\0'), 'a BMP image'],
    ['a zip with a mimetype that is not OpenDocument', Buffer.from(`PK\x03\x04${'.'.repeat(26)}mimetypeapplication/epub+zip`), 'a zip archive'],
    ['a zip with an xl/ folder but no Office manifest', zip('xl/notes.txt'), 'a zip archive'],
    ['an OpenDocument manifest that is not first in the zip', zip('mimetypeapplication/vnd.oasis.opendocument.text'), 'a zip archive'],
    ['an Office manifest without Word, PowerPoint or Excel parts', zip('[Content_Types].xml', 'docProps/app.xml'), 'a zip archive'],
  ] as const)('recognizes %s', async (_name, data, what) => {
    await expect(loadMedia(`data:;base64,${data.toString('base64')}`, 'image', {})).rejects.toThrow(`is ${what}, not a JPEG`);
  });

  it.each([
    ['"heic" without an ftyp box', Buffer.from('\0\0\0\x18abcdheic\0\0\0\0')],
    ['an ftyp box of another kind', Buffer.from('\0\0\0\x18ftypcrx \0\0\0\0')],
    ['"BM" shorter than a BMP header', Buffer.from('BMxy')],
    ['"BM" whose size does not match', Buffer.from('BM\x07\0\0\0')],
    ['"RIFF" that is not WebP', Buffer.from('RIFF\x24\0\0\0WAVEfmt ')],
    ['"<svg" inside a word', Buffer.from('this is <svgish> text')],
    ['"WEBP" without "RIFF"', Buffer.from('ABCD\x24\0\0\0WEBPVP8 ')],
    ['a BMP-sized header without "BM"', Buffer.from('XY\x06\0\0\0')],
  ] as const)('does not guess a format for %s', async (_name, data) => {
    const source = `data:;base64,${data.toString('base64')}`;
    await expect(loadMedia(source, 'image', {})).rejects.toThrow(new UserInputError(`"${source}" is not a JPEG, PNG or GIF image.`));
  });

  it('shows a source of up to 80 characters in full', async () => {
    const source = `data:text/plain;base64,${'QUJD'.repeat(14)}x`;
    expect(source).toHaveLength(80);
    await expect(loadMedia(source, 'image', {})).rejects.toThrow(`"${source}" is not a JPEG`);
  });

  it('says only what was expected for files it does not recognize', async () => {
    const bmpLookalike = Buffer.from('BM is not a bitmap');
    await expect(loadMedia(`data:text/plain;base64,${bmpLookalike.toString('base64')}`, 'image', {})).rejects.toThrow(
      /^"data:text\/plain;base64,[^"]+" is not a JPEG, PNG or GIF image\.$/,
    );
  });

  it('reads file: URLs, and explains the ones that name no local file', async () => {
    expect((await loadMedia(pathToFileURL(join(dir, 'pixel.png')).href, 'image', { localFileDirs: [dir] })).mimeType).toBe('image/png');
    const failure = loadMedia('file://server/share/photo.png', 'image', { localFileDirs: [dir] });
    await expect(failure).rejects.toThrow(UserInputError);
    await expect(failure).rejects.toThrow(/^"file:\/\/server\/share\/photo\.png" is not a local file URL \(.+\)\. Pass the file's path instead\.$/);
  });

  it('suggests an absolute path when a relative one is not found', async () => {
    await expect(loadMedia('missing.png', 'image', { localFileDirs: [dir], cwd: dir })).rejects.toThrow(
      `"missing.png" was resolved against ${dir}; pass an absolute path instead.`,
    );
  });

  it('decodes base64 data URIs', async () => {
    const media = await loadMedia(`data:image/png;base64,${PNG.toString('base64')}`, 'image', {});
    expect(media.mimeType).toBe('image/png');
  });

  it('accepts data URIs whose media type has parameters', async () => {
    const media = await loadMedia(`data:application/pdf;name=deck.pdf;base64,${PDF.toString('base64')}`, 'document', {});
    expect(media.mimeType).toBe('application/pdf');
    await expect(loadMedia('data:image/png;charset=utf-8,abc', 'image', {})).rejects.toThrow(/Only base64/);
  });

  it('downloads URLs', async () => {
    const media = await loadMedia(`${server.url}/deck.pdf`, 'document', { allowPrivateNetwork: true });
    expect(media).toMatchObject({ mimeType: 'application/pdf', filename: 'deck.pdf' });
  });

  it('keeps file names that are not valid percent-encoding', async () => {
    const media = await loadMedia(`${server.url}/100%.pdf`, 'document', { allowPrivateNetwork: true });
    expect(media).toMatchObject({ mimeType: 'application/pdf', filename: '100%.pdf' });
  });
});
