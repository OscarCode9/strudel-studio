import { CHANNEL_PRESETS } from './strudel-bridge.mjs';
import { clamp, escapeAttr, escapeHtml } from './ui-utils.mjs';

const SYNTH_SOUNDS = ['sawtooth', 'triangle', 'square', 'supersaw', 'sine', 'piano'];
const DRUM_SOUNDS = ['bd', 'cp', 'hh', 'oh', 'sd', 'rim', 'white'];

/**
 * Generates an inline mini Piano Roll contour preview across 1 bar (16 steps) for melodic channels.
 */
function buildMelodicStripSvg(notes, barPage, totalCycles) {
  const start = barPage % Math.max(1, totalCycles || 1);
  const inBar = (notes || []).filter((n) => n.start >= start - 1e-4 && n.start < start + 1 - 1e-4);
  if (!inBar.length) {
    return `<svg class="cr-mini-pr-svg" viewBox="0 0 160 26" preserveAspectRatio="none" aria-hidden="true">
      <line x1="0" y1="13" x2="160" y2="13" stroke="currentColor" stroke-opacity="0.2" stroke-dasharray="3 3"/>
    </svg>`;
  }
  let minMidi = 127;
  let maxMidi = 0;
  for (const n of inBar) {
    if (n.midi < minMidi) minMidi = n.midi;
    if (n.midi > maxMidi) maxMidi = n.midi;
  }
  const span = Math.max(6, maxMidi - minMidi);
  const rects = inBar.map((n) => {
    const x = Math.max(0, Math.min(156, (n.start - start) * 160));
    const w = Math.max(4, Math.min(160 - x, n.duration * 160));
    const y = 21 - ((n.midi - minMidi) / span) * 16 - 2;
    return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="3.2" rx="1" fill="currentColor" fill-opacity="0.9"/>`;
  });
  return `<svg class="cr-mini-pr-svg" viewBox="0 0 160 26" preserveAspectRatio="none" aria-hidden="true">${rects.join('')}</svg>`;
}

/**
 * Computes active step booleans [0..15] for a channel on `barPage`.
 */
function computeChannelStepMask(ch, channelEval, barPage) {
  const mask = new Array(16).fill(false);
  const totalCycles = Math.max(1, ch.cycleCount || 1);
  const targetCycle = barPage % totalCycles;

  // Prefer stepsByCycle if present, else derive from notes
  const precomputed = channelEval?.stepsByCycle?.[targetCycle];
  if (precomputed && precomputed.length === 16) {
    return [...precomputed];
  }
  const notes = channelEval?.notes ?? [];
  for (const n of notes) {
    if (n.start >= targetCycle - 1e-4 && n.start < targetCycle + 1 - 1e-4) {
      const idx = Math.max(0, Math.min(15, Math.round((n.start - targetCycle) * 16)));
      mask[idx] = true;
    }
  }
  return mask;
}

function extractCleanSoundToken(ch) {
  const candidates = [
    ch.params?.s?.value,
    ch.params?.sound?.value,
    ch.stackLayers?.[0]?.sLit?.value,
    ch.patternSource?.kind === 's' || ch.patternSource?.kind === 'sound'
      ? ch.patternSource?.stringInfo?.value
      : null,
  ];
  for (const raw of candidates) {
    if (!raw || typeof raw !== 'string') continue;
    const toks = raw.match(/[a-zA-Z_][a-zA-Z0-9_-]*/g);
    const hit = toks?.find((t) => t !== 'x' && t !== 'Silence');
    if (hit) return hit;
  }
  return ch.kind === 'drum' ? 'bd' : ch.callsHelper === 'sierra' ? 'sawtooth' : 'triangle';
}

/**
 * Renders sound selector options while preserving custom tokens (like `bombo_club` or `user`).
 */
function renderSoundOptions(ch) {
  const baseList = ch.kind === 'drum' ? DRUM_SOUNDS : SYNTH_SOUNDS;
  const current = extractCleanSoundToken(ch);
  const opts = baseList.includes(current) ? baseList : [current, ...baseList];
  return opts
    .map(
      (s) =>
        `<option value="${escapeAttr(s)}" ${s === current ? 'selected' : ''}>${escapeHtml(s)}</option>`,
    )
    .join('');
}

/**
 * Interactive FL Studio Channel Rack & 16-Step Sequencer component.
 */
export function createChannelRackView(container, callbacks) {
  let currentAnalysis = null;
  let currentEval = null;
  let currentState = {
    selectedChannelId: null,
    mutedIds: new Set(),
    soloIds: new Set(),
    barPage: 0,
    customVocalName: null,
  };
  let lastStepIndex = -1;
  let selectedPreset = 'lead';

  function render() {
    if (!currentAnalysis) return;
    const { channels } = currentAnalysis;
    const maxCycles = Math.max(1, ...channels.map((c) => c.cycleCount || 1));
    const barPage = Math.min(currentState.barPage, Math.max(0, maxCycles - 1));
    const hasSolo = currentState.soloIds.size > 0;

    const pageBtns = [];
    for (let p = 0; p < Math.min(8, maxCycles); p++) {
      pageBtns.push(
        `<button type="button" class="fl-btn fl-btn-xs ${p === barPage ? 'is-active' : ''}" data-action="bar-page" data-page="${p}" title="Ver compás ${p + 1} en el Step Sequencer">C${p + 1}</button>`,
      );
    }

    const presetOptions = Object.entries(CHANNEL_PRESETS)
      .map(
        ([k, p]) =>
          `<option value="${escapeAttr(k)}" ${k === selectedPreset ? 'selected' : ''}>${escapeHtml(p.label)}</option>`,
      )
      .join('');

    const stepIndicesRow = Array.from({ length: 16 }, (_, i) => {
      const groupCls = Math.floor(i / 4) % 2 === 0 ? 'is-group-a' : 'is-group-b';
      return `<div class="cr-step-num ${groupCls}" data-step-hdr="${i}">${i + 1}</div>`;
    }).join('');

    const rowsHtml = channels
      .map((ch) => {
        const chEval = currentEval?.channelData?.[ch.id];
        const isMuted = currentState.mutedIds.has(ch.id);
        const isSolo = currentState.soloIds.has(ch.id);
        const isSilenced = hasSolo ? !isSolo : isMuted;
        const isSelected = currentState.selectedChannelId === ch.id;
        const gainVal = clamp(ch.effectiveGain ?? 0.75, 0, 1.5);
        const panVal = clamp(ch.params?.pan?.numericValue ?? 0, -1, 1);

        let rightWidgetHtml = '';
        if (ch.isVocal) {
          const canUpload = ch.params?.s?.value === 'voz_norost' ||
            ch.patternSource?.stringInfo?.value === 'voz_norost';
          const vocalBadge = canUpload && currentState.customVocalName
            ? `✓ ${escapeHtml(currentState.customVocalName)}`
            : canUpload ? 'Voz local (/local-audio/voz-norost.wav)' : 'Voz de esta sección';
          rightWidgetHtml = `
            <div class="cr-vocal-bar">
              <span class="cr-vocal-status">${vocalBadge}</span>
              ${canUpload ? `<label class="fl-btn fl-btn-xs fl-btn-accent cr-vocal-upload">
                📁 Cargar voz (.wav/.mp3)
                <input type="file" accept="audio/*" data-action="upload-vocal" hidden />
              </label>` : ''}
            </div>
          `;
        } else if (ch.kind === 'drum') {
          const mask = computeChannelStepMask(ch, chEval, barPage);
          const stepsHtml = mask
            .map((on, i) => {
              const groupCls = Math.floor(i / 4) % 2 === 0 ? 'is-group-a' : 'is-group-b';
              return `<button type="button" class="cr-step ${groupCls} ${on ? 'is-on' : ''}" style="--step-color:${ch.color}" data-action="toggle-step" data-ch-id="${escapeAttr(ch.id)}" data-step="${i}" aria-pressed="${on}" aria-label="${escapeAttr(ch.label)} paso ${i + 1}"></button>`;
            })
            .join('');
          rightWidgetHtml = `<div class="cr-steps-grid">${stepsHtml}</div>`;
        } else {
          const previewSvg = buildMelodicStripSvg(chEval?.notes, barPage, ch.cycleCount);
          rightWidgetHtml = `
            <button type="button" class="cr-melodic-strip" style="--strip-color:${ch.color}" data-action="open-piano-roll" data-ch-id="${escapeAttr(ch.id)}" title="Abrir ${escapeAttr(ch.label)} en el Piano Roll (${ch.cycleCount} compases)">
              ${previewSvg}
              <span class="cr-melodic-hint">🎹 Piano Roll (${chEval?.notes?.length ?? 0} notas · ${ch.cycleCount}c)</span>
            </button>
          `;
        }

        const sharedBadge = ch.patternSource?.sharedWith?.length
          ? `<span class="cr-shared-badge" title="Comparte patrón '${escapeAttr(ch.patternSource.sourceVar)}' con: ${escapeAttr(ch.patternSource.sharedWith.join(', '))}">🔗</span>`
          : '';

        return `
          <div class="cr-row ${isSelected ? 'is-selected' : ''} ${isSilenced ? 'is-muted' : ''}" data-ch-id="${escapeAttr(ch.id)}">
            <div class="cr-controls">
              <button type="button" class="fl-led ${isMuted ? 'is-off' : 'is-green'}" data-action="mute" data-ch-id="${escapeAttr(ch.id)}" aria-label="Silenciar ${escapeAttr(ch.label)}" title="Mute"></button>
              <button type="button" class="fl-led fl-led-sm ${isSolo ? 'is-amber' : 'is-off'}" data-action="solo" data-ch-id="${escapeAttr(ch.id)}" aria-label="Solo ${escapeAttr(ch.label)}" title="Solo">S</button>
              <input type="range" class="fl-mini-slider" data-action="param" data-param="pan" data-ch-id="${escapeAttr(ch.id)}" min="-1" max="1" step="0.05" value="${panVal}" aria-label="Paneo ${escapeAttr(ch.label)}" title="Pan (${panVal.toFixed(2)})" />
              <input type="range" class="fl-mini-slider" data-action="param" data-param="gain" data-ch-id="${escapeAttr(ch.id)}" min="0" max="1.4" step="0.02" value="${gainVal}" aria-label="Volumen ${escapeAttr(ch.label)}" title="Volumen (${gainVal.toFixed(2)})" />
              <button type="button" class="cr-chan-btn ${isSelected ? 'is-selected' : ''}" style="--ch-color:${ch.color}" data-action="select-channel" data-ch-id="${escapeAttr(ch.id)}" title="Seleccionar ${escapeAttr(ch.label)} para Piano Roll">
                <span class="cr-chan-dot" style="background:${ch.color}"></span>
                <span class="cr-chan-label">${escapeHtml(ch.label)}</span>
                ${sharedBadge}
              </button>
              <select class="fl-select fl-select-xs" data-action="sound-select" data-ch-id="${escapeAttr(ch.id)}" aria-label="Timbre de ${escapeAttr(ch.label)}" title="Timbre / Sintetizador">
                ${renderSoundOptions(ch)}
              </select>
            </div>
            <div class="cr-seq-cell">
              ${rightWidgetHtml}
            </div>
          </div>
        `;
      })
      .join('');

    container.innerHTML = `
      <div class="pane-toolbar">
        <div class="pane-title-group">
          <span class="pane-title">CHANNEL RACK</span>
          <span class="pane-meta">${channels.length} canales · 16 pasos</span>
        </div>
        <div class="pane-actions">
          ${maxCycles > 1 ? `<div class="cr-pages" role="group" aria-label="Página de compás">${pageBtns.join('')}</div>` : ''}
          <div class="cr-add-group">
            <select class="fl-select fl-select-xs" id="cr-preset-select" aria-label="Preset de nuevo canal">
              ${presetOptions}
            </select>
            <button type="button" class="fl-btn fl-btn-xs fl-btn-accent" data-action="add-channel">+ Canal</button>
          </div>
        </div>
      </div>
      <div class="cr-list">
        <div class="cr-header-strip">
          <div class="cr-header-left">Canales · Timbre</div>
          <div class="cr-header-steps">${stepIndicesRow}</div>
        </div>
        ${rowsHtml}
      </div>
    `;

    lastStepIndex = -1;
  }

  function updateStepIndicator(cycle, playing) {
    const activeStep = playing ? Math.floor((cycle - Math.floor(cycle)) * 16) % 16 : -1;
    if (activeStep === lastStepIndex) return;
    lastStepIndex = activeStep;

    container.querySelectorAll('.cr-step-num.is-playing, .cr-step.is-playing').forEach((el) => {
      el.classList.remove('is-playing');
    });
    if (activeStep >= 0) {
      const hdr = container.querySelector(`.cr-step-num[data-step-hdr="${activeStep}"]`);
      if (hdr) hdr.classList.add('is-playing');
      container.querySelectorAll(`.cr-step[data-step="${activeStep}"]`).forEach((el) => {
        el.classList.add('is-playing');
      });
    }
  }

  container.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    if (action === 'toggle-step') {
      const chId = btn.dataset.chId;
      const step = Number(btn.dataset.step);
      callbacks.onToggleStep?.(chId, currentState.barPage, step);
      return;
    }
    if (action === 'select-channel') {
      callbacks.onSelectChannel?.(btn.dataset.chId);
      return;
    }
    if (action === 'open-piano-roll') {
      callbacks.onSelectChannel?.(btn.dataset.chId, { openPianoRoll: true });
      return;
    }
    if (action === 'mute') {
      callbacks.onToggleMute?.(btn.dataset.chId);
      return;
    }
    if (action === 'solo') {
      callbacks.onToggleSolo?.(btn.dataset.chId);
      return;
    }
    if (action === 'bar-page') {
      currentState.barPage = Number(btn.dataset.page);
      render();
      callbacks.onBarPageChange?.(currentState.barPage);
      return;
    }
    if (action === 'add-channel') {
      const sel = container.querySelector('#cr-preset-select');
      selectedPreset = sel?.value || selectedPreset;
      callbacks.onAddChannel?.(selectedPreset);
    }
  });

  container.addEventListener('change', (e) => {
    const target = e.target;
    if (target.id === 'cr-preset-select') {
      selectedPreset = target.value;
      return;
    }
    const action = target.dataset.action;
    if (action === 'sound-select') {
      callbacks.onParamChange?.(target.dataset.chId, 's', target.value, { commit: true });
      return;
    }
    if (action === 'param') {
      callbacks.onParamChange?.(target.dataset.chId, target.dataset.param, Number(target.value), { commit: true });
      return;
    }
    if (action === 'upload-vocal' && target.files?.[0]) {
      callbacks.onUploadVocal?.(target.files[0]);
    }
  });

  // Live preview feedback while dragging Pan/Gain sliders without regenerating AST unnecessarily until throttled/committed
  container.addEventListener('input', (e) => {
    const target = e.target;
    if (target.dataset.action === 'param') {
      callbacks.onParamChange?.(target.dataset.chId, target.dataset.param, Number(target.value), { commit: false });
    }
  });

  return {
    update(analysis, evalResult, state = {}) {
      currentAnalysis = analysis;
      currentEval = evalResult;
      currentState = { ...currentState, ...state };
      render();
    },
    updateStepIndicator,
  };
}
