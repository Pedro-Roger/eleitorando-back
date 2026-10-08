const test = require('node:test');
const assert = require('node:assert/strict');

const { buildElectionReport } = require('./src/lib/electionReport');

test('resume equipes e lista somente faltas positivas por zona e seção', () => {
  const report = buildElectionReport({
    candidateName: 'Erika Amorim',
    comparisonRows: [
      { cabo: 'Felipe', subcabo: 'Pedro', zona: '01', secao: '0001', cadastrados: 4, apurado: 10 },
      { cabo: 'Felipe', subcabo: 'João', zona: '01', secao: '0001', cadastrados: 3, apurado: 10 },
      { cabo: 'Maria', subcabo: 'Ana', zona: '02', secao: '0002', cadastrados: 8, apurado: 5 },
      { cabo: 'Maria', subcabo: '', zona: '02', secao: '0003', cadastrados: 0, apurado: 3 },
    ],
  });

  assert.deepEqual(report.summary, [
    { cabo: 'Felipe', subcabo: 'João', cadastrados: 3, confirmados: 3, faltantes: 0, secoes: 1 },
    { cabo: 'Felipe', subcabo: 'Pedro', cadastrados: 4, confirmados: 4, faltantes: 0, secoes: 1 },
    { cabo: 'Maria', subcabo: 'Ana', cadastrados: 8, confirmados: 5, faltantes: 3, secoes: 1 },
    { cabo: 'Maria', subcabo: '', cadastrados: 0, confirmados: 0, faltantes: 0, secoes: 1 },
  ]);
  assert.deepEqual(report.missing, [
    { cabo: 'Maria', subcabo: 'Ana', zona: '02', secao: '0002', cadastrados: 8, apurado: 5, confirmados: 5, faltantes: 3 },
  ]);
  assert.deepEqual(report.details.find((row) => row.zona === '02' && row.secao === '0002'), {
    cabo: 'Maria', subcabo: 'Ana', zona: '02', secao: '0002', cadastrados: 8, apurado: 5, confirmados: 5, faltantes: 3,
  });
  assert.equal(report.totalCadastrados, 15);
  assert.equal(report.totalConfirmados, 12);
  assert.equal(report.totalApurado, 18);
  assert.equal(report.totalFaltantes, 3);
  assert.equal(report.candidateName, 'Erika Amorim');
});

test('aceita o formato rows usado pela rota de comparação', () => {
  const report = buildElectionReport({
    candidateName: 'Erika Amorim',
    rows: [{ cabo: 'Felipe', subcabo: 'Elio', zona: '118', secao: '0476', cadastrados: 2, apurado: 1 }],
  });

  assert.equal(report.totalFaltantes, 1);
  assert.deepEqual(report.missing, [{ cabo: 'Felipe', subcabo: 'Elio', zona: '118', secao: '0476', cadastrados: 2, apurado: 1, confirmados: 1, faltantes: 1 }]);
});
