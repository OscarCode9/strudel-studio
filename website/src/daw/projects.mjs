import pa1 from '../../../my-patterns/norost-rework.txt?raw';
import pa2Piano from '../../../my-patterns/norost-v2.txt?raw';
import pa2Synth from '../../../my-patterns/historial/norost-v2-sintetizador.txt?raw';
import salgo from '../../../my-patterns/calle-bounce.txt?raw';
import salgoEstructura from '../../../my-patterns/calle-estructura-v1.txt?raw';
import salgoProgresiva from '../../../my-patterns/calle-progresiva.txt?raw';

import { CHANNEL_PALETTE, starterProjectSource } from './constants.mjs';

export { CHANNEL_PALETTE, starterProjectSource };

export const dawProjects = [
  {
    id: '1',
    family: 'paque',
    title: 'Pa Que La Pases Bien',
    label: 'V1 · Noro$t Rework (Original)',
    source: pa1,
  },
  {
    id: '2',
    family: 'paque',
    title: 'Pa Que La Pases Bien',
    label: 'V2 · Piano Natural',
    source: pa2Piano,
  },
  {
    id: 'paque-v2-synth',
    family: 'paque',
    title: 'Pa Que La Pases Bien',
    label: 'V2 · Sintetizadores',
    source: pa2Synth,
  },
  {
    id: 'salgo',
    family: 'salgo',
    title: "Salgo Pa' la Calle",
    label: 'V7 · 175 BPM / Regreso del intro',
    source: salgo,
  },
  {
    id: 'salgo-pa-que-v1',
    family: 'salgo',
    title: "Salgo Pa' la Calle",
    label: 'Estructura Pa Que V1 · 157 BPM',
    source: salgoEstructura,
  },
  {
    id: 'salgo-progresiva',
    family: 'salgo',
    title: "Salgo Pa' la Calle",
    label: 'Progresiva · 90 → 175 → 185 BPM',
    source: salgoProgresiva,
  },
  {
    id: 'nuevo',
    family: 'custom',
    title: 'Nuevo Beat FL',
    label: 'Plantilla editable desde cero',
    source: starterProjectSource,
  },
];

export function getDawProject(id) {
  return dawProjects.find((p) => p.id === id) ?? dawProjects[0];
}
