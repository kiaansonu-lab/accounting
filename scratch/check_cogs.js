const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
    console.log("=== Checking Inventory Config ===");
    const companies = await prisma.company.findMany({ select: { id: true, name: true, inventoryConfig: true } });
    for (const c of companies) {
        console.log(`Company ID: ${c.id}, Name: ${c.name}, Config:`, c.inventoryConfig);
    }

    console.log("\n=== Checking Products ===");
    const products = await prisma.product.findMany({
        select: { id: true, name: true, purchasePrice: true, averageCost: true, totalQty: true, totalInventoryValue: true }
    });
    console.log(products);

    console.log("\n=== Checking Latest Invoices ===");
    const invoices = await prisma.invoice.findMany({
        orderBy: { id: 'desc' },
        take: 3,
        include: { invoiceitem: true }
    });
    console.log(JSON.stringify(invoices, null, 2));

    console.log("\n=== Checking Batches ===");
    const batches = await prisma.inventory_batch.findMany();
    console.log(batches);

    console.log("\n=== Checking Transactions for COGS ===");
    const trans = await prisma.transaction.findMany({
        where: { voucherNumber: { startsWith: 'COGS-' } },
        orderBy: { id: 'desc' }
    });
    console.log(trans);
}

main().catch(console.error).finally(() => prisma.$disconnect());
