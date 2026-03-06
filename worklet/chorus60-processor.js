// ════════════════════════════════════════════════════════════════
//  Chorus60 AudioWorkletProcessor
//  Roland Juno-60 BBD chorus emulation
//
//  Hardware reference:
//    BBD chip:   MN3009 (256-stage Panasonic/Matsushita) + MN3101 clock driver
//    Modes:      I = 0.513 Hz triangle LFO, II = 0.863 Hz triangle LFO
//    Delay range (both modes):
//      left  1.540 ms – 5.150 ms  (center 3.345 ms, ±1.805 ms)
//      right 1.510 ms – 5.400 ms  (center 3.455 ms, ±1.945 ms)
//    Stereo:     right LFO phase-inverted vs left → opposite-direction pitch sweep
//    Pre-filter:  1-pole LPF @ 7237 Hz (BBD input anti-aliasing)
//    Post-filter: 1-pole LPF @ 10644 Hz (BBD output reconstruction)
//    No feedback, no compander (Juno-60 lacks the Roland Dimension D's companding)
//
//  Signal path (per sample):
//    mono input
//      → pre-filter (LPF 7237 Hz)
//      → ring buffer write  [BUF_SIZE=512, covers 11.6 ms @ 44100, max needed 5.4 ms]
//      → triangle LFO modulates separate L/R read pointers
//      → linear-interpolated read (L and R independently)
//      → post-filter (LPF 10644 Hz, per channel)
//      → output channel 0 = left, output channel 1 = right
//
//  Sources: pendragon-andyh/Juno60 README, pendragon-andyh/junox, jpcima measurements
// ════════════════════════════════════════════════════════════════

// ── Pre-filter: 1-pole LPF @ 7237 Hz (fc/fs = 7237/44100) ──────
// y[n] = b0·x[n] + a1·y[n−1],  a1 = exp(−2π·fc/fs)
const PRE_A1 = Math.exp(-2 * Math.PI * 7237  / 44100); // ≈ 0.3566
const PRE_B0 = 1 - PRE_A1;                             // ≈ 0.6434

// ── Post-filter: 1-pole LPF @ 10644 Hz ──────────────────────────
const POST_A1 = Math.exp(-2 * Math.PI * 10644 / 44100); // ≈ 0.2194
const POST_B0 = 1 - POST_A1;                            // ≈ 0.7806

// ── Ring buffer ──────────────────────────────────────────────────
// 512 samples → 11.6 ms @ 44100 Hz, well above the 5.40 ms maximum delay
const BUF_SIZE = 512;
const BUF_MASK = BUF_SIZE - 1;

// ── Delay geometry (Modes I and II share the same range) ─────────
// From audio measurements by jpcima and pendragon-andyh/junox source
const L_CENTER_S = 0.003345; // 3.345 ms — left center delay
const L_OFFSET_S = 0.001805; // ±1.805 ms — left peak-to-center swing
const R_CENTER_S = 0.003455; // 3.455 ms — right center delay (measured asymmetry)
const R_OFFSET_S = 0.001945; // ±1.945 ms — right peak-to-center swing

class Chorus60Processor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      // lfoRate: 0 = LFO frozen (use gain nodes to silence output),
      //          0.513 = Mode I, 0.863 = Mode II
      { name: 'lfoRate', defaultValue: 0.513, minValue: 0, maxValue: 2, automationRate: 'k-rate' },
    ];
  }

  constructor() {
    super();

    // Ring buffer + write pointer (shared by L and R — same input, different read ptrs)
    this._buf   = new Float32Array(BUF_SIZE);
    this._wrPtr = 0;

    // LFO phase accumulator [0, 1)
    this._phase = 0;

    // Pre-filter state (one-pole LPF applied before buffer write)
    this._preState = 0;

    // Post-filter states (independent per channel, applied after read)
    this._postL = 0;
    this._postR = 0;
  }

  process(inputs, outputs, parameters) {
    const inp  = inputs[0]?.[0];
    const outL = outputs[0][0];
    const outR = outputs[0][1];

    const lfoRate = parameters.lfoRate[0];

    // Convert delay geometry to samples (k-rate — computed once per block)
    const lCenter = L_CENTER_S * sampleRate; // ≈ 147.5 samples
    const lOffset = L_OFFSET_S * sampleRate; // ≈  79.6 samples
    const rCenter = R_CENTER_S * sampleRate; // ≈ 152.4 samples
    const rOffset = R_OFFSET_S * sampleRate; // ≈  85.8 samples

    const buf      = this._buf;
    let wrPtr      = this._wrPtr;
    let phase      = this._phase;
    let preState   = this._preState;
    let postL      = this._postL;
    let postR      = this._postR;

    const phaseInc = lfoRate / sampleRate;

    for (let i = 0; i < outL.length; i++) {
      const x = inp ? inp[i] : 0;

      // ── Pre-filter: 1-pole LPF (BBD anti-aliasing) ──────────
      preState = PRE_B0 * x + PRE_A1 * preState;

      // ── Ring buffer write ────────────────────────────────────
      buf[wrPtr] = preState;

      // ── Triangle LFO ∈ [−1, +1] ─────────────────────────────
      // phase 0→0.5: rises from −1 to +1; phase 0.5→1: falls from +1 to −1
      const lfo = phase < 0.5 ? 4 * phase - 1 : 3 - 4 * phase;

      // ── Read pointers (fractional samples behind wrPtr) ──────
      // Left:  normal LFO phase → delay sweeps 1.54–5.15 ms
      // Right: inverted LFO → delay sweeps opposite direction → stereo spread
      const rdL = wrPtr - lCenter - lfo * lOffset;
      const rdR = wrPtr - rCenter + lfo * rOffset;

      // ── Linear interpolation — left ──────────────────────────
      const rdLw = ((rdL % BUF_SIZE) + BUF_SIZE) % BUF_SIZE;
      const liL  = rdLw | 0;
      const frL  = rdLw - liL;
      const wetL = buf[liL & BUF_MASK] + (buf[(liL + 1) & BUF_MASK] - buf[liL & BUF_MASK]) * frL;

      // ── Linear interpolation — right ─────────────────────────
      const rdRw = ((rdR % BUF_SIZE) + BUF_SIZE) % BUF_SIZE;
      const liR  = rdRw | 0;
      const frR  = rdRw - liR;
      const wetR = buf[liR & BUF_MASK] + (buf[(liR + 1) & BUF_MASK] - buf[liR & BUF_MASK]) * frR;

      // ── Post-filter: 1-pole LPF (BBD reconstruction) ────────
      postL = POST_B0 * wetL + POST_A1 * postL;
      postR = POST_B0 * wetR + POST_A1 * postR;

      outL[i] = postL;
      outR[i] = postR;

      // ── Advance ──────────────────────────────────────────────
      wrPtr = (wrPtr + 1) & BUF_MASK;
      phase += phaseInc;
      if (phase >= 1) phase -= 1;
    }

    // Writeback
    this._wrPtr    = wrPtr;
    this._phase    = phase;
    this._preState = preState;
    this._postL    = postL;
    this._postR    = postR;

    return true;
  }
}

registerProcessor('chorus60-processor', Chorus60Processor);
