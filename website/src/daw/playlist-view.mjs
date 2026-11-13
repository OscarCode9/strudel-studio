import { escapeAttr, escapeHtml } from './ui-utils.mjs';

/**
 * Generates an inline SVG mini-preview of a channel's note/drum pattern inside a Playlist clip.
 */
function buildClipMiniSvg(notes, cycleCount, isDrum) {
  if (!notes || notes.length === 0) {
    return '<svg class="pl-clip-svg" viewBox="0 0 100 20" preserveAspectRatio="none" aria-hidden="true"><line x1="2" y1="10" x2="98" y2="10" stroke="currentColor" stroke-opacity="0.35" stroke-width="1.5" stroke-dasharray="3 3"/></svg>';
  }
  const cycles = Math.max(1, cycleCount || 1);
  let minMidi = 127;
  let maxMidi = 0;
  for (const n of notes) {
    if (n.midi < minMidi) minMidi = n.midi;
    if (n.midi > maxMidi) maxMidi = n.midi;
  }
  const span = Math.max(4, maxMidi - minMidi);
  const rects = notes.slice(0, 64).map((n) => {
    const x = Math.max(0, Math.min(98, (n.start / cycles) * 100));
    const w = Math.max(2, Math.min(100 - x, (n.duration / cycles) * 100));
    const y = isDrum ? 6 : 16 - ((n.midi - minMidi) / span) * 13 - 2;
    const h = isDrum ? 8 : 2.6;
    return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${h}" rx="0.8" fill="currentColor" fill-opacity="0.85"/>`;
  });
  return `<svg class="pl-clip-svg" viewBox="0 0 100 20" preserveAspectRatio="none" aria-hidden="true">${rects.join('')}</svg>`;
}

/**
 * Interactive FL Studio Playlist Timeline component.
 * Shows Arrangement sections across bars, per-channel clips, mute/solo track headers,
 * clickable seeking bar ruler, loop markers, and section manipulation controls.
 */
export function createPlaylistView(container, callbacks) {
  let currentAnalysis = null;
  let currentEval = null;
  let currentState = {
    selectedChannelId: null,
    selectedSectionIndex: 0,
    mutedIds: new Set(),
    soloIds: new Set(),
    loopRange: { enabled: false, start: 0, end: 8 },
    pxPerBar: 16,
  };

  let scrollEl = null;
  let playheadEl = null;
  let lastPlayheadBar = 0;

  function renderStructure() {
    if (!currentAnalysis) return;
    const { channels, sections, totalBars, hasArrange } = currentAnalysis;
    const pxPerBar = currentState.pxPerBar;
    const timelineWidth = Math.max(480, Math.round(totalBars * pxPerBar));
    const secIdx = Math.min(
      Math.max(0, currentState.selectedSectionIndex),
      Math.max(0, sections.length - 1),
    );
    const activeSec = sections[secIdx];
    const hasSolo = currentState.soloIds.size > 0;

    // Group grid rulers every 4 bars
    const rulerTicks = [];
    const stepBars = pxPerBar < 12 ? 8 : 4;
    for (let b = 0; b < totalBars; b += stepBars) {
      const left = Math.round(b * pxPerBar);
      rulerTicks.push(
        `<span class="pl-tick" style="left:${left}px">${b + 1}</span>`,
      );
    }

    const loopOverlayHtml =
      currentState.loopRange?.enabled && currentState.loopRange.end > currentState.loopRange.start
        ? `<div class="pl-loop-band" style="left:${Math.round(currentState.loopRange.start * pxPerBar)}px;width:${Math.round((currentState.loopRange.end - currentState.loopRange.start) * pxPerBar)}px" title="Loop activo: compás ${currentState.loopRange.start + 1}–${currentState.loopRange.end}"></div>`
        : '';

    const sectionHeadersHtml = sections
      .map((sec, idx) => {
        const left = Math.round(sec.startBar * pxPerBar);
        const width = Math.max(18, Math.round(sec.bars * pxPerBar));
        const selected = idx === secIdx ? 'is-selected' : '';
        return `<button type="button" class="pl-sec-chip ${selected}" data-sec-idx="${idx}" style="left:${left}px;width:${width}px" title="${sec.label} (${sec.bars} compases) · Clic para seleccionar / Doble clic para loop">
          <span class="pl-sec-name">${escapeHtml(sec.label)}</span>
          <span class="pl-sec-bars">${sec.bars}c</span>
        </button>`;
      })
      .join('');

    const sectionColsHtml = sections
      .map((sec, idx) => {
        const left = Math.round(sec.startBar * pxPerBar);
        const width = Math.round(sec.bars * pxPerBar);
        const selected = idx === secIdx ? 'is-selected' : '';
        return `<div class="pl-sec-col ${selected}" style="left:${left}px;width:${width}px"></div>`;
      })
      .join('');

    const headersRowsHtml = channels
      .map((ch) => {
        const isMuted = currentState.mutedIds.has(ch.id);
        const isSolo = currentState.soloIds.has(ch.id);
        const isSilenced = hasSolo ? !isSolo : isMuted;
        const isFocused = currentState.selectedChannelId === ch.id;
        return `<div class="pl-track-hdr ${isFocused ? 'is-focused' : ''} ${isSilenced ? 'is-muted' : ''}" data-ch-id="${escapeAttr(ch.id)}">
          <span class="pl-track-accent" style="background:${ch.color}"></span>
          <button type="button" class="pl-track-name" data-action="focus-channel" data-ch-id="${escapeAttr(ch.id)}" title="Abrir ${escapeAttr(ch.label)} en Piano Roll">
            <span>${escapeHtml(ch.label)}</span>
            ${ch.isGlobal ? '<span class="pl-badge">GLOBAL</span>' : ''}
          </button>
          <div class="pl-track-leds">
            <button type="button" class="fl-led ${isMuted ? 'is-off' : 'is-green'}" data-action="mute" data-ch-id="${escapeAttr(ch.id)}" aria-label="Silenciar ${escapeAttr(ch.label)}" title="Mute (Silenciar)">M</button>
            <button type="button" class="fl-led ${isSolo ? 'is-amber' : 'is-off'}" data-action="solo" data-ch-id="${escapeAttr(ch.id)}" aria-label="Solo ${escapeAttr(ch.label)}" title="Solo">S</button>
          </div>
        </div>`;
      })
      .join('');

    const laneRowsHtml = channels
      .map((ch) => {
        const notes = currentEval?.channelData?.[ch.id]?.notes ?? [];
        const miniSvg = buildClipMiniSvg(notes, ch.cycleCount, ch.kind === 'drum');
        const isMuted = currentState.mutedIds.has(ch.id);
        const isSolo = currentState.soloIds.has(ch.id);
        const isSilenced = hasSolo ? !isSolo : isMuted;

        if (!hasArrange) {
          const width = Math.max(120, timelineWidth);
          return `<div class="pl-lane ${isSilenced ? 'is-muted' : ''}" data-ch-id="${escapeAttr(ch.id)}">
            <div class="pl-clip is-active" style="left:0;width:${width}px;--clip-color:${ch.color}" data-action="focus-channel" data-ch-id="${escapeAttr(ch.id)}">
              <div class="pl-clip-head"><span class="pl-clip-title">${escapeHtml(ch.label)}</span></div>
              ${miniSvg}
            </div>
          </div>`;
        }

        const cells = sections
          .map((sec, idx) => {
            const left = Math.round(sec.startBar * pxPerBar);
            const width = Math.round(sec.bars * pxPerBar);
            const info = sec.channels?.[ch.id];
            const active = Boolean(info?.active);
            const modText = info?.modifiers?.length ? info.modifiers.slice(0, 2).join(' ') : '';
            if (!active) {
              return `<button type="button" class="pl-cell-empty" data-action="toggle-clip" data-sec-idx="${idx}" data-ch-id="${escapeAttr(ch.id)}" data-enable="1" style="left:${left}px;width:${width}px" aria-label="Activar ${escapeAttr(ch.label)} en ${escapeAttr(sec.label)}" title="Clic: activar ${escapeAttr(ch.label)} en ${escapeAttr(sec.label)}"></button>`;
            }
            return `<div role="button" tabindex="0" class="pl-clip is-active ${ch.isGlobal ? 'is-global' : ''}" data-action="select-clip" data-sec-idx="${idx}" data-ch-id="${escapeAttr(ch.id)}" style="left:${left + 1}px;width:${Math.max(12, width - 2)}px;--clip-color:${ch.color}" title="Clic: seleccionar ${escapeAttr(ch.label)} · Doble clic: Piano Roll · Clic derecho o ×: quitar">
              <div class="pl-clip-head">
                <span class="pl-clip-title">${escapeHtml(ch.label)}</span>
                ${modText ? `<span class="pl-clip-mod">${escapeHtml(modText)}</span>` : ''}
                ${width >= 26 ? `<button type="button" class="pl-clip-x" data-action="toggle-clip" data-sec-idx="${idx}" data-ch-id="${escapeAttr(ch.id)}" data-enable="0" aria-label="Quitar ${escapeAttr(ch.label)} de ${escapeAttr(sec.label)}" title="Quitar de ${escapeAttr(sec.label)}">×</button>` : ''}
              </div>
              ${width >= 36 ? miniSvg : ''}
            </div>`;
          })
          .join('');

        return `<div class="pl-lane ${isSilenced ? 'is-muted' : ''}" data-ch-id="${escapeAttr(ch.id)}">${cells}</div>`;
      })
      .join('');

    container.innerHTML = `
      <div class="pane-toolbar">
        <div class="pane-title-group">
          <span class="pane-title">PLAYLIST · Arreglo</span>
          <span class="pane-meta">${totalBars} compases · ${sections.length} secciones</span>
        </div>
        ${
          activeSec && hasArrange
            ? `<div class="pl-section-actions" role="group" aria-label="Controles de sección seleccionada">
                <span class="pl-active-sec-pill" title="Sección seleccionada">§ ${secIdx + 1}: <strong>${escapeHtml(activeSec.label)}</strong> (${activeSec.bars}c)</span>
                <button type="button" class="fl-btn fl-btn-xs" data-action="sec-shrink" title="Acortar sección 1 compás">−1c</button>
                <button type="button" class="fl-btn fl-btn-xs" data-action="sec-grow" title="Alargar sección 1 compás">+1c</button>
                <button type="button" class="fl-btn fl-btn-xs" data-action="sec-split" ${activeSec.bars <= 1 ? 'disabled' : ''} title="Dividir sección a la mitad">✂ Dividir</button>
                <button type="button" class="fl-btn fl-btn-xs" data-action="sec-dup" title="Duplicar sección">⧉ Duplicar</button>
                <button type="button" class="fl-btn fl-btn-xs fl-btn-danger" data-action="sec-del" ${sections.length <= 1 ? 'disabled' : ''} title="Eliminar sección">✕</button>
              </div>`
            : ''
        }
        <div class="pane-actions">
          ${hasArrange ? '<button type="button" class="fl-btn fl-btn-xs fl-btn-accent" data-action="sec-add" title="Añadir nueva sección al final">+ Sección</button>' : ''}
          <button type="button" class="fl-btn fl-btn-xs ${currentState.loopRange?.enabled ? 'is-active' : ''}" data-action="toggle-loop" title="Loop sobre sección seleccionada o rango">⟳ Loop</button>
          <div class="zoom-group">
            <button type="button" class="fl-btn fl-btn-xs" data-action="zoom-out" aria-label="Alejar timeline">−</button>
            <button type="button" class="fl-btn fl-btn-xs" data-action="zoom-in" aria-label="Acercar timeline">+</button>
          </div>
        </div>
      </div>
      <div class="pl-body">
        <div class="pl-sidebar">
          <div class="pl-sidebar-corner">Pistas (${channels.length})</div>
          <div class="pl-sidebar-rows">${headersRowsHtml}</div>
        </div>
        <div class="pl-scroll" id="pl-scroll-area">
          <div class="pl-canvas" style="width:${timelineWidth}px">
            <div class="pl-ruler" data-action="seek-ruler" title="Clic para saltar al compás · Alt+Clic para ubicar un punto exacto">
              ${loopOverlayHtml}
              ${rulerTicks.join('')}
            </div>
            <div class="pl-sec-bar">
              ${sectionHeadersHtml}
            </div>
            <div class="pl-lanes-wrap">
              ${sectionColsHtml}
              ${laneRowsHtml}
            </div>
            <div class="pl-playhead" id="pl-playhead" aria-hidden="true"></div>
          </div>
        </div>
      </div>
    `;

    scrollEl = container.querySelector('#pl-scroll-area');
    playheadEl = container.querySelector('#pl-playhead');
    updatePlayhead(lastPlayheadBar);
  }

  function updatePlayhead(bar) {
    lastPlayheadBar = bar;
    if (!playheadEl) return;
    const x = Math.round(bar * currentState.pxPerBar);
    playheadEl.style.transform = `translate3d(${x}px, 0, 0)`;
  }

  // Delegated interaction handlers so DOM re-renders remain instant & leak-free
  container.addEventListener('click', (e) => {
    const secChip = e.target.closest('.pl-sec-chip');
    if (secChip) {
      const idx = Number(secChip.dataset.secIdx);
      currentState.selectedSectionIndex = idx;
      const sec = currentAnalysis?.sections?.[idx];
      if (e.shiftKey && sec) {
        callbacks.onSetLoop?.(true, sec.startBar, sec.endBar);
      } else if (sec) {
        callbacks.onSeek?.(sec.startBar);
      }
      renderStructure();
      return;
    }

    const ruler = e.target.closest('[data-action="seek-ruler"]');
    if (ruler) {
      const rect = ruler.getBoundingClientRect();
      const relX = Math.max(0, e.clientX - rect.left);
      const position = relX / currentState.pxPerBar;
      const bar = e.altKey ? position : Math.floor(position);
      callbacks.onSeek?.(bar);
      return;
    }

    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;

    if (action === 'toggle-clip') {
      e.stopPropagation();
      const secIdx = Number(btn.dataset.secIdx);
      const chId = btn.dataset.chId;
      const enable = btn.dataset.enable === '1';
      currentState.selectedSectionIndex = secIdx;
      callbacks.onToggleCell?.(secIdx, chId, enable);
      return;
    }
    if (action === 'select-clip') {
      const secIdx = Number(btn.dataset.secIdx);
      const chId = btn.dataset.chId;
      currentState.selectedSectionIndex = secIdx;
      callbacks.onFocusChannel?.(chId);
      renderStructure();
      return;
    }
    if (action === 'focus-channel') {
      callbacks.onFocusChannel?.(btn.dataset.chId);
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
    if (action === 'sec-shrink') {
      const sec = currentAnalysis?.sections?.[currentState.selectedSectionIndex];
      if (sec) callbacks.onResizeSection?.(currentState.selectedSectionIndex, Math.max(1, sec.bars - 1));
      return;
    }
    if (action === 'sec-grow') {
      const sec = currentAnalysis?.sections?.[currentState.selectedSectionIndex];
      if (sec) callbacks.onResizeSection?.(currentState.selectedSectionIndex, Math.min(64, sec.bars + 1));
      return;
    }
    if (action === 'sec-split') {
      callbacks.onSplitSection?.(currentState.selectedSectionIndex);
      return;
    }
    if (action === 'sec-dup') {
      callbacks.onDuplicateSection?.(currentState.selectedSectionIndex);
      return;
    }
    if (action === 'sec-del') {
      callbacks.onDeleteSection?.(currentState.selectedSectionIndex);
      return;
    }
    if (action === 'sec-add') {
      callbacks.onAddSection?.();
      return;
    }
    if (action === 'toggle-loop') {
      const sec = currentAnalysis?.sections?.[currentState.selectedSectionIndex];
      if (currentState.loopRange?.enabled) {
        callbacks.onSetLoop?.(false, 0, 8);
      } else if (sec) {
        callbacks.onSetLoop?.(true, sec.startBar, sec.endBar);
      }
      return;
    }
    if (action === 'zoom-in') {
      currentState.pxPerBar = Math.min(40, currentState.pxPerBar + 4);
      renderStructure();
      return;
    }
    if (action === 'zoom-out') {
      currentState.pxPerBar = Math.max(8, currentState.pxPerBar - 4);
      renderStructure();
    }
  });

  container.addEventListener('contextmenu', (e) => {
    const clip = e.target.closest('.pl-clip');
    if (clip) {
      e.preventDefault();
      const secIdx = Number(clip.dataset.secIdx);
      const chId = clip.dataset.chId;
      currentState.selectedSectionIndex = secIdx;
      callbacks.onToggleCell?.(secIdx, chId, false);
    }
  });

  container.addEventListener('dblclick', (e) => {
    const clip = e.target.closest('.pl-clip');
    if (clip) {
      callbacks.onFocusChannel?.(clip.dataset.chId, { openPianoRoll: true });
      return;
    }
    const secChip = e.target.closest('.pl-sec-chip');
    if (secChip) {
      const idx = Number(secChip.dataset.secIdx);
      const sec = currentAnalysis?.sections?.[idx];
      if (sec) {
        callbacks.onSetLoop?.(true, sec.startBar, sec.endBar);
        callbacks.onSeek?.(sec.startBar);
      }
    }
  });

  return {
    update(analysis, evalResult, state = {}) {
      currentAnalysis = analysis;
      currentEval = evalResult;
      currentState = {
        ...currentState,
        ...state,
      };
      renderStructure();
    },
    updatePlayhead,
    scrollToBar(bar) {
      if (!scrollEl) return;
      const target = Math.max(0, bar * currentState.pxPerBar - scrollEl.clientWidth * 0.35);
      scrollEl.scrollLeft = target;
    },
  };
}
