import { crc32, deflateRawSync } from 'node:zlib';

/**
 * Builds a zip archive of these files, deflated unless `stored`; `flags` and `method` override every entry's, and
 * `extra` and `comment` are added to every entry, as zip tools add timestamps and permissions.
 */
export function zipArchive(
  files: Record<string, string | Buffer>,
  options: { stored?: boolean; flags?: number; method?: number; extra?: Buffer; comment?: string } = {},
): Buffer {
  const extra = options.extra ?? Buffer.alloc(0);
  const comment = Buffer.from(options.comment ?? '');
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [path, content] of Object.entries(files)) {
    const data = Buffer.from(content);
    const name = Buffer.from(path);
    const method = options.method ?? (options.stored ? 0 : 8);
    const body = method === 8 ? deflateRawSync(data) : data;
    const fields = (header: Buffer, at: number) => {
      header.writeUInt16LE(options.flags ?? 0, at);
      header.writeUInt16LE(method, at + 2);
      header.writeUInt32LE(crc32(data), at + 8);
      header.writeUInt32LE(body.length, at + 12);
      header.writeUInt32LE(data.length, at + 16);
      header.writeUInt16LE(name.length, at + 20);
      header.writeUInt16LE(extra.length, at + 22);
    };
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    fields(local, 6);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    fields(central, 8);
    central.writeUInt16LE(comment.length, 32);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, extra, body);
    centrals.push(central, name, extra, comment);
    offset += local.length + name.length + extra.length + body.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
