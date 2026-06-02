const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
    console.log("--- Ledgers ---");
    const ledgers = await prisma.ledger.findMany({
        include: { accountgroup: true }
    });
    ledgers.forEach(l => {
        console.log(`ID: ${l.id} | Name: ${l.name} | Type: ${l.accountgroup?.type} | CurrentBalance: ${l.currentBalance} | OpeningBalance: ${l.openingBalance}`);
    });

    console.log("\n--- Transactions ---");
    const txs = await prisma.transaction.findMany({
        include: {
            ledger_transaction_debitLedgerIdToledger: true,
            ledger_transaction_creditLedgerIdToledger: true
        }
    });
    txs.forEach(t => {
        console.log(`ID: ${t.id} | Date: ${t.date} | Amount: ${t.amount} | Debit: ${t.ledger_transaction_debitLedgerIdToledger?.name} (ID: ${t.debitLedgerId}) | Credit: ${t.ledger_transaction_creditLedgerIdToledger?.name} (ID: ${t.creditLedgerId}) | Narration: ${t.narration} | Voucher: ${t.voucherType}`);
    });

    console.log("\n--- Stocks ---");
    const stocks = await prisma.stock.findMany({
        include: { product: true }
    });
    stocks.forEach(s => {
        console.log(`Product: ${s.product.name} | Quantity: ${s.quantity} | PurchasePrice: ${s.product.purchasePrice} | InitialCost: ${s.product.initialCost}`);
    });
}

main().catch(console.error).finally(() => prisma.$disconnect());
