import { describe, expect, test } from 'vitest';
import {
  TUNE_COMMIT_DELAY_MS,
  initialTuner,
  reduceTuner,
  type TunerState,
} from '../../src/web/tuner';

/** Canais 1, 2, 3, 7 e 12: com buracos, como acontece depois de remover uma serie. */
const CHANNELS = [1, 2, 3, 7, 12];

function digit(state: TunerState, value: string, atMs = 0) {
  return reduceTuner(state, { type: 'digit', value, atMs }, CHANNELS);
}

describe('reduceTuner - passo com as setas', () => {
  test('sobe para o proximo canal existente, pulando buracos', () => {
    const r = reduceTuner(initialTuner(3), { type: 'step', delta: 1 }, CHANNELS);
    expect(r.tuneTo).toBe(7);
  });

  test('desce para o anterior existente', () => {
    const r = reduceTuner(initialTuner(7), { type: 'step', delta: -1 }, CHANNELS);
    expect(r.tuneTo).toBe(3);
  });

  test('do ultimo canal da a volta para o primeiro', () => {
    const r = reduceTuner(initialTuner(12), { type: 'step', delta: 1 }, CHANNELS);
    expect(r.tuneTo).toBe(1);
  });

  test('do primeiro canal para tras da a volta para o ultimo', () => {
    const r = reduceTuner(initialTuner(1), { type: 'step', delta: -1 }, CHANNELS);
    expect(r.tuneTo).toBe(12);
  });

  test('canal atual desconhecido cai no primeiro canal', () => {
    const r = reduceTuner(initialTuner(99), { type: 'step', delta: 1 }, CHANNELS);
    expect(r.tuneTo).toBe(1);
  });

  test('lista vazia nao sintoniza nada', () => {
    const r = reduceTuner(initialTuner(1), { type: 'step', delta: 1 }, []);
    expect(r.tuneTo).toBeNull();
  });

  test('seta descarta digitacao em andamento', () => {
    const a = digit(initialTuner(1), '1');
    const r = reduceTuner(a.state, { type: 'step', delta: 1 }, CHANNELS);
    expect(r.state.buffer).toBe('');
    expect(r.display).toBeNull();
  });
});

describe('reduceTuner - digitacao direta', () => {
  test('um digito fica pendente, nao sintoniza na hora', () => {
    // '1' pode virar 1 ou 12; esperar e o que um controle remoto faz.
    const r = digit(initialTuner(1), '1');
    expect(r.tuneTo).toBeNull();
    expect(r.display).toBe('1');
  });

  test('atingir o numero maximo de digitos sintoniza na hora', () => {
    const a = digit(initialTuner(1), '1', 0);
    const b = digit(a.state, '2', 100);
    expect(b.tuneTo).toBe(12);
    expect(b.state.buffer).toBe('');
  });

  test('o tempo de espera sintoniza o que foi digitado', () => {
    const a = digit(initialTuner(12), '7', 0);
    const b = reduceTuner(a.state, { type: 'tick', atMs: TUNE_COMMIT_DELAY_MS }, CHANNELS);
    expect(b.tuneTo).toBe(7);
    expect(b.state.buffer).toBe('');
  });

  test('tick antes do tempo nao sintoniza', () => {
    const a = digit(initialTuner(12), '7', 0);
    const b = reduceTuner(a.state, { type: 'tick', atMs: TUNE_COMMIT_DELAY_MS - 1 }, CHANNELS);
    expect(b.tuneTo).toBeNull();
    expect(b.state.buffer).toBe('7');
  });

  test('cada digito novo reinicia a contagem', () => {
    const a = digit(initialTuner(1), '0', 0);
    const b = digit(a.state, '3', TUNE_COMMIT_DELAY_MS - 10);
    const c = reduceTuner(b.state, { type: 'tick', atMs: TUNE_COMMIT_DELAY_MS }, CHANNELS);
    expect(c.tuneTo).toBeNull();
  });

  test('zeros a esquerda funcionam, como em controle remoto', () => {
    const a = digit(initialTuner(12), '0', 0);
    const b = digit(a.state, '7', 100);
    expect(b.tuneTo).toBe(7);
  });

  test('canal inexistente e descartado sem sintonizar', () => {
    const a = digit(initialTuner(1), '9', 0);
    const b = digit(a.state, '9', 100);
    expect(b.tuneTo).toBeNull();
    expect(b.state.buffer).toBe('');
    expect(b.invalid).toBe(true);
  });

  test('tick sem digitacao pendente e inofensivo', () => {
    const r = reduceTuner(initialTuner(1), { type: 'tick', atMs: 999_999 }, CHANNELS);
    expect(r.tuneTo).toBeNull();
    expect(r.state.buffer).toBe('');
  });

  test('nao-digito e ignorado', () => {
    const r = digit(initialTuner(1), 'a');
    expect(r.state.buffer).toBe('');
    expect(r.display).toBeNull();
  });

  test('largura maxima acompanha o maior canal existente', () => {
    // So ha canais de um digito: o primeiro digito ja sintoniza.
    const r = reduceTuner(initialTuner(1), { type: 'digit', value: '3', atMs: 0 }, [1, 2, 3]);
    expect(r.tuneTo).toBe(3);
  });

  test('com canais de tres digitos, espera tres digitos', () => {
    const wide = [1, 100, 250];
    const a = reduceTuner(initialTuner(1), { type: 'digit', value: '2', atMs: 0 }, wide);
    const b = reduceTuner(a.state, { type: 'digit', value: '5', atMs: 10 }, wide);
    expect(b.tuneTo).toBeNull();
    const c = reduceTuner(b.state, { type: 'digit', value: '0', atMs: 20 }, wide);
    expect(c.tuneTo).toBe(250);
  });
});
