// Lightweight audio feedback — tiny Web Audio oscillator "blips" with zero assets.
// A shared AudioContext is created lazily on first user gesture so browsers allow it,
// then reused for every cue. Sound stays subtle (low gain) and is safelisted to run
// only for real click/select interactions.

let ctx = null;
let enabled = true;

function ensureCtx() {
  if (typeof window === "undefined") return null;
  if (!ctx) {
    const AC = window.AudioContext || window["webkitAudioContext"];
    if (!AC) return null;
    ctx = new AC();
  }
  if (ctx.state === "suspended") {
    ctx.resume().catch(() => {});
  }
  return ctx;
}

function blip({ freq = 520, end = 900, dur = 0.06, type = "sine", gain = 0.045, delay = 0 }) {
  if (!enabled) return;
  const ac = ensureCtx();
  if (!ac) return;
  try {
    const t0 = ac.currentTime + delay;
    const osc = ac.createOscillator();
    const g = ac.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    osc.frequency.exponentialRampToValueAtTime(Math.max(1, end), t0 + dur);
    g.gain.setValueAtTime(gain, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g);
    g.connect(ac.destination);
    osc.start(t0);
    osc.stop(t0 + dur + 0.01);
  } catch {
    /* audio is best-effort only */
  }
}

function noiseBurst({ dur = 0.08, gain = 0.05 }) {
  if (!enabled) return;
  const ac = ensureCtx();
  if (!ac) return;
  try {
    const t0 = ac.currentTime;
    const buffer = ac.createBuffer(1, Math.floor(ac.sampleRate * dur), ac.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length);
    const src = ac.createBufferSource();
    const g = ac.createGain();
    src.buffer = buffer;
    g.gain.value = gain;
    src.connect(g);
    g.connect(ac.destination);
    src.start(t0);
  } catch {
    /* ignored */
  }
}

// Distinct cues
export const sfx = {
  click() {
    blip({ freq: 620, end: 1050, dur: 0.045, type: "triangle", gain: 0.05 });
  },
  success() {
    blip({ freq: 620, end: 980, dur: 0.06, type: "triangle", gain: 0.05 });
    blip({ freq: 880, end: 1320, dur: 0.07, type: "triangle", gain: 0.04, delay: 0.07 });
  },
  error() {
    blip({ freq: 300, end: 180, dur: 0.12, type: "sawtooth", gain: 0.04 });
    blip({ freq: 220, end: 140, dur: 0.14, type: "sawtooth", gain: 0.03, delay: 0.06 });
  },
  pop() {
    noiseBurst({ dur: 0.05, gain: 0.03 });
    blip({ freq: 1100, end: 500, dur: 0.05, type: "sine", gain: 0.04 });
  },
  setEnabled(value) {
    enabled = !!value;
  },
  isEnabled() {
    return enabled;
  },
};

// Global interaction sound — plays a soft click on any button/link/select press
let attached = false;
export function attachClickSounds() {
  if (attached || typeof document === "undefined") return;
  attached = true;
  const selector = "button, a[href], [role=button], [role=menuitem], select, .fx-clickable";
  document.addEventListener(
    "pointerdown",
    (e) => {
      if (!enabled) return;
      const t = e.target;
      if (!t || !(t instanceof Element)) return;
      if (t.closest(selector)) sfx.click();
    },
    true
  );
}

export default sfx;