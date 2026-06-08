const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const { deleteWarehouse } = require('../src/controllers/warehouseController');

// Helper to mock Express req and res
function mockResponse() {
    const res = {};
    res.status = (code) => {
        res.statusCode = code;
        return res;
    };
    res.json = (data) => {
        res.body = data;
        return res;
    };
    return res;
}

async function runTest() {
    let tempWarehouse = null;
    let tempProduct = null;
    let tempTx = null;
    
    try {
        console.log('--- STARTING WAREHOUSE DELETE RESTRICTION TEST ---');

        // 1. Get an existing company
        const company = await prisma.company.findFirst();
        if (!company) {
            console.error('No company found in database. Please run seed or create a company first.');
            return;
        }
        const companyId = company.id;
        console.log(`Using Company: ${company.name} (ID: ${companyId})`);

        // Get an existing product to use for stock tests
        tempProduct = await prisma.product.findFirst({ where: { companyId } });
        if (!tempProduct) {
            tempProduct = await prisma.product.create({
                data: {
                    name: 'Delete Test Product',
                    companyId,
                    initialCost: 10,
                    salePrice: 15,
                    purchasePrice: 10
                }
            });
            console.log(`Created temp product ID: ${tempProduct.id}`);
        }

        // 2. Create a completely unused warehouse
        tempWarehouse = await prisma.warehouse.create({
            data: {
                name: 'Temporary Delete Test Warehouse',
                location: 'Delete Test Location',
                companyId
            }
        });
        console.log(`Created temporary warehouse: ${tempWarehouse.name} (ID: ${tempWarehouse.id})`);

        // Test Scenario A: Delete completely unused warehouse (should SUCCEED)
        console.log('\n--- Scenario A: Deleting completely unused warehouse (should succeed) ---');
        let req = {
            params: { id: tempWarehouse.id.toString() },
            user: { companyId }
        };
        let res = mockResponse();

        await deleteWarehouse(req, res);
        console.log(`Delete Response Status: ${res.statusCode}`);
        console.log(`Delete Response Body:`, res.body);

        if (res.statusCode === 200 && res.body.success === true) {
            console.log('✅ Scenario A Passed: Unused warehouse deleted successfully.');
        } else {
            throw new Error(`Scenario A Failed: Expected status 200, got ${res.statusCode}`);
        }

        // 3. Re-create warehouse for Scenario B
        tempWarehouse = await prisma.warehouse.create({
            data: {
                name: 'Temporary Delete Test Warehouse',
                location: 'Delete Test Location',
                companyId
            }
        });
        console.log(`Re-created temporary warehouse ID: ${tempWarehouse.id}`);

        // Test Scenario B: Warehouse has positive stock (should FAIL)
        console.log('\n--- Scenario B: Deleting warehouse with active stock (should fail) ---');
        await prisma.stock.upsert({
            where: { warehouseId_productId: { warehouseId: tempWarehouse.id, productId: tempProduct.id } },
            update: { quantity: 10 },
            create: { warehouseId: tempWarehouse.id, productId: tempProduct.id, quantity: 10 }
        });
        console.log('Added stock record with quantity = 10');

        req = {
            params: { id: tempWarehouse.id.toString() },
            user: { companyId }
        };
        res = mockResponse();

        await deleteWarehouse(req, res);
        console.log(`Delete Response Status: ${res.statusCode}`);
        console.log(`Delete Response Body:`, res.body);

        if (res.statusCode === 400 && res.body.success === false) {
            console.log('✅ Scenario B Passed: Deletion blocked due to active stock levels.');
        } else {
            throw new Error(`Scenario B Failed: Expected status 400, got ${res.statusCode}`);
        }

        // Test Scenario C: Warehouse has negative stock (should FAIL)
        console.log('\n--- Scenario C: Deleting warehouse with negative stock (should fail) ---');
        await prisma.stock.update({
            where: { warehouseId_productId: { warehouseId: tempWarehouse.id, productId: tempProduct.id } },
            data: { quantity: -5 }
        });
        console.log('Updated stock record with quantity = -5');

        req = {
            params: { id: tempWarehouse.id.toString() },
            user: { companyId }
        };
        res = mockResponse();

        await deleteWarehouse(req, res);
        console.log(`Delete Response Status: ${res.statusCode}`);
        console.log(`Delete Response Body:`, res.body);

        if (res.statusCode === 400 && res.body.success === false) {
            console.log('✅ Scenario C Passed: Deletion blocked due to negative stock levels.');
        } else {
            throw new Error(`Scenario C Failed: Expected status 400, got ${res.statusCode}`);
        }

        // Test Scenario D: Warehouse has stock records but quantity is 0, but has transactions (should FAIL)
        console.log('\n--- Scenario D: Deleting warehouse with quantity 0 but has transactions (should fail) ---');
        // Clear stock quantity to 0
        await prisma.stock.update({
            where: { warehouseId_productId: { warehouseId: tempWarehouse.id, productId: tempProduct.id } },
            data: { quantity: 0 }
        });
        console.log('Updated stock record with quantity = 0');

        // Create a transaction referencing the warehouse
        tempTx = await prisma.inventorytransaction.create({
            data: {
                type: 'OPENING_STOCK',
                productId: tempProduct.id,
                toWarehouseId: tempWarehouse.id,
                quantity: 10,
                companyId
            }
        });
        console.log(`Created inventory transaction referencing warehouse ID: ${tempWarehouse.id}`);

        req = {
            params: { id: tempWarehouse.id.toString() },
            user: { companyId }
        };
        res = mockResponse();

        await deleteWarehouse(req, res);
        console.log(`Delete Response Status: ${res.statusCode}`);
        console.log(`Delete Response Body:`, res.body);

        if (res.statusCode === 400 && res.body.success === false) {
            console.log('✅ Scenario D Passed: Deletion blocked due to transaction references.');
        } else {
            throw new Error(`Scenario D Failed: Expected status 400, got ${res.statusCode}`);
        }

        console.log('\n🎉 ALL SCENARIOS PASSED SUCCESSFULLY!');

    } catch (error) {
        console.error('\n❌ TEST RUN FAILED:', error.message);
    } finally {
        // Cleanup
        console.log('\n--- Cleaning up database records ---');
        try {
            if (tempTx) {
                await prisma.inventorytransaction.deleteMany({
                    where: { id: tempTx.id }
                });
                console.log('Cleaned up test inventory transaction.');
            }
            if (tempWarehouse) {
                // Delete stock records if they exist
                await prisma.stock.deleteMany({
                    where: { warehouseId: tempWarehouse.id }
                });
                // Delete warehouse
                await prisma.warehouse.deleteMany({
                    where: { id: tempWarehouse.id }
                });
                console.log('Cleaned up test warehouse and associated stock entries.');
            }
        } catch (cleanupError) {
            console.error('Error during cleanup:', cleanupError.message);
        }
        await prisma.$disconnect();
    }
}

runTest();
