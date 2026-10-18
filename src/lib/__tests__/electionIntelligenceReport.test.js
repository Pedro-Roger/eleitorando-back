const test = require('node:test');
const assert = require('node:assert/strict');
const { buildElectionIntelligenceReport } = require('../electionIntelligenceReport');

test('totais por cidade excluem seções compartilhadas entre bairros', () => {
  const voters = [];
  for (let index = 0; index < 30; index += 1) {
    voters.push({ name: `Pessoa A ${index}`, city: 'Fortaleza', neighborhood: 'Messejana', zone: 120, section: 533, creatorRole: 'SUBCABO', creatorName: 'Solange', caboName: 'Felipe' });
    voters.push({ name: `Pessoa B ${index}`, city: 'Fortaleza', neighborhood: 'Messejana', zone: 120, section: 534, creatorRole: 'SUBCABO', creatorName: 'Solange', caboName: 'Felipe' });
  }
  voters.push(
    { name: 'Pessoa compartilhada 1', city: 'Fortaleza', neighborhood: 'Messejana', zone: 120, section: 535, creatorRole: 'SUBCABO', creatorName: 'Solange', caboName: 'Felipe' },
    { name: 'Pessoa compartilhada 2', city: 'Fortaleza', neighborhood: 'Centro', zone: 120, section: 535, creatorRole: 'SUBCABO', creatorName: 'Solange', caboName: 'Felipe' },
  );
  const report = buildElectionIntelligenceReport({
    voters,
    tseRows: [
      { city: 'Fortaleza', zone: 120, section: 533, total: 30 },
      { city: 'Fortaleza', zone: 120, section: 534, total: 0 },
      { city: 'Fortaleza', zone: 120, section: 535, total: 1 },
    ],
  });
  const city = report.detailed[0];
  assert.equal(city.prometidos, 62);
  assert.equal(city.entregue, 30);
  assert.equal(city.faltante, 30);
  assert.equal(city.compartilhadasEntreBairros.length, 1);
  assert.equal(city.compartilhadasEntreBairros[0].secao, '0535');
  const messejana = city.bairros.find((bairro) => bairro.bairro === 'Messejana');
  assert.equal(messejana.entregue, 30);
  assert.equal(messejana.faltante, 30);
  assert.equal(messejana.prometidosCompartilhados, 1);
});
