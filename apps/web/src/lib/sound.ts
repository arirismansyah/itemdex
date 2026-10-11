// 8-bit sound effects with WebAudio square waves. No audio files needed.

let ctx: AudioContext | undefined;
let enabled = true;
try { enabled = localStorage.getItem('itemdex.sound') !== 'off'; } catch { /* storage blocked */ }

interface ToneOpts { type?: OscillatorType; vol?: number; slideTo?: number }

function tone(freq: number, start: number, dur: number, { type = 'square', vol = 0.06, slideTo }: ToneOpts = {}) {
  ctx ??= new AudioContext();
  const t = ctx.currentTime + start;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
  gain.gain.setValueAtTime(vol, t);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(gain).connect(ctx.destination);
  osc.start(t);
  osc.stop(t + dur + 0.02);
}

const seq = (notes: number[], step = 0.08, opts?: ToneOpts) =>
  notes.forEach((f, i) => f && tone(f, i * step, step * 0.95, opts));

const fx = {
  click: () => tone(660, 0, 0.05, { vol: 0.04 }),
  select: () => seq([523, 784], 0.05),
  tick: () => tone(1200, 0, 0.03, { vol: 0.02 }),
  appear: () => seq([392, 523, 659, 784, 1047], 0.06),
  // The classic "item get" jingle vibe.
  get: () => {
    seq([523, 523, 523, 659, 0, 784, 0, 1047], 0.09);
    seq([262, 262, 262, 330, 0, 392, 0, 523], 0.09, { type: 'triangle', vol: 0.08 });
  },
  error: () => seq([220, 165], 0.12, { type: 'sawtooth', vol: 0.05 }),
  remove: () => tone(400, 0, 0.25, { slideTo: 80, vol: 0.05 }),
  type: () => tone(880 + Math.random() * 200, 0, 0.02, { vol: 0.015 }),
};
export type SoundName = keyof typeof fx;

export const Sound = {
  play(name: SoundName) {
    if (!enabled) return;
    try { fx[name](); } catch { /* audio unavailable */ }
  },
  toggle(): boolean {
    enabled = !enabled;
    try { localStorage.setItem('itemdex.sound', enabled ? 'on' : 'off'); } catch { /* ignore */ }
    return enabled;
  },
  get enabled() { return enabled; },
};
