import { clamp, escapeAttr, escapeHtml, formatDb } from './ui-utils.mjs';

/**
 * Interactive FL Studio Mixer Console component.
 * Provides Master postgain + real-time VU meter + per-channel Mute/Solo, Pan,
 * vertical Gain/Postgain fader, and LPF / HPF / Room / Delay effect controls.
 */
export function createMixerView(container, callbacks) {
  let currentAnalysis = null;
  let currentState = {
    selectedChannelId: null,
    mutedIds: new Set(),
    soloIds: new Set(),
  };
  let masterVuFillEl = null;
  let masterPeakEl = null;
  let stripsScrollEl = null;

  function render() {
    if (!currentAnalysis) return;
    const prevScrollLeft = stripsScrollEl?.scrollLeft ?? 0;
    const { channels, masterPostgain } = currentAnalysis;
    const hasSolo = currentState.soloIds.size > 0;
    const masterGain = clamp(masterPostgain ?? 0.86, 0, 1.5);

    const stripsHtml = channels
      .map((ch, idx) => {
        const isMuted = currentState.mutedIds.has(ch.id);
        const isSolo = currentState.soloIds.has(ch.id);
        const isSilenced = hasSolo ? !isSolo : isMuted;
        const isSelected = currentState.selectedChannelId === ch.id;
        const gain = clamp(ch.effectiveGain ?? 0.75, 0, 1.4);
        const pan = clamp(ch.params?.pan?.numericValue ?? 0, -1, 1);
        const lpf = clamp(ch.params?.lpf?.numericValue ?? 12000, 100, 18000);
        const hpf = clamp(ch.params?.hpf?.numericValue ?? 20, 20, 8000);
        const room = clamp(ch.params?.room?.numericValue ?? 0, 0, 1);
        const delay = clamp(ch.params?.delay?.numericValue ?? 0, 0, 1);

        return `
          <div class="mx-strip ${isSelected ? 'is-selected' : ''} ${isSilenced ? 'is-muted' : ''}" data-ch-id="${escapeAttr(ch.id)}">
            <div class="mx-strip-top" style="border-top:3px solid ${ch.color}">
              <span class="mx-insert-num">IN ${idx + 1}</span>
              <div class="mx-leds">
                <button type="button" class="fl-led fl-led-sm ${isMuted ? 'is-off' : 'is-green'}" data-action="mute" data-ch-id="${escapeAttr(ch.id)}" aria-label="Silenciar ${escapeAttr(ch.label)}" title="Mute"></button>
                <button type="button" class="fl-led fl-led-sm ${isSolo ? 'is-amber' : 'is-off'}" data-action="solo" data-ch-id="${escapeAttr(ch.id)}" aria-label="Solo ${escapeAttr(ch.label)}" title="Solo">S</button>
              </div>
            </div>
            <button type="button" class="mx-chan-name" data-action="select-channel" data-ch-id="${escapeAttr(ch.id)}" title="${escapeAttr(ch.label)}">
              ${escapeHtml(ch.label)}
            </button>

            <div class="mx-pan-row">
              <span class="mx-micro-lbl">PAN</span>
              <input type="range" class="fl-mini-slider" data-action="param" data-param="pan" data-ch-id="${escapeAttr(ch.id)}" min="-1" max="1" step="0.05" value="${pan}" aria-label="Paneo ${escapeAttr(ch.label)}" />
            </div>

            <div class="mx-fader-wrap">
              <input type="range" class="mx-vfader" orient="vertical" data-action="param" data-param="gain" data-ch-id="${escapeAttr(ch.id)}" min="0" max="1.4" step="0.02" value="${gain}" aria-label="Volumen ${escapeAttr(ch.label)}" />
            </div>
            <div class="mx-db" data-readout="gain-${escapeAttr(ch.id)}">${formatDb(gain)}</div>

            <div class="mx-fx-rack">
              <label class="mx-fx-item" title="Filtro pasa bajos (.lpf)">
                <span>LPF <strong data-readout="lpf-${escapeAttr(ch.id)}">${Math.round(lpf)}</strong></span>
                <input type="range" class="fl-mini-slider" data-action="param" data-param="lpf" data-ch-id="${escapeAttr(ch.id)}" min="100" max="18000" step="50" value="${lpf}" />
              </label>
              <label class="mx-fx-item" title="Filtro pasa altos (.hpf)">
                <span>HPF <strong data-readout="hpf-${escapeAttr(ch.id)}">${Math.round(hpf)}</strong></span>
                <input type="range" class="fl-mini-slider" data-action="param" data-param="hpf" data-ch-id="${escapeAttr(ch.id)}" min="20" max="8000" step="20" value="${hpf}" />
              </label>
              <label class="mx-fx-item" title="Reverberación (.room)">
                <span>ROOM <strong data-readout="room-${escapeAttr(ch.id)}">${room.toFixed(2)}</strong></span>
                <input type="range" class="fl-mini-slider" data-action="param" data-param="room" data-ch-id="${escapeAttr(ch.id)}" min="0" max="1" step="0.02" value="${room}" />
              </label>
              <label class="mx-fx-item" title="Delay (.delay)">
                <span>DLY <strong data-readout="delay-${escapeAttr(ch.id)}">${delay.toFixed(2)}</strong></span>
                <input type="range" class="fl-mini-slider" data-action="param" data-param="delay" data-ch-id="${escapeAttr(ch.id)}" min="0" max="1" step="0.02" value="${delay}" />
              </label>
            </div>
          </div>
        `;
      })
      .join('');

    container.innerHTML = `
      <div class="pane-toolbar">
        <div class="pane-title-group">
          <span class="pane-title">MIXER · Consola</span>
          <span class="pane-meta">Master .postgain + Inserts</span>
        </div>
      </div>
      <div class="mx-console">
        <div class="mx-strip is-master">
          <div class="mx-strip-top" style="border-top:3px solid #ff934f">
            <span class="mx-insert-num">MASTER</span>
          </div>
          <div class="mx-chan-name is-master-name">Salida</div>
          <div class="mx-master-meter-row">
            <div class="mx-vu-track" aria-hidden="true">
              <div class="mx-vu-fill" id="mx-vu-fill"></div>
              <div class="mx-vu-peak" id="mx-vu-peak"></div>
            </div>
            <div class="mx-fader-wrap">
              <input type="range" class="mx-vfader is-master-fader" orient="vertical" data-action="master-gain" min="0" max="1.5" step="0.02" value="${masterGain}" aria-label="Volumen Master (.postgain)" />
            </div>
          </div>
          <div class="mx-db" data-readout="master">${formatDb(masterGain)}</div>
          <div class="mx-master-hint">.postgain(${masterGain.toFixed(2)})</div>
        </div>
        <div class="mx-strips-scroll" id="mx-strips-scroll">
          ${stripsHtml}
        </div>
      </div>
    `;

    masterVuFillEl = container.querySelector('#mx-vu-fill');
    masterPeakEl = container.querySelector('#mx-vu-peak');
    stripsScrollEl = container.querySelector('#mx-strips-scroll');
    if (stripsScrollEl) {
      stripsScrollEl.scrollLeft = prevScrollLeft;
    }
  }

  function updateMeter(levels) {
    if (!masterVuFillEl || !masterPeakEl) return;
    const pct = clamp(Math.round((levels?.rms ?? 0) * 100), 0, 100);
    const peakPct = clamp(Math.round((levels?.peak ?? 0) * 100), 0, 100);
    masterVuFillEl.style.height = `${pct}%`;
    masterPeakEl.style.bottom = `${peakPct}%`;
  }

  function updateLocalReadout(target) {
    const action = target.dataset.action;
    const val = Number(target.value);
    if (action === 'master-gain') {
      const el = container.querySelector('[data-readout="master"]');
      if (el) el.textContent = formatDb(val);
      const hint = container.querySelector('.mx-master-hint');
      if (hint) hint.textContent = `.postgain(${val.toFixed(2)})`;
      return;
    }
    if (action === 'param') {
      const chId = target.dataset.chId;
      const param = target.dataset.param;
      const el = container.querySelector(`[data-readout="${CSS.escape(param)}-${CSS.escape(chId)}"]`);
      if (el) {
        el.textContent =
          param === 'gain'
            ? formatDb(val)
            : param === 'lpf' || param === 'hpf'
              ? String(Math.round(val))
              : val.toFixed(2);
      }
    }
  }

  container.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    if (action === 'mute') callbacks.onToggleMute?.(btn.dataset.chId);
    else if (action === 'solo') callbacks.onToggleSolo?.(btn.dataset.chId);
    else if (action === 'select-channel') callbacks.onSelectChannel?.(btn.dataset.chId);
  });

  container.addEventListener('input', (e) => {
    const target = e.target;
    updateLocalReadout(target);
    if (target.dataset.action === 'master-gain') {
      callbacks.onMasterGainChange?.(Number(target.value), { commit: false });
    } else if (target.dataset.action === 'param') {
      callbacks.onParamChange?.(target.dataset.chId, target.dataset.param, Number(target.value), { commit: false });
    }
  });

  container.addEventListener('change', (e) => {
    const target = e.target;
    updateLocalReadout(target);
    if (target.dataset.action === 'master-gain') {
      callbacks.onMasterGainChange?.(Number(target.value), { commit: true });
    } else if (target.dataset.action === 'param') {
      callbacks.onParamChange?.(target.dataset.chId, target.dataset.param, Number(target.value), { commit: true });
    }
  });

  return {
    update(analysis, state = {}) {
      currentAnalysis = analysis;
      currentState = { ...currentState, ...state };
      render();
    },
    updateMeter,
  };
}
