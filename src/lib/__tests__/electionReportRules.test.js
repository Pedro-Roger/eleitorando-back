const test = require('node:test');
const assert = require('node:assert/strict');
const { sectionDelivery, markShared, sumDeliveries, coverage } = require('../electionReportRules');

test('entregue é o mínimo entre prometido e votos TSE', () => {
  assert.deepEqual(sectionDelivery({ prometidos: 5, tse: 3 }), {
    prometidos: 5, entregue: 3, faltante: 2, excedente: 0, status: 'com-falta',
  });
});

test('votos TSE acima do prometido viram excedente, não falta', () => {
  assert.deepEqual(sectionDelivery({ prometidos: 2, tse: 7 }), {
    prometidos: 2, entregue: 2, faltante: 0, excedente: 5, status: 'ok',
  });
});

test('seção sem apuração não tem entregue nem falta', () => {
  const section = sectionDelivery({ prometidos: 4, tse: null });
  assert.equal(section.entregue, null);
  assert.equal(section.faltante, null);
  assert.equal(section.status, 'sem-apuracao');
});

test('markShared marca seção com pessoas de mais de uma unidade', () => {
  const sections = [
    { id: 'a', pessoas: [{ subcaboId: 1 }, { subcaboId: 2 }] },
    { id: 'b', pessoas: [{ subcaboId: 1 }] },
  ];
  const marked = markShared(sections, (person) => person.subcaboId);
  assert.equal(marked[0].compartilhada, true);
  assert.equal(marked[1].compartilhada, false);
});

test('sumDeliveries separa compartilhadas e sem apuração e fecha o total prometido', () => {
  const sections = [
    { prometidos: 5, ...sectionDelivery({ prometidos: 5, tse: 3 }), compartilhada: false },
    { prometidos: 2, ...sectionDelivery({ prometidos: 2, tse: 7 }), compartilhada: false },
    { prometidos: 4, ...sectionDelivery({ prometidos: 4, tse: null }), compartilhada: false },
    { prometidos: 6, ...sectionDelivery({ prometidos: 6, tse: 1 }), compartilhada: true },
  ];
  const totals = sumDeliveries(sections);
  assert.deepEqual(totals, {
    prometidos: 17, entregue: 5, faltante: 2, excedente: 5,
    prometidosCompartilhados: 6, prometidosSemApuracao: 4,
  });
  assert.equal(totals.prometidos, totals.entregue + totals.faltante + totals.prometidosCompartilhados + totals.prometidosSemApuracao);
});

test('coverage é entregue sobre prometido e zero quando não há prometidos', () => {
  assert.equal(coverage({ prometidos: 10, entregue: 4 }), 0.4);
  assert.equal(coverage({ prometidos: 0, entregue: 0 }), 0);
});
