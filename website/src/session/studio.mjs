import * as core from '@strudel/core';
import * as mini from '@strudel/mini';
import { transpiler } from '@strudel/transpiler';
import * as webaudio from '@strudel/webaudio';
import { getScore } from './score.mjs';

const { bpm, buildEnd, instrumentSetup, scenes, scoreEnd } = getScore(document.body.dataset.version);
const byId = (name) => document.getElementById(`studio-${name}`);
const play = byId('play');
const reset = byId('reset');
const code = byId('code');
const scroll = byId('code-scroll');
const wave = byId('wave');
const cues = [...document.querySelectorAll('[data-scene]')];
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const flatLine = 'M0 25H360';
byId('song')?.addEventListener('change', (event) => { window.location.assign(event.target.value); });
const cps = bpm / 240;

let audio, engine, score, analyser, waveform;
let frame, offset = 0, phase = 'idle', pending = false;
let lastText, lastCue, lastStatus, lastWaveTime = 0;

const escapes = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
const escapeHtml = (text) => text.replace(/[&<>"]/g, (character) => escapes[character]);
const tokens = /(\/\/.*)|("(?:[^"\\]|\\.)*"?|'(?:[^'\\]|\\.)*'?)|\b(const|setcpm|stack|arrange)\b|(?<![\w#])(\.?\d+(?:\.\d+)?)/g;

function highlight(line) {
  let result = '';
  let from = 0;
  for (const match of line.matchAll(tokens)) {
    const [, comment, string, keyword] = match;
    const type = comment ? 'comment' : string ? 'string' : keyword ? 'keyword' : 'number';
    result += escapeHtml(line.slice(from, match.index));
    result += `<span class="studio-${type}">${escapeHtml(match[0])}</span>`;
    from = match.index + match[0].length;
  }
  return result + escapeHtml(line.slice(from));
}

function write(text) {
  if (text === lastText) return;
  lastText = text;
  const lines = text.split('\n');
  code.innerHTML = lines.map((line, i) => {
    const cursor = i === lines.length - 1 ? '<span class="studio-cursor" aria-hidden="true"></span>' : '';
    return `<span class="studio-code-line"><span>${highlight(line)}${cursor}</span></span>`;
  }).join('');
  scroll.scrollTop = scroll.scrollHeight;
}

function editBetween(previous, next, progress) {
  if (progress >= 1 || reducedMotion.matches) return { text: next, deleting: false };
  let shared = 0;
  while (shared < previous.length && shared < next.length && previous[shared] === next[shared]) shared++;
  const erase = previous.length > shared ? .21 : 0;
  if (progress < erase) {
    const length = previous.length - Math.floor((previous.length - shared) * progress / erase);
    return { text: previous.slice(0, length), deleting: true };
  }
  const typed = Math.floor((next.length - shared) * (progress - erase) / (1 - erase));
  return { text: next.slice(0, shared + typed), deleting: false };
}

function status(value) {
  if (value === lastStatus) return;
  lastStatus = value;
  byId('state-label').textContent = value;
}

function formatTime(seconds) {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

function render(position) {
  const scene = scenes.findLast(({ start }) => start <= position) ?? scenes[0];
  const previous = scenes[scene.index - 1]?.text ?? '';
  const progress = Math.min(1, (position - scene.start) / (scene.commit - scene.start));
  const { text, deleting } = editBetween(previous, scene.text, progress);
  write(text);
  if (scene.index !== lastCue) {
    cues.forEach((button, i) => {
      if (i === scene.index) button.setAttribute('aria-current', 'step');
      else button.removeAttribute('aria-current');
    });
    byId('note-index').textContent = String(scene.index + 1).padStart(2, '0');
    byId('note').textContent = scene.note;
    lastCue = scene.index;
  }
  const mixing = position >= buildEnd;
  const elapsed = (mixing ? Math.min(position, scoreEnd) - buildEnd : position) / cps;
  const clock = formatTime(position >= scoreEnd ? Math.round(elapsed) : Math.floor(elapsed));
  if (byId('time').textContent !== clock) byId('time').textContent = clock;
  const total = ` / ${formatTime(Math.round((mixing ? scoreEnd - buildEnd : buildEnd) / cps))}`;
  if (byId('time-total').textContent !== total) {
    byId('time-total').textContent = total;
    byId('clock').setAttribute('aria-label', mixing ? 'Tiempo de la mezcla' : 'Tiempo de construcción');
  }
  byId('progress').value = Math.min(position / buildEnd, 1);
  if (phase !== 'running') return;
  if (mixing) status('MEZCLA EN VIVO');
  else if (progress === 1) status('ESCUCHANDO');
  else status(deleting ? 'AJUSTANDO' : 'ESCRIBIENDO');
}

function drawWave(time) {
  if (time - lastWaveTime < 32 || !analyser || reducedMotion.matches) return;
  lastWaveTime = time;
  analyser.getFloatTimeDomainData(waveform);
  const points = Array.from({ length: 100 }, (_, i) => {
    const value = waveform[Math.round(i * (waveform.length - 1) / 99)];
    return `${i === 0 ? 'M' : 'L'}${(i * 360 / 99).toFixed(1)} ${(25 - Math.max(-1, Math.min(1, value)) * 23).toFixed(1)}`;
  });
  wave.setAttribute('d', points.join(' '));
}

function refreshControls() {
  document.body.dataset.phase = phase;
  play.disabled = pending;
  reset.disabled = pending || phase === 'idle';
  cues.forEach((button) => { button.disabled = pending; });
  byId('play-label').textContent = pending ? 'Preparando audio…'
    : { idle: 'Empezar sesión', running: 'Pausar', paused: 'Continuar', ended: 'Repetir sesión' }[phase];
}

function clearSound() {
  engine.stop();
  webaudio.resetGlobalEffects();
  analyser?.disconnect();
  wave.setAttribute('d', flatLine);
}

function tick(time) {
  const position = offset + Math.max(0, engine.scheduler.now());
  render(position);
  if (position >= scoreEnd) {
    clearSound();
    phase = 'ended';
    status('SESIÓN TERMINADA');
    refreshControls();
    return;
  }
  drawWave(time);
  frame = requestAnimationFrame(tick);
}

async function prepareScore() {
  await core.evalScope(core, mini, webaudio);
  webaudio.registerSynthSounds();
  await webaudio.initAudio({ maxPolyphony: 128 });
  engine = core.repl({
    getTime: () => audio.currentTime,
    onSchedule: webaudio.webaudioOutput,
    transpiler,
  });
  if (!await engine.evaluate(instrumentSetup, false)) throw new Error('No se pudo iniciar la sesión');
  const sections = [[scenes[0].commit, core.silence]];
  for (const scene of scenes) {
    const pattern = await engine.evaluate(scene.text, false);
    if (!pattern) throw new Error(`No se pudo compilar: ${scene.title}`);
    const duration = scenes[scene.index + 1]
      ? scene.playBars + scenes[scene.index + 1].writeBars
      : scene.playBars;
    sections.push([duration, pattern]);
  }
  return core.arrange(...sections);
}

async function start(position) {
  audio ??= webaudio.getAudioContext();
  await audio.resume();
  score ??= await prepareScore();
  cancelAnimationFrame(frame);
  clearSound();
  analyser = audio.createAnalyser();
  analyser.fftSize = 512;
  waveform = new Float32Array(analyser.fftSize);
  webaudio.getSuperdoughAudioController().output.destinationGain.connect(analyser);
  offset = position;
  engine.setCps(cps);
  await engine.setPattern(position ? score.early(position) : score);
  phase = 'running';
  render(position);
  frame = requestAnimationFrame(tick);
}

async function transport(action) {
  if (pending) return;
  pending = true;
  refreshControls();
  try {
    await action();
  } catch (error) {
    cancelAnimationFrame(frame);
    if (engine) clearSound();
    phase = 'idle';
    lastCue = undefined;
    status('ERROR DE AUDIO');
    byId('note').textContent = 'No se pudo iniciar el audio. Pulsa «Empezar sesión» para reintentar.';
    console.error(error);
  } finally {
    pending = false;
    refreshControls();
  }
}

play.addEventListener('click', () => transport(async () => {
  if (phase === 'running') {
    cancelAnimationFrame(frame);
    await audio.suspend();
    phase = 'paused';
    status('EN PAUSA');
  } else if (phase === 'paused') {
    await audio.resume();
    phase = 'running';
    frame = requestAnimationFrame(tick);
  } else {
    await start(0);
  }
}));
reset.addEventListener('click', () => transport(() => start(0)));
cues.forEach((button, index) => button.addEventListener('click', () => transport(() => start(scenes[index].start))));
window.addEventListener('pagehide', () => {
  if (phase === 'running') play.click();
});
refreshControls();
