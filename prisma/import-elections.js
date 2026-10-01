// Importa os resultados oficiais do TSE 2022 (CE) por zona/seção para ElectionResult.
// Fonte: "Votação por seção eleitoral - 2022" (dadosabertos.tse.jus.br),
// CSV no formato do arquivo votacao_secao_2022_CE.csv (Latin-1, campos entre aspas, separados por ;).
//
// Uso: node prisma/import-elections.js [caminho-do-csv]
// Padrão: /tmp/tse/votacao_secao_2022_CE.csv
// Idempotente: remove as linhas TSE de 2022 antes de reinserir.
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

const CSV_PATH = process.argv[2] || '/tmp/tse/votacao_secao_2022_CE.csv';
const BATCH_SIZE = 2000;

// Campos que não representam candidato (mantidos fora da base — agregações usam só votos nominais)
const NON_CANDIDATE = new Set(['VOTO NULO', 'VOTO BRANCO', 'VOTO ANULADO']);

function parseLine(rawLine) {
  // O stream já decodifica Latin-1 → string JS (createReadStream abaixo com encoding 'latin1').
  // NÃO re-decodificar: um segundo Buffer.from(rawLine, 'latin1') corrompe acentos em U+FFFD.
  // Campos vêm sempre entre aspas ("...";"...")
  const fields = rawLine.split(';').map((f) => f.replace(/^"(.*)"$/, '$1'));
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

  console.log(`Limpando resultados TSE 2022 existentes...`);
  await prisma.electionResult.deleteMany({ where: { year: 2022, source: 'TSE' } });

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
    if (r.uf !== 'CE' || NON_CANDIDATE.has(r.votavel.toUpperCase())) continue;

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
      // Este CSV (votação por seção 2022) não possui coluna SG_PARTIDO — o partido
      // não está disponível nesta fonte; permanece null (coluna é nullable no schema).
      party: null,
      votes: r.votos,
      source: 'TSE',
    });

    if (batch.length >= BATCH_SIZE) await flush();
  }
  await flush();

  console.log(`Importação concluída: ${total} registros inseridos.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
