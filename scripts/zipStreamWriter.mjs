import { createReadStream, createWriteStream } from 'node:fs';
import { stat, unlink } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import path from 'node:path';
import zlib from 'node:zlib';

// Minimal streaming ZIP writer — the yazl replacement for the BeamNG export
// sidecar. Why hand-rolled:
//
//  - yazl.addBuffer() hard-caps entries at 1 GB ("buffer too large") — an
//    ultra-tier google_tiles.dae is 1.8 GB.
//  - every streaming zip API (yazl.addReadStream, archiver, …) sets general-
//    purpose bit 3 and writes sizes/CRC in trailing data descriptors; BeamNG's
//    Torque-derived zip reader fails to load shapes from such entries (the
//    in-game "NO MESH" placeholder — hard-won lesson).
//
// This writer gets both: each entry's input is streamed through DEFLATE into
// a spool file while CRC32/raw size are computed on the fly; the spool is
// then appended after a COMPLETE local header (sizes + CRC known, no bit 3).
// Memory stays flat regardless of entry size. ZIP64 records are emitted only
// when an entry's sizes or the archive offsets actually require them (>4 GB)
// — archives below the thresholds are byte-layout-identical to classic zip32.
// ⚠️ Whether BeamNG's reader copes with ZIP64 is UNVERIFIED — but a zip that
// big was impossible to produce before, so this is strictly an improvement.
//
// Entries are written strictly sequentially — callers must serialize
// addStream/addEmptyDirectory calls (the sidecar's per-job chain does).

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_ZIP64_EOCD = 0x06064b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;
const U32_MAX = 0xffffffff;

const dosDateTime = (d = new Date()) => ({
  time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
  date: (((d.getFullYear() - 1980) & 0x7f) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
});

export class ZipStreamWriter {
  constructor(outPath, spoolDir) {
    this.out = createWriteStream(outPath);
    this.spoolDir = spoolDir;
    this.offset = 0;
    this.central = [];
    this.seq = 0;
    this.finished = false;
    this.outError = null;
    this.out.on('error', (err) => { this.outError = err; });
  }

  _checkError() {
    if (this.outError) throw this.outError;
  }

  _write(buf) {
    this._checkError();
    return new Promise((resolve, reject) => {
      this.out.write(buf, (err) => (err ? reject(err) : resolve()));
    }).then(() => { this.offset += buf.length; });
  }

  /**
   * Append one file entry. `input` is any readable stream of the RAW bytes
   * (e.g. the upload request); it is deflated to a spool file first so the
   * local header can carry the final CRC/sizes.
   * @returns {Promise<{rawSize: number, compSize: number}>}
   */
  async addStream(name, input, { maxBytes = Infinity } = {}) {
    this._checkError();
    const entryName = name.replace(/\\/g, '/');
    const spool = path.join(this.spoolDir, `spool-${this.seq++}.deflate`);

    let crc = 0;
    let rawSize = 0;
    const meter = new Transform({
      transform(chunk, _enc, cb) {
        rawSize += chunk.length;
        if (rawSize > maxBytes) {
          cb(new Error(`entry "${entryName}" exceeds ${maxBytes} bytes`));
          return;
        }
        crc = zlib.crc32(chunk, crc);
        cb(null, chunk);
      },
    });

    try {
      await pipeline(input, meter, zlib.createDeflateRaw({ level: 6 }), createWriteStream(spool));
      const compSize = (await stat(spool)).size;
      await this._writeEntry(entryName, { crc: crc >>> 0, rawSize, compSize, method: 8, spool });
      return { rawSize, compSize };
    } finally {
      await unlink(spool).catch(() => {});
    }
  }

  /** Append a directory entry (name gets a trailing slash). */
  addEmptyDirectory(name) {
    const entryName = `${name.replace(/\\/g, '/').replace(/\/+$/, '')}/`;
    return this._writeEntry(entryName, { crc: 0, rawSize: 0, compSize: 0, method: 0, spool: null, isDir: true });
  }

  async _writeEntry(entryName, { crc, rawSize, compSize, method, spool, isDir = false }) {
    const nameBuf = Buffer.from(entryName, 'utf8');
    const headerOffset = this.offset;
    const needZip64 = rawSize >= U32_MAX || compSize >= U32_MAX || headerOffset >= U32_MAX;
    const { time, date } = dosDateTime();

    // Local zip64 extra carries the 64-bit sizes when the 32-bit fields
    // overflow (the offset only ever appears in the CENTRAL extra).
    let extra = Buffer.alloc(0);
    if (needZip64) {
      extra = Buffer.alloc(4 + 16);
      extra.writeUInt16LE(0x0001, 0);
      extra.writeUInt16LE(16, 2);
      extra.writeBigUInt64LE(BigInt(rawSize), 4);
      extra.writeBigUInt64LE(BigInt(compSize), 12);
    }

    const header = Buffer.alloc(30);
    header.writeUInt32LE(SIG_LOCAL, 0);
    header.writeUInt16LE(needZip64 ? 45 : 20, 4);   // version needed
    header.writeUInt16LE(0x0800, 6);                // flags: UTF-8 names, NO bit 3
    header.writeUInt16LE(method, 8);
    header.writeUInt16LE(time, 10);
    header.writeUInt16LE(date, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(needZip64 ? U32_MAX : compSize, 18);
    header.writeUInt32LE(needZip64 ? U32_MAX : rawSize, 22);
    header.writeUInt16LE(nameBuf.length, 26);
    header.writeUInt16LE(extra.length, 28);

    await this._write(header);
    await this._write(nameBuf);
    if (extra.length) await this._write(extra);

    if (spool && compSize > 0) {
      this._checkError();
      await new Promise((resolve, reject) => {
        const rs = createReadStream(spool);
        rs.on('data', (c) => { this.offset += c.length; });
        rs.on('error', reject);
        this.out.on('error', reject);
        rs.pipe(this.out, { end: false });
        rs.on('end', resolve);
      });
    }

    this.central.push({ nameBuf, crc, rawSize, compSize, method, headerOffset, time, date, isDir });
  }

  /** Write the central directory + end records and close the file. */
  async finalize() {
    this._checkError();
    if (this.finished) throw new Error('zip already finalized');
    this.finished = true;

    const centralStart = this.offset;
    let anyZip64 = false;

    for (const e of this.central) {
      const needZip64 = e.rawSize >= U32_MAX || e.compSize >= U32_MAX || e.headerOffset >= U32_MAX;
      anyZip64 = anyZip64 || needZip64;
      let extra = Buffer.alloc(0);
      if (needZip64) {
        extra = Buffer.alloc(4 + 24);
        extra.writeUInt16LE(0x0001, 0);
        extra.writeUInt16LE(24, 2);
        extra.writeBigUInt64LE(BigInt(e.rawSize), 4);
        extra.writeBigUInt64LE(BigInt(e.compSize), 12);
        extra.writeBigUInt64LE(BigInt(e.headerOffset), 20);
      }

      const h = Buffer.alloc(46);
      h.writeUInt32LE(SIG_CENTRAL, 0);
      h.writeUInt16LE(needZip64 ? 45 : 20, 4);  // version made by (lower byte: spec)
      h.writeUInt16LE(needZip64 ? 45 : 20, 6);  // version needed
      h.writeUInt16LE(0x0800, 8);               // flags: UTF-8, no bit 3
      h.writeUInt16LE(e.method, 10);
      h.writeUInt16LE(e.time, 12);
      h.writeUInt16LE(e.date, 14);
      h.writeUInt32LE(e.crc, 16);
      h.writeUInt32LE(needZip64 ? U32_MAX : e.compSize, 20);
      h.writeUInt32LE(needZip64 ? U32_MAX : e.rawSize, 24);
      h.writeUInt16LE(e.nameBuf.length, 28);
      h.writeUInt16LE(extra.length, 30);
      // comment len, disk start, internal attrs = 0
      h.writeUInt32LE(e.isDir ? 0x10 : 0, 38);  // external attrs: FAT directory bit
      h.writeUInt32LE(needZip64 ? U32_MAX : e.headerOffset, 42);

      await this._write(h);
      await this._write(e.nameBuf);
      if (extra.length) await this._write(extra);
    }

    const centralSize = this.offset - centralStart;
    const needZip64Eocd = anyZip64 ||
      this.central.length > 0xffff || centralStart >= U32_MAX || centralSize >= U32_MAX;

    if (needZip64Eocd) {
      const z = Buffer.alloc(56);
      const zip64EocdOffset = this.offset;
      z.writeUInt32LE(SIG_ZIP64_EOCD, 0);
      z.writeBigUInt64LE(44n, 4);               // size of remainder
      z.writeUInt16LE(45, 12);                  // version made by
      z.writeUInt16LE(45, 14);                  // version needed
      // disk numbers = 0
      z.writeBigUInt64LE(BigInt(this.central.length), 24);
      z.writeBigUInt64LE(BigInt(this.central.length), 32);
      z.writeBigUInt64LE(BigInt(centralSize), 40);
      z.writeBigUInt64LE(BigInt(centralStart), 48);
      await this._write(z);

      const loc = Buffer.alloc(20);
      loc.writeUInt32LE(SIG_ZIP64_LOCATOR, 0);
      loc.writeUInt32LE(0, 4);                  // disk with zip64 EOCD
      loc.writeBigUInt64LE(BigInt(zip64EocdOffset), 8);
      loc.writeUInt32LE(1, 16);                 // total disks
      await this._write(loc);
    }

    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(SIG_EOCD, 0);
    eocd.writeUInt16LE(Math.min(this.central.length, 0xffff), 8);
    eocd.writeUInt16LE(Math.min(this.central.length, 0xffff), 10);
    eocd.writeUInt32LE(centralSize >= U32_MAX ? U32_MAX : centralSize, 12);
    eocd.writeUInt32LE(centralStart >= U32_MAX || needZip64Eocd ? Math.min(centralStart, U32_MAX) : centralStart, 16);
    await this._write(eocd);

    await new Promise((resolve, reject) => this.out.end((err) => (err ? reject(err) : resolve())));
    return this.offset;
  }
}
