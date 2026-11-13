import { parse } from 'acorn';
import { getSession } from './catalog.mjs';

function numeric(node, values) {
  if (!node) return undefined;
  if (node.type === 'Literal' && typeof node.value === 'number') return node.value;
  if (node.type === 'Identifier') return values[node.name];
  if (node.type === 'UnaryExpression' && node.operator === '-') return -numeric(node.argument, values);
  if (node.type === 'BinaryExpression') {
    const a = numeric(node.left, values), b = numeric(node.right, values);
    return ({ '+': () => a + b, '-': () => a - b, '*': () => a * b, '/': () => a / b })[node.operator]?.();
  }
}

// Read only numeric duration expressions; never execute source to estimate its length.
function songCycles(source) {
  const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
  const values = {};
  let arrangement;
  for (const statement of ast.body) {
    if (statement.type !== 'VariableDeclaration') continue;
    for (const declaration of statement.declarations) {
      if (declaration.id.type !== 'Identifier') continue;
      const value = numeric(declaration.init, values);
      if (Number.isFinite(value)) values[declaration.id.name] = value;
      if (declaration.id.name === 'arreglo') arrangement = declaration.init;
    }
  }
  while (arrangement?.type === 'CallExpression' && arrangement.callee.type === 'MemberExpression') {
    arrangement = arrangement.callee.object;
  }
  if (arrangement?.callee?.name !== 'arrange') throw new Error('Falta el arreglo de la canción');
  const cycles = arrangement.arguments.reduce((total, section) => {
    if (section.type === 'ArrayExpression') return total + numeric(section.elements[0], values);
    if (section.type === 'CallExpression' && section.callee.name === 'tramo') {
      return total + numeric(section.arguments[0], values) * values.bpm / numeric(section.arguments[2], values);
    }
    throw new Error('Duración de sección desconocida');
  }, 0);
  if (!Number.isFinite(cycles) || cycles <= 0) throw new Error('Duración de canción inválida');
  return cycles;
}

const descriptions = {
  motor: ['Diseño del sonido', 'Escribo los osciladores y preparo el timbre de esta versión.'],
  pulso: ['Pulso', 'Empiezo por el golpe que marca el ritmo.'],
  bombo: ['Bombo', 'Pruebo el bombo de club antes de añadir el bajo.'],
  bajo: ['Bajo', 'El bajo y el subgrave responden entre los golpes.'],
  percusion: ['Percusión', 'Añado hats, palmas y percusión.'],
  bateria: ['Batería', 'Añado hats, palmas y redobles.'],
  armonia: ['Acordes', 'Construyo la armonía con el instrumento de esta versión.'],
  intro: ['Intro', 'Escribo el motivo y su continuación con la velocidad de esta toma.'],
  arpegio: ['Arpegio', 'Pruebo la figura de notas y sus silencios.'],
  frase: ['Gancho y voz', 'La melodía principal y la voz encuentran su sitio.'],
  gancho: ['Gancho y respuesta', 'Alterno la frase principal con sus contestaciones.'],
  voz: ['Voz', 'Pruebo la voz original sobre la base.'],
  arreglo: ['Mezcla completa', 'Suena el arreglo completo, con sus cortes, cambios y cierre.'],
};
function has(prefix, name) { return new RegExp(`\\b(?:const|let)\\s+${name}\\s*=`).test(prefix); }
function preview(section, prefix) {
  if (section === 'motor') return 'silence';
  if (section === 'intro') {
    if (has(prefix, 'introLento')) return 'introLento';
    if (has(prefix, 'muestra')) return 'muestra';
  }
  if (section === 'armonia') return 'stack(pad, pulsos)';
  const names = section === 'arpegio'
    ? ['bombo', 'kick', 'bajo', 'sub', 'hats', 'arp']
    : section === 'gancho' || section === 'frase' || section === 'voz'
      ? ['bombo', 'kick', 'bajo', 'sub', 'hats', 'clap', 'lead', 'respuesta', 'voz']
      : ['bombo', 'kick', 'bajo', 'sub', 'acid', 'hats', 'clap', 'perc'];
  const voices = names.filter((name) => has(prefix, name));
  return voices.length ? `stack(${voices.join(', ')})` : 'silence';
}

const cache = new Map();
export function getScore(version) {
  if (cache.has(version)) return cache.get(version);
  const session = getSession(version);
  if (!session) throw new Error(`Sesión desconocida: ${version}`);
  const source = session.source;
  const bpm = Number(source.match(/const bpm = (\d+)/)[1]);
  const cycles = songCycles(source);
  const segments = source.split(/^\/\/ @session (\w+)\s*$/m);
  let prefix = segments[0].trim(), cursor = 0;
  const scenes = [];
  for (let i = 1; i < segments.length; i += 2) {
    const section = segments[i], body = segments[i + 1].trim();
    prefix += `\n\n// @session ${section}\n${body}`;
    const final = section === 'arreglo';
    const [title, note] = descriptions[section] ?? [section, 'Pruebo esta parte de la canción.'];
    const text = final ? source.trim() : `${prefix}\n\n${preview(section, prefix)}.postgain(.46)`;
    const writeBars = final ? 4 : section === 'motor' ? 6 : 3;
    let playBars = final ? cycles : 2;
    if (section === 'intro') playBars = Number(source.match(/const segundosIntro = (\d+)/)?.[1] ?? 8) * bpm / 240;
    scenes.push({ index: scenes.length, title, note, text, writeBars, playBars,
      start: cursor, commit: cursor + writeBars, end: cursor + writeBars + playBars });
    cursor += writeBars + playBars;
  }
  if (!scenes.length || scenes.at(-1).title !== 'Mezcla completa') throw new Error('Sesión sin mezcla final');
  const score = { bpm, scenes, instrumentSetup: 'silence', buildEnd: scenes.at(-1).commit, scoreEnd: cursor,
    songSeconds: cycles * 240 / bpm };
  cache.set(version, score);
  return score;
}
