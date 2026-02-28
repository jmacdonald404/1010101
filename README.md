# SH-101 Web Synthesizer

A web-based clone of the classic Roland SH-101 analog synthesizer, implemented using modern HTML5, CSS3, JavaScript, and the Web Audio API.

## Project Overview

This project recreates the iconic Roland SH-101 monophonic synthesizer entirely in the browser, featuring:

- **Authentic visual design** with detailed CSS styling mimicking the original hardware
- **Full synthesizer engine** running in an AudioWorklet for real-time audio processing
- **External MIDI support** with automatic device detection and filtering
- **Built-in arpeggiator** with multiple patterns and timing divisions
- **Computer keyboard support** for musical input

## Architecture

### File Structure
```
├── index.html              # Main application with UI and control logic
├── sh101-node.js           # Main thread synthesizer wrapper class
├── arp.js                  # Arpeggiator implementation with Web Audio scheduling
└── worklet/
    └── sh101-processor.js  # AudioWorklet processor (core synthesis engine)
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

## Current Status

All synthesis modules are operational.

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

### Notes
- Each section has a panel toggle switch for independent bypass (useful for debugging)
- MIDI device filtering excludes devices whose names start with 'M'
- All DSP runs inside the AudioWorklet; UI communicates via parameters and `port.postMessage`

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

*This is a faithful recreation of the classic Roland SH-101 synthesizer for educational and creative purposes. The original SH-101 was first released by Roland in 1982.*