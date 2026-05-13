const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

// Transfer Stock between Warehouses
const transferStock = async (req, res) => {
    try {
        const { productId, fromWarehouseId, toWarehouseId, quantity, description } = req.body;
        const companyId = req.user.companyId;

        if (!productId || !fromWarehouseId || !toWarehouseId || !quantity || quantity <= 0) {
            return res.status(400).json({ success: false, message: 'Invalid transfer details' });
        }

        if (fromWarehouseId === toWarehouseId) {
            return res.status(400).json({ success: false, message: 'Source and Destination warehouses cannot be the same' });
        }

        // Check if source stock exists
        const sourceStock = await prisma.stock.findUnique({
            where: {
                warehouseId_productId: {
                    warehouseId: parseInt(fromWarehouseId),
                    productId: parseInt(productId)
                }
            }
        });

        if (!sourceStock || sourceStock.quantity < quantity) {
            return res.status(400).json({ success: false, message: 'Insufficient stock in source warehouse' });
        }

        // Perform Transfer within a Transaction
        await prisma.$transaction(async (prisma) => {
            // 1. Decrement Source
            await prisma.stock.update({
                where: {
                    warehouseId_productId: {
                        warehouseId: parseInt(fromWarehouseId),
                        productId: parseInt(productId)
                    }
                },
                data: { quantity: { decrement: parseFloat(quantity) } }
            });

            // 2. Increment Destination (Upsert)
            await prisma.stock.upsert({
                where: {
                    warehouseId_productId: {
                        warehouseId: parseInt(toWarehouseId),
                        productId: parseInt(productId)
                    }
                },
                update: { quantity: { increment: parseFloat(quantity) } },
                create: {
                    warehouseId: parseInt(toWarehouseId),
                    productId: parseInt(productId),
                    quantity: parseFloat(quantity),
                    initialQty: 0,
                    minOrderQty: 0
                }
            });

            // 3. Log Transaction
            await prisma.inventorytransaction.create({
                data: {
                    type: 'TRANSFER',
                    productId: parseInt(productId),
                    fromWarehouseId: parseInt(fromWarehouseId),
                    toWarehouseId: parseInt(toWarehouseId),
                    quantity: parseFloat(quantity),
                    reason: description || 'Stock Transfer',
                    companyId: parseInt(companyId)
                }
            });
        });

        res.status(200).json({ success: true, message: 'Stock transferred successfully' });

    } catch (error) {
        console.error('Transfer Error:', error);
        res.status(500).json({ success: false, message: 'Failed to transfer stock', error: error.message });
    }
};

// Adjust Stock (Damage, Loss, Correction)
const adjustStock = async (req, res) => {
    try {
        const { productId, warehouseId, quantity, type, reason } = req.body; // type: 'ADD' or 'REMOVE'
        const companyId = req.user.companyId;

        if (!productId || !warehouseId || !quantity || quantity <= 0 || !type) {
            return res.status(400).json({ success: false, message: 'Invalid adjustment details' });
        }

        const qty = parseFloat(quantity);
        const adjustmentQuantity = type === 'REMOVE' ? -qty : qty;

        // Optionally check stock for removal
        if (type === 'REMOVE') {
            const currentStock = await prisma.stock.findUnique({
                where: {
                    warehouseId_productId: {
                        warehouseId: parseInt(warehouseId),
                        productId: parseInt(productId)
                    }
                }
            });
            if (!currentStock || currentStock.quantity < qty) {
                return res.status(400).json({ success: false, message: 'Insufficient stock to remove' });
            }
        }

        await prisma.$transaction(async (prisma) => {
            // 1. Update Stock
            await prisma.stock.upsert({
                where: {
                    warehouseId_productId: {
                        warehouseId: parseInt(warehouseId),
                        productId: parseInt(productId)
                    }
                },
                update: { quantity: { increment: adjustmentQuantity } },
                create: {
                    warehouseId: parseInt(warehouseId),
                    productId: parseInt(productId),
                    quantity: adjustmentQuantity > 0 ? adjustmentQuantity : 0,
                    // Note: Creating with negative stock is theoretically possible but weird. 
                    // But check above prevents removal if no stock exists.
                    // If adding, it's fine.
                    initialQty: 0,
                    minOrderQty: 0
                }
            });

            // 2. Log Transaction
            await prisma.inventorytransaction.create({
                data: {
                    type: 'ADJUSTMENT',
                    productId: parseInt(productId),
                    // If adding, it goes TO the warehouse. If removing, it comes FROM the warehouse?
                    // Or just use 'toWarehouse' for consistency and rely on type/quantity?
                    // Let's use logic:
                    // If ADD: toWarehouse = ID.
                    // If REMOVE: fromWarehouse = ID.
                    toWarehouseId: type === 'ADD' ? parseInt(warehouseId) : null,
                    fromWarehouseId: type === 'REMOVE' ? parseInt(warehouseId) : null,
                    quantity: qty, // Log the absolute amount
                    reason: reason || `${type} Adjustment`,
                    companyId: parseInt(companyId)
                }
            });
        });

        res.status(200).json({ success: true, message: 'Stock adjusted successfully' });

    } catch (error) {
        console.error('Adjustment Error:', error);
        res.status(500).json({ success: false, message: 'Failed to adjust stock', error: error.message });
    }
};

// Get Inventory Transactions/History
const getInventoryHistory = async (req, res) => {
    try {
        const { productId, warehouseId } = req.query;
        const companyId = req.user.companyId;

        const where = { companyId: parseInt(companyId) };
        if (productId) where.productId = parseInt(productId);
        if (warehouseId) {
            where.OR = [
                { fromWarehouseId: parseInt(warehouseId) },
                { toWarehouseId: parseInt(warehouseId) }
            ];
        }

        const transactions = await prisma.inventorytransaction.findMany({
            where,
            include: {
                product: { select: { name: true, sku: true } },
                fromWarehouse: { select: { name: true } },
                toWarehouse: { select: { name: true } }
            },
            orderBy: { date: 'desc' }
        });

        res.status(200).json({ success: true, data: transactions });
    } catch (error) {
        console.error('History Error:', error);
        res.status(500).json({ success: false, message: 'Failed to fetch history' });
    }
}

module.exports = {
    transferStock,
    adjustStock,
    getInventoryHistory
};
