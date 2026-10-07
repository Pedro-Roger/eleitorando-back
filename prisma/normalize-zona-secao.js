// Normaliza zona/seção de voters e users para o formato canônico numérico
// ("014"→"14", "0125"→"125"), batendo com ElectionResult importado do TSE.
// Idempotente — pode rodar a qualquer momento. Valores não numéricos são preservados.
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

async function main() {
  // strip leading zeros mantendo valor numérico: "0125" → 125
  const normalize = (table) => prisma.$executeRawUnsafe(`
    UPDATE ${table}
    SET zone = CASE WHEN zone ~ '^0+$' THEN '0' ELSE ltrim(zone, '0') END,
        section = CASE WHEN section ~ '^0+$' THEN '0' ELSE ltrim(section, '0') END
    WHERE (zone ~ '^0[0-9]+$' OR section ~ '^0[0-9]+$')
  `);

  const voters = await normalize('"voters"');
  const users = await normalize('"users"');
  console.log(`Normalização concluída: voters=${voters}, users=${users} linhas atualizadas.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());