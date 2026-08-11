"use strict";
/* ══════════════════════════════════════════════════════════════
   MOLEFIELD — Audio Synthesizer (Web Audio API)
   Generates all game sound effects and alarm tones procedurally.
   ══════════════════════════════════════════════════════════════ */

const Audio_ = {
  ctx: null,
  muted: false,
  alarmOsc: null,
  alarmGain: null,

  init() {
    if (!this.ctx) {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    }
  },

  blip(freq, dur, type = "square", vol = 0.18, slideTo = null) {
    if (!this.ctx || this.muted) return;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();

    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (slideTo) {
      o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
    }

    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);

    o.connect(g).connect(this.ctx.destination);
    o.start(t);
    o.stop(t + dur + 0.02);
  },

  whack() {
    this.blip(700, 0.09, "square", 0.2, 180);
    this.blip(140, 0.14, "triangle", 0.16);
  },

  bomb() {
    this.blip(90, 0.35, "sawtooth", 0.22, 40);
  },

  gold() {
    [880, 1320, 1760].forEach((f, i) =>
      setTimeout(() => this.blip(f, 0.1, "triangle", 0.15), i * 55)
    );
  },

  escaped() {
    this.blip(220, 0.12, "sine", 0.08, 150);
  },

  level() {
    [523, 659, 784, 1046].forEach((f, i) =>
      setTimeout(() => this.blip(f, 0.16, "square", 0.14), i * 90)
    );
  },

  over() {
    [523, 392, 330, 262].forEach((f, i) =>
      setTimeout(() => this.blip(f, 0.28, "sawtooth", 0.14), i * 150)
    );
  },

  alarmOn() {
    if (!this.ctx || this.muted || this.alarmOsc) return;
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    const lfo = this.ctx.createOscillator();
    const lg = this.ctx.createGain();

    o.type = "square";
    o.frequency.value = 760;

    lfo.type = "square";
    lfo.frequency.value = 6;
    lg.gain.value = 240;

    lfo.connect(lg).connect(o.frequency);
    g.gain.value = 0.13;

    o.connect(g).connect(this.ctx.destination);
    o.start();
    lfo.start();

    this.alarmOsc = { o, lfo };
    this.alarmGain = g;
  },

  alarmOff() {
    if (this.alarmOsc) {
      this.alarmOsc.o.stop();
      this.alarmOsc.lfo.stop();
      this.alarmOsc = null;
    }
  }
};
