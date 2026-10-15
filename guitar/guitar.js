/* Guitar tuner: live needle for whichever string is playing (or the one you pick). */
(function () {
  "use strict";

  const { notes, Mic, detectPitch, refineFrequency, Gauge, formatCents, store } = window.Tuner;

  const STORAGE_KEY = "instrument-tuner:guitar:v1";

  const GOOD = 3; // cents: guitar tuners are usually this strict
  const OK = 10;

  // Strings, lowest (6th) to highest (1st), as MIDI note numbers.
  const TUNINGS = {
    standard: { label: "Standard", strings: [40, 45, 50, 55, 59, 64] },
    dropD: { label: "Drop D", strings: [38, 45, 50, 55, 59, 64] },
    halfDown: { label: "Half step down", strings: [39, 44, 49, 54, 58, 63], flats: true },
    fullDown: { label: "Whole step down", strings: [38, 43, 48, 53, 57, 62] },
    dropC: { label: "Drop C", strings: [36, 43, 48, 53, 57, 62] },
    dadgad: { label: "DADGAD", strings: [38, 45, 50, 55, 57, 62] },
    openG: { label: "Open G", strings: [38, 43, 50, 55, 59, 62] },
    openD: { label: "Open D", strings: [38, 45, 50, 54, 57, 62] },
    openE: { label: "Open E", strings: [40, 47, 52, 56, 59, 64] },
  };

  // Readings are matched to a string within this many cents. Neighbouring
  // strings are at least 200 cents apart, so a badly-out string still matches.
  const SEARCH_CENTS = 450;
  const SWITCH_FRAMES = 3; // frames a new string must win before auto mode switches to it
  const SETTLE_MS = 600; // a reading must hold this long to tick (or untick) a string
  const HOLD_MS = 1500; // keep showing the last reading this long after the string fades
  const FRAME_MS = 40;

  const FLATS = { "C♯": "D♭", "D♯": "E♭", "F♯": "G♭", "G♯": "A♭", "A♯": "B♭" };

  function noteName(midi, flats) {
    const name = notes.name(midi);
    const pc = name.replace(/-?\d+$/, "");
    return flats && FLATS[pc] ? FLATS[pc] + name.slice(pc.length) : name;
  }

  function ordinal(n) {
    return n + (["th", "st", "nd", "rd"][n] || "th");
  }

  // ---------- Pitch analysis ----------

  /*
   * Finds which string is sounding and how far off it is.
   *   targets - each string's target frequency, lowest first
   *   only    - index of the one string to listen for, or -1 to work it out
   * Returns { index, cents, freq } or null.
   */
  function analyse(samples, sampleRate, targets, only) {
    const span = Math.pow(2, SEARCH_CENTS / 1200);
    const range = only >= 0
      ? [targets[only] / span, targets[only] * span]
      : [Math.min(...targets) / span, Math.max(...targets) * span];
    const pitch = detectPitch(samples, sampleRate, {
      minFreq: range[0],
      maxFreq: range[1],
      threshold: 0.35,
      decimate: 2, // guitar strings are all below ~450 Hz
    });
    if (!pitch) return null;

    let index = only;
    if (index < 0) {
      index = 0;
      targets.forEach((t, i) => {
        if (Math.abs(notes.cents(pitch.freq, t)) < Math.abs(notes.cents(pitch.freq, targets[index]))) index = i;
      });
    }

    // Pin down the fundamental's exact frequency; on a weak low string use the
    // 2nd–4th partial, failing that the overall pitch.
    let freq = pitch.freq;
    for (let n = 1; n <= 4; n++) {
      const partial = refineFrequency(samples, sampleRate, pitch.freq * n);
      if (partial) {
        freq = partial / n;
        break;
      }
    }
    return { index, freq, cents: notes.cents(freq, targets[index]) };
  }

  // ---------- State ----------

  const settings = Object.assign({ tuning: "standard", a4: 440 }, store.get(STORAGE_KEY, {}));
  if (!TUNINGS[settings.tuning]) settings.tuning = "standard";

  let picked = -1; // string chosen by tapping, or -1 for auto
  let current = -1; // string being shown
  let candidate = -1; // auto mode: string that's trying to take over
  let candidateFrames = 0;
  let tuned = []; // per string: last settled reading was in tune
  let liveCents = null;
  let liveFreq = null;
  let lastHeard = 0;
  let settleIn = null; // whether the reading is currently within GOOD
  let settleStart = 0;
  let noiseFloor = 0.002;
  let lastFrame = 0;
  let mic = null;

  function tuning() {
    return TUNINGS[settings.tuning];
  }

  function targets() {
    return tuning().strings.map((m) => notes.freq(m, settings.a4));
  }

  function save() {
    store.set(STORAGE_KEY, settings);
  }

  // ---------- Elements ----------

  const $ = (id) => document.getElementById(id);
  const gauge = new Gauge($("gauge"), { range: 50, good: GOOD, ok: OK });

  function rating(cents) {
    return gauge.rating(cents);
  }

  function buildTuningSelect() {
    $("tuning").innerHTML = Object.entries(TUNINGS)
      .map(([key, t]) => {
        const names = t.strings.map((m) => noteName(m, t.flats).replace(/\d+$/, "")).join(" ");
        return `<option value="${key}">${t.label} (${names})</option>`;
      })
      .join("");
    $("tuning").value = settings.tuning;
    $("a4").value = settings.a4;
  }

  function buildStrings() {
    const t = tuning();
    $("strings").innerHTML = t.strings
      .map((m, i) => `<button class="string" data-index="${i}" aria-pressed="false">` +
        `<span class="string-note">${noteName(m, t.flats).replace(/\d+$/, "")}</span>` +
        `<span class="string-num">${ordinal(t.strings.length - i)}</span></button>`)
      .join("");
  }

  function resetReadings() {
    current = picked;
    candidate = -1;
    candidateFrames = 0;
    liveCents = null;
    liveFreq = null;
    settleIn = null;
  }

  // ---------- Listening loop ----------

  function step(now) {
    if (now - lastFrame < FRAME_MS) return;
    lastFrame = now;

    const { samples, rms } = mic.read();
    if (rms < noiseFloor * 4) noiseFloor = noiseFloor * 0.97 + rms * 0.03; // follow room noise
    const loud = rms > Math.max(0.003, noiseFloor * 3);
    const result = loud ? analyse(samples, mic.sampleRate, targets(), picked) : null;

    if (result) {
      // In auto mode, don't jump to another string on a single stray frame.
      let accept = true;
      if (picked < 0 && result.index !== current && current >= 0) {
        candidateFrames = result.index === candidate ? candidateFrames + 1 : 1;
        candidate = result.index;
        accept = candidateFrames >= SWITCH_FRAMES;
      }
      if (accept) {
        if (result.index !== current) {
          current = result.index;
          liveCents = null;
          settleIn = null;
        }
        candidate = -1;
        // Smooth the needle, but follow a fresh pluck or a big peg turn at once.
        liveCents = liveCents === null || Math.abs(result.cents - liveCents) > 30
          ? result.cents
          : liveCents * 0.65 + result.cents * 0.35;
        liveFreq = result.freq;
        lastHeard = now;

        const inTune = Math.abs(liveCents) <= GOOD;
        if (inTune !== settleIn) {
          settleIn = inTune;
          settleStart = now;
        } else if (now - settleStart >= SETTLE_MS) {
          tuned[current] = inTune;
        }
      }
    } else if (liveCents !== null && now - lastHeard > HOLD_MS) {
      liveCents = null;
      liveFreq = null;
      settleIn = null;
      if (picked < 0) current = -1;
    }
    render();
  }

  function startLoop() {
    const tick = (now) => {
      requestAnimationFrame(tick);
      step(now);
    };
    requestAnimationFrame(tick);
  }

  // ---------- Rendering ----------

  function render() {
    const t = tuning();
    const count = t.strings.length;

    if (current >= 0) {
      const midi = t.strings[current];
      const num = count - current;
      const which = current === 0 ? " · thickest" : current === count - 1 ? " · thinnest" : "";
      $("note-name").textContent = noteName(midi, t.flats);
      $("note-hint").textContent = `${ordinal(num)} string${which} · ${targets()[current].toFixed(1)} Hz`;
    } else {
      $("note-name").textContent = "–";
      $("note-hint").textContent = mic ? "Any string" : "";
    }

    gauge.set(liveCents);
    const reading = $("reading");
    reading.className = "reading" + (liveCents !== null ? " " + rating(liveCents) : "");
    reading.textContent = liveCents !== null ? formatCents(liveCents) : "";

    let status;
    if (!mic) status = "";
    else if (liveCents === null) {
      status = tuned.filter(Boolean).length === count
        ? "All strings in tune ✓"
        : current >= 0 ? `Pluck the ${ordinal(count - current)} string` : "Pluck a string and let it ring";
    } else if (Math.abs(liveCents) <= GOOD) {
      status = tuned[current] ? "In tune ✓" : "In tune… hold it";
    } else {
      const lot = Math.abs(liveCents) > 50 ? " a lot" : "";
      status = liveCents < 0
        ? `Too low: tighten the string${lot} (tune up)`
        : `Too high: loosen the string${lot} (tune down)`;
    }
    $("status").textContent = status;
    $("heard").textContent = liveFreq !== null ? `Hearing ${liveFreq.toFixed(1)} Hz` : "";

    $("auto-btn").setAttribute("aria-pressed", picked < 0);
    document.querySelectorAll("#strings .string").forEach((b) => {
      const i = +b.dataset.index;
      b.setAttribute("aria-pressed", i === picked);
      b.classList.toggle("active", i === current);
      b.classList.toggle("tuned", !!tuned[i]);
    });
  }

  // ---------- Controls ----------

  $("start-btn").addEventListener("click", async () => {
    $("error").hidden = true;
    try {
      mic = new Mic({ fftSize: 4096 }); // ~90 ms of audio: several cycles of the lowest string
      await mic.start();
    } catch (err) {
      mic = null;
      $("error").textContent =
        err && err.name === "NotAllowedError"
          ? "Microphone access was blocked. On iPhone: Settings → Safari → Microphone → Allow, then reload."
          : (err && err.message) || "Couldn't start the microphone.";
      $("error").hidden = false;
      return;
    }
    $("start-btn").hidden = true;
    render();
    startLoop();
  });

  $("auto-btn").addEventListener("click", () => {
    picked = -1;
    resetReadings();
    render();
  });

  $("strings").addEventListener("click", (e) => {
    const b = e.target.closest(".string");
    if (!b) return;
    const i = +b.dataset.index;
    picked = picked === i ? -1 : i; // tap the picked string again to go back to auto
    resetReadings();
    render();
  });

  $("tuning").addEventListener("change", () => {
    settings.tuning = $("tuning").value;
    save();
    picked = -1;
    tuned = [];
    resetReadings();
    buildStrings();
    render();
  });

  $("a4").addEventListener("change", () => {
    const a4 = parseFloat($("a4").value);
    settings.a4 = a4 >= 400 && a4 <= 480 ? a4 : 440;
    $("a4").value = settings.a4;
    save();
    tuned = [];
    resetReadings();
    render();
  });

  buildTuningSelect();
  buildStrings();
  render();
})();
