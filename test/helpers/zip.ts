import { crc32, deflateRawSync } from 'node:zlib';

/** Builds a zip archive of these files, deflated unless `stored`; `flags` and `method` override every entry's. */
export function zipArchive(
  files: Record<string, string | Buffer>,
  options: { stored?: boolean; flags?: number; method?: number } = {},
): Buffer {
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
    };
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    fields(local, 6);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    fields(central, 8);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, body);
    centrals.push(central, name);
    offset += local.length + name.length + body.length;
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
