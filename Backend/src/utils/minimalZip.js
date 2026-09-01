// ─────────────────────────────────────────────────────────────────────────────
//  Minimal ZIP writer (dependency-free)
//
//  Extracted from Phase 29.8 (where it produced the XLSX bank file) so Phase
//  29.9's bulk payslip download can reuse the SAME writer instead of adding
//  an npm package — the call 29.5, 29.7 and 29.8 all made for archive-shaped
//  output.
//
//  Entries are STORED (no compression): the payloads are PDFs and small XML
//  parts, and deflate would be a few hundred lines for no real gain.
// ─────────────────────────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value;
  }
  return table;
})();

const crc32 = (buffer) => {
  let crc = -1;
  for (let index = 0; index < buffer.length; index += 1) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buffer[index]) & 0xff];
  }
  return (crc ^ -1) >>> 0;
};

/**
 * @param {Array<{ name: string, data: Buffer }>} files
 * @returns {Buffer} a valid ZIP archive
 */
export const buildZip = (files = []) => {
  const chunks = [];
  const central = [];
  let offset = 0;

  (files || []).forEach(({ name, data }) => {
    const nameBuffer = Buffer.from(String(name || 'file'), 'utf8');
    const payload = Buffer.isBuffer(data) ? data : Buffer.from(String(data ?? ''), 'utf8');
    const crc = crc32(payload);
    const size = payload.length;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt16LE(0, 10); // time
    local.writeUInt16LE(0, 12); // date
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(size, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    local.writeUInt16LE(0, 28); // extra length

    chunks.push(local, nameBuffer, payload);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4); // version made by
    entry.writeUInt16LE(20, 6); // version needed
    entry.writeUInt16LE(0, 8); // flags
    entry.writeUInt16LE(0, 10); // stored
    entry.writeUInt16LE(0, 12); // time
    entry.writeUInt16LE(0, 14); // date
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(size, 20);
    entry.writeUInt32LE(size, 24);
    entry.writeUInt16LE(nameBuffer.length, 28);
    entry.writeUInt16LE(0, 30); // extra
    entry.writeUInt16LE(0, 32); // comment
    entry.writeUInt16LE(0, 34); // disk number
    entry.writeUInt16LE(0, 36); // internal attrs
    entry.writeUInt32LE(0, 38); // external attrs
    entry.writeUInt32LE(offset, 42);

    central.push(entry, nameBuffer);
    offset += local.length + nameBuffer.length + size;
  });

  const centralBuffer = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...chunks, centralBuffer, end]);
};

export default buildZip;
