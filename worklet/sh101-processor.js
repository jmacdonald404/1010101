// ════════════════════════════════════════════════════════════════
//  SH-101 AudioWorkletProcessor — fully self-contained, no imports
// ════════════════════════════════════════════════════════════════

// ── POLYBLEP ─────────────────────────────────────────────────────
function polyBlep(t, dt) {
  if (t < dt) {
    t /= dt;
    return t + t - t * t - 1.0;
  } else if (t > 1.0 - dt) {
    t = (t - 1.0) / dt;
    return t * t + t + t + 1.0;
  }
  return 0.0;
}

function blSaw(phase, dt) {
  return (2.0 * phase - 1.0) - polyBlep(phase, dt);
}

function blPulse(phase, dt, pw) {
  let p1 = 2.0 * phase - 1.0;
  const phase2 = (phase + (1.0 - pw)) % 1.0;
  let p2 = 2.0 * phase2 - 1.0;
  p1 -= polyBlep(phase, dt);
  p2 -= polyBlep(phase2, dt);
  return 0.5 * (p1 - p2);
}

// ── ADSR ─────────────────────────────────────────────────────────
class ADSR {
  constructor(SR) {
    this.SR = SR;
    this.value = 0;
    this.stage = 'idle';
    this.prevGate = 0;
  }

  _coeff(t) {
    return 1.0 - Math.exp(-1.0 / (Math.max(t, 0.0005) * this.SR));
  }

  process(gate, a, d, s, r) {
    const hi = gate > 0.5;
    const ph = this.prevGate > 0.5;
    if (hi && !ph) this.stage = 'attack';
    if (!hi && ph) this.stage = 'release';
    this.prevGate = gate;

    const ac = this._coeff(a);
    const dc = this._coeff(d);
    const rc = this._coeff(r);

    switch (this.stage) {
      case 'attack':
        this.value += ac * (1.001 - this.value);
        if (this.value >= 1.0) { this.value = 1.0; this.stage = 'decay'; }
        break;
      case 'decay':
        this.value += dc * (s - this.value);
        if (Math.abs(this.value - s) < 0.0001) { this.value = s; this.stage = 'sustain'; }
        break;
      case 'sustain':
        this.value = s;
        break;
      case 'release':
        this.value += rc * (0.00001 - this.value);
        if (this.value < 0.0001) { this.value = 0; this.stage = 'idle'; }
        break;
      default:
        this.value = 0;
    }
    return Math.max(0, this.value);
  }
}

// ── LFO ──────────────────────────────────────────────────────────
class LFO {
  constructor(SR) {
    this.SR = SR;
    this.phase = 0;
    this.sh = 0;
  }

  process(rate, shape) {
    this.phase += rate / this.SR;
    if (this.phase >= 1.0) {
      this.phase -= 1.0;
      if (shape === 'sh') this.sh = Math.random() * 2 - 1;
    }
    const p = this.phase;
    switch (shape) {
      case 'sine':     return Math.sin(2 * Math.PI * p);
      case 'triangle': return p < 0.5 ? 4*p - 1 : 3 - 4*p;
      case 'square':   return p < 0.5 ? 1 : -1;
      case 'saw':      return 2*p - 1;
      case 'sh':       return this.sh;
      default:         return 0;
    }
  }
}

// ── PORTAMENTO ───────────────────────────────────────────────────
class Portamento {
  constructor(SR) {
    this.SR = SR;
    this.cur = 440;
    this.tgt = 440;
    this.coeff = 1.0;
    this.active = false;
  }

  setTime(t) {
    if (t < 0.001) { this.coeff = 1.0; this.active = false; }
    else { this.coeff = 1.0 - Math.exp(-1.0 / (t * this.SR)); this.active = true; }
  }

  setTarget(f) { this.tgt = f; }

  process() {
    if (!this.active) { this.cur = this.tgt; return this.cur; }
    const lc = Math.log(this.cur);
    const lt = Math.log(this.tgt);
    this.cur = Math.exp(lc + this.coeff * (lt - lc));
    return this.cur;
  }
}

// ── HALF-BAND DECIMATOR (2x oversampling) ────────────────────────
const HB = new Float64Array([
  -0.00176508, 0, 0.01902222, 0, -0.11605382, 0,
   0.59679058, 1.0,
   0.59679058, 0, -0.11605382, 0, 0.01902222, 0, -0.00176508
]);
const HB_SUM = HB.reduce((a,b) => a+b, 0);
const HBC = HB.map(c => c / HB_SUM);
const HBL = HBC.length;

class Decimator {
  constructor() {
    this.buf = new Float64Array(HBL);
    this.idx = 0;
  }
  push(v) {
    this.buf[this.idx] = v;
    this.idx = (this.idx + 1) % HBL;
  }
  read() {
    let o = 0;
    for (let j = 0; j < HBL; j++) o += HBC[j] * this.buf[(this.idx + j) % HBL];
    return o;
  }
  process(s0, s1) {
    this.push(s0);
    this.push(s1);
    return this.read();
  }
}

// ── LADDER FILTER (Huovilainen, 2x oversampled) ──────────────────
function tanhf(x) {
  if (x >  4) return  1;
  if (x < -4) return -1;
  const x2 = x * x;
  return x * (27 + x2) / (27 + 9 * x2);
}

const THERMAL = 0.5;

class LadderFilter {
  constructor(SR) {
    this.SR  = SR;
    this.OSR = SR * 2;
    this.s   = [0, 0, 0, 0];
    this.dec = new Decimator();
  }

  reset() { this.s = [0, 0, 0, 0]; }

  process(input, cutoff, res) {
    const f = 2.0 * Math.tan(Math.PI * Math.min(cutoff, this.OSR * 0.45) / this.OSR);
    const k = res * 4.0;
    const s0 = this._step(input, f, k);
    const s1 = this._step(input, f, k);
    return this.dec.process(s0, s1);
  }

  _step(input, f, k) {
    const s = this.s;
    // predictor
    const fb  = s[3];
    let   inp = input - k * fb;
    const t   = [0,0,0,0];
    t[0] = s[0] + f*(tanhf(inp /(2*THERMAL)) - tanhf(s[0]/(2*THERMAL)));
    t[1] = s[1] + f*(tanhf(t[0]/(2*THERMAL)) - tanhf(s[1]/(2*THERMAL)));
    t[2] = s[2] + f*(tanhf(t[1]/(2*THERMAL)) - tanhf(s[2]/(2*THERMAL)));
    t[3] = s[3] + f*(tanhf(t[2]/(2*THERMAL)) - tanhf(s[3]/(2*THERMAL)));
    // corrector
    inp  = input - k * 0.5 * (t[3] + s[3]);
    s[0] += f*(tanhf(inp /(2*THERMAL)) - tanhf(s[0]/(2*THERMAL)));
    s[1] += f*(tanhf(s[0]/(2*THERMAL)) - tanhf(s[1]/(2*THERMAL)));
    s[2] += f*(tanhf(s[1]/(2*THERMAL)) - tanhf(s[2]/(2*THERMAL)));
    s[3] += f*(tanhf(s[2]/(2*THERMAL)) - tanhf(s[3]/(2*THERMAL)));
    s[3] += (Math.random()*2-1) * 1e-6;
    return s[3];
  }
}

// ════════════════════════════════════════════════════════════════
//  PROCESSOR
// ════════════════════════════════════════════════════════════════
class SH101Processor extends AudioWorkletProcessor {

  static get parameterDescriptors() {
    return [
      { name:'frequency',   defaultValue:440,  minValue:0.01, maxValue:20000, automationRate:'a-rate' },
      { name:'gate',        defaultValue:0,    minValue:0,    maxValue:1,     automationRate:'a-rate' },
      { name:'pulseWidth',  defaultValue:0.5,  minValue:0.01, maxValue:0.99,  automationRate:'a-rate' },
      { name:'sawLevel',    defaultValue:1.0,  minValue:0,    maxValue:1,     automationRate:'k-rate' },
      { name:'pulseLevel',  defaultValue:0.0,  minValue:0,    maxValue:1,     automationRate:'k-rate' },
      { name:'subLevel',    defaultValue:0.0,  minValue:0,    maxValue:1,     automationRate:'k-rate' },
      { name:'noiseLevel',  defaultValue:0.0,  minValue:0,    maxValue:1,     automationRate:'k-rate' },
      { name:'cutoff',      defaultValue:2000, minValue:10,   maxValue:20000, automationRate:'a-rate' },
      { name:'resonance',   defaultValue:0.1,  minValue:0,    maxValue:1.2,   automationRate:'a-rate' },
      { name:'envModAmt',   defaultValue:0.5,  minValue:0,    maxValue:1,     automationRate:'k-rate' },
      { name:'keyTracking', defaultValue:0.5,  minValue:0,    maxValue:1,     automationRate:'k-rate' },
      { name:'attack',      defaultValue:0.005,minValue:0.0015,maxValue:4,    automationRate:'k-rate' },
      { name:'decay',       defaultValue:0.2,  minValue:0.002, maxValue:10,   automationRate:'k-rate' },
      { name:'sustain',     defaultValue:0.7,  minValue:0,     maxValue:1,    automationRate:'k-rate' },
      { name:'release',     defaultValue:0.3,  minValue:0.002, maxValue:10,   automationRate:'k-rate' },
      { name:'lfoRate',     defaultValue:2.0,  minValue:0.01, maxValue:30,    automationRate:'k-rate' },
      { name:'lfoPitchAmt', defaultValue:0,    minValue:0,    maxValue:12,    automationRate:'k-rate' },
      { name:'lfoCutoffAmt',defaultValue:0,    minValue:0,    maxValue:1,     automationRate:'k-rate' },
      { name:'lfoPWMAmt',   defaultValue:0,    minValue:0,    maxValue:1,     automationRate:'k-rate' },
      { name:'volume',      defaultValue:0.7,  minValue:0,    maxValue:1,     automationRate:'k-rate' },
      { name:'velocity',    defaultValue:1.0,  minValue:0,    maxValue:1,     automationRate:'k-rate' },
      { name:'octaveShift', defaultValue:0,    minValue:-5,   maxValue:5,     automationRate:'k-rate' },
      { name:'fineTune',    defaultValue:0,    minValue:-100, maxValue:100,   automationRate:'k-rate' },
    ];
  }

  constructor() {
    super();
    console.log('[AudioWorklet] SH101Processor constructor called, sampleRate:', sampleRate);
    this.phase   = 0;
    this.adsr    = new ADSR(sampleRate);
    this.lfo     = new LFO(sampleRate);
    this.filter  = new LadderFilter(sampleRate);
    this.porta   = new Portamento(sampleRate);
    this.lfoShape = 'triangle';
    this._loggedFirstNote = false;
    this._processCount = 0;
    this._lastLogTime = 0;

    // Module bypass states
    this.moduleStates = {
      vco: true,
      vcf: true, 
      vca: true,
      env: true,
      lfo: true
    };

    // drift: slow random walk simulating CEM3340 tempco
    this.driftPhase  = 0;
    this.driftTarget = 0;
    this.driftSmooth = 0;

    this.pwMode   = 'man'; // 'lfo' | 'man' | 'env'
    this.subMode  = 1;    // 0 = 25%pw -2oct | 1 = sq -2oct | 2 = sq -1oct
    this.envMode  = 1;    // 0 = lfo | 1 = gate | 2 = gate+trig
    this.retrigger = false;
    this.vcaMode  = 0;    // 0 = env | 1 = gate
    this.subPhase1 = 0;   // -1 oct phase (advances at dt*0.5)
    this.subPhase2 = 0;   // -2 oct phase (advances at dt*0.25)

    this.port.onmessage = ({ data }) => {
      switch (data.type) {
        case 'lfoWaveform': this.lfoShape = data.value; break;
        case 'pwMode':      this.pwMode   = data.value; break;
        case 'subMode':     this.subMode  = data.value; break;
        case 'envMode':     this.envMode  = data.value; break;
        case 'retrigger':   this.retrigger = true; break;
        case 'vcaMode':     this.vcaMode  = data.value; break;
        case 'glideTime':   this.porta.setTime(data.value); break;
        case 'noteTarget':  this.porta.setTarget(data.freq); break;
        case 'reset':       this.filter.reset(); break;
        case 'moduleToggle':
          this.moduleStates[data.module] = data.enabled;
          console.log(`[AudioWorklet] Module ${data.module} ${data.enabled ? 'enabled' : 'bypassed'}`);
          break;
      }
    };
  }

  _p(p, i) { return p.length > 1 ? p[i] : p[0]; }

  process(inputs, outputs, parameters) {
    const out = outputs[0][0];
    const p   = parameters;
    
    this._processCount++;
    
    // SIMPLE TEST: Generate a sine wave directly in the AudioWorklet (disabled for now)
    // if (this._processCount < 44100 * 2 / 128) { // 2 seconds of test tone
    //   const freq = 440; // A4
    //   for (let i = 0; i < out.length; i++) {
    //     const t = (this._processCount * 128 + i) / sampleRate;
    //     out[i] = 0.1 * Math.sin(2 * Math.PI * freq * t);
    //   }
    //   if (this._processCount % 1000 === 0) {
    //     console.log(`[AudioWorklet] SIMPLE TEST - generating sine wave, sample ${this._processCount * 128}`);
    //   }
    //   return true;
    // }
    
    // Log every 1000 process calls (about every 20ms at 44.1kHz)
    // if (this._processCount % 1000 === 0) {
    //   console.log(`[AudioWorklet] Process call #${this._processCount}, output buffer length: ${out.length}`);
    // }

    const sawLvl    = p.sawLevel[0];
    const pulseLvl  = p.pulseLevel[0];
    const subLvl    = p.subLevel[0];
    const noiseLvl  = p.noiseLevel[0];
    const envMod    = p.envModAmt[0];
    const keyTrack  = p.keyTracking[0];
    const lfoRate   = p.lfoRate[0];
    const lfoPitch  = p.lfoPitchAmt[0];
    const lfoCutoff = p.lfoCutoffAmt[0];
    const lfoPWM    = p.lfoPWMAmt[0];
    const attack    = p.attack[0];
    const decay     = p.decay[0];
    const sustain   = p.sustain[0];
    const release   = p.release[0];
    const volume    = p.volume[0];
    const velocity  = p.velocity[0];
    const transposeRatio = Math.pow(2, p.octaveShift[0] + p.fineTune[0] / 1200);

    for (let i = 0; i < out.length; i++) {
      const freq   = this._p(p.frequency,  i);
      const gate   = this._p(p.gate,       i);
      const pw     = this._p(p.pulseWidth, i);
      const cutoffBase = this._p(p.cutoff, i);
      const res    = this._p(p.resonance,  i);
      
      // SYNTHESIS DEBUG: Test each step of the synthesis chain
    //   if (gate > 0 && this._processCount % 1000 === 0 && i === 0) {
    //     console.log(`[AudioWorklet] SYNTHESIS DEBUG START - Gate: ${gate}, Freq: ${freq}`);
    //   }
      
      // Log gate state when it changes
    //   if (this._processCount % 1000 === 0) {
    //     console.log(`[AudioWorklet] Gate: ${gate.toFixed(3)}, Freq: ${freq.toFixed(1)}, Vol: ${volume.toFixed(2)}`);
    //   }

      // drift
      this.driftPhase += 1 / (sampleRate * 4);
      if (this.driftPhase >= 1) {
        this.driftPhase -= 1;
        this.driftTarget = (Math.random()*2-1) * 0.002;
      }
      this.driftSmooth += (this.driftTarget - this.driftSmooth) * 0.00005;

      // portamento tracks parameter frequency
      this.porta.setTarget(freq);
      const slewedFreq = this.porta.process() * (1 + this.driftSmooth) * transposeRatio;

      // LFO
      const lfoOut = this.moduleStates.lfo ? this.lfo.process(lfoRate, this.lfoShape) : 0;

      // ADSR (computed before VCO so envOut is available for pwMode:'env')
      let effectiveGate = gate;
      if (this.envMode === 0) {
        // LFO mode: gate driven by LFO phase (first half = on, second half = off)
        effectiveGate = this.lfo.phase < 0.5 ? 1 : 0;
      } else if (this.envMode === 2 && this.retrigger) {
        // Gate+Trig: force restart from zero even if gate was already held
        this.adsr.stage = 'attack';
        this.adsr.value = 0;
        this.retrigger = false;
      }
      const envOut = this.moduleStates.env ? this.adsr.process(effectiveGate, attack, decay, sustain, release) : 1.0;
      if (!this._loggedFirstNote && this.adsr.stage === 'attack') {
        console.log('[worklet] first gate trigger — freq:', freq.toFixed(1), 'vol:', volume.toFixed(2));
        this._loggedFirstNote = true;
      }

      // VCO
      let osc = 0;
      let norm = 1.0;
      if (this.moduleStates.vco) {
        const pitchMod  = lfoOut * lfoPitch;
        const finalFreq = slewedFreq * Math.pow(2, pitchMod / 12.0);
        const dt        = finalFreq / sampleRate;
        let modPW;
        switch (this.pwMode) {
          case 'lfo': modPW = Math.min(0.99, Math.max(0.01, pw + lfoOut * lfoPWM * 0.4)); break;
          case 'env': modPW = Math.min(0.99, Math.max(0.01, envOut)); break;
          default:    modPW = Math.min(0.99, Math.max(0.01, pw)); break; // 'man'
        }

        this.phase += dt;
        if (this.phase >= 1) this.phase -= 1;

        const saw   = blSaw(this.phase, dt);
        const pulse = blPulse(this.phase, dt, modPW);

        // Sub oscillator — phase-locked dividers (unaffected by PWM)
        this.subPhase1 = (this.subPhase1 + dt * 0.5)  % 1;
        this.subPhase2 = (this.subPhase2 + dt * 0.25) % 1;
        let sub;
        switch (this.subMode) {
          case 2:  sub = this.subPhase1 < 0.5  ? 1.0 : -1.0; break; // sq, -1 oct
          case 1:  sub = this.subPhase2 < 0.5  ? 1.0 : -1.0; break; // sq, -2 oct
          default: sub = this.subPhase2 < 0.25 ? 1.0 : -1.0; break; // 25% pw, -2 oct
        }
        const noise = Math.random() * 2 - 1;

        norm = Math.max(sawLvl + pulseLvl + subLvl + noiseLvl, 1.0);
        osc = (saw*sawLvl + pulse*pulseLvl + sub*subLvl + noise*noiseLvl) / norm;
      }
      
    //   // Debug oscillator output
    //   if (this._processCount % 1000 === 0 && Math.abs(osc) > 0.001) {
    //     console.log(`[AudioWorklet] Oscillator output: ${osc.toFixed(4)}, sawLvl: ${sawLvl}, norm: ${norm.toFixed(3)}`);
    //   }

      // Debug envelope state every 1000 calls
    //   if (this._processCount % 1000 === 0 && (gate > 0 || envOut > 0.001)) {
    //     console.log(`[AudioWorklet] Envelope - gate: ${gate.toFixed(3)}, stage: ${this.adsr.stage}, envOut: ${envOut.toFixed(4)}`);
    //   }

      // VCF — key tracking relative to A4
      const keyOffset  = cutoffBase * (Math.pow(freq / 440, keyTrack) - 1);
      const envBoost   = envOut * envMod * (20000 - cutoffBase);
      const lfoBoost   = lfoOut * lfoCutoff * 10000;
      const finalCutoff = Math.min(20000, Math.max(10, cutoffBase + envBoost + keyOffset + lfoBoost));

      // VCF
      const filtered = this.moduleStates.vcf ? this.filter.process(osc, finalCutoff, res) : osc;

      // VCA — env mode: ADSR controls amplitude; gate mode: raw key gate controls amplitude
      const vcaEnv  = this.vcaMode === 1 ? gate : envOut;
      const vcaLevel = this.moduleStates.vca ? (vcaEnv * volume * velocity) : 1.0;
      const finalOutput = filtered * vcaLevel;
      
      // DEBUG: Log the entire synthesis chain when gate is on
    //   if (gate > 0 && this._processCount % 500 === 0 && i === 0) {
    //     console.log(`[AudioWorklet] SYNTHESIS CHAIN: gate=${gate.toFixed(3)}`);
    //     console.log(`  osc: ${osc.toFixed(4)} (sawLvl: ${sawLvl}, norm: ${norm.toFixed(3)})`);
    //     console.log(`  filtered: ${filtered.toFixed(4)}`);
    //     console.log(`  envOut: ${envOut.toFixed(3)} (attack: ${attack.toFixed(3)}, stage: ${this.adsr.stage})`);
    //     console.log(`  vcaLevel: ${vcaLevel.toFixed(3)} (vol: ${volume.toFixed(2)}, vel: ${velocity.toFixed(2)})`);
    //     console.log(`  finalOutput: ${finalOutput.toFixed(4)}`);
    //   }
      
      // Simple check to see if we ever get non-zero output
    //   if (Math.abs(finalOutput) > 0.001 && this._processCount % 500 === 0) {
    //     console.log(`[AudioWorklet] NON-ZERO OUTPUT: ${finalOutput.toFixed(4)}`);
    //   }
      
      // USE SYNTHESIS OUTPUT
      out[i] = finalOutput;
    }

    return true;
  }
}

registerProcessor('sh101-processor', SH101Processor);