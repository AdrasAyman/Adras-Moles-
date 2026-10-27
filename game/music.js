"use strict";
/* ══════════════════════════════════════════════════════════════
   MOLEFIELD — Background Music (Web Audio API, no audio files)
   An original chiptune loop in the style of old arcade games:
   square-wave melody, bouncing triangle bass, drum beat and a
   little "boing" at the end of each phrase, like a mole popping
   up. As the level clock runs down it builds: the tempo rises,
   the hi-hats double, a fast arpeggio comes in, and near the end
   the whole tune jumps up a key ("hurry up!"). In the final 5
   seconds it dips under the countdown beeps, then fades out.
   ══════════════════════════════════════════════════════════════ */

const Music = {
  VOLUME: 0.55,        // music level relative to the sound effects (0 = off)
  BPM_START: 126,      // tempo for most of the level
  BPM_END: 152,        // tempo reached as the clock hits zero
  RUSH_FROM: 0.35,     // start building when this share of the level's time is left

  ctx: null,
  nodes: null,
  timer: null,
  playing: false,
  nextBar: 0,
  bar: 0,
  left: 1,             // share of the level's time still left (1 -> 0)
  secsLeft: 99,
  seed: 1,

  /* ── Called by the game ──────────────────────────────────── */
  start() {
    if (this.playing || typeof Audio_ === "undefined" || !Audio_.ctx) return;
    this.ctx = Audio_.ctx;
    this.nodes = this.build(this.ctx, this.ctx.destination);
    const g = this.nodes.bus.gain, t = this.ctx.currentTime;
    g.setValueAtTime(0.0001, t);
    g.linearRampToValueAtTime(Audio_.muted ? 0 : this.VOLUME, t + 0.8);
    this.nextBar = t + 0.1;
    this.bar = 0;
    this.playing = true;
    this.timer = setInterval(() => this.pump(), 50);
  },

  /* Tell the music how much of the level's clock is left. */
  setTimeLeft(t, dur) {
    this.secsLeft = t;
    this.left = dur > 0 ? Math.max(0, Math.min(1, t / dur)) : 1;
  },

  stop(fade = 1.0) {
    if (!this.playing) return;
    this.playing = false;
    clearInterval(this.timer);
    const nodes = this.nodes, t = this.ctx.currentTime;
    nodes.bus.gain.cancelScheduledValues(t);
    nodes.bus.gain.setValueAtTime(nodes.bus.gain.value, t);
    nodes.bus.gain.linearRampToValueAtTime(0, t + fade);
    setTimeout(() => { try { nodes.bus.disconnect(); } catch (e) {} }, (fade + 3) * 1000);
  },

  pump() {
    if (!this.playing) return;
    const t = this.ctx.currentTime;
    // Mute key, and a dip under the final countdown beeps
    const duck = this.secsLeft <= 5 ? 0.5 : 1;
    this.nodes.bus.gain.setTargetAtTime(Audio_.muted ? 0 : this.VOLUME * duck, t, 0.1);
    while (this.nextBar < t + 0.3) {
      this.nextBar += this.scheduleBar(this.ctx, this.nodes, this.nextBar, this.bar, this.left);
      this.bar++;
    }
  },

  /* ── Sound building blocks ───────────────────────────────── */
  build(ctx, dest) {
    const bus = ctx.createGain();
    bus.connect(dest);
    // Soften the square waves a little so they don't get harsh
    const tone = ctx.createBiquadFilter();
    tone.type = "lowpass"; tone.frequency.value = 5200; tone.Q.value = 0.4;
    tone.connect(bus);
    // Shared white noise for the drums
    const nb = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const nd = nb.getChannelData(0);
    for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
    return { bus, tone, noise: nb };
  },

  rand() { this.seed = (this.seed * 16807) % 2147483647; return this.seed / 2147483647; },
  hz(midi) { return 440 * Math.pow(2, (midi - 69) / 12); },

  // One chip-style note: instant attack, short and bouncy
  chip(ctx, N, type, midi, t, len, vol) {
    const o = ctx.createOscillator(); o.type = type; o.frequency.value = this.hz(midi);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(vol, t + 0.004);
    g.gain.setValueAtTime(vol, t + len * 0.7);
    g.gain.linearRampToValueAtTime(0.0001, t + len);
    o.connect(g).connect(N.tone);
    o.start(t); o.stop(t + len + 0.02);
  },

  kick(ctx, N, t, vol) {
    const o = ctx.createOscillator(); o.type = "sine";
    o.frequency.setValueAtTime(160, t);
    o.frequency.exponentialRampToValueAtTime(45, t + 0.12);
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
    o.connect(g).connect(N.bus); o.start(t); o.stop(t + 0.18);
  },

  noiseHit(ctx, N, t, vol, type, freq, dur) {
    const s = ctx.createBufferSource(); s.buffer = N.noise;
    const f = ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(f).connect(g).connect(N.bus);
    s.start(t, this.rand() * 0.8, dur + 0.02);
  },

  snare(ctx, N, t, vol) {
    this.noiseHit(ctx, N, t, vol, "bandpass", 1900, 0.13);
    const o = ctx.createOscillator(); o.type = "triangle"; o.frequency.setValueAtTime(220, t);
    o.frequency.exponentialRampToValueAtTime(140, t + 0.06);
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol * 0.6, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.07);
    o.connect(g).connect(N.bus); o.start(t); o.stop(t + 0.08);
  },

  hat(ctx, N, t, vol) { this.noiseHit(ctx, N, t, vol, "highpass", 8000, 0.03); },

  // "Boing": a quick upward slide, like a mole popping out of its hole
  boing(ctx, N, t, vol) {
    const o = ctx.createOscillator(); o.type = "square";
    o.frequency.setValueAtTime(260, t);
    o.frequency.exponentialRampToValueAtTime(880, t + 0.12);
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.setValueAtTime(vol, t + 0.1);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
    o.connect(g).connect(N.tone); o.start(t); o.stop(t + 0.17);
  },

  /* ── The tune: C – G – Am – F, two melody phrases (original) ── */
  ROOTS: [48, 43, 45, 41],                         // C, G, A, F
  ARPS: [[60, 64, 67, 72], [55, 59, 62, 67], [57, 60, 64, 69], [53, 57, 60, 65]],
  PHRASES: [
    [[72, 76, 79, 76, 84, 0, 79, 0], [79, 0, 74, 79, 83, 0, 79, 0],
     [81, 0, 76, 81, 84, 83, 81, 76], [77, 0, 81, 0, 79, 0, 0, 0]],
    [[76, 76, 0, 79, 0, 76, 72, 0], [74, 74, 0, 79, 0, 74, 71, 0],
     [72, 72, 0, 76, 0, 72, 69, 0], [69, 72, 77, 81, 79, 0, 0, 0]]
  ],

  /* Schedules one 4-beat bar starting at t0 and returns its length (s). */
  scheduleBar(ctx, N, t0, bar, left) {
    const u = Math.max(0, Math.min(1, (this.RUSH_FROM - left) / this.RUSH_FROM));   // 0 normal -> 1 time up
    const bpm = this.BPM_START + (this.BPM_END - this.BPM_START) * Math.pow(u, 1.3);
    const beat = 60 / bpm, len = beat * 4, e = beat / 2, s = beat / 4;
    const key = u > 0.6 ? 2 : 0;                    // "hurry up": jump up a key
    const c = bar % 4;
    const root = this.ROOTS[c] + key;
    const phrase = this.PHRASES[Math.floor(bar / 4) % this.PHRASES.length][c];

    // Bouncing octave bass on every eighth note
    for (let i = 0; i < 8; i++) this.chip(ctx, N, "triangle", root + (i % 2 ? 12 : 0), t0 + i * e, e * 0.9, 0.08);

    // Square-wave melody (plus a quiet octave-up double near the end)
    phrase.forEach((m, i) => {
      if (!m) return;
      this.chip(ctx, N, "square", m + key, t0 + i * e, e * 0.75, 0.06);
      if (u > 0.6) this.chip(ctx, N, "square", m + key + 12, t0 + i * e, e * 0.6, 0.015);
    });

    // Fast arpeggio joins as time runs low
    if (u > 0.25) {
      const notes = this.ARPS[c];
      for (let i = 0; i < 16; i++) this.chip(ctx, N, "square", notes[i % 4] + key + 12, t0 + i * s, s * 0.8, 0.012 + 0.012 * u);
    }

    // Drums: kick on 1 and 3, snare on 2 and 4, hi-hats on eighths (sixteenths later)
    for (let b = 0; b < 4; b++) {
      if (b % 2 === 0) this.kick(ctx, N, t0 + b * beat, 0.3);
      else this.snare(ctx, N, t0 + b * beat, 0.12 + 0.08 * u);
    }
    const hats = u > 0.3 ? 16 : 8;
    for (let i = 0; i < hats; i++) this.hat(ctx, N, t0 + i * (len / hats), i % (hats / 4) ? 0.025 : 0.045);

    // A mole "boing" at the end of every 4-bar phrase
    if (c === 3) this.boing(ctx, N, t0 + 3.5 * beat, 0.05);
    return len;
  }
};