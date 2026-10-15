const test = require('node:test');
const assert = require('node:assert/strict');

const { buildElectionIntelligenceReport, buildCaboSummaryModel } = require('./src/lib/electionIntelligenceReport');

test('agrupa eleitores por cabo/subcabo e ordena por votos prometidos', () => {
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
  assert.equal(report.detailed[0].prometidos, 2);
  assert.equal(report.detailed[0].secoes[0].bairro, 'Centro');
  assert.deepEqual(report.detailed[0].bairros[0].secoes[0].eleitores, ['Bia', 'Caio']);
  assert.equal(report.detailed[0].bairros[0].secoes[0].prometidosSecao, 2);
  assert.equal(report.cabos[0].cabo, 'Carlos');
  assert.equal(report.cabos[0].votos, 2);
  assert.equal(report.cabos[1].faltantes, 1);
  assert.equal(report.cabos[0].subcabos[0].subcabo, 'Ana');
  assert.equal(report.cabos[0].subcabos[0].secoes, 1);
  assert.equal(report.subcabos[0].cabo, 'Carlos');
  assert.equal(report.subcabos[0].prometidos, 2);
  assert.equal(report.subcabos[0].apurado, 10);
  assert.equal(report.subcabos[0].secoesCompartilhadas, 0);
  assert.equal(report.totals.prometidos, 3);
  assert.equal(report.totals.apurado, 10);
  assert.equal(report.sectionAudits.length, 2);
});

test('monta hierarquia nominal, prioriza faltas e não duplica a seção compartilhada entre cabos', () => {
  const selectedVoters = [
    ...['A', 'B', 'C'].map((name) => ({ name, city: 'Fortaleza', neighborhood: 'Bom Jardim', zone: '1', section: '141', creatorName: 'Solange', creatorRole: 'SUBCABO', caboName: 'Felipe' })),
    ...['D', 'E'].map((name) => ({ name, city: 'Fortaleza', neighborhood: 'Bom Jardim', zone: '1', section: '139', creatorName: 'Solange', creatorRole: 'SUBCABO', caboName: 'Felipe' })),
    { name: 'F', city: 'Caucaia', neighborhood: 'Centro', zone: '2', section: '25', creatorName: 'Solange', creatorRole: 'SUBCABO', caboName: 'Felipe' },
    ...['G', 'H'].map((name) => ({ name, city: 'Fortaleza', neighborhood: 'Serrinha', zone: '4', section: '210', creatorName: 'Andre', creatorRole: 'SUBCABO', caboName: 'Felipe' })),
  ];
  const allTeamSectionRows = [
    { city: 'Fortaleza', neighborhood: 'Bom Jardim', zone: '1', section: '141', creatorName: 'Solange', creatorRole: 'SUBCABO', caboName: 'Felipe', prometidos: 3 },
    { city: 'Fortaleza', neighborhood: 'Bom Jardim', zone: '1', section: '139', creatorName: 'Solange', creatorRole: 'SUBCABO', caboName: 'Felipe', prometidos: 2 },
    { city: 'Caucaia', neighborhood: 'Centro', zone: '2', section: '25', creatorName: 'Solange', creatorRole: 'SUBCABO', caboName: 'Felipe', prometidos: 1 },
    { city: 'Fortaleza', neighborhood: 'Serrinha', zone: '4', section: '210', creatorName: 'Andre', creatorRole: 'SUBCABO', caboName: 'Felipe', prometidos: 2 },
    { city: 'Fortaleza', neighborhood: 'Bom Jardim', zone: '1', section: '141', creatorName: 'Outro', creatorRole: 'SUBCABO', caboName: 'Marina', prometidos: 2 },
  ];
  const report = buildElectionIntelligenceReport({
    voters: selectedVoters,
    teamSectionRows: allTeamSectionRows,
    tseRows: [
      { city: 'Fortaleza', zone: '1', section: '141', total: 4 },
      { city: 'Fortaleza', zone: '1', section: '139', total: 0 },
      { city: 'Fortaleza', zone: '4', section: '210', total: 0 },
      { city: 'Caucaia', zone: '2', section: '25', total: 4 },
    ],
  });

  assert.deepEqual(report.hierarchy.map((cabo) => cabo.cabo), ['Felipe']);
  assert.equal(report.hierarchy[0].subcabos[0].subcabo, 'Solange');
  assert.equal(report.hierarchy[0].subcabos[0].prometidos, 6);
  assert.equal(report.hierarchy[0].subcabos[0].cidades[0].city, 'Fortaleza');
  const missingSections = report.hierarchy[0].subcabos[0].cidades[0].bairros[0].secoesComFaltas;
  assert.deepEqual(missingSections.map((section) => section.secao), ['0139', '0141']);
  assert.deepEqual(missingSections[1].eleitores, ['A', 'B', 'C']);
  assert.equal(missingSections[1].prometidosSecao, 5);
  assert.equal(missingSections[1].apurado, 4);
  assert.equal(missingSections[1].faltantes, 1);
  assert.equal(missingSections[1].compartilhadaEntreCabos, true);
  assert.equal(report.totals.prometidos, 10);
  assert.equal(report.totals.apurado, 8);
  assert.equal(report.totals.faltantes, 5);
  assert.equal(report.sectionAudits.find((section) => section.secao === '0141').teams.length, 2);
  assert.equal(report.cabos[0].prometidos, 8);
  assert.equal(report.cabos[0].prometidosExclusivos, 5);
  assert.equal(report.cabos[0].prometidosCompartilhados, 3);
  assert.equal(report.cabos[0].apurado, 4);
  assert.equal(report.cabos[0].secoesCompartilhadas, 1);
  assert.equal(report.sharedSections.length, 1);
  assert.equal(report.sharedSections[0].prometidos, 5);
  assert.equal(report.sharedSections[0].apurado, 4);
  assert.equal(report.sharedSections[0].faltantes, 1);

  const caboSummary = buildCaboSummaryModel(report);
  assert.deepEqual(caboSummary.cabos.map(({ cabo, prometidos, prometidosExclusivos, apurado, faltantes }) => (
    [cabo, prometidos, prometidosExclusivos, apurado, faltantes]
  )), [['Felipe', 8, 5, 4, 4]]);
  assert.equal(caboSummary.sections.length, 3);
  assert.equal(caboSummary.sections.some((section) => section.compartilhadaEntreCabos), false);
  assert.equal(caboSummary.sharedSections.length, 1);
  assert.deepEqual(caboSummary.sharedSections[0].teams.map((team) => team.cabo).sort(), ['Felipe', 'Marina']);
  assert.notEqual(report.totals.prometidos, caboSummary.cabos[0].prometidos);
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
  assert.deepEqual(report.subcabos.map((item) => [item.prometidos, item.apurado, item.secoesCompartilhadas]), [[1, 0, 1], [1, 0, 1]]);
});
