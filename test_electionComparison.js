const test = require('node:test');
const assert = require('node:assert/strict');

const { buildComparisonRows } = require('./src/lib/electionComparison');

test('agrupa cadastros por cabo, subcabo, zona e seção e une votos TSE', () => {
  const rows = buildComparisonRows({
    candidateName: 'Keivia Dias',
    voters: [
      { city: 'Fortaleza', zone: '2', section: '533', creatorRole: 'SUBCABO', creatorName: 'Pedro', caboName: 'Felipe' },
      { city: 'FORTALEZA', zone: '02', section: '0533', creatorRole: 'SUBCABO', creatorName: 'Pedro', caboName: 'Felipe' },
      { city: 'Fortaleza', zone: '3', section: '987', creatorRole: 'CABO', creatorName: 'Felipe', caboName: null },
    ],
    tseRows: [
      { candidateName: 'Keivia Dias', city: 'FORTALEZA', zone: '02', section: '0533', total: '3' },
      { candidateName: 'Outra Candidata', city: 'FORTALEZA', zone: '02', section: '0533', total: '99' },
      { candidateName: 'Keivia Dias', city: 'Fortaleza', zone: '4', section: '12', total: '5' },
    ],
  });

  assert.deepEqual(rows, [
    {
      cabo: 'Felipe', subcabo: 'Pedro', zona: '02', secao: '0533',
      cadastrados: 2, apurado: 3, diferenca: -1, status: 'OK',
    },
    {
      cabo: 'Felipe', subcabo: '', zona: '03', secao: '0987',
      cadastrados: 1, apurado: 0, diferenca: 1, status: 'Faltam 1 votos',
    },
    {
      cabo: '', subcabo: '', zona: '04', secao: '0012',
      cadastrados: 0, apurado: 5, diferenca: -5, status: 'OK',
    },
  ]);
});
