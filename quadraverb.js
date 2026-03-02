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

  // Rebuild the hard-clip curve for the new drive level and hot-swap it.
  // drive=1 → 0 dB (no clipping), drive=4 → +12 dB (aggressive "Red LED").
  setDrive(drive) {
    this._clipper.curve = Quadraverb._makeClipCurve(drive);
  }

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
