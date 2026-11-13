import source from '../../../my-patterns/calle-bounce.txt?raw';
import { evaluate } from '@strudel/core';
import { transpiler } from '@strudel/transpiler';

// Share the current composition and synth setup with the compact visual REPL.
export async function cargarCancion() {
  const { pattern } = await evaluate(source, transpiler);
  return pattern;
}
