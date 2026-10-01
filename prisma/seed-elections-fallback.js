// Fallback: seed fictício de ElectionResult quando a base TSE não foi importada
// (sem CSV/baixada falhou). Cria a adversária Keiva Dias (CE, candidato do sistema)
// e votos fictícios por zona/seção de Fortaleza/Caucaia, ano 2022 (eleição passada).
// Se já existem resultados TSE importados, não faz nada.
const { PrismaClient } = require('@prisma/client');
const secoesCE = require('../src/data/ce-secoes.json');

const prisma = new PrismaClient();

// PRNG determinístico (mesmos dados a cada execução)
function pseudoRandom(seed) {
  let s = seed % 2147483647;
  if (s <= 0) s += 2147483646;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

async function main() {
  const existing = await prisma.electionResult.count();
  if (existing > 0) {
    console.log(`ElectionResult já tem ${existing} registros — seed fictício ignorado.`);
    return;
  }
  const seedYear = 2022; // alinhado ao DEFAULT_PAST_YEAR de /elections
  const rand = pseudoRandom(seedYear);

  // Adversário fictício Kevin + candidato "nosso" para o cruzamento
  const admin = await prisma.user.findFirst({ where: { role: 'ADMIN' }, orderBy: { id: 'asc' } });
  if (!admin) throw new Error('Nenhum ADMIN encontrado — rode o seed principal primeiro.');

  const keiva = await findOrCreateCandidate('Keiva Dias', 'FICT', admin.id);
  const nosso = await findOrCreateCandidate('Bruno Lima', 'PL', admin.id);

  const cidades = ['FORTALEZA', 'CAUCAIA'];
  const rows = [];

  for (const row of secoesCE) {
    const city = String(row.c).toUpperCase();
    if (!cidades.includes(city)) continue;
    // Limita o volume: no máximo 300 seções por cidade
    if (rows.filter((r) => r.city === city).length >= 600) continue;

    for (const cand of [
      { candidateId: keiva.id, candidateName: keiva.name, party: keiva.party },
      { candidateId: nosso.id, candidateName: nosso.name, party: nosso.party },
    ]) {
      rows.push({
        year: seedYear,
        office: 'GOVERNADOR',
        turn: 1,
        state: 'CE',
        city,
        zone: String(row.z),
        section: String(row.s),
        candidateId: cand.candidateId,
        candidateName: cand.candidateName,
        party: cand.party,
        votes: Math.floor(rand() * 120) + 10,
        source: 'FALLBACK',
      });
    }
  }

  // Cria candidatos em lote
  for (const chunk of chunkify(rows, 2000)) {
    await prisma.electionResult.createMany({ data: chunk, skipDuplicates: true });
  }
  console.log(`Seed fictício (fallback) concluído: ${rows.length} registros, adversária Keiva Dias (CE).`);
}

async function findOrCreateCandidate(name, party, adminId) {
  const existing = await prisma.candidate.findFirst({ where: { name, deletedAt: null } });
  if (existing) return existing;
  return prisma.candidate.create({ data: { name, party, createdById: adminId } });
}

function chunkify(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
