/*
 * Genesis Stage sound — restrained, synthesized cues that follow the orb.
 *
 * Everything is generated with the Web Audio API (no audio files): a soft
 * tonal bed that only sounds while the orb speaks, plus short glassy event
 * cues on one D-major pentatonic palette. Silence is true silence: there is no
 * always-on drone or noise layer, so nothing hums between lines. The whole bus runs through a
 * generated reverb, a low-pass and a compressor at a low master level.
 *
 * window.createGenesisSound({ context?, enabled? }) → engine:
 *   cue(name, { delay?, at?, ...params })  schedule one event cue
 *   frame({ speech, glow })                per-frame ambient modulation
 *   setEnabled(on, { immediate? })          mute / unmute with a short fade
 *   resume() / suspend() / fadeOut(seconds) / dispose()
 * A missing Web Audio implementation yields a silent no-op engine.
 */
(() => {
  const SCALE = [0, 2, 4, 7, 9];
  const ROOT = 146.83; // D3
  const note = (degree, octave = 0) => {
    const index = ((degree % 5) + 5) % 5;
    const lift = Math.floor(degree / 5) + octave;
    return ROOT * Math.pow(2, (SCALE[index] + 12 * lift) / 12);
  };
  const FLOOR = 0.0001;
  // Speech envelope below which the bed is fully silent.
  const BED_GATE = 0.06;

  // Minimum gap between two cues of the same name (seconds).
  const THROTTLE = {
    'drop-wait': 1.15, segment: 0.35, cue: 0.22, engrave: 0.09, pin: 0.3, node: 0.18, packet: 0.7, evolve: 1.2, chapter: 1.5, morph: 0.5,
  };

  const silent = () => ({
    cue() {}, frame() {}, setEnabled() {}, setBed() {}, resume() {}, suspend() {}, fadeOut() {}, dispose() {},
    isEnabled: () => false, getContext: () => null, cueNames: () => [], stats: () => ({ voices: 0 }),
  });

  window.createGenesisSound = function createGenesisSound(options = {}) {
    const Context = window.AudioContext || window.webkitAudioContext;
    let ctx = options.context || null;
    try {
      if (!ctx && Context) ctx = new Context({ latencyHint: 'interactive' });
    } catch {
      ctx = null;
    }
    if (!ctx) return silent();

    let enabled = options.enabled !== false;
    let disposed = false;
    let voices = 0;
    const lastAt = new Map();

    // ── master bus ──────────────────────────────────────────────────────
    const master = ctx.createGain();
    master.gain.value = enabled && options.immediate ? 1 : 0;
    const compressor = ctx.createDynamicsCompressor();
    compressor.threshold.value = -26;
    compressor.knee.value = 16;
    compressor.ratio.value = 3.2;
    compressor.attack.value = 0.008;
    compressor.release.value = 0.3;
    const tone = ctx.createBiquadFilter();
    tone.type = 'lowpass';
    tone.frequency.value = 6800;
    tone.Q.value = 0.4;
    const bus = ctx.createGain();
    bus.gain.value = 0.9;
    const dry = ctx.createGain();
    dry.gain.value = 0.82;
    const wet = ctx.createGain();
    wet.gain.value = 0.3;
    const reverb = ctx.createConvolver();
    reverb.buffer = impulse(2.8, 2.6);
    bus.connect(dry);
    bus.connect(reverb);
    reverb.connect(wet);
    dry.connect(tone);
    wet.connect(tone);
    tone.connect(compressor);
    compressor.connect(master);
    master.connect(ctx.destination);

    const noise = ctx.createBuffer(1, Math.max(1, Math.floor(ctx.sampleRate * 2)), ctx.sampleRate);
    const noiseData = noise.getChannelData(0);
    for (let index = 0; index < noiseData.length; index += 1) noiseData[index] = Math.random() * 2 - 1;

    function impulse(seconds, decay) {
      const length = Math.max(1, Math.floor(ctx.sampleRate * seconds));
      const buffer = ctx.createBuffer(2, length, ctx.sampleRate);
      for (let channel = 0; channel < 2; channel += 1) {
        const data = buffer.getChannelData(channel);
        const preDelay = Math.floor(ctx.sampleRate * 0.018);
        for (let index = preDelay; index < length; index += 1) {
          data[index] = (Math.random() * 2 - 1) * Math.pow(1 - index / length, decay);
        }
      }
      return buffer;
    }

    // ── speech bed (sounds only while the orb speaks) ──────────────────
    // The bed used to idle at a constant level with a looping band-passed
    // noise "air" layer on top; through laptop speakers that read as a
    // permanent hum + hiss floor between lines. The bed is now gated by the
    // speech envelope alone (zero output at rest) and the noise layer is gone
    // — whooshes keep their own one-shot noise sources.
    const bedFilter = ctx.createBiquadFilter();
    bedFilter.type = 'lowpass';
    bedFilter.frequency.value = 260;
    bedFilter.Q.value = 0.7;
    const bedGain = ctx.createGain();
    bedGain.gain.value = 0;
    bedFilter.connect(bedGain);
    bedGain.connect(bus);
    const bedOscillators = [
      { type: 'sine', freq: note(0, -1), level: 0.5, detune: 0 },
      { type: 'sine', freq: note(3, -1), level: 0.3, detune: 4 },
      { type: 'triangle', freq: note(0, 0), level: 0.1, detune: -3 },
    ].map((spec) => {
      const osc = ctx.createOscillator();
      osc.type = spec.type;
      osc.frequency.value = spec.freq;
      osc.detune.value = spec.detune;
      const gain = ctx.createGain();
      gain.gain.value = spec.level;
      osc.connect(gain);
      gain.connect(bedFilter);
      osc.start();
      return osc;
    });
    let bedLevel = 0;

    // ── voices ─────────────────────────────────────────────────────────
    const track = (node, stopAt) => {
      voices += 1;
      node.onended = () => { voices = Math.max(0, voices - 1); };
      node.stop(stopAt);
    };

    // Every envelope starts from a zero initial value: AudioParams default to
    // 1, and a source starting at `at` can otherwise slip a few full-gain
    // samples out ahead of the first automation event (an audible click).
    function envelope(param, at, peak, attack, decay) {
      param.value = 0;
      param.setValueAtTime(FLOOR, at);
      param.exponentialRampToValueAtTime(Math.max(FLOOR, peak), at + attack);
      param.exponentialRampToValueAtTime(FLOOR, at + attack + decay);
    }

    /** Glassy FM bell: the modulation index falls faster than the body. */
    function bell(freq, at, { gain = 0.05, decay = 2.2, metal = 1 } = {}) {
      const carrier = ctx.createOscillator();
      carrier.type = 'sine';
      carrier.frequency.value = freq;
      const modulator = ctx.createOscillator();
      modulator.type = 'sine';
      modulator.frequency.value = freq * 3.5;
      const index = ctx.createGain();
      envelope(index.gain, at, freq * 1.1 * metal, 0.004, decay * 0.35);
      modulator.connect(index);
      index.connect(carrier.frequency);
      const partial = ctx.createOscillator();
      partial.type = 'sine';
      partial.frequency.value = freq * 2.76;
      const partialGain = ctx.createGain();
      envelope(partialGain.gain, at, gain * 0.18, 0.004, decay * 0.4);
      const body = ctx.createGain();
      envelope(body.gain, at, gain, 0.006, decay);
      carrier.connect(body);
      partial.connect(partialGain);
      partialGain.connect(bus);
      body.connect(bus);
      const end = at + decay + 0.1;
      [carrier, modulator, partial].forEach((osc) => osc.start(at));
      track(carrier, end);
      modulator.stop(end);
      partial.stop(end);
    }

    /** Soft swelling pad (detuned triangles through an opening low-pass). */
    function pad(freqs, at, { gain = 0.04, attack = 0.8, hold = 0.6, release = 2, bright = 1400 } = {}) {
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.Q.value = 0.5;
      filter.frequency.setValueAtTime(220, at);
      filter.frequency.linearRampToValueAtTime(bright, at + attack);
      filter.frequency.linearRampToValueAtTime(300, at + attack + hold + release);
      const level = ctx.createGain();
      level.gain.value = 0;
      level.gain.setValueAtTime(FLOOR, at);
      level.gain.linearRampToValueAtTime(gain, at + attack);
      level.gain.setValueAtTime(gain, at + attack + hold);
      level.gain.exponentialRampToValueAtTime(FLOOR, at + attack + hold + release);
      filter.connect(level);
      level.connect(bus);
      const end = at + attack + hold + release + 0.1;
      freqs.forEach((freq, index) => {
        for (const detune of [-6, 6]) {
          const osc = ctx.createOscillator();
          osc.type = 'triangle';
          osc.frequency.value = freq;
          osc.detune.value = detune + index * 1.5;
          const voice = ctx.createGain();
          voice.gain.value = 1 / (freqs.length * 2);
          osc.connect(voice);
          voice.connect(filter);
          osc.start(at);
          track(osc, end);
        }
      });
    }

    /** Filtered noise sweep (air, light, motion). */
    function whoosh(at, { dur = 0.8, from = 400, to = 3200, gain = 0.03, q = 0.9 } = {}) {
      const source = ctx.createBufferSource();
      source.buffer = noise;
      source.loop = true;
      const filter = ctx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.Q.value = q;
      filter.frequency.setValueAtTime(from, at);
      filter.frequency.exponentialRampToValueAtTime(Math.max(40, to), at + dur);
      const level = ctx.createGain();
      level.gain.value = 0;
      level.gain.setValueAtTime(FLOOR, at);
      level.gain.exponentialRampToValueAtTime(gain, at + dur * 0.45);
      level.gain.exponentialRampToValueAtTime(FLOOR, at + dur);
      source.connect(filter);
      filter.connect(level);
      level.connect(bus);
      source.start(at, Math.random());
      track(source, at + dur + 0.05);
    }

    /** Soft low thump with a short pitch drop. */
    function thump(at, { freq = 52, gain = 0.12, decay = 0.6 } = {}) {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq * 2.2, at);
      osc.frequency.exponentialRampToValueAtTime(freq, at + 0.12);
      const level = ctx.createGain();
      envelope(level.gain, at, gain, 0.012, decay);
      osc.connect(level);
      level.connect(bus);
      osc.start(at);
      track(osc, at + decay + 0.1);
    }

    function blip(freq, at, { gain = 0.03, decay = 0.18, glideTo = 0 } = {}) {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, at);
      if (glideTo) osc.frequency.exponentialRampToValueAtTime(glideTo, at + decay * 0.8);
      const level = ctx.createGain();
      envelope(level.gain, at, gain, 0.004, decay);
      osc.connect(level);
      level.connect(bus);
      osc.start(at);
      track(osc, at + decay + 0.05);
    }

    function tick(at, gain = 0.006) {
      const source = ctx.createBufferSource();
      source.buffer = noise;
      const filter = ctx.createBiquadFilter();
      filter.type = 'highpass';
      filter.frequency.value = 5200;
      const level = ctx.createGain();
      envelope(level.gain, at, gain, 0.001, 0.03);
      source.connect(filter);
      filter.connect(level);
      level.connect(bus);
      source.start(at, Math.random());
      track(source, at + 0.06);
    }

    function riser(at, { dur = 2, gain = 0.025 } = {}) {
      whoosh(at, { dur, from: 220, to: 5200, gain, q: 0.5 });
      blip(note(0, 0), at + dur * 0.15, { gain: gain * 0.6, decay: dur * 0.8, glideTo: note(0, 2) });
    }

    // ── event cues ─────────────────────────────────────────────────────
    const CUE_TONES = {
      welcome: (at) => { bell(note(0, 1), at, { gain: 0.022, decay: 1.6 }); bell(note(2, 1), at + 0.09, { gain: 0.018, decay: 1.6 }); },
      internet: (at) => [0, 2, 4, 5].forEach((degree, index) => bell(note(degree, 1), at + index * 0.06, { gain: 0.012, decay: 1.2 })),
      chain: (at) => bell(note(4, 1), at, { gain: 0.02, decay: 1.9, metal: 2.2 }),
      name: (at) => { bell(note(0, 1), at, { gain: 0.022, decay: 2.2 }); bell(note(4, 1), at, { gain: 0.016, decay: 2.2 }); },
      collab: (at) => { bell(note(1, 1), at, { gain: 0.016, decay: 1.4 }); bell(note(3, 1), at + 0.12, { gain: 0.016, decay: 1.4 }); },
      learn: (at) => blip(note(2, 1), at, { gain: 0.016, decay: 0.5, glideTo: note(5, 1) }),
      create: (at) => [7, 9, 11].forEach((degree, index) => blip(note(degree, 0), at + index * 0.05, { gain: 0.01, decay: 0.22 })),
      memory: (at) => [0, 0.22, 0.44].forEach((offset, index) => bell(note(3, 1), at + offset, { gain: 0.016 / (index + 1), decay: 1.2 })),
    };

    let segmentStep = 0;

    const CUES = {
      'crt-dot': (at) => { blip(note(9, 1), at, { gain: 0.022, decay: 0.12 }); blip(note(9, 1), at + 0.11, { gain: 0.012, decay: 0.1 }); },
      'crt-line': (at) => { whoosh(at, { dur: 0.9, from: 320, to: 4200, gain: 0.03 }); bell(note(4, 2), at + 0.3, { gain: 0.01, decay: 1.4 }); },
      'crt-flash': (at) => { thump(at, { freq: 46, gain: 0.085, decay: 0.7 }); whoosh(at, { dur: 0.55, from: 2600, to: 500, gain: 0.022 }); },
      drop: (at) => { blip(note(7, 1), at, { gain: 0.03, decay: 0.16, glideTo: note(2, 1) }); bell(note(2, 2), at + 0.04, { gain: 0.012, decay: 1.1 }); },
      'drop-wait': (at) => blip(note(0, -1), at, { gain: 0.025, decay: 0.35 }),
      birth: (at) => {
        pad([note(0, -1), note(2, 0), note(4, 0)], at, { gain: 0.05, attack: 0.9, hold: 0.5, release: 2.4, bright: 1800 });
        bell(note(0, 1), at + 0.25, { gain: 0.03, decay: 2.6 });
        bell(note(4, 1), at + 0.45, { gain: 0.018, decay: 2.4 });
        thump(at, { freq: 55, gain: 0.07, decay: 0.9 });
      },
      morph: (at, params) => {
        whoosh(at, { dur: 0.7, from: 900, to: 3400, gain: 0.018 });
        bell(note(params.degree ?? 2, 2), at + 0.15, { gain: 0.01, decay: 1.3 });
      },
      segment: (at) => {
        const degrees = [0, 2, 4, 2, 7, 4];
        bell(note(degrees[segmentStep % degrees.length], 1), at, { gain: 0.009, decay: 0.9 });
        segmentStep += 1;
      },
      cue: (at, params) => (CUE_TONES[params.kind] || CUE_TONES.welcome)(at),
      'invite-open': (at) => {
        whoosh(at, { dur: 0.6, from: 500, to: 2400, gain: 0.016 });
        bell(note(2, 1), at + 0.2, { gain: 0.016, decay: 1.4 });
        bell(note(4, 1), at + 0.34, { gain: 0.014, decay: 1.6 });
      },
      'invite-accept': (at) => [0, 2, 4].forEach((degree, index) => bell(note(degree, 1), at + index * 0.08, { gain: 0.02, decay: 1.5 })),
      'invite-later': (at) => [4, 2].forEach((degree, index) => bell(note(degree, 1), at + index * 0.1, { gain: 0.016, decay: 1.4 })),
      'naming-gather': (at) => riser(at, { dur: 1.3, gain: 0.016 }),
      'naming-reveal': (at) => {
        pad([note(0, 0), note(2, 0), note(4, 0)], at, { gain: 0.03, attack: 0.25, hold: 0.6, release: 2, bright: 2200 });
        [0, 2, 4].forEach((degree, index) => bell(note(degree, 1), at + index * 0.05, { gain: 0.018, decay: 2.4 }));
      },
      chapter: (at, params) => {
        const degree = [0, 2, 4, 1][params.index ?? 0] ?? 0;
        thump(at, { freq: 58, gain: 0.06, decay: 0.8 });
        whoosh(at, { dur: 0.9, from: 300, to: 2600, gain: 0.018 });
        bell(note(degree, 1), at + 0.18, { gain: 0.03, decay: 2.6 });
        bell(note(degree + 2, 1), at + 0.32, { gain: 0.014, decay: 2.2 });
      },
      engrave: (at) => tick(at, 0.0055),
      pin: (at) => blip(note(2, 1), at, { gain: 0.008, decay: 0.16, glideTo: note(7, 1) }),
      node: (at, params) => bell(note(params.degree ?? 4, 2), at, { gain: 0.007, decay: 0.8 }),
      packet: (at) => blip(note(3, 2), at, { gain: 0.006, decay: 0.12 }),
      warp: (at) => riser(at, { dur: 2.6, gain: 0.02 }),
      evolve: (at, params) => {
        const degree = params.degree ?? 0;
        pad([note(degree, -1), note(degree + 2, 0), note(degree + 4, 0)], at, { gain: 0.026, attack: 0.18, hold: 0.3, release: 1.6, bright: 2400 });
        bell(note(degree, 1), at, { gain: 0.016, decay: 1.8 });
      },
      finale: (at) => {
        pad([note(0, -1), note(4, -1), note(1, 0), note(3, 0)], at, { gain: 0.045, attack: 1.1, hold: 0.8, release: 3, bright: 1600 });
        bell(note(0, 1), at + 0.4, { gain: 0.02, decay: 3 });
      },
      settle: (at) => bell(note(4, 0), at, { gain: 0.014, decay: 2 }),
      handoff: (at) => {
        whoosh(at, { dur: 1, from: 3200, to: 320, gain: 0.022 });
        thump(at + 0.95, { freq: 50, gain: 0.05, decay: 0.6 });
        bell(note(0, 1), at + 0.95, { gain: 0.012, decay: 1.6 });
      },
    };

    function cue(name, params = {}) {
      if (disposed || !enabled) return;
      const build = CUES[name];
      if (!build) return;
      const now = ctx.currentTime;
      const at = Number.isFinite(params.at) ? params.at : now + Math.max(0, Number(params.delay) || 0) + 0.01;
      const gate = THROTTLE[name];
      const key = name === 'cue' ? `cue:${params.kind}` : name;
      if (gate) {
        const previous = lastAt.get(key);
        if (previous !== undefined && at - previous < gate) return;
        if (name === 'cue') {
          const anyCue = lastAt.get('cue:any');
          if (anyCue !== undefined && at - anyCue < THROTTLE.cue) return;
          lastAt.set('cue:any', at);
        }
        lastAt.set(key, at);
      }
      try {
        build(at, params);
      } catch {
        // A cue must never break the stage.
      }
    }

    function frame(input = {}) {
      if (disposed) return;
      const speech = Math.max(0, Math.min(1, Number(input.speech) || 0));
      const glow = Math.max(0, Math.min(1, Number(input.glow) || 0));
      const now = Number.isFinite(input.at) ? input.at : ctx.currentTime;
      // Below the gate the bed is exactly silent; above it the level follows
      // the speech envelope only (glow merely colors the filter).
      const voiced = speech < BED_GATE ? 0 : (speech - BED_GATE) / (1 - BED_GATE);
      bedFilter.frequency.setTargetAtTime(240 + speech * 760 + glow * 380, now, 0.12);
      bedGain.gain.setTargetAtTime(bedLevel * voiced * 0.022, now, voiced > 0 ? 0.12 : 0.25);
    }

    function setEnabled(on, opts = {}) {
      if (disposed) return;
      enabled = Boolean(on);
      const now = ctx.currentTime;
      master.gain.cancelScheduledValues(now);
      if (opts.immediate) master.gain.setValueAtTime(enabled ? 1 : 0, now);
      else master.gain.setTargetAtTime(enabled ? 1 : 0, now, 0.18);
      if (enabled) resume();
    }

    function setBed(level) {
      bedLevel = Math.max(0, Math.min(1, level));
    }

    function resume() {
      if (disposed || ctx.state !== 'suspended' || typeof ctx.resume !== 'function') return;
      ctx.resume().catch(() => {});
    }

    function suspend() {
      if (disposed || ctx.state !== 'running' || typeof ctx.suspend !== 'function') return;
      ctx.suspend().catch(() => {});
    }

    function fadeOut(seconds = 1.2) {
      if (disposed) return;
      const now = ctx.currentTime;
      master.gain.cancelScheduledValues(now);
      master.gain.setTargetAtTime(0, now, Math.max(0.05, seconds / 4));
      enabled = false;
    }

    function dispose() {
      if (disposed) return;
      disposed = true;
      try { bedOscillators.forEach((osc) => osc.stop()); } catch { /* already stopped */ }
      if (!options.context && typeof ctx.close === 'function') ctx.close().catch(() => {});
    }

    if (enabled) setEnabled(true, { immediate: options.immediate === true });

    return {
      cue,
      frame,
      setEnabled,
      setBed,
      resume,
      suspend,
      fadeOut,
      dispose,
      isEnabled: () => enabled,
      getContext: () => ctx,
      cueNames: () => Object.keys(CUES),
      stats: () => ({ voices, state: ctx.state }),
    };
  };
})();
