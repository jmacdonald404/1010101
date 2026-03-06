// ════════════════════════════════════════════════════════════════
//  Chorus60 — Roland Juno-60 BBD chorus (main-thread class)
//
//  Signal chain:
//    input (public GainNode, mono)
//      → AudioWorkletNode 'chorus60-processor'  [2-channel stereo output]
//      → ChannelSplitter
//      → outputL (public GainNode) → caller routes to stereo merger left
//      → outputR (public GainNode) → caller routes to stereo merger right
//
//  The worklet outputs pure wet signal (delayed + filtered, no dry).
//  Dry signal remains in the caller's fxDry path.
//  On/off and fade are handled by outputL/outputR gain.
// ════════════════════════════════════════════════════════════════

export class Chorus60 {
  constructor(audioCtx) {
    this.ctx   = audioCtx;
    this._node = null;    // set by init()
    this._mode = 'off';

    this.input   = audioCtx.createGain();
    this.outputL = audioCtx.createGain();
    this.outputR = audioCtx.createGain();
    this.outputL.gain.value = 0;
    this.outputR.gain.value = 0;
  }

  async init() {
    await this.ctx.audioWorklet.addModule(
      './worklet/chorus60-processor.js?v=' + Date.now()
    );

    this._node = new AudioWorkletNode(this.ctx, 'chorus60-processor', {
      numberOfInputs:     1,
      numberOfOutputs:    1,
      outputChannelCount: [2],   // stereo: ch0 = left, ch1 = right
    });

    const split = this.ctx.createChannelSplitter(2);
    this.input.connect(this._node);
    this._node.connect(split);
    split.connect(this.outputL, 0); // worklet ch0 (left)  → outputL
    split.connect(this.outputR, 1); // worklet ch1 (right) → outputR
  }

  // mode: 'off' | 'I' | 'II'
  setMode(mode) {
    this._mode = mode;
    if (!this._node) return;

    const LFO_RATES = { I: 0.513, II: 0.863 };
    const rate = LFO_RATES[mode] ?? 0;
    const gain = mode === 'off' ? 0 : 1;
    const t = this.ctx.currentTime;

    this._node.parameters.get('lfoRate').setValueAtTime(rate, t);
    this.outputL.gain.setTargetAtTime(gain, t, 0.02);
    this.outputR.gain.setTargetAtTime(gain, t, 0.02);
  }
}
