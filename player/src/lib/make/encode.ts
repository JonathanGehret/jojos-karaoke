// Audio helpers on the main thread: decode/resample with OfflineAudioContext (not available
// in workers) and Opus encoding with WebCodecs, muxed into Ogg.

import { type OpusPacket, muxOggOpus } from './ogg';

export async function decodeFile(data: ArrayBuffer, sampleRate = 44100): Promise<{ left: Float32Array; right: Float32Array; sampleRate: number }> {
  const tmp = new OfflineAudioContext(2, 1, sampleRate);
  const buf = await tmp.decodeAudioData(data);   // resampled to `sampleRate`
  const left = buf.getChannelData(0).slice();
  const right = buf.numberOfChannels > 1 ? buf.getChannelData(1).slice() : left.slice();
  return { left, right, sampleRate };
}

export async function resample(channels: Float32Array[], from: number, to: number): Promise<Float32Array[]> {
  if (from === to) return channels;
  const len = Math.ceil((channels[0].length * to) / from);
  const ctx = new OfflineAudioContext(channels.length, len, to);
  const b = ctx.createBuffer(channels.length, channels[0].length, from);
  channels.forEach((c, i) => b.copyToChannel(c as Float32Array<ArrayBuffer>, i));
  const src = ctx.createBufferSource();
  src.buffer = b;
  src.connect(ctx.destination);
  src.start();
  const out = await ctx.startRendering();
  return channels.map((_, i) => out.getChannelData(i).slice());
}

export async function toMono16k(left: Float32Array, right: Float32Array, from: number): Promise<Float32Array> {
  const mono = new Float32Array(left.length);
  for (let i = 0; i < mono.length; i++) mono[i] = 0.5 * (left[i] + right[i]);
  return (await resample([mono], from, 16000))[0];
}

export function canEncodeOpus(): Promise<boolean> {
  if (typeof AudioEncoder === 'undefined') return Promise.resolve(false);
  return AudioEncoder.isConfigSupported({ codec: 'opus', sampleRate: 48000, numberOfChannels: 2, bitrate: 128000 })
    .then((r) => !!r.supported).catch(() => false);
}

/** Stereo float PCM (any rate) → Ogg Opus file bytes. */
export async function encodeOpus(left: Float32Array, right: Float32Array, sampleRate: number, bitrate = 128000,
  channels: 1 | 2 = 2): Promise<Uint8Array> {
  const [l, r] = await resample(channels === 2 ? [left, right] : [left], sampleRate, 48000).then((c) => [c[0], c[1] ?? c[0]]);
  const packets: OpusPacket[] = [];
  let preSkip = 312;
  let failed: Error | null = null;
  const enc = new AudioEncoder({
    output: (chunk, meta) => {
      const d = new Uint8Array(chunk.byteLength);
      chunk.copyTo(d);
      packets.push({ data: d, samples: Math.round(((chunk.duration ?? 20000) * 48000) / 1e6) });
      const desc = meta?.decoderConfig?.description;
      if (desc) {
        const u = desc instanceof ArrayBuffer ? new Uint8Array(desc) : new Uint8Array((desc as ArrayBufferView).buffer);
        if (u.length >= 12 && new TextDecoder().decode(u.subarray(0, 8)) === 'OpusHead') preSkip = u[10] | (u[11] << 8);
      }
    },
    error: (e) => { failed = e as Error; },
  });
  enc.configure({ codec: 'opus', sampleRate: 48000, numberOfChannels: channels, bitrate });
  const block = 48000;
  for (let i = 0; i < l.length; i += block) {
    const n = Math.min(block, l.length - i);
    const data = new Float32Array(n * channels);
    data.set(l.subarray(i, i + n), 0);
    if (channels === 2) data.set(r.subarray(i, i + n), n);
    enc.encode(new AudioData({ format: 'f32-planar', sampleRate: 48000, numberOfFrames: n, numberOfChannels: channels,
      timestamp: Math.round((i / 48000) * 1e6), data }));
    if (enc.encodeQueueSize > 8) await new Promise((res) => setTimeout(res, 0));
  }
  await enc.flush();
  enc.close();
  if (failed) throw failed;
  return muxOggOpus(packets, { channels, preSkip, inputRate: sampleRate, totalSamples: l.length });
}
