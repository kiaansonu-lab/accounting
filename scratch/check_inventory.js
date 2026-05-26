const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function check() {
    try {
        console.log('--- LEDGERS MATCHING INVENTORY ---');
        const ledgers = await prisma.ledger.findMany({
            where: { name: { contains: 'Inventory' } },
            include: { accountgroup: true }
        });
        console.dir(ledgers, { depth: null });

        for (const ledger of ledgers) {
            console.log(`\n--- TRANSACTIONS FOR LEDGER: ${ledger.name} (ID: ${ledger.id}) ---`);
            const txs = await prisma.transaction.findMany({
                where: {
                    OR: [
                        { debitLedgerId: ledger.id },
                        { creditLedgerId: ledger.id }
                    ]
                },
                orderBy: { date: 'desc' }
            });
            console.table(txs.map(t => ({
                id: t.id,
                date: t.date.toISOString(),
                amount: t.amount,
                debitLedgerId: t.debitLedgerId,
                creditLedgerId: t.creditLedgerId,
                voucherType: t.voucherType,
                voucherNumber: t.voucherNumber,
                narration: t.narration
            })));
        }

        console.log('\n--- ALL PRODUCTS AND THEIR STOCK VALUATION ---');
        const products = await prisma.product.findMany({
            include: {
                stock: true
            }
        });
        
        const productsList = products.map(p => {
            const totalQty = p.stock.reduce((sum, s) => sum + s.quantity, 0);
            const valueAtCost = totalQty * (p.initialCost || p.purchasePrice || 0);
            return {
                id: p.id,
                name: p.name,
                initialCost: p.initialCost,
                purchasePrice: p.purchasePrice,
                totalQty: totalQty,
                valueAtCost: valueAtCost
            };
        });
        console.table(productsList);

    } catch (err) {
        console.error(err);
    } finally {
        await prisma.$disconnect();
    }
}

check();
