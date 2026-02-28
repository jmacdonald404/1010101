// ════════════════════════════════════════════════════════════════
//  Arpeggiator — Web Audio clock scheduled, Chris Wilson technique
// ════════════════════════════════════════════════════════════════
export class Arpeggiator {
  constructor(audioCtx, synth) {
    this.ctx   = audioCtx;
    this.synth = synth;

    this.running    = false;
    this.held       = [];
    this.pattern    = 'up';
    this.octaves    = 1;
    this.bpm        = 120;
    this.division   = 16;

    this._idx       = 0;
    this._seq       = [];
    this._nextTime  = 0;
    this._lookahead = 0.025;   // seconds
    this._interval  = 10;      // ms
    this._timer     = null;
  }

  // ── PUBLIC ───────────────────────────────────────────────────
  noteOn(midi) {
    if (!this.held.includes(midi)) {
      this.held.push(midi);
      this._build();
      if (!this.running) this.start();
    }
  }

  noteOff(midi) {
    this.held = this.held.filter(n => n !== midi);
    this._build();
    if (this.held.length === 0) this.stop();
  }

  setBPM(bpm)           { this.bpm = bpm; }
  setDivision(div)      { this.division = div; }
  setPattern(pat)       { this.pattern = pat; this._build(); }
  setOctaveRange(oct)   { this.octaves = oct; this._build(); }

  start() {
    if (this.running) return;
    this.running   = true;
    this._idx      = 0;
    this._nextTime = this.ctx.currentTime;
    this._tick();
  }

  stop() {
    this.running = false;
    clearTimeout(this._timer);
    this.synth._releaseNote();
  }

  // ── INTERNALS ────────────────────────────────────────────────
  _build() {
    const sorted = [...this.held].sort((a,b) => a-b);
    let seq = [];
    for (let o = 0; o < this.octaves; o++)
      for (const n of sorted) seq.push(n + o*12);

    switch (this.pattern) {
      case 'up':     this._seq = seq; break;
      case 'down':   this._seq = [...seq].reverse(); break;
      case 'updown':
        this._seq = seq.length < 2
          ? seq
          : [...seq, ...[...seq].reverse().slice(1, -1)];
        break;
      case 'random': this._seq = seq; break;
    }
    if (this._seq.length > 0)
      this._idx = this._idx % this._seq.length;
  }

  _stepSec() {
    return (60.0 / this.bpm) * (4.0 / this.division);
  }

  _tick() {
    while (this._nextTime < this.ctx.currentTime + this._lookahead) {
      this._schedule(this._nextTime);
      this._advance();
    }
    this._timer = setTimeout(() => this._tick(), this._interval);
  }

  _schedule(time) {
    if (!this._seq.length) return;
    const idx  = this.pattern === 'random'
      ? Math.floor(Math.random() * this._seq.length)
      : this._idx;
    const midi = this._seq[idx];
    const freq = 440 * Math.pow(2, (midi - 69) / 12);
    const step = this._stepSec();

    // schedule via AudioParam automation — sample accurate
    this.synth.node.parameters.get('frequency').setValueAtTime(freq, time);
    this.synth.node.port.postMessage({ type: 'noteTarget', freq });
    this.synth.node.parameters.get('gate').setValueAtTime(1, time);
    this.synth.node.parameters.get('gate').setValueAtTime(0, time + step * 0.5);

    // notify UI
    if (this.synth.onNoteOn)  this.synth.onNoteOn(midi);
    setTimeout(() => {
      if (this.synth.onNoteOff) this.synth.onNoteOff();
    }, step * 500); // step * 0.5 in ms
  }

  _advance() {
    if (this._seq.length) this._idx = (this._idx + 1) % this._seq.length;
    this._nextTime += this._stepSec();
  }
}