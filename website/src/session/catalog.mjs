import pa1 from '../../../my-patterns/norost-rework.txt?raw';
import pa2Synth from '../../../my-patterns/historial/norost-v2-sintetizador.txt?raw';
import pa2Piano from '../../../my-patterns/norost-v2.txt?raw';
import sample from '../../../my-patterns/historial/calle-bounce-sampled-v1.txt?raw';
import recreated from '../../../my-patterns/historial/calle-bounce-recreado-v2.txt?raw';
import development from '../../../my-patterns/historial/calle-bounce-desarrollo-v3.txt?raw';
import measured from '../../../my-patterns/historial/calle-bounce-timbre-v4.txt?raw';
import direct from '../../../my-patterns/historial/calle-bounce-entrada-directa-v5.txt?raw';
import motif from '../../../my-patterns/historial/calle-bounce-mismo-motivo-v6.txt?raw';
import salgo from '../../../my-patterns/calle-bounce.txt?raw';
import structure from '../../../my-patterns/calle-estructura-v1.txt?raw';
import progressive from '../../../my-patterns/calle-progresiva.txt?raw';

const paTitle = 'Pa Que La Pases Bien';
const salgoTitle = "Salgo Pa' la Calle";
export const sessionCatalog = [
  { id: '1', title: paTitle, label: 'V1 · primera', source: pa1, family: 'paque' },
  { id: 'paque-v2-synth', title: paTitle, label: 'V2 · sintetizadores', source: pa2Synth, family: 'paque' },
  { id: '2', title: paTitle, label: 'V2 · piano natural', source: pa2Piano, family: 'paque' },
  { id: 'salgo-sample', title: salgoTitle, label: 'V1 · intro con recorte', source: sample, family: 'salgo' },
  { id: 'salgo-recreada', title: salgoTitle, label: 'V2 · intro recreado', source: recreated, family: 'salgo' },
  { id: 'salgo-desarrollo', title: salgoTitle, label: 'V3 · intro de 22 segundos', source: development, family: 'salgo' },
  { id: 'salgo-timbre', title: salgoTitle, label: 'V4 · timbre medido / intro 8 s', source: measured, family: 'salgo' },
  { id: 'salgo-directa', title: salgoTitle, label: 'V5 · entrada directa', source: direct, family: 'salgo' },
  { id: 'salgo-motivo', title: salgoTitle, label: 'V6 · mismo motivo', source: motif, family: 'salgo' },
  { id: 'salgo', title: salgoTitle, label: 'V7 · 175 BPM / regreso del intro', source: salgo, family: 'salgo' },
  { id: 'salgo-pa-que-v1', title: salgoTitle, label: 'Estructura Pa Que V1 · 157 BPM', source: structure, family: 'salgo' },
  { id: 'salgo-progresiva', title: salgoTitle, label: 'Progresiva · 90 → 175 → 185 BPM', source: progressive, family: 'salgo' },
];
export function getSession(id) { return sessionCatalog.find((session) => session.id === id); }
