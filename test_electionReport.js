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
    { cabo: 'Maria', subcabo: 'Ana', cadastrados: 8, secoes: 1, secoesComFaltantes: 1 },
    { cabo: 'Maria', subcabo: '', cadastrados: 0, secoes: 1, secoesComFaltantes: 0 },
    { cabo: 'Felipe', subcabo: 'Pedro', cadastrados: 4, secoes: 1, secoesComFaltantes: 0 },
    { cabo: 'Felipe', subcabo: 'João', cadastrados: 3, secoes: 1, secoesComFaltantes: 0 },
  ]);
  assert.deepEqual(report.missing, [
    { zona: '02', secao: '0002', cadastrados: 8, apurado: 5, confirmados: 5, faltantes: 3, percentualFaltantes: 38, teams: [{ cabo: 'Maria', subcabo: 'Ana' }], compartilhada: false, compartilhadaEntreCabos: false },
  ]);
  assert.equal(report.details.length, 3);
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
  assert.deepEqual(report.missing, [{ zona: '118', secao: '0476', cadastrados: 2, apurado: 1, confirmados: 1, faltantes: 1, percentualFaltantes: 50, teams: [{ cabo: 'Felipe', subcabo: 'Elio' }], compartilhada: false, compartilhadaEntreCabos: false }]);
});

test('mantém cidades diferentes separadas mesmo quando zona e seção coincidem', () => {
  const report = buildElectionReport({
    comparisonRows: [
      { city: 'FORTALEZA', cabo: 'Equipe A', zona: '01', secao: '0001', cadastrados: 3, apurado: 5 },
      { city: 'SOBRAL', cabo: 'Equipe B', zona: '01', secao: '0001', cadastrados: 4, apurado: 2 },
    ],
  });

  assert.equal(report.totalApurado, 7);
  assert.equal(report.totalConfirmados, 5);
  assert.equal(report.totalFaltantes, 2);
  assert.equal(report.details.length, 2);
  assert.deepEqual(report.details.map((row) => row.city).sort(), ['FORTALEZA', 'SOBRAL']);
});

test('calcula a falta uma vez por seção e mantém todos os cabos associados', () => {
  const report = buildElectionReport({
    comparisonRows: [
      { city: 'Fortaleza', cabo: 'Ana', subcabo: 'Bia', zona: '01', secao: '0001', cadastrados: 2, apurado: 3 },
      { city: 'Fortaleza', cabo: 'Ana', subcabo: 'Caio', zona: '01', secao: '0001', cadastrados: 2, apurado: 3 },
    ],
  });

  assert.equal(report.details.length, 1);
  assert.equal(report.details[0].cadastrados, 4);
  assert.equal(report.details[0].apurado, 3);
  assert.equal(report.details[0].faltantes, 1);
  assert.deepEqual(report.details[0].teams.map((team) => team.subcabo), ['Bia', 'Caio']);
  assert.equal(report.summary.every((row) => row.secoesComFaltantes === 1), true);
  assert.equal(Object.hasOwn(report.summary[0], 'faltantes'), false);
});

test('mantém resumo do cabo filtrado, mas calcula diferença com todas as equipes da seção', () => {
  const report = buildElectionReport({
    comparisonRows: [
      { city: 'Fortaleza', cabo: 'Felipe', subcabo: 'Solange', zona: '01', secao: '0141', cadastrados: 2, apurado: 4 },
    ],
    teamSectionRows: [
      { city: 'Fortaleza', zone: '1', section: '141', creatorName: 'Solange', creatorRole: 'SUBCABO', caboName: 'Felipe', prometidos: 2 },
      { city: 'Fortaleza', zone: '1', section: '141', creatorName: 'André', creatorRole: 'SUBCABO', caboName: 'Marina', prometidos: 3 },
    ],
  });

  assert.equal(report.summary[0].cadastrados, 2);
  assert.equal(report.details[0].cadastrados, 5);
  assert.equal(report.details[0].faltantes, 1);
  assert.equal(report.details[0].teams.length, 2);
  assert.equal(report.details[0].compartilhadaEntreCabos, true);
});
