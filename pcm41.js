// ════════════════════════════════════════════════════════════════
//  PCM41 — Lexicon PCM 41 digital delay emulation
//  Modular build — one module per session
//
//  Signal chain (internal):
//    input
//      → [M1] inputGain → clipper → compressor   (analog front-end)  ✓
//      → [M2] 12-bit quantise                    (ADC simulation)    ✓
//      → [M3] variable-clock circular-buffer delay                   ✓
//      → [M4] LFO modulation (sine / slewed square)                  ✓
//      → [M5] feedback LPF + phase inv + ∞ hold + expander             ✓
//    output
//
//  Note: M2–M5 (feedback path) live in the same AudioWorkletProcessor
//  (worklet/pcm41-processor.js) for sample accuracy. The M5 expander
//  WaveShaperNode sits on the main thread, post-worklet.
//
//  index.html owns the wet/dry blend and the on/off toggle.
//  Connect: source → pcm41.input, pcm41.output → wetGain → dest
// ════════════════════════════════════════════════════════════════

export class PCM41 {
  constructor(audioCtx) {
    this.ctx = audioCtx;
    this._quantizer = null; // set by init()

    // ── Module 1: Analog Front-End ────────────────────────────────
    this._buildFrontEnd();

    // ── Output gain node (public port) ────────────────────────────
    this._out = audioCtx.createGain();
    this._out.gain.value = 1.0;

    // ── Wire M1 internally ────────────────────────────────────────
    // M1 → M2/M3 connection is made in init() after the worklet loads.
    this._inputGain.connect(this._clipper);
    this._clipper.connect(this._compressor);

    // Public ports — never change as modules are swapped in
    this.input  = this._inputGain;
    this.output = this._out;
  }

  // ── Module 1 ────────────────────────────────────────────────────

  _buildFrontEnd() {
    const ctx = this.ctx;

    // Input gain — drives the compander; unity for now
    this._inputGain = ctx.createGain();
    this._inputGain.gain.value = 1.0;

    // Soft clipper — tanh sigmoid emulating analog input op-amps.
    // At normal levels (< −18 dBFS, amp < 0.126) the curve is
    // effectively linear. Saturation becomes audible only when
    // hot signals hit the front end, exactly as on the hardware.
    this._clipper = ctx.createWaveShaper();
    this._clipper.curve = PCM41._makeClipCurve(2.5);
    this._clipper.oversample = '4x';

    // Compressor — replicates the compander's input half.
    // 2:1 ratio, fast attack/release keeps the signal in the
    // sweet spot of the 12-bit ADC range (Module 2).
    this._compressor = ctx.createDynamicsCompressor();
    this._compressor.threshold.value = -18;  // dBFS
    this._compressor.knee.value      =   6;  // dB — soft knee
    this._compressor.ratio.value     =   2;  // 2:1
    this._compressor.attack.value    = 0.002; // 2 ms
    this._compressor.release.value   = 0.060; // 60 ms
  }

  // ── Modules 2 + 3 ───────────────────────────────────────────────

  async init() {
    await this.ctx.audioWorklet.addModule(
      './worklet/pcm41-processor.js?v=' + Date.now()
    );

    // Combined M2–M5 worklet node
    this._quantizer = new AudioWorkletNode(this.ctx, 'pcm41-processor', {
      numberOfInputs:     1,
      numberOfOutputs:    1,
      outputChannelCount: [1],
    });

    // M5: expander WaveShaperNode — reverses M1's 2:1 compression.
    // 1:2 expansion above −18 dBFS restores the dynamic range that
    // the compander compressed on the way in.
    this._expander = this.ctx.createWaveShaper();
    this._expander.curve = PCM41._makeExpandCurve();
    this._expander.oversample = '2x';

    // Complete the chain: M1 → M2-M5 worklet → expander → output
    this._compressor.connect(this._quantizer);
    this._quantizer.connect(this._expander);
    this._expander.connect(this._out);
  }

  // ── Parameter control ────────────────────────────────────────────

  // Set any AudioParam on the worklet node by name.
  // Silently ignored before init() completes.
  set(name, value) {
    if (!this._quantizer) return;
    const p = this._quantizer.parameters.get(name);
    if (p) p.setValueAtTime(value, this.ctx.currentTime);
  }

  // Send LFO waveform shape to worklet ('sine' or 'square').
  // Silently ignored before init() completes.
  setLFOShape(shape) {
    if (!this._quantizer) return;
    this._quantizer.port.postMessage({ type: 'lfoShape', value: shape });
  }

  // Invert feedback polarity (−1 × feedback signal before ADC mix).
  setPhaseInvert(bool) {
    if (!this._quantizer) return;
    this._quantizer.port.postMessage({ type: 'phaseInvert', value: bool });
  }

  // Freeze buffer content and loop indefinitely (infinite hold).
  setInfiniteRepeat(bool) {
    if (!this._quantizer) return;
    this._quantizer.port.postMessage({ type: 'infiniteRepeat', value: bool });
  }

  // ── Helpers ─────────────────────────────────────────────────────

  // Expansion curve — inverse of M1's 2:1 compressor above −18 dBFS.
  // Below threshold: f(x) = x  (compressor didn't touch these levels)
  // Above threshold: 1:2 expansion → f(x) = sign(x) · (T + (|x|−T) · 2)
  // Clamped to ±1 so the WaveShaper never produces out-of-range values.
  static _makeExpandCurve() {
    const n    = 512;
    const curve = new Float32Array(n);
    const T    = 0.126; // −18 dBFS, matches M1 compressor threshold
    for (let i = 0; i < n; i++) {
      const x   = (i / (n - 1)) * 2 - 1;
      const abs = Math.abs(x);
      if (abs <= T) {
        curve[i] = x;
      } else {
        const e = Math.sign(x) * (T + (abs - T) * 2.0);
        curve[i] = e > 1 ? 1 : e < -1 ? -1 : e;
      }
    }
    return curve;
  }

  // Normalised tanh curve: f(x) = tanh(amount·x) / tanh(amount)
  // Maps [−1, +1] → [−1, +1], stays close to linear near 0.
  static _makeClipCurve(amount) {
    const n    = 512;
    const curve = new Float32Array(n);
    const norm  = Math.tanh(amount);
    for (let i = 0; i < n; i++) {
      const x  = (i / (n - 1)) * 2 - 1; // −1 → +1
      curve[i] = Math.tanh(amount * x) / norm;
    }
    return curve;
  }
}
