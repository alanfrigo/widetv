import type { DisplayMode } from '@shared/api-types';

/**
 * Leitura do modo de apresentacao vindo do servidor.
 *
 * Separado do cliente HTTP porque a regra e uma so e vale a pena testar: o modo
 * novo exige o valor exato, e tudo o mais - servidor antigo sem a rota, resposta
 * fora do contrato, campo faltando - cai em CRT, que e o modo que sempre
 * funcionou. Cair calado aqui e de proposito: o oposto do servidor, que derruba
 * o boot quando DISPLAY_MODE vem errado. Quem digitou o env ve o erro la; o
 * cliente so precisa continuar de pe.
 */
export function parseDisplayMode(raw: unknown): DisplayMode {
  return raw === 'widescreen' ? 'widescreen' : 'crt';
}
