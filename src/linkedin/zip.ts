import { crc32, inflateRawSync } from 'node:zlib';
import { UserInputError } from '../errors.js';

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY = Buffer.from('PK\x05\x06');
/** Sizes and offsets this large mean the real value is in a ZIP64 record, which LinkedIn's small exports never need. */
const ZIP64_MARKER = 0xffffffff;

export function isZip(data: Buffer): boolean {
  return data.length >= 4 && data.readUInt32LE(0) === LOCAL_HEADER;
}

/**
 * Extracts the first file in a zip archive whose path matches, or returns undefined if there is none.
 * Only stored and deflated, unencrypted entries are supported, which is what LinkedIn's data export uses.
 * The output is capped at `maxBytes`, so a small archive cannot expand into an unbounded amount of memory.
 */
export function extractZipEntry(data: Buffer, matches: (path: string) => boolean, maxBytes: number): Buffer | undefined {
  const corrupt = () => new UserInputError('This zip archive is damaged or incomplete. Download it from LinkedIn again.');
  // The end-of-central-directory record is the last 22 bytes, followed by a comment of up to 65535 bytes.
  const end = data.length < 22 ? -1 : data.lastIndexOf(END_OF_CENTRAL_DIRECTORY, data.length - 22);
  if (end < Math.max(0, data.length - 22 - 0xffff)) throw corrupt();
  const entries = data.readUInt16LE(end + 10);
  let at = data.readUInt32LE(end + 16);

  for (let index = 0; index < entries; index += 1) {
    if (at + 46 > data.length || data.readUInt32LE(at) !== CENTRAL_HEADER) throw corrupt();
    const flags = data.readUInt16LE(at + 8);
    const method = data.readUInt16LE(at + 10);
    const crc = data.readUInt32LE(at + 16);
    const compressedSize = data.readUInt32LE(at + 20);
    const size = data.readUInt32LE(at + 24);
    const nameLength = data.readUInt16LE(at + 28);
    const headerOffset = data.readUInt32LE(at + 42);
    const path = data.toString('utf8', at + 46, at + 46 + nameLength);
    at += 46 + nameLength + data.readUInt16LE(at + 30) + data.readUInt16LE(at + 32);
    if (!matches(path)) continue;

    if (flags & 1) throw new UserInputError(`${path} in this zip archive is encrypted. Extract it yourself and pass the file instead.`);
    if ([compressedSize, size, headerOffset].includes(ZIP64_MARKER)) {
      throw new UserInputError(`This zip archive is too large to read here. Extract ${path} from it and pass that file instead.`);
    }
    const tooLarge = () => new UserInputError(`${path} in this zip archive is larger than ${maxBytes / 1024 / 1024} MB.`);
    if (size > maxBytes) throw tooLarge();
    if (headerOffset + 30 > data.length || data.readUInt32LE(headerOffset) !== LOCAL_HEADER) throw corrupt();
    const start = headerOffset + 30 + data.readUInt16LE(headerOffset + 26) + data.readUInt16LE(headerOffset + 28);
    if (start + compressedSize > data.length) throw corrupt();
    const stored = data.subarray(start, start + compressedSize);

    let content: Buffer;
    if (method === 0) content = stored;
    else if (method === 8) {
      try {
        content = inflateRawSync(stored, { maxOutputLength: maxBytes });
      } catch (error) {
        if (error instanceof RangeError) throw tooLarge();
        throw corrupt();
      }
    } else {
      throw new UserInputError(`${path} in this zip archive uses a compression method this connector cannot read. Extract it and pass the file instead.`);
    }
    if (content.length !== size || crc32(content) !== crc) throw corrupt();
    return content;
  }
  return undefined;
}
