const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
    try {
        const columns = await prisma.$queryRaw`SHOW COLUMNS FROM Product`;
        console.log('Columns in Product table:', columns.map(c => c.Field));
    } catch (err) {
        console.error('Error:', err.message);
    } finally {
        await prisma.$disconnect();
        process.exit(0);
    }
}

main();
