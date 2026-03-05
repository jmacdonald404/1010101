// ════════════════════════════════════════════════════════════════
//  Quadraverb AudioWorkletProcessor
//  Phase 1: Digital Bottleneck (16-bit quantisation + Chebyshev LPF)
//  Phase 2: Resonator   (5-voice IIR comb filter bank + gate)
//  Phase 3: Reverb      (4-stage APF diffusion + dual-path density tail)
//
//  Signal path per sample:
//    input
//      → [Ph1] 16-bit non-dithered quantise
//      → [Ph1] 4th-order Chebyshev Type I LPF @ 17.5 kHz       → flt
//      → [Ph2] 5 parallel IIR comb filters (gate-controlled)    → resonated
//      → [Ph3] 4 Schroeder all-pass filters (diffusion smear)   → diffused
//      → [Ph3] Short tail (M=1321) + Long tail (M=3527)
//              density crossfades between them                   → tailOut
//      → reverbMix crossfade: resonated → tailOut               → output
//
//  ── Phase 1 biquad (Fs=44 100, fc=17 500 Hz, 0.5 dB Chebyshev) ──
//    k = tan(π·fc/Fs) ≈ 2.9768   Unity DC gain across both sections.
//    Prototype poles: pair 1 σ=−0.175 ω=±1.016; pair 2 σ=−0.423 ω=±0.421
//
//  ── Phase 2 comb filter ──────────────────────────────────────────
//    COMB_SIZE = 4096 (covers ≥10.8 Hz); linear-interpolated read ptr.
//    Hard-clip each voice yn to ±1 (16-bit digital saturation).
//    effFb = feedback × gate:  gate=0 silences feedback (resonator decays).
//
//  ── Phase 3 APF (Schroeder nested-delay form) ───────────────────
//    H(z) = (z^{−M} − g) / (1 − g·z^{−M})     |H|=1 for all ω
//    Per sample:
//      t[n]  = x[n] + g · buf[wp]    (store v[n] internally)
//      y[n]  = buf[wp] − g · t[n]    (output)
//      buf[wp] = t[n];  wp = (wp+1) % M
//    g = 0.75 · diffusion   (max 0.75: stable, high smear quality)
//    Delays (prime samples): 149 / 211 / 263 / 347  (3.4–7.9 ms)
//    At diffusion=0, g=0: each APF reduces to a pure M-sample delay,
//    giving a natural 22 ms pre-delay before the reverb tail begins.
//
//  ── Phase 3 dual-path tail ───────────────────────────────────────
//    Both tails are IIR comb filters fed by diffused:
//      yn[n] = diffused[n] + reverbDecay · yn[n−M]
//    Short (M=1321, ~30 ms, buf 2048) → denser, faster decay
//    Long  (M=3527, ~80 ms, buf 4096) → sparser, longer decay
//    tailOut = density·ynShort + (1−density)·ynLong
//    Hard-clip each tail to ±1 to prevent digital explosion.
// ════════════════════════════════════════════════════════════════

// ── Phase 1: Chebyshev Type I biquad coefficients ───────────────
const B0_S1 =  0.05614, B1_S1 = 0.11228, B2_S1 =  0.05614;
const A1_S1 = -1.42178, A2_S1 = 0.80961;
const B0_S2 =  0.05245, B1_S2 = 0.10490, B2_S2 =  0.05245;
const A1_S2 = -1.44918, A2_S2 = 0.57065;

// ── Phase 4: Analog noise floor ─────────────────────────────────
// -85 dBFS: 10^(-85/20) ≈ 5.623e-5
// Added to each input sample BEFORE the 16-bit quantiser so the noise
// interacts with the quantisation grid, preventing "perfect digital
// silence" and contributing the characteristic Quadraverb background hiss.
const NOISE_AMP = 5.623e-5;

// ── Phase 2: Resonator comb geometry ────────────────────────────
const COMB_SIZE = 4096;
const COMB_MASK = COMB_SIZE - 1;

// ── Phase 3: APF delay lengths (prime samples) ──────────────────
const APF_M1 = 149; // ~3.4 ms
const APF_M2 = 211; // ~4.8 ms
const APF_M3 = 263; // ~6.0 ms
const APF_M4 = 347; // ~7.9 ms

// ── Pre-delay buffer ─────────────────────────────────────────────
// Sits between Phase 1 (LPF output) and Phase 2/3 (comb + APF).
// Max 140 ms @ 44100 Hz = 6174 samples; 8192 is the next power-of-2.
const PD_SIZE = 8192;
const PD_MASK = PD_SIZE - 1;

// ── Phase 3: Dual-path reverb tail ──────────────────────────────
// Both delays are prime, coprime to each other (GCD = 1).
const TAIL_S_M    = 1321; // ~29.9 ms — short/dense path
const TAIL_S_SIZE = 2048; // next power-of-2 ≥ TAIL_S_M
const TAIL_S_MASK = TAIL_S_SIZE - 1;

const TAIL_L_M    = 3527; // ~79.97 ms — long/sparse path
const TAIL_L_SIZE = 4096; // next power-of-2 ≥ TAIL_L_M
const TAIL_L_MASK = TAIL_L_SIZE - 1;

class QuadraverbProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      // Phase 2 — resonator voice frequencies (Hz, log-taper in UI)
      { name: 'voice1Freq',   defaultValue: 110,  minValue: 20, maxValue: 5000, automationRate: 'k-rate' },
      { name: 'voice2Freq',   defaultValue: 220,  minValue: 20, maxValue: 5000, automationRate: 'k-rate' },
      { name: 'voice3Freq',   defaultValue: 330,  minValue: 20, maxValue: 5000, automationRate: 'k-rate' },
      { name: 'voice4Freq',   defaultValue: 440,  minValue: 20, maxValue: 5000, automationRate: 'k-rate' },
      { name: 'voice5Freq',   defaultValue: 660,  minValue: 20, maxValue: 5000, automationRate: 'k-rate' },
      { name: 'feedback',     defaultValue: 0.85, minValue: 0,  maxValue: 0.99, automationRate: 'k-rate' },
      { name: 'gate',         defaultValue: 1.0,  minValue: 0,  maxValue: 1.0,  automationRate: 'k-rate' },
      { name: 'resonatorMix', defaultValue: 0.5,  minValue: 0,  maxValue: 1.0,  automationRate: 'k-rate' },
      // Phase 3 — reverb
      // diffusion: scales APF coefficient g (g = 0.75 × diffusion)
      //   0 = distinct echoes (pure pre-delay), 1 = immediate wash
      { name: 'diffusion',    defaultValue: 0.7,  minValue: 0,  maxValue: 1.0,  automationRate: 'k-rate' },
      // density: crossfades short tail (1) vs long tail (0)
      //   1 = dense/fast decay, 0 = sparse/long decay
      { name: 'density',      defaultValue: 0.5,  minValue: 0,  maxValue: 1.0,  automationRate: 'k-rate' },
      // reverbDecay: feedback coefficient for both tail comb filters
      { name: 'reverbDecay',  defaultValue: 0.7,  minValue: 0,  maxValue: 0.98, automationRate: 'k-rate' },
      // reverbMix: 0 = resonated only, 1 = reverb tail only
      { name: 'reverbMix',    defaultValue: 0.0,  minValue: 0,  maxValue: 1.0,  automationRate: 'k-rate' },
      // preDelay: time in seconds inserted between LPF and reverb body
      { name: 'preDelay',     defaultValue: 0.0,  minValue: 0,  maxValue: 0.14, automationRate: 'k-rate' },
      // preDelayMix: blend between undelayed (0) and delayed (1) signal into reverb
      { name: 'preDelayMix',  defaultValue: 1.0,  minValue: 0,    maxValue: 1.0,  automationRate: 'k-rate' },
      // hfCutoff: one-pole LPF on tail feedback — attenuates HF (20kHz = no cut)
      { name: 'hfCutoff',     defaultValue: 20000, minValue: 500,  maxValue: 20000, automationRate: 'k-rate' },
      // lfCutoff: one-pole HPF on tail feedback — attenuates LF (20Hz = no cut)
      { name: 'lfCutoff',     defaultValue: 20,    minValue: 20,   maxValue: 2000,  automationRate: 'k-rate' },
    ];
  }

  constructor() {
    super();

    // Phase 1: Direct Form II transposed biquad state
    this._w1_1 = 0.0; this._w2_1 = 0.0;
    this._w1_2 = 0.0; this._w2_2 = 0.0;

    // Phase 2: five IIR comb filter buffers + write pointers (unrolled)
    this._cb1 = new Float32Array(COMB_SIZE); this._wr1 = 0;
    this._cb2 = new Float32Array(COMB_SIZE); this._wr2 = 0;
    this._cb3 = new Float32Array(COMB_SIZE); this._wr3 = 0;
    this._cb4 = new Float32Array(COMB_SIZE); this._wr4 = 0;
    this._cb5 = new Float32Array(COMB_SIZE); this._wr5 = 0;

    // Phase 3: four APF buffers + write pointers
    // Each buffer holds exactly M samples (one full delay cycle).
    this._apf1 = new Float32Array(APF_M1); this._wp1 = 0;
    this._apf2 = new Float32Array(APF_M2); this._wp2 = 0;
    this._apf3 = new Float32Array(APF_M3); this._wp3 = 0;
    this._apf4 = new Float32Array(APF_M4); this._wp4 = 0;

    // Phase 3: dual-path reverb tail buffers + write pointers
    this._tailS = new Float32Array(TAIL_S_SIZE); this._twrS = 0;
    this._tailL = new Float32Array(TAIL_L_SIZE); this._twrL = 0;

    // Phase 3: frequency-dependent decay filter states (per tail path)
    // LPF (HF damp): one-pole low-pass applied to tail feedback
    this._lpfS = 0.0; this._lpfL = 0.0;
    // HPF (LF damp): one-pole high-pass; needs previous input + previous output
    this._hpfYS = 0.0; this._hpfXS = 0.0;
    this._hpfYL = 0.0; this._hpfXL = 0.0;

    // Pre-delay ring buffer + write pointer
    this._pdBuf = new Float32Array(PD_SIZE); this._pdWr = 0;
  }

  process(inputs, outputs, parameters) {
    const inp = inputs[0]?.[0];
    const out = outputs[0][0];

    // ── Phase 1 biquad state (register-local for JIT) ────────────
    let w1_1 = this._w1_1, w2_1 = this._w2_1;
    let w1_2 = this._w1_2, w2_2 = this._w2_2;

    // ── Phase 2 params (k-rate: read once per block) ─────────────
    const L1 = sampleRate / parameters.voice1Freq[0];
    const L2 = sampleRate / parameters.voice2Freq[0];
    const L3 = sampleRate / parameters.voice3Freq[0];
    const L4 = sampleRate / parameters.voice4Freq[0];
    const L5 = sampleRate / parameters.voice5Freq[0];
    const effFb  = parameters.feedback[0] * parameters.gate[0];
    const mixVal = parameters.resonatorMix[0];

    // Local refs to Phase 2 buffers
    const cb1 = this._cb1; let wr1 = this._wr1;
    const cb2 = this._cb2; let wr2 = this._wr2;
    const cb3 = this._cb3; let wr3 = this._wr3;
    const cb4 = this._cb4; let wr4 = this._wr4;
    const cb5 = this._cb5; let wr5 = this._wr5;

    // ── Phase 3 params (k-rate: read once per block) ─────────────
    // g is capped at 0.75: at this value the APF internal state can reach
    // A/(1−g)=4A for a sustained signal, but the output remains bounded.
    const g           = parameters.diffusion[0] * 0.75;
    const densityVal  = parameters.density[0];
    const decayVal    = parameters.reverbDecay[0];
    const reverbMix   = parameters.reverbMix[0];

    // Local refs to Phase 3 APF buffers + write pointers
    const apf1 = this._apf1; let wp1 = this._wp1;
    const apf2 = this._apf2; let wp2 = this._wp2;
    const apf3 = this._apf3; let wp3 = this._wp3;
    const apf4 = this._apf4; let wp4 = this._wp4;

    // Local refs to tail buffers + write pointers
    const tailS = this._tailS; let twrS = this._twrS;
    const tailL = this._tailL; let twrL = this._twrL;

    // ── Frequency-dependent decay coefficients (k-rate) ──────────
    // LPF (HF damp): y[n] = b0·x[n] + a1·y[n−1],  a1 = exp(−2π·fc/sr)
    const lpfA1 = Math.exp(-2 * Math.PI * parameters.hfCutoff[0] / sampleRate);
    const lpfB0 = 1 - lpfA1;
    // HPF (LF damp): y[n] = b0·(x[n] − x[n−1]) + a1·y[n−1],  b0 = (1+a1)/2
    const hpfA1 = Math.exp(-2 * Math.PI * parameters.lfCutoff[0] / sampleRate);
    const hpfB0 = (1 + hpfA1) / 2;

    // Local filter states
    let lpfS = this._lpfS, lpfL = this._lpfL;
    let hpfYS = this._hpfYS, hpfXS = this._hpfXS;
    let hpfYL = this._hpfYL, hpfXL = this._hpfXL;

    // Pre-delay (k-rate): compute integer delay in samples once per block.
    // Clamped to [0, PD_SIZE-1] so the read pointer never aliases.
    const pdDelaySamp = Math.min(Math.round(parameters.preDelay[0] * sampleRate), PD_SIZE - 1);
    const pdMix       = parameters.preDelayMix[0];
    const pdBuf = this._pdBuf; let pdWr = this._pdWr;

    for (let i = 0; i < out.length; i++) {
      const x = inp ? inp[i] : 0;

      // ── Phase 4: Noise floor (−85 dBFS, injected pre-quantiser) ─
      // The noise mixes with x before the ADC grid rounding.
      // At 16-bit resolution (LSB ≈ 3.05e-5), NOISE_AMP ≈ 1.84 LSBs —
      // enough to constantly flip the low-order bits and add warmth.
      const noise = NOISE_AMP * (Math.random() * 2 - 1);

      // ── Phase 1: 16-bit quantisation ─────────────────────────
      const q = Math.round((x + noise) * 32767) / 32767;

      // ── Phase 1: Chebyshev LPF (Direct Form II transposed) ───
      const flt1 = B0_S1 * q + w1_1;
      w1_1 = B1_S1 * q - A1_S1 * flt1 + w2_1;
      w2_1 = B2_S1 * q - A2_S1 * flt1;
      const flt  = B0_S2 * flt1 + w1_2;
      w1_2 = B1_S2 * flt1 - A1_S2 * flt + w2_2;
      w2_2 = B2_S2 * flt1 - A2_S2 * flt;

      // ── Pre-delay: write flt, read pdDelaySamp samples ago ───
      // reverbIn blends undelayed (pdMix=0) and delayed (pdMix=1) signal.
      pdBuf[pdWr] = flt;
      const pdRd    = (pdWr - pdDelaySamp + PD_SIZE) & PD_MASK;
      const delayed = pdBuf[pdRd];
      pdWr = (pdWr + 1) & PD_MASK;
      const reverbIn = flt + pdMix * (delayed - flt);

      // ── Phase 2: IIR comb filter bank ────────────────────────
      // y[n] = reverbIn[n] + effFb·y[n−L]  — hard-clipped at ±1
      let rp1 = wr1 - L1; if (rp1 < 0) rp1 += COMB_SIZE;
      const ri1 = rp1 | 0, fr1 = rp1 - ri1;
      const yd1 = cb1[ri1 & COMB_MASK] + (cb1[(ri1+1) & COMB_MASK] - cb1[ri1 & COMB_MASK]) * fr1;
      let yn1 = reverbIn + effFb * yd1;
      if (yn1 >  1) yn1 =  1; else if (yn1 < -1) yn1 = -1;
      cb1[wr1] = yn1;  wr1 = (wr1 + 1) & COMB_MASK;

      let rp2 = wr2 - L2; if (rp2 < 0) rp2 += COMB_SIZE;
      const ri2 = rp2 | 0, fr2 = rp2 - ri2;
      const yd2 = cb2[ri2 & COMB_MASK] + (cb2[(ri2+1) & COMB_MASK] - cb2[ri2 & COMB_MASK]) * fr2;
      let yn2 = reverbIn + effFb * yd2;
      if (yn2 >  1) yn2 =  1; else if (yn2 < -1) yn2 = -1;
      cb2[wr2] = yn2;  wr2 = (wr2 + 1) & COMB_MASK;

      let rp3 = wr3 - L3; if (rp3 < 0) rp3 += COMB_SIZE;
      const ri3 = rp3 | 0, fr3 = rp3 - ri3;
      const yd3 = cb3[ri3 & COMB_MASK] + (cb3[(ri3+1) & COMB_MASK] - cb3[ri3 & COMB_MASK]) * fr3;
      let yn3 = reverbIn + effFb * yd3;
      if (yn3 >  1) yn3 =  1; else if (yn3 < -1) yn3 = -1;
      cb3[wr3] = yn3;  wr3 = (wr3 + 1) & COMB_MASK;

      let rp4 = wr4 - L4; if (rp4 < 0) rp4 += COMB_SIZE;
      const ri4 = rp4 | 0, fr4 = rp4 - ri4;
      const yd4 = cb4[ri4 & COMB_MASK] + (cb4[(ri4+1) & COMB_MASK] - cb4[ri4 & COMB_MASK]) * fr4;
      let yn4 = reverbIn + effFb * yd4;
      if (yn4 >  1) yn4 =  1; else if (yn4 < -1) yn4 = -1;
      cb4[wr4] = yn4;  wr4 = (wr4 + 1) & COMB_MASK;

      let rp5 = wr5 - L5; if (rp5 < 0) rp5 += COMB_SIZE;
      const ri5 = rp5 | 0, fr5 = rp5 - ri5;
      const yd5 = cb5[ri5 & COMB_MASK] + (cb5[(ri5+1) & COMB_MASK] - cb5[ri5 & COMB_MASK]) * fr5;
      let yn5 = reverbIn + effFb * yd5;
      if (yn5 >  1) yn5 =  1; else if (yn5 < -1) yn5 = -1;
      cb5[wr5] = yn5;  wr5 = (wr5 + 1) & COMB_MASK;

      // Phase 2 crossfade output
      const combAvg  = (yn1 + yn2 + yn3 + yn4 + yn5) * 0.2;
      const resonated = reverbIn + mixVal * (combAvg - reverbIn);

      // ── Phase 3: Diffusion — 4 cascaded Schroeder APFs ───────
      // Nested-delay form (read THEN write each buffer slot):
      //   t[n]   = x[n] + g·buf[wp]   (intermediate state v[n])
      //   y[n]   = buf[wp] − g·t[n]   (all-pass output)
      //   buf[wp] = t[n];  wp = (wp+1) % M
      //
      // At low diffusion (g≈0) each stage acts as a pure M-sample delay,
      // producing a ~22 ms pre-delay. At high diffusion the transient
      // smears into a dense "cloud", replicating the hardware's character.

      // APF 1 (M=149):
      const t1  = resonated + g * apf1[wp1];
      const d1  = apf1[wp1] - g * t1;
      apf1[wp1] = t1;
      wp1 = (wp1 + 1) % APF_M1;

      // APF 2 (M=211):
      const t2  = d1 + g * apf2[wp2];
      const d2  = apf2[wp2] - g * t2;
      apf2[wp2] = t2;
      wp2 = (wp2 + 1) % APF_M2;

      // APF 3 (M=263):
      const t3  = d2 + g * apf3[wp3];
      const d3  = apf3[wp3] - g * t3;
      apf3[wp3] = t3;
      wp3 = (wp3 + 1) % APF_M3;

      // APF 4 (M=347):
      const t4  = d3 + g * apf4[wp4];
      const d4  = apf4[wp4] - g * t4;
      apf4[wp4] = t4;
      wp4 = (wp4 + 1) % APF_M4;

      const diffused = d4; // all-pass output is bounded (|H|=1)

      // ── Phase 3: Dual-path reverb tail ───────────────────────
      // Feedback signal is shaped by cascaded one-pole LPF (HF damp)
      // then one-pole HPF (LF damp) before multiplying by decayVal.
      //   LPF: lpf[n] = b0·fb + a1·lpf[n−1]
      //   HPF: hpf[n] = b0·(lpf[n] − lpf[n−1]) + a1·hpf[n−1]

      // Short path:
      const sRd  = (twrS - TAIL_S_M + TAIL_S_SIZE) & TAIL_S_MASK;
      const fbS  = tailS[sRd];
      lpfS       = lpfB0 * fbS  + lpfA1 * lpfS;
      hpfYS      = hpfB0 * (lpfS - hpfXS) + hpfA1 * hpfYS;
      hpfXS      = lpfS;
      let ynS = diffused + decayVal * hpfYS;
      if (ynS >  1) ynS =  1; else if (ynS < -1) ynS = -1;
      tailS[twrS] = ynS;
      twrS = (twrS + 1) & TAIL_S_MASK;

      // Long path:
      const lRd  = (twrL - TAIL_L_M + TAIL_L_SIZE) & TAIL_L_MASK;
      const fbL  = tailL[lRd];
      lpfL       = lpfB0 * fbL  + lpfA1 * lpfL;
      hpfYL      = hpfB0 * (lpfL - hpfXL) + hpfA1 * hpfYL;
      hpfXL      = lpfL;
      let ynL = diffused + decayVal * hpfYL;
      if (ynL >  1) ynL =  1; else if (ynL < -1) ynL = -1;
      tailL[twrL] = ynL;
      twrL = (twrL + 1) & TAIL_L_MASK;

      // Density crossfade: 1 = dense (short), 0 = sparse (long)
      const tailOut = densityVal * ynS + (1 - densityVal) * ynL;

      // Phase 3 output: crossfade resonated ↔ tail
      // reverbMix=0 → resonated only; reverbMix=1 → reverb tail only
      out[i] = resonated + reverbMix * (tailOut - resonated);
    }

    // ── Writeback ────────────────────────────────────────────────
    this._w1_1 = w1_1; this._w2_1 = w2_1;
    this._w1_2 = w1_2; this._w2_2 = w2_2;
    this._wr1 = wr1; this._wr2 = wr2;
    this._wr3 = wr3; this._wr4 = wr4; this._wr5 = wr5;
    this._wp1 = wp1; this._wp2 = wp2; this._wp3 = wp3; this._wp4 = wp4;
    this._twrS = twrS; this._twrL = twrL;
    this._lpfS = lpfS; this._lpfL = lpfL;
    this._hpfYS = hpfYS; this._hpfXS = hpfXS;
    this._hpfYL = hpfYL; this._hpfXL = hpfXL;
    this._pdWr = pdWr;

    return true;
  }
}

registerProcessor('quadraverb-processor', QuadraverbProcessor);
