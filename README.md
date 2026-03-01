# SH-101 Web Synthesizer + PCM 41 FX

A web-based clone of the classic Roland SH-101 analog synthesizer with a Lexicon PCM 41 digital delay emulation in an FX rack, implemented using modern HTML5, CSS3, JavaScript, and the Web Audio API.

## Project Overview

This project recreates the iconic Roland SH-101 monophonic synthesizer entirely in the browser, featuring:

- **Authentic visual design** with detailed CSS styling mimicking the original hardware
- **Full synthesizer engine** running in an AudioWorklet for real-time audio processing
- **External MIDI support** with automatic device detection and filtering
- **Built-in arpeggiator** with multiple patterns and timing divisions
- **Computer keyboard support** for musical input
- **PCM 41 FX rack** — five-module Lexicon PCM 41 digital delay emulation

## Architecture

### File Structure
```
├── index.html              # Main application with UI and control logic
├── sh101-node.js           # Main thread synthesizer wrapper class
├── arp.js                  # Arpeggiator implementation with Web Audio scheduling
├── pcm41.js                # Main thread PCM 41 wrapper class (M1 + M5 expander)
└── worklet/
    ├── sh101-processor.js  # AudioWorklet processor (core synthesis engine)
    └── pcm41-processor.js  # AudioWorklet processor (PCM 41 delay engine, M2–M5)
```

### Technical Implementation

**Audio Engine (worklet/sh101-processor.js)**
- **PolyBLEP oscillators** for alias-free sawtooth and pulse waveforms
- **Huovilainen ladder filter** with 2x oversampling for authentic Moog-style filtering
- **ADSR envelope generator** with logarithmic curves
- **LFO** with triangle, square, sawtooth, and sample & hold waveforms
- **Portamento/glide** with logarithmic frequency interpolation
- **Analog drift simulation** mimicking CEM3340 VCO temperature coefficient behavior
- **Half-band decimation** for proper downsampling from 2x oversampled processing

**User Interface (index.html)**
- Pixel-perfect recreation of SH-101 panel layout using CSS Grid and Flexbox
- Custom-styled range sliders with authentic cream-colored caps
- Real-time parameter visualization with value displays
- Status indicators for audio context, MIDI, and note activity
- 32-key virtual keyboard (C2-G4) with black/white key positioning

**MIDI Integration**
- Automatic MIDI device discovery and connection
- Note on/off handling with velocity sensitivity
- MIDI CC mapping for real-time parameter control (cutoff, resonance, envelope, etc.)
- **Device filtering**: Excludes MIDI devices whose names start with 'M' (lines 692, 737, 740)

**Arpeggiator (arp.js)**
- Web Audio scheduled timing for sample-accurate sequencing
- Patterns: Up, Down, Up/Down, Random
- Note divisions: 8th, 16th, 32nd notes
- 1-2 octave range support
- BPM control from 40-260

**PCM 41 FX rack (pcm41.js + worklet/pcm41-processor.js)**
- Five-module emulation of the Lexicon PCM 41 digital delay
- Signal chain: analog front-end → 12-bit ADC → variable-clock delay → LFO mod → feedback path → expander
- Wet/dry routing via GainNodes; on/off toggle with smooth gain ramp

## Current Status

All SH-101 synthesis modules and PCM 41 FX modules are operational.

### SH-101

| Module | Status |
|---|---|
| VCO | ✅ PolyBLEP sawtooth, pulse, sub-oscillator, noise |
| VCF | ✅ Huovilainen ladder, cutoff/resonance/env-mod/key-tracking |
| VCA | ✅ Envelope and gate modes |
| ADSR | ✅ All stages with logarithmic curves |
| LFO | ✅ Triangle, square, saw, S&H; routes to pitch, PWM, cutoff |
| Portamento | ✅ Logarithmic frequency glide |
| Arpeggiator | ✅ Up/Down/Up-Down/Random, 8th–32nd, 1–2 oct |
| MIDI | ✅ Note on/off, velocity, CC mapping |

### PCM 41

| Module | Status | Description |
|---|---|---|
| M1 — Analog Front-End | ✅ | tanh soft clipper (WaveShaper, 4× oversample) + 2:1 compressor (−18 dBFS) |
| M2 — 12-bit ADC | ✅ | `floor(x × 2048)`, clip to ±2048, re-quantise per feedback cycle |
| M3 — Variable-Clock Delay | ✅ | 65536-sample circular buffer, linear interpolation, clock-aliasing LPF |
| M4 — LFO Modulation | ✅ | Sine / square (40 Hz slewed) modulates delay time; depth clamped to 90 % |
| M5 — Feedback + Expander | ✅ | 12 kHz feedback LPF, phase invert, infinite hold, 1:2 expander WaveShaper |

### Notes
- Each SH-101 section has a panel toggle switch for independent bypass (useful for debugging)
- MIDI device filtering excludes devices whose names start with 'M'
- All DSP runs inside AudioWorklets; UI communicates via parameters and `port.postMessage`

## Technical Specifications

- **Sample Rate**: 44.1 kHz with 2x oversampling in filter
- **Latency**: Interactive latency hint for minimal audio delay  
- **Polyphony**: Monophonic (true to original SH-101)
- **Oscillator**: PolyBLEP anti-aliased waveforms
- **Filter**: 24dB/oct Huovilainen ladder filter with analog modeling
- **Modulation**: LFO → Pitch, Pulse Width, Filter Cutoff
- **MIDI**: Full MIDI input support with CC parameter mapping

## Next Steps

1. **Cross-browser compatibility** — Test in Firefox and Safari; resolve any Web Audio API differences
2. **Performance profiling** — Measure AudioWorklet CPU usage and optimize hot paths if needed
3. **Extended features** — Step sequencer patterns, patch save/load
4. **PCM 41 UI** — Dedicated panel styling for the FX rack; per-unit wet/dry mix knob

## Development Environment

- Modern browser with Web Audio API support
- AudioWorklet support (Chrome 66+, Firefox 76+, Safari 14.1+)
- MIDI API support for external controller input
- No build process required - pure vanilla JavaScript implementation

## Changelog

### 2026-02-28
**Note stack — last-note priority**

- `SH101.noteOn/noteOff` now maintain a `_noteStack`. Releasing a note falls back to the most recently held note (retriggering envelope + velocity) rather than dropping to silence.

**VCF (Huovilainen ladder filter) — three bugs fixed, filter re-enabled**

- **`f` coefficient formula** (`LadderFilter.process`): removed a spurious `/ this.OSR` factor that made the cutoff ~88,200× too low (effective cutoff ≈ 0.02 Hz — essentially DC). Fixed to `2.0 * Math.tan(π * fc / OSR)`.
- **`THERMAL` constant**: changed from `0.000025` to `0.5`. At the old value every tanh argument was ±20,000, fully saturating all four stages so they acted as comparators instead of filter poles. `0.5` is the value consistent with the corrected `f` formula for normalized (±1) audio signals.
- **Noise dither**: the dither term `(random) * THERMAL * 0.5` would have added ±0.25 noise per sample at `THERMAL = 0.5`. Changed to a fixed `1e-6`.
- Removed the temporary `* 3.0` output gain and re-enabled `filter.process()`.

---

### 2026-02-28 (session 2)
**VCO — oscillator mix level sliders**

- Saw and Pulse waveform toggles replaced with independent 0–100% level sliders; both waveforms can now be mixed simultaneously.
- Sub oscillator level slider added; Sub Oct buttons (Off / −1 Oct / −2 Oct) gate the level without controlling it directly.

**VCO — Octave and Fine Tune**

- `octaveShift` (±5 oct) and `fineTune` (±100 ¢) added as k-rate AudioWorklet parameters.
- Transpose ratio `2^(octaveShift + fineTune/1200)` applied post-portamento, preserving glide behaviour.
- AudioWorklet `addModule()` now appends `?v=<timestamp>` to prevent stale cached modules during development.

**UI — keyboard octave controls removed**

- Oct Up / Down buttons and display removed from the keyboard toolbar; computer keyboard input is fixed to octave 4.

**UI — slider interaction**

- All sliders respond to mouse wheel while hovered (1 step per tick).
- Double-clicking any slider resets it to the midpoint of its range.

---

### 2026-02-28 (session 3)
**PCM 41 — five-module Lexicon PCM 41 digital delay emulation**

- **M1 (Analog Front-End)**: tanh soft-clipper WaveShaperNode (4× oversample, normalised tanh curve) + DynamicsCompressor (2:1 ratio, −18 dBFS, 6 dB soft knee, 2 ms attack, 60 ms release).
- **M2 (12-bit ADC)**: per-sample `floor(x × 2048)`, hard clip to ±2048, write quantised value back; feedback is mixed with input *before* quantisation so every repeat is re-quantised (accumulates characteristic 12-bit noise).
- **M3 (Variable-Clock Delay)**: 65536-sample (2^16) power-of-2 circular buffer with bitwise-AND wrapping; fractional linear interpolation between adjacent samples; one-pole anti-aliasing LPF whose cutoff scales with `readSpeed` (`fc = readSpeed × 8 kHz`); read pointer re-anchored on delay-time changes with a 0.5-sample threshold to avoid floating-point jitter.
- **M4 (LFO Modulation)**: sine or square (40 Hz slew-limited, ~4 ms τ) LFO modulates the read-pointer offset; depth clamped to 90 % of current delay distance so the read pointer never overtakes the write pointer.
- **M5 (Feedback Path + Expander)**: one-pole 12 kHz LPF on the feedback signal (simulates hardware DAC anti-aliasing); optional phase invert (×−1) on feedback; infinite-hold mode freezes buffer writes while looping existing 12-bit content; WaveShaperNode expander (1:2 ratio above −18 dBFS, 2× oversample) complements the M1 compressor.
- **FX rack UI**: dark-blue rack panel between synth and keyboard; PCM 41 unit with on/off toggle, Delay (log 2ms–1.2s), Repeat (0–97%), LFO Rate (log 0.05–10 Hz), LFO Depth (0–30ms), Sine/Square shape toggle, ɸ Inv, and Hold toggles. All sliders support mouse-wheel and double-click reset.
- **Audio routing**: `synth.output → fxBus → dry gain → masterOut`; `fxBus → pcm41.input → pcm41.output → wetGain (0 by default) → masterOut`; wet gain ramps with `setTargetAtTime` on toggle.

---

*This is a faithful recreation of the classic Roland SH-101 synthesizer for educational and creative purposes. The original SH-101 was first released by Roland in 1982.*