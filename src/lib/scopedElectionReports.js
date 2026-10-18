const { sectionDelivery, markShared, sumDeliveries, quebra } = require('./electionReportRules');

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
      const subsection = zone.secoes.get(section.secao) || {
        name: section.secao,
        prometidos: 0,
        entregue: section.entregue,
        faltante: section.faltante,
        excedente: section.excedente,
        status: section.status,
        compartilhada: section.compartilhada,
        totalPrometidoNaSecao: section.prometidos,
        apuradoTseNaSecao: section.apuradoTseNaSecao,
        apuracaoDisponivel: section.apuracaoDisponivel,
        faltantes: section.faltantes,
        pessoas: [],
      };
      subsection.prometidos += 1;
      subsection.pessoas.push(person);
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
    const delivery = sectionDelivery({
      prometidos,
      tse: section.apuracaoDisponivel ? section.apuradoTseNaSecao : null,
    });
    const subcaboCounts = new Map();
    for (const person of section.pessoas) {
      const subKey = person.subcaboId ?? 'CADASTRO DIRETO';
      subcaboCounts.set(subKey, (subcaboCounts.get(subKey) || 0) + 1);
    }
    return {
      ...section,
      ...delivery,
      possivelmenteVotaram: delivery.entregue,
      faltantes: delivery.faltante,
      percentualFaltantes: delivery.faltante === null ? null : (prometidos ? Math.round((delivery.faltante / prometidos) * 1000) / 10 : 0),
      pessoas: section.pessoas.sort((a, b) => (
        (subcaboCounts.get(b.subcaboId ?? 'CADASTRO DIRETO') || 0) - (subcaboCounts.get(a.subcaboId ?? 'CADASTRO DIRETO') || 0)
        || a.subcabo.localeCompare(b.subcabo, 'pt-BR') || a.name.localeCompare(b.name, 'pt-BR')
      )),
    };
  });

  const sectionsByCabo = new Map();
  for (const section of allSections) {
    const caboKey = section.caboId ?? key(section.cabo);
    const caboSections = sectionsByCabo.get(caboKey) || [];
    caboSections.push(section);
    sectionsByCabo.set(caboKey, caboSections);
  }

  const cabos = new Map();
  for (const [caboKey, sectionsDoCabo] of sectionsByCabo) {
    const markedSections = markShared(sectionsDoCabo, (person) => person.subcaboId ?? 'CADASTRO DIRETO');
    const cabo = { id: caboKey, name: sectionsDoCabo[0].cabo, sections: markedSections, subcabos: new Map() };
    for (const section of markedSections) {
      for (const person of section.pessoas) {
        const subKey = person.subcaboId ?? 'CADASTRO DIRETO';
        const subcabo = cabo.subcabos.get(subKey) || { id: subKey, name: person.subcabo || 'Cadastro direto', prometidos: 0 };
        subcabo.prometidos += 1;
        cabo.subcabos.set(subKey, subcabo);
      }
    }
    cabos.set(caboKey, cabo);
  }
  const rankedCabos = [...cabos.values()].map((cabo) => {
    // Dentro do cabo a secao pertence ao cabo inteiro: conta uma vez, sem excluir compartilhadas entre subcabos.
    const totals = sumDeliveries(cabo.sections.map((section) => ({ ...section, compartilhada: false })));
    return {
      id: cabo.id,
      name: cabo.name,
      ...totals,
      compartilhadas: cabo.sections.filter((section) => section.compartilhada).length,
      quebra: quebra(totals),
      secoes: cabo.sections.length,
      secoesComFaltantes: cabo.sections.filter((section) => section.faltante > 0).length,
      subcabos: [...cabo.subcabos.values()].sort(descending),
      cidades: locationHierarchy(cabo.sections),
    };
  }).sort(descending);
  // Total geral: cada localizacao (cidade, zona, secao) conta uma vez, com os prometidos de todos os cabos.
  const porLocal = new Map();
  for (const section of allSections) {
    const lk = locationKey(section.city, section.zona, section.secao);
    const atual = porLocal.get(lk) || { prometidos: 0, apuracaoDisponivel: section.apuracaoDisponivel, apuradoTseNaSecao: section.apuradoTseNaSecao };
    atual.prometidos += section.prometidos;
    porLocal.set(lk, atual);
  }
  const secoesUnicas = [...porLocal.values()].map((local) => ({
    ...local,
    ...sectionDelivery({ prometidos: local.prometidos, tse: local.apuracaoDisponivel ? local.apuradoTseNaSecao : null }),
    compartilhada: false,
  }));
  const totais = sumDeliveries(secoesUnicas);
  totais.quebra = quebra(totais);

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
    totais,
    cabos: rankedCabos,
    missingSections: orderedSections.filter((section) => section.faltantes > 0),
    secoes: orderedSections,
  };
}

module.exports = { buildScopedElectionReports };

