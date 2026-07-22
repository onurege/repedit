// All game audio is synthesized with WebAudio — no external files.
// Starts only after the first user gesture (browser autoplay policy).

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let ambientStarted = false;

function ensureCtx(): AudioContext | null {
  if (!ctx) {
    try {
      ctx = new AudioContext();
      master = ctx.createGain();
      master.gain.value = 0.5;
      master.connect(ctx.destination);
    } catch {
      return null;
    }
  }
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

export function unlockAudio(): void {
  const c = ensureCtx();
  if (c && !ambientStarted) {
    ambientStarted = true;
    startAmbient(c);
  }
}

function tone(
  freq: number,
  dur: number,
  type: OscillatorType = 'sine',
  gain = 0.15,
  when = 0,
  slide = 0
): void {
  const c = ensureCtx();
  if (!c || !master) return;
  const t0 = c.currentTime + when;
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  if (slide) osc.frequency.exponentialRampToValueAtTime(Math.max(30, freq + slide), t0 + dur);
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(gain, t0 + 0.01);
  g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
  osc.connect(g).connect(master);
  osc.start(t0);
  osc.stop(t0 + dur + 0.05);
}

export const sfx = {
  click(): void {
    tone(660, 0.06, 'triangle', 0.08);
  },
  sale(): void {
    tone(880, 0.09, 'sine', 0.12);
    tone(1320, 0.12, 'sine', 0.1, 0.07);
  },
  saleFar(): void {
    tone(880, 0.08, 'sine', 0.035);
  },
  purchase(): void {
    tone(520, 0.08, 'triangle', 0.12);
    tone(390, 0.12, 'triangle', 0.1, 0.06);
  },
  upgrade(): void {
    tone(523, 0.12, 'triangle', 0.14);
    tone(659, 0.12, 'triangle', 0.14, 0.1);
    tone(784, 0.12, 'triangle', 0.14, 0.2);
    tone(1047, 0.25, 'triangle', 0.16, 0.3);
  },
  delivery(): void {
    tone(740, 0.1, 'sine', 0.12);
    tone(988, 0.16, 'sine', 0.12, 0.09);
  },
  levelUp(): void {
    tone(659, 0.12, 'square', 0.06);
    tone(880, 0.12, 'square', 0.06, 0.1);
    tone(1319, 0.3, 'square', 0.07, 0.2);
  },
  error(): void {
    tone(220, 0.15, 'sawtooth', 0.06, 0, -60);
  },
};

// Gentle ambient bed: filtered noise (city hush) + soft low hum.
function startAmbient(c: AudioContext): void {
  if (!master) return;
  const bufferSize = c.sampleRate * 2;
  const buffer = c.createBuffer(1, bufferSize, c.sampleRate);
  const data = buffer.getChannelData(0);
  let last = 0;
  for (let i = 0; i < bufferSize; i++) {
    const white = Math.random() * 2 - 1;
    last = (last + 0.02 * white) / 1.02; // brown-ish noise
    data[i] = last * 3.5;
  }
  const noise = c.createBufferSource();
  noise.buffer = buffer;
  noise.loop = true;
  const filter = c.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = 400;
  const g = c.createGain();
  g.gain.value = 0.025;
  noise.connect(filter).connect(g).connect(master);
  noise.start();

  const lfo = c.createOscillator();
  lfo.frequency.value = 0.05;
  const lfoGain = c.createGain();
  lfoGain.gain.value = 0.012;
  lfo.connect(lfoGain).connect(g.gain);
  lfo.start();
}
