import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  analyzeStrudelSource,
  evaluateVisualPatterns,
  midiToNoteName,
  patchAddChannel,
  patchBpm,
  patchChannelNotes,
  patchChannelParam,
  patchMasterPostgain,
  patchPlaylistAddSection,
  patchPlaylistDeleteSection,
  patchPlaylistDuplicateSection,
  patchPlaylistResizeSection,
  patchPlaylistSplitSection,
  patchPlaylistToggleChannel,
  patchSeparateSharedSource,
  safeNoteToMidi,
  serializeNotesToMini,
} from '../website/src/daw/strudel-bridge.mjs';
import { starterProjectSource } from '../website/src/daw/constants.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const readPattern = (rel) => readFileSync(resolve(ROOT, rel), 'utf8');

const pa1 = readPattern('my-patterns/norost-rework.txt');
const pa2Piano = readPattern('my-patterns/norost-v2.txt');
const pa2Synth = readPattern('my-patterns/historial/norost-v2-sintetizador.txt');
const salgoBounce = readPattern('my-patterns/calle-bounce.txt');

describe('strudel-bridge: AST analysis on real tracks', () => {
  test('analyzes Pa Que La Pases Bien V1 (norost-rework.txt)', () => {
    const a = analyzeStrudelSource(pa1);
    expect(a.bpm).toBe(157);
    expect(a.hasArrange).toBe(true);
    expect(a.totalBars).toBe(128);
    expect(a.masterPostgain).toBeCloseTo(0.86, 2);

    const ids = a.channels.map((c) => c.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        'bombo',
        'bajo',
        'hats',
        'clap',
        'perc',
        'arp',
        'lead',
        'eco',
        'acordes',
        'teclas',
        'voz',
      ]),
    );

    const bombo = a.channels.find((c) => c.id === 'bombo');
    expect(bombo.kind).toBe('drum');
    expect(bombo.isStack).toBe(true);

    const bajo = a.channels.find((c) => c.id === 'bajo');
    expect(bajo.cycleCount).toBe(4);

    const lead = a.channels.find((c) => c.id === 'lead');
    expect(lead.kind).toBe('synth');
    expect(lead.callsHelper).toBe('sierra');
    expect(lead.patternSource?.sourceVar).toBe('gancho');

    const voz = a.channels.find((c) => c.id === 'voz');
    expect(voz.isVocal).toBe(true);
    expect(voz.isGlobal).toBe(true);
  });

  test('analyzes Pa Que La Pases Bien V2 Piano & V2 Synth with shared sources', () => {
    const a2 = analyzeStrudelSource(pa2Piano);
    expect(a2.bpm).toBe(157);
    expect(a2.totalBars).toBeGreaterThan(100);
    const sub = a2.channels.find((c) => c.id === 'sub');
    const acid = a2.channels.find((c) => c.id === 'acid');
    const pad = a2.channels.find((c) => c.id === 'pad');
    const pulsos = a2.channels.find((c) => c.id === 'pulsos');
    expect(sub.patternSource.sourceVar).toBe('figura');
    expect(acid.patternSource.sharedWith).toContain('sub');
    expect(sub.patternSource.sharedWith).toContain('acid');
    expect(pad.patternSource.sourceVar).toBe('progresion');
    expect(pulsos.patternSource.sharedWith).toContain('pad');

    const a2s = analyzeStrudelSource(pa2Synth);
    expect(a2s.bpm).toBe(157);
    expect(a2s.sections.length).toBe(a2.sections.length);
  });

  test("analyzes Salgo Pa' la Calle & starterProjectSource", () => {
    const salgo = analyzeStrudelSource(salgoBounce);
    expect(salgo.bpm).toBe(175);
    expect(salgo.channels.length).toBeGreaterThanOrEqual(4);
    expect(salgo.sections.length).toBeGreaterThanOrEqual(5);

    const starter = analyzeStrudelSource(starterProjectSource);
    expect(starter.bpm).toBe(132);
    expect(starter.totalBars).toBe(24);
    expect(starter.channels.map((c) => c.id)).toEqual([
      'kick',
      'clap',
      'hats',
      'bajo',
      'acordes',
      'lead',
    ]);
  });
});

describe('strudel-bridge: visual pattern evaluation & mini serialization', () => {
  test('extracts notes and drum steps cleanly without network blocking', async () => {
    const a = analyzeStrudelSource(pa1);
    const evalRes = await evaluateVisualPatterns(pa1, a);
    expect(evalRes.channelData.bombo.notes.length).toBeGreaterThanOrEqual(4);
    expect(evalRes.channelData.lead.notes.length).toBeGreaterThanOrEqual(4);
    expect(evalRes.channelData.acordes.notes.length).toBeGreaterThanOrEqual(6);
    expect(evalRes.channelData.bajo.notes.length).toBeGreaterThanOrEqual(6);
  });

  test('round-trips serialized melodic & drum patterns cleanly', () => {
    const notes = [
      { start: 0, duration: 0.25, midi: safeNoteToMidi('b4'), velocity: 0.85 },
      { start: 0.25, duration: 0.25, midi: safeNoteToMidi('d5'), velocity: 0.9 },
      { start: 0.5, duration: 0.5, midi: safeNoteToMidi('f#5'), velocity: 1.0 },
      { start: 1.0, duration: 0.5, midi: safeNoteToMidi('g4'), velocity: 0.8 },
      { start: 1.0, duration: 0.5, midi: safeNoteToMidi('b4'), velocity: 0.8 },
    ];
    const mini = serializeNotesToMini(notes, 2, { isDrum: false });
    expect(mini).toContain('b4');
    expect(mini).toContain('f#5');
    expect(mini).toContain('g4,b4');
    expect(midiToNoteName(safeNoteToMidi('c#4'))).toBe('c#4');

    const drumSteps = [
      { start: 0, duration: 0.0625, midi: 60, velocity: 1 },
      { start: 0.25, duration: 0.0625, midi: 60, velocity: 1 },
      { start: 0.5, duration: 0.0625, midi: 60, velocity: 1 },
      { start: 0.75, duration: 0.0625, midi: 60, velocity: 1 },
    ];
    const drumMini = serializeNotesToMini(drumSteps, 1, { isDrum: true, drumToken: 'bd' });
    expect(drumMini).toBe('bd*4');
  });
});

describe('strudel-bridge: bidirectional AST patchers preserve valid Strudel code', () => {
  test('patchBpm and patchMasterPostgain', () => {
    const a = analyzeStrudelSource(pa1);
    const { code: c1 } = patchBpm(pa1, a, 160);
    const a1 = analyzeStrudelSource(c1);
    expect(a1.bpm).toBe(160);

    const { code: c2 } = patchMasterPostgain(c1, a1, 0.72);
    const a2 = analyzeStrudelSource(c2);
    expect(a2.masterPostgain).toBeCloseTo(0.72, 2);
  });

  test('patchChannelParam respects stack/helper gain -> postgain rule', () => {
    const a = analyzeStrudelSource(pa1);
    const { code: cBombo } = patchChannelParam(pa1, a, 'bombo', 'gain', 0.65);
    const aBombo = analyzeStrudelSource(cBombo);
    const bomboCh = aBombo.channels.find((c) => c.id === 'bombo');
    expect(bomboCh.params.postgain.numericValue).toBeCloseTo(0.65, 2);
    expect(bomboCh.effectiveGain).toBeCloseTo(0.65, 2);

    const { code: cLead } = patchChannelParam(cBombo, aBombo, 'lead', 'lpf', 2400);
    const aLead = analyzeStrudelSource(cLead);
    expect(aLead.channels.find((c) => c.id === 'lead').params.lpf.numericValue).toBe(2400);
  });

  test('patchChannelNotes edits gancho and drum stack channel safely', async () => {
    const a = analyzeStrudelSource(pa1);
    const newNotes = [
      { start: 0, duration: 0.25, midi: safeNoteToMidi('b4'), velocity: 0.9 },
      { start: 0.5, duration: 0.25, midi: safeNoteToMidi('f#5'), velocity: 0.9 },
    ];
    const { code: c1 } = patchChannelNotes(pa1, a, 'lead', newNotes, 1);
    const a1 = analyzeStrudelSource(c1);
    const eval1 = await evaluateVisualPatterns(c1, a1);
    expect(eval1.channelData.lead.notes.some((n) => n.midi === safeNoteToMidi('f#5'))).toBe(true);

    const kickHits = [
      { start: 0, duration: 0.0625, midi: 60, velocity: 1 },
      { start: 0.0625, duration: 0.0625, midi: 60, velocity: 1 },
      { start: 0.5, duration: 0.0625, midi: 60, velocity: 1 },
    ];
    const { code: c2 } = patchChannelNotes(c1, a1, 'bombo', kickHits, 1);
    expect(c2).not.toContain('bombo_club,');
    expect(c2).toContain('.struct("');
    const a2 = analyzeStrudelSource(c2);
    const eval2 = await evaluateVisualPatterns(c2, a2);
    expect(eval2.channelData.bombo.notes.length).toBeGreaterThanOrEqual(4);
  });

  test('patchPlaylistToggleChannel, Resize, Split, Duplicate, Delete, Add', () => {
    const a = analyzeStrudelSource(pa1);
    const firstDropIdx = a.sections.findIndex((s) => s.channels.bombo?.active);
    expect(firstDropIdx).toBeGreaterThanOrEqual(0);

    // Disable bombo in that drop section
    const { code: toggledOff } = patchPlaylistToggleChannel(pa1, a, firstDropIdx, 'bombo', false);
    const aOff = analyzeStrudelSource(toggledOff);
    expect(Boolean(aOff.sections[firstDropIdx].channels.bombo?.active)).toBe(false);

    // Re-enable bombo
    const { code: toggledOn } = patchPlaylistToggleChannel(toggledOff, aOff, firstDropIdx, 'bombo', true);
    const aOn = analyzeStrudelSource(toggledOn);
    expect(aOn.sections[firstDropIdx].channels.bombo.active).toBe(true);

    // Resize first section
    const origBars = aOn.sections[0].bars;
    const { code: resized } = patchPlaylistResizeSection(toggledOn, aOn, 0, origBars + 2);
    const aResized = analyzeStrudelSource(resized);
    expect(aResized.sections[0].bars).toBe(origBars + 2);
    expect(aResized.totalBars).toBe(aOn.totalBars + 2);

    // Split section 0
    const { code: split } = patchPlaylistSplitSection(resized, aResized, 0);
    const aSplit = analyzeStrudelSource(split);
    expect(aSplit.sections.length).toBe(aResized.sections.length + 1);
    expect(aSplit.totalBars).toBe(aResized.totalBars);

    // Duplicate & Delete
    const { code: duped } = patchPlaylistDuplicateSection(split, aSplit, 0);
    const aDuped = analyzeStrudelSource(duped);
    expect(aDuped.sections.length).toBe(aSplit.sections.length + 1);

    const { code: deleted } = patchPlaylistDeleteSection(duped, aDuped, 1);
    const aDeleted = analyzeStrudelSource(deleted);
    expect(aDeleted.sections.length).toBe(aSplit.sections.length);

    // Add section
    const { code: addedSec } = patchPlaylistAddSection(deleted, aDeleted, 4, ['bombo', 'lead']);
    const aAddedSec = analyzeStrudelSource(addedSec);
    expect(aAddedSec.sections.length).toBe(aDeleted.sections.length + 1);
    expect(aAddedSec.sections.at(-1).bars).toBe(4);
    expect(aAddedSec.sections.at(-1).channels.bombo.active).toBe(true);
    expect(aAddedSec.sections.at(-1).channels.lead.active).toBe(true);
  });

  test('patchSeparateSharedSource unlinks acid from sub in V2', () => {
    const a = analyzeStrudelSource(pa2Piano);
    const { code } = patchSeparateSharedSource(pa2Piano, a, 'acid');
    const a2 = analyzeStrudelSource(code);
    const acid = a2.channels.find((c) => c.id === 'acid');
    const sub = a2.channels.find((c) => c.id === 'sub');
    expect(acid.patternSource.sharedWith).toEqual([]);
    expect(sub.patternSource.sharedWith).toEqual([]);
  });

  test('patchAddChannel adds a valid editable channel', () => {
    const a = analyzeStrudelSource(starterProjectSource);
    const { code } = patchAddChannel(starterProjectSource, a, 'arp');
    const a2 = analyzeStrudelSource(code);
    expect(a2.channels.some((c) => c.id.startsWith('arp'))).toBe(true);
  });
});
