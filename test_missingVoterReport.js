const test = require('node:test');
const assert = require('node:assert/strict');
const { buildMissingVoterRows } = require('./src/lib/missingVoterReport');

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
    { name: 'Ana', phone: '111', cabo: 'Felipe', subcabo: 'Pedro', zona: '01', secao: '0006' },
    { name: 'Bia', phone: '222', cabo: 'Felipe', subcabo: 'Pedro', zona: '01', secao: '0006' },
  ]);
});
