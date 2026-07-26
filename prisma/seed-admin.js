// Seed de produção — cria apenas o administrador inicial do sistema, sem dados de demonstração.
// Idempotente: pode ser executado toda vez que o sistema sobe (ex.: no start do container Docker),
// pois usa upsert e não recria nem duplica o usuário se ele já existir.
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');

const prisma = new PrismaClient();

const ADMIN_NAME = 'Felipe';
const ADMIN_USERNAME = 'felipe.admin';
const ADMIN_PASSWORD = '300822';

async function main() {
  await prisma.user.upsert({
    where: { username: ADMIN_USERNAME },
    update: {},
    create: {
      name: ADMIN_NAME,
      username: ADMIN_USERNAME,
      passwordHash: await bcrypt.hash(ADMIN_PASSWORD, 10),
      role: 'ADMIN',
      state: 'CE',
      city: 'Fortaleza',
      active: true,
      mustChangePassword: true,
    },
  });

  console.log('Administrador inicial pronto.');
  console.log(`Login: ${ADMIN_USERNAME} / ${ADMIN_PASSWORD}`);
  console.log('A troca de senha será exigida no primeiro acesso.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
