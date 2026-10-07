// Importa os resultados oficiais do TSE por zona/seção para ElectionResult.
// Fonte: "Votação por seção eleitoral" (dadosabertos.tse.jus.br), CSV no formato
// votacao_secao_<ANO>_<UF>.csv (Latin-1, campos entre aspas, separados por ;).
//
// Uso: node prisma/import-elections.js [caminho-do-csv]
// Ex.: node prisma/import-elections.js /tmp/tse/votacao_secao_2026_CE.csv
// Padrão: /tmp/tse/votacao_secao_2022_CE.csv
// Idempotente: remove as linhas TSE do ano do CSV antes de reinserir.
// O ano é lido da coluna ANO_ELEICAO do próprio arquivo (suporta 2022/2026/...).
const fs = require('fs');
const readline = require('readline');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

const CSV_PATH = process.argv[2] || '/tmp/tse/votacao_secao_2022_CE.csv';
const BATCH_SIZE = 2000;

// Campos que não representam candidato (mantidos fora da base — agregações usam só votos nominais)
const NON_CANDIDATE = new Set(['VOTO NULO', 'VOTO BRANCO', 'VOTO ANULADO']);

function parseLine(rawLine) {
  // Linha Latin-1 → UTF-8; campos vêm sempre entre aspas ("...";"...")
  const line = Buffer.from(rawLine, 'latin1').toString('utf8');
  const fields = line.split(';').map((f) => f.replace(/^"(.*)"$/, '$1'));
  return {
    ano: Number(fields[2]),
    turno: Number(fields[5]),
    uf: fields[10],
    municipio: fields[14],
    zona: String(Number(fields[15])),
    secao: String(Number(fields[16])),
    cargo: fields[18],
    votavel: fields[20],
    votos: Number(fields[21]),
  };
}

async function main() {
  if (!fs.existsSync(CSV_PATH)) {
    console.error(`CSV não encontrado: ${CSV_PATH}`);
    process.exit(1);
  }

  // Descobre o ano do arquivo (pula header, lê 1a linha de dados)
  const probe = fs.createReadStream(CSV_PATH, { encoding: 'latin1' });
  const probeRl = readline.createInterface({ input: probe, crlfDelay: Infinity });
  let year = null;
  for await (const line of probeRl) {
    const r = parseLine(line);
    if (Number.isInteger(r.ano) && r.ano > 1945) {
      year = r.ano;
      break;
    }
  }
  if (!year) {
    console.error('Não foi possível determinar o ano eleitoral do CSV.');
    process.exit(1);
  }
  console.log(`Ano do CSV: ${year}. Limpando resultados TSE ${year} existentes...`);
  await prisma.electionResult.deleteMany({ where: { year, source: 'TSE' } });

  const fileStream = fs.createReadStream(CSV_PATH, { encoding: 'latin1' });
  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

  let header = true;
  let batch = [];
  let total = 0;

  async function flush() {
    if (!batch.length) return;
    await prisma.electionResult.createMany({ data: batch, skipDuplicates: true });
    total += batch.length;
    batch = [];
  }

  for await (const rawLine of rl) {
    if (header) {
      header = false;
      continue;
    }
    const r = parseLine(rawLine);
    if (r.uf !== 'CE' || r.ano !== year || NON_CANDIDATE.has(r.votavel.toUpperCase())) continue;

    batch.push({
      year: r.ano,
      office: r.cargo.toUpperCase(),
      turn: r.turno,
      state: 'CE',
      city: r.municipio,
      zone: r.zona,
      section: r.secao,
      candidateId: null,
      candidateName: r.votavel,
      party: null,
      votes: r.votos,
      source: 'TSE',
    });

    if (batch.length >= BATCH_SIZE) await flush();
  }
  await flush();

  console.log(`Importação concluída (${year}): ${total} registros inseridos.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());