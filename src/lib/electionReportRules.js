// Regra única do relatório: prometido x entregue (TSE) x faltante, por seção.
// Não lê banco nem formata texto; só aritmética.
function sectionDelivery({ prometidos, tse }) {
  if (tse === null || tse === undefined) {
    return { prometidos, entregue: null, faltante: null, excedente: null, status: 'sem-apuracao' };
  }
  const entregue = Math.min(prometidos, tse);
  const faltante = prometidos - entregue;
  return {
    prometidos,
    entregue,
    faltante,
    excedente: Math.max(tse - prometidos, 0),
    status: faltante > 0 ? 'com-falta' : 'ok',
  };
}

function markShared(sections, unitOf) {
  return sections.map((section) => {
    const units = new Set(section.pessoas.map(unitOf));
    return { ...section, compartilhada: units.size > 1 };
  });
}

function sumDeliveries(sections) {
  const totals = {
    prometidos: 0, entregue: 0, faltante: 0, excedente: 0,
    prometidosCompartilhados: 0, prometidosSemApuracao: 0,
  };
  for (const section of sections) {
    totals.prometidos += section.prometidos;
    if (section.compartilhada) {
      totals.prometidosCompartilhados += section.prometidos;
      continue;
    }
    if (section.entregue === null) {
      totals.prometidosSemApuracao += section.prometidos;
      continue;
    }
    totals.entregue += section.entregue;
    totals.faltante += section.faltante;
    totals.excedente += section.excedente;
  }
  return totals;
}

function coverage({ prometidos, entregue }) {
  return prometidos > 0 ? entregue / prometidos : 0;
}

module.exports = { sectionDelivery, markShared, sumDeliveries, coverage };
