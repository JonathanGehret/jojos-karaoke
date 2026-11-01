// Minimal Ogg Opus muxer for packets from WebCodecs' AudioEncoder (RFC 7845).

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let r = i << 24;
    for (let j = 0; j < 8; j++) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
    t[i] = r >>> 0;
  }
  return t;
})();

export function oggCrc(data: Uint8Array): number {
  let crc = 0;
  for (const b of data) crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ b) & 0xff]) >>> 0;
  return crc >>> 0;
}

function page(packets: Uint8Array[], granule: bigint, serial: number, seq: number, flags: number): Uint8Array {
  const segs: number[] = [];
  for (const p of packets) {
    let len = p.length;
    while (len >= 255) { segs.push(255); len -= 255; }
    segs.push(len);
  }
  if (segs.length > 255) throw new Error('too many segments in one Ogg page');
  const bodyLen = packets.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(27 + segs.length + bodyLen);
  const dv = new DataView(out.buffer);
  out.set([0x4f, 0x67, 0x67, 0x53], 0); // OggS
  out[4] = 0;
  out[5] = flags;
  dv.setBigUint64(6, granule, true);
  dv.setUint32(14, serial, true);
  dv.setUint32(18, seq, true);
  out[26] = segs.length;
  out.set(segs, 27);
  let o = 27 + segs.length;
  for (const p of packets) { out.set(p, o); o += p.length; }
  dv.setUint32(22, oggCrc(out), true);
  return out;
}

export function opusHead(channels: number, preSkip: number, inputRate: number): Uint8Array {
  const b = new Uint8Array(19);
  const dv = new DataView(b.buffer);
  b.set(new TextEncoder().encode('OpusHead'), 0);
  b[8] = 1;
  b[9] = channels;
  dv.setUint16(10, preSkip, true);
  dv.setUint32(12, inputRate, true);
  dv.setInt16(16, 0, true);
  b[18] = 0;
  return b;
}

function opusTags(): Uint8Array {
  const vendor = new TextEncoder().encode('jojos-karaoke');
  const b = new Uint8Array(8 + 4 + vendor.length + 4);
  const dv = new DataView(b.buffer);
  b.set(new TextEncoder().encode('OpusTags'), 0);
  dv.setUint32(8, vendor.length, true);
  b.set(vendor, 12);
  dv.setUint32(12 + vendor.length, 0, true);
  return b;
}

export interface OpusPacket { data: Uint8Array; samples: number } // samples at 48 kHz

/** Build an .opus (Ogg) file. totalSamples = real audio length at 48 kHz (trims encoder padding). */
export function muxOggOpus(packets: OpusPacket[], opts: { channels: number; preSkip: number; inputRate: number; totalSamples: number }): Uint8Array {
  const serial = (Math.random() * 0xffffffff) >>> 0;
  const pages: Uint8Array[] = [];
  let seq = 0;
  pages.push(page([opusHead(opts.channels, opts.preSkip, opts.inputRate)], 0n, serial, seq++, 0x02));
  pages.push(page([opusTags()], 0n, serial, seq++, 0));
  let granule = 0;
  const end = opts.preSkip + opts.totalSamples;
  for (let i = 0; i < packets.length; i += 50) {
    const group = packets.slice(i, i + 50);
    for (const p of group) granule += p.samples;
    const last = i + 50 >= packets.length;
    pages.push(page(group.map((p) => p.data), BigInt(last ? Math.min(granule, end) : granule), serial, seq++, last ? 0x04 : 0));
  }
  const len = pages.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of pages) { out.set(p, o); o += p.length; }
  return out;
}

/** Parse pages back (used by tests and as a sanity check after encoding). */
export function readOggPages(b: Uint8Array): { granule: bigint; flags: number; crcOk: boolean; packets: number }[] {
  const out = [];
  let o = 0;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  while (o + 27 <= b.length) {
    if (b[o] !== 0x4f || b[o + 1] !== 0x67 || b[o + 2] !== 0x67 || b[o + 3] !== 0x53) throw new Error(`bad page at ${o}`);
    const nseg = b[o + 26];
    const segs = b.subarray(o + 27, o + 27 + nseg);
    const body = segs.reduce((a, s) => a + s, 0);
    const pg = b.slice(o, o + 27 + nseg + body);
    const crc = dv.getUint32(o + 22, true);
    pg[22] = pg[23] = pg[24] = pg[25] = 0;
    out.push({ granule: dv.getBigUint64(o + 6, true), flags: b[o + 5], crcOk: oggCrc(pg) === crc,
      packets: [...segs].filter((s) => s < 255).length });
    o += 27 + nseg + body;
  }
  return out;
}
