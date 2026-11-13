import * as core from '@strudel/core';
import * as mini from '@strudel/mini';
import * as tonal from '@strudel/tonal';
import * as webaudio from '@strudel/webaudio';
import { transpiler } from '@strudel/transpiler';
import { midiToNoteName } from './strudel-bridge.mjs';

const AUDIO_DEFAULT_SAMPLES_URL =
  'https://raw.githubusercontent.com/tidalcycles/Dirt-Samples/master/strudel.json';

/**
 * Replaces multiple non-overlapping source spans cleanly using right-to-left sorting.
 */
function applyMultiEdits(source, edits) {
  const sorted = [...edits].sort((a, b) => b.start - a.start || b.end - a.end);
  let out = source;
  for (const e of sorted) {
    out = out.slice(0, e.start) + e.replacement + out.slice(e.end);
  }
  return out;
}

/**
 * Computes the effective muted channel set taking FL Studio Solo exclusivity into account.
 */
export function resolveActiveChannelIds(channels, mutedIds, soloIds) {
  const hasSolo = soloIds && soloIds.size > 0;
  const active = new Set();
  for (const ch of channels) {
    if (hasSolo) {
      if (soloIds.has(ch.id)) active.add(ch.id);
    } else if (!mutedIds?.has(ch.id)) {
      active.add(ch.id);
    }
  }
  return active;
}

/**
 * Builds an audio-only Strudel source string reflecting live Mixer Mutes/Solos,
 * SONG vs PAT transport mode, seek bar offset, and loop boundaries without mutating user code.
 */
export function buildPlayableSource(source, analysis, options = {}) {
  const {
    mode = 'SONG',
    mutedIds = new Set(),
    soloIds = new Set(),
    seekBar = 0,
    loopRange = null,
    patBars = 1,
    hasCustomVocal = false,
  } = options;

  const activeSet = resolveActiveChannelIds(analysis.channels, mutedIds, soloIds);
  const edits = [];

  for (const ch of analysis.channels) {
    if (!activeSet.has(ch.id) && ch.exprRange) {
      edits.push({
        start: ch.exprRange[0],
        end: ch.exprRange[1],
        replacement: 'silence',
      });
    }
  }

  const totalBars = Math.max(1, analysis.totalBars || 1);
  const clampedSeek = Math.max(0, seekBar % totalBars);

  if (analysis.finalExprRange) {
    const [fStart, fEnd] = analysis.finalExprRange;
    const origFinal = source.slice(fStart, fEnd).trim();

    if (mode === 'PAT') {
      const hasExplicitVocalSolo = [...soloIds].some((id) =>
        analysis.channels.find((c) => c.id === id)?.isVocal,
      );
      const patChannels = analysis.channels.filter(
        (ch) => activeSet.has(ch.id) && (!ch.isVocal || hasExplicitVocalSolo) && !ch.isLabel,
      );
      const stackExpr = patChannels.length
        ? patChannels.length === 1
          ? patChannels[0].id
          : `stack(${patChannels.map((c) => c.id).join(', ')})`
        : 'silence';
      const loopBars = Math.max(1, Math.round(patBars || 1));
      const postgain = analysis.masterPostgain ?? 0.86;
      const patFinal = `;\narrange([${loopBars}, ${stackExpr}]).postgain(${postgain})`;
      edits.push({ start: fStart, end: fEnd, replacement: patFinal });
    } else if (loopRange?.enabled && loopRange.end > loopRange.start) {
      const loopLen = Math.max(1, loopRange.end - loopRange.start);
      const subOffset =
        (((clampedSeek - loopRange.start) % loopLen) + loopLen) % loopLen;
      const looped =
        subOffset > 1e-4
          ? `;\narrange([${loopLen}, (${origFinal}).early(${loopRange.start})]).early(${subOffset})`
          : `;\narrange([${loopLen}, (${origFinal}).early(${loopRange.start})])`;
      edits.push({ start: fStart, end: fEnd, replacement: looped });
    } else if (clampedSeek > 1e-4) {
      edits.push({
        start: fStart,
        end: fEnd,
        replacement: `;\n(${origFinal}).early(${clampedSeek})`,
      });
    }
  }

  let result = applyMultiEdits(source, edits);
  if (hasCustomVocal) {
    result = result.replace(/\blet\s+vocalDisponible\s*=\s*false\b/, 'let vocalDisponible = true');
  }
  return result;
}

/**
 * Manages Strudel WebAudio initialization, hot-swappable transport playback,
 * real-time note auditioning, local vocal file loading, and master metering.
 */
export function createAudioEngine({ onToggle, onError } = {}) {
  let initialized = false;
  let initPromise = null;
  let replInstance = null;
  let analyser = null;
  let timeDomainData = null;
  let freqData = null;
  let samplesRequested = false;

  const failedAudioPaths = new Set();
  let customVocalUrl = null;
  let customVocalName = null;

  // Transport bookkeeping for accurate playhead position across seeks, pauses & loops
  let playing = false;
  let pausedBar = 0;
  let playOriginBar = 0;
  let activeLoopRange = null;
  let activeMode = 'SONG';
  let activeTotalBars = 1;
  let activePatBars = 1;
  let currentBpm = 157;

  function connectAnalyser() {
    try {
      const ctx = webaudio.getAudioContext();
      const ctrl = webaudio.getSuperdoughAudioController?.();
      if (!ctx || !ctrl?.output?.destinationGain) return;
      if (!analyser || analyser.context !== ctx) {
        analyser = ctx.createAnalyser();
        analyser.fftSize = 256;
        analyser.smoothingTimeConstant = 0.72;
        timeDomainData = new Uint8Array(analyser.fftSize);
        freqData = new Uint8Array(analyser.frequencyBinCount);
        ctrl.output.destinationGain.connect(analyser);
      }
    } catch {
      // Ignore analyser attachment issues until audio node exists
    }
  }

  async function ensureInitialized() {
    if (initialized) {
      const ctx = webaudio.getAudioContext();
      if (ctx?.state === 'suspended') {
        await ctx.resume();
      }
      connectAnalyser();
      return;
    }
    if (initPromise) return initPromise;

    initPromise = (async () => {
      await webaudio.initAudio({ maxPolyphony: 128 });
      webaudio.registerSynthSounds();

      // Safe wrapped loadBuffer/samples so failed local audio checks don't stall hot-swaps
      const origLoadBuffer = webaudio.loadBuffer;
      const origSamples = webaudio.samples;

      const safeLoadBuffer = async (url, ac, name, n = 0) => {
        if (customVocalUrl && (name === 'voz_norost' || String(url).includes('voz-norost'))) {
          return origLoadBuffer(customVocalUrl, ac, name, n);
        }
        if (failedAudioPaths.has(url)) {
          throw new Error(`Audio omitido tras fallo previo: ${url}`);
        }
        try {
          return await origLoadBuffer(url, ac, name, n);
        } catch (err) {
          if (typeof url === 'string' && !url.startsWith('blob:')) {
            failedAudioPaths.add(url);
          }
          throw err;
        }
      };

      const safeSamples = async (src, baseUrl, extra) => {
        if (
          customVocalUrl &&
          src &&
          typeof src === 'object' &&
          Object.prototype.hasOwnProperty.call(src, 'voz_norost')
        ) {
          return origSamples({ ...src, voz_norost: customVocalUrl }, baseUrl, extra);
        }
        return origSamples(src, baseUrl, extra);
      };

      await core.evalScope(
        core,
        mini,
        tonal,
        webaudio,
        {
          loadBuffer: safeLoadBuffer,
          samples: safeSamples,
        },
      );

      if (!samplesRequested) {
        samplesRequested = true;
        // Kick off Dirt drum sample bank non-blockingly so standard `bd`/`cp`/`hh` work online
        webaudio.samples(AUDIO_DEFAULT_SAMPLES_URL).catch(() => {});
      }

      replInstance = core.repl({
        onSchedule: webaudio.webaudioOutput,
        getTime: () => webaudio.getAudioContext().currentTime,
        transpiler,
        onToggle: (started) => {
          playing = Boolean(started);
          onToggle?.(playing);
        },
        onEvalError: (err) => {
          onError?.(err);
        },
        beforeEval: () => {
          webaudio.resetGlobalEffects?.();
        },
      });

      connectAnalyser();
      initialized = true;
    })();

    try {
      await initPromise;
    } catch (err) {
      initPromise = null;
      throw err;
    }
  }

  function updateTransportMeta(analysis, options) {
    currentBpm = analysis.bpm || currentBpm;
    activeTotalBars = Math.max(1, analysis.totalBars || 1);
    activeMode = options.mode ?? 'SONG';
    activeLoopRange = options.loopRange?.enabled ? { ...options.loopRange } : null;
    activePatBars = Math.max(1, options.patBars || 1);
  }

  async function startFromBar(source, analysis, options = {}, startBar = 0) {
    await ensureInitialized();
    updateTransportMeta(analysis, options);

    const playable = buildPlayableSource(source, analysis, {
      ...options,
      seekBar: startBar,
      hasCustomVocal: Boolean(customVocalUrl),
    });

    if (playing && replInstance) {
      replInstance.stop();
    }

    if (activeMode === 'SONG' && activeLoopRange && activeLoopRange.end > activeLoopRange.start) {
      const len = Math.max(1, activeLoopRange.end - activeLoopRange.start);
      const sub = (((startBar - activeLoopRange.start) % len) + len) % len;
      playOriginBar = activeLoopRange.start + sub;
    } else if (activeMode === 'PAT') {
      playOriginBar = 0;
    } else {
      playOriginBar = Math.max(0, startBar % activeTotalBars);
    }
    pausedBar = playOriginBar;

    try {
      await replInstance.evaluate(playable, true);
      connectAnalyser();
      playing = true;
      onToggle?.(true);
    } catch (err) {
      onError?.(err);
      throw err;
    }
  }

  async function hotSwap(source, analysis, options = {}) {
    if (!playing || !replInstance) return;
    await ensureInitialized();
    updateTransportMeta(analysis, options);

    // Keep exact phase alignment: compute the bar offset currently corresponding to scheduler c=0
    const schedNow = replInstance.scheduler?.now?.() ?? 0;
    const curBar = getCurrentBar();
    const effectiveZeroBar =
      activeMode === 'PAT'
        ? 0
        : ((curBar - schedNow) % activeTotalBars + activeTotalBars) % activeTotalBars;

    const playable = buildPlayableSource(source, analysis, {
      ...options,
      seekBar: effectiveZeroBar,
      hasCustomVocal: Boolean(customVocalUrl),
    });

    playOriginBar = effectiveZeroBar;

    try {
      await replInstance.evaluate(playable, false);
      connectAnalyser();
    } catch (err) {
      onError?.(err);
    }
  }

  function pause() {
    if (!replInstance) return;
    pausedBar = getCurrentBar();
    replInstance.stop();
    playing = false;
    onToggle?.(false);
  }

  function stop() {
    if (replInstance) {
      replInstance.stop();
    }
    playing = false;
    pausedBar = 0;
    playOriginBar = 0;
    onToggle?.(false);
  }

  function setPausedBar(bar) {
    pausedBar = Math.max(0, bar);
    playOriginBar = pausedBar;
  }

  function getCurrentBar() {
    if (!playing || !replInstance?.scheduler) {
      return pausedBar;
    }
    const now = replInstance.scheduler.now();
    if (now === undefined || now === null || Number.isNaN(now)) return playOriginBar;

    if (activeMode === 'PAT') {
      const len = Math.max(1, activePatBars);
      return ((now % len) + len) % len;
    }

    if (activeLoopRange && activeLoopRange.end > activeLoopRange.start) {
      const len = Math.max(1, activeLoopRange.end - activeLoopRange.start);
      const offsetWithinLoop =
        (((playOriginBar - activeLoopRange.start) % len) + len) % len;
      return activeLoopRange.start + ((offsetWithinLoop + now) % len);
    }

    return (playOriginBar + now) % Math.max(1, activeTotalBars);
  }

  function getAudioLevels() {
    if (!analyser || !timeDomainData || !playing) {
      return { rms: 0, peak: 0, bars: [0, 0, 0, 0, 0, 0] };
    }
    analyser.getByteTimeDomainData(timeDomainData);
    analyser.getByteFrequencyData(freqData);
    let sumSq = 0;
    let peak = 0;
    for (let i = 0; i < timeDomainData.length; i++) {
      const v = (timeDomainData[i] - 128) / 128;
      sumSq += v * v;
      if (Math.abs(v) > peak) peak = Math.abs(v);
    }
    const rms = Math.min(1, Math.sqrt(sumSq / timeDomainData.length) * 2.2);
    const step = Math.max(1, Math.floor(freqData.length / 6));
    const bars = [];
    for (let b = 0; b < 6; b++) {
      bars.push((freqData[b * step] ?? 0) / 255);
    }
    return { rms, peak: Math.min(1, peak * 1.3), bars };
  }

  /**
   * Auditions a single note or drum hit live when clicking Piano Roll keys or drawing notes.
   */
  async function previewNote(channel, midi = 60, duration = 0.28) {
    try {
      await ensureInitialized();
      const ctx = webaudio.getAudioContext();
      const t = ctx.currentTime + 0.015;
      const cps = (currentBpm || 132) / 240;

      if (channel?.kind === 'drum') {
        let sName =
          channel.params?.s?.value ||
          channel.stackLayers?.[0]?.sLit?.value ||
          channel.patternSource?.stringInfo?.value?.match(/[a-zA-Z_][a-zA-Z0-9_-]*/)?.[0] ||
          'bd';
        // Strip mini multipliers like `bombo_club*4` -> `bombo_club`
        sName = sName.split('*')[0].trim() || 'bd';
        if (sName === 'bombo_club' && channel.id === 'bombo') {
          // Synthesize punchy kick immediately even before script registerSound ran
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.frequency.setValueAtTime(180, t);
          osc.frequency.exponentialRampToValueAtTime(44, t + 0.14);
          gain.gain.setValueAtTime(0.65, t);
          gain.gain.exponentialRampToValueAtTime(0.001, t + 0.19);
          osc.connect(gain).connect(webaudio.getSuperdoughAudioController().output.destinationGain);
          osc.start(t);
          osc.stop(t + 0.2);
          return;
        }
        webaudio.superdough(
          {
            s: sName === 'x' ? 'bd' : sName,
            gain: Math.min(0.85, channel?.effectiveGain ?? 0.65),
            hpf: channel?.params?.hpf?.numericValue,
            lpf: channel?.params?.lpf?.numericValue,
            decay: 0.12,
          },
          t,
          Math.min(0.22, duration),
          cps,
        );
        return;
      }

      const soundName =
        channel?.params?.s?.value ||
        channel?.params?.sound?.value ||
        (channel?.callsHelper === 'sierra' ? 'sawtooth' : 'triangle');

      webaudio.superdough(
        {
          note: midiToNoteName(midi),
          s: soundName,
          gain: Math.min(0.7, (channel?.effectiveGain ?? 0.5) * 0.8),
          lpf: channel?.params?.lpf?.numericValue ?? 3200,
          hpf: channel?.params?.hpf?.numericValue,
          attack: channel?.params?.attack?.numericValue ?? 0.01,
          decay: channel?.params?.decay?.numericValue ?? 0.18,
          sustain: channel?.params?.sustain?.numericValue ?? 0.45,
          release: channel?.params?.release?.numericValue ?? 0.15,
          room: channel?.params?.room?.numericValue ?? 0.15,
        },
        t,
        duration,
        cps,
      );
    } catch {
      // Auditioning should never break UI drag interactions
    }
  }

  /**
   * Loads a user-selected vocal audio file (.wav, .mp3, .ogg) into Superdough as `voz_norost`.
   */
  async function loadCustomVocalFile(file) {
    await ensureInitialized();
    if (customVocalUrl) {
      URL.revokeObjectURL(customVocalUrl);
    }
    const url = URL.createObjectURL(file);
    customVocalUrl = url;
    customVocalName = file.name;
    await webaudio.loadBuffer(url, webaudio.getAudioContext(), 'voz_norost', 0);
    await webaudio.samples({ voz_norost: url });
    return customVocalName;
  }

  return {
    ensureInitialized,
    startFromBar,
    hotSwap,
    pause,
    stop,
    setPausedBar,
    getCurrentBar,
    getAudioLevels,
    previewNote,
    loadCustomVocalFile,
    isPlaying: () => playing,
    getPausedBar: () => pausedBar,
    getCustomVocalName: () => customVocalName,
    getBpm: () => currentBpm,
  };
}
