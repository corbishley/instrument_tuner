/*
 * Shared tuner engine, used by every instrument page.
 *
 *   Tuner.notes   - note names and frequencies (MIDI numbering)
 *   Tuner.Mic     - microphone input with iOS-friendly settings
 *   Tuner.detectPitch - pitch detection, optionally limited to a range
 *   Tuner.refineFrequency - pins down the fundamental's exact frequency
 *   Tuner.Gauge   - SVG needle gauge showing cents sharp/flat
 *
 * Plain script (no modules) so pages also work when opened from disk.
 */
(function () {
  "use strict";

  // ---------- Notes ----------

  const NAMES = ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"];

  const notes = {
    name(midi) {
      return NAMES[midi % 12] + (Math.floor(midi / 12) - 1);
    },
    isSharp(midi) {
      return [1, 3, 6, 8, 10].includes(midi % 12);
    },
    // Equal-tempered frequency, with A4 (MIDI 69) at `a4` Hz.
    freq(midi, a4 = 440) {
      return a4 * Math.pow(2, (midi - 69) / 12);
    },
    cents(measured, target) {
      return 1200 * Math.log2(measured / target);
    },
  };

  // ---------- Microphone ----------

  class Mic {
    constructor({ fftSize = 8192 } = {}) {
      this.fftSize = fftSize;
      this.ctx = null;
      this.analyser = null;
      this.stream = null;
      this.buffer = null;
      this.wakeLock = null;
    }

    // Must be called from a tap/click: iOS only allows audio after a user gesture.
    async start() {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error("This browser can't access the microphone. On iPhone, use Safari and open the page over https.");
      }
      const AC = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AC();
      await this.ctx.resume();

      // Turn off voice processing: it distorts musical notes.
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });

      const source = this.ctx.createMediaStreamSource(this.stream);
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = this.fftSize;
      this.analyser.smoothingTimeConstant = 0;
      source.connect(this.analyser);
      this.buffer = new Float32Array(this.analyser.fftSize);

      this.keepAwake();
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") {
          this.keepAwake();
          if (this.ctx.state !== "running") this.ctx.resume();
        }
      });
    }

    async keepAwake() {
      try {
        if ("wakeLock" in navigator) this.wakeLock = await navigator.wakeLock.request("screen");
      } catch (_) {
        // Not supported or refused; the screen may dim, nothing else breaks.
      }
    }

    get sampleRate() {
      return this.ctx.sampleRate;
    }

    // Returns the latest block of samples and its loudness (RMS).
    read() {
      this.analyser.getFloatTimeDomainData(this.buffer);
      let sum = 0;
      for (let i = 0; i < this.buffer.length; i++) sum += this.buffer[i] * this.buffer[i];
      return { samples: this.buffer, rms: Math.sqrt(sum / this.buffer.length) };
    }

    stop() {
      if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
      if (this.ctx) this.ctx.close();
      if (this.wakeLock) this.wakeLock.release().catch(() => {});
    }
  }

  // ---------- Pitch detection ----------

  /*
   * Normalised difference function (the core of YIN / McLeod), computed only
   * for the lags inside [minFreq, maxFreq], so a narrow range is very cheap.
   *
   * Returns { freq, clarity } or null. clarity is 0..1 (1 = perfectly periodic).
   *
   * When the expected note is known, pass a narrow range: it prevents octave
   * mistakes, which matter for piano bass notes whose fundamental is weak.
   *
   * `periods` > 1 measures across several cycles at once (e.g. 4 cycles of a
   * high note). Short periods are only a few samples long, so this gives much
   * finer resolution for treble notes. Keep the range within about
   * ±1700/periods cents so the dips at neighbouring multiples stay outside it.
   *
   * `decimate` > 1 averages that many samples together first: low notes have
   * long periods, so this makes them several times cheaper with no real loss.
   */
  function detectPitch(samples, sampleRate, { minFreq = 25, maxFreq = 4500, threshold = 0.3, periods = 1, decimate = 1 } = {}) {
    if (decimate > 1) {
      const out = new Float32Array(Math.floor(samples.length / decimate));
      for (let i = 0; i < out.length; i++) {
        let sum = 0;
        for (let k = 0; k < decimate; k++) sum += samples[i * decimate + k];
        out[i] = sum / decimate;
      }
      samples = out;
      sampleRate /= decimate;
    }
    const lo = Math.max(2, Math.floor((sampleRate * periods) / maxFreq) - 1);
    const hi = Math.min(Math.ceil((sampleRate * periods) / minFreq) + 1, Math.floor(samples.length / 2));
    if (hi <= lo + 1) return null;

    const span = samples.length - hi;
    const nd = new Float32Array(hi + 1);
    nd.fill(1);
    for (let tau = lo; tau <= hi; tau++) {
      let diff = 0;
      let energy = 0;
      for (let j = 0; j < span; j++) {
        const a = samples[j];
        const b = samples[j + tau];
        diff += (a - b) * (a - b);
        energy += a * a + b * b;
      }
      nd[tau] = energy === 0 ? 1 : diff / energy; // 0 = identical, ~1 = unrelated
    }

    // Deepest dip; then prefer the shortest lag that's nearly as deep, because
    // a note also repeats at 2x, 3x... its period (which would read an octave low).
    let globalMin = Infinity;
    for (let tau = lo + 1; tau < hi; tau++) globalMin = Math.min(globalMin, nd[tau]);
    if (globalMin > threshold) return null;
    let best = -1;
    for (let tau = lo + 1; tau < hi; tau++) {
      if (nd[tau] <= globalMin + 0.05 && nd[tau] <= nd[tau - 1] && nd[tau] <= nd[tau + 1]) {
        best = tau;
        break;
      }
    }
    if (best === -1) return null; // only dips at the edges: real pitch is outside the range

    // Parabolic interpolation for sub-sample accuracy.
    const a = nd[best - 1];
    const b = nd[best];
    const c = nd[best + 1];
    const denom = a - 2 * b + c;
    const shift = denom === 0 ? 0 : (0.5 * (a - c)) / denom;
    const freq = (sampleRate * periods) / (best + Math.max(-1, Math.min(1, shift)));

    if (freq < minFreq || freq > maxFreq) return null;
    return { freq, clarity: 1 - b };
  }

  /*
   * Sharpens a rough estimate by finding the exact frequency of that partial
   * with a fine spectral scan (Hann-windowed DFT, 1-cent steps) within ±`cents`.
   *
   * Why: detectPitch measures how often the whole waveform repeats. On strings
   * with sharp overtones (piano, especially) that reads a few cents above the
   * fundamental. The fundamental's own frequency is what tuners measure.
   *
   * Returns the refined frequency, or null when that partial carries less than
   * `minPower` of the signal's power (e.g. a weak fundamental in the deep bass).
   */
  function refineFrequency(samples, sampleRate, freq, { cents = 40, minPower = 0.02 } = {}) {
    const N = samples.length;
    const w = new Float32Array(N);
    let power = 0;
    for (let i = 0; i < N; i++) {
      w[i] = samples[i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1)));
      power += samples[i] * samples[i];
    }
    if (power === 0) return null;

    const steps = 2 * cents + 1;
    const mags = new Float32Array(steps);
    for (let k = 0; k < steps; k++) {
      const f = freq * Math.pow(2, (k - cents) / 1200);
      // Goertzel: one DFT bin at an arbitrary frequency.
      const coeff = 2 * Math.cos((2 * Math.PI * f) / sampleRate);
      let s1 = 0, s2 = 0;
      for (let i = 0; i < N; i++) {
        const s0 = w[i] + coeff * s1 - s2;
        s2 = s1;
        s1 = s0;
      }
      mags[k] = Math.sqrt(Math.max(0, s1 * s1 + s2 * s2 - coeff * s1 * s2));
    }

    let best = 0;
    for (let k = 1; k < steps; k++) if (mags[k] > mags[best]) best = k;
    if (best === 0 || best === steps - 1) return null;

    // Share of the signal's power in this partial (Hann peak = amplitude * N / 4).
    const amp = (mags[best] * 4) / N;
    if ((amp * amp) / 2 / (power / N) < minPower) return null;

    const a = mags[best - 1], b = mags[best], c = mags[best + 1];
    const denom = a - 2 * b + c;
    const shift = denom === 0 ? 0 : (0.5 * (a - c)) / denom;
    return freq * Math.pow(2, (best - cents + shift) / 1200);
  }

  // ---------- Gauge ----------

  /*
   * Semicircle gauge from -range to +range cents.
   *   const g = new Tuner.Gauge(element, { range: 50, good: 5, ok: 15 });
   *   g.set(-12);   // needle to 12 cents flat
   *   g.set(null);  // idle
   */
  class Gauge {
    constructor(el, { range = 50, good = 5, ok = 15 } = {}) {
      this.range = range;
      this.good = good;
      this.ok = ok;
      const ns = "http://www.w3.org/2000/svg";
      const svg = document.createElementNS(ns, "svg");
      svg.setAttribute("viewBox", "0 0 300 170");
      svg.setAttribute("class", "gauge");
      svg.setAttribute("role", "img");
      svg.setAttribute("aria-label", "Tuning gauge");

      const arc = (from, to, color, width) => {
        const p = document.createElementNS(ns, "path");
        const [x1, y1] = this.point(from, 120);
        const [x2, y2] = this.point(to, 120);
        p.setAttribute("d", `M ${x1} ${y1} A 120 120 0 0 1 ${x2} ${y2}`);
        p.setAttribute("fill", "none");
        p.setAttribute("stroke", color);
        p.setAttribute("stroke-width", width);
        svg.appendChild(p);
      };
      arc(-range, -ok, "var(--bad)", 14);
      arc(-ok, -good, "var(--warn)", 14);
      arc(-good, good, "var(--good)", 14);
      arc(good, ok, "var(--warn)", 14);
      arc(ok, range, "var(--bad)", 14);

      // Tick marks every 10 cents.
      for (let c = -range; c <= range; c += 10) {
        const [x1, y1] = this.point(c, 100);
        const [x2, y2] = this.point(c, c === 0 ? 86 : 92);
        const t = document.createElementNS(ns, "line");
        t.setAttribute("x1", x1); t.setAttribute("y1", y1);
        t.setAttribute("x2", x2); t.setAttribute("y2", y2);
        t.setAttribute("stroke", "var(--muted)");
        t.setAttribute("stroke-width", c === 0 ? 3 : 1.5);
        svg.appendChild(t);
      }

      const label = (text, c) => {
        const [x, y] = this.point(c, 145);
        const t = document.createElementNS(ns, "text");
        t.setAttribute("x", x); t.setAttribute("y", y + 4);
        t.setAttribute("text-anchor", "middle");
        t.setAttribute("font-size", "13");
        t.setAttribute("fill", "var(--muted)");
        t.textContent = text;
        svg.appendChild(t);
      };
      label("flat", -range * 0.82);
      label("sharp", range * 0.82);

      this.needle = document.createElementNS(ns, "line");
      this.needle.setAttribute("x1", 150); this.needle.setAttribute("y1", 150);
      this.needle.setAttribute("x2", 150); this.needle.setAttribute("y2", 40);
      this.needle.setAttribute("stroke", "var(--text)");
      this.needle.setAttribute("stroke-width", 4);
      this.needle.setAttribute("stroke-linecap", "round");
      this.needle.style.transformOrigin = "150px 150px";
      this.needle.style.transition = "transform 120ms ease-out, opacity 200ms";
      svg.appendChild(this.needle);

      const hub = document.createElementNS(ns, "circle");
      hub.setAttribute("cx", 150); hub.setAttribute("cy", 150); hub.setAttribute("r", 8);
      hub.setAttribute("fill", "var(--text)");
      svg.appendChild(hub);

      el.appendChild(svg);
      this.set(null);
    }

    // Position on the arc for a cents value (0 = straight up).
    point(cents, radius) {
      const angle = (cents / this.range) * (Math.PI / 2) * 0.92;
      return [150 + radius * Math.sin(angle), 150 - radius * Math.cos(angle)];
    }

    set(cents) {
      if (cents === null || cents === undefined) {
        this.needle.style.opacity = "0.25";
        this.needle.style.transform = "rotate(0deg)";
        return;
      }
      const clamped = Math.max(-this.range, Math.min(this.range, cents));
      const deg = (clamped / this.range) * 90 * 0.92;
      this.needle.style.opacity = "1";
      this.needle.style.transform = `rotate(${deg}deg)`;
    }

    // "good" | "ok" | "bad" for a cents value.
    rating(cents) {
      const a = Math.abs(cents);
      return a <= this.good ? "good" : a <= this.ok ? "ok" : "bad";
    }
  }

  // ---------- Small helpers ----------

  function median(values) {
    const s = [...values].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }

  function formatCents(cents) {
    const r = Math.round(cents);
    if (r === 0) return "0 cents (in tune)";
    return `${r > 0 ? "+" : "−"}${Math.abs(r)} cents (${r > 0 ? "sharp" : "flat"})`;
  }

  // localStorage can throw (private mode, blocked storage); never let that break the page.
  const store = {
    get(key, fallback) {
      try {
        const v = localStorage.getItem(key);
        return v === null ? fallback : JSON.parse(v);
      } catch (_) {
        return fallback;
      }
    },
    set(key, value) {
      try { localStorage.setItem(key, JSON.stringify(value)); } catch (_) {}
    },
    remove(key) {
      try { localStorage.removeItem(key); } catch (_) {}
    },
  };

  window.Tuner = { notes, Mic, detectPitch, refineFrequency, Gauge, median, formatCents, store };
})();
