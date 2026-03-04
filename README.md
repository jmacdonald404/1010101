# SH-101 Web Synthesizer + FX Rack

A web-based clone of the classic Roland SH-101 analog synthesizer with a Lexicon PCM 41 digital delay and Alesis Quadraverb reverb/resonator emulation in an FX rack, implemented using modern HTML5, CSS3, JavaScript, and the Web Audio API.

## Project Overview

This project recreates the iconic Roland SH-101 monophonic synthesizer entirely in the browser, featuring:

- **Authentic visual design** with detailed CSS styling mimicking the original hardware
- **Full synthesizer engine** running in an AudioWorklet for real-time audio processing
- **External MIDI support** with automatic device detection and filtering
- **Built-in arpeggiator** with multiple patterns and timing divisions
- **Computer keyboard support** for musical input
- **PCM 41 FX rack** — five-module Lexicon PCM 41 digital delay emulation
- **Quadraverb FX rack** — Alesis Quadraverb reverb/resonator emulation with analog input stage
- **Output limiter** — brickwall DynamicsCompressor at −1 dBFS, active by default
- **dB signal scope** — real-time peak meter with color-coded bar and readout in the brand bar

## Architecture

### File Structure
```
├── index.html                    # Main application with UI and control logic
├── sh101-node.js                 # Main thread synthesizer wrapper class
├── arp.js                        # Arpeggiator implementation with Web Audio scheduling
├── pcm41.js                      # Main thread PCM 41 wrapper (M1 front-end + M5 expander)
├── quadraverb.js                 # Main thread Quadraverb wrapper (input stage + set/setDrive)
├── presets/
│   └── factory.json              # Factory patch bank — edit to add/replace factory presets
└── worklet/
    ├── sh101-processor.js        # AudioWorklet processor (core synthesis engine)
    ├── pcm41-processor.js        # AudioWorklet processor (PCM 41 delay engine, M2–M5)
    └── quadraverb-processor.js   # AudioWorklet processor (Quadraverb — all DSP phases 1–4)
```

### Signal Chain
```
synth.output
  → fxBus ─┬─ pcm41Dry (gain 1) ─────────────────────────────────────────→ masterOut
            ├─ pcm41.input  → pcm41.output  → pcm41Wet  (default 0) ──────→ masterOut
            └─ qrv.input    → qrv.output    → qrvWet    (default 0) ──────→ masterOut

masterOut → limiterNode (DynamicsCompressor) → _meterAn (AnalyserNode) → destination
```

### Technical Implementation

**Audio Engine (worklet/sh101-processor.js)**
- **PolyBLEP oscillators** — alias-free sawtooth and pulse; sub-oscillator via phase-locked dividers (`subPhase1` at dt×0.5, `subPhase2` at dt×0.25) with three modes (sq −1oct, sq −2oct, 25%pw −2oct)
- **Huovilainen ladder filter** — 24 dB/oct, 2× oversampled, trapezoidal predictor-corrector; cutoff 10 Hz–20 kHz; resonance 0 to self-oscillation (k=4)
- **ADSR envelope** — one-pole exponential coefficients; computed before VCO so envOut is available for P.Mode:Env and VCF env-mod
- **Three envelope trigger modes** — Gate (standard), Gate+Trig (restart on every noteOn), LFO (phase-locked to LFO cycle)
- **VCA modes** — ENV (ADSR controls amplitude) and GATE (slewed keyboard gate — 2 ms one-pole ramp eliminates click; ADSR still runs for VCF/PWM modulation)
- **LFO** — sine, triangle, square, sawtooth, sample & hold; routes to pitch (0–+1 oct), pulse width, and filter cutoff (±10 kHz)
- **Portamento/glide** — three modes: On (always), Off, Auto (legato only); logarithmic frequency slew
- **Analog drift simulation** — mimics CEM3340 VCO temperature coefficient behaviour
- **Half-band decimation** — 15-tap FIR for downsampling from 2× oversampled filter

**VCF modulation chain (per sample)**
```
cutoffBase (slider)
  + envOut × envMod × (20000 − cutoffBase)          ← env mod sweeps to 20 kHz ceiling
  + lfoOut × lfoCutoff × 10000                       ← LFO mod ±10 kHz fixed range
  + cutoffBase × ((freq/440)^keyTrack − 1)           ← key tracking: exponential, 1 oct/oct at 100%
  → clamp [10, 20000] → LadderFilter
```

**User Interface (index.html)**
- Pixel-perfect recreation of SH-101 panel layout using CSS Grid and Flexbox
- Custom-styled vertical range sliders with cream-coloured caps
- Slider scale marks — 11 evenly-spaced dashes (0/5/10 labelled) on all standard sliders
- 32-key virtual keyboard (C2–G4); computer keyboard input supported
- Brand bar: dB peak scope + output limiter toggle

**Portamento strip (row 3, left)**
- Volume level + Porta Time sliders
- Porta Mode (xs switch): Auto (legato only) / Off / On

**Output Stage (index.html)**
- `DynamicsCompressorNode` limiter (threshold −1 dBFS, ratio 20:1, knee 0, attack 1 ms, release 50 ms); active by default
- Limiter bypass: sets threshold→0, ratio→1 in-place (no graph reconnect, glitch-free)
- `AnalyserNode` (fftSize 1024) post-limiter feeds `requestAnimationFrame` peak meter
- Meter: −60→0 dBFS mapped to 0→100% bar; green ≤ −18, orange −18 to −6, red above −6

**MIDI Integration**
- Automatic MIDI device discovery and connection
- Note on/off handling with velocity sensitivity
- MIDI CC mapping for real-time parameter control (cutoff, resonance, envelope, etc.)
- **Device filtering**: excludes MIDI devices whose names start with 'M'

**Arpeggiator (arp.js)**
- Web Audio scheduled timing for sample-accurate sequencing
- Patterns: Up, Down, Up/Down; rate synced to LFO rate slider (BPM = lfoHz × 60)
- Note divisions: 8th, 16th, 32nd notes; 1–2 octave range

**Patch Bank (index.html)**
- Captures all synth settings (not FX rack) as a named patch — stored in `localStorage`
- Save / Load / Export / Import buttons with a dropdown selector
- Dropdown sections: Factory (loaded from `presets/factory.json` at boot) and Custom (localStorage); imported banks appear as additional optgroups for the session
- Patch format: `sh101-patch-bank` v1 JSON — identical to the Export output, so exported files can be pasted directly into `presets/factory.json`

**PCM 41 FX rack (pcm41.js + worklet/pcm41-processor.js)**
- Five-module emulation of the Lexicon PCM 41 digital delay
- Signal chain: analog front-end → 12-bit ADC → variable-clock delay → LFO mod → feedback path → expander
- Wet/dry routing via GainNodes; on/off toggle with smooth gain ramp

**Quadraverb FX rack (quadraverb.js + worklet/quadraverb-processor.js)**
- Four-phase emulation of the Alesis Quadraverb digital reverb unit
- Phase 1 — digital bottleneck: 16-bit non-dithered quantiser + 4th-order Chebyshev Type I LPF at 17.5 kHz
- Phase 2 — resonator: 5-voice tuned IIR comb filter bank with master feedback gate
- Phase 3 — reverb texture: 4-stage Schroeder APF diffusion network + dual-path (short/long) IIR tail
- Phase 4 — analog input stage: hardware noise floor (−85 dBFS) + hard-clip WaveShaperNode with variable drive

## Current Status

### SH-101

| Module | Status | Notes |
|---|---|---|
| VCO | ✅ | PolyBLEP saw+pulse; 3-mode sub-osc; noise; independent level sliders |
| VCF | ✅ | Huovilainen ladder; 10Hz–20kHz; resonance 0→self-osc; exponential key tracking |
| VCA | ✅ | ENV (ADSR shapes amplitude) + GATE (key gate, ADSR still runs for VCF/PW) |
| ADSR | ✅ | Attack 1.5ms–4s; Decay/Release 2ms–10s; Sustain 0–100% |
| Envelope Trigger | ✅ | Gate / Gate+Trig / LFO modes |
| LFO | ✅ | Sine/Tri/Sqr/Saw/S&H; → pitch (0–+1oct), PWM, cutoff (±10kHz) |
| Portamento | ✅ | On/Off/Auto (legato) modes; logarithmic glide |
| Arpeggiator | ✅ | Up/Down/Up-Down; rate synced to LFO; 8th–32nd; 1–2 oct |
| Patch Bank | ✅ | Save/Load/Export/Import; Factory (presets/factory.json) + Custom (localStorage) |
| MIDI | ✅ | Note on/off, velocity, CC mapping |

### PCM 41

| Module | Status | Description |
|---|---|---|
| M1 — Analog Front-End | ✅ | tanh soft clipper (WaveShaper, 4× oversample) + 2:1 compressor (−18 dBFS) |
| M2 — 12-bit ADC | ✅ | `floor(x × 2048)`, clip to ±2048, re-quantise per feedback cycle |
| M3 — Variable-Clock Delay | ✅ | 65536-sample circular buffer, linear interpolation, clock-aliasing LPF |
| M4 — LFO Modulation | ✅ | Sine / slewed-square (40 Hz) modulates delay time; depth clamped to 90% |
| M5 — Feedback + Expander | ✅ | 12 kHz feedback LPF, phase invert, infinite hold, 1:2 expander WaveShaper |

### Quadraverb

| Phase | Status | Description |
|---|---|---|
| Ph1 — Digital Bottleneck | ✅ | 16-bit non-dithered quantiser + 4th-order Chebyshev Type I LPF @ 17.5 kHz |
| Ph2 — Resonator | ✅ | 5-voice IIR comb bank (linear interp), master feedback gate; hard-clips each voice to ±1 |
| Ph3 — Reverb Texture | ✅ | 4× Schroeder APF diffusion (primes 149/211/263/347); dual-path tail (M=1321/3527) with density crossfade |
| Ph4 — Analog Input Stage | ✅ | −85 dBFS hardware noise floor pre-quantiser; hard-clip WaveShaperNode (drive 0–+12 dB) |

### Output Stage

| Feature | Status | Description |
|---|---|---|
| Limiter | ✅ | Brickwall DynamicsCompressor at −1 dBFS; on by default; toggle bypasses in-place |
| dB Scope | ✅ | rAF peak meter (AnalyserNode, time domain); 72 px bar + numeric readout; three-zone colour coding |

### Notes
- Each SH-101 section has a panel toggle switch for independent bypass (useful for debugging)
- MIDI device filtering excludes devices whose names start with 'M'
- All DSP runs inside AudioWorklets; UI communicates via parameters and `port.postMessage`
- `addModule()` appends `?v=<timestamp>` to all worklet URLs to prevent browser caching

## Technical Specifications

- **Sample Rate**: 44.1 kHz with 2× oversampling in filter
- **Latency**: Interactive latency hint for minimal audio delay
- **Polyphony**: Monophonic (true to original SH-101)
- **Oscillator**: PolyBLEP anti-aliased waveforms
- **Filter**: 24 dB/oct Huovilainen ladder filter with analog modelling; cutoff 10 Hz–20 kHz
- **Modulation**: LFO → Pitch (0–+1 oct), Pulse Width, Filter Cutoff (±10 kHz)
- **MIDI**: Full MIDI input support with CC parameter mapping

## Changelog

### 2026-03-04
**Patch Bank**
- New component in Row 2 (next to Arpeggio), flowing horizontally
- Save: prompts for name, captures all synth settings (not FX rack), warns before overwrite, persists to `localStorage`
- Load: applies selected patch by dispatching `input` events on all sliders/buttons
- Export: downloads all custom patches as `sh101-patches-<timestamp>.json`
- Import: validates format, adds patches as a per-session optgroup labelled with the filename
- Factory presets: fetched from `presets/factory.json` at boot via top-level `await fetch()`; paste any exported file there to define factory patches
- Patch format: `{ format: "sh101-patch-bank", version: 1, patches: [{ name, created, settings }] }`

**VCA Gate — click fix**
- GATE mode VCA now uses a slewed gate signal (2 ms one-pole filter) rather than the raw step-function `gate` AudioParam, eliminating audible clicks on note on/off

---

### 2026-03-03
**VCO / Source Mixer**
- Noise slider moved from VCO to last position in Source Mixer
- VCO Mod slider changed to unipolar 0–100% (0 to +1 octave of LFO pitch depth)
- Fine Tune range narrowed to ±50 cents (was ±100)

**VCF — range and modulation corrections**
- Cutoff range: 10 Hz–20 kHz (was 20 Hz–18 kHz); taper `10 × 2000^v`
- Resonance: now reaches self-oscillation at full travel (k=4); cap removed
- Key tracking formula corrected from linear to exponential: `cutoffBase × ((freq/440)^keyTrack − 1)` — filter now tracks the keyboard in equal-tempered octaves at 100%
- LFO Mod formula corrected from `lfoOut × lfoCutoff × cutoffBase × 0.5` (cutoff-position-dependent) to `lfoOut × lfoCutoff × 10000` (fixed ±10 kHz)
- Env Mod ceiling updated from 18000 to 20000 to match new cutoff range
- LFO Mod and Key Trk slider positions swapped; "LFO" renamed to "LFO Mod"

**ADSR — range corrections**
- Attack: 1.5 ms–4 s (was 1 ms–2 s); taper `0.0015 × 2667^v`
- Decay: 2 ms–10 s (was 1 ms–2 s); taper `0.002 × 5000^v`
- Release: 2 ms–10 s (was 1 ms–2 s); same taper as decay
- Sustain display changed from raw decimal to percentage
- `fmtTime()` display helper shows `ms` below 1 s and `s` above

**Envelope trigger modes (new)**
- 3-position xs switch added as first control in Envelope section
- Gate+Trig: ADSR restarts from zero on every `noteOn` (retrigger message sent from `noteOn` only, not from noteOff stack recovery)
- Gate: standard legato — envelope does not restart when another key is already held
- LFO: keyboard gate replaced by `lfo.phase < 0.5` — rhythmic envelope locked to LFO cycle

**VCA mode — properly implemented**
- ENV: `vcaEnv = envOut` — ADSR shapes amplitude directly
- GATE: `vcaEnv = gate` — raw keyboard gate controls amplitude; ADSR runs freely and continues to modulate VCF env-mod and pulse width
- Old implementation (hacking ADSR time constants to near-zero) removed

**Portamento strip (redesigned)**
- Section title removed; Level slider (Volume) added alongside Porta Time
- On/Off toggle switch replaced with 3-position xs switch: Auto (legato only) / Off (default) / On (always)
- `sh101-node.js`: `portaMode` + `_glideTime` state; `_applyGlide(isLegato)` dispatches correct glide time per mode; noteOff stack recovery always treated as legato

**Slider scale marks**
- 11 equally-spaced horizontal dashes injected via JS into every standard `.strk` (non-xs)
- Marks at positions 0, 5, 10 labelled via CSS `::after { content: attr(data-lbl) }`
- Scale container: `height: 82%`, vertically centred on `.strk`, positioned to right via `left: 100%`

---

### 2026-03-02
**Output stage — limiter and dB scope**

- `DynamicsCompressorNode` limiter inserted between `masterOut` and `audioCtx.destination`: threshold −1 dBFS, ratio 20:1, hard knee, 1 ms attack, 50 ms release. Active by default; toggling sets threshold→0/ratio→1 in-place (no audio graph reconnect).
- `AnalyserNode` (fftSize 1024) sits post-limiter; a `requestAnimationFrame` loop calls `getFloatTimeDomainData`, finds the block peak, converts to dBFS, and drives a 72 px gradient bar + numeric readout in the brand bar.
- Colour zones: ≤ −18 dBFS green, −18 to −6 orange, above −6 red (both bar fill and text).

**Quadraverb — Alesis Quadraverb FX rack module (all four phases)**

- **Phase 1 — Digital Bottleneck**: 16-bit non-dithered quantiser; 4th-order Chebyshev Type I LPF at 17.5 kHz (two cascaded Direct Form II transposed biquad sections).
- **Phase 2 — Resonator**: Five independently tuned IIR comb filters; master feedback gate; each voice hard-clipped to ±1.
- **Phase 3 — Reverb Texture**: Four cascaded Schroeder all-pass filters (prime delays 149/211/263/347, g = 0.75 × diffusion); dual-path IIR tail (short M=1321, long M=3527) crossfaded by density; `reverbMix` blends tail into resonator output.
- **Phase 4 — Analog Input Stage**: Hardware noise floor at −85 dBFS injected pre-quantiser; hard-clip WaveShaperNode with Drive control (0 to +12 dB).

---

### 2026-03-01
**UI — mobile responsive scaling**

- `scaleSynth()` measures the synth's natural width vs viewport width and applies `zoom` (CSS standard) or `transform: scale()` (fallback) to fit narrow screens.
- Desktop is unaffected (`s ≥ 1` → early return).
- On resize/orientation change the scale recalculates automatically.

---

### 2026-02-28 (session 3)
**PCM 41 — five-module Lexicon PCM 41 digital delay emulation**

- M1 (Analog Front-End), M2 (12-bit ADC), M3 (Variable-Clock Delay), M4 (LFO Modulation), M5 (Feedback Path + Expander) — see README §PCM 41 for full details.

---

### 2026-02-28 (session 2)
**VCO — oscillator mix level sliders; Octave + Fine Tune AudioParams; slider interaction (wheel + double-click reset)**

---

### 2026-02-28
**Note stack — last-note priority; VCF — three Huovilainen filter bugs fixed**

---

*This is a faithful recreation of the classic Roland SH-101 synthesizer for educational and creative purposes. The original SH-101 was first released by Roland in 1982.*
