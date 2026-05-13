const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function check() {
    const users = await prisma.user.findMany({
        select: { id: true, email: true, role: true, companyId: true }
    });
    const companies = await prisma.company.findMany({
        select: { id: true, name: true }
    });

    console.log('--- USERS ---');
    console.table(users);
    console.log('--- COMPANIES ---');
    console.table(companies);

    await prisma.$disconnect();
}

check();
