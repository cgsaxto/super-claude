// Super Claude — sound effects, synthesised with the Web Audio API.
// Every sound is original: square / triangle voices, short pitch glides, small
// arpeggios and filtered noise. No samples, no external files.
//
// The game only calls SuperAudio.play(name). Nothing here reads or changes game
// state, uses the game's random numbers, or can throw into the game loop.
(function (root) {
  'use strict';

  // ------------------------------------------------------------------ tuning
  const CONFIG = {
    defaultVolume: 0.35,
    maxSounds: 8,          // sounds allowed to overlap; the least important one gives way
    fadeSeconds: 0.03,     // fade used when everything is stopped at once
    storageKey: 'superClaude.audio',
  };

  // Note helpers: n(frequency, start, duration, options)
  const sq = (f, t, d, o = {}) => ({ wave: 'square', f, t, d, g: 0.22, ...o });
  const tri = (f, t, d, o = {}) => ({ wave: 'triangle', f, t, d, g: 0.4, ...o });
  const noise = (t, d, o = {}) => ({ wave: 'noise', t, d, g: 0.3, filter: 'lowpass', cut: 1200, ...o });
  // a run of notes: [frequency, duration] pairs played back to back
  const run = (make, start, notes, o = {}) => {
    let t = start;
    return notes.map(([f, d]) => { const v = make(f, t, d * 0.92, o); t += d; return v; });
  };

  // priority: higher wins a voice when too many sounds overlap.
  // throttle: minimum seconds between two plays of the same sound.
  // ui: allowed while the game is paused or showing a panel.
  // jingle: stops every other sound first, so it is never crowded.
  const SOUNDS = {
    // --- interface
    confirm: { priority: 3, ui: true, voices: [tri(660, 0, 0.06), sq(990, 0.055, 0.09, { g: 0.16 }), tri(990, 0.055, 0.09)] },
    pause: { priority: 3, ui: true, voices: [tri(520, 0, 0.07, { to: 430 })] },
    resume: { priority: 3, ui: true, voices: [tri(430, 0, 0.07, { to: 540 })] },

    // --- movement
    jump: { priority: 2, throttle: 0.06, voices: [sq(270, 0, 0.13, { to: 540, g: 0.15 }), tri(135, 0, 0.11, { to: 270, g: 0.3 })] },
    land: { priority: 1, throttle: 0.12, voices: [noise(0, 0.05, { g: 0.16, cut: 420 }), tri(105, 0, 0.05, { to: 78, g: 0.25 })] },
    stomp: { priority: 3, voices: [tri(170, 0, 0.1, { to: 430, g: 0.5 }), sq(690, 0.04, 0.07, { to: 930, g: 0.14 }), noise(0, 0.035, { g: 0.2, cut: 900 })] },

    // --- pickups
    ember: { priority: 1, throttle: 0.055, voices: [tri(1420, 0, 0.055, { to: 1900, g: 0.3 }), sq(1420, 0, 0.03, { g: 0.07 })] },
    spark: { priority: 4, voices: [
      ...run(tri, 0, [[523, 0.055], [659, 0.055], [784, 0.055], [1175, 0.17]]),
      ...run(sq, 0, [[523, 0.055], [659, 0.055], [784, 0.055], [1175, 0.14]], { g: 0.1 }),
      noise(0.16, 0.14, { g: 0.07, filter: 'highpass', cut: 5200 }),
    ] },
    heart: { priority: 4, voices: [...run(tri, 0, [[440, 0.09], [554, 0.09], [659, 0.2]], { g: 0.36, attack: 0.02 })] },
    shieldGet: { priority: 4, voices: [sq(880, 0, 0.2, { to: 1100, g: 0.1 }), tri(1320, 0, 0.22, { to: 1650, g: 0.3 }), noise(0, 0.08, { g: 0.06, filter: 'highpass', cut: 6000 })] },
    shieldBreak: { priority: 6, voices: [noise(0, 0.09, { g: 0.3, filter: 'highpass', cut: 2600 }), sq(1250, 0, 0.1, { to: 480, g: 0.14 }), tri(300, 0.03, 0.08, { to: 190, g: 0.3 })] },
    checkpoint: { priority: 5, voices: [
      ...run(tri, 0, [[392, 0.11], [587, 0.11], [784, 0.2]]),
      ...run(sq, 0, [[392, 0.11], [587, 0.11], [784, 0.16]], { g: 0.09 }),
    ] },

    // --- danger
    hurt: { priority: 7, voices: [sq(340, 0, 0.24, { to: 130, g: 0.2 }), tri(170, 0, 0.24, { to: 65, g: 0.4 }), noise(0, 0.12, { g: 0.22, filter: 'bandpass', cut: 900 })] },
    pit: { priority: 7, voices: [sq(430, 0, 0.36, { to: 105, g: 0.16 }), tri(215, 0, 0.36, { to: 52, g: 0.4 })] },
    warning: { priority: 6, throttle: 0.25, voices: [sq(740, 0, 0.07, { g: 0.13 }), tri(740, 0, 0.07, { g: 0.3 }), sq(740, 0.12, 0.07, { g: 0.13 }), tri(740, 0.12, 0.07, { g: 0.3 })] },
    meteorFall: { priority: 3, voices: [noise(0, 0.5, { g: 0.13, filter: 'bandpass', cut: 2600, cutTo: 500, q: 2.5, attack: 0.12 }), tri(900, 0.05, 0.45, { to: 210, g: 0.12, attack: 0.1 })] },
    impact: { priority: 4, voices: [tri(125, 0, 0.3, { to: 44, g: 0.6 }), noise(0, 0.26, { g: 0.3, cut: 700, cutTo: 180 })] },

    // --- jingles
    levelClear: { priority: 9, ui: true, jingle: true, voices: [
      ...run(sq, 0, [[440, 0.1], [554, 0.1], [659, 0.1], [740, 0.1], [988, 0.13], [880, 0.42]], { g: 0.15 }),
      ...run(tri, 0, [[220, 0.2], [277, 0.2], [247, 0.13], [220, 0.42]], { g: 0.38 }),
    ] },
    complete: { priority: 10, ui: true, jingle: true, voices: [
      ...run(sq, 0, [[392, 0.12], [494, 0.12], [587, 0.12], [784, 0.24], [880, 0.12], [740, 0.12], [587, 0.12], [880, 0.24], [988, 0.14], [1175, 0.62]], { g: 0.14 }),
      ...run(tri, 0, [[196, 0.24], [247, 0.36], [220, 0.24], [294, 0.36], [247, 0.14], [196, 0.62]], { g: 0.38 }),
      noise(1.34, 0.5, { g: 0.05, filter: 'highpass', cut: 5600, attack: 0.05 }),
    ] },
    gameover: { priority: 9, ui: true, jingle: true, voices: [
      ...run(tri, 0, [[494, 0.16], [440, 0.16], [370, 0.16], [294, 0.2]], { g: 0.4 }),
      ...run(sq, 0, [[494, 0.16], [440, 0.16], [370, 0.16], [294, 0.2]], { g: 0.08 }),
      tri(220, 0.68, 0.4, { to: 185, g: 0.4 }),
    ] },
  };
  for (const [name, def] of Object.entries(SOUNDS)) {
    def.name = name;
    def.duration = Math.max(...def.voices.map((v) => v.t + v.d)) + 0.03;
  }

  // ---------------------------------------------------------------- settings
  const settings = { volume: CONFIG.defaultVolume, muted: false };
  try {
    const saved = JSON.parse(root.localStorage.getItem(CONFIG.storageKey) || 'null');
    if (saved && typeof saved.volume === 'number') settings.volume = Math.max(0, Math.min(1, saved.volume));
    if (saved && typeof saved.muted === 'boolean') settings.muted = saved.muted;
  } catch (e) { /* storage unavailable: defaults are fine */ }
  const save = () => {
    try { root.localStorage.setItem(CONFIG.storageKey, JSON.stringify(settings)); } catch (e) { /* ignore */ }
  };
  const audible = () => !settings.muted && settings.volume > 0;
  // perceived loudness is closer to the square of the slider position
  const outputGain = () => (audible() ? settings.volume * settings.volume * 1.6 : 0);

  // ------------------------------------------------------------------ engine
  let ctx = null;          // the one shared AudioContext, created on the first user gesture
  let master = null;
  let noiseBuffer = null;
  let failed = false;      // audio could not be started: stay silent, never throw
  let blocked = false;     // game paused or in the background: only ui sounds may start
  let masterLevel = 0;     // the output level last requested
  let resuming = false;    // resume() requested by a user gesture and not settled yet
  let active = [];         // sounds currently scheduled or ringing
  const lastPlayed = {};
  const listeners = new Set();
  const stats = {
    contexts: 0, nodesStarted: 0, nodesEnded: 0, stopAlls: 0,
    requested: {}, played: {}, skipped: { locked: 0, muted: 0, blocked: 0, throttled: 0, crowded: 0 },
  };

  // Deterministic noise (no Math.random) so sounds never touch any random stream.
  function makeNoiseBuffer(c) {
    const buffer = c.createBuffer(1, c.sampleRate, c.sampleRate);
    const data = buffer.getChannelData(0);
    let seed = 0x2f6e2b1;
    for (let i = 0; i < data.length; i++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) | 0;
      data[i] = (seed >>> 8) / 8388608 - 1;
    }
    return buffer;
  }

  // Builds one sound into `dest`, starting at time t0. Returns its source nodes.
  function build(c, dest, buffer, def, t0, onNodeEnd) {
    const sources = [];
    for (const v of def.voices) {
      const start = t0 + v.t;
      const end = start + v.d;
      const attack = Math.min(v.attack || 0.006, v.d * 0.4);
      const release = Math.min(0.05, v.d * 0.5);
      const env = c.createGain();
      // smooth in and out: no clicks at either end
      env.gain.setValueAtTime(0, start);
      env.gain.linearRampToValueAtTime(v.g, start + attack);
      env.gain.setValueAtTime(v.g, end - release);
      env.gain.linearRampToValueAtTime(0, end);

      let src;
      let tail = env;
      if (v.wave === 'noise') {
        src = c.createBufferSource();
        src.buffer = buffer;
        src.loop = true;
        const filter = c.createBiquadFilter();
        filter.type = v.filter;
        filter.Q.value = v.q || 0.8;
        filter.frequency.setValueAtTime(v.cut, start);
        if (v.cutTo) filter.frequency.exponentialRampToValueAtTime(v.cutTo, end);
        src.connect(filter);
        filter.connect(env);
        tail = filter;
      } else {
        src = c.createOscillator();
        src.type = v.wave;
        src.frequency.setValueAtTime(v.f, start);
        if (v.to) src.frequency.exponentialRampToValueAtTime(v.to, end);
        src.connect(env);
      }
      env.connect(dest);
      src.onended = () => {
        try { src.disconnect(); tail.disconnect(); env.disconnect(); } catch (e) { /* already gone */ }
        if (onNodeEnd) onNodeEnd();
      };
      src.start(start);
      src.stop(end + 0.02);
      sources.push(src);
    }
    return sources;
  }

  function ensureContext() {
    if (ctx || failed) return;
    try {
      const AC = root.AudioContext || root.webkitAudioContext;
      if (!AC) throw new Error('Web Audio unavailable');
      ctx = new AC();
      stats.contexts += 1;
      master = ctx.createGain();
      master.gain.value = outputGain();
      masterLevel = outputGain();
      // light compression keeps overlapping sounds from clipping
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -14;
      comp.knee.value = 12;
      comp.ratio.value = 6;
      comp.attack.value = 0.003;
      comp.release.value = 0.12;
      master.connect(comp);
      comp.connect(ctx.destination);
      master.output = comp;
      noiseBuffer = makeNoiseBuffer(ctx);
    } catch (e) {
      failed = true;
      ctx = null;
    }
  }

  const SuperAudio = {
    // Call from a real click or key press. Creates / resumes the shared context.
    unlock() {
      try {
        ensureContext();
        if (ctx && ctx.state === 'suspended' && !document.hidden) {
          resuming = true;
          const p = ctx.resume();
          if (p && p.then) p.then(() => { resuming = false; }, () => { resuming = false; /* still locked: stay silent */ });
          else resuming = false;
        }
      } catch (e) { failed = true; }
    },

    // Plays a sound by name. Never throws; returns true if it was scheduled.
    play(name, opts = {}) {
      try {
        const def = SOUNDS[name];
        if (!def) return false;
        stats.requested[name] = (stats.requested[name] || 0) + 1;
        // a context that is just being resumed by this very gesture may already be scheduled on
        if (!ctx || failed || (ctx.state !== 'running' && !resuming)) { stats.skipped.locked += 1; return false; }
        if (blocked && !def.ui) { stats.skipped.blocked += 1; return false; }
        if (!audible()) { stats.skipped.muted += 1; return false; }
        const now = ctx.currentTime;
        if (def.throttle && lastPlayed[name] !== undefined && now - lastPlayed[name] < def.throttle) { stats.skipped.throttled += 1; return false; }

        active = active.filter((s) => s.end > now);
        if (def.jingle && !opts.keep) this.stopAll();
        if (active.length >= CONFIG.maxSounds) {
          // the least important (then oldest) sound gives way, unless that is the new one
          const weakest = active.reduce((a, b) => (b.priority < a.priority || (b.priority === a.priority && b.start < a.start) ? b : a));
          if (weakest.priority > def.priority) { stats.skipped.crowded += 1; return false; }
          stopSound(weakest, now);
          active = active.filter((s) => s !== weakest);
        }

        const t0 = now + 0.005 + (opts.delay || 0);
        const bus = ctx.createGain();
        bus.connect(master);
        const sound = { name, priority: def.priority, start: t0, end: t0 + def.duration, bus, sources: [], pending: 0 };
        sound.sources = build(ctx, bus, noiseBuffer, def, t0, () => {
          stats.nodesEnded += 1;
          sound.pending -= 1;
          if (sound.pending <= 0) { try { bus.disconnect(); } catch (e) { /* gone */ } }
        });
        sound.pending = sound.sources.length;
        stats.nodesStarted += sound.sources.length;
        active.push(sound);
        lastPlayed[name] = now;
        stats.played[name] = (stats.played[name] || 0) + 1;
        return true;
      } catch (e) {
        return false; // a sound must never break the game
      }
    },

    // Fades out and cancels everything, including notes scheduled for later.
    stopAll() {
      try {
        if (!ctx) return;
        stats.stopAlls += 1;
        const now = ctx.currentTime;
        for (const s of active) stopSound(s, now);
        active = [];
      } catch (e) { /* ignore */ }
    },

    // Game paused / panel up: stop what is ringing and let only ui sounds start.
    setBlocked(value) {
      blocked = !!value;
      if (blocked) this.stopAll();
    },

    // Tab in the background: silence and suspend so nothing can sound.
    setHidden(hidden) {
      try {
        if (!ctx) return;
        if (hidden) {
          this.stopAll();
          // let the short fade finish, then suspend so nothing can sound in the background
          root.setTimeout(() => {
            try {
              if (!document.hidden) return;
              const p = ctx.suspend();
              if (p && p.catch) p.catch(() => {});
            } catch (e) { /* ignore */ }
          }, 80);
        }
        // coming back: the context resumes on the player's next key press or click
      } catch (e) { /* ignore */ }
    },

    setVolume(value) {
      settings.volume = Math.max(0, Math.min(1, Number(value) || 0));
      if (settings.volume > 0) settings.muted = false;
      apply();
    },
    setMuted(value) {
      settings.muted = !!value;
      // un-muting at zero volume would still be silent: go back to the default level
      if (!settings.muted && settings.volume === 0) settings.volume = CONFIG.defaultVolume;
      apply();
    },
    toggleMute() { this.setMuted(audible()); },
    getSettings: () => ({ volume: settings.volume, muted: settings.muted, audible: audible() }),
    onChange(fn) { listeners.add(fn); },

    // ---- read-only helpers for tests and tuning
    names: () => Object.keys(SOUNDS),
    describe: (name) => ({ priority: SOUNDS[name].priority, duration: SOUNDS[name].duration, throttle: SOUNDS[name].throttle || 0, ui: !!SOUNDS[name].ui, jingle: !!SOUNDS[name].jingle, voices: SOUNDS[name].voices.length }),
    stats: () => ({
      ...JSON.parse(JSON.stringify(stats)),
      state: failed ? 'failed' : ctx ? ctx.state : 'not-created',
      activeSounds: ctx ? active.filter((s) => s.end > ctx.currentTime).length : 0,
      liveNodes: stats.nodesStarted - stats.nodesEnded,
      blocked,
      outputGain: master ? masterLevel : 0,
      config: { ...CONFIG },
    }),
    // Renders one sound offline with the same synthesis code (for inspection or export).
    render(name, sampleRate = 44100) {
      const def = SOUNDS[name];
      const OAC = root.OfflineAudioContext || root.webkitOfflineAudioContext;
      const off = new OAC(1, Math.ceil((def.duration + 0.05) * sampleRate), sampleRate);
      build(off, off.destination, makeNoiseBuffer(off), def, 0.005, null);
      return off.startRendering().then((buf) => Array.from(buf.getChannelData(0)));
    },
    // A stream of the game's actual output, for recording a play session.
    captureStream() {
      ensureContext();
      if (!ctx) return null;
      const dest = ctx.createMediaStreamDestination();
      master.output.connect(dest);
      return dest.stream;
    },
  };

  function stopSound(sound, now) {
    try {
      sound.bus.gain.cancelScheduledValues(now);
      sound.bus.gain.setValueAtTime(sound.bus.gain.value, now);
      sound.bus.gain.linearRampToValueAtTime(0, now + CONFIG.fadeSeconds);
      for (const src of sound.sources) {
        try { src.stop(now + CONFIG.fadeSeconds + 0.01); } catch (e) { /* already stopped */ }
      }
    } catch (e) { /* ignore */ }
  }

  function apply() {
    save();
    try {
      if (master && ctx) {
        // short ramp from the level we last set: no zipper noise, no jump
        const now = ctx.currentTime;
        master.gain.cancelScheduledValues(now);
        master.gain.setValueAtTime(masterLevel, now);
        master.gain.linearRampToValueAtTime(outputGain(), now + 0.03);
      }
      masterLevel = outputGain();
    } catch (e) { /* ignore */ }
    for (const fn of listeners) {
      try { fn(SuperAudio.getSettings()); } catch (e) { /* ignore */ }
    }
  }

  root.SuperAudio = SuperAudio;
})(window);
