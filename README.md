# Instrument Tuner

A browser-based instrument tuner that runs on iPhone, iPad, Android and desktop. Everything happens on your device: audio is analysed in the browser and never uploaded.

There's no build step, framework or dependencies: just HTML, CSS and plain JavaScript.

## Instruments

| Instrument | Status |
|---|---|
| [Piano](piano/) | Working |
| [Guitar](guitar/) | Working |

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

### Guitar

A live tuner: pluck a string and turn the peg until the needle is in the green (within 3 cents; amber up to 10).

- **Auto-detect** works out which string you're playing and tells you whether to tighten or loosen it. If a string is so far out that it's picked up as its neighbour, tap the string you're tuning to lock onto it. Tap it again, or **Auto-detect**, to go back.
- A ✓ appears on each string once it has held in tune for a moment.
- **Tunings:** Standard, Drop D, half step down, whole step down, Drop C, DADGAD, Open G, Open D and Open E.
- **Reference pitch:** defaults to A4 = 440 Hz. The tuning and reference pitch are remembered.

## Running it

Browsers only allow microphone access on secure pages: `https://`, or `http://localhost` on the same machine. Opening `index.html` straight from Finder (`file://`) won't work, and nor will `http://<your-mac's-IP>` from another device.

### On a Mac

1. Open **Terminal** and go to the project folder:

   ```sh
   cd ~/git/corbishley/instrument_tuner
   ```

2. Start a local web server. Python 3 comes with macOS's command line tools; if `python3` asks you to install them, accept.

   ```sh
   python3 -m http.server 8000
   ```

3. Open **http://localhost:8000** in Safari, Chrome or Firefox and choose **Piano** or **Guitar**.
4. Press **Start** and allow the microphone when the browser asks.
   - If you clicked "Don't Allow": in Safari go to **Safari → Settings → Websites → Microphone** and set `localhost` to **Allow**. In Chrome, click the icon to the left of the address bar.
   - If there's still no sound: check **System Settings → Privacy & Security → Microphone** and make sure your browser is switched on.
5. Press **Ctrl+C** in Terminal to stop the server when you're done.

A MacBook's built-in mic works fine. Put the laptop on or near the piano, not across the room.

### On an iPhone

The iPhone needs the page served over `https://`, so it has to be hosted somewhere. GitHub Pages is the simplest option:

1. **Turn on GitHub Pages** (one-off):
   - On github.com, open the repo → **Settings → Pages**.
   - Under **Build and deployment**, set **Source** to **Deploy from a branch**, branch **`main`**, folder **`/ (root)`**, then **Save**.
   - After a minute or two the page shows the address: `https://corbishley.github.io/instrument_tuner/`.
   - This repo is currently **private**. GitHub Pages for private repos needs a paid plan (GitHub Pro or higher), and even then the published site is public. On a free account, make the repo public first (**Settings → General → Danger Zone → Change visibility**). The site contains no personal data, and results are only stored on your phone.
2. **Open it on the iPhone** in **Safari** and go to `https://corbishley.github.io/instrument_tuner/`.
3. **Add it to the Home Screen** (optional, recommended): tap **Share → Add to Home Screen → Add**. It then opens full-screen like an app, with its own icon.
4. **Allow the microphone**: choose **Piano** or **Guitar**, press **Start** and tap **Allow** when asked.
   - If you tapped "Don't Allow": tap **aA** in the Safari address bar → **Website Settings → Microphone → Allow**. Or go to **Settings → Apps → Safari → Microphone** and set it to **Ask** or **Allow**.
5. **Updates**: after you push changes to `main`, GitHub Pages republishes within a few minutes. If the phone still shows the old version, pull down to reload, or close and reopen the Home Screen app.

The screen stays awake while the tuner is listening. Turn off Low Power Mode if it dims anyway.

### Tips for good readings

- Use a quiet room: no TV, fridge hum or people talking.
- Put the phone on the music stand, or the laptop on the piano lid, with the mic facing the strings.
- Play each key firmly (mezzo-forte or louder) and hold it down until the tuner moves on.
- Progress saves automatically in that browser. The Mac and the iPhone keep separate progress.

## How it works

- `shared/tuner.js` is the instrument-independent engine:
  - **Mic** opens the microphone with echo cancellation, noise suppression and auto-gain turned off (on iOS these distort musical notes). It also keeps the screen awake.
  - **detectPitch** is a normalised difference function (the core of the YIN / McLeod methods). Given the expected note, it only searches ±70 cents around it. That avoids octave errors on bass notes whose fundamental is weak, and stops a still-ringing neighbouring key being picked up. Treble notes are measured across several cycles for finer resolution, and bass notes are downsampled first to save CPU.
  - **Gauge** draws the SVG needle display.
- `guitar/` matches each reading to the nearest string of the chosen tuning (or only listens for the string you picked). It only switches strings after a few frames agree, so a stray reading doesn't make the display jump.
- `piano/` handles the piano flow: which key comes next, the listening state machine (wait for a fresh strike → skip the hammer noise → collect readings until 6 agree within 4 cents → record the median), the keyboard drawing and the results.

### Accuracy

On synthetic test tones the detector is within about 1.5 cents from A0 to C8. Real piano strings are *inharmonic* (their overtones run sharp), so the pitch you hear, and what this measures, sits a little above the string's true fundamental. The effect is largest in the lowest and highest octave and a half. As a result:

- Comparisons between neighbouring keys are reliable everywhere. That's why it's the default view.
- Absolute readings against the reference pitch are approximate at the extremes. The stretch curve is a generic average, not calibrated to your piano.
- A key with 2–3 strings that disagree with each other (a "wobbly" sound) reads as their average. This tuner doesn't detect that.

## Adding an instrument

1. Create a folder, e.g. `violin/`, with an `index.html` that loads `../shared/style.css` and `../shared/tuner.js`.
2. Use `Tuner.Mic`, `Tuner.detectPitch` (pass a `minFreq`/`maxFreq` around the string you're expecting) and `Tuner.Gauge`.
3. Add a card for it in the root `index.html`.

## Licence

[MIT](LICENSE)
