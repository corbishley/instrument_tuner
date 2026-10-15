/* Piano tuner: walks through the keys one at a time and records how far each is off. */
(function () {
  "use strict";

  const { notes, Mic, detectPitch, refineFrequency, Gauge, median, formatCents, store } = window.Tuner;

  const LOWEST = 21; // A0
  const HIGHEST = 108; // C8
  const STORAGE_KEY = "instrument-tuner:piano:v1";

  const GOOD = 5; // cents
  const OK = 15;

  // Readings must fall within this many cents of the target. Kept below 100 so
  // a neighbouring key that's still ringing can't be mistaken for this one.
  const SEARCH_CENTS = 70;
  const ATTACK_MS = 200; // ignore the noisy hammer strike (and the previous note in the buffer)
  const STABLE_COUNT = 6; // readings that must agree before a key is accepted
  const STABLE_SPREAD = 4; // cents
  const MAX_LISTEN_MS = 4000;
  const LOCKED_PAUSE_MS = 1200; // time to show a result before moving on
  const FRAME_MS = 50;

  // ---------- Targets ----------

  // Rough average of real piano stretch (Railsback curve): about −25 cents at
  // A0, about +30 at C8, flat through the middle two octaves.
  function stretchCents(midi) {
    const x = midi - 69;
    if (x > 12) return 30 * Math.pow((x - 12) / 27, 2);
    if (x < -12) return -25 * Math.pow((-x - 12) / 36, 2);
    return 0;
  }

  function targetFreq(midi, settings) {
    const base = notes.freq(midi, settings.a4);
    return settings.stretch ? base * Math.pow(2, stretchCents(midi) / 1200) : base;
  }

  function keyNumber(midi) {
    return midi - LOWEST + 1;
  }

  function hint(midi) {
    const special = {
      21: "the lowest key",
      60: "middle C",
      69: "the A above middle C",
      108: "the highest key",
    };
    const where = `key ${keyNumber(midi)} from the left`;
    return special[midi] ? `${special[midi]} · ${where}` : where;
  }

  function buildQueue(mode, order) {
    let keys = [];
    for (let m = LOWEST; m <= HIGHEST; m++) {
      if (mode === "quick" && m % 12 !== 9 && m % 12 !== 4) continue; // A and E only
      keys.push(m);
    }
    if (order === "outward") {
      const up = keys.filter((m) => m >= 69);
      const down = keys.filter((m) => m < 69).reverse();
      keys = up.concat(down);
    }
    return keys;
  }

  // ---------- State ----------

  let session = store.get(STORAGE_KEY, null); // { settings, queue, index, freqs: { midi: Hz } }
  // How results are judged:
  //   "neighbours" - against the keys around it. Robust: whatever the piano's
  //                  overall pitch and stretch, a key that stands out is out.
  //   "ref"        - against the reference pitch (plus stretch allowance).
  let judge = "neighbours";
  let mic = null;
  let running = false;

  function save() {
    store.set(STORAGE_KEY, session);
  }

  function centsOf(midi) {
    const f = session.freqs[midi];
    return f ? notes.cents(f, targetFreq(midi, session.settings)) : null;
  }

  function averageCents() {
    const all = Object.keys(session.freqs).map((m) => centsOf(+m));
    return all.length ? all.reduce((a, b) => a + b, 0) / all.length : 0;
  }

  // Median of the nearest measured keys (up to 6, within an octave), or the
  // overall average when too few nearby keys have been checked.
  function neighbourCents(midi, avg) {
    const near = Object.keys(session.freqs).map(Number)
      .filter((m) => m !== midi && Math.abs(m - midi) <= 12)
      .sort((a, b) => Math.abs(a - midi) - Math.abs(b - midi))
      .slice(0, 6)
      .map(centsOf);
    return near.length >= 3 ? median(near) : avg;
  }

  function judgedCents(midi, avg) {
    const c = centsOf(midi);
    if (c === null) return null;
    return judge === "neighbours" ? c - neighbourCents(midi, avg) : c;
  }

  function rating(cents) {
    const a = Math.abs(cents);
    return a <= GOOD ? "good" : a <= OK ? "ok" : "bad";
  }

  // ---------- Elements ----------

  const $ = (id) => document.getElementById(id);
  const views = { setup: $("setup"), tuning: $("tuning"), results: $("results") };

  function show(name) {
    for (const [k, el] of Object.entries(views)) el.hidden = k !== name;
    running = name === "tuning";
    if (running) startLoop();
    window.scrollTo(0, 0);
  }

  const gauge = new Gauge($("gauge"), { range: 50, good: GOOD, ok: OK });

  // ---------- Keyboard drawing ----------

  function buildKeyboard(container, { compact, onTap }) {
    const ns = "http://www.w3.org/2000/svg";
    const W = 18, H = 100, BW = 11, BH = 62;
    const whiteCount = 52;
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", `0 0 ${whiteCount * W} ${H + 14}`);
    svg.setAttribute("class", "keyboard" + (compact ? " compact" : ""));
    const rects = {};
    const xs = {};
    const blacks = [];

    let white = 0;
    for (let m = LOWEST; m <= HIGHEST; m++) {
      const r = document.createElementNS(ns, "rect");
      r.dataset.midi = m;
      if (notes.isSharp(m)) {
        r.setAttribute("x", white * W - BW / 2);
        r.setAttribute("y", 0);
        r.setAttribute("width", BW);
        r.setAttribute("height", BH);
        r.setAttribute("rx", 1.5);
        xs[m] = white * W;
        blacks.push(r);
      } else {
        r.setAttribute("x", white * W);
        r.setAttribute("y", 0);
        r.setAttribute("width", W);
        r.setAttribute("height", H);
        r.setAttribute("rx", 2);
        xs[m] = white * W + W / 2;
        svg.appendChild(r);
        if (m % 12 === 0) {
          const t = document.createElementNS(ns, "text");
          t.setAttribute("x", xs[m]);
          t.setAttribute("y", H + 11);
          t.textContent = notes.name(m);
          svg.appendChild(t);
        }
        white++;
      }
      const title = document.createElementNS(ns, "title");
      title.textContent = notes.name(m);
      r.appendChild(title);
      rects[m] = r;
    }
    blacks.forEach((r) => svg.appendChild(r)); // black keys drawn on top

    if (onTap) {
      svg.addEventListener("click", (e) => {
        const m = e.target.closest("rect")?.dataset.midi;
        if (m) onTap(+m);
      });
    }
    container.appendChild(svg);

    return {
      update(current) {
        const avg = averageCents();
        for (let m = LOWEST; m <= HIGHEST; m++) {
          const c = judgedCents(m, avg);
          const cls = [notes.isSharp(m) ? "black" : "white"];
          if (c !== null) cls.push(rating(c));
          if (m === current) cls.push("current");
          rects[m].setAttribute("class", cls.join(" "));
          rects[m].firstChild.textContent = notes.name(m) + (c === null ? "" : ` · ${formatCents(c)}`);
        }
      },
      scrollTo(midi) {
        const scale = svg.getBoundingClientRect().width / (whiteCount * W);
        container.scrollLeft = xs[midi] * scale - container.clientWidth / 2;
      },
    };
  }

  const tuningKb = buildKeyboard($("tuning-kb-scroll"), { compact: false, onTap: (m) => jumpTo(m) });
  const resultsKb = buildKeyboard($("results-kb-scroll"), {
    compact: true,
    onTap: (m) => { jumpTo(m); openTuning(); },
  });

  // ---------- Tuning flow ----------

  // Listening state machine:
  //   waiting   - armed, waiting for a fresh key strike
  //   attack    - just struck, ignoring the first ATTACK_MS
  //   measuring - collecting pitch readings until they agree
  //   locked    - result shown, about to advance
  let phase = "waiting";
  let phaseStart = 0;
  let readings = [];
  let quietLevel = Infinity; // quietest level since arming; a strike must rise well above it
  let noiseFloor = 0.002;
  let liveCents = null;
  let lastFrame = 0;
  let loopId = 0;
  let advanceTimer = null;

  function currentMidi() {
    return session.queue[session.index];
  }

  function arm() {
    clearTimeout(advanceTimer);
    phase = "waiting";
    readings = [];
    liveCents = null;
    quietLevel = Infinity;
    render();
  }

  function goTo(index) {
    session.index = Math.max(0, Math.min(session.queue.length, index));
    save();
    if (session.index >= session.queue.length) {
      openResults();
      return;
    }
    arm();
    tuningKb.scrollTo(currentMidi());
  }

  function jumpTo(midi) {
    let i = session.queue.indexOf(midi);
    if (i === -1) {
      // Key wasn't in this run (e.g. quick check); check it next.
      session.queue.splice(session.index, 0, midi);
      i = session.index;
    }
    goTo(i);
  }

  function nextUnchecked(from) {
    for (let i = from; i < session.queue.length; i++) {
      if (!session.freqs[session.queue[i]]) return i;
    }
    return session.queue.length;
  }

  function lock(cents) {
    const midi = currentMidi();
    session.freqs[midi] = targetFreq(midi, session.settings) * Math.pow(2, cents / 1200);
    save();
    phase = "locked";
    liveCents = cents;
    render();
    advanceTimer = setTimeout(() => goTo(session.index + 1), LOCKED_PAUSE_MS);
  }

  function step(now) {
    if (now - lastFrame < FRAME_MS) return;
    lastFrame = now;

    const { samples, rms } = mic.read();
    const midi = currentMidi();
    if (midi === undefined) return;

    if (phase === "waiting") {
      if (rms < noiseFloor * 4) noiseFloor = noiseFloor * 0.97 + rms * 0.03; // follow room noise
      quietLevel = Math.min(quietLevel, rms);
      const gate = Math.max(0.002, noiseFloor * 3);
      if (rms > gate && rms > quietLevel * 2.5) {
        phase = "attack";
        phaseStart = now;
        readings = [];
        render();
      }
      return;
    }

    if (phase === "attack") {
      if (now - phaseStart >= ATTACK_MS) {
        phase = "measuring";
        phaseStart = now;
      }
      return;
    }

    if (phase !== "measuring") return;

    const target = targetFreq(midi, session.settings);
    const span = Math.pow(2, SEARCH_CENTS / 1200);
    const period = mic.sampleRate / target; // in samples
    const pitch = detectPitch(samples, mic.sampleRate, {
      minFreq: target / span,
      maxFreq: target * span,
      threshold: midi < 40 ? 0.45 : 0.3, // bass strings are less cleanly periodic
      periods: Math.min(16, Math.max(1, Math.round(64 / period))), // finer resolution for treble
      decimate: target < 130 ? 4 : target < 260 ? 2 : 1, // cheaper for bass
    });

    if (pitch) {
      // Pin down the fundamental's exact frequency. In the deep bass the
      // fundamental is too weak, so measure the 2nd–4th partial instead (as
      // tuners do); failing that, use the overall pitch.
      let freq = pitch.freq;
      for (let n = 1; n <= 4; n++) {
        const partial = refineFrequency(samples, mic.sampleRate, pitch.freq * n);
        if (partial) {
          freq = partial / n;
          break;
        }
      }
      const c = notes.cents(freq, target);
      readings.push(c);
      liveCents = liveCents === null ? c : liveCents * 0.6 + c * 0.4;
      render();

      const recent = readings.slice(-STABLE_COUNT);
      if (recent.length === STABLE_COUNT && Math.max(...recent) - Math.min(...recent) <= STABLE_SPREAD) {
        lock(median(recent));
        return;
      }
    }

    const faded = rms < Math.max(0.002, noiseFloor * 3) * 0.8;
    if (faded || now - phaseStart > MAX_LISTEN_MS) {
      if (readings.length >= 3) {
        lock(median(readings));
      } else {
        phase = "waiting";
        quietLevel = rms;
        liveCents = null;
        render("Couldn't get a clear reading. Play it again a little firmer. If it keeps failing, this key may be very far out: skip it.");
      }
    }
  }

  function startLoop() {
    if (!mic) return;
    const id = ++loopId;
    lastFrame = 0;
    const tick = (now) => {
      if (!running || id !== loopId) return;
      requestAnimationFrame(tick);
      step(now);
    };
    requestAnimationFrame(tick);
  }

  function render(message) {
    const midi = currentMidi();
    if (midi === undefined) return;
    const done = Object.keys(session.freqs).filter((m) => session.queue.includes(+m)).length;

    $("progress-text").textContent = `Key ${session.index + 1} of ${session.queue.length}`;
    $("target-text").textContent = `${done} checked · target ${targetFreq(midi, session.settings).toFixed(1)} Hz`;
    $("progress-fill").style.width = `${(done / session.queue.length) * 100}%`;
    $("note-name").textContent = notes.name(midi);
    $("note-hint").textContent = hint(midi);

    const saved = centsOf(midi);
    const shown = liveCents !== null ? liveCents : phase === "waiting" ? saved : null;
    gauge.set(shown);

    const reading = $("reading");
    reading.className = "reading" + (shown !== null ? " " + rating(shown) : "");
    reading.textContent = shown !== null ? formatCents(shown) : "";

    const status = {
      waiting: saved !== null ? `Already checked. Play ${notes.name(midi)} to check it again, or skip.` : `Play ${notes.name(midi)}`,
      attack: "Listening…",
      measuring: "Listening… hold the key down",
      locked: "Got it ✓",
    }[phase];
    $("status").textContent = message || status;
    $("prev-btn").disabled = session.index === 0;

    tuningKb.update(midi);
  }

  // ---------- Results ----------

  function openResults() {
    clearTimeout(advanceTimer);
    show("results");
    renderResults();
  }

  function renderResults() {
    const measured = Object.keys(session.freqs).map(Number).sort((a, b) => a - b);
    const avg = averageCents();
    resultsKb.update(null);

    $("judge-ref").setAttribute("aria-pressed", judge === "ref");
    $("judge-neighbours").setAttribute("aria-pressed", judge === "neighbours");

    if (!measured.length) {
      $("results-summary").textContent = "No keys checked yet.";
      $("stats").innerHTML = "";
      $("worst").innerHTML = "";
      $("recheck-btn").disabled = true;
      return;
    }

    const judged = measured.map((m) => ({ midi: m, cents: judgedCents(m, avg) }));
    const counts = { good: 0, ok: 0, bad: 0 };
    judged.forEach((k) => counts[rating(k.cents)]++);
    const spread = Math.sqrt(judged.reduce((s, k) => s + Math.pow(centsOf(k.midi) - avg, 2), 0) / judged.length);

    const pitchWord = Math.abs(avg) < 3 ? "right on pitch" : `${Math.round(Math.abs(avg))} cents ${avg < 0 ? "flat" : "sharp"} overall`;
    $("results-summary").textContent =
      `${measured.length} key${measured.length === 1 ? "" : "s"} checked. The piano is ${pitchWord}` +
      (judge === "neighbours"
        ? ". Colours show keys that stand out from the keys around them, which is what makes a piano sound out of tune."
        : ". Colours show each key against the reference pitch. Readings in the lowest and highest octaves are approximate.");

    const stat = (value, label) => `<div class="stat"><div class="value">${value}</div><div class="label">${label}</div></div>`;
    $("stats").innerHTML =
      stat(`${avg > 0 ? "+" : avg < 0 ? "−" : ""}${Math.abs(avg).toFixed(1)}¢`, "Average offset (overall pitch)") +
      stat(`${spread.toFixed(1)}¢`, "Spread between keys (lower is more even)") +
      stat(`<span style="color:var(--good)">${counts.good}</span>`, "Within 5 cents") +
      stat(`<span style="color:var(--warn)">${counts.ok}</span> / <span style="color:var(--bad)">${counts.bad}</span>`, "5–15 / over 15 cents off");

    const worst = [...judged].sort((a, b) => Math.abs(b.cents) - Math.abs(a.cents)).slice(0, 10);
    $("worst").innerHTML = worst
      .map((k) => `<tr><td>${notes.name(k.midi)} <span class="muted small">key ${keyNumber(k.midi)}</span></td>` +
        `<td style="color:var(--${{ good: "good", ok: "warn", bad: "bad" }[rating(k.cents)]})">${formatCents(k.cents)}</td></tr>`)
      .join("");

    $("recheck-btn").disabled = counts.ok + counts.bad === 0;
  }

  // ---------- Setup and buttons ----------

  function readSettings() {
    const a4 = parseFloat($("a4").value);
    return {
      mode: $("mode").value,
      order: $("order").value,
      a4: a4 >= 400 && a4 <= 480 ? a4 : 440,
      stretch: $("stretch").checked,
    };
  }

  async function ensureMic() {
    if (mic) return true;
    $("error").hidden = true;
    try {
      mic = new Mic({ fftSize: 8192 }); // ~170 ms of audio: enough for the lowest A
      await mic.start();
      return true;
    } catch (err) {
      mic = null;
      $("error").textContent =
        err && err.name === "NotAllowedError"
          ? "Microphone access was blocked. On iPhone: Settings → Safari → Microphone → Allow, then reload."
          : (err && err.message) || "Couldn't start the microphone.";
      $("error").hidden = false;
      show("setup");
      return false;
    }
  }

  async function openTuning() {
    if (!(await ensureMic())) return;
    show("tuning");
    if (session.index >= session.queue.length) session.index = nextUnchecked(0);
    if (session.index >= session.queue.length) session.index = 0;
    arm();
    requestAnimationFrame(() => tuningKb.scrollTo(currentMidi()));
  }

  function showSetup() {
    const s = session && session.settings;
    if (s) {
      $("mode").value = s.mode;
      $("order").value = s.order;
      $("a4").value = s.a4;
      $("stretch").checked = s.stretch;
    }
    const checked = session ? Object.keys(session.freqs).length : 0;
    $("resume-card").hidden = !checked;
    if (checked) $("resume-detail").textContent = `(${checked} of ${session.queue.length} keys checked)`;
    show("setup");
  }

  $("start-btn").addEventListener("click", () => {
    const settings = readSettings();
    session = { settings, queue: buildQueue(settings.mode, settings.order), index: 0, freqs: {} };
    save();
    openTuning();
  });
  $("resume-btn").addEventListener("click", () => {
    session.index = nextUnchecked(0);
    openTuning();
  });
  $("results-btn").addEventListener("click", openResults);
  $("discard-btn").addEventListener("click", () => {
    store.remove(STORAGE_KEY);
    session = null;
    showSetup();
  });

  $("prev-btn").addEventListener("click", () => goTo(session.index - 1));
  $("redo-btn").addEventListener("click", () => {
    delete session.freqs[currentMidi()];
    save();
    arm();
  });
  $("skip-btn").addEventListener("click", () => goTo(session.index + 1));
  $("finish-btn").addEventListener("click", openResults);

  $("judge-ref").addEventListener("click", () => { judge = "ref"; renderResults(); });
  $("judge-neighbours").addEventListener("click", () => { judge = "neighbours"; renderResults(); });
  $("recheck-btn").addEventListener("click", () => {
    const avg = averageCents();
    session.queue = Object.keys(session.freqs).map(Number)
      .filter((m) => rating(judgedCents(m, avg)) !== "good")
      .sort((a, b) => a - b);
    session.index = 0;
    save();
    openTuning();
  });
  $("continue-btn").addEventListener("click", openTuning);
  $("restart-btn").addEventListener("click", () => {
    store.remove(STORAGE_KEY);
    session = null;
    showSetup();
  });

  showSetup();
})();
