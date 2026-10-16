function label(value, fallback = '') {
  return String(value ?? '').trim() || fallback;
}

function key(value) {
  return label(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleUpperCase('pt-BR');
}

function padded(value, width) {
  const number = Number.parseInt(String(value ?? '').trim(), 10);
  return Number.isFinite(number) ? String(number).padStart(width, '0') : '';
}

function locationKey(city, zone, section) {
  return `${key(city)}\u0000${padded(zone, 2)}\u0000${padded(section, 4)}`;
}

function descending(a, b) {
  return b.prometidos - a.prometidos || a.name.localeCompare(b.name, 'pt-BR');
}

function locationHierarchy(sections) {
  const cities = new Map();
  for (const section of sections) {
    const cityKey = key(section.city);
    const city = cities.get(cityKey) || { name: section.city, prometidos: 0, subcabos: new Map() };
    for (const person of section.pessoas) {
      city.prometidos += 1;
      const subKey = person.subcaboId ?? 'CADASTRO DIRETO';
      const subcabo = city.subcabos.get(subKey) || { id: subKey, name: person.subcabo || 'Cadastro direto', prometidos: 0, zonas: new Map() };
      subcabo.prometidos += 1;
      const zone = subcabo.zonas.get(section.zona) || { name: section.zona, prometidos: 0, secoes: new Map() };
      zone.prometidos += 1;
      const subsection = zone.secoes.get(section.secao) || { name: section.secao, prometidos: 0 };
      subsection.prometidos += 1;
      zone.secoes.set(section.secao, subsection);
      subcabo.zonas.set(section.zona, zone);
      city.subcabos.set(subKey, subcabo);
    }
    cities.set(cityKey, city);
  }
  return [...cities.values()].map((city) => ({
    name: city.name, prometidos: city.prometidos,
    subcabos: [...city.subcabos.values()].map((subcabo) => ({
      name: subcabo.name, prometidos: subcabo.prometidos,
      zonas: [...subcabo.zonas.values()].map((zone) => ({
        name: zone.name, prometidos: zone.prometidos,
        secoes: [...zone.secoes.values()].sort(descending),
      })).sort(descending),
    })).sort(descending),
  })).sort(descending);
}

function buildScopedElectionReports({ voters = [], tseRows = [], candidateName = '', filters = {}, year, office, turn }) {
  const official = new Map();
  for (const row of tseRows) {
    const location = locationKey(row.city, row.zone, row.section);
    official.set(location, (official.get(location) || 0) + Number(row.total || row.votes || 0));
  }

  const sections = new Map();
  for (const voter of voters) {
    const zona = padded(voter.zone, 2);
    const secao = padded(voter.section, 4);
    if (!zona || !secao) continue;
    const city = label(voter.city, 'Cidade não informada');
    const cabo = label(voter.creatorRole).toUpperCase() === 'SUBCABO'
      ? label(voter.caboName, 'Cabo não informado') : label(voter.creatorName, 'Cabo não informado');
    const subcabo = label(voter.creatorRole).toUpperCase() === 'SUBCABO' ? label(voter.creatorName) : '';
    const caboId = label(voter.creatorRole).toUpperCase() === 'SUBCABO' ? voter.caboId : voter.creatorId;
    const groupKey = `${caboId ?? key(cabo)}\u0000${locationKey(city, zona, secao)}`;
    const section = sections.get(groupKey) || {
      cabo, caboId, city, zona, secao, pessoas: [],
      apuracaoDisponivel: official.has(locationKey(city, zona, secao)),
      apuradoTseNaSecao: official.get(locationKey(city, zona, secao)) || 0,
    };
    section.pessoas.push({
      name: label(voter.name, 'Pessoa sem nome'),
      subcabo, subcaboId: subcabo ? voter.creatorId : null,
      bairro: label(voter.neighborhood, 'Bairro não informado'),
      city, zona, secao,
    });
    sections.set(groupKey, section);
  }

  const allSections = [...sections.values()].map((section) => {
    const prometidos = section.pessoas.length;
    const possivelmenteVotaram = section.apuracaoDisponivel ? Math.min(prometidos, section.apuradoTseNaSecao) : null;
    const faltantes = section.apuracaoDisponivel ? prometidos - possivelmenteVotaram : null;
    const subcaboCounts = new Map();
    for (const person of section.pessoas) {
      const subKey = person.subcaboId ?? 'CADASTRO DIRETO';
      subcaboCounts.set(subKey, (subcaboCounts.get(subKey) || 0) + 1);
    }
    return {
      ...section, prometidos, possivelmenteVotaram, faltantes,
      percentualFaltantes: section.apuracaoDisponivel ? Math.round((faltantes / prometidos) * 1000) / 10 : null,
      pessoas: section.pessoas.sort((a, b) => (
        (subcaboCounts.get(b.subcaboId ?? 'CADASTRO DIRETO') || 0) - (subcaboCounts.get(a.subcaboId ?? 'CADASTRO DIRETO') || 0)
        || a.subcabo.localeCompare(b.subcabo, 'pt-BR') || a.name.localeCompare(b.name, 'pt-BR')
      )),
    };
  });

  const cabos = new Map();
  for (const section of allSections) {
    const caboKey = section.caboId ?? key(section.cabo);
    const cabo = cabos.get(caboKey) || { id: caboKey, name: section.cabo, prometidos: 0, sections: [], subcabos: new Map() };
    cabo.prometidos += section.prometidos;
    cabo.sections.push(section);
    for (const person of section.pessoas) {
      const subKey = person.subcaboId ?? 'CADASTRO DIRETO';
      const subcabo = cabo.subcabos.get(subKey) || { id: subKey, name: person.subcabo || 'Cadastro direto', prometidos: 0 };
      subcabo.prometidos += 1;
      cabo.subcabos.set(subKey, subcabo);
    }
    cabos.set(caboKey, cabo);
  }
  const rankedCabos = [...cabos.values()].map((cabo) => ({
    id: cabo.id,
    name: cabo.name,
    prometidos: cabo.prometidos,
    secoes: cabo.sections.length,
    secoesComFaltantes: cabo.sections.filter((section) => section.faltantes > 0).length,
    subcabos: [...cabo.subcabos.values()].sort(descending),
    cidades: locationHierarchy(cabo.sections),
  })).sort(descending);
  const rank = new Map(rankedCabos.map((cabo, index) => [cabo.id, index]));
  const cityCounts = new Map();
  const zoneCounts = new Map();
  for (const section of allSections) {
    const cityKey = `${section.caboId ?? key(section.cabo)}\u0000${key(section.city)}`;
    const zoneKey = `${cityKey}\u0000${section.zona}`;
    cityCounts.set(cityKey, (cityCounts.get(cityKey) || 0) + section.prometidos);
    zoneCounts.set(zoneKey, (zoneCounts.get(zoneKey) || 0) + section.prometidos);
  }
  const cityKeyOf = (section) => `${section.caboId ?? key(section.cabo)}\u0000${key(section.city)}`;
  const zoneKeyOf = (section) => `${cityKeyOf(section)}\u0000${section.zona}`;
  const orderedSections = allSections.sort((a, b) => (
    rank.get(a.caboId ?? key(a.cabo)) - rank.get(b.caboId ?? key(b.cabo))
    || cityCounts.get(cityKeyOf(b)) - cityCounts.get(cityKeyOf(a))
    || a.city.localeCompare(b.city, 'pt-BR')
    || zoneCounts.get(zoneKeyOf(b)) - zoneCounts.get(zoneKeyOf(a))
    || Number(b.zona) - Number(a.zona)
    || b.prometidos - a.prometidos
    || Number(b.secao) - Number(a.secao)
  ));
  return {
    candidateName, filters, year, office, turn,
    cabos: rankedCabos,
    missingSections: orderedSections.filter((section) => section.faltantes > 0),
  };
}

module.exports = { buildScopedElectionReports };
