import { parse } from 'acorn';
import { evalScope, freqToMidi, noteToMidi, silence, stack } from '@strudel/core';
import * as core from '@strudel/core';
import * as mini from '@strudel/mini';
import * as tonal from '@strudel/tonal';
import { transpiler } from '@strudel/transpiler';
import { CHANNEL_PALETTE } from './constants.mjs';

const NOTE_NAMES_SHARP = ['c', 'c#', 'd', 'd#', 'e', 'f', 'f#', 'g', 'g#', 'a', 'a#', 'b'];

const CHANNEL_PARAM_NAMES = new Set([
  's',
  'sound',
  'gain',
  'postgain',
  'pan',
  'lpf',
  'hpf',
  'lpq',
  'room',
  'roomsize',
  'delay',
  'delaytime',
  'delayfeedback',
  'attack',
  'decay',
  'sustain',
  'release',
  'velocity',
  'struct',
  'mask',
  'clip',
]);

const PATTERN_ROOT_FNS = new Set(['note', 's', 'sound', 'freq', 'n', 'stack', 'arrange', 'silence']);

export function midiToNoteName(midi) {
  const m = Math.round(midi);
  const name = NOTE_NAMES_SHARP[((m % 12) + 12) % 12];
  const octave = Math.floor(m / 12) - 1;
  return `${name}${octave}`;
}

export function midiToHz(midi) {
  return Math.round(440 * Math.pow(2, (midi - 69) / 12));
}

export function safeNoteToMidi(noteVal) {
  if (typeof noteVal === 'number' && Number.isFinite(noteVal)) return noteVal;
  if (typeof noteVal === 'string') {
    try {
      return noteToMidi(noteVal);
    } catch {
      return null;
    }
  }
  return null;
}

function formatNum(value, decimals = 2) {
  if (!Number.isFinite(value)) return '0';
  const rounded = Number(value.toFixed(decimals));
  if (Math.abs(rounded) < 1 && rounded > 0) {
    return String(rounded).replace(/^0\./, '.');
  }
  return String(rounded);
}

function evalNumeric(node, values = {}) {
  if (!node) return undefined;
  if (node.type === 'Literal' && typeof node.value === 'number') return node.value;
  if (node.type === 'Identifier') return values[node.name];
  if (node.type === 'UnaryExpression' && node.operator === '-') {
    const v = evalNumeric(node.argument, values);
    return Number.isFinite(v) ? -v : undefined;
  }
  if (node.type === 'BinaryExpression') {
    const a = evalNumeric(node.left, values);
    const b = evalNumeric(node.right, values);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return undefined;
    switch (node.operator) {
      case '+':
        return a + b;
      case '-':
        return a - b;
      case '*':
        return a * b;
      case '/':
        return b !== 0 ? a / b : undefined;
      default:
        return undefined;
    }
  }
  return undefined;
}

function extractStringLiteral(node) {
  if (!node) return null;
  if (node.type === 'Literal' && typeof node.value === 'string') {
    return {
      value: node.value,
      nodeRange: [node.start, node.end],
      innerRange: [node.start + 1, node.end - 1],
      quote: node.raw?.[0] ?? '"',
    };
  }
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0 && node.quasis.length === 1) {
    const quasi = node.quasis[0];
    return {
      value: quasi.value.cooked ?? quasi.value.raw,
      nodeRange: [node.start, node.end],
      innerRange: [quasi.start, quasi.end],
      quote: '`',
    };
  }
  return null;
}

function unwrapMethodChain(expr) {
  const calls = [];
  let cur = expr;
  let conditionalNode = null;

  if (cur?.type === 'ConditionalExpression' && cur.alternate?.type === 'Identifier' && cur.alternate.name === 'silence') {
    conditionalNode = cur;
    cur = cur.consequent;
  }

  while (cur?.type === 'CallExpression' && cur.callee?.type === 'MemberExpression' && cur.callee.property?.type === 'Identifier') {
    calls.push({
      method: cur.callee.property.name,
      args: cur.arguments,
      callNode: cur,
      argRange: cur.arguments.length ? [cur.arguments[0].start, cur.arguments.at(-1).end] : null,
      methodRange: [cur.callee.property.start, cur.end],
    });
    cur = cur.callee.object;
  }
  calls.reverse();
  return { root: cur, calls, conditionalNode, outerRange: [expr.start, expr.end] };
}

function collectIdentifiers(node, out = new Set()) {
  if (!node || typeof node !== 'object') return out;
  if (node.type === 'Identifier') {
    out.add(node.name);
    return out;
  }
  for (const [key, val] of Object.entries(node)) {
    if (key === 'loc' || key === 'range') continue;
    if (key === 'property' && !node.computed) continue;
    if (key === 'params') continue;
    if (Array.isArray(val)) {
      for (const item of val) collectIdentifiers(item, out);
    } else if (val && typeof val === 'object' && val.type) {
      collectIdentifiers(val, out);
    }
  }
  return out;
}

function countTopLevelAngleGroups(miniText) {
  if (typeof miniText !== 'string') return 1;
  const trimmed = miniText.trim();
  if (!trimmed.startsWith('<') || !trimmed.endsWith('>')) return 1;
  // Verify outer <...> spans the entire expression
  let depthAngle = 0;
  let depthBracket = 0;
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (ch === '[') depthBracket++;
    else if (ch === ']') depthBracket = Math.max(0, depthBracket - 1);
    else if (ch === '<') depthAngle++;
    else if (ch === '>') {
      depthAngle--;
      if (depthAngle === 0 && i < trimmed.length - 1) return 1;
    }
  }
  const inner = trimmed.slice(1, -1).trim();
  if (!inner) return 1;
  let count = 0;
  let bDepth = 0;
  let aDepth = 0;
  let inToken = false;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch === '[') {
      if (bDepth === 0 && aDepth === 0 && !inToken) {
        count++;
        inToken = true;
      }
      bDepth++;
    } else if (ch === ']') {
      bDepth = Math.max(0, bDepth - 1);
    } else if (ch === '<') {
      if (bDepth === 0 && aDepth === 0 && !inToken) {
        count++;
        inToken = true;
      }
      aDepth++;
    } else if (ch === '>') {
      aDepth = Math.max(0, aDepth - 1);
    } else if (/\s/.test(ch)) {
      if (bDepth === 0 && aDepth === 0) inToken = false;
    } else if (bDepth === 0 && aDepth === 0 && !inToken) {
      count++;
      inToken = true;
    }
  }
  return Math.max(1, count);
}

function extractParamsFromChain(calls, numericEnv = {}) {
  const params = {};
  for (const call of calls) {
    if (!CHANNEL_PARAM_NAMES.has(call.method)) continue;
    const arg0 = call.args[0];
    if (!arg0) continue;
    const str = extractStringLiteral(arg0);
    const num = evalNumeric(arg0, numericEnv);
    const isNumeric = Number.isFinite(num);
    let numericMean = num;
    if (!isNumeric && str) {
      const nums = str.value.match(/-?\d*\.?\d+/g)?.map(Number).filter(Number.isFinite);
      if (nums?.length) numericMean = nums.reduce((a, b) => a + b, 0) / nums.length;
    }
    params[call.method] = {
      method: call.method,
      value: isNumeric ? num : str ? str.value : null,
      numericValue: Number.isFinite(numericMean) ? numericMean : null,
      isNumeric,
      isPattern: Boolean(str),
      argRange: [arg0.start, arg0.end],
      callRange: [call.callNode.start, call.callNode.end],
      methodRange: call.methodRange,
      stringInfo: str,
    };
  }
  return params;
}

function formatChannelLabel(id) {
  const map = {
    bombo: 'Bombo',
    kick: 'Kick',
    bajo: 'Bajo',
    sub: 'Sub Bajo',
    acid: 'Acid Bajo',
    hats: 'Hats',
    clap: 'Clap',
    perc: 'Percusión',
    cortes: 'Cortes',
    redoble: 'Redoble',
    arp: 'Arpegio',
    lead: 'Lead / Gancho',
    eco: 'Eco / Respuesta',
    acordes: 'Acordes',
    pad: 'Piano / Pad',
    teclas: 'Teclas',
    pulsos: 'Pulsos Piano',
    contramelodia: 'Contramelodía',
    voz: 'Voz',
    vozCortes: 'Voz · Hoy sí / Gatita',
    estela: 'Estela',
    melodiaIntro: 'Melodía Intro',
    graveIntro: 'Grave Intro',
    subidaRegreso: 'Subida Regreso',
    llamada: 'Llamada',
    campana: 'Campana',
    leadB: 'Lead B',
    aire: 'Aire',
  };
  return map[id] ?? id.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase());
}

function inferChannelKind(id, params, isDrumSource) {
  const lower = id.toLowerCase();
  if (lower.includes('voz') || params.s?.value === 'voz_norost') return 'vocal';
  if (/(bombo|kick|hat|clap|perc|cortes|redoble|impacto|subida|drum|sd|bd|hh)/.test(lower) || isDrumSource) return 'drum';
  if (/(bajo|sub|acid|grave|bass)/.test(lower)) return 'bass';
  if (/(acorde|pad|tecla|pulso|piano|aire)/.test(lower)) return 'keys';
  return 'synth';
}

function extractStackDrumInfo(rootCall, numericEnv) {
  if (rootCall?.type !== 'CallExpression' || rootCall.callee?.name !== 'stack') return null;
  const layers = [];
  for (const arg of rootCall.arguments) {
    const chain = unwrapMethodChain(arg);
    const fn = chain.root?.type === 'CallExpression' ? chain.root.callee?.name : null;
    const lit = chain.root?.arguments?.[0] ? extractStringLiteral(chain.root.arguments[0]) : null;
    const params = extractParamsFromChain(chain.calls, numericEnv);
    const sLit = params.s?.stringInfo ?? (fn === 's' || fn === 'sound' ? lit : null);
    layers.push({ fn, lit, sLit, params, chain });
  }
  return layers;
}

function computeAvgGainFromStack(layers) {
  const gains = layers.map((l) => l.params.gain?.numericValue).filter(Number.isFinite);
  if (!gains.length) return 0.85;
  return Math.min(2, Math.max(0.05, gains.reduce((a, b) => a + b, 0) / gains.length));
}

function prettySectionLabel(exprText) {
  const clean = exprText.trim();
  const stackMatch = clean.match(/^stack\(([\s\S]+)\)$/);
  if (!stackMatch) {
    return clean.split('.')[0].replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase());
  }
  const parts = stackMatch[1]
    .split(',')
    .map((p) => p.trim().split('.')[0])
    .filter(Boolean);
  if (!parts.length) return 'Sección';
  if (parts.length <= 2) return parts.join(' + ');
  return `${parts[0]} + ${parts.length - 1}`;
}

/**
 * Parses and analyzes real Strudel source code into a structured DAW model
 * without altering the source text.
 */
export function analyzeStrudelSource(source) {
  const comments = [];
  const ast = parse(source, {
    ecmaVersion: 'latest',
    sourceType: 'module',
    allowAwaitOutsideFunction: true,
    ranges: true,
    locations: true,
    onComment: comments,
  });

  let title = 'Proyecto Strudel';
  for (const c of comments) {
    const m = c.value.match(/@title\s+(.+)/);
    if (m) {
      title = m[1].trim();
      break;
    }
  }

  const numericEnv = {};
  let bpm = 120;
  let bpmRange = null;
  let bpmMode = 'none'; // 'const_bpm' | 'setcpm' | 'setcps' | 'none'
  let setcpmRange = null;
  const decls = new Map();
  const helperFns = new Map();
  const labels = [];

  for (const stmt of ast.body) {
    if (stmt.type === 'VariableDeclaration') {
      for (const decl of stmt.declarations) {
        if (decl.id.type !== 'Identifier' || !decl.init) continue;
        const name = decl.id.name;
        const num = evalNumeric(decl.init, numericEnv);
        if (Number.isFinite(num)) {
          numericEnv[name] = num;
          if (name === 'bpm') {
            bpm = num;
            bpmRange = [decl.init.start, decl.init.end];
            bpmMode = 'const_bpm';
          }
        }
        if (decl.init.type === 'ArrowFunctionExpression' || decl.init.type === 'FunctionExpression') {
          const bodyNode = decl.init.body;
          if (bodyNode && bodyNode.type !== 'BlockStatement') {
            const chain = unwrapMethodChain(bodyNode);
            helperFns.set(name, {
              name,
              paramName: decl.init.params[0]?.name ?? null,
              params: extractParamsFromChain(chain.calls, numericEnv),
              node: decl.init,
            });
          }
        }
        decls.set(name, {
          name,
          init: decl.init,
          declNode: decl,
          stmtNode: stmt,
          range: [stmt.start, stmt.end],
          initRange: [decl.init.start, decl.init.end],
          chain: unwrapMethodChain(decl.init),
          deps: collectIdentifiers(decl.init),
        });
      }
    } else if (stmt.type === 'ExpressionStatement') {
      const expr = stmt.expression;
      if (expr?.type === 'CallExpression' && expr.callee?.type === 'Identifier') {
        const fn = expr.callee.name.toLowerCase();
        if (fn === 'setcpm' && expr.arguments[0]) {
          const val = evalNumeric(expr.arguments[0], numericEnv);
          if (Number.isFinite(val) && bpmMode === 'none') {
            bpm = Math.round(val * 4 * 100) / 100;
            bpmMode = 'setcpm';
            setcpmRange = [expr.arguments[0].start, expr.arguments[0].end];
          }
        } else if (fn === 'setcps' && expr.arguments[0]) {
          const val = evalNumeric(expr.arguments[0], numericEnv);
          if (Number.isFinite(val) && bpmMode === 'none') {
            bpm = Math.round(val * 240 * 100) / 100;
            bpmMode = 'setcps';
            setcpmRange = [expr.arguments[0].start, expr.arguments[0].end];
          }
        }
      }
    } else if (stmt.type === 'LabeledStatement' && stmt.body?.type === 'ExpressionStatement') {
      labels.push({
        label: stmt.label.name,
        expr: stmt.body.expression,
        stmtNode: stmt,
        range: [stmt.start, stmt.end],
        chain: unwrapMethodChain(stmt.body.expression),
      });
    }
  }

  // Locate arreglo declaration or standalone arrange() expression
  let arregloDecl = decls.get('arreglo') ?? null;
  if (!arregloDecl) {
    for (const d of decls.values()) {
      if (d.chain.root?.type === 'CallExpression' && d.chain.root.callee?.name === 'arrange') {
        arregloDecl = d;
        break;
      }
    }
  }

  const lastStmt = ast.body.at(-1);
  const finalExpr = lastStmt?.type === 'ExpressionStatement' ? lastStmt.expression : null;
  let arrangeCall = arregloDecl?.chain.root ?? null;
  let arrangeOuterChain = arregloDecl?.chain ?? null;
  if (!arrangeCall && finalExpr) {
    const fc = unwrapMethodChain(finalExpr);
    if (fc.root?.type === 'CallExpression' && fc.root.callee?.name === 'arrange') {
      arrangeCall = fc.root;
      arrangeOuterChain = fc;
    }
  }

  // Classify every variable declaration into pattern source / instrument channel / composite macro
  const patternDecls = new Map();
  for (const [name, d] of decls.entries()) {
    if (d === arregloDecl) continue;
    if (name === 'timbresCalle' || name === 'caida' || name === 'golpe' || name === 'vocalLocal' || name === 'vocalDisponible') continue;
    const root = d.chain.root;
    const isRootCall = root?.type === 'CallExpression' && root.callee?.type === 'Identifier';
    const rootFn = isRootCall ? root.callee.name : null;
    const callsHelper = isRootCall && helperFns.has(rootFn);
    const refsPatternDecl = root?.type === 'Identifier' && (decls.has(root.name) || d.chain.calls.length > 0);
    const isVocalCond = Boolean(d.chain.conditionalNode);
    if (PATTERN_ROOT_FNS.has(rootFn) || callsHelper || refsPatternDecl || isVocalCond) {
      if (helperFns.has(name)) continue;
      patternDecls.set(name, d);
    }
  }

  // Identify pure note sources (like gancho, respuesta, figura, progresion, destellos) vs instrumented channels
  // A decl is a "composite macro" if it is a stack(...) referencing at least one patternDecl,
  // OR if it's derived (e.g. kickRoto = kick.mask(...)) from another decl that already has sound/stack.
  function hasOwnSoundOrHelper(d) {
    const fn = d.chain.root?.type === 'CallExpression' ? d.chain.root.callee?.name : null;
    if (fn && (fn === 's' || fn === 'sound' || fn === 'stack' || helperFns.has(fn))) return true;
    const p = extractParamsFromChain(d.chain.calls, numericEnv);
    if (p.s || p.sound) return true;
    if (d.chain.conditionalNode) return true;
    return false;
  }

  function resolveRootPatternVar(name, seen = new Set()) {
    if (seen.has(name)) return null;
    seen.add(name);
    const d = patternDecls.get(name);
    if (!d) return null;
    const root = d.chain.root;
    if (root?.type === 'CallExpression') {
      const fn = root.callee?.name;
      if (fn && ['note', 's', 'sound', 'freq', 'n'].includes(fn)) {
        return { sourceVar: name, fn, argNode: root.arguments[0], decl: d };
      }
      if (fn && helperFns.has(fn) && root.arguments[0]?.type === 'Identifier') {
        const inner = resolveRootPatternVar(root.arguments[0].name, seen);
        if (inner) return inner;
      }
      if (fn === 'stack') {
        return { sourceVar: name, fn: 'stack', argNode: root, decl: d };
      }
    }
    if (root?.type === 'Identifier' && patternDecls.has(root.name)) {
      return resolveRootPatternVar(root.name, seen);
    }
    return null;
  }

  const macroNames = new Set();
  const variantToBase = new Map(); // e.g., kickRoto -> kick, golpeUno -> bombo, bajoMedio -> bajo
  for (const [name, d] of patternDecls.entries()) {
    const root = d.chain.root;
    if (root?.type === 'CallExpression' && root.callee?.name === 'stack') {
      const refsOtherPattern = [...d.deps].some((dep) => dep !== name && patternDecls.has(dep));
      if (refsOtherPattern) {
        macroNames.add(name);
      }
    } else if (root?.type === 'Identifier' && patternDecls.has(root.name)) {
      const target = patternDecls.get(root.name);
      if (hasOwnSoundOrHelper(target)) {
        // e.g. kickRoto = kick.mask("1 0 1 0"), golpeUno = bombo.mask(...)
        variantToBase.set(name, root.name);
        macroNames.add(name);
      }
    } else if (root?.type === 'CallExpression' && helperFns.has(root.callee?.name)) {
      // e.g. const frase = motivo.mask(...); const lead = cuerda(frase)
      // or const golpeCadaCuatro = golpeUno.mask(...)
      const arg0 = root.arguments[0];
      if (arg0?.type === 'CallExpression' && arg0.callee?.type === 'MemberExpression') {
        // handled via deps if needed
      }
    }
  }
  // Transitive variants (e.g. golpeCadaCuatro = golpeUno.mask(...) -> bombo)
  let changed = true;
  while (changed) {
    changed = false;
    for (const [name, d] of patternDecls.entries()) {
      if (variantToBase.has(name)) continue;
      const root = d.chain.root;
      if (root?.type === 'Identifier' && variantToBase.has(root.name)) {
        variantToBase.set(name, variantToBase.get(root.name));
        macroNames.add(name);
        changed = true;
      }
    }
  }

  // Collect all variables referenced in arrange(...) or finalExpr
  const arrangementUsedVars = new Set();
  function expandExprToChannels(node, out = new Map(), modifiers = []) {
    if (!node) return out;
    const chain = unwrapMethodChain(node);
    const localMods = [...modifiers];
    for (const call of chain.calls) {
      if (['mask', 'velocity', 'early', 'late', 'gain', 'postgain', 'lpf', 'hpf'].includes(call.method)) {
        localMods.push(`.${call.method}(${source.slice(call.args[0]?.start ?? call.callNode.start, call.args.at(-1)?.end ?? call.callNode.end)})`);
      }
    }
    const root = chain.root;
    if (root?.type === 'Identifier') {
      const name = root.name;
      if (name === 'silence') return out;
      if (variantToBase.has(name)) {
        const baseId = variantToBase.get(name);
        const prev = out.get(baseId) ?? { active: true, modifiers: [], via: [] };
        prev.modifiers.push(name, ...localMods);
        prev.via.push(name);
        out.set(baseId, prev);
        return out;
      }
      if (macroNames.has(name)) {
        const macroDecl = patternDecls.get(name);
        if (macroDecl) {
          return expandExprToChannels(macroDecl.init, out, localMods);
        }
      }
      if (patternDecls.has(name)) {
        arrangementUsedVars.add(name);
        const prev = out.get(name) ?? { active: true, modifiers: [], via: [] };
        prev.modifiers.push(...localMods);
        out.set(name, prev);
      }
      return out;
    }
    if (root?.type === 'CallExpression' && root.callee?.name === 'stack') {
      for (const arg of root.arguments) {
        expandExprToChannels(arg, out, localMods);
      }
      return out;
    }
    return out;
  }

  // Parse arrange(...) sections
  const sections = [];
  let totalBars = 0;
  let arrangeRange = null;
  let arrangeArgsRange = null;
  if (arrangeCall && arrangeCall.callee?.name === 'arrange') {
    arrangeRange = [arrangeCall.start, arrangeCall.end];
    if (arrangeCall.arguments.length) {
      arrangeArgsRange = [arrangeCall.arguments[0].start, arrangeCall.arguments.at(-1).end];
    }
    for (let i = 0; i < arrangeCall.arguments.length; i++) {
      const item = arrangeCall.arguments[i];
      let bars = 1;
      let barsRange = null;
      let exprNode = null;
      let tramoBpm = bpm;
      if (item.type === 'ArrayExpression' && item.elements.length >= 2) {
        bars = evalNumeric(item.elements[0], numericEnv) ?? 1;
        barsRange = [item.elements[0].start, item.elements[0].end];
        exprNode = item.elements[1];
      } else if (item.type === 'CallExpression' && item.callee?.name === 'tramo' && item.arguments.length >= 3) {
        const rawBars = evalNumeric(item.arguments[0], numericEnv) ?? 1;
        tramoBpm = evalNumeric(item.arguments[2], numericEnv) ?? bpm;
        bars = (rawBars * bpm) / tramoBpm;
        barsRange = [item.arguments[0].start, item.arguments[0].end];
        exprNode = item.arguments[1];
      } else {
        continue;
      }
      const chMap = expandExprToChannels(exprNode);
      const exprText = source.slice(exprNode.start, exprNode.end);
      sections.push({
        index: sections.length,
        startBar: totalBars,
        bars,
        endBar: totalBars + bars,
        label: prettySectionLabel(exprText),
        exprText,
        exprRange: [exprNode.start, exprNode.end],
        barsRange,
        itemRange: [item.start, item.end],
        tramoBpm,
        channels: Object.fromEntries(chMap.entries()),
      });
      totalBars += bars;
    }
  }

  // Inspect final expression (e.g. stack(arreglo, voz)) for parallel global channels
  const globalChannelIds = new Set();
  if (finalExpr && arregloDecl) {
    const fc = unwrapMethodChain(finalExpr);
    if (fc.root?.type === 'CallExpression' && fc.root.callee?.name === 'stack') {
      for (const arg of fc.root.arguments) {
        if (arg.type === 'Identifier' && arg.name !== arregloDecl.name && patternDecls.has(arg.name)) {
          globalChannelIds.add(arg.name);
          arrangementUsedVars.add(arg.name);
        }
      }
    }
  }

  // Decide final list of channels
  const channels = [];
  if (labels.length > 0 && !arrangeCall) {
    // Label-based REPL code ($: ... or drums: ...)
    let anon = 0;
    for (const lbl of labels) {
      if (lbl.label.startsWith('_') && lbl.label.length > 1) continue;
      const id = lbl.label === '$' ? `canal_${++anon}` : lbl.label;
      const rootCall = lbl.chain.root;
      const rootFn = rootCall?.type === 'CallExpression' ? rootCall.callee?.name : null;
      const strInfo = rootCall?.arguments?.[0] ? extractStringLiteral(rootCall.arguments[0]) : null;
      const params = extractParamsFromChain(lbl.chain.calls, numericEnv);
      const isStack = rootFn === 'stack';
      const stackLayers = isStack ? extractStackDrumInfo(rootCall, numericEnv) : null;
      const isDrum = rootFn === 's' || rootFn === 'sound' || (isStack && stackLayers?.every((l) => l.fn === 's' || l.fn === 'sound' || l.fn === 'freq'));
      channels.push({
        id,
        label: formatChannelLabel(id),
        color: CHANNEL_PALETTE[channels.length % CHANNEL_PALETTE.length],
        kind: inferChannelKind(id, params, isDrum),
        isLabel: true,
        rawLabel: lbl.label,
        isStack,
        stackLayers,
        isVocal: false,
        params,
        inheritedParams: {},
        patternSource: {
          kind: isStack ? 'stack' : rootFn ?? 'note',
          sourceVar: null,
          stringInfo: strInfo,
          sharedWith: [],
        },
        cycleCount: strInfo ? countTopLevelAngleGroups(strInfo.value) : 1,
        definitionRange: lbl.range,
        exprRange: lbl.chain.outerRange,
        chainTailPos: lbl.chain.outerRange[1],
        line: lbl.stmtNode.loc.start.line,
      });
    }
  } else {
    // Variable-declaration based Strudel song (norost, salgo, starter)
    for (const [name, d] of patternDecls.entries()) {
      if (macroNames.has(name)) continue;
      if (!hasOwnSoundOrHelper(d)) continue; // pure note source like gancho, respuesta, figura, progresion, destellos
      if (arrangeCall && arrangementUsedVars.size > 0 && !arrangementUsedVars.has(name) && name !== 'voz') {
        // Also exclude helper phrases referenced only inside another channel (e.g., frase, firma)
        const referencedByChannel = [...patternDecls.values()].some(
          (other) => other.name !== name && !macroNames.has(other.name) && other.deps.has(name),
        );
        if (referencedByChannel) continue;
      }

      const root = d.chain.root;
      const rootFn = root?.type === 'CallExpression' ? root.callee?.name : null;
      const callsHelper = Boolean(rootFn && helperFns.has(rootFn));
      const helper = callsHelper ? helperFns.get(rootFn) : null;
      const directParams = extractParamsFromChain(d.chain.calls, numericEnv);
      const inheritedParams = helper ? helper.params : {};
      const params = { ...inheritedParams, ...directParams };

      const resolved = resolveRootPatternVar(name);
      const sourceVar = resolved?.sourceVar ?? name;
      const sourceDecl = decls.get(sourceVar);
      const sourceCall = resolved?.argNode ? resolved : null;
      const strInfo = sourceCall?.argNode ? extractStringLiteral(sourceCall.argNode) : null;
      const isStack = rootFn === 'stack';
      const stackLayers = isStack ? extractStackDrumInfo(root, numericEnv) : null;
      const stackAvgGain = stackLayers ? computeAvgGainFromStack(stackLayers) : null;
      const isDrum =
        resolved?.fn === 's' ||
        resolved?.fn === 'sound' ||
        (isStack && stackLayers?.every((l) => l.fn === 's' || l.fn === 'sound' || l.fn === 'freq')) ||
        /(bombo|kick|hat|clap|perc|cortes|redoble|impacto|subida)/.test(name.toLowerCase());

      let cycleCount = strInfo ? countTopLevelAngleGroups(strInfo.value) : 1;
      if (directParams.struct?.stringInfo) {
        cycleCount = Math.max(cycleCount, countTopLevelAngleGroups(directParams.struct.stringInfo.value));
      }
      if (stackLayers) {
        for (const l of stackLayers) {
          if (l.lit) cycleCount = Math.max(cycleCount, countTopLevelAngleGroups(l.lit.value));
        }
      }

      channels.push({
        id: name,
        label: formatChannelLabel(name),
        color: CHANNEL_PALETTE[channels.length % CHANNEL_PALETTE.length],
        kind: inferChannelKind(name, params, isDrum),
        isLabel: false,
        isStack,
        stackLayers,
        stackAvgGain,
        isVocal: name.toLowerCase().includes('voz') || params.s?.value === 'voz_norost',
        isGlobal: globalChannelIds.has(name),
        callsHelper: callsHelper ? rootFn : null,
        params,
        effectiveGain:
          params.postgain?.numericValue ??
          params.gain?.numericValue ??
          stackAvgGain ??
          0.8,
        directParams,
        inheritedParams,
        patternSource: {
          kind: isStack ? 'stack' : resolved?.fn ?? 'note',
          sourceVar: sourceVar !== name ? sourceVar : null,
          sourceDeclRange: sourceDecl?.range ?? d.range,
          stringInfo: strInfo,
          sharedWith: [],
        },
        cycleCount,
        definitionRange: d.range,
        exprRange: d.initRange,
        chainTailPos: d.chain.conditionalNode ? d.chain.conditionalNode.consequent.end : d.initRange[1],
        line: d.stmtNode.loc.start.line,
      });
    }

    // Fallback: bare final pattern expression
    if (channels.length === 0 && finalExpr && !arrangeCall) {
      const fc = unwrapMethodChain(finalExpr);
      const rootFn = fc.root?.type === 'CallExpression' ? fc.root.callee?.name : null;
      const strInfo = fc.root?.arguments?.[0] ? extractStringLiteral(fc.root.arguments[0]) : null;
      const params = extractParamsFromChain(fc.calls, numericEnv);
      channels.push({
        id: 'patron',
        label: 'Patrón',
        color: CHANNEL_PALETTE[0],
        kind: inferChannelKind('patron', params, rootFn === 's' || rootFn === 'sound'),
        isLabel: false,
        isStack: rootFn === 'stack',
        stackLayers: rootFn === 'stack' ? extractStackDrumInfo(fc.root, numericEnv) : null,
        isVocal: false,
        params,
        directParams: params,
        inheritedParams: {},
        patternSource: {
          kind: rootFn ?? 'note',
          sourceVar: null,
          stringInfo: strInfo,
          sharedWith: [],
        },
        cycleCount: strInfo ? countTopLevelAngleGroups(strInfo.value) : 1,
        definitionRange: [lastStmt.start, lastStmt.end],
        exprRange: [finalExpr.start, finalExpr.end],
        chainTailPos: finalExpr.end,
        line: lastStmt.loc.start.line,
      });
    }
  }

  // Compute shared pattern sources (e.g. sub & acid sharing figura, pad & pulsos sharing progresion)
  const bySourceVar = new Map();
  for (const ch of channels) {
    const sv = ch.patternSource.sourceVar;
    if (!sv) continue;
    if (!bySourceVar.has(sv)) bySourceVar.set(sv, []);
    bySourceVar.get(sv).push(ch.id);
  }
  for (const ch of channels) {
    const sv = ch.patternSource.sourceVar;
    if (sv && bySourceVar.get(sv)?.length > 1) {
      ch.patternSource.sharedWith = bySourceVar.get(sv).filter((id) => id !== ch.id);
    }
  }

  // Master postgain on arreglo or final expression
  let masterPostgain = 1;
  let masterPostgainRange = null;
  let masterChainTail = null;
  if (arrangeOuterChain) {
    const pg = arrangeOuterChain.calls.find((c) => c.method === 'postgain');
    if (pg?.args[0]) {
      const val = evalNumeric(pg.args[0], numericEnv);
      if (Number.isFinite(val)) {
        masterPostgain = val;
        masterPostgainRange = [pg.args[0].start, pg.args[0].end];
      }
    }
    masterChainTail = arrangeOuterChain.outerRange[1];
  } else if (finalExpr) {
    const fc = unwrapMethodChain(finalExpr);
    const pg = fc.calls.find((c) => c.method === 'postgain');
    if (pg?.args[0]) {
      const val = evalNumeric(pg.args[0], numericEnv);
      if (Number.isFinite(val)) {
        masterPostgain = val;
        masterPostgainRange = [pg.args[0].start, pg.args[0].end];
      }
    }
    masterChainTail = finalExpr.end;
  }

  // Default 4-bar visual arrangement when there is no arrange() in code
  if (!sections.length && channels.length) {
    const activeChannels = {};
    for (const ch of channels) activeChannels[ch.id] = { active: true, modifiers: [] };
    sections.push({
      index: 0,
      startBar: 0,
      bars: 4,
      endBar: 4,
      label: 'Loop',
      exprText: '',
      exprRange: null,
      barsRange: null,
      itemRange: null,
      tramoBpm: bpm,
      channels: activeChannels,
    });
    totalBars = 4;
  } else if (globalChannelIds.size > 0 && sections.length) {
    for (const sec of sections) {
      for (const gId of globalChannelIds) {
        sec.channels[gId] = { active: true, modifiers: ['global'], isGlobal: true };
      }
    }
  }

  return {
    title,
    bpm,
    bpmMode,
    bpmRange,
    setcpmRange,
    cps: bpm / 240,
    masterPostgain,
    masterPostgainRange,
    masterChainTail,
    hasArrange: Boolean(arrangeCall),
    arrangeRange,
    arrangeArgsRange,
    arregloName: arregloDecl?.name ?? null,
    arregloStmtRange: arregloDecl?.range ?? null,
    finalExprRange: finalExpr ? [finalExpr.start, finalExpr.end] : null,
    channels,
    sections,
    totalBars: Math.max(1, totalBars),
    numericEnv,
    macroNames: [...macroNames],
    decls,
  };
}

let visualScopeInitialized = false;
async function ensureVisualScope() {
  if (visualScopeInitialized) return;
  await evalScope(core, mini, tonal);
  visualScopeInitialized = true;
}

/**
 * Replaces blocking network/audio calls for instant, non-blocking visual evaluation.
 */
function buildVisualEvalSource(source, analysis) {
  const ast = parse(source, {
    ecmaVersion: 'latest',
    sourceType: 'module',
    allowAwaitOutsideFunction: true,
    ranges: true,
  });

  const replacements = [];
  function visit(node) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'AwaitExpression' && node.argument?.type === 'CallExpression') {
      const fn = node.argument.callee?.name;
      if (fn === 'samples' || fn === 'loadBuffer') {
        replacements.push([node.start, node.end, 'undefined']);
        return;
      }
    }
    if (node.type === 'CallExpression' && node.callee?.type === 'Identifier') {
      const fn = node.callee.name;
      if (fn === 'registerSound' || fn === 'samples' || fn === 'loadBuffer') {
        replacements.push([node.start, node.end, 'undefined']);
        return;
      }
      if (fn === 'setcpm' || fn === 'setCpm' || fn === 'setcps' || fn === 'setCps') {
        replacements.push([node.start, node.end, 'silence']);
        return;
      }
    }
    for (const val of Object.values(node)) {
      if (Array.isArray(val)) val.forEach(visit);
      else if (val && typeof val === 'object' && val.type) visit(val);
    }
  }
  visit(ast);

  replacements.sort((a, b) => b[0] - a[0]);
  let patched = source;
  // Filter nested replacements so we never overlap splices
  let lastStart = Infinity;
  for (const [start, end, text] of replacements) {
    if (end <= lastStart) {
      patched = patched.slice(0, start) + text + patched.slice(end);
      lastStart = start;
    }
  }

  // Safely guard `location.hostname` in headless/Node contexts
  patched = patched.replace(/\blocation\.hostname\b/g, "(typeof location !== 'undefined' ? location.hostname : '')");

  // Capture all declared channel identifiers before the final statement
  const channelIds = analysis.channels.filter((c) => !c.isLabel && c.id !== 'patron').map((c) => c.id);
  const captureEntries = channelIds.map((id) => `${id}: typeof ${id} !== 'undefined' ? ${id} : undefined`);
  if (analysis.arregloName) {
    captureEntries.push(`__arreglo: typeof ${analysis.arregloName} !== 'undefined' ? ${analysis.arregloName} : undefined`);
  }
  const captureLine = `globalThis.__dawVisualCapture?.({ ${captureEntries.join(', ')} });\n`;

  const parsedPatched = parse(patched, {
    ecmaVersion: 'latest',
    sourceType: 'module',
    allowAwaitOutsideFunction: true,
    ranges: true,
  });
  const lastNode = parsedPatched.body.at(-1);
  if (lastNode && lastNode.type === 'ExpressionStatement') {
    return patched.slice(0, lastNode.start) + captureLine + patched.slice(lastNode.start);
  }
  return patched + '\n' + captureLine;
}

/**
 * Evaluates real Strudel patterns in memory (no audio side effects) and extracts
 * Piano Roll note events & 16-step grids for every channel.
 */
export async function evaluateVisualPatterns(source, analysis) {
  await ensureVisualScope();
  const captured = {};
  const labelPatterns = {};
  let anonIdx = 0;

  const prevP = core.Pattern.prototype.p;
  core.Pattern.prototype.p = function (id) {
    if (typeof id === 'string' && (id.startsWith('_') || id.endsWith('_'))) return silence;
    const key = id === '$' ? `canal_${++anonIdx}` : id;
    labelPatterns[key] = this;
    return this;
  };
  globalThis.__dawVisualCapture = (obj) => {
    Object.assign(captured, obj);
  };

  let masterPattern = silence;
  try {
    const evalSrc = buildVisualEvalSource(source, analysis);
    const transpiled = transpiler(evalSrc, {
      addReturn: true,
      emitMiniLocations: false,
      emitWidgets: false,
    });
    const fn = new Function(`"use strict"; return (async () => { ${transpiled.output} })()`);
    masterPattern = (await fn()) ?? silence;
  } finally {
    core.Pattern.prototype.p = prevP;
    delete globalThis.__dawVisualCapture;
  }

  const channelData = {};
  for (const ch of analysis.channels) {
    let pat = ch.isLabel ? labelPatterns[ch.id] : ch.id === 'patron' ? masterPattern : captured[ch.id];
    if (!pat || typeof pat.queryArc !== 'function') {
      pat = silence;
    }

    const cycles = Math.max(1, ch.cycleCount || 1);
    let haps = [];
    try {
      haps = pat.queryArc(0, cycles).filter((h) => h.hasOnset());
    } catch {
      haps = [];
    }

    const notes = [];
    let minMidi = 127;
    let maxMidi = 0;

    for (let i = 0; i < haps.length; i++) {
      const hap = haps[i];
      const val = typeof hap.value === 'object' && hap.value !== null ? hap.value : { note: hap.value };
      const begin = Number(hap.whole.begin);
      const end = Number(hap.whole.end);
      const duration = Math.max(1 / 64, end - begin);

      let midi = null;
      let noteName = '';
      if (val.note !== undefined) {
        midi = safeNoteToMidi(val.note);
        if (midi !== null) noteName = typeof val.note === 'string' ? val.note : midiToNoteName(midi);
      } else if (val.n !== undefined && typeof val.n === 'number') {
        midi = 60 + val.n;
        noteName = midiToNoteName(midi);
      } else if (val.freq !== undefined && Number.isFinite(Number(val.freq))) {
        midi = Math.round(freqToMidi(Number(val.freq)));
        noteName = `${Math.round(Number(val.freq))}Hz`;
      } else if (val.s !== undefined) {
        midi = 60;
        noteName = String(val.s);
      }

      if (midi === null || !Number.isFinite(midi)) continue;
      minMidi = Math.min(minMidi, midi);
      maxMidi = Math.max(maxMidi, midi);

      notes.push({
        id: `${ch.id}_${i}`,
        cycle: Math.floor(begin + 1e-6),
        start: begin,
        end,
        duration,
        midi,
        noteName,
        freq: val.freq !== undefined ? Number(val.freq) : null,
        sound: val.s ?? ch.params.s?.value ?? 'sawtooth',
        velocity: Number.isFinite(Number(val.velocity))
          ? Number(val.velocity)
          : Number.isFinite(Number(val.gain))
            ? Math.min(1, Number(val.gain))
            : 0.85,
        gain: Number.isFinite(Number(val.gain)) ? Number(val.gain) : null,
        pan: Number.isFinite(Number(val.pan)) ? Number(val.pan) : 0.5,
      });
    }

    // Build 16-step array per cycle for the Step Sequencer
    const stepsByCycle = Array.from({ length: cycles }, () => Array(16).fill(null));
    for (const n of notes) {
      const cyc = Math.max(0, Math.min(cycles - 1, Math.floor(n.start + 1e-6)));
      const frac = n.start - cyc;
      const step = Math.max(0, Math.min(15, Math.round(frac * 16)));
      if (!stepsByCycle[cyc][step]) {
        stepsByCycle[cyc][step] = n;
      }
    }

    channelData[ch.id] = {
      pattern: pat,
      notes,
      stepsByCycle,
      minMidi: minMidi <= maxMidi ? minMidi : 48,
      maxMidi: minMidi <= maxMidi ? maxMidi : 72,
    };
  }

  return {
    masterPattern,
    arregloPattern: captured.__arreglo ?? null,
    channelData,
  };
}

// ============================================================================
// MINI-NOTATION SERIALIZER (Piano Roll / Step Sequencer -> Real Strudel Code)
// ============================================================================

function tokenForNote(note, mode, sampleToken) {
  if (mode === 'struct') {
    return sampleToken || 'x';
  }
  if (mode === 'freq') {
    if (Number.isFinite(note.freq) && Math.abs(freqToMidi(note.freq) - note.midi) < 0.25) {
      return String(Math.round(note.freq));
    }
    return String(midiToHz(note.midi));
  }
  if (mode === 'sample') {
    return sampleToken || note.sound || 'white';
  }
  return midiToNoteName(note.midi);
}

function serializeMonophonicSpan(quantizedNotes, totalSteps, mode, sampleToken) {
  // Group simultaneous notes with identical (startStep, endStep)
  const groups = new Map();
  for (const q of quantizedNotes) {
    const key = `${q.startStep}:${q.endStep}`;
    if (!groups.has(key)) groups.set(key, { startStep: q.startStep, endStep: q.endStep, tokens: [] });
    const tok = tokenForNote(q.note, mode, sampleToken);
    if (!groups.get(key).tokens.includes(tok)) groups.get(key).tokens.push(tok);
  }
  const sorted = [...groups.values()].sort((a, b) => a.startStep - b.startStep);
  const parts = [];
  let cursor = 0;

  for (const g of sorted) {
    if (g.startStep > cursor) {
      const restLen = g.startStep - cursor;
      parts.push(restLen === 1 ? '~' : `~@${restLen}`);
      cursor = g.startStep;
    }
    const dur = Math.max(1, g.endStep - g.startStep);
    const head = g.tokens.length === 1 ? g.tokens[0] : `[${g.tokens.join(',')}]`;
    parts.push(dur === 1 ? head : `${head}@${dur}`);
    cursor = g.endStep;
  }

  if (cursor < totalSteps) {
    const tailRest = totalSteps - cursor;
    parts.push(tailRest === 1 ? '~' : `~@${tailRest}`);
  }

  if (!parts.length) return '~';
  if (parts.length === 1 && !parts[0].includes(' ')) return parts[0];
  return `[${parts.join(' ')}]`;
}

function serializeSpan(notesInSpan, spanLen, mode, sampleToken) {
  if (!notesInSpan.length) return '~';

  const isTriggerMode = mode === 'sample' || mode === 'struct';
  const candidates = spanLen < 0.5 ? [1, 2, 4, 8, 16, 32] : [1, 2, 4, 8, 16, 32, 64, 12, 24];
  const distinctOnsets = new Set(notesInSpan.map((n) => Math.round(n.relStart * 1e4))).size;
  let steps = 16;
  for (const cand of candidates) {
    const fits =
      isTriggerMode
        ? notesInSpan.every((n) => {
            const s = (n.relStart / spanLen) * cand;
            return Math.abs(s - Math.round(s)) < 0.03;
          }) &&
          new Set(
            notesInSpan.map((n) =>
              Math.max(0, Math.min(cand - 1, Math.round((n.relStart / spanLen) * cand))),
            ),
          ).size === distinctOnsets
        : notesInSpan.every((n) => {
            const s = (n.relStart / spanLen) * cand;
            const e = (n.relEnd / spanLen) * cand;
            return Math.abs(s - Math.round(s)) < 0.03 && Math.abs(e - Math.round(e)) < 0.03;
          });
    if (fits) {
      steps = cand;
      break;
    }
  }

  let quantized = notesInSpan.map((n) => {
    const startStep = Math.max(0, Math.min(steps - 1, Math.round((n.relStart / spanLen) * steps)));
    const rawEnd = isTriggerMode ? startStep + 1 : Math.round((n.relEnd / spanLen) * steps);
    const endStep = Math.max(startStep + 1, Math.min(steps, rawEnd));
    return { startStep, endStep, note: n };
  });

  if (isTriggerMode) {
    const seenSteps = new Set();
    quantized = quantized.filter((q) => {
      if (seenSteps.has(q.startStep)) return false;
      seenSteps.add(q.startStep);
      return true;
    });
  }

  // Check if all overlaps share exact startStep AND endStep (purely monophonic or block-chordal)
  let hasStaggeredOverlap = false;
  for (let i = 0; i < quantized.length && !hasStaggeredOverlap; i++) {
    for (let j = i + 1; j < quantized.length; j++) {
      const a = quantized[i];
      const b = quantized[j];
      const overlaps = a.startStep < b.endStep && b.startStep < a.endStep;
      if (overlaps && (a.startStep !== b.startStep || a.endStep !== b.endStep)) {
        hasStaggeredOverlap = true;
        break;
      }
    }
  }

  if (!hasStaggeredOverlap) {
    return serializeMonophonicSpan(quantized, steps, mode, sampleToken);
  }

  // Greedy lane packing for polyphonic staggered voices
  const sorted = [...quantized].sort((a, b) => a.startStep - b.startStep || a.note.midi - b.note.midi);
  const lanes = [];
  for (const item of sorted) {
    let placed = false;
    for (const lane of lanes) {
      const compatible = lane.every(
        (existing) =>
          existing.endStep <= item.startStep ||
          item.endStep <= existing.startStep ||
          (existing.startStep === item.startStep && existing.endStep === item.endStep),
      );
      if (compatible) {
        lane.push(item);
        placed = true;
        break;
      }
    }
    if (!placed) lanes.push([item]);
  }
  const laneStrings = lanes.map((lane) => serializeMonophonicSpan(lane, steps, mode, sampleToken));
  return `[${laneStrings.join(', ')}]`;
}

function areQuartersIdentical(notesInCycle) {
  if (!notesInCycle.length) return false;
  // Ensure no note crosses a 0.25 boundary
  for (const n of notesInCycle) {
    const qStart = Math.floor(n.relStart * 4 + 1e-5);
    const qEnd = Math.ceil(n.relEnd * 4 - 1e-5) - 1;
    if (qStart !== qEnd) return false;
  }
  const byQuarter = [[], [], [], []];
  for (const n of notesInCycle) {
    const q = Math.min(3, Math.max(0, Math.floor(n.relStart * 4 + 1e-5)));
    byQuarter[q].push({
      ...n,
      relStart: n.relStart - q * 0.25,
      relEnd: n.relEnd - q * 0.25,
    });
  }
  const sig = (list) =>
    [...list]
      .sort((a, b) => a.relStart - b.relStart || a.midi - b.midi)
      .map((n) => `${n.midi}:${n.relStart.toFixed(4)}:${n.relEnd.toFixed(4)}`)
      .join('|');
  const first = sig(byQuarter[0]);
  return Boolean(first) && byQuarter.every((q) => sig(q) === first);
}

/**
 * Converts Piano Roll / Step Sequencer note events back into clean Strudel mini-notation.
 */
export function serializeNotesToMini(notes, cycleCount, options = {}) {
  const mode = options.mode ?? (options.isDrum ? 'sample' : 'note');
  const sampleToken = options.sampleToken ?? options.drumToken ?? 'white';
  const cycles = Math.max(1, cycleCount || 1);
  const cycleStrings = [];

  for (let c = 0; c < cycles; c++) {
    const inCycle = notes
      .filter((n) => n.start >= c - 1e-4 && n.start < c + 1 - 1e-4)
      .map((n) => {
        const relStart = Math.max(0, n.start - c);
        const relEnd = Math.min(1, relStart + Math.max(1 / 64, n.duration));
        return { ...n, relStart, relEnd };
      });

    if (!inCycle.length) {
      cycleStrings.push('~');
    } else if (areQuartersIdentical(inCycle)) {
      const q0 = inCycle
        .filter((n) => n.relStart < 0.25 - 1e-5)
        .map((n) => ({ ...n, relStart: n.relStart, relEnd: Math.min(0.25, n.relEnd) }));
      const qStr = serializeSpan(q0, 0.25, mode, sampleToken);
      const wrapped = qStr.includes(' ') && !qStr.startsWith('[') ? `[${qStr}]` : qStr;
      cycleStrings.push(`${wrapped}*4`);
    } else {
      cycleStrings.push(serializeSpan(inCycle, 1, mode, sampleToken));
    }
  }

  if (cycles === 1) {
    const single = cycleStrings[0];
    // Strip outer [...] only if it doesn't have *4 and isn't stacked with commas
    if (single.startsWith('[') && single.endsWith(']') && !single.includes(',') && !single.includes('*')) {
      return single.slice(1, -1);
    }
    return single;
  }
  return `<${cycleStrings.join(' ')}>`;
}

// ============================================================================
// SOURCE CODE PATCHERS (Visual Edits -> Real Strudel Code)
// ============================================================================

function applyEdit(source, start, end, replacement, editKind) {
  const code = source.slice(0, start) + replacement + source.slice(end);
  return {
    code,
    changedRanges: [[start, start + replacement.length]],
    editKind,
  };
}

export function patchBpm(source, analysis, newBpm) {
  const cleanBpm = Math.max(40, Math.min(260, Math.round(newBpm * 10) / 10));
  if (analysis.bpmMode === 'const_bpm' && analysis.bpmRange) {
    return applyEdit(source, analysis.bpmRange[0], analysis.bpmRange[1], String(cleanBpm), 'bpm');
  }
  if (analysis.bpmMode === 'setcpm' && analysis.setcpmRange) {
    return applyEdit(source, analysis.setcpmRange[0], analysis.setcpmRange[1], `${cleanBpm} / 4`, 'bpm');
  }
  if (analysis.bpmMode === 'setcps' && analysis.setcpmRange) {
    return applyEdit(source, analysis.setcpmRange[0], analysis.setcpmRange[1], `${cleanBpm} / 240`, 'bpm');
  }
  const prefix = `const bpm = ${cleanBpm}\nsetcpm(bpm / 4)\n\n`;
  return applyEdit(source, 0, 0, prefix, 'bpm');
}

export function patchMasterPostgain(source, analysis, newGain) {
  const val = formatNum(Math.max(0, Math.min(2, newGain)), 2);
  if (analysis.masterPostgainRange) {
    return applyEdit(source, analysis.masterPostgainRange[0], analysis.masterPostgainRange[1], val, 'master');
  }
  if (analysis.masterChainTail !== null) {
    return applyEdit(source, analysis.masterChainTail, analysis.masterChainTail, `.postgain(${val})`, 'master');
  }
  return { code: source, changedRanges: [], editKind: 'master' };
}

export function patchChannelParam(source, analysis, channelId, paramName, newValue) {
  const ch = analysis.channels.find((c) => c.id === channelId);
  if (!ch) return { code: source, changedRanges: [], editKind: 'param' };

  // For stack channels or patterned gain or helper-wrapped channels without direct numeric .gain(),
  // route mixer volume edits to .postgain() so relative layer balances / accents remain intact!
  let targetMethod = paramName;
  if (paramName === 'gain') {
    const directGain = ch.directParams?.gain;
    if (!directGain || !directGain.isNumeric) {
      if (ch.isStack || ch.callsHelper || ch.params.gain?.isPattern) {
        targetMethod = 'postgain';
      }
    }
  }

  const formatted =
    targetMethod === 's' || targetMethod === 'sound'
      ? `"${String(newValue).replace(/"/g, '')}"`
      : targetMethod === 'lpf' || targetMethod === 'hpf'
        ? String(Math.round(Math.max(20, Math.min(20000, Number(newValue)))))
        : formatNum(Number(newValue), 2);

  const existing = ch.directParams?.[targetMethod] ?? (ch.isLabel ? ch.params[targetMethod] : null);
  if (existing?.argRange) {
    return applyEdit(source, existing.argRange[0], existing.argRange[1], formatted, 'param');
  }

  if (targetMethod === 's' && ch.isStack) {
    const firstSampleLayer = ch.stackLayers?.find((l) => l.sLit?.innerRange);
    if (firstSampleLayer?.sLit?.innerRange) {
      const raw = String(newValue).replace(/"/g, '');
      const cur = firstSampleLayer.sLit.value;
      const replaced = cur.replace(/[a-zA-Z_][a-zA-Z0-9_-]*/, raw);
      const [sStart, sEnd] = firstSampleLayer.sLit.innerRange;
      return applyEdit(source, sStart, sEnd, replaced, 'param');
    }
    return { code: source, changedRanges: [], editKind: 'param' };
  }

  // If this channel has a single inner s("...") call at root (e.g. s("white") -> change sound)
  if (targetMethod === 's' && ch.patternSource.kind === 's' && ch.patternSource.stringInfo && !ch.patternSource.sourceVar) {
    const raw = String(newValue).replace(/"/g, '');
    const cur = ch.patternSource.stringInfo.value;
    // Replace sound token inside the mini-notation (e.g. white -> hh or cp -> sd)
    const replaced = cur.replace(/[a-zA-Z_][a-zA-Z0-9_-]*/g, (tok) => (tok === 'x' ? tok : raw));
    const [sStart, sEnd] = ch.patternSource.stringInfo.innerRange;
    return applyEdit(source, sStart, sEnd, replaced, 'param');
  }

  return applyEdit(source, ch.chainTailPos, ch.chainTailPos, `.${targetMethod}(${formatted})`, 'param');
}

function escapeMiniForQuote(miniText, quote) {
  if (quote === '`') return miniText.replace(/`/g, '\\`');
  if (quote === "'") return miniText.replace(/'/g, "\\'");
  return miniText.replace(/"/g, '\\"');
}

export function patchChannelNotes(source, analysis, channelId, notes, cycleCount, options = {}) {
  const ch = analysis.channels.find((c) => c.id === channelId);
  if (!ch) return { code: source, changedRanges: [], editKind: 'notes' };

  // Handle drum stack channels like `bombo` or `kick` via `.struct(...)`!
  if (ch.isStack && ch.kind === 'drum') {
    const structStr = serializeNotesToMini(notes, cycleCount, { mode: 'struct', sampleToken: 'x' });
    // If stack layers have `*4` or rests inside `s("...")`/`freq("...")`, normalize them to continuous triggers so `.struct()` fires on every step!
    const decl = analysis.decls.get(ch.id);
    if (decl) {
      let updatedDeclCode = source.slice(decl.initRange[0], decl.initRange[1]);
      // Simplify *4 triggers on unison drum layers (bombo_club*4 -> bombo_club, 150*4 -> 150)
      updatedDeclCode = updatedDeclCode.replace(
        /\b(s|freq)\(\s*(['"`])([^*'"`\s]+)\*\d+\2\s*\)/g,
        '$1($2$3$2)',
      );
      if (ch.directParams?.struct?.argRange) {
        const baseDecl = source.slice(decl.initRange[0], ch.directParams.struct.argRange[0]).replace(
          /\b(s|freq)\(\s*(['"`])([^*'"`\s]+)\*\d+\2\s*\)/g,
          '$1($2$3$2)',
        );
        const tailDecl = source.slice(ch.directParams.struct.argRange[1], decl.initRange[1]);
        const newInit = `${baseDecl}"${structStr}"${tailDecl}`;
        return applyEdit(source, decl.initRange[0], decl.initRange[1], newInit, 'notes');
      }
      // If `hats` has multi-layer stack without .struct, simplify to clean 16-step pattern preserving timbre!
      if (ch.id === 'hats') {
        const hatBase = `s("${serializeNotesToMini(notes, cycleCount, { mode: 'sample', sampleToken: 'white' })}").hpf(${ch.stackLayers?.[0]?.params?.hpf?.value ?? 6700}).lpf(${ch.stackLayers?.[0]?.params?.lpf?.value ?? 12200}).attack(.002).decay(.055).sustain(0).gain(.55)`;
        return applyEdit(source, decl.initRange[0], decl.initRange[1], hatBase, 'notes');
      }
      return applyEdit(source, decl.initRange[0], decl.initRange[1], `${updatedDeclCode}.struct("${structStr}")`, 'notes');
    }
  }

  // Handle channels with `.struct(...)` modifier like `pulsos = progresion.struct("~ x ~ x")`
  if (ch.directParams?.struct?.stringInfo && options.preferStruct) {
    const structStr = serializeNotesToMini(notes, cycleCount, { mode: 'struct', sampleToken: 'x' });
    const [sStart, sEnd] = ch.directParams.struct.stringInfo.innerRange;
    return applyEdit(source, sStart, sEnd, escapeMiniForQuote(structStr, ch.directParams.struct.stringInfo.quote), 'notes');
  }

  // Standard pattern source edit (`note("...")`, `freq("...")`, `s("...")`)
  const ps = ch.patternSource;
  if (!ps.stringInfo) return { code: source, changedRanges: [], editKind: 'notes' };

  const mode = ps.kind === 'freq' ? 'freq' : ps.kind === 's' || ps.kind === 'sound' ? 'sample' : 'note';
  const sampleToken =
    ps.stringInfo.value.match(/[a-zA-Z_][a-zA-Z0-9_-]*/g)?.find((t) => t !== 'x') ?? 'white';
  const miniStr = serializeNotesToMini(notes, cycleCount, { mode, sampleToken });
  const [iStart, iEnd] = ps.stringInfo.innerRange;
  return applyEdit(source, iStart, iEnd, escapeMiniForQuote(miniStr, ps.stringInfo.quote), 'notes');
}

export function patchSeparateSharedSource(source, analysis, channelId) {
  const ch = analysis.channels.find((c) => c.id === channelId);
  if (!ch || !ch.patternSource.sourceVar || !ch.patternSource.stringInfo) {
    return { code: source, changedRanges: [], editKind: 'notes' };
  }
  const sourceVar = ch.patternSource.sourceVar;
  const decl = analysis.decls.get(ch.id);
  if (!decl) return { code: source, changedRanges: [], editKind: 'notes' };

  const noteFn = ch.patternSource.kind === 'freq' ? 'freq' : ch.patternSource.kind === 's' ? 's' : 'note';
  const rawLiteral = `${noteFn}("${escapeMiniForQuote(ch.patternSource.stringInfo.value, '"')}")`;
  const initText = source.slice(decl.initRange[0], decl.initRange[1]);
  const replaced = initText.replace(new RegExp(`\\b${sourceVar}\\b`), rawLiteral);
  return applyEdit(source, decl.initRange[0], decl.initRange[1], replaced, 'notes');
}

// ============================================================================
// PLAYLIST / ARRANGEMENT PATCHERS
// ============================================================================

function buildSectionExpr(channelIds, extras = []) {
  const items = [...channelIds, ...extras].filter(Boolean);
  if (items.length === 0) return 'silence';
  if (items.length === 1) return items[0];
  return `stack(${items.join(', ')})`;
}

export function patchPlaylistToggleChannel(source, analysis, sectionIndex, channelId, enable) {
  const sec = analysis.sections[sectionIndex];
  if (!sec) return { code: source, changedRanges: [], editKind: 'playlist' };

  // Handle global parallel track like `voz` in `stack(arreglo, voz)`
  const ch = analysis.channels.find((c) => c.id === channelId);
  if (ch?.isGlobal && analysis.finalExprRange && analysis.arregloName) {
    const finalText = source.slice(analysis.finalExprRange[0], analysis.finalExprRange[1]);
    if (enable && !finalText.includes(channelId)) {
      return applyEdit(
        source,
        analysis.finalExprRange[0],
        analysis.finalExprRange[1],
        `stack(${analysis.arregloName}, ${channelId})`,
        'playlist',
      );
    }
    if (!enable && finalText.includes(channelId)) {
      return applyEdit(
        source,
        analysis.finalExprRange[0],
        analysis.finalExprRange[1],
        analysis.arregloName,
        'playlist',
      );
    }
    return { code: source, changedRanges: [], editKind: 'playlist' };
  }

  if (!analysis.hasArrange || !sec.exprRange) return { code: source, changedRanges: [], editKind: 'playlist' };

  const currentlyActive = Boolean(sec.channels[channelId]?.active);
  if (currentlyActive === enable) return { code: source, changedRanges: [], editKind: 'playlist' };

  let nextExpr;
  if (enable) {
    const cur = sec.exprText.trim();
    if (cur === 'silence') {
      nextExpr = channelId;
    } else if (/^stack\(([\s\S]+)\)$/.test(cur)) {
      nextExpr = cur.replace(/\)$/, `, ${channelId})`);
    } else {
      nextExpr = `stack(${cur}, ${channelId})`;
    }
  } else {
    const remaining = Object.keys(sec.channels).filter((id) => id !== channelId && !sec.channels[id]?.isGlobal);
    nextExpr = buildSectionExpr(remaining);
  }

  return applyEdit(source, sec.exprRange[0], sec.exprRange[1], nextExpr, 'playlist');
}

export function patchPlaylistResizeSection(source, analysis, sectionIndex, newBars) {
  const sec = analysis.sections[sectionIndex];
  if (!sec || !sec.barsRange) return { code: source, changedRanges: [], editKind: 'playlist' };
  const cleanBars = Math.max(1, Math.min(64, Math.round(newBars)));
  return applyEdit(source, sec.barsRange[0], sec.barsRange[1], String(cleanBars), 'playlist');
}

export function patchPlaylistDuplicateSection(source, analysis, sectionIndex) {
  const sec = analysis.sections[sectionIndex];
  if (!sec || !sec.itemRange) return { code: source, changedRanges: [], editKind: 'playlist' };
  const itemText = source.slice(sec.itemRange[0], sec.itemRange[1]);
  return applyEdit(source, sec.itemRange[1], sec.itemRange[1], `,\n  ${itemText}`, 'playlist');
}

export function patchPlaylistSplitSection(source, analysis, sectionIndex, firstHalfBars) {
  const sec = analysis.sections[sectionIndex];
  if (!sec || !sec.itemRange || sec.bars <= 1) return { code: source, changedRanges: [], editKind: 'playlist' };
  const barsA = Math.max(1, Math.min(Math.floor(sec.bars) - 1, Math.round(firstHalfBars ?? Math.floor(sec.bars / 2))));
  const barsB = Math.max(1, Math.round(sec.bars) - barsA);
  const replacement = `[${barsA}, ${sec.exprText}],\n  [${barsB}, ${sec.exprText}]`;
  return applyEdit(source, sec.itemRange[0], sec.itemRange[1], replacement, 'playlist');
}

export function patchPlaylistDeleteSection(source, analysis, sectionIndex) {
  if (analysis.sections.length <= 1) return { code: source, changedRanges: [], editKind: 'playlist' };
  const sec = analysis.sections[sectionIndex];
  if (!sec || !sec.itemRange) return { code: source, changedRanges: [], editKind: 'playlist' };

  const [start, end] = sec.itemRange;
  // Also trim leading or trailing comma + whitespace cleanly
  if (sectionIndex < analysis.sections.length - 1) {
    const nextStart = analysis.sections[sectionIndex + 1].itemRange[0];
    return applyEdit(source, start, nextStart, '', 'playlist');
  }
  const prevEnd = analysis.sections[sectionIndex - 1].itemRange[1];
  return applyEdit(source, prevEnd, end, '', 'playlist');
}

export function patchPlaylistAddSection(source, analysis, bars = 4, channelIds = []) {
  if (!analysis.hasArrange || !analysis.arrangeArgsRange) return { code: source, changedRanges: [], editKind: 'playlist' };
  const defaultChs = channelIds.length
    ? channelIds
    : analysis.channels
        .filter((c) => !c.isVocal && !c.isGlobal)
        .slice(0, 3)
        .map((c) => c.id);
  const expr = buildSectionExpr(defaultChs);
  const insertPos = analysis.arrangeArgsRange[1];
  return applyEdit(source, insertPos, insertPos, `,\n  [${Math.max(1, Math.round(bars))}, ${expr}]`, 'playlist');
}

export const CHANNEL_PRESETS = {
  kick: { baseName: 'kick', label: 'Kick / Bombo', code: (n) => `const ${n} = s("bd*4").gain(.9)` },
  clap: { baseName: 'clap', label: 'Clap / Caja', code: (n) => `const ${n} = s("~ cp ~ cp").room(.18).gain(.65)` },
  hats: { baseName: 'hats', label: 'Hi-Hats', code: (n) => `const ${n} = s("[~ hh]*4").hpf(5500).gain(.42)` },
  bajo: {
    baseName: 'bajo',
    label: 'Bajo Synth',
    code: (n) => `const ${n} = note("b1 ~ b1 ~ d2 ~ f#1 ~").s("sawtooth").lpf(380).decay(.15).sustain(.3).gain(.75)`,
  },
  lead: {
    baseName: 'lead',
    label: 'Lead Melódico',
    code: (n) => `const ${n} = note("b4 ~ d5 ~ f#5 ~ a5 ~").s("sawtooth").lpf(4200).decay(.14).sustain(.4).delay(.2).gain(.45)`,
  },
  arp: {
    baseName: 'arp',
    label: 'Arpegio',
    code: (n) => `const ${n} = note("b4 d5 f#5 a5 b5 a5 f#5 d5").s("triangle").lpf(3600).decay(.12).sustain(.15).delay(.25).gain(.35)`,
  },
  piano: {
    baseName: 'piano',
    label: 'Piano Acordes',
    code: (n) => `const ${n} = note("<[b3,d4,f#4] [g3,b3,d4]>").s("piano").room(.22).gain(.55)`,
  },
  pad: {
    baseName: 'pad',
    label: 'Pad Supersaw',
    code: (n) => `const ${n} = note("<[b3,d4,f#4] [g3,b3,d4]>").s("supersaw").lpf(1600).attack(.18).room(.35).gain(.35)`,
  },
};

export function patchAddChannel(source, analysis, presetKey = 'lead') {
  const preset = CHANNEL_PRESETS[presetKey] ?? CHANNEL_PRESETS.lead;
  const existing = new Set(analysis.decls.keys());
  let name = preset.baseName;
  let counter = 2;
  while (existing.has(name)) {
    name = `${preset.baseName}${counter++}`;
  }
  const line = preset.code(name);

  if (!analysis.hasArrange) {
    // Label style or bare REPL
    const hasLabels = analysis.channels.some((c) => c.isLabel);
    if (hasLabels) {
      const snippet = `\n${name}: ${line.replace(/^const\s+\w+\s*=\s*/, '')}\n`;
      return applyEdit(source, source.length, source.length, snippet, 'channel');
    }
  }

  // Insert variable right before `arreglo` (or at the end of top-level channels)
  const insertPos = analysis.arregloStmtRange ? analysis.arregloStmtRange[0] : source.length;
  let updated = source.slice(0, insertPos) + `${line}\n` + source.slice(insertPos);

  // Also add the new channel into the first drop or last section of arrange() if present so it plays right away!
  if (analysis.sections.length) {
    const targetSec =
      analysis.sections.find((s) => /drop/i.test(s.exprText)) ?? analysis.sections.at(-1);
    if (targetSec?.exprRange) {
      const offset = `${line}\n`.length;
      const eStart = targetSec.exprRange[0] + offset;
      const eEnd = targetSec.exprRange[1] + offset;
      const cur = updated.slice(eStart, eEnd).trim();
      const nextExpr = /^stack\(([\s\S]+)\)$/.test(cur)
        ? cur.replace(/\)$/, `, ${name})`)
        : cur === 'silence'
          ? name
          : `stack(${cur}, ${name})`;
      updated = updated.slice(0, eStart) + nextExpr + updated.slice(eEnd);
    }
  }

  return {
    code: updated,
    changedRanges: [[insertPos, insertPos + line.length]],
    editKind: 'channel',
    addedChannelId: name,
  };
}
