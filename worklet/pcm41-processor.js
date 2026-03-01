// ════════════════════════════════════════════════════════════════
//  PCM 41 AudioWorkletProcessor
//  Module 2: 12-bit quantisation
//  Module 3: Variable-clock delay engine
//  Module 4: LFO modulation (sine / slewed square)
//  Module 5: Feedback path LPF + phase invert + infinite repeat
//            (expander WaveShaperNode lives in pcm41.js, post-worklet)
//
//  M2–M5 share one worklet because the ADC, delay RAM, and feedback
//  path are tightly coupled and require sample-accurate timing.
//
//  Signal path per sample:
//    input
//      → [M5] feedback LPF (12 kHz one-pole) + phase invert
//      → [M2] mix with feedback; 12-bit quantise (clips to ±1)
//      → [M3] write to circular buffer  ← skipped in infinite-repeat mode
//      → [M4] LFO offset applied to read pointer
//      → [M3] linear-interpolated read (variable read speed)
//      → [M3] one-pole anti-aliasing LPF (cutoff ∝ clock speed)
//      → output  (stored as _prevOut for next cycle's feedback)
//
//  Parameters (all k-rate):
//    delayTime   [0.002, 1.4 s]    default 0.375 s
//    readSpeed   [0.25,  4.0 ]     default 1.0
//    feedback    [0,     0.97]     default 0.35
//    lfoRate     [0.05, 10.0 Hz]   default 0.5 Hz
//    lfoDepth    [0,    0.030 s]   default 0 s
//
//  Messages (port):
//    { type:'lfoShape',      value:'sine'|'square' }
//    { type:'phaseInvert',   value: bool }
//    { type:'infiniteRepeat',value: bool }
//
//  Buffer geometry:
//    BUF_SIZE = 65536 (2^16) — bitwise AND wrapping
//    Covers 1.486 s at 44.1 kHz
//
//  LFO detail (M4):
//    Both shapes modulate the effective delay time:
//      effectiveReadOffset = baseReadOffset + lfoOut * clampedDepthSamples
//    Square-wave slew: a 40 Hz one-pole LPF (~4 ms τ) smooths the hard
//    edges to prevent clicks while preserving the rhythmic pitch-jump feel.
//    Depth is clamped to 90 % of the current delay time so the read
//    pointer never overtakes the write pointer.
// ════════════════════════════════════════════════════════════════

const BUF_SIZE = 65536; // 2^16
const BUF_MASK = BUF_SIZE - 1;

class PCM41Processor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name:'delayTime', defaultValue:0.375, minValue:0.002, maxValue:1.4,   automationRate:'k-rate' },
      { name:'readSpeed', defaultValue:1.0,   minValue:0.25,  maxValue:4.0,   automationRate:'k-rate' },
      { name:'feedback',  defaultValue:0.35,  minValue:0,     maxValue:0.97,  automationRate:'k-rate' },
      { name:'lfoRate',   defaultValue:0.5,   minValue:0.05,  maxValue:10.0,  automationRate:'k-rate' },
      { name:'lfoDepth',  defaultValue:0,     minValue:0,     maxValue:0.030, automationRate:'k-rate' },
    ];
  }

  constructor() {
    super();
    this._buf           = new Float32Array(BUF_SIZE);
    this._writePtr      = 0;
    this._readPtr       = 0.0;
    this._lpfY          = 0.0;
    this._prevOut       = 0.0;
    this._prevDelayTime = -1;

    // M4 state
    this._lfoPhase  = 0.0;
    this._lfoShape  = 'sine';  // 'sine' | 'square'
    this._slewY     = 0.0;    // one-pole state for square-wave slew

    // Slew filter coefficient — 40 Hz (~4 ms τ), computed once.
    // Smooths square-wave edges to prevent clicks while keeping
    // the rhythmic pitch-jump character of the hardware.
    this._slewA = Math.exp(-2.0 * Math.PI * 40.0 / sampleRate);
    this._slewB = 1.0 - this._slewA;

    // M5 state
    // Feedback path LPF at 12 kHz — simulates the anti-aliasing filter
    // on the hardware DAC output that fed back into the ADC.
    this._fbLpfA       = Math.exp(-2.0 * Math.PI * 12000.0 / sampleRate);
    this._fbLpfB       = 1.0 - this._fbLpfA;
    this._fbLpfY       = 0.0;
    this._phaseInvert   = 1;      // 1 = normal, −1 = inverted
    this._infiniteRepeat = false; // when true: freeze buffer, loop existing content

    this.port.onmessage = e => {
      if (e.data.type === 'lfoShape')       this._lfoShape       = e.data.value;
      if (e.data.type === 'phaseInvert')    this._phaseInvert    = e.data.value ? -1 : 1;
      if (e.data.type === 'infiniteRepeat') this._infiniteRepeat = e.data.value;
    };
  }

  process(inputs, outputs, parameters) {
    const inp       = inputs[0]?.[0];
    const out       = outputs[0][0];
    const delayTime = parameters.delayTime[0];
    const readSpeed = parameters.readSpeed[0];
    const feedback  = parameters.feedback[0];
    const lfoRate   = parameters.lfoRate[0];
    const lfoDepth  = parameters.lfoDepth[0];

    // ── Re-anchor read pointer when delay time changes ─────────────
    if (Math.abs(delayTime - this._prevDelayTime) > 0.5 / sampleRate) {
      const dist = Math.round(delayTime * sampleRate);
      this._readPtr = (this._writePtr - dist + BUF_SIZE * 2) & BUF_MASK;
      this._prevDelayTime = delayTime;
    }

    // ── One-pole LPF coefficient (once per block) ──────────────────
    const fc   = Math.max(20, Math.min(readSpeed * 8000, sampleRate * 0.45));
    const lpfA = Math.exp(-2.0 * Math.PI * fc / sampleRate);
    const lpfB = 1.0 - lpfA;

    // ── M4: LFO setup (once per block) ────────────────────────────
    const lfoInc = 2.0 * Math.PI * lfoRate / sampleRate;

    // Clamp depth so the LFO can never push the read pointer past the
    // write pointer: max swing = 90 % of the current delay distance.
    const maxDepthSmp = Math.min(lfoDepth, delayTime * 0.9) * sampleRate;

    const isSine   = this._lfoShape === 'sine';
    const slewA    = this._slewA;
    const slewB    = this._slewB;

    for (let i = 0; i < out.length; i++) {
      const input = inp ? inp[i] : 0;

      // ── M5: feedback path — 12 kHz LPF + phase invert ────────────
      // LPF runs on _prevOut before the mix so every repeat is gently
      // band-limited, matching the hardware DAC anti-aliasing filter.
      this._fbLpfY = this._fbLpfA * this._fbLpfY + this._fbLpfB * this._prevOut;
      const filteredFb = this._fbLpfY * this._phaseInvert;

      // ── M2: feedback mix + 12-bit quantise ───────────────────────
      // In infinite-repeat mode the buffer is frozen: skip the write but
      // still advance the pointer so the read-distance stays correct.
      if (!this._infiniteRepeat) {
        const mixIn = input + feedback * filteredFb;
        let q = Math.floor(mixIn * 2048);
        if (q < -2048) q = -2048;
        if (q >  2047) q =  2047;
        this._buf[this._writePtr] = q / 2048;
      }
      this._writePtr = (this._writePtr + 1) & BUF_MASK;

      // ── M4: LFO output ────────────────────────────────────────────
      let lfoOut;
      if (isSine) {
        lfoOut = Math.sin(this._lfoPhase);
      } else {
        // Square — apply slew filter to soften transitions
        const rawSq = this._lfoPhase < Math.PI ? 1.0 : -1.0;
        this._slewY = slewA * this._slewY + slewB * rawSq;
        lfoOut = this._slewY;
      }

      // Positive lfoOut → longer effective delay (read pointer moves back)
      const lfoSamp = maxDepthSmp * lfoOut;
      let rp = this._readPtr - lfoSamp;
      if      (rp >= BUF_SIZE) rp -= BUF_SIZE;
      else if (rp < 0)         rp += BUF_SIZE;

      // ── M3: linear-interpolated read ─────────────────────────────
      const ri   = rp | 0;
      const frac = rp - ri;
      const x0   = this._buf[ ri          & BUF_MASK];
      const x1   = this._buf[(ri + 1)     & BUF_MASK];
      const raw  = x0 + (x1 - x0) * frac;

      // ── M3: one-pole LPF (clock aliasing simulation) ─────────────
      this._lpfY = lpfA * this._lpfY + lpfB * raw;
      out[i]     = this._lpfY;

      this._prevOut = this._lpfY;

      // ── Advance LFO phase ─────────────────────────────────────────
      this._lfoPhase += lfoInc;
      if (this._lfoPhase >= 2.0 * Math.PI) this._lfoPhase -= 2.0 * Math.PI;

      // ── Advance read pointer ──────────────────────────────────────
      this._readPtr += readSpeed;
      if (this._readPtr >= BUF_SIZE) this._readPtr -= BUF_SIZE;
    }

    return true;
  }
}

registerProcessor('pcm41-processor', PCM41Processor);
