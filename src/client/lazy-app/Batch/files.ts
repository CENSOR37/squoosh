/** Keep downloads portable and never allow ZIP entries to contain paths. */
export function safeName(name: string): string {
  return (
    name
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
      .replace(/[. ]+$/g, '')
      .trim() || 'image'
  );
}

export function outputNames(
  items: Array<{ file: { name: string }; customName?: string }>,
  extension: string | undefined,
  naming: {
    enabled: boolean;
    prefix: string;
    suffix: string;
    numbered: boolean;
  },
): string[] {
  const used = new Set<string>();
  return items.map((item, index) => {
    const original = item.file.name;
    const base = original.replace(/\.[^.]+$/, '');
    const ext = extension || (/\.([^.]+)$/.exec(original) || [])[1] || 'bin';
    const stem = safeName(
      item.customName ||
        (naming.enabled
          ? `${naming.prefix}${base}${naming.suffix}${
              naming.numbered ? `-${String(index + 1).padStart(3, '0')}` : ''
            }`
          : base),
    );
    let name = `${stem}.${ext}`;
    let count = 2;
    while (used.has(name.toLowerCase())) name = `${stem} (${count++}).${ext}`;
    used.add(name.toLowerCase());
    return name;
  });
}

const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++)
    value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  return value >>> 0;
});

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** Stored ZIP entries: images are already compressed, so do not recompress them. */
export async function createZip(
  entries: Array<{ name: string; blob: Blob }>,
): Promise<Blob> {
  if (entries.length > 65535)
    throw Error('Too many files for one ZIP. Download smaller batches.');
  const parts: BlobPart[] = [];
  const directory: Uint8Array[] = [];
  let offset = 0;
  let directorySize = 0;
  for (const entry of entries) {
    const name = new TextEncoder().encode(safeName(entry.name));
    const size = entry.blob.size;
    if (size >= 0xffffffff || offset + size + name.length + 30 >= 0xffffffff) {
      throw Error(
        'This ZIP exceeds 4 GB. Download smaller batches or individual files.',
      );
    }
    if (name.length > 65535) throw Error('A filename is too long for a ZIP.');
    const crc = crc32(new Uint8Array(await entry.blob.arrayBuffer()));
    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x800, true); // UTF-8 filenames
    lv.setUint16(12, 33, true); // 1980-01-01
    lv.setUint32(14, crc, true);
    lv.setUint32(18, size, true);
    lv.setUint32(22, size, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);
    parts.push(local, entry.blob);
    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x800, true);
    cv.setUint16(14, 33, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, size, true);
    cv.setUint32(24, size, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    central.set(name, 46);
    directory.push(central);
    directorySize += central.length;
    offset += local.length + size;
  }
  if (offset + directorySize >= 0xffffffff)
    throw Error('This ZIP exceeds 4 GB. Download a smaller batch.');
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, directorySize, true);
  ev.setUint32(16, offset, true);
  return new Blob([...parts, ...directory, end], { type: 'application/zip' });
}
