const test = require('node:test');
const assert = require('node:assert/strict');

const { buildElectionIntelligenceReport } = require('./src/lib/electionIntelligenceReport');

test('agrupa eleitores por cabo/subcabo e ordena por votos confirmados', () => {
  const report = buildElectionIntelligenceReport({
    candidateName: 'Erika Amorim',
    voters: [
      { name: 'Bia', city: 'Fortaleza', neighborhood: 'Centro', zone: '1', section: '2', creatorName: 'Ana', creatorRole: 'SUBCABO', caboName: 'Carlos' },
      { name: 'Caio', city: 'Fortaleza', neighborhood: 'Centro', zone: '1', section: '2', creatorName: 'Ana', creatorRole: 'SUBCABO', caboName: 'Carlos' },
      { name: 'Duda', city: 'Sobral', neighborhood: 'Junco', zone: '2', section: '3', creatorName: 'Bruno', creatorRole: 'CABO' },
    ],
    tseRows: [
      { city: 'FORTALEZA', zone: '01', section: '0002', total: 10 },
      { city: 'SOBRAL', zone: '02', section: '0003', total: 0 },
    ],
  });

  assert.equal(report.detailed[0].subcabo, 'Ana');
  assert.equal(report.detailed[0].city, 'Fortaleza');
  assert.equal(report.detailed[0].percentualVotos, 100);
  assert.deepEqual(report.detailed[0], {
    cabo: 'Carlos', subcabo: 'Ana', city: 'Fortaleza', prometidos: 2, apurado: 10, votos: 2, faltantes: 0,
    percentualVotos: 100, percentualFaltantes: 0,
    secoes: [{
      city: 'Fortaleza', bairro: 'Centro', zona: '01', secao: '0002', prometidos: 2, apurado: 10, votos: 2,
      faltantes: 0, percentualVotos: 100, percentualFaltantes: 0,
      eleitores: ['Bia', 'Caio'],
    }],
  });
  assert.equal(report.cabos[0].cabo, 'Carlos');
  assert.equal(report.cabos[0].votos, 2);
  assert.equal(report.cabos[1].faltantes, 1);
  assert.equal(report.cabos[0].subcabos[0].subcabo, 'Ana');
  assert.equal(report.subcabos[0].cabo, 'Carlos');
  assert.equal(report.subcabos[0].percentualVotos, 100);
  assert.equal(report.totals.prometidos, 3);
  assert.equal(report.totals.apurado, 10);
  assert.equal(report.sectionAudits.length, 2);
});

test('não duplica votos oficiais quando dois subcabos atuam na mesma seção', () => {
  const report = buildElectionIntelligenceReport({
    voters: [
      { name: 'A', city: 'A', zone: '1', section: '1', creatorName: 'Sub 1', creatorRole: 'SUBCABO', caboName: 'Cabo' },
      { name: 'B', city: 'A', zone: '1', section: '1', creatorName: 'Sub 2', creatorRole: 'SUBCABO', caboName: 'Cabo' },
    ],
    tseRows: [{ city: 'A', zone: '1', section: '1', total: 1 }],
  });

  assert.equal(report.cabos[0].prometidos, 2);
  assert.equal(report.cabos[0].apurado, 1);
  assert.equal(report.cabos[0].votos, 1);
  assert.equal(report.cabos[0].faltantes, 1);
  assert.equal(report.sectionAudits[0].prometidos, 2);
  assert.equal(report.sectionAudits[0].apurado, 1);
  assert.equal(report.sectionAudits[0].faltantes, 1);
});
