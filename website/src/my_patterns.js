import { getMetadata } from './metadata_parser';

export function getMyPatterns() {
  const my = import.meta.glob('../../my-patterns/**/*.txt', { query: '?raw', import: 'default', eager: true });
  return Object.fromEntries(
    Object.entries(my).map(([name, raw]) => [getMetadata(raw)['title'] || name.split('/').at(-1), raw]),
  );
}
