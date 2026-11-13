import { code2hash } from '@strudel/core';
import { getDawProject, dawProjects } from './projects.mjs';
import {
  analyzeStrudelSource,
  evaluateVisualPatterns,
  patchAddChannel,
  patchBpm,
  patchChannelNotes,
  patchChannelParam,
  patchMasterPostgain,
  patchPlaylistAddSection,
  patchPlaylistDeleteSection,
  patchPlaylistDuplicateSection,
  patchPlaylistResizeSection,
  patchPlaylistSplitSection,
  patchPlaylistToggleChannel,
  patchSeparateSharedSource,
} from './strudel-bridge.mjs';
import { createAudioEngine } from './audio-engine.mjs';
import { createPlaylistView } from './playlist-view.mjs';
import { createChannelRackView } from './channel-rack-view.mjs';
import { createPianoRollView } from './piano-roll-view.mjs';
import { createMixerView } from './mixer-view.mjs';
import { createCodePanelView } from './code-panel-view.mjs';
import { clamp, escapeAttr, escapeHtml } from './ui-utils.mjs';

/**
 * Formats a fractional bar cycle into FL Studio LCD position `BBB:B:SS`.
 */
function formatBarLcd(barCycle) {
  const safe = Math.max(0, barCycle || 0);
  const bar = Math.floor(safe) + 1;
  const frac = safe - Math.floor(safe);
  const beat = Math.floor(frac * 4) + 1;
  const sub = Math.floor((frac * 4 - Math.floor(frac * 4)) * 4) + 1;
  return `${String(bar).padStart(3, '0')}:${beat}:${String(sub).padStart(2, '0')}`;
}

/**
 * Bootstraps the bidirectional FL Studio-style DAW inside `#daw-root`.
 */
export async function mountDawApp(rootEl, { base = '', initialVersion = '1' } = {}) {
  let currentProject = getDawProject(initialVersion);
  let currentCode = currentProject.source;
  let currentAnalysis = analyzeStrudelSource(currentCode);
  let currentEval = await evaluateVisualPatterns(currentCode, currentAnalysis);

  let selectedChannelId =
    currentAnalysis.channels.find((c) => c.id === 'lead')?.id ??
    currentAnalysis.channels.find((c) => !c.isVocal)?.id ??
    currentAnalysis.channels[0]?.id ??
    null;

  let transportMode = currentAnalysis.hasArrange ? 'SONG' : 'PAT';
  let mutedIds = new Set();
  let soloIds = new Set();
  let loopRange = { enabled: false, start: 0, end: 8 };
  let barPage = 0;

  // Layout state
  let layoutMode = 'all'; // 'all' | 'playlist' | 'rack' | 'piano' | 'mixer'
  let bottomSubtab = 'split'; // 'split' | 'rack' | 'piano' | 'mixer'
  let desktopCodeVisible = true;
  let mobileCodeActive = false;

  // Undo & debounce state
  const undoStack = [];
  let preDragSnapshot = null;
  let sliderThrottleTimer = null;
  let codeEditDebounce = null;
  let evalGeneration = 0;
  let rafId = null;

  // Build shell skeleton
  const projectOptions = dawProjects
    .map(
      (p) =>
        `<option value="${escapeAttr(p.id)}" ${p.id === currentProject.id ? 'selected' : ''}>${escapeHtml(p.title)} · ${escapeHtml(p.label)}</option>`,
    )
    .join('');

  const cleanBase = base && base !== '/' ? base.replace(/\/$/, '') : '';
  rootEl.innerHTML = `
    <div class="daw-shell">
      <header class="daw-topbar">
        <div class="daw-brand-group">
          <a class="daw-back-link" href="${cleanBase}/sesiones/1/" title="Volver a sesiones">← Sesiones</a>
          <div class="daw-brand">
            <span class="daw-brand-badge">FL</span>
            <span>Strudel Studio</span>
          </div>
          <select class="fl-select" id="daw-project-select" aria-label="Proyecto Strudel">
            ${projectOptions}
          </select>
          <a class="daw-back-link" id="daw-vocal-cue" href="${cleanBase}/studio/entrada/" ${currentProject.id === 'salgo-progresiva' ? '' : 'hidden'}>Alinear voz</a>
        </div>

        <div class="daw-transport-group">
          <div class="daw-mode-switch" role="group" aria-label="Modo de reproducción">
            <button type="button" class="daw-mode-btn ${transportMode === 'PAT' ? 'is-active' : ''}" data-transport-mode="PAT" title="Reproducir el patrón / Channel Rack en loop">PAT</button>
            <button type="button" class="daw-mode-btn ${transportMode === 'SONG' ? 'is-active' : ''}" data-transport-mode="SONG" title="Reproducir la canción completa (arrange)">SONG</button>
          </div>
          <button type="button" class="daw-play-btn" id="daw-play-btn" aria-label="Reproducir o pausar (Espacio)">▶ Play</button>
          <button type="button" class="daw-stop-btn" id="daw-stop-btn" aria-label="Detener">■ Stop</button>
          <div class="daw-lcd" aria-label="Posición y tempo">
            <span class="daw-lcd-pos" id="daw-lcd-pos">001:1:01</span>
            <span id="daw-elapsed" title="Segundos desde el inicio">0.000 s</span>
            <label class="daw-bpm-box">
              <span>BPM</span>
              <button type="button" class="daw-bpm-step" id="daw-bpm-dec" aria-label="Bajar BPM">−</button>
              <input type="number" class="daw-bpm-input" id="daw-bpm-input" min="40" max="260" step="1" value="${currentAnalysis.bpm}" />
              <button type="button" class="daw-bpm-step" id="daw-bpm-inc" aria-label="Subir BPM">+</button>
            </label>
          </div>
        </div>

        <div class="daw-view-tabs" role="tablist" aria-label="Vistas del estudio">
          <button type="button" class="fl-btn is-active" data-layout-tab="all">Todo</button>
          <button type="button" class="fl-btn" data-layout-tab="playlist">Playlist</button>
          <button type="button" class="fl-btn" data-layout-tab="rack">Rack</button>
          <button type="button" class="fl-btn" data-layout-tab="piano">Piano Roll</button>
          <button type="button" class="fl-btn" data-layout-tab="mixer">Mixer</button>
          <button type="button" class="fl-btn daw-mobile-code-btn" id="daw-mobile-code-btn">{ } Código</button>
          <button type="button" class="fl-btn is-active daw-desktop-code-toggle" id="daw-desktop-code-toggle" title="Mostrar u ocultar código Strudel en vivo">{ } Código</button>
        </div>
      </header>

      <main class="daw-workspace" id="daw-workspace">
        <section class="daw-visual-col" id="daw-visual-col" data-layout="${layoutMode}" aria-label="Espacio visual DAW">
          <div class="daw-pane daw-playlist-pane" id="daw-playlist-pane"></div>
          <div class="daw-bottom-dock" id="daw-bottom-dock" data-subtab="${bottomSubtab}">
            <div class="daw-bottom-tabs">
              <div class="daw-subtab-list" role="tablist" aria-label="Paneles de creación">
                <button type="button" class="fl-btn fl-btn-xs is-active" data-subtab-btn="split">Rack + Piano</button>
                <button type="button" class="fl-btn fl-btn-xs" data-subtab-btn="rack">Channel Rack</button>
                <button type="button" class="fl-btn fl-btn-xs" data-subtab-btn="piano">Piano Roll</button>
                <button type="button" class="fl-btn fl-btn-xs" data-subtab-btn="mixer">Mixer</button>
              </div>
              <span class="pane-meta" id="daw-active-channel-badge"></span>
            </div>
            <div class="daw-subpanel-host">
              <div class="daw-pane daw-rack-pane" id="daw-rack-pane"></div>
              <div class="daw-pane daw-piano-pane" id="daw-piano-pane"></div>
              <div class="daw-pane daw-mixer-pane" id="daw-mixer-pane"></div>
            </div>
          </div>
        </section>

        <aside class="daw-code-dock" id="daw-code-dock" aria-label="Editor de código Strudel">
          <div class="daw-pane" id="daw-code-pane" style="height:100%"></div>
        </aside>
      </main>
    </div>
  `;

  // DOM refs
  const workspaceEl = rootEl.querySelector('#daw-workspace');
  const visualColEl = rootEl.querySelector('#daw-visual-col');
  const bottomDockEl = rootEl.querySelector('#daw-bottom-dock');
  const playBtn = rootEl.querySelector('#daw-play-btn');
  const stopBtn = rootEl.querySelector('#daw-stop-btn');
  const lcdPosEl = rootEl.querySelector('#daw-lcd-pos');
  const elapsedEl = rootEl.querySelector('#daw-elapsed');
  const cueLink = rootEl.querySelector('#daw-vocal-cue');
  const bpmInputEl = rootEl.querySelector('#daw-bpm-input');
  const activeChannelBadgeEl = rootEl.querySelector('#daw-active-channel-badge');
  const projectSelectEl = rootEl.querySelector('#daw-project-select');

  const audioEngine = createAudioEngine({
    onToggle(playing) {
      playBtn.classList.toggle('is-playing', playing);
      playBtn.textContent = playing ? '❚❚ Pausa' : '▶ Play';
      if (playing) startPlayheadLoop();
      else stopPlayheadLoop();
    },
    onError(err) {
      codePanel.setSyncState({
        error: err?.message || String(err),
        undoCount: undoStack.length,
      });
    },
  });

  function getSelectedChannel() {
    return (
      currentAnalysis.channels.find((c) => c.id === selectedChannelId) ??
      currentAnalysis.channels[0] ??
      null
    );
  }

  function getPlayOptions() {
    const ch = getSelectedChannel();
    return {
      mode: transportMode,
      mutedIds,
      soloIds,
      seekBar: audioEngine.getCurrentBar(),
      loopRange,
      patBars: Math.max(1, ch?.cycleCount ?? 1),
    };
  }

  function renderAllVisuals() {
    const ch = getSelectedChannel();
    if (ch && selectedChannelId !== ch.id) {
      selectedChannelId = ch.id;
    }

    const sharedState = {
      selectedChannelId,
      mutedIds,
      soloIds,
      loopRange,
      barPage,
      customVocalName: audioEngine.getCustomVocalName(),
    };

    playlist.update(currentAnalysis, currentEval, sharedState);
    channelRack.update(currentAnalysis, currentEval, sharedState);
    pianoRoll.update(currentAnalysis, currentEval, sharedState);
    mixer.update(currentAnalysis, sharedState);

    if (document.activeElement !== bpmInputEl) {
      bpmInputEl.value = String(currentAnalysis.bpm);
    }

    if (activeChannelBadgeEl) {
      activeChannelBadgeEl.textContent = ch
        ? `Canal activo: ${ch.label} (${ch.cycleCount}c)`
        : '';
    }

    rootEl.querySelectorAll('[data-transport-mode]').forEach((btn) => {
      btn.classList.toggle('is-active', btn.dataset.transportMode === transportMode);
    });
  }

  async function syncFromCode(newCode, { triggerHotSwap = false } = {}) {
    const myGen = ++evalGeneration;
    try {
      const nextAnalysis = analyzeStrudelSource(newCode);
      const nextEval = await evaluateVisualPatterns(newCode, nextAnalysis);
      if (myGen !== evalGeneration) return;

      currentCode = newCode;
      currentAnalysis = nextAnalysis;
      currentEval = nextEval;
      renderAllVisuals();
      codePanel.setSyncState({ error: null, undoCount: undoStack.length });

      if (triggerHotSwap && audioEngine.isPlaying()) {
        await audioEngine.hotSwap(currentCode, currentAnalysis, getPlayOptions());
      }
    } catch (err) {
      if (myGen !== evalGeneration) return;
      codePanel.setSyncState({
        error: err?.message || 'Error al analizar código Strudel',
        undoCount: undoStack.length,
      });
    }
  }

  async function applyVisualPatch(patchResult, { recordUndo = true } = {}) {
    if (!patchResult || patchResult.code === currentCode) return;
    if (recordUndo) {
      undoStack.push(currentCode);
      if (undoStack.length > 60) undoStack.shift();
    }
    currentCode = patchResult.code;
    codePanel.setCode(currentCode, {
      fromVisual: true,
      changedRanges: patchResult.changedRanges,
    });
    await syncFromCode(currentCode, { triggerHotSwap: true });
  }

  function undoVisual() {
    if (!undoStack.length) return;
    const prevCode = undoStack.pop();
    currentCode = prevCode;
    codePanel.setCode(currentCode, {
      fromVisual: true,
      changedRanges: [[0, 0]],
      scrollToChange: false,
    });
    syncFromCode(currentCode, { triggerHotSwap: true });
  }

  function setLayoutState(nextLayout, nextSubtab = bottomSubtab) {
    layoutMode = nextLayout;
    if (nextLayout === 'rack') bottomSubtab = 'rack';
    else if (nextLayout === 'piano') bottomSubtab = 'piano';
    else if (nextLayout === 'mixer') bottomSubtab = 'mixer';
    else bottomSubtab = nextSubtab;

    mobileCodeActive = false;
    workspaceEl.classList.remove('is-mobile-code');
    visualColEl.dataset.layout = layoutMode;
    bottomDockEl.dataset.subtab = bottomSubtab;

    rootEl.querySelectorAll('[data-layout-tab]').forEach((b) => {
      b.classList.toggle('is-active', b.dataset.layoutTab === layoutMode && !mobileCodeActive);
    });
    rootEl.querySelectorAll('[data-subtab-btn]').forEach((b) => {
      b.classList.toggle('is-active', b.dataset.subtabBtn === bottomSubtab);
    });
    rootEl.querySelector('#daw-mobile-code-btn')?.classList.remove('is-active');
  }

  function focusChannel(chId, { openPianoRoll = false } = {}) {
    selectedChannelId = chId;
    if (openPianoRoll) {
      if (window.innerWidth < 1024) {
        setLayoutState('piano', 'piano');
      } else if (layoutMode === 'playlist') {
        setLayoutState('all', 'split');
      } else if (bottomSubtab === 'rack' || bottomSubtab === 'mixer') {
        setLayoutState(layoutMode, 'piano');
      }
    }
    renderAllVisuals();
  }

  function toggleMute(chId) {
    if (mutedIds.has(chId)) mutedIds.delete(chId);
    else mutedIds.add(chId);
    renderAllVisuals();
    if (audioEngine.isPlaying()) {
      audioEngine.hotSwap(currentCode, currentAnalysis, getPlayOptions());
    }
  }

  function toggleSolo(chId) {
    if (soloIds.has(chId)) soloIds.delete(chId);
    else soloIds.add(chId);
    renderAllVisuals();
    if (audioEngine.isPlaying()) {
      audioEngine.hotSwap(currentCode, currentAnalysis, getPlayOptions());
    }
  }

  function handleStepToggle(chId, pageIdx, stepIdx) {
    const ch = currentAnalysis.channels.find((c) => c.id === chId);
    if (!ch) return;
    const cycles = Math.max(1, ch.cycleCount || 1);
    const targetCycle = pageIdx % cycles;
    const targetStart = targetCycle + stepIdx / 16;
    const rawNotes = currentEval?.channelData?.[chId]?.notes ?? [];
    const seen = new Set();
    const curNotes =
      ch.kind === 'drum'
        ? rawNotes
            .filter((n) => {
              const key = Math.round(n.start * 64);
              if (seen.has(key)) return false;
              seen.add(key);
              return true;
            })
            .map((n) => ({ ...n, midi: 60 }))
        : [...rawNotes];

    const matchIdx = curNotes.findIndex(
      (n) => Math.abs(n.start - targetStart) < 0.025,
    );
    let nextNotes;
    if (matchIdx >= 0) {
      nextNotes = curNotes.filter((n) => Math.abs(n.start - targetStart) >= 0.025);
    } else {
      nextNotes = [
        ...curNotes,
        { start: targetStart, duration: 1 / 16, midi: 60, velocity: 0.9 },
      ];
      audioEngine.previewNote(ch, 60, 0.14);
    }

    const res = patchChannelNotes(currentCode, currentAnalysis, chId, nextNotes, cycles);
    applyVisualPatch(res);
  }

  function handleParamEdit(chId, param, value, { commit }) {
    if (!commit) {
      if (!preDragSnapshot) {
        preDragSnapshot = currentCode;
      }
      clearTimeout(sliderThrottleTimer);
      sliderThrottleTimer = setTimeout(() => {
        const res = patchChannelParam(currentCode, currentAnalysis, chId, param, value);
        applyVisualPatch(res, { recordUndo: false });
      }, 65);
      return;
    }

    clearTimeout(sliderThrottleTimer);
    const snap = preDragSnapshot || currentCode;
    preDragSnapshot = null;

    const res = patchChannelParam(currentCode, currentAnalysis, chId, param, value);
    if (res && res.code !== snap) {
      undoStack.push(snap);
      if (undoStack.length > 60) undoStack.shift();
    }
    applyVisualPatch(res, { recordUndo: false });
  }

  function handleMasterGain(value, { commit }) {
    if (!commit) {
      if (!preDragSnapshot) preDragSnapshot = currentCode;
      clearTimeout(sliderThrottleTimer);
      sliderThrottleTimer = setTimeout(() => {
        applyVisualPatch(patchMasterPostgain(currentCode, currentAnalysis, value), {
          recordUndo: false,
        });
      }, 65);
      return;
    }
    clearTimeout(sliderThrottleTimer);
    const snap = preDragSnapshot || currentCode;
    preDragSnapshot = null;
    const res = patchMasterPostgain(currentCode, currentAnalysis, value);
    if (res && res.code !== snap) {
      undoStack.push(snap);
      if (undoStack.length > 60) undoStack.shift();
    }
    applyVisualPatch(res, {
      recordUndo: false,
    });
  }

  // Instantiate all 5 panes
  const playlist = createPlaylistView(rootEl.querySelector('#daw-playlist-pane'), {
    onToggleCell: (secIdx, chId, enable) =>
      applyVisualPatch(patchPlaylistToggleChannel(currentCode, currentAnalysis, secIdx, chId, enable)),
    onResizeSection: (secIdx, bars) =>
      applyVisualPatch(patchPlaylistResizeSection(currentCode, currentAnalysis, secIdx, bars)),
    onSplitSection: (secIdx) =>
      applyVisualPatch(patchPlaylistSplitSection(currentCode, currentAnalysis, secIdx)),
    onDuplicateSection: (secIdx) =>
      applyVisualPatch(patchPlaylistDuplicateSection(currentCode, currentAnalysis, secIdx)),
    onDeleteSection: (secIdx) =>
      applyVisualPatch(patchPlaylistDeleteSection(currentCode, currentAnalysis, secIdx)),
    onAddSection: () =>
      applyVisualPatch(patchPlaylistAddSection(currentCode, currentAnalysis, 4)),
    onFocusChannel: focusChannel,
    onToggleMute: toggleMute,
    onToggleSolo: toggleSolo,
    onSeek(bar) {
      const clamped = clamp(bar, 0, Math.max(0, currentAnalysis.totalBars - 1));
      audioEngine.setPausedBar(clamped);
      updatePlayheadUi(clamped, audioEngine.isPlaying());
      if (audioEngine.isPlaying()) {
        audioEngine.startFromBar(currentCode, currentAnalysis, getPlayOptions(), clamped);
      }
    },
    onSetLoop(enabled, start, end) {
      loopRange = { enabled, start, end };
      renderAllVisuals();
      if (audioEngine.isPlaying()) {
        audioEngine.hotSwap(currentCode, currentAnalysis, getPlayOptions());
      }
    },
  });

  const channelRack = createChannelRackView(rootEl.querySelector('#daw-rack-pane'), {
    onToggleStep: handleStepToggle,
    onSelectChannel: focusChannel,
    onToggleMute: toggleMute,
    onToggleSolo: toggleSolo,
    onParamChange: handleParamEdit,
    onBarPageChange(nextPage) {
      barPage = nextPage;
    },
    async onAddChannel(presetKey) {
      const res = patchAddChannel(currentCode, currentAnalysis, presetKey);
      if (res.addedChannelId) {
        selectedChannelId = res.addedChannelId;
      }
      await applyVisualPatch(res);
    },
    async onUploadVocal(file) {
      try {
        await audioEngine.loadCustomVocalFile(file);
        renderAllVisuals();
        if (audioEngine.isPlaying()) {
          await audioEngine.hotSwap(currentCode, currentAnalysis, getPlayOptions());
        }
      } catch (err) {
        codePanel.setSyncState({ error: err?.message || 'Error cargando pista vocal' });
      }
    },
  });

  const pianoRoll = createPianoRollView(rootEl.querySelector('#daw-piano-pane'), {
    onSelectChannel: (chId) => focusChannel(chId),
    onPreviewNote: (ch, midi, dur) => audioEngine.previewNote(ch, midi, dur),
    onCommitNotes(chId, notes, cycles) {
      const res = patchChannelNotes(currentCode, currentAnalysis, chId, notes, cycles);
      applyVisualPatch(res);
    },
    onSeparateShared(chId) {
      const res = patchSeparateSharedSource(currentCode, currentAnalysis, chId);
      applyVisualPatch(res);
    },
  });

  const mixer = createMixerView(rootEl.querySelector('#daw-mixer-pane'), {
    onSelectChannel: (chId) => focusChannel(chId),
    onToggleMute: toggleMute,
    onToggleSolo: toggleSolo,
    onParamChange: handleParamEdit,
    onMasterGainChange: handleMasterGain,
  });

  const codePanel = createCodePanelView(rootEl.querySelector('#daw-code-pane'), {
    onUserCodeEdit(newCode, { autoSync }) {
      currentCode = newCode;
      if (!autoSync) return;
      clearTimeout(codeEditDebounce);
      codeEditDebounce = setTimeout(() => {
        syncFromCode(newCode, { triggerHotSwap: true });
      }, 220);
    },
    onApplyCode(newCode) {
      clearTimeout(codeEditDebounce);
      syncFromCode(newCode, { triggerHotSwap: true });
    },
    onUndoVisual: undoVisual,
    onResetProject() {
      undoStack.push(currentCode);
      currentCode = currentProject.source;
      codePanel.setCode(currentCode, { fromVisual: true });
      syncFromCode(currentCode, { triggerHotSwap: true });
    },
    onOpenRepl(code) {
      const hash = code2hash(code);
      window.open(`${cleanBase}/#${hash}`, '_blank', 'noopener');
    },
  });

  // Playhead 60fps loop
  function updatePlayheadUi(bar, playing) {
    lcdPosEl.textContent = formatBarLcd(bar);
    const seconds = (bar * 240 / currentAnalysis.bpm).toFixed(3);
    elapsedEl.textContent = `${seconds} s`;
    if (!cueLink.hidden && !playing) {
      cueLink.href = `${cleanBase}/studio/entrada/?t=${seconds}`;
    }
    playlist.updatePlayhead(bar);
    channelRack.updateStepIndicator(bar, playing);
    pianoRoll.updatePlayhead(bar, playing);
    mixer.updateMeter(audioEngine.getAudioLevels());
  }

  function startPlayheadLoop() {
    stopPlayheadLoop();
    const tick = () => {
      if (!audioEngine.isPlaying()) return;
      const bar = audioEngine.getCurrentBar();
      updatePlayheadUi(bar, true);
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
  }

  function stopPlayheadLoop() {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = null;
    updatePlayheadUi(audioEngine.getPausedBar(), false);
  }

  // Initial population
  codePanel.setCode(currentCode, { fromVisual: true, scrollToChange: false });
  renderAllVisuals();
  codePanel.setSyncState({ error: null, undoCount: 0 });
  if (window.innerWidth < 1024) {
    setLayoutState('rack', 'rack');
  }

  // Topbar bindings
  projectSelectEl.addEventListener('change', async () => {
    const nextProj = getDawProject(projectSelectEl.value);
    if (audioEngine.isPlaying()) audioEngine.stop();
    undoStack.length = 0;
    mutedIds.clear();
    soloIds.clear();
    loopRange = { enabled: false, start: 0, end: 8 };
    barPage = 0;
    currentProject = nextProj;
    cueLink.hidden = nextProj.id !== 'salgo-progresiva';
    currentCode = nextProj.source;
    const nextAnalysis = analyzeStrudelSource(currentCode);
    transportMode = nextAnalysis.hasArrange ? 'SONG' : 'PAT';
    selectedChannelId =
      nextAnalysis.channels.find((c) => c.id === 'lead')?.id ??
      nextAnalysis.channels.find((c) => !c.isVocal)?.id ??
      nextAnalysis.channels[0]?.id ??
      null;
    codePanel.setCode(currentCode, { fromVisual: true, scrollToChange: false });
    await syncFromCode(currentCode, { triggerHotSwap: false });
    updatePlayheadUi(0, false);

    // Sync URL query param smoothly without reload
    try {
      const url = new URL(window.location.href);
      url.searchParams.set('v', nextProj.id);
      window.history.replaceState({}, '', url);
    } catch {
      // Ignore history restrictions
    }
  });

  rootEl.querySelectorAll('[data-transport-mode]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const nextMode = btn.dataset.transportMode;
      if (nextMode === transportMode) return;
      transportMode = nextMode;
      renderAllVisuals();
      if (audioEngine.isPlaying()) {
        await audioEngine.startFromBar(
          currentCode,
          currentAnalysis,
          getPlayOptions(),
          transportMode === 'PAT' ? 0 : audioEngine.getCurrentBar(),
        );
      }
    });
  });

  playBtn.addEventListener('click', async () => {
    if (audioEngine.isPlaying()) {
      audioEngine.pause();
    } else {
      const startBar = transportMode === 'PAT' ? 0 : audioEngine.getPausedBar();
      await audioEngine.startFromBar(currentCode, currentAnalysis, getPlayOptions(), startBar);
    }
  });

  stopBtn.addEventListener('click', () => {
    audioEngine.stop();
    updatePlayheadUi(0, false);
  });

  const commitBpm = (nextBpm) => {
    const clean = clamp(Number(nextBpm) || 132, 40, 260);
    applyVisualPatch(patchBpm(currentCode, currentAnalysis, clean));
  };
  bpmInputEl.addEventListener('change', () => commitBpm(bpmInputEl.value));
  rootEl.querySelector('#daw-bpm-dec').addEventListener('click', () => {
    commitBpm((currentAnalysis.bpm || 132) - 1);
  });
  rootEl.querySelector('#daw-bpm-inc').addEventListener('click', () => {
    commitBpm((currentAnalysis.bpm || 132) + 1);
  });

  rootEl.querySelectorAll('[data-layout-tab]').forEach((btn) => {
    btn.addEventListener('click', () => setLayoutState(btn.dataset.layoutTab));
  });

  rootEl.querySelectorAll('[data-subtab-btn]').forEach((btn) => {
    btn.addEventListener('click', () => setLayoutState(layoutMode, btn.dataset.subtabBtn));
  });

  rootEl.querySelector('#daw-desktop-code-toggle').addEventListener('click', (e) => {
    desktopCodeVisible = !desktopCodeVisible;
    workspaceEl.classList.toggle('is-code-hidden', !desktopCodeVisible);
    e.currentTarget.classList.toggle('is-active', desktopCodeVisible);
  });

  rootEl.querySelector('#daw-mobile-code-btn').addEventListener('click', (e) => {
    mobileCodeActive = !mobileCodeActive;
    workspaceEl.classList.toggle('is-mobile-code', mobileCodeActive);
    e.currentTarget.classList.toggle('is-active', mobileCodeActive);
  });

  // Global keyboard shortcuts (Spacebar = Play/Pause, Ctrl/Cmd+Z = Undo Visual outside editor)
  const onKeyDown = (e) => {
    const insideEditor = e.target?.closest?.('.cm-editor');
    const tag = e.target?.tagName;
    const isInput = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || insideEditor;
    if (e.code === 'Space' && !isInput) {
      e.preventDefault();
      playBtn.click();
      return;
    }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z' && !e.shiftKey && !insideEditor) {
      if (undoStack.length) {
        e.preventDefault();
        undoVisual();
      }
    }
  };
  window.addEventListener('keydown', onKeyDown);

  return {
    getCode: () => currentCode,
    getAnalysis: () => currentAnalysis,
    destroy() {
      stopPlayheadLoop();
      audioEngine.stop();
      window.removeEventListener('keydown', onKeyDown);
      codePanel.destroy();
    },
  };
}
