import { describe, expect, test } from 'vitest';

import {
  cleanSearchTerm,
  groupingKey,
  parseFolderTitle,
} from '../../src/server/library/title-parser';

/**
 * Os nomes daqui sao de release de verdade. Cada linha que falha e um canal
 * duplicado no catalogo (titulo nao agrupou) ou um canal com nome quebrado
 * (parser comeu palavra do titulo), entao a tabela vale mais que o caso feliz.
 */

describe('parseFolderTitle', () => {
  describe('separadores', () => {
    test.each([
      ['THE.WIRE', 'THE WIRE'],
      ['Rick.and.Morty', 'Rick and Morty'],
      ['Tom_e_Jerry', 'Tom e Jerry'],
      ['Os   Simpsons', 'Os Simpsons'],
    ])('"%s" -> "%s"', (raw, esperado) => {
      expect(parseFolderTitle(raw).title).toBe(esperado);
    });

    test('ponto seguido de espaco e pontuacao, nao separador', () => {
      expect(parseFolderTitle('Dr. House').title).toBe('Dr. House');
      expect(parseFolderTitle('Mr. Robot').title).toBe('Mr. Robot');
    });

    test('ponto colado no meio de nome de release e separador', () => {
      expect(parseFolderTitle('Dr.House.S01.1080p').title).toBe('Dr House');
    });

    test('sigla mantem os pontos', () => {
      expect(parseFolderTitle('S.W.A.T.').title).toBe('S.W.A.T');
    });

    test('traco que o dono do acervo escreveu continua no titulo', () => {
      expect(parseFolderTitle('Cavaleiros do Zodiaco - Saga de Asgard').title).toBe(
        'Cavaleiros do Zodiaco - Saga de Asgard',
      );
      expect(parseFolderTitle('Tom - Jerry').title).toBe('Tom - Jerry');
    });
  });

  describe('corte na temporada', () => {
    test.each([
      ['Rick.and.Morty.S01.1080p.HMAX.WEB-DL.DD2.0.x264-DUAL-SiGLA', 'Rick and Morty', 1],
      ['Rick.and.Morty.S03.2160p.NF.WEB-DL.DDP5.1.x265-DUAL-SiGLA', 'Rick and Morty', 3],
      ['The.Simpsons.S37.1080p.DSNP.WEB-DL.DDP5.1.H.264-DUAL', 'The Simpsons', 37],
      ['Breaking.Bad.S05.1080p.BluRay.x265-RARBG', 'Breaking Bad', 5],
      ['The.Office.US.S03.720p.WEBRip', 'The Office US', 3],
      ['Chaves.1a.Temporada.1972.DVDRip', 'Chaves', 1],
      ['Os.Simpsons.Temporada.12', 'Os Simpsons', 12],
      ['Thundercats S2', 'Thundercats', 2],
      ['Dexter Season 4 1080p', 'Dexter', 4],
      ['Chaves 3 Temporada', 'Chaves', 3],
      ['Chaves Terceira Temporada', 'Chaves', 3],
      ['Twin.Peaks.S02E07.1080p', 'Twin Peaks', 2],
    ])('"%s" -> "%s" temporada %i', (raw, titulo, temporada) => {
      const parsed = parseFolderTitle(raw);
      expect(parsed.title).toBe(titulo);
      expect(parsed.season).toBe(temporada);
    });

    test.each([
      ['Dexter.S01-S03.1080p.BluRay', 'Dexter'],
      ['Dexter Seasons 1-3', 'Dexter'],
      ['Friends.Complete.Series.1080p.BluRay', 'Friends'],
      ['Chaves.Serie.Completa.DVDRip', 'Chaves'],
    ])('faixa ou colecao em "%s" deixa a temporada para as subpastas', (raw, titulo) => {
      const parsed = parseFolderTitle(raw);
      expect(parsed.title).toBe(titulo);
      expect(parsed.season).toBeNull();
      expect(parsed.isRelease).toBe(true);
    });

    test('palavra de temporada sem numero nao corta nada', () => {
      // "Open Season" e nome de filme, nao anuncio de temporada.
      expect(parseFolderTitle('Open Season').title).toBe('Open Season');
      expect(parseFolderTitle('Open Season').season).toBeNull();
    });
  });

  describe('tokens de release sem temporada nenhuma', () => {
    test.each([
      ['Cowboy.Bebop.1080p.BluRay.x264-GROUP', 'Cowboy Bebop'],
      ['Akira 1988 2160p UHD BluRay REMUX HDR10 x265-GRUPO', 'Akira'],
      ['Chaves 720p HDTV DUAL', 'Chaves'],
      ['Serie [1080p] [DUAL]', 'Serie'],
      ['One Piece [1080p] [Dual Audio]', 'One Piece'],
    ])('"%s" -> "%s"', (raw, esperado) => {
      const parsed = parseFolderTitle(raw);
      expect(parsed.title).toBe(esperado);
      expect(parsed.isRelease).toBe(true);
    });

    test('token ambiguo no fim do titulo nao e confundido com plataforma', () => {
      // "MAX" e plataforma, mas tambem e metade de "Mad Max".
      expect(parseFolderTitle('Mad Max').title).toBe('Mad Max');
      expect(parseFolderTitle('Mad Max 1080p BluRay').title).toBe('Mad Max');
      expect(parseFolderTitle('Mad.Max.Fury.Road.2015.2160p.MAX.WEB-DL.x265-GRUPO').title).toBe(
        'Mad Max Fury Road',
      );
    });

    test('nome sem nada de release fica intacto', () => {
      for (const nome of ['Pica-Pau', 'He-Man', 'A-Team', 'Ação & Aventura!', 'ドラえもん']) {
        const parsed = parseFolderTitle(nome);
        expect(parsed.title).toBe(nome);
        expect(parsed.isRelease).toBe(false);
      }
    });
  });

  describe('grupo de release', () => {
    test('sufixo de grupo sai quando o resto ja e release', () => {
      expect(parseFolderTitle('Chaves.1080p.WEB-DL-SiGLA').title).toBe('Chaves');
      expect(parseFolderTitle('Chaves 1080p [RARBG]').title).toBe('Chaves');
    });

    test('sem sinal de release, o hifen e parte do nome', () => {
      expect(parseFolderTitle('Law-Abiding').title).toBe('Law-Abiding');
      expect(parseFolderTitle('Law-Abiding Citizen').title).toBe('Law-Abiding Citizen');
    });
  });

  describe('ano', () => {
    test.each([
      ['Batman (1992)', 'Batman', 1992],
      ['Cowboy Bebop (1998-1999)', 'Cowboy Bebop', 1998],
      ['Doctor Who (2005) Especiais', 'Doctor Who Especiais', 2005],
      ['Mad.Max.Fury.Road.2015.1080p.BluRay.x264-GRUPO', 'Mad Max Fury Road', 2015],
    ])('"%s" -> "%s" ano %i', (raw, titulo, ano) => {
      const parsed = parseFolderTitle(raw);
      expect(parsed.title).toBe(titulo);
      expect(parsed.year).toBe(ano);
    });

    test('ano depois da temporada nao entra: e ano DAQUELA temporada', () => {
      // Usar isso na chave separaria a S01 da S02 da mesma serie.
      expect(parseFolderTitle('Chaves.1a.Temporada.1972.DVDRip').year).toBeNull();
    });

    test('numero solto que nao e ano fica no titulo', () => {
      expect(parseFolderTitle('Serie 1').title).toBe('Serie 1');
      expect(parseFolderTitle('Serie 12').title).toBe('Serie 12');
    });
  });

  describe('titulo final', () => {
    test('nunca devolve vazio', () => {
      for (const nome of ['1080p', 'S01', 'WEB-DL', '   ', '-']) {
        expect(parseFolderTitle(nome).title).not.toBe('');
      }
    });

    test('pontuacao orfa sai das pontas, parentese balanceado fica', () => {
      expect(parseFolderTitle('- Chaves -').title).toBe('Chaves');
      expect(parseFolderTitle('Batman (Serie Animada)').title).toBe('Batman (Serie Animada)');
    });

    test('preserva a caixa original, sem inventar Title Case', () => {
      expect(parseFolderTitle('THE.WIRE.S01.1080p').title).toBe('THE WIRE');
      expect(parseFolderTitle('os simpsons S12').title).toBe('os simpsons');
    });
  });

  describe('isRelease', () => {
    test.each([
      ['Rick.and.Morty.S01.1080p.WEB-DL-SiGLA', true],
      ['Chaves 720p', true],
      ['Os.Simpsons.Temporada.12', true],
      ['Pica-Pau', false],
      ['Batman (1992)', false],
      ['Tom e Jerry', false],
    ])('"%s" -> %s', (raw, esperado) => {
      expect(parseFolderTitle(raw).isRelease).toBe(esperado);
    });
  });
});

describe('groupingKey', () => {
  test('as tres temporadas da mesma serie caem na mesma chave', () => {
    const chaves = [
      'Rick.and.Morty.S01.1080p.HMAX.WEB-DL.DD2.0.x264-DUAL-SiGLA',
      'Rick.and.Morty.S02.1080p.HMAX.WEB-DL.DD2.0.x264-DUAL-SiGLA',
      'Rick.and.Morty.S03.2160p.NF.WEB-DL.DDP5.1.x265-DUAL-SiGLA',
    ].map((nome) => groupingKey(parseFolderTitle(nome)));

    expect(new Set(chaves).size).toBe(1);
  });

  test('series diferentes com prefixo em comum ficam em chaves diferentes', () => {
    const us = groupingKey(parseFolderTitle('The.Office.US.S03.720p.WEBRip'));
    const uk = groupingKey(parseFolderTitle('The.Office.UK.S01.720p.WEBRip'));
    expect(us).not.toBe(uk);
  });

  test('o ano entra na chave e separa remake de original', () => {
    expect(groupingKey(parseFolderTitle('Batman (1992)'))).not.toBe(
      groupingKey(parseFolderTitle('Batman (1966)')),
    );
    expect(groupingKey(parseFolderTitle('Batman (1992)'))).toBe('batman@1992');
  });

  test('nome sem letra ASCII ainda gera chave estavel e unica', () => {
    const doraemon = groupingKey(parseFolderTitle('ドラえもん'));
    expect(doraemon).not.toBe('');
    expect(doraemon).not.toBe(groupingKey(parseFolderTitle('サザエさん')));
  });
});

describe('cleanSearchTerm', () => {
  test('pasta de release vira o titulo limpo', () => {
    expect(cleanSearchTerm('Rick.and.Morty.S01.1080p.HMAX.WEB-DL.DD2.0.x264-DUAL-SiGLA')).toBe(
      'Rick and Morty',
    );
  });

  test('fora de release, so o sufixo de ano sai', () => {
    expect(cleanSearchTerm('Batman (1989)')).toBe('Batman');
    expect(cleanSearchTerm('Batman (Serie Animada)')).toBe('Batman (Serie Animada)');
    expect(cleanSearchTerm('Doctor Who (2005) Especiais')).toBe('Doctor Who (2005) Especiais');
    expect(cleanSearchTerm('  He-Man   e  os  Mestres ')).toBe('He-Man e os Mestres');
  });

  test('nome so de espaco vira string vazia, e quem chama nao busca nada', () => {
    expect(cleanSearchTerm('   ')).toBe('');
  });
});
