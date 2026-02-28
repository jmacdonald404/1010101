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

**Signal flow:** `index.html` (UI + glue) → `sh101-node.js` (SH101 class) → `worklet/sh101-processor.js` (AudioWorkletProcessor, all DSP)

### Communication between threads

- **AudioParams** (a-rate or k-rate): `frequency`, `gate`, `cutoff`, `resonance`, `pulseWidth`, `velocity`, all ADSR params, LFO params, oscillator mix levels, `volume`
- **`port.postMessage`** (main → worklet): `lfoWaveform`, `glideTime`, `noteTarget`, `reset`, `moduleToggle`

### DSP chain (per sample, in `sh101-processor.js`)

1. **Portamento** — logarithmic frequency glide + analog drift
2. **LFO** — triangle/square/saw/S&H; modulates pitch, PWM, cutoff
3. **VCO** — PolyBLEP sawtooth + pulse (anti-aliased), square sub-octave divider, white noise; mixer normalized by total level sum
4. **ADSR** — exponential-coefficient envelope; used for VCA and VCF env-mod
5. **VCF** — Huovilainen 4-pole ladder filter, **2× oversampled** (OSR = 88200 Hz); decimated via 15-tap half-band FIR. `THERMAL = 0.5`, `f = 2*tan(π*fc/OSR)`, noise dither `1e-6`
6. **VCA** — `envOut * volume * velocity`

### Parameter tapers in `sh101-node.js`

| Method | Formula |
|---|---|
| `setCutoff(v)` | `20 * 900^v` Hz |
| `setResonance(v)` | `v * 0.95` (max resonance = 0.95, just below self-oscillation at k=4) |
| `setAttack/Decay/Release(v)` | `0.001 * 2000^v` seconds |
| `setGlideSlider(v)` | `0.01 * 150^v` seconds; `0` when `v < 0.01` |

### MIDI device filtering

MIDI inputs whose names start with `'M'` are intentionally excluded (lines 707, 760, 763 in `index.html`). This is deliberate — do not remove.

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
