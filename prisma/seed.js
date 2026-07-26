// Seed com a estrutura de exemplo da especificação
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');

const prisma = new PrismaClient();

async function main() {
  const hash = (pw) => bcrypt.hash(pw, 10);

  const admin = await prisma.user.upsert({
    where: { username: 'admin' },
    update: {},
    create: {
      name: 'Maria Administradora',
      username: 'admin',
      passwordHash: await hash('admin1234'),
      role: 'ADMIN',
      state: 'CE',
      city: 'Fortaleza',
      active: true,
      mustChangePassword: false,
    },
  });

  const carlos = await prisma.user.upsert({
    where: { username: 'carlos.silva' },
    update: {},
    create: {
      name: 'Carlos Silva',
      username: 'carlos.silva',
      passwordHash: await hash('carlos1234'),
      role: 'CABO',
      state: 'CE',
      city: 'Fortaleza',
      neighborhood: 'Centro',
      active: true,
      mustChangePassword: false,
      createdById: admin.id,
    },
  });

  const subcabos = [
    { name: 'João Santos', username: 'joao.santos', city: 'Fortaleza' },
    { name: 'Ana Lima', username: 'ana.lima', city: 'Fortaleza' },
    { name: 'Marcos Alves', username: 'marcos.alves', city: 'Caucaia' },
  ];
  for (const s of subcabos) {
    await prisma.user.upsert({
      where: { username: s.username },
      update: {},
      create: {
        name: s.name,
        username: s.username,
        passwordHash: await hash('subcabo1234'),
        role: 'SUBCABO',
        state: 'CE',
        city: s.city,
        active: true,
        mustChangePassword: false,
        parentId: carlos.id,
        createdById: carlos.id,
      },
    });
  }

  await prisma.setting.upsert({
    where: { key: 'bairroObrigatorioEleitor' },
    update: {},
    create: { key: 'bairroObrigatorioEleitor', value: 'false' },
  });

  console.log('Seed concluído.');
  console.log('Login admin: admin / admin1234');
  console.log('Login cabo:  carlos.silva / carlos1234');
  console.log('Login subcabo: joao.santos / subcabo1234');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
