import { readFileSync, writeFileSync } from 'node:fs';

const seconds = Number(process.argv[2]);
const takes = ['calle-progresiva.txt', 'calle-progresiva-visual.txt'];
const marker = /^const segundosLlamada = (\d+(?:\.\d+)?)$/m;
const changes = takes.map((name) => {
  const path = new URL('../my-patterns/' + name, import.meta.url);
  const source = readFileSync(path, 'utf8');
  const duration = Number(source.match(/^const compasesVozCortes = (\d+(?:\.\d+)?) \* bpm \/ 240$/m)?.[1]);
  if (!marker.test(source) || !Number.isFinite(seconds) || seconds <= 0 || seconds >= duration) {
    throw new Error('Usa node scripts/set-salgo-cue.mjs SEGUNDOS, dentro de la toma vocal.');
  }
  return { path, source: source.replace(marker, 'const segundosLlamada = ' + seconds) };
});

for (const { path, source } of changes) writeFileSync(path, source);
console.log('Segunda entrada alineada a ' + seconds.toFixed(3) + ' s de la toma vocal.');
