const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
    const companies = await prisma.company.findMany();
    const users = await prisma.user.findMany();
    console.log('Companies:', JSON.stringify(companies, null, 2));
    console.log('Users:', JSON.stringify(users.map(u => ({ id: u.id, email: u.email, companyId: u.companyId })), null, 2));
    process.exit(0);
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
