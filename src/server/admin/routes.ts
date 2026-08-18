import type { FastifyInstance, FastifyReply } from 'fastify';

import {
  API,
  type AdminShow,
  type AdminShowPatch,
  type MergeSuggestion,
  type MetadataCandidate,
  type TaskAccepted,
} from '@shared/api-types';

import { backdropUrlOf, posterUrlOf } from '../channels/service.js';
import type { ShowRow, Store } from '../library/index-store';
import { suggestMerges } from '../library/merge-suggest.js';
import { imageUrlAllowed, type ShowCandidate } from '../metadata/providers.js';

/**
 * Curadoria do catalogo pelo painel web.
 *
 * Duas regras organizam o modulo. A primeira: toda decisao e gravada DUAS
 * vezes - no indice, para valer agora, e na tabela de override, para valer
 * depois do proximo scan. Gravar so uma faria a curadoria durar ate a
 * madrugada.
 *
 * A segunda: as URLs de imagem chegam do cliente e o download sai do servidor.
 * A allowlist de host e conferida aqui, antes de a requisicao existir.
 *
 * Ficam atras do guard de sessao que ja cobre `/api/`.
 */

export interface AdminDeps {
  store: Store;
  dataDir: string;
  tmdbApiKey: string | null;
  /** Dispara scan incremental. E o que efetiva o desfazer de uma fusao. */
  startScan: () => TaskAccepted;
  /** Injetavel para teste; por padrao percorre os provedores de verdade. */
  searchCandidates: (term: string) => Promise<ShowCandidate[]>;
  /** Injetavel para teste; por padrao baixa a arte e grava a linha manual. */
  applyMetadata: (show: ShowRow, candidate: ShowCandidate) => Promise<void>;
  /** Injetavel para teste; por padrao devolve a serie ao automatico. */
  clearMetadata?: (show: ShowRow) => void;
}

function folderNameOf(absolutePath: string): string {
  const parts = absolutePath.split('/').filter((part) => part !== '');
  return parts[parts.length - 1] ?? absolutePath;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Curadoria pre-calculada para a listagem inteira.
 *
 * `toAdminShow` NAO pode reconsultar o banco por serie: com ~460 canais,
 * chamar `countEpisodesByShow()` e `listShowAliases()` (as duas sao varreduras
 * da tabela inteira, nao busca por indice) dentro dela custaria ~920
 * varreduras completas por requisicao do `GET /api/admin/shows`. As tres
 * consultas agregadas rodam UMA vez por requisicao e o resultado e passado por
 * parametro - a mesma razao de `listSeasonsByShow` existir para
 * `GET /api/channels`.
 */
interface AdminIndex {
  episodeCounts: Map<number, number>;
  seasonsByShow: Map<number, number[]>;
  /** Slugs fundidos, agrupados pelo slug ALVO. Mesma ordem de `listShowAliases`. */
  mergedSlugsByTarget: Map<string, string[]>;
}

function buildAdminIndex(store: Store): AdminIndex {
  const mergedSlugsByTarget = new Map<string, string[]>();
  for (const alias of store.listShowAliases()) {
    const merged = mergedSlugsByTarget.get(alias.targetSlug);
    if (merged === undefined) mergedSlugsByTarget.set(alias.targetSlug, [alias.slug]);
    else merged.push(alias.slug);
  }
  return {
    episodeCounts: store.countEpisodesByShow(),
    seasonsByShow: store.listSeasonsByShow(),
    mergedSlugsByTarget,
  };
}

/** Monta a visao do painel: indice, curadoria e metadata numa linha so. */
function toAdminShow(deps: AdminDeps, show: ShowRow, index: AdminIndex): AdminShow {
  const store = deps.store;
  const metadata = store.getShowMetadata(show.id);
  const override = store.getShowOverride(show.slug);

  return {
    id: show.id,
    slug: show.slug,
    name: show.name,
    folderName: folderNameOf(show.absolutePath),
    channelNumber: show.channelNumber,
    episodeCount: index.episodeCounts.get(show.id) ?? 0,
    seasons: index.seasonsByShow.get(show.id) ?? [],
    hidden: override?.hidden ?? false,
    renamed: override?.name !== null && override?.name !== undefined,
    year: metadata?.year ?? null,
    overview: metadata?.overview ?? null,
    source: metadata?.source ?? null,
    manual: metadata?.manual ?? false,
    posterUrl: posterUrlOf(show.channelNumber, metadata),
    backdropUrl: backdropUrlOf(show.channelNumber, metadata),
    mergedSlugs: index.mergedSlugsByTarget.get(show.slug) ?? [],
  };
}

function findShow(deps: AdminDeps, raw: string): ShowRow | null {
  if (!/^\d+$/.test(raw)) return null;
  const id = Number(raw);
  return deps.store.listShows().find((show) => show.id === id) ?? null;
}

/** Corpo -> patch, campo a campo. Devolve a mensagem quando o TIPO nao bate. */
function toPatch(body: Record<string, unknown>): AdminShowPatch | string {
  const patch: AdminShowPatch = {};

  if (body.name !== undefined) {
    if (body.name !== null && typeof body.name !== 'string') {
      return 'name precisa ser string ou null';
    }
    // Nome so de espaco e o mesmo que "sem nome manual": volta para a pasta.
    const name = typeof body.name === 'string' ? body.name.trim() : null;
    patch.name = name === null || name === '' ? null : name;
  }

  if (body.hidden !== undefined) {
    if (typeof body.hidden !== 'boolean') return 'hidden precisa ser boolean';
    patch.hidden = body.hidden;
  }

  if (body.channelNumber !== undefined) {
    if (typeof body.channelNumber !== 'number' || !Number.isInteger(body.channelNumber)) {
      return 'channelNumber precisa ser inteiro';
    }
    if (body.channelNumber < 1) return 'channelNumber precisa ser maior que zero';
    patch.channelNumber = body.channelNumber;
  }

  return patch;
}

function isCandidate(value: unknown): value is MetadataCandidate {
  if (!isPlainObject(value)) return false;
  const sources = ['tmdb', 'tvmaze', 'itunes'];
  if (typeof value.source !== 'string' || !sources.includes(value.source)) return false;
  if (typeof value.title !== 'string' || value.title.trim() === '') return false;
  for (const field of ['posterUrl', 'backdropUrl'] as const) {
    const url = value[field];
    if (url !== null && typeof url !== 'string') return false;
  }
  for (const field of ['overview'] as const) {
    const text = value[field];
    if (text !== null && typeof text !== 'string') return false;
  }
  const year = value.year;
  return year === null || typeof year === 'number';
}

function notFound(reply: FastifyReply): FastifyReply {
  return reply.code(404).send({ error: 'serie inexistente' });
}

export function registerAdminRoutes(app: FastifyInstance, deps: AdminDeps): void {
  const { store } = deps;

  app.get(API.adminShows, async (_request, reply) => {
    // A tela e de edicao: mostrar estado velho aqui e mostrar a pessoa
    // desfazendo o que ela acabou de fazer.
    reply.header('cache-control', 'no-store');
    const index = buildAdminIndex(store);
    return store.listShows().map((show) => toAdminShow(deps, show, index));
  });

  app.get(API.adminMergeSuggestions, async (_request, reply) => {
    reply.header('cache-control', 'no-store');
    const suggestions: MergeSuggestion[] = suggestMerges(
      store.listShows(),
      store.countEpisodesByShow(),
    );
    return suggestions;
  });

  // Caminhos literais com `:id`: as entradas de `API` sao funcoes de URL para
  // o CLIENTE, e derivar o padrao delas por replace de string trocaria uma
  // linha legivel por um truque que quebra calado quando a rota mudar.
  app.patch<{ Params: { id: string } }>('/api/admin/shows/:id', async (request, reply) => {
    const show = findShow(deps, request.params.id);
    if (show === null) return notFound(reply);

    const body: unknown = request.body;
    if (!isPlainObject(body)) {
      return reply.code(400).send({ error: 'corpo precisa ser um objeto' });
    }
    const patch = toPatch(body);
    if (typeof patch === 'string') return reply.code(400).send({ error: patch });

    const override = store.getShowOverride(show.slug);
    const name = patch.name === undefined ? (override?.name ?? null) : patch.name;
    const hidden = patch.hidden ?? override?.hidden ?? false;
    const channelNumber =
      patch.channelNumber === undefined ? (override?.channelNumber ?? null) : patch.channelNumber;

    // Numero primeiro: se a troca falhar (constraint), nada mais foi gravado.
    if (patch.channelNumber !== undefined && patch.channelNumber !== show.channelNumber) {
      store.setChannelNumber(show.id, patch.channelNumber);
    }
    // O nome vale AGORA no indice; o override e o que o faz sobreviver ao scan.
    if (patch.name !== undefined) {
      store.upsertShow({
        slug: show.slug,
        name: name ?? folderNameOf(show.absolutePath),
        absolutePath: show.absolutePath,
      });
    }
    store.setShowOverride({ slug: show.slug, name, hidden, channelNumber });

    // Relido DEPOIS da troca de canal: o `show` capturado no topo da funcao e
    // uma foto de ANTES do swap em `setChannelNumber`, e devolve-lo devolveria
    // o numero de canal antigo na resposta.
    const updated = findShow(deps, String(show.id));
    /* c8 ignore next */
    if (updated === null) return notFound(reply);
    reply.header('cache-control', 'no-store');
    return toAdminShow(deps, updated, buildAdminIndex(store));
  });

  app.post<{ Params: { id: string } }>('/api/admin/shows/:id/merge', async (request, reply) => {
    const target = findShow(deps, request.params.id);
    if (target === null) return notFound(reply);

    const body: unknown = request.body;
    if (!isPlainObject(body) || !Array.isArray(body.sourceIds)) {
      return reply.code(400).send({ error: 'sourceIds precisa ser uma lista de ids' });
    }

    const sources: ShowRow[] = [];
    for (const raw of body.sourceIds) {
      if (typeof raw !== 'number') {
        return reply.code(400).send({ error: 'sourceIds precisa ser uma lista de ids' });
      }
      const source = findShow(deps, String(raw));
      if (source === null) return notFound(reply);
      if (source.id === target.id) {
        return reply.code(400).send({ error: 'nao da para fundir a serie nela mesma' });
      }
      sources.push(source);
    }

    for (const source of sources) {
      // Alias antes da fusao: `mergeShows` apaga a linha da fonte, e depois
      // dela o slug so existiria na memoria deste request.
      store.addShowAlias(source.slug, target.slug);
      store.mergeShows(source.id, target.id);
    }

    return reply.code(202).send({ started: true } satisfies TaskAccepted);
  });

  app.post<{ Params: { id: string } }>('/api/admin/shows/:id/unmerge', async (request, reply) => {
    const target = findShow(deps, request.params.id);
    if (target === null) return notFound(reply);

    const body: unknown = request.body;
    if (!isPlainObject(body) || typeof body.slug !== 'string') {
      return reply.code(400).send({ error: 'slug precisa ser string' });
    }

    store.removeShowAlias(body.slug);
    // O desfazer real acontece no scan: `upsertEpisodes` move o episodio de
    // volta para a serie recriada pelo `ON CONFLICT(id) DO UPDATE`.
    // 409 quando ja ha um scan rodando, igual as outras rotas de tarefa de
    // fundo (`library/routes.ts`) - "aceitei" seria mentira aqui.
    const result = deps.startScan();
    return reply.code(result.started ? 202 : 409).send(result);
  });

  app.get<{ Params: { id: string }; Querystring: { q?: unknown } }>(
    '/api/admin/shows/:id/metadata/search',
    async (request, reply) => {
      const show = findShow(deps, request.params.id);
      if (show === null) return notFound(reply);

      const rawTerm = request.query.q;
      // Querystring nao passa por validacao de tipo do Fastify: `?q=a&q=b`
      // chega como array, e mandar isso para os provedores quebraria dentro
      // deles (`.trim()` num array) - 500 por causa de uma URL repetida.
      if (rawTerm !== undefined && typeof rawTerm !== 'string') {
        return reply.code(400).send({ error: 'q precisa ser uma unica string' });
      }
      const term = rawTerm ?? show.name;
      reply.header('cache-control', 'no-store');
      return deps.searchCandidates(term);
    },
  );

  app.put<{ Params: { id: string } }>('/api/admin/shows/:id/metadata', async (request, reply) => {
    const show = findShow(deps, request.params.id);
    if (show === null) return notFound(reply);

    const body: unknown = request.body;
    if (!isPlainObject(body) || !isCandidate(body.candidate)) {
      return reply.code(400).send({ error: 'candidate invalido' });
    }
    const candidate = body.candidate;

    for (const url of [candidate.posterUrl, candidate.backdropUrl]) {
      if (url !== null && !imageUrlAllowed(url)) {
        return reply.code(400).send({ error: 'host de imagem nao permitido' });
      }
    }

    await deps.applyMetadata(show, candidate);
    reply.header('cache-control', 'no-store');
    return toAdminShow(deps, show, buildAdminIndex(store));
  });

  app.delete<{ Params: { id: string } }>('/api/admin/shows/:id/metadata', async (request, reply) => {
    const show = findShow(deps, request.params.id);
    if (show === null) return notFound(reply);

    deps.clearMetadata?.(show);
    return reply.code(202).send({ started: true } satisfies TaskAccepted);
  });
}
