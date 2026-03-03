// ════════════════════════════════════════════════════════════════
//  SH101Node — main-thread wrapper
// ════════════════════════════════════════════════════════════════
import { Arpeggiator } from './arp.js';

export class SH101 {
  constructor(audioCtx) {
    this.ctx  = audioCtx;
    this.node   = null;
    this.output = null; // GainNode — connect this to the FX bus
    this.arp    = null;
    this.arpEnabled = false;
    this._noteStack = []; // {note, velocity} — most recent last
    this.portaMode  = 1;  // 0 = on | 1 = off | 2 = auto (legato only)
    this._glideTime = 0;  // computed from slider, in seconds

    // status callbacks — set these from the outside
    this.onNoteOn  = null; // (midiNote) => void
    this.onNoteOff = null; // ()         => void
  }

  async init() {
    console.log('[SH101] Loading AudioWorklet module...');
    await this.ctx.audioWorklet.addModule('./worklet/sh101-processor.js?v=' + Date.now());
    console.log('[SH101] AudioWorklet module loaded successfully');

    console.log('[SH101] Creating AudioWorkletNode...');
    this.node = new AudioWorkletNode(this.ctx, 'sh101-processor', {
      numberOfInputs:     0,
      numberOfOutputs:    1,
      outputChannelCount: [1],
    });
    console.log('[SH101] AudioWorkletNode created:', this.node);

    this.output = this.ctx.createGain();
    this.node.connect(this.output);

    console.log('[SH101] Creating arpeggiator...');
    this.arp = new Arpeggiator(this.ctx, this);
    console.log('[SH101] Arpeggiator created');

    return this;
  }

  // ── NOTE CONTROL ─────────────────────────────────────────────
  noteOn(midiNote, velocity = 1.0) {
    if (this.arpEnabled) { this.arp.noteOn(midiNote); return; }
    const wasHolding = this._noteStack.length > 0;
    this._noteStack = this._noteStack.filter(n => n.note !== midiNote);
    this._noteStack.push({ note: midiNote, velocity });
    this._applyGlide(wasHolding);
    this.node.port.postMessage({ type: 'retrigger' }); // Gate+Trig: only on deliberate key press
    this._triggerNote(midiNote, velocity);
  }

  noteOff(midiNote) {
    if (this.arpEnabled) { this.arp.noteOff(midiNote); return; }
    this._noteStack = this._noteStack.filter(n => n.note !== midiNote);
    if (this._noteStack.length > 0) {
      const prev = this._noteStack[this._noteStack.length - 1];
      this._applyGlide(true); // recovering to previously held note = always legato
      this._triggerNote(prev.note, prev.velocity);
    } else {
      this._releaseNote();
    }
  }

  // Compute and send glide time based on current portaMode and whether it's a legato transition
  _applyGlide(isLegato) {
    let t;
    switch (this.portaMode) {
      case 0: t = this._glideTime; break;                      // On: always glide
      case 1: t = 0; break;                                    // Off: never glide
      case 2: t = isLegato ? this._glideTime : 0; break;       // Auto: legato only
    }
    this.setGlideTime(t);
  }

  // internal — also called directly by arpeggiator
  _triggerNote(midiNote, velocity = 1.0) {
    const freq = 440 * Math.pow(2, (midiNote - 69) / 12);
    const now  = this.ctx.currentTime;

    // tell worklet portamento target (for glide)
    this.node.port.postMessage({ type: 'noteTarget', freq });

    this.node.parameters.get('frequency').setValueAtTime(freq, now);
    this.node.parameters.get('velocity').setValueAtTime(velocity, now);
    this.node.parameters.get('gate').setValueAtTime(1, now);

    if (this.onNoteOn) this.onNoteOn(midiNote);
  }

  _releaseNote() {
    this.node.parameters.get('gate').setValueAtTime(0, this.ctx.currentTime);
    if (this.onNoteOff) this.onNoteOff();
  }

  // ── PARAMETER SET ────────────────────────────────────────────
  set(name, value, rampSec = 0) {
    const param = this.node.parameters.get(name);
    if (!param) return;
    if (rampSec > 0) {
      param.linearRampToValueAtTime(value, this.ctx.currentTime + rampSec);
    } else {
      param.setValueAtTime(value, this.ctx.currentTime);
    }
  }

  // ── WORKLET MESSAGES ─────────────────────────────────────────
  setLFOWaveform(shape) {
    this.node.port.postMessage({ type: 'lfoWaveform', value: shape });
  }

  setEnvMode(mode) {
    this.node.port.postMessage({ type: 'envMode', value: mode });
  }

  setVCAMode(mode) {
    this.node.port.postMessage({ type: 'vcaMode', value: mode });
  }

  setPWMode(mode) {
    this.node.port.postMessage({ type: 'pwMode', value: mode });
  }

  setSubMode(mode) {
    this.node.port.postMessage({ type: 'subMode', value: mode });
  }

  setGlideTime(sec) {
    this.node.port.postMessage({ type: 'glideTime', value: sec });
  }

  setPortaMode(mode) {
    this.portaMode = mode;
    // Immediately reflect mode change (no note playing assumed)
    if (mode === 1) this.setGlideTime(0);           // Off: silence glide now
    else this.setGlideTime(this._glideTime);         // On/Auto: apply current time
  }

  // ── SLIDER CURVE HELPERS (matching 101 panel tapers) ─────────
  setCutoff(v)    { this.set('cutoff',    10 * Math.pow(2000, v)); }
  setResonance(v) { this.set('resonance', v); }
  setAttack(v)    { this.set('attack',    0.0015 * Math.pow(2667, v)); }  // 1.5ms – 4s
  setDecay(v)     { this.set('decay',     0.002  * Math.pow(5000, v)); }  // 2ms – 10s
  setRelease(v)   { this.set('release',   0.002  * Math.pow(5000, v)); }  // 2ms – 10s

  // glide slider 0..1 → 0..1.5s log; stores time and applies per portaMode
  setGlideSlider(v) {
    this._glideTime = v < 0.01 ? 0 : 0.01 * Math.pow(150, v);
    this._applyGlide(false); // update immediately (conservative: treat as non-legato)
  }

  setArpEnabled(bool) {
    this.arpEnabled = bool;
    if (!bool) { this.arp.stop(); this._releaseNote(); }
  }
}
