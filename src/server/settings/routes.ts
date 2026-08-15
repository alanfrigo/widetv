import type { FastifyInstance } from 'fastify';

import type { SettingsPatch } from '@shared/api-types';

import { SettingsError, type SettingsService } from './store';

/**
 * Rotas das preferencias.
 *
 * Sao duas de proposito: `GET` para ler e `PATCH` para mudar UM campo. Nao ha
 * `POST` nem `PUT` - sobrescrever o objeto inteiro faria dois aparelhos com a
 * tela aberta ao mesmo tempo apagarem a escolha um do outro, que e exatamente o
 * cenario desta casa (mesma senha, mesmas telas, TV e tablet ligados juntos).
 *
 * Ficam atras do guard de sessao que ja cobre tudo sob `/api/` fora dos
 * PUBLIC_PATHS: preferencia e da casa, nao da internet.
 */

export interface SettingsRoutesDeps {
  settings: SettingsService;
}

/** Objeto JSON de verdade: array e null tambem sao `typeof 'object'`. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

/**
 * Corpo -> `SettingsPatch`, campo a campo. Devolve a mensagem de erro quando o
 * TIPO nao bate; o valor em si (horario torto, idioma esquisito) e problema do
 * servico, que conhece as regras.
 *
 * `tmdbConfigured` e ignorado em silencio em vez de recusado: e so leitura, e o
 * cliente mais simples possivel e o que devolve o objeto que acabou de receber.
 */
function toPatch(body: Record<string, unknown>): SettingsPatch | string {
  const patch: SettingsPatch = {};

  for (const field of ['audioLang', 'subtitleLang', 'rescanTime'] as const) {
    const value = body[field];
    if (value === undefined) continue;
    if (!isNullableString(value)) return `${field} precisa ser string ou null`;
    patch[field] = value;
  }

  for (const field of ['subtitlesAuto', 'autoRemux', 'smartGrouping'] as const) {
    const value = body[field];
    if (value === undefined) continue;
    if (typeof value !== 'boolean') return `${field} precisa ser boolean`;
    patch[field] = value;
  }

  return patch;
}

export function registerSettingsRoutes(app: FastifyInstance, deps: SettingsRoutesDeps): void {
  app.get('/api/settings', async (_request, reply) => {
    // A preferencia muda em QUALQUER aparelho da casa; cache aqui mostraria a
    // escolha antiga para quem nao fez a mudanca - o oposto do objetivo de
    // guardar isso no servidor.
    reply.header('cache-control', 'no-store');
    return deps.settings.get();
  });

  app.patch('/api/settings', async (request, reply) => {
    const body: unknown = request.body;
    if (!isPlainObject(body)) {
      return reply.code(400).send({ error: 'corpo precisa ser um objeto' });
    }

    const patch = toPatch(body);
    if (typeof patch === 'string') {
      return reply.code(400).send({ error: patch });
    }

    try {
      const settings = deps.settings.patch(patch);
      reply.header('cache-control', 'no-store');
      return settings;
    } catch (error) {
      // Valor recusado pelo servico e corpo torto, nao servidor quebrado: 400.
      if (error instanceof SettingsError) {
        return reply.code(400).send({ error: error.message });
      }
      throw error;
    }
  });
}
