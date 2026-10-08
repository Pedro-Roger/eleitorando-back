function reportTeam(row) {
  return { cabo: String(row.cabo || '').trim(), subcabo: String(row.subcabo || '').trim() };
}

function teamKey(team) {
  return `${team.cabo}\u0000${team.subcabo}`;
}

function sectionKey(row) {
  return `${row.zona}\u0000${row.secao}`;
}

function compareNames(a, b) {
  return String(a || '').localeCompare(String(b || ''), 'pt-BR');
}

function buildElectionReport({ candidateName, comparisonRows, rows = [] }) {
  const sourceRows = comparisonRows || rows;
  const summaryMap = new Map();
  const sectionMap = new Map();

  for (const row of sourceRows) {
    const team = reportTeam(row);
    const key = teamKey(team);
    const cadastrados = Number(row.cadastrados) || 0;
    const apurado = Number(row.apurado) || 0;
    const confirmados = Math.min(cadastrados, apurado);
    const faltantes = Math.max(cadastrados - apurado, 0);
    const summary = summaryMap.get(key) || {
      ...team, cadastrados: 0, confirmados: 0, faltantes: 0, sections: new Set(),
    };
    summary.cadastrados += cadastrados;
    summary.confirmados += confirmados;
    summary.faltantes += faltantes;
    summary.sections.add(sectionKey(row));
    summaryMap.set(key, summary);

    const section = sectionMap.get(sectionKey(row)) || {
      zona: row.zona,
      secao: row.secao,
      cadastrados: 0,
      apurado: 0,
    };
    section.cadastrados += cadastrados;
    // O apurado é o mesmo por zona/seção em todas as equipes: nunca somar duplicado.
    section.apurado = Math.max(section.apurado, Number(row.apurado) || 0);
    sectionMap.set(sectionKey(row), section);
  }

  const summary = [...summaryMap.values()]
    .map(({ sections, ...row }) => ({ ...row, secoes: sections.size }))
    .sort((a, b) => (
      compareNames(a.cabo, b.cabo)
      || (a.subcabo ? 0 : 1) - (b.subcabo ? 0 : 1)
      || compareNames(a.subcabo, b.subcabo)
    ));

  const details = [...sectionMap.values()]
    .map((row) => ({
      ...row,
      confirmados: Math.min(row.cadastrados, row.apurado),
      faltantes: Math.max(row.cadastrados - row.apurado, 0),
    }))
    .sort((a, b) => Number(a.zona) - Number(b.zona) || Number(a.secao) - Number(b.secao));

  return {
    candidateName,
    summary,
    details,
    missing: details.filter((row) => row.faltantes > 0),
    totalCadastrados: summary.reduce((total, row) => total + row.cadastrados, 0),
    totalConfirmados: details.reduce((total, row) => total + row.confirmados, 0),
    totalApurado: details.reduce((total, row) => total + row.apurado, 0),
    totalFaltantes: details.reduce((total, row) => total + row.faltantes, 0),
  };
}

module.exports = { buildElectionReport };
