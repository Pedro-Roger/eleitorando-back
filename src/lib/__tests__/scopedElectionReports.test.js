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
  assert.equal(cabo.cobertura, 0.5);
});

test('seção com mais de um subcabo é compartilhada e não atribui votos ao cabo', () => {
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
  assert.equal(cabo.prometidosCompartilhados, 2);
  assert.equal(cabo.entregue, 0);
  assert.equal(cabo.faltante, 0);
});
