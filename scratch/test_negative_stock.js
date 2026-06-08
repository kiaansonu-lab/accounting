const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function runTest() {
    try {
        console.log('--- STARTING NEGATIVE STOCK & TRANSFER TEST ---');
        
        // 1. Setup test company, warehouses, and product
        const company = await prisma.company.findFirst();
        if (!company) {
            console.error('No company found in database. Please run seed or create a company first.');
            return;
        }
        const companyId = company.id;
        console.log(`Using Company: ${company.name} (ID: ${companyId})`);

        // Find or create Warehouse A
        let warehouseA = await prisma.warehouse.findFirst({
            where: { companyId, name: 'Test Warehouse A' }
        });
        if (!warehouseA) {
            warehouseA = await prisma.warehouse.create({
                data: { name: 'Test Warehouse A', location: 'Location A', companyId }
            });
        }

        // Find or create Warehouse B
        let warehouseB = await prisma.warehouse.findFirst({
            where: { companyId, name: 'Test Warehouse B' }
        });
        if (!warehouseB) {
            warehouseB = await prisma.warehouse.create({
                data: { name: 'Test Warehouse B', location: 'Location B', companyId }
            });
        }

        console.log(`Warehouse A: ${warehouseA.name} (ID: ${warehouseA.id})`);
        console.log(`Warehouse B: ${warehouseB.name} (ID: ${warehouseB.id})`);

        // Find or create a test product
        let product = await prisma.product.findFirst({
            where: { companyId, name: 'Test Negative Stock Product' }
        });
        if (!product) {
            product = await prisma.product.create({
                data: {
                    name: 'Test Negative Stock Product',
                    sku: 'TEST-NEG-101',
                    companyId,
                    initialCost: 10,
                    salePrice: 15,
                    purchasePrice: 10
                }
            });
        }
        const productId = product.id;
        console.log(`Product: ${product.name} (ID: ${productId})`);

        // Clean up any existing stock for this product in these warehouses
        await prisma.stock.deleteMany({
            where: {
                productId,
                warehouseId: { in: [warehouseA.id, warehouseB.id] }
            }
        });
        console.log('Cleared existing stock records for the test product.');

        // Verify initial state: no stock records
        let stockA = await prisma.stock.findUnique({
            where: { warehouseId_productId: { warehouseId: warehouseA.id, productId } }
        });
        let stockB = await prisma.stock.findUnique({
            where: { warehouseId_productId: { warehouseId: warehouseB.id, productId } }
        });
        console.log(`Initial Stock A: ${stockA?.quantity ?? 'No Record'}`);
        console.log(`Initial Stock B: ${stockB?.quantity ?? 'No Record'}`);

        // --- STEP 1: Purchase 10 items for Warehouse A ---
        console.log('\n--- Step 1: Purchasing 10 items for Warehouse A ---');
        await prisma.stock.upsert({
            where: { warehouseId_productId: { warehouseId: warehouseA.id, productId } },
            update: { quantity: { increment: 10 } },
            create: { warehouseId: warehouseA.id, productId, quantity: 10 }
        });

        stockA = await prisma.stock.findUnique({
            where: { warehouseId_productId: { warehouseId: warehouseA.id, productId } }
        });
        stockB = await prisma.stock.findUnique({
            where: { warehouseId_productId: { warehouseId: warehouseB.id, productId } }
        });
        console.log(`After Purchase Stock A: ${stockA?.quantity ?? 'No Record'}`);
        console.log(`After Purchase Stock B: ${stockB?.quantity ?? 'No Record'}`);

        // --- STEP 2: Sale of 4 items from Warehouse B ---
        console.log('\n--- Step 2: Selling 4 items from Warehouse B (should create negative stock) ---');
        // This simulates our updated salesInvoiceController.js logic (direct invoice decrement)
        await prisma.stock.upsert({
            where: { warehouseId_productId: { warehouseId: warehouseB.id, productId } },
            create: {
                warehouseId: warehouseB.id,
                productId,
                quantity: -4,
                initialQty: 0,
                minOrderQty: 0
            },
            update: {
                quantity: { decrement: 4 }
            }
        });

        stockA = await prisma.stock.findUnique({
            where: { warehouseId_productId: { warehouseId: warehouseA.id, productId } }
        });
        stockB = await prisma.stock.findUnique({
            where: { warehouseId_productId: { warehouseId: warehouseB.id, productId } }
        });
        console.log(`After Sale Stock A (expected 10): ${stockA?.quantity ?? 'No Record'}`);
        console.log(`After Sale Stock B (expected -4): ${stockB?.quantity ?? 'No Record'}`);

        // --- STEP 3: Transfer 4 items from Warehouse A to B ---
        console.log('\n--- Step 3: Transferring 4 items from Warehouse A to B ---');
        // This simulates stockTransferController.js transfer logic
        // Decrement source A
        await prisma.stock.upsert({
            where: { warehouseId_productId: { warehouseId: warehouseA.id, productId } },
            update: { quantity: { decrement: 4 } },
            create: { warehouseId: warehouseA.id, productId, quantity: -4 }
        });
        // Increment destination B
        await prisma.stock.upsert({
            where: { warehouseId_productId: { warehouseId: warehouseB.id, productId } },
            update: { quantity: { increment: 4 } },
            create: { warehouseId: warehouseB.id, productId, quantity: 4 }
        });

        stockA = await prisma.stock.findUnique({
            where: { warehouseId_productId: { warehouseId: warehouseA.id, productId } }
        });
        stockB = await prisma.stock.findUnique({
            where: { warehouseId_productId: { warehouseId: warehouseB.id, productId } }
        });
        console.log(`After Transfer Stock A (expected 6): ${stockA?.quantity ?? 'No Record'}`);
        console.log(`After Transfer Stock B (expected 0): ${stockB?.quantity ?? 'No Record'}`);

        // --- STEP 4: Verify overall total stock ---
        const totalStock = (stockA?.quantity || 0) + (stockB?.quantity || 0);
        console.log(`\nOverall Total Stock (expected 6): ${totalStock}`);

        if (stockA?.quantity === 6 && stockB?.quantity === 0 && totalStock === 6) {
            console.log('\n✅ TEST PASSED SUCCESSFULLY!');
        } else {
            console.error('\n❌ TEST FAILED. Unmatched stocks.');
        }

    } catch (error) {
        console.error('Error during test execution:', error);
    } finally {
        await prisma.$disconnect();
    }
}

runTest();
