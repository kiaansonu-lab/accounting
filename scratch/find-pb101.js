const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
    try {
        const je = await prisma.journalentry.findFirst({
            where: { voucherNumber: 'PB-101' },
            include: { transaction: true }
        });
        console.log('Journal Entry for PB-101:', JSON.stringify(je, null, 2));

        const pb = await prisma.purchasebill.findFirst({
            where: { billNumber: 'PB-101' }
        });
        console.log('Purchase Bill for PB-101:', JSON.stringify(pb, null, 2));
    } catch (err) {
        console.error('Error:', err);
    } finally {
        await prisma.$disconnect();
        process.exit(0);
    }
}

main();
