// CTC forced alignment: given per-frame log-probabilities from a character model (wav2vec2)
// and the known lyrics, find where each word is sung (Viterbi over the CTC graph).
// Knowing the words makes this far more precise than speech recognition timestamps.

export interface AlignedWord { start: number; end: number; score: number } // frames; score 0..1

/** Model characters for one lyric token: accents stripped, upper-case, only symbols the model
 *  knows (letters and apostrophe for the English wav2vec2 vocabulary). */
export function charIds(token: string, vocab: Record<string, number>): number[] {
  const t = token.normalize('NFKD').replace(/\p{M}/gu, '').toUpperCase().replace(/[’‘`]/g, "'");
  const out: number[] = [];
  for (const c of t) {
    const id = vocab[c];
    if (id !== undefined && c !== '|') out.push(id);
  }
  // a lone apostrophe isn't a word
  return out.length === 1 && t.replace(/[^A-Z0-9]/g, '') === '' ? [] : out;
}

/** In-place log-softmax over each frame of a [T, V] row-major array. */
export function logSoftmax(x: Float32Array, T: number, V: number): Float32Array {
  for (let t = 0; t < T; t++) {
    const o = t * V;
    let max = -Infinity;
    for (let v = 0; v < V; v++) if (x[o + v] > max) max = x[o + v];
    let sum = 0;
    for (let v = 0; v < V; v++) sum += Math.exp(x[o + v] - max);
    const lse = max + Math.log(sum);
    for (let v = 0; v < V; v++) x[o + v] -= lse;
  }
  return x;
}

/**
 * Align words (each a list of character ids, may be empty) to frames.
 * logp: [T, V] log-probabilities. sep: the word-separator id (wav2vec2 "|"), placed between
 * words. Returns one entry per word; null for words without characters or if alignment is
 * impossible (more characters than frames).
 */
export function forcedAlign(logp: Float32Array, T: number, V: number, words: number[][], blank = 0, sep = -1): (AlignedWord | null)[] {
  // target label sequence with word index per label
  const labels: number[] = [];
  const wordOf: number[] = [];
  let first = true;
  words.forEach((chars, w) => {
    if (!chars.length) return;
    if (!first && sep >= 0) { labels.push(sep); wordOf.push(-1); }
    first = false;
    for (const c of chars) { labels.push(c); wordOf.push(w); }
  });
  const L = labels.length;
  const out: (AlignedWord | null)[] = words.map(() => null);
  if (!L) return out;
  // CTC states: blank, l0, blank, l1, ..., blank  (S = 2L + 1)
  const S = 2 * L + 1;
  let minFrames = L;
  for (let i = 1; i < L; i++) if (labels[i] === labels[i - 1]) minFrames++;
  if (T < minFrames) return out;

  const lab = (s: number) => (s & 1 ? labels[s >> 1] : blank);
  const NEG = -1e30;
  let prev = new Float64Array(S).fill(NEG);
  let cur = new Float64Array(S);
  const back = new Uint8Array(T * S); // 0: stay, 1: from s-1, 2: from s-2
  prev[0] = logp[blank];
  prev[1] = logp[labels[0]];
  for (let t = 1; t < T; t++) {
    const o = t * V;
    // states that can still reach the end in the remaining frames are the only useful ones,
    // but the plain recursion is fast enough for a song (T ~ 15k, S ~ 3k)
    for (let s = 0; s < S; s++) {
      let best = prev[s], b = 0;
      if (s > 0 && prev[s - 1] > best) { best = prev[s - 1]; b = 1; }
      if (s > 1 && (s & 1) && labels[s >> 1] !== labels[(s >> 1) - 1] && prev[s - 2] > best) { best = prev[s - 2]; b = 2; }
      cur[s] = best + logp[o + lab(s)];
      back[t * S + s] = b;
    }
    [prev, cur] = [cur, prev];
  }
  // end in the last label or the trailing blank
  let s = prev[S - 1] >= prev[S - 2] ? S - 1 : S - 2;
  if (prev[s] <= NEG / 2) return out;
  // backtrack: which label does each frame emit
  const stateAt = new Int32Array(T);
  for (let t = T - 1; t >= 0; t--) {
    stateAt[t] = s;
    if (t > 0) s -= back[t * S + s];
  }
  const sumP = new Float64Array(words.length);
  const nP = new Int32Array(words.length);
  for (let t = 0; t < T; t++) {
    const st = stateAt[t];
    if (!(st & 1)) continue;
    const w = wordOf[st >> 1];
    if (w < 0) continue;
    const a = out[w];
    if (!a) out[w] = { start: t, end: t + 1, score: 0 };
    else a.end = t + 1;
    sumP[w] += Math.exp(logp[t * V + labels[st >> 1]]);
    nP[w]++;
  }
  out.forEach((a, w) => { if (a) a.score = nP[w] ? sumP[w] / nP[w] : 0; });
  return out;
}
