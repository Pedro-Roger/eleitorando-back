const test = require('node:test');
const assert = require('node:assert/strict');
const { buildScopedElectionReports } = require('../scopedElectionReports');

const voter = (overrides) => ({
  name: 'Pessoa', city: 'Fortaleza', neighborhood: 'Messejana', zone: 120, section: 533,
  creatorId: 1, creatorName: 'Felipe', creatorRole: 'CABO', caboName: 'Felipe', caboId: 1,
  ...overrides,
});

test('seção exclusiva: entregue e faltante vêm da regra compartilhada', () => {
  const report = buildScopedElectionReports({
    voters: [
      voter({ creatorId: 2, creatorName: 'Solange', creatorRole: 'SUBCABO', caboId: 1, caboName: 'Felipe' }),
      voter({ creatorId: 2, creatorName: 'Solange', creatorRole: 'SUBCABO', caboId: 1, caboName: 'Felipe' }),
    ],
    tseRows: [{ city: 'Fortaleza', zone: 120, section: 533, total: 1 }],
  });
  const cabo = report.cabos[0];
  const section = cabo.cidades[0].subcabos[0].zonas[0].secoes[0];
  assert.equal(section.prometidos, 2);
  assert.equal(section.entregue, 1);
  assert.equal(section.faltante, 1);
  assert.equal(section.compartilhada, false);
  assert.equal(cabo.entregue, 1);
  assert.equal(cabo.quebra, 0.5);
});

test('seção com mais de um subcabo é informada como compartilhada, mas conta inteira no total do cabo', () => {
  const report = buildScopedElectionReports({
    voters: [
      voter({ creatorId: 2, creatorName: 'Solange', creatorRole: 'SUBCABO', caboId: 1, caboName: 'Felipe' }),
      voter({ creatorId: 3, creatorName: 'André', creatorRole: 'SUBCABO', caboId: 1, caboName: 'Felipe' }),
    ],
    tseRows: [{ city: 'Fortaleza', zone: 120, section: 533, total: 1 }],
  });
  const cabo = report.cabos[0];
  assert.equal(cabo.prometidos, 2);
  assert.equal(cabo.compartilhadas, 1);
  assert.equal(cabo.prometidosCompartilhados, 0);
  assert.equal(cabo.entregue, 1);
  assert.equal(cabo.faltante, 1);
});

test('secao compartilhada entre subcabos do mesmo cabo conta inteira no total do cabo', () => {
  const base = { city: 'Fortaleza', neighborhood: 'Messejana', zone: 120, section: 533, creatorRole: 'SUBCABO', caboId: 1, caboName: 'Felipe' };
  const report = buildScopedElectionReports({
    voters: [
      { ...base, name: 'Ana', creatorId: 2, creatorName: 'Solange' },
      { ...base, name: 'Bruno', creatorId: 3, creatorName: 'Andre' },
    ],
    tseRows: [{ city: 'Fortaleza', zone: 120, section: 533, total: 1 }],
    candidateName: 'X', year: 2026, office: 'DEPUTADO', turn: 1,
  });
  const cabo = report.cabos[0];
  assert.equal(cabo.prometidos, 2);
  assert.equal(cabo.entregue, 1);
  assert.equal(cabo.faltante, 1);
});

test('secao com eleitores de dois cabos conta uma vez no total geral', () => {
  const base = { city: 'Fortaleza', neighborhood: 'Messejana', zone: 120, section: 533, creatorRole: 'CABO' };
  const report = buildScopedElectionReports({
    voters: [
      { ...base, name: 'Ana', creatorId: 1, creatorName: 'Felipe', caboId: 1, caboName: 'Felipe' },
      { ...base, name: 'Carla', creatorId: 9, creatorName: 'Outro', caboId: 9, caboName: 'Outro' },
    ],
    tseRows: [{ city: 'Fortaleza', zone: 120, section: 533, total: 1 }],
    candidateName: 'X', year: 2026, office: 'DEPUTADO', turn: 1,
  });
  assert.equal(report.totais.prometidos, 2);
  assert.equal(report.totais.entregue, 1);
  assert.equal(report.totais.faltante, 1);
});

test('apurado soma os votos TSE das seções uma vez, no cabo e no total', () => {
  const report = buildScopedElectionReports({
    voters: [
      voter({ creatorId: 2, creatorName: 'Solange', creatorRole: 'SUBCABO', caboId: 1, caboName: 'Felipe' }),
      voter({ creatorId: 3, creatorName: 'André', creatorRole: 'SUBCABO', caboId: 1, caboName: 'Felipe' }),
      voter({ section: 534 }),
    ],
    tseRows: [
      { city: 'Fortaleza', zone: 120, section: 533, total: 40 },
      { city: 'Fortaleza', zone: 120, section: 534, total: 7 },
    ],
  });
  assert.equal(report.cabos[0].apurado, 47);
  assert.equal(report.totais.apurado, 47);
});
