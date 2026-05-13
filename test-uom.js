const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
    try {
        const uoms = await prisma.uOM.findMany();
        console.log('UOM Table exists, count:', uoms.length);
    } catch (err) {
        console.error('Error:', err.message);
    } finally {
        await prisma.$disconnect();
        process.exit(0);
    }
}

main();
