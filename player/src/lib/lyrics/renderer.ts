// Two-line karaoke display driven by requestAnimationFrame, outside Svelte reactivity, so
// the wipe stays smooth. Text goes in with textContent only.

import {
  type Lyrics, COUNTDOWN_DOTS, countdownDots, currentLineIndex, displayPair, inInstrumentalBreak, wordProgress,
} from '$shared/lyrics';

export class LyricsRenderer {
  private slots: HTMLDivElement[];
  private slotLine: (number | null)[] = [null, null];
  private wordEls: HTMLSpanElement[][] = [[], []];
  private dots: HTMLDivElement;
  private note: HTMLDivElement;
  private raf = 0;
  lyrics: Lyrics | null = null;

  constructor(private root: HTMLElement, private clock: () => number) {
    root.classList.add('lyrics');
    root.replaceChildren();
    this.dots = document.createElement('div');
    this.dots.className = 'countdown';
    this.note = document.createElement('div');
    this.note.className = 'break-note';
    this.note.textContent = '♪';
    this.slots = [0, 1].map((i) => {
      const d = document.createElement('div');
      d.className = `slot slot-${i}`;
      return d;
    });
    root.append(this.dots, ...this.slots, this.note);
  }

  setLyrics(l: Lyrics | null) {
    this.lyrics = l;
    this.slotLine = [null, null];
    for (const s of this.slots) s.replaceChildren();
    this.wordEls = [[], []];
  }

  start() {
    const tick = () => {
      this.render(this.clock());
      this.raf = requestAnimationFrame(tick);
    };
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(tick);
  }

  stop() { cancelAnimationFrame(this.raf); }

  render(t: number) {
    const lines = this.lyrics?.lines ?? [];
    const pair = displayPair(lines, t);
    const cur = currentLineIndex(lines, t);
    for (let s = 0; s < 2; s++) {
      const li = pair[s];
      if (li !== this.slotLine[s]) {
        this.slotLine[s] = li;
        this.fill(s, li);
      }
      const els = this.wordEls[s];
      if (li == null) continue;
      const words = lines[li].words;
      for (let k = 0; k < words.length; k++) {
        els[k].style.setProperty('--p', String(wordProgress(words[k], t)));
      }
      this.slots[s].classList.toggle('active', li === cur && t >= lines[li].start - 200);
    }
    const n = countdownDots(lines, cur, t);
    this.dots.textContent = n ? '●'.repeat(n) + '○'.repeat(COUNTDOWN_DOTS - n) : '';
    this.note.classList.toggle('show', inInstrumentalBreak(lines, t));
  }

  private fill(s: number, li: number | null) {
    const slot = this.slots[s];
    slot.replaceChildren();
    this.wordEls[s] = [];
    if (li == null || !this.lyrics) return;
    const line = this.lyrics.lines[li];
    slot.dataset.singer = line.singer ?? '';
    for (const w of line.words) {
      const span = document.createElement('span');
      span.className = 'w';
      span.dataset.t = w.t;      // drawn twice (unsung + sung overlay) via CSS
      span.textContent = w.t;
      slot.append(span, document.createTextNode(' '));
      this.wordEls[s].push(span);
    }
  }
}
