import { Annotation, EditorState, RangeSetBuilder, StateEffect, StateField } from '@codemirror/state';
import { Decoration, EditorView, highlightActiveLine, keymap, lineNumbers } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { bracketMatching } from '@codemirror/language';
import { javascript } from '@codemirror/lang-javascript';
import { themes } from '@strudel/codemirror';

const visualOriginAnnotation = Annotation.define();
const setFlashRangesEffect = StateEffect.define();

const flashDecorationField = StateField.define({
  create() {
    return Decoration.none;
  },
  update(decorations, tr) {
    decorations = decorations.map(tr.changes);
    for (const eff of tr.effects) {
      if (eff.is(setFlashRangesEffect)) {
        const builder = new RangeSetBuilder();
        const doc = tr.state.doc;
        const linesSeen = new Set();
        for (const [rawFrom, rawTo] of eff.value || []) {
          const from = Math.max(0, Math.min(doc.length, rawFrom));
          const to = Math.max(from, Math.min(doc.length, rawTo));
          const startLine = doc.lineAt(from).number;
          const endLine = doc.lineAt(to).number;
          for (let ln = startLine; ln <= endLine; ln++) {
            if (linesSeen.has(ln)) continue;
            linesSeen.add(ln);
            const lineObj = doc.line(ln);
            builder.add(
              lineObj.from,
              lineObj.from,
              Decoration.line({ attributes: { class: 'cm-visual-flash' } }),
            );
          }
        }
        return builder.finish();
      }
    }
    return decorations;
  },
  provide: (f) => EditorView.decorations.from(f),
});

const flEditorTheme = EditorView.theme(
  {
    '&': {
      height: '100%',
      fontSize: '12.5px',
      fontFamily: '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
      backgroundColor: '#11141a',
    },
    '.cm-scroller': {
      overflow: 'auto',
      lineHeight: '1.55',
    },
    '.cm-gutters': {
      backgroundColor: '#151922',
      color: '#5c667a',
      borderRight: '1px solid rgba(255,255,255,0.06)',
    },
    '.cm-activeLine': {
      backgroundColor: 'rgba(255, 147, 79, 0.06)',
    },
    '.cm-visual-flash': {
      backgroundColor: 'rgba(255, 147, 79, 0.22) !important',
      boxShadow: 'inset 3px 0 0 #ff934f',
      transition: 'background-color 0.5s ease',
    },
  },
  { dark: true },
);

/**
 * Interactive CodeMirror 6 Strudel Live Editor Panel.
 * Synchronizes bidirectionally with all visual DAW views without circular feedback loops,
 * highlights AST-modified lines when visual tools edit the track, and exposes undo/copy/REPL actions.
 */
export function createCodePanelView(container, callbacks) {
  let autoSync = true;
  let clearFlashTimer = null;
  let errorMsg = null;
  let syncStatusEl = null;
  let editorMountEl = null;
  let editorView = null;
  let undoBtn = null;

  container.innerHTML = `
    <div class="pane-toolbar code-toolbar">
      <div class="pane-title-group">
        <span class="pane-title">CÓDIGO STRUDEL EN VIVO</span>
        <span class="code-sync-pill is-ok" id="code-sync-status" role="status">● Sincronizado</span>
      </div>
      <div class="pane-actions">
        <label class="fl-toggle-check" title="Traducir automáticamente cada cambio de código al DAW visual">
          <input type="checkbox" id="code-auto-sync" checked />
          <span>Auto-Sync</span>
        </label>
        <button type="button" class="fl-btn fl-btn-xs" data-action="undo-visual" id="code-undo-btn" title="Deshacer último cambio visual (Ctrl/Cmd+Z)">↩ Deshacer</button>
        <button type="button" class="fl-btn fl-btn-xs fl-btn-accent" data-action="apply-code" title="Aplicar y evaluar código (Ctrl/Cmd+Enter)">▶ Aplicar</button>
        <button type="button" class="fl-btn fl-btn-xs" data-action="copy-code" id="code-copy-btn" title="Copiar código Strudel">📋 Copiar</button>
        <button type="button" class="fl-btn fl-btn-xs" data-action="reset-project" title="Restaurar versión original del proyecto">↺ Reset</button>
        <button type="button" class="fl-btn fl-btn-xs" data-action="open-repl" title="Abrir este código en el REPL completo de Strudel">REPL ↗</button>
      </div>
    </div>
    <div class="code-error-bar" id="code-error-bar" hidden></div>
    <div class="code-cm-mount" id="code-cm-mount"></div>
  `;

  syncStatusEl = container.querySelector('#code-sync-status');
  undoBtn = container.querySelector('#code-undo-btn');
  const errorBarEl = container.querySelector('#code-error-bar');
  editorMountEl = container.querySelector('#code-cm-mount');

  function setStatus(statusText, isError = false) {
    if (!syncStatusEl) return;
    syncStatusEl.textContent = isError ? `⚠ ${statusText}` : `● ${statusText}`;
    syncStatusEl.classList.toggle('is-err', isError);
    syncStatusEl.classList.toggle('is-ok', !isError);
    if (errorBarEl) {
      if (isError && errorMsg) {
        errorBarEl.hidden = false;
        errorBarEl.textContent = errorMsg;
      } else {
        errorBarEl.hidden = true;
        errorBarEl.textContent = '';
      }
    }
  }

  const updateListener = EditorView.updateListener.of((update) => {
    if (!update.docChanged) return;
    const isVisual = update.transactions.some((tr) => tr.annotation(visualOriginAnnotation));
    if (isVisual) return;
    const newCode = update.state.doc.toString();
    callbacks.onUserCodeEdit?.(newCode, { autoSync });
  });

  const evalKeymap = keymap.of([
    {
      key: 'Mod-Enter',
      run(view) {
        callbacks.onApplyCode?.(view.state.doc.toString());
        return true;
      },
    },
  ]);

  const initialState = EditorState.create({
    doc: '',
    extensions: [
      lineNumbers(),
      highlightActiveLine(),
      history(),
      bracketMatching(),
      javascript(),
      themes.tokyoNight,
      flEditorTheme,
      flashDecorationField,
      evalKeymap,
      keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
      EditorView.lineWrapping,
      updateListener,
    ],
  });

  editorView = new EditorView({
    state: initialState,
    parent: editorMountEl,
  });

  container.addEventListener('change', (e) => {
    if (e.target.id === 'code-auto-sync') {
      autoSync = e.target.checked;
    }
  });

  container.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    if (action === 'apply-code') {
      callbacks.onApplyCode?.(editorView.state.doc.toString());
    } else if (action === 'undo-visual') {
      callbacks.onUndoVisual?.();
    } else if (action === 'reset-project') {
      callbacks.onResetProject?.();
    } else if (action === 'open-repl') {
      callbacks.onOpenRepl?.(editorView.state.doc.toString());
    } else if (action === 'copy-code') {
      try {
        await navigator.clipboard.writeText(editorView.state.doc.toString());
        btn.textContent = '✓ Copiado';
        setTimeout(() => {
          btn.textContent = '📋 Copiar';
        }, 1200);
      } catch {
        // Fallback if clipboard blocked
      }
    }
  });

  return {
    getValue() {
      return editorView.state.doc.toString();
    },
    setCode(newCode, { fromVisual = false, changedRanges = [], scrollToChange = true } = {}) {
      const cur = editorView.state.doc.toString();
      if (cur === newCode) return;

      const effects = [];
      if (fromVisual && changedRanges?.length) {
        effects.push(setFlashRangesEffect.of(changedRanges));
        const targetPos = Math.max(0, Math.min(newCode.length, changedRanges[0][0]));
        if (scrollToChange && !editorView.hasFocus) {
          effects.push(EditorView.scrollIntoView(targetPos, { y: 'center' }));
        }
      }

      editorView.dispatch({
        changes: { from: 0, to: cur.length, insert: newCode },
        annotations: fromVisual ? visualOriginAnnotation.of(true) : undefined,
        effects,
      });

      if (fromVisual && changedRanges?.length) {
        clearTimeout(clearFlashTimer);
        clearFlashTimer = setTimeout(() => {
          editorView.dispatch({ effects: setFlashRangesEffect.of([]) });
        }, 900);
      }
    },
    setSyncState({ error = null, undoCount = 0 } = {}) {
      errorMsg = error;
      if (error) {
        setStatus('Error de sintaxis / patrón', true);
      } else {
        setStatus('Sincronizado', false);
      }
      if (undoBtn) {
        undoBtn.disabled = undoCount <= 0;
        undoBtn.title = undoCount > 0 ? `Deshacer cambio visual (${undoCount})` : 'Nada que deshacer';
      }
    },
    focus() {
      editorView.focus();
    },
    destroy() {
      clearTimeout(clearFlashTimer);
      editorView.destroy();
    },
  };
}
