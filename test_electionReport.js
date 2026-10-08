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
    { cabo: 'Felipe', subcabo: 'João', cadastrados: 3, secoes: 1 },
    { cabo: 'Felipe', subcabo: 'Pedro', cadastrados: 4, secoes: 1 },
    { cabo: 'Maria', subcabo: 'Ana', cadastrados: 8, secoes: 1 },
    { cabo: 'Maria', subcabo: '', cadastrados: 0, secoes: 1 },
  ]);
  assert.deepEqual(report.missing, [
    { zona: '01', secao: '0001', cadastrados: 7, apurado: 10, faltantes: 3 },
    { zona: '02', secao: '0003', cadastrados: 0, apurado: 3, faltantes: 3 },
  ]);
  assert.equal(report.totalCadastrados, 15);
  assert.equal(report.totalApurado, 13);
  assert.equal(report.totalFaltantes, 6);
  assert.equal(report.candidateName, 'Erika Amorim');
});
