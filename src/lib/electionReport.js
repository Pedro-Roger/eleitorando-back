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
  const detailMap = new Map();
  const totalSectionMap = new Map();

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

    const detailKey = `${key}\u0000${sectionKey(row)}`;
    const detail = detailMap.get(detailKey) || {
      ...team,
      zona: row.zona,
      secao: row.secao,
      cadastrados: 0,
      apurado: 0,
    };
    detail.cadastrados += cadastrados;
    // O apurado é o mesmo por zona/seção em todas as equipes: nunca somar duplicado.
    detail.apurado = Math.max(detail.apurado, apurado);
    detailMap.set(detailKey, detail);

    const totalSection = totalSectionMap.get(sectionKey(row)) || {
      zona: row.zona, secao: row.secao, cadastrados: 0, apurado: 0,
    };
    totalSection.cadastrados += cadastrados;
    totalSection.apurado = Math.max(totalSection.apurado, apurado);
    totalSectionMap.set(sectionKey(row), totalSection);
  }

  const summary = [...summaryMap.values()]
    .map(({ sections, ...row }) => ({
      ...row,
      secoes: sections.size,
      percentualFaltantes: row.cadastrados ? Math.round((row.faltantes / row.cadastrados) * 100) : 0,
    }))
    .sort((a, b) => (
      compareNames(a.cabo, b.cabo)
      || (a.subcabo ? 0 : 1) - (b.subcabo ? 0 : 1)
      || compareNames(a.subcabo, b.subcabo)
    ));

  const details = [...detailMap.values()]
    .map((row) => ({
      ...row,
      confirmados: Math.min(row.cadastrados, row.apurado),
      faltantes: Math.max(row.cadastrados - row.apurado, 0),
    }))
    .map((row) => ({
      ...row,
      percentualFaltantes: row.cadastrados ? Math.round((row.faltantes / row.cadastrados) * 100) : 0,
    }))
    .sort((a, b) => Number(a.zona) - Number(b.zona) || Number(a.secao) - Number(b.secao));

  return {
    candidateName,
    summary,
    details,
    missing: details.filter((row) => row.faltantes > 0),
    totalCadastrados: summary.reduce((total, row) => total + row.cadastrados, 0),
    totalConfirmados: [...totalSectionMap.values()].reduce((total, row) => total + Math.min(row.cadastrados, row.apurado), 0),
    totalApurado: [...totalSectionMap.values()].reduce((total, row) => total + row.apurado, 0),
    totalFaltantes: [...totalSectionMap.values()].reduce((total, row) => total + Math.max(row.cadastrados - row.apurado, 0), 0),
  };
}

module.exports = { buildElectionReport };
