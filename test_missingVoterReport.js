const test = require('node:test');
const assert = require('node:assert/strict');
const { buildMissingVoterRows, findMissingSections } = require('./src/lib/missingVoterReport');

test('considera a falta pelo total da seção, mesmo com vários subcabos', () => {
  assert.deepEqual(findMissingSections([
    { zona: '01', secao: '0006', cadastrados: 3, apurado: 5 },
    { zona: '01', secao: '0006', cadastrados: 3, apurado: 5 },
    { zona: '01', secao: '0007', cadastrados: 2, apurado: 2 },
  ]), [{ zona: '01', secao: '0006', cadastrados: 6, apurado: 5 }]);
});

test('lista todos os eleitores das seções abaixo da meta', () => {
  const voters = buildMissingVoterRows({
    missingSections: [{ zona: '01', secao: '0006' }],
    voters: [
      { name: 'Ana', phone: '111', zone: '1', section: '6', creatorName: 'Pedro', creatorRole: 'SUBCABO', caboName: 'Felipe' },
      { name: 'Bia', phone: '222', zone: '01', section: '0006', creatorName: 'Pedro', creatorRole: 'SUBCABO', caboName: 'Felipe' },
      { name: 'Caio', phone: '333', zone: '01', section: '0007', creatorName: 'Pedro', creatorRole: 'SUBCABO', caboName: 'Felipe' },
    ],
  });

  assert.deepEqual(voters, [
    { name: 'Ana', phone: '111', city: '—', neighborhood: '—', cabo: 'Felipe', subcabo: 'Pedro', zona: '01', secao: '0006' },
    { name: 'Bia', phone: '222', city: '—', neighborhood: '—', cabo: 'Felipe', subcabo: 'Pedro', zona: '01', secao: '0006' },
  ]);
});

test('não mistura cidades que compartilham zona e seção', () => {
  const missing = findMissingSections([
    { city: 'Fortaleza', zona: '01', secao: '0006', cadastrados: 4, apurado: 1 },
    { city: 'Sobral', zona: '01', secao: '0006', cadastrados: 1, apurado: 5 },
  ]);
  assert.equal(missing.length, 1);
  assert.equal(missing[0].city, 'Fortaleza');
  const voters = buildMissingVoterRows({
    missingSections: missing,
    voters: [
      { name: 'Ana', city: 'Fortaleza', zone: '01', section: '0006' },
      { name: 'Bia', city: 'Sobral', zone: '01', section: '0006' },
    ],
  });
  assert.deepEqual(voters.map((voter) => voter.name), ['Ana']);
});
