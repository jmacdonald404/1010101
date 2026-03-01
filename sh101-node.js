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
    this._noteStack = this._noteStack.filter(n => n.note !== midiNote);
    this._noteStack.push({ note: midiNote, velocity });
    this._triggerNote(midiNote, velocity);
  }

  noteOff(midiNote) {
    if (this.arpEnabled) { this.arp.noteOff(midiNote); return; }
    this._noteStack = this._noteStack.filter(n => n.note !== midiNote);
    if (this._noteStack.length > 0) {
      const prev = this._noteStack[this._noteStack.length - 1];
      this._triggerNote(prev.note, prev.velocity);
    } else {
      this._releaseNote();
    }
  }

  // internal — also called directly by arpeggiator
  _triggerNote(midiNote, velocity = 1.0) {
    const freq = 440 * Math.pow(2, (midiNote - 69) / 12);
    const now  = this.ctx.currentTime;

    // console.log(`[SH101] Triggering note: MIDI=${midiNote}, freq=${freq.toFixed(1)}Hz, vel=${velocity.toFixed(2)}, time=${now.toFixed(3)}`);

    // tell worklet portamento target (for glide)
    this.node.port.postMessage({ type: 'noteTarget', freq });

    this.node.parameters.get('frequency').setValueAtTime(freq, now);
    this.node.parameters.get('velocity').setValueAtTime(velocity, now);
    this.node.parameters.get('gate').setValueAtTime(1, now);

    // console.log('[SH101] Parameters set - frequency, velocity, gate=1');

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

  setGlideTime(sec) {
    this.node.port.postMessage({ type: 'glideTime', value: sec });
  }

  // ── SLIDER CURVE HELPERS (matching 101 panel tapers) ─────────
  setCutoff(v)    { this.set('cutoff',    20 * Math.pow(900, v)); }
  setResonance(v) { this.set('resonance', v * 0.95); }
  setAttack(v)    { this.set('attack',    0.001 * Math.pow(2000, v)); }
  setDecay(v)     { this.set('decay',     0.001 * Math.pow(2000, v)); }
  setRelease(v)   { this.set('release',   0.001 * Math.pow(2000, v)); }

  // glide slider 0..1 → 0..1.5s log
  setGlideSlider(v) {
    const t = v < 0.01 ? 0 : 0.01 * Math.pow(150, v);
    this.setGlideTime(t);
  }

  setArpEnabled(bool) {
    this.arpEnabled = bool;
    if (!bool) { this.arp.stop(); this._releaseNote(); }
  }
}