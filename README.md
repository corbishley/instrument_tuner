# Instrument Tuner

A browser-based instrument tuner that runs on iPhone, iPad, Android and desktop. Everything happens on your device: audio is analysed in the browser and never uploaded.

There's no build step, framework or dependencies: just HTML, CSS and plain JavaScript.

## Instruments

| Instrument | Status |
|---|---|
| [Piano](piano/) | Working |
| Guitar | Planned |

### Piano

Walks you through the keyboard one key at a time:

1. The key to play is highlighted on an 88-key keyboard, e.g. **A4**: *the A above middle C · key 49 from the left*.
2. Play it and hold it down. A needle shows how far it is off in cents (1/100 of a semitone): green within 5 cents, amber 5–15, red beyond.
3. Once the readings settle, it records the result and moves to the next key.
4. At the end you get a heat map of the keyboard, the piano's overall pitch, how even it is, and the keys furthest out.

Options:

- **All 88 keys** (about 10 minutes) or a **quick check** of every A and E (15 keys).
- **Order:** start at A4 and work outwards (how tuners do it), or go from lowest to highest.
- **Reference pitch:** defaults to A4 = 440 Hz.
- **Stretch tuning allowance:** pianos are deliberately tuned slightly flat in the bass and sharp in the treble, so the reference targets follow an average stretch curve.
- **Judge results against neighbouring keys** (default) or the reference pitch. "Neighbouring keys" highlights keys that stand out from the keys around them, which is what makes a piano sound out of tune, whatever its overall pitch and stretch.

Progress is saved in the browser, so you can stop and continue later. Back, Redo and Skip are always available, and tapping any key jumps to it.

## Running it

The microphone only works on secure pages: `https://`, or `http://localhost` on the same machine.

**On your computer:**

```sh
python3 -m http.server 8000
# then open http://localhost:8000
```

**On an iPhone:** host it over https. The easiest way is GitHub Pages: repo **Settings → Pages → Deploy from a branch → `main` / root**. It will then be at `https://corbishley.github.io/instrument_tuner/`.

Open it in Safari, then **Share → Add to Home Screen** to get a full-screen app icon. Allow the microphone when asked. If you denied it earlier, go to **Settings → Apps → Safari → Microphone**.

Tips: use a quiet room, put the phone on the music stand, and play each key firmly and hold it.

## How it works

- `shared/tuner.js` is the instrument-independent engine:
  - **Mic** opens the microphone with echo cancellation, noise suppression and auto-gain turned off (on iOS these distort musical notes). It also keeps the screen awake.
  - **detectPitch** is a normalised difference function (the core of the YIN / McLeod methods). Given the expected note, it only searches ±70 cents around it. That avoids octave errors on bass notes whose fundamental is weak, and stops a still-ringing neighbouring key being picked up. Treble notes are measured across several cycles for finer resolution, and bass notes are downsampled first to save CPU.
  - **Gauge** draws the SVG needle display.
- `piano/` handles the piano flow: which key comes next, the listening state machine (wait for a fresh strike → skip the hammer noise → collect readings until 6 agree within 4 cents → record the median), the keyboard drawing and the results.

### Accuracy

On synthetic test tones the detector is within about 1.5 cents from A0 to C8. Real piano strings are *inharmonic* (their overtones run sharp), so the pitch you hear, and what this measures, sits a little above the string's true fundamental. The effect is largest in the lowest and highest octave and a half. As a result:

- Comparisons between neighbouring keys are reliable everywhere. That's why it's the default view.
- Absolute readings against the reference pitch are approximate at the extremes. The stretch curve is a generic average, not calibrated to your piano.
- A key with 2–3 strings that disagree with each other (a "wobbly" sound) reads as their average. This tuner doesn't detect that.

## Adding an instrument

1. Create a folder, e.g. `guitar/`, with an `index.html` that loads `../shared/style.css` and `../shared/tuner.js`.
2. Use `Tuner.Mic`, `Tuner.detectPitch` (pass a `minFreq`/`maxFreq` around the string you're expecting) and `Tuner.Gauge`.
3. Add a card for it in the root `index.html`.

## Licence

[MIT](LICENSE)
