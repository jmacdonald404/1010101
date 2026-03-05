// ════════════════════════════════════════════════════════════════
//  Quadraverb — Alesis Quadraverb digital reverb emulation
//
//  Main-thread signal chain (left → right):
//    input (public)
//      → [Ph4] _inputGain   GainNode     — drive level control
//      → [Ph4] _clipper     WaveShaperNode — hard-clip saturation
//      → [Ph1-3] _node      AudioWorkletNode — all DSP
//    output (public)
//
//  Phase 4 (main thread):
//    _inputGain gain 1.0–4.0 amplifies the signal before the hard clipper.
//    _clipper uses a piecewise-linear curve:  y = drive·x for |x| < 1/drive,
//    y = ±1 for |x| ≥ 1/drive.  At drive=1 the curve is a unity pass-through.
//    At drive=4 everything above ¼ input amplitude is hard-clipped.
//    The drive and clip stages are encoded together in the curve array so the
//    effect is browser-independent (no reliance on out-of-range extrapolation).
//
//  index.html owns the wet/dry blend and the on/off toggle.
//  Connect: source → quadraverb.input, quadraverb.output → wetGain → dest
// ════════════════════════════════════════════════════════════════

export class Quadraverb {
  constructor(audioCtx) {
    this.ctx  = audioCtx;
    this._node = null; // set by init()

    // Phase 4: hard-clip analog input stage
    // Wire: input → _inputGain → _clipper → worklet
    this._inputGain = audioCtx.createGain();
    this._inputGain.gain.value = 1.0;

    this._clipper = audioCtx.createWaveShaper();
    this._clipper.curve      = Quadraverb._makeClipCurve(1.0); // unity default
    this._clipper.oversample = '2x'; // reduce aliasing from the hard edge

    this._inputGain.connect(this._clipper);

    // Public ports — stable references, never change
    this.input  = this._inputGain;
    this.output = audioCtx.createGain();
    this.output.gain.value = 1.0;
  }

  async init() {
    await this.ctx.audioWorklet.addModule(
      './worklet/quadraverb-processor.js?v=' + Date.now()
    );

    this._node = new AudioWorkletNode(this.ctx, 'quadraverb-processor', {
      numberOfInputs:     1,
      numberOfOutputs:    1,
      outputChannelCount: [1],
    });

    // Complete the chain: clipper → worklet → output
    this._clipper.connect(this._node);
    this._node.connect(this.output);
  }

  // Set any AudioParam on the worklet node by name.
  // Silently ignored before init() completes.
  set(name, value) {
    if (!this._node) return;
    const p = this._node.parameters.get(name);
    if (p) p.setValueAtTime(value, this.ctx.currentTime);
  }

  // Input level: linear gain 0–1 applied before the clip stage.
  setInputLevel(v) {
    this._inputGain.gain.setValueAtTime(v, this.ctx.currentTime);
  }

  // Output level: linear gain 0–1 on the public output node.
  setOutputLevel(v) {
    this.output.gain.setValueAtTime(v, this.ctx.currentTime);
  }

  // Rebuild the hard-clip curve for the new drive level and hot-swap it.
  // drive=1 → 0 dB (no clipping), drive=4 → +12 dB (aggressive "Red LED").
  setDrive(drive) {
    this._clipper.curve = Quadraverb._makeClipCurve(drive);
  }

  // Apply a reverb type preset by setting all worklet AudioParams at once.
  // Types model different acoustic and digital reverb characters:
  //
  //  plate   — EMT 140 steel plate: immediate dense wash, bright, ~1.5 s decay
  //  room    — small live room: short RT60, distinct echoes, coloured reflections
  //  chamber — medium stone chamber: smooth build, moderate decay ~1 s
  //  hall    — concert hall: long sparse tail, wide, ~3 s decay
  //  reverse — swelling build-up: resonator sustain + near-infinite diffuse tail
  //
  // reverbMix=1 routes fully into the reverb tail (bypassing raw resonator output).
  // resonatorMix controls how much of the comb bank feeds into the APF chain.
  // feedback near 1 makes the resonator voices sustain; gate=1 keeps them open.
  setType(type) {
    if (!this._node) return;
    const T = Quadraverb._TYPE_PRESETS[type];
    if (!T) return;
    const now = this.ctx.currentTime;
    for (const [name, value] of Object.entries(T)) {
      const p = this._node.parameters.get(name);
      if (p) p.setValueAtTime(value, now);
    }
  }

  static _TYPE_PRESETS = {
    plate: {
      // Dense, bright, immediate attack — no resonator colouration
      diffusion: 0.88, density: 0.88, reverbDecay: 0.72, reverbMix: 1.0,
      resonatorMix: 0.0, feedback: 0.82, gate: 1.0,
      voice1Freq: 110, voice2Freq: 220, voice3Freq: 330, voice4Freq: 440, voice5Freq: 660,
    },
    room: {
      // Short RT60, more discrete early reflections, slightly darker
      diffusion: 0.42, density: 0.78, reverbDecay: 0.50, reverbMix: 1.0,
      resonatorMix: 0.0, feedback: 0.60, gate: 1.0,
      voice1Freq: 110, voice2Freq: 220, voice3Freq: 330, voice4Freq: 440, voice5Freq: 660,
    },
    chamber: {
      // Stone chamber: smoother build than room, moderate decay ~1 s
      diffusion: 0.65, density: 0.60, reverbDecay: 0.65, reverbMix: 1.0,
      resonatorMix: 0.0, feedback: 0.72, gate: 1.0,
      voice1Freq: 110, voice2Freq: 220, voice3Freq: 330, voice4Freq: 440, voice5Freq: 660,
    },
    hall: {
      // Spacious: sparse long tail (long-path dominant), slow build, ~3 s decay
      diffusion: 0.55, density: 0.22, reverbDecay: 0.92, reverbMix: 1.0,
      resonatorMix: 0.0, feedback: 0.85, gate: 1.0,
      voice1Freq: 110, voice2Freq: 220, voice3Freq: 330, voice4Freq: 440, voice5Freq: 660,
    },
    reverse: {
      // Swelling build: high resonator feedback + near-infinite diffuse tail.
      // Comb voices tuned to sub octaves for thick metallic swell.
      diffusion: 0.92, density: 0.05, reverbDecay: 0.96, reverbMix: 0.70,
      resonatorMix: 0.65, feedback: 0.96, gate: 1.0,
      voice1Freq: 55, voice2Freq: 110, voice3Freq: 220, voice4Freq: 440, voice5Freq: 880,
    },
  };

  // Piecewise-linear hard-clip curve:
  //   |x| < 1/drive  →  y = drive · x   (linear gain zone)
  //   |x| ≥ 1/drive  →  y = ±1           (hard-clip zone)
  // The gain and clip are baked into the curve itself so the result is
  // identical across browsers regardless of out-of-range extrapolation policy.
  static _makeClipCurve(drive) {
    const n = 512;
    const curve = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1; // i→[0,511] maps to x→[−1,+1]
      const y = x * drive;
      curve[i] = y > 1 ? 1 : y < -1 ? -1 : y;
    }
    return curve;
  }
}
