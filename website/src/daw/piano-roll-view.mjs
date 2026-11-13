import { midiToNoteName } from './strudel-bridge.mjs';
import { clamp, escapeAttr, escapeHtml } from './ui-utils.mjs';

const MIDI_MIN = 24; // C1
const MIDI_MAX = 96; // C7
const ROW_H = 15;
const NUM_ROWS = MIDI_MAX - MIDI_MIN + 1;
const TOTAL_PITCH_H = NUM_ROWS * ROW_H;
const KEYS_W = 58;
const VEL_H = 62;

const BLACK_KEY_SET = new Set([1, 3, 6, 8, 10]);

const SCALES = {
  b_minor: { label: 'B menor (Pa Que)', pcs: new Set([11, 1, 2, 4, 6, 7, 9]) },
  a_minor: { label: 'A menor (Salgo)', pcs: new Set([9, 11, 0, 2, 4, 5, 7]) },
  g_major: { label: 'G mayor', pcs: new Set([7, 9, 11, 0, 2, 4, 6]) },
  chromatic: { label: 'Cromática', pcs: null },
};

/**
 * HiDPI Canvas FL Studio Piano Roll + Clickable Piano Keys + Velocity Lane.
 * Supports note drawing, moving, right-edge duration resizing, right-click/tool deletion,
 * scale ghost highlighting, snap presets, cycle lengths (1/2/4 bars), and live playhead.
 */
export function createPianoRollView(container, callbacks) {
  let currentAnalysis = null;
  let currentEval = null;
  let selectedChannelId = null;

  let tool = 'draw'; // 'draw' | 'erase'
  let snapDenom = 16; // 4, 8, 16, 32
  let scaleKey = 'b_minor';
  let cycleOverride = null; // null = follow channel cycleCount

  // Working local copy of notes while editing/dragging so canvas renders at 60fps
  let localNotes = [];
  let activeCycles = 1;
  let lastCreatedDuration = 1 / 8;

  // Drag state
  let dragState = null;
  let pressedKeyMidi = null;
  let playheadCycle = 0;
  let isPlaying = false;
  let lastFocusedForScroll = null;

  // DOM refs
  let scrollEl = null;
  let canvasEl = null;
  let velCanvasEl = null;
  let ctx = null;
  let velCtx = null;
  let resizeObserver = null;

  function getSelectedChannel() {
    if (!currentAnalysis?.channels?.length) return null;
    return (
      currentAnalysis.channels.find((c) => c.id === selectedChannelId) ??
      currentAnalysis.channels.find((c) => c.kind === 'synth' || c.kind === 'keys') ??
      currentAnalysis.channels[0]
    );
  }

  function getEffectiveCycles(ch) {
    return Math.max(1, cycleOverride ?? ch?.cycleCount ?? 1);
  }

  function getGridWidth() {
    if (!scrollEl) return 720;
    const minW = Math.max(480, activeCycles * 240);
    return Math.max(scrollEl.clientWidth - 2, minW);
  }

  function midiToY(midi) {
    return (MIDI_MAX - midi) * ROW_H;
  }

  function yToMidi(y) {
    return clamp(MIDI_MAX - Math.floor(y / ROW_H), MIDI_MIN, MIDI_MAX);
  }

  function timeToX(time, gridW) {
    return KEYS_W + (time / activeCycles) * (gridW - KEYS_W);
  }

  function xToTime(x, gridW) {
    return clamp(((x - KEYS_W) / Math.max(1, gridW - KEYS_W)) * activeCycles, 0, activeCycles);
  }

  function snapTime(t) {
    const step = 1 / snapDenom;
    return Math.round(t / step) * step;
  }

  function renderChrome() {
    if (!currentAnalysis) return;
    const prevScrollTop = scrollEl?.scrollTop ?? 0;
    const prevScrollLeft = scrollEl?.scrollLeft ?? 0;
    const ch = getSelectedChannel();
    if (!ch) return;
    selectedChannelId = ch.id;
    activeCycles = getEffectiveCycles(ch);

    const chanOptions = currentAnalysis.channels
      .filter((c) => !c.isVocal)
      .map(
        (c) =>
          `<option value="${escapeAttr(c.id)}" ${c.id === ch.id ? 'selected' : ''}>${escapeHtml(c.label)} (${c.cycleCount}c)</option>`,
      )
      .join('');

    const scaleOptions = Object.entries(SCALES)
      .map(
        ([k, s]) =>
          `<option value="${escapeAttr(k)}" ${k === scaleKey ? 'selected' : ''}>${escapeHtml(s.label)}</option>`,
      )
      .join('');

    const sharedList = ch.patternSource?.sharedWith ?? [];
    const sharedBannerHtml = sharedList.length
      ? `<div class="pr-shared-banner">
          <span>🔗 <strong>${escapeHtml(ch.label)}</strong> comparte el patrón <code>${escapeHtml(ch.patternSource.sourceVar)}</code> con <strong>${escapeHtml(sharedList.join(', '))}</strong>.</span>
          <button type="button" class="fl-btn fl-btn-xs fl-btn-accent" data-action="separate-shared">✂ Separar para editar independiente</button>
        </div>`
      : '';

    const cycleButtons = [1, 2, 4]
      .map(
        (c) =>
          `<button type="button" class="fl-btn fl-btn-xs ${activeCycles === c ? 'is-active' : ''}" data-action="set-cycles" data-cycles="${c}">${c}c</button>`,
      )
      .join('');

    const toolButtons = [
      { id: 'draw', label: '✏ Dibujar' },
      { id: 'erase', label: '✕ Borrar' },
    ]
      .map(
        (t) =>
          `<button type="button" class="fl-btn fl-btn-xs ${tool === t.id ? 'is-active' : ''}" data-action="set-tool" data-tool="${t.id}">${t.label}</button>`,
      )
      .join('');

    const snapOpts = [4, 8, 16, 32]
      .map((s) => `<option value="${s}" ${snapDenom === s ? 'selected' : ''}>1/${s}</option>`)
      .join('');

    const isDrumNoteHint = ch.isStack && ch.kind === 'drum';

    container.innerHTML = `
      <div class="pane-toolbar">
        <div class="pane-title-group">
          <span class="pane-title">PIANO ROLL</span>
          <select class="fl-select fl-select-xs" id="pr-channel-select" aria-label="Canal activo en Piano Roll">
            ${chanOptions}
          </select>
          ${isDrumNoteHint ? '<span class="pane-meta">(Edita golpes rítmicos via .struct)</span>' : ''}
        </div>
        <div class="pane-actions">
          <div class="btn-group">${toolButtons}</div>
          <label class="fl-field-inline">
            <span>Snap</span>
            <select class="fl-select fl-select-xs" id="pr-snap-select" aria-label="Cuantización Snap">${snapOpts}</select>
          </label>
          <div class="btn-group" role="group" aria-label="Duración de patrón en compases">${cycleButtons}</div>
          <select class="fl-select fl-select-xs" id="pr-scale-select" aria-label="Resaltado de escala">${scaleOptions}</select>
        </div>
      </div>
      ${sharedBannerHtml}
      <div class="pr-stage">
        <div class="pr-scroll" id="pr-scroll">
          <canvas class="pr-canvas" id="pr-canvas"></canvas>
        </div>
        <div class="pr-vel-bar">
          <div class="pr-vel-label">Velocidad</div>
          <div class="pr-vel-scroll" id="pr-vel-scroll">
            <canvas class="pr-vel-canvas" id="pr-vel-canvas"></canvas>
          </div>
        </div>
      </div>
    `;

    scrollEl = container.querySelector('#pr-scroll');
    canvasEl = container.querySelector('#pr-canvas');
    velCanvasEl = container.querySelector('#pr-vel-canvas');
    ctx = canvasEl.getContext('2d');
    velCtx = velCanvasEl.getContext('2d');

    bindCanvasEvents();
    setupResizeObserver();
    syncCanvasSizes();
    if (lastFocusedForScroll === selectedChannelId) {
      scrollEl.scrollTop = prevScrollTop;
      scrollEl.scrollLeft = prevScrollLeft;
    } else {
      scrollToChannelCentroid();
    }
    drawAll();
  }

  function scrollToChannelCentroid() {
    if (!scrollEl || !selectedChannelId) return;
    if (lastFocusedForScroll === selectedChannelId) return;
    lastFocusedForScroll = selectedChannelId;

    let targetMidi = 64;
    if (localNotes.length) {
      const avg = localNotes.reduce((acc, n) => acc + n.midi, 0) / localNotes.length;
      targetMidi = Math.round(avg);
    }
    const targetY = midiToY(targetMidi) - scrollEl.clientHeight * 0.45;
    scrollEl.scrollTop = clamp(targetY, 0, Math.max(0, TOTAL_PITCH_H - scrollEl.clientHeight));
  }

  function syncCanvasSizes() {
    if (!canvasEl || !velCanvasEl || !scrollEl) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const gridW = getGridWidth();

    canvasEl.width = Math.round(gridW * dpr);
    canvasEl.height = Math.round(TOTAL_PITCH_H * dpr);
    canvasEl.style.width = `${gridW}px`;
    canvasEl.style.height = `${TOTAL_PITCH_H}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const velGridW = Math.max(200, gridW - KEYS_W);
    velCanvasEl.width = Math.round(velGridW * dpr);
    velCanvasEl.height = Math.round(VEL_H * dpr);
    velCanvasEl.style.width = `${velGridW}px`;
    velCanvasEl.style.height = `${VEL_H}px`;
    velCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function setupResizeObserver() {
    if (resizeObserver) resizeObserver.disconnect();
    if (typeof ResizeObserver === 'undefined' || !scrollEl) return;
    resizeObserver = new ResizeObserver(() => {
      syncCanvasSizes();
      drawAll();
    });
    resizeObserver.observe(scrollEl);
  }

  function drawAll() {
    if (!ctx || !velCtx || !canvasEl) return;
    const ch = getSelectedChannel();
    const noteColor = ch?.color || '#ff934f';
    const gridW = getGridWidth();
    const scalePcs = SCALES[scaleKey]?.pcs ?? null;

    // 1. Background pitch lanes
    for (let midi = MIDI_MAX; midi >= MIDI_MIN; midi--) {
      const y = midiToY(midi);
      const pc = ((midi % 12) + 12) % 12;
      const isBlack = BLACK_KEY_SET.has(pc);
      const inScale = !scalePcs || scalePcs.has(pc);

      if (pc === 0) {
        ctx.fillStyle = '#252931';
      } else if (!inScale) {
        ctx.fillStyle = '#17191f';
      } else {
        ctx.fillStyle = isBlack ? '#1d2027' : '#21252d';
      }
      ctx.fillRect(KEYS_W, y, gridW - KEYS_W, ROW_H);

      // Horizontal pitch line
      ctx.strokeStyle = pc === 0 ? 'rgba(255,255,255,0.14)' : 'rgba(255,255,255,0.04)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(KEYS_W, y + ROW_H - 0.5);
      ctx.lineTo(gridW, y + ROW_H - 0.5);
      ctx.stroke();

      // Piano key on the left
      const pressed = pressedKeyMidi === midi;
      if (pressed) {
        ctx.fillStyle = '#ff934f';
      } else {
        ctx.fillStyle = isBlack ? '#17191e' : '#d6dae2';
      }
      ctx.fillRect(0, y, isBlack ? KEYS_W - 14 : KEYS_W - 1, ROW_H - 0.5);
      if (isBlack) {
        ctx.fillStyle = pressed ? '#ff934f' : '#b8bec8';
        ctx.fillRect(KEYS_W - 14, y, 13, ROW_H - 0.5);
      }
      ctx.strokeStyle = '#0d0f13';
      ctx.beginPath();
      ctx.moveTo(0, y + ROW_H - 0.5);
      ctx.lineTo(KEYS_W, y + ROW_H - 0.5);
      ctx.stroke();

      // Label C notes and scale root (B)
      if (pc === 0 || (scaleKey === 'b_minor' && pc === 11)) {
        ctx.fillStyle = pressed ? '#0e1116' : isBlack ? '#e2e6ee' : '#252932';
        ctx.font = '600 9.5px "JetBrains Mono", monospace';
        ctx.textBaseline = 'middle';
        ctx.fillText(midiToNoteName(midi).toUpperCase(), 6, y + ROW_H / 2 + 0.5);
      }
    }

    // 2. Vertical time grid (steps, beats, bars)
    const totalSteps = activeCycles * snapDenom;
    for (let s = 0; s <= totalSteps; s++) {
      const t = s / snapDenom;
      const x = Math.round(timeToX(t, gridW)) + 0.5;
      const isBar = Math.abs(t - Math.round(t)) < 1e-4;
      const isBeat = Math.abs(t * 4 - Math.round(t * 4)) < 1e-4;
      ctx.strokeStyle = isBar
        ? 'rgba(255, 147, 79, 0.35)'
        : isBeat
          ? 'rgba(255, 255, 255, 0.14)'
          : 'rgba(255, 255, 255, 0.045)';
      ctx.lineWidth = isBar ? 1.5 : 1;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, TOTAL_PITCH_H);
      ctx.stroke();
    }

    // 3. Notes
    const localPlayCycle = isPlaying ? playheadCycle % activeCycles : -1;
    for (let idx = 0; idx < localNotes.length; idx++) {
      const n = localNotes[idx];
      if (n.start >= activeCycles - 1e-4) continue;
      const x = timeToX(n.start, gridW) + 1;
      const w = Math.max(6, timeToX(Math.min(activeCycles, n.start + n.duration), gridW) - x - 1);
      const y = midiToY(n.midi) + 1;
      const h = ROW_H - 2;
      const activeNow =
        isPlaying && localPlayCycle >= n.start - 0.02 && localPlayCycle < n.start + n.duration;
      const selected = dragState?.noteIndex === idx;

      ctx.fillStyle = activeNow ? '#ffffff' : noteColor;
      ctx.globalAlpha = activeNow ? 1 : 0.38 + clamp(n.velocity ?? 0.85, 0.2, 1) * 0.62;
      roundRect(ctx, x, y, w, h, 3);
      ctx.fill();
      ctx.globalAlpha = 1;

      ctx.strokeStyle = selected ? '#ffffff' : 'rgba(10, 12, 16, 0.75)';
      ctx.lineWidth = selected ? 1.6 : 1;
      roundRect(ctx, x, y, w, h, 3);
      ctx.stroke();

      // Resize handle accent on right edge
      if (w >= 14) {
        ctx.fillStyle = 'rgba(0,0,0,0.3)';
        ctx.fillRect(x + w - 4, y + 2, 2, h - 4);
      }

      if (w >= 26) {
        ctx.fillStyle = '#0f1218';
        ctx.font = '700 9px "JetBrains Mono", monospace';
        ctx.textBaseline = 'middle';
        ctx.fillText(midiToNoteName(n.midi).toUpperCase(), x + 4, y + h / 2 + 0.5);
      }
    }

    // 4. Live playhead vertical line
    if (isPlaying || playheadCycle > 0) {
      const px = timeToX(playheadCycle % activeCycles, gridW);
      ctx.strokeStyle = '#ff934f';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(px, 0);
      ctx.lineTo(px, TOTAL_PITCH_H);
      ctx.stroke();
    }

    // 5. Velocity stems lane below
    const velW = Math.max(200, gridW - KEYS_W);
    velCtx.fillStyle = '#15181e';
    velCtx.fillRect(0, 0, velW, VEL_H);

    for (let s = 0; s <= totalSteps; s++) {
      const t = s / snapDenom;
      const x = (t / activeCycles) * velW;
      const isBar = Math.abs(t - Math.round(t)) < 1e-4;
      velCtx.strokeStyle = isBar ? 'rgba(255,147,79,0.28)' : 'rgba(255,255,255,0.05)';
      velCtx.beginPath();
      velCtx.moveTo(x, 0);
      velCtx.lineTo(x, VEL_H);
      velCtx.stroke();
    }

    for (const n of localNotes) {
      if (n.start >= activeCycles - 1e-4) continue;
      const x = (n.start / activeCycles) * velW + 2;
      const vel = clamp(n.velocity ?? 0.85, 0.08, 1);
      const barH = Math.round(vel * (VEL_H - 12));
      velCtx.fillStyle = noteColor;
      velCtx.globalAlpha = 0.85;
      velCtx.fillRect(x, VEL_H - barH - 4, 6, barH);
      velCtx.fillStyle = '#fff';
      velCtx.fillRect(x, VEL_H - barH - 5, 6, 2.5);
      velCtx.globalAlpha = 1;
    }
  }

  function findNoteAt(x, y, gridW) {
    const midi = yToMidi(y);
    for (let i = localNotes.length - 1; i >= 0; i--) {
      const n = localNotes[i];
      if (n.midi !== midi) continue;
      const nx = timeToX(n.start, gridW);
      const nw = Math.max(8, timeToX(n.start + n.duration, gridW) - nx);
      if (x >= nx - 2 && x <= nx + nw + 3) {
        const nearRightEdge = nw >= 10 && x >= nx + nw - 7;
        return { index: i, note: n, nearRightEdge };
      }
    }
    return null;
  }

  function commitNotes() {
    const ch = getSelectedChannel();
    if (!ch) return;
    callbacks.onCommitNotes?.(ch.id, [...localNotes], activeCycles);
  }

  function bindCanvasEvents() {
    const velScroll = container.querySelector('#pr-vel-scroll');
    scrollEl.addEventListener('scroll', () => {
      if (velScroll) velScroll.scrollLeft = scrollEl.scrollLeft;
    });

    canvasEl.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const rect = canvasEl.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      if (x < KEYS_W) return;
      const hit = findNoteAt(x, y, getGridWidth());
      if (hit) {
        localNotes.splice(hit.index, 1);
        drawAll();
        commitNotes();
      }
    });

    canvasEl.addEventListener('pointerdown', (e) => {
      if (e.button === 2) return;
      const rect = canvasEl.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const gridW = getGridWidth();
      const ch = getSelectedChannel();

      // Piano keys click
      if (x < KEYS_W) {
        const midi = yToMidi(y);
        pressedKeyMidi = midi;
        callbacks.onPreviewNote?.(ch, midi, 0.32);
        drawAll();
        canvasEl.setPointerCapture(e.pointerId);
        dragState = { mode: 'key' };
        return;
      }

      const hit = findNoteAt(x, y, gridW);
      if (tool === 'erase') {
        if (hit) {
          localNotes.splice(hit.index, 1);
          drawAll();
          commitNotes();
        }
        dragState = { mode: 'erase-sweep', dirty: Boolean(hit) };
        canvasEl.setPointerCapture(e.pointerId);
        return;
      }

      canvasEl.setPointerCapture(e.pointerId);
      if (hit) {
        if (hit.nearRightEdge) {
          dragState = {
            mode: 'resize',
            noteIndex: hit.index,
            origDuration: hit.note.duration,
            dirty: false,
          };
        } else {
          const pointerTime = xToTime(x, gridW);
          dragState = {
            mode: 'move',
            noteIndex: hit.index,
            offsetTime: pointerTime - hit.note.start,
            lastMidi: hit.note.midi,
            dirty: false,
          };
          callbacks.onPreviewNote?.(ch, hit.note.midi, 0.22);
        }
        drawAll();
        return;
      }

      // Draw new note
      const step = 1 / snapDenom;
      const start = clamp(snapTime(xToTime(x, gridW)), 0, activeCycles - step);
      const midi = yToMidi(y);
      const dur = clamp(lastCreatedDuration || step, step, activeCycles - start);
      const newNote = {
        start,
        duration: dur,
        midi,
        velocity: 0.9,
      };
      localNotes.push(newNote);
      const newIndex = localNotes.length - 1;
      dragState = {
        mode: 'draw-drag',
        noteIndex: newIndex,
        startOrigin: start,
        lastMidi: midi,
        dirty: true,
      };
      callbacks.onPreviewNote?.(ch, midi, 0.25);
      drawAll();
    });

    canvasEl.addEventListener('pointermove', (e) => {
      const rect = canvasEl.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const gridW = getGridWidth();
      const ch = getSelectedChannel();

      if (!dragState) {
        if (x < KEYS_W) {
          canvasEl.style.cursor = 'pointer';
          return;
        }
        const hit = findNoteAt(x, y, gridW);
        canvasEl.style.cursor = hit
          ? hit.nearRightEdge
            ? 'ew-resize'
            : tool === 'erase'
              ? 'not-allowed'
              : 'grab'
          : tool === 'erase'
            ? 'crosshair'
            : 'cell';
        return;
      }

      if (dragState.mode === 'key') {
        const midi = yToMidi(y);
        if (midi !== pressedKeyMidi) {
          pressedKeyMidi = midi;
          callbacks.onPreviewNote?.(ch, midi, 0.25);
          drawAll();
        }
        return;
      }

      if (dragState.mode === 'erase-sweep') {
        const hit = findNoteAt(x, y, gridW);
        if (hit) {
          localNotes.splice(hit.index, 1);
          dragState.dirty = true;
          drawAll();
        }
        return;
      }

      const n = localNotes[dragState.noteIndex];
      if (!n) return;
      const step = 1 / snapDenom;

      if (dragState.mode === 'resize') {
        const pointerTime = snapTime(xToTime(x, gridW));
        const nextDur = Math.max(step, Math.min(activeCycles - n.start, pointerTime - n.start));
        if (Math.abs(nextDur - n.duration) > 1e-4) {
          n.duration = nextDur;
          lastCreatedDuration = nextDur;
          dragState.dirty = true;
          drawAll();
        }
        return;
      }

      if (dragState.mode === 'move') {
        const nextMidi = yToMidi(y);
        const nextStart = clamp(
          snapTime(xToTime(x, gridW) - dragState.offsetTime),
          0,
          Math.max(0, activeCycles - n.duration),
        );
        if (nextMidi !== n.midi || Math.abs(nextStart - n.start) > 1e-4) {
          if (nextMidi !== n.midi) {
            callbacks.onPreviewNote?.(ch, nextMidi, 0.2);
          }
          n.midi = nextMidi;
          n.start = nextStart;
          dragState.dirty = true;
          drawAll();
        }
        return;
      }

      if (dragState.mode === 'draw-drag') {
        const nextMidi = yToMidi(y);
        const endT = snapTime(xToTime(x, gridW));
        if (endT > dragState.startOrigin + step * 0.9) {
          n.duration = clamp(endT - dragState.startOrigin, step, activeCycles - n.start);
          lastCreatedDuration = n.duration;
        }
        if (nextMidi !== n.midi) {
          n.midi = nextMidi;
          callbacks.onPreviewNote?.(ch, nextMidi, 0.2);
        }
        drawAll();
      }
    });

    const endDrag = () => {
      if (!dragState) return;
      const shouldCommit = dragState.dirty;
      pressedKeyMidi = null;
      dragState = null;
      drawAll();
      if (shouldCommit) {
        commitNotes();
      }
    };

    canvasEl.addEventListener('pointerup', endDrag);
    canvasEl.addEventListener('pointercancel', endDrag);

    // Velocity lane dragging
    velCanvasEl.addEventListener('pointerdown', (e) => {
      const rect = velCanvasEl.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const velW = Math.max(200, getGridWidth() - KEYS_W);
      const t = (x / velW) * activeCycles;
      const target = localNotes.reduce((best, n) => {
        const d = Math.abs(n.start - t);
        return !best || d < best.d ? { n, d } : best;
      }, null);
      if (target && target.d < 0.15) {
        target.n.velocity = clamp(1 - y / VEL_H, 0.1, 1);
        drawAll();
        velCanvasEl.setPointerCapture(e.pointerId);
        dragState = { mode: 'velocity', note: target.n, dirty: true };
      }
    });

    velCanvasEl.addEventListener('pointermove', (e) => {
      if (dragState?.mode !== 'velocity') return;
      const rect = velCanvasEl.getBoundingClientRect();
      const y = e.clientY - rect.top;
      dragState.note.velocity = clamp(1 - y / VEL_H, 0.1, 1);
      drawAll();
    });

    velCanvasEl.addEventListener('pointerup', () => {
      if (dragState?.mode === 'velocity') {
        dragState = null;
        commitNotes();
      }
    });
  }

  container.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    if (action === 'set-tool') {
      tool = btn.dataset.tool;
      renderChrome();
      return;
    }
    if (action === 'set-cycles') {
      cycleOverride = Number(btn.dataset.cycles);
      const ch = getSelectedChannel();
      activeCycles = cycleOverride;
      renderChrome();
      if (ch) callbacks.onCommitNotes?.(ch.id, [...localNotes], activeCycles);
      return;
    }
    if (action === 'separate-shared') {
      const ch = getSelectedChannel();
      if (ch) callbacks.onSeparateShared?.(ch.id);
    }
  });

  container.addEventListener('change', (e) => {
    if (e.target.id === 'pr-channel-select') {
      selectedChannelId = e.target.value;
      cycleOverride = null;
      callbacks.onSelectChannel?.(selectedChannelId);
      return;
    }
    if (e.target.id === 'pr-snap-select') {
      snapDenom = Number(e.target.value);
      drawAll();
      return;
    }
    if (e.target.id === 'pr-scale-select') {
      scaleKey = e.target.value;
      drawAll();
    }
  });

  return {
    update(analysis, evalResult, state = {}) {
      currentAnalysis = analysis;
      currentEval = evalResult;
      if (state.selectedChannelId) {
        if (state.selectedChannelId !== selectedChannelId) {
          cycleOverride = null;
        }
        selectedChannelId = state.selectedChannelId;
      }
      const ch = getSelectedChannel();
      const rawNotes = ch ? evalResult?.channelData?.[ch.id]?.notes ?? [] : [];
      if (ch?.kind === 'drum') {
        const seenOnsets = new Set();
        localNotes = rawNotes
          .filter((n) => {
            const key = Math.round(n.start * 64);
            if (seenOnsets.has(key)) return false;
            seenOnsets.add(key);
            return true;
          })
          .map((n) => ({ ...n, midi: 60 }));
      } else {
        localNotes = rawNotes.map((n) => ({ ...n }));
      }
      renderChrome();
    },
    updatePlayhead(cycle, playing) {
      playheadCycle = cycle;
      isPlaying = playing;
      if (!dragState) {
        drawAll();
      }
    },
  };
}

function roundRect(ctx, x, y, w, h, r) {
  const rad = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rad, y);
  ctx.lineTo(x + w - rad, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rad);
  ctx.lineTo(x + w, y + h - rad);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rad, y + h);
  ctx.lineTo(x + rad, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rad);
  ctx.lineTo(x, y + rad);
  ctx.quadraticCurveTo(x, y, x + rad, y);
  ctx.closePath();
}
