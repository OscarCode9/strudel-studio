import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { analyzeStrudelSource, evaluateVisualPatterns } from '../website/src/daw/strudel-bridge.mjs';

const root = new URL('../', import.meta.url);
const readPattern = (name) => readFileSync(new URL('my-patterns/' + name, root), 'utf8');
const source = readPattern('calle-progresiva.txt');
const visual = readPattern('calle-progresiva-visual.txt');
const markerLine = /^const segundosLlamada = (\d+(?:\.\d+)?)$/m;
const durationLine = /^const compasesVozCortes = (\d+(?:\.\d+)?) \* bpm \/ 240$/m;
const sampleLine = /^const vozCortesUrl = '([^']+)'$/m;
for (const line of [markerLine, durationLine, sampleLine]) {
  assert.ok(source.match(line), 'Falta un dato de la toma vocal.');
  assert.equal(source.match(line)[1], visual.match(line)?.[1], 'Las dos versiones del arreglo difieren.');
}

const marker = Number(source.match(markerLine)[1]);
const declaredDuration = Number(source.match(durationLine)[1]);
const sample = source.match(sampleLine)[1].replace(/^\//, '');
const local = new URL('website/' + sample, root);
const publicSample = new URL('website/public/' + sample, root);
const wav = fileURLToPath(existsSync(local) ? local : publicSample);
const wavDuration = Number(execFileSync('ffprobe', [
  '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', wav,
], { encoding: 'utf8' }));
assert.ok(Math.abs(wavDuration - declaredDuration) < .001, 'La duración declarada no coincide con el WAV.');
assert.ok(marker > 0 && marker < wavDuration, 'El marcador queda fuera del WAV.');

const analysis = analyzeStrudelSource(source);
const dropIndex = analysis.sections.findIndex(({ tramoBpm }) => tramoBpm === 180);
assert.ok(dropIndex > 0, 'Falta el segundo drop.');
const drop = analysis.sections[dropIndex];
const previous = analysis.sections[dropIndex - 1];
const sections = (list) => list.map(({ startBar, bars, tramoBpm, exprText }) => ({ startBar, bars, tramoBpm, exprText }));
assert.deepEqual(sections(analysis.sections), sections(analyzeStrudelSource(visual).sections));
assert.notEqual(previous.exprText.trim(), 'silence', 'Hay una sección muda antes de la entrada.');
assert.ok(Math.abs(previous.endBar - drop.startBar) < 1e-8, 'Hay un hueco en el arreglo.');

const seconds = (cycle) => Number(cycle) * 240 / analysis.bpm;
const { masterPattern } = await evaluateVisualPatterns(source, analysis);
const events = masterPattern.queryArc(0, analysis.totalBars).filter((event) => event.hasOnset());
const vocal = events.filter(({ value }) => value.s === 'voz_calle_cortes');
assert.equal(vocal.length, 1, 'La segunda voz debe dispararse una sola vez.');
const vocalStart = seconds(vocal[0].whole.begin);
const kick = events.find(({ whole, value }) => value.s === 'bombo_calle' && Math.abs(Number(whole.begin) - drop.startBar) < 1e-8);
assert.ok(kick, 'No hay bombo al inicio del segundo drop.');
const dropSeconds = seconds(kick.whole.begin);
assert.ok(Math.abs(dropSeconds - vocalStart - marker) < 1e-6, 'El bombo no coincide con el marcador.');
console.log('Voz ' + vocalStart.toFixed(3) + ' s · marcador WAV ' + marker.toFixed(3) + ' s · bombo ' + dropSeconds.toFixed(3) + ' s');
console.log('Las dos versiones coinciden. Una sola toma y ningún bloque vacío antes del drop.');
