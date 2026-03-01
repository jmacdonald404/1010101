# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Running the Project

No build process. Serve files over HTTP (required for ES modules and AudioWorklet):

```bash
python3 -m http.server 8080
# or
npx serve .
```

Open `http://localhost:8080` in Chrome/Firefox/Safari. Click **"Start Audio"** to initialize the AudioContext (browser requires a user gesture).

## Architecture

**SH-101 signal flow:** `index.html` (UI + glue) → `sh101-node.js` (SH101 class) → `worklet/sh101-processor.js` (AudioWorkletProcessor, all DSP)

**PCM 41 signal flow:** `index.html` (FX routing + UI) → `pcm41.js` (PCM41 class, M1 + M5 expander) → `worklet/pcm41-processor.js` (M2–M5 feedback path, AudioWorkletProcessor)

### Communication between threads

- **AudioParams** (a-rate or k-rate): `frequency`, `gate`, `cutoff`, `resonance`, `pulseWidth`, `velocity`, all ADSR params, LFO params, oscillator mix levels (`sawLevel`, `pulseLevel`, `subLevel`, `noiseLevel`), `volume`, `octaveShift`, `fineTune`
- **`port.postMessage`** (main → worklet): `lfoWaveform`, `glideTime`, `noteTarget`, `reset`, `moduleToggle`

### DSP chain (per sample, in `sh101-processor.js`)

1. **Portamento** — logarithmic frequency glide + analog drift
2. **Transpose** — `transposeRatio = 2^(octaveShift + fineTune/1200)` applied to portamento output (k-rate, computed once per block)
3. **LFO** — triangle/square/saw/S&H; modulates pitch, PWM, cutoff
4. **VCO** — PolyBLEP sawtooth + pulse (anti-aliased), square sub-octave divider, white noise; mixer normalized by total level sum
5. **ADSR** — exponential-coefficient envelope; used for VCA and VCF env-mod
6. **VCF** — Huovilainen 4-pole ladder filter, **2× oversampled** (OSR = 88200 Hz); decimated via 15-tap half-band FIR. `THERMAL = 0.5`, `f = 2*tan(π*fc/OSR)`, noise dither `1e-6`
7. **VCA** — `envOut * volume * velocity`

### VCO oscillator mix

Saw, Pulse, Sub, and Noise each have independent 0–1 level AudioParams (`sawLevel`, `pulseLevel`, `subLevel`, `noiseLevel`). All four can be mixed simultaneously. The Sub Oct buttons (Off / −1 Oct / −2 Oct) gate `subLevel`: Off forces it to 0; the active octave mode restores it from the Sub level slider.

### Slider UX

All `.vs` sliders support:
- **Mouse wheel** on hover — 1 step per tick, prevents page scroll
- **Double-click** — resets to midpoint of the slider's range (`(min + max) / 2`)

### AudioWorklet cache busting

`sh101-node.js` appends `?v=<Date.now()>` to the `addModule()` URL. This is intentional — browsers aggressively cache worklet modules and will silently run stale code otherwise. Do not remove.

### Parameter tapers in `sh101-node.js`

| Method | Formula |
|---|---|
| `setCutoff(v)` | `20 * 900^v` Hz |
| `setResonance(v)` | `v * 0.95` (max resonance = 0.95, just below self-oscillation at k=4) |
| `setAttack/Decay/Release(v)` | `0.001 * 2000^v` seconds |
| `setGlideSlider(v)` | `0.01 * 150^v` seconds; `0` when `v < 0.01` |

### MIDI device filtering

MIDI inputs whose names start with `'M'` are intentionally excluded. This is deliberate — do not remove.

### MIDI CC mappings

| CC | Parameter |
|---|---|
| 74 | Cutoff |
| 71 | Resonance |
| 73 | Attack |
| 75 | Decay |
| 7  | Volume |
| 5  | Glide |

### Module bypass system

Each DSP section (VCO, VCF, VCA, ENV, LFO) can be bypassed independently via toggle switches in the UI, sending `{ type: 'moduleToggle', module: 'vcf', enabled: false }` through the port. Useful for debugging.

### Arpeggiator (`arp.js`)

Uses Chris Wilson's Web Audio lookahead scheduling technique (`_lookahead = 25ms`, `_interval = 10ms`). Patterns: `up`, `down`, `updown`, `random`. Divisions: 8, 16, 32. Supports 1–2 octave range. The arpeggiator bypasses `SH101.noteOn/noteOff` and drives `synth.node.parameters` directly for sample-accurate timing.

---

## PCM 41 FX Rack

### File roles

| File | Responsibility |
|---|---|
| `pcm41.js` | `PCM41` class — M1 front-end nodes, M5 expander WaveShaperNode, `init()`, public `set()` / `setLFOShape()` / `setPhaseInvert()` / `setInfiniteRepeat()` |
| `worklet/pcm41-processor.js` | `PCM41Processor` — M2 ADC, M3 delay engine, M4 LFO, M5 feedback path (LPF + phase invert + infinite hold) |

### PCM 41 signal chain (per sample)

1. **M5 feedback LPF** — one-pole at 12 kHz on `_prevOut`; optional `× −1` phase invert
2. **M2 — 12-bit quantise** — `floor(mixIn × 2048)`, clip ±2048; skipped in infinite-hold mode
3. **M3 — circular buffer write** — 65536-sample (2^16) ring buffer, bitwise-AND wrap; skipped in infinite-hold mode; `writePtr` always advances
4. **M4 — LFO offset** — sine or slewed-square (40 Hz one-pole slew) shifts `readPtr` by up to `min(lfoDepth, delayTime × 0.9) × sampleRate` samples
5. **M3 — linear-interpolated read** — fractional `readPtr`, two-tap interpolation, bitwise-AND wrap
6. **M3 — clock-aliasing LPF** — one-pole, `fc = readSpeed × 8 kHz`
7. **M5 expander** (main thread WaveShaperNode, post-worklet) — 1:2 expansion above −18 dBFS, clamped ±1, 2× oversample

### PCM 41 AudioWorklet parameters (all k-rate)

| Parameter | Range | Default | UI taper |
|---|---|---|---|
| `delayTime` | 0.002–1.4 s | 0.375 s | `0.002 × 600^(v/100)` |
| `readSpeed` | 0.25–4.0 | 1.0 | linear |
| `feedback` | 0–0.97 | 0.35 | linear (slider 0–97) |
| `lfoRate` | 0.05–10 Hz | 0.5 Hz | `0.05 × 200^(v/100)` |
| `lfoDepth` | 0–0.030 s | 0 | linear (slider 0–100 → ×0.030) |

### PCM 41 port messages (main → worklet)

| Message | Effect |
|---|---|
| `{ type:'lfoShape', value:'sine'\|'square' }` | Switch LFO waveform |
| `{ type:'phaseInvert', value: bool }` | Multiply feedback by −1 |
| `{ type:'infiniteRepeat', value: bool }` | Freeze buffer writes; loop existing content |

### PCM 41 audio routing (`index.html`)

```
synth.output → fxBus ─┬─ pcm41Dry (gain 1) ──────────────────→ masterOut → destination
                       └─ pcm41.input → pcm41.output → pcm41Wet (gain 0→0.45) ─┘
```

`pcm41Wet.gain` is ramped with `setTargetAtTime(τ=0.02 s)` on toggle. PCM 41 is off by default.

### PCM 41 FX unit controls

| Control | ID | Notes |
|---|---|---|
| On/Off | `pcm41-pwr` | Ramps `pcm41Wet` gain |
| Delay | `pcm41-delay` | Log taper, displays ms / s |
| Repeat | `pcm41-repeat` | Linear, 0–97% |
| LFO Rate | `pcm41-lfo-rate` | Log taper |
| LFO Depth | `pcm41-lfo-depth` | Linear, 0–30ms |
| Sine/Square | `pcm41-lfo-shape` | tsw toggle; off=sine, on=square |
| ɸ Inv | `pcm41-phase` | tsw toggle |
| Hold | `pcm41-hold` | tsw toggle; freezes buffer |
