const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

// Create Warehouse
const createWarehouse = async (req, res) => {
    try {
        const companyId = req.user?.companyId || req.query.companyId || req.body.companyId;
        const { name, location, addressLine1, addressLine2, city, state, postalCode, country } = req.body;

        if (!companyId) return res.status(400).json({ success: false, message: 'Company ID is required' });
        if (!name || !location) {
            return res.status(400).json({ success: false, message: 'Name and Location are required' });
        }

        const existingWarehouse = await prisma.warehouse.findFirst({
            where: { companyId: parseInt(companyId), name }
        });

        if (existingWarehouse) {
            return res.status(400).json({ success: false, message: 'Warehouse with this name already exists' });
        }

        const warehouse = await prisma.warehouse.create({
            data: {
                name,
                location,
                addressLine1,
                addressLine2,
                city,
                state,
                postalCode,
                country,
                companyId: parseInt(companyId)
            }
        });

        res.status(201).json({ success: true, message: 'Warehouse created successfully', data: warehouse });

    } catch (error) {
        console.error('Error creating warehouse:', error);
        res.status(500).json({ success: false, message: error.message });
    }
};

// Get Warehouses
const getWarehouses = async (req, res) => {
    try {
        const companyId = req.user?.companyId || req.query.companyId || req.body.companyId;

        if (!companyId) return res.status(400).json({ success: false, message: 'Company ID is required' });

        const warehouses = await prisma.warehouse.findMany({
            where: { companyId: parseInt(companyId) },
            include: {
                stock: {
                    select: {
                        quantity: true
                    }
                }
            },
            orderBy: { createdAt: 'desc' }
        });

        const formattedWarehouses = warehouses.map(w => {
            const totalStock = w.stock.reduce((sum, stock) => sum + (stock.quantity || 0), 0);
            const { stock, ...warehouseData } = w;
            return {
                ...warehouseData,
                totalStock
            };
        });

        res.status(200).json({ success: true, data: formattedWarehouses });

    } catch (error) {
        console.error('Error fetching warehouses:', error);
        res.status(500).json({ success: false, message: error.message });
    }
};

// Update Warehouse
const updateWarehouse = async (req, res) => {
    try {
        const { id } = req.params;
        const companyId = req.user?.companyId || req.query.companyId || req.body.companyId;
        const { name, location, addressLine1, addressLine2, city, state, postalCode, country } = req.body;

        const warehouse = await prisma.warehouse.update({
            where: {
                id: parseInt(id),
                companyId: parseInt(companyId)
            },
            data: {
                name,
                location,
                addressLine1,
                addressLine2,
                city,
                state,
                postalCode,
                country
            }
        });

        res.status(200).json({ success: true, message: 'Warehouse updated successfully', data: warehouse });

    } catch (error) {
        console.error('Error updating warehouse:', error);
        res.status(500).json({ success: false, message: error.message });
    }
};

// Delete Warehouse
const deleteWarehouse = async (req, res) => {
    try {
        const { id } = req.params;
        const companyId = req.user?.companyId || req.query.companyId || req.body.companyId;

        await prisma.warehouse.delete({
            where: {
                id: parseInt(id),
                companyId: parseInt(companyId)
            }
        });

        res.status(200).json({ success: true, message: 'Warehouse deleted successfully' });

    } catch (error) {
        console.error('Error deleting warehouse:', error);
        res.status(500).json({ success: false, message: error.message });
    }
};

const getWarehouseById = async (req, res) => {
    try {
        const { id } = req.params;
        const companyId = req.user?.companyId || req.query.companyId || req.body.companyId;

        const warehouse = await prisma.warehouse.findUnique({
            where: {
                id: parseInt(id),
                companyId: parseInt(companyId)
            },
            include: {
                stock: {
                    include: {
                        product: {
                            include: {
                                category: true
                            }
                        }
                    }
                }
            }
        });

        if (!warehouse) {
            return res.status(404).json({ success: false, message: 'Warehouse not found' });
        }

        // Calculate Stats
        const totalStockUnits = warehouse.stock.reduce((sum, stock) => sum + stock.quantity, 0);
        const categories = new Set(warehouse.stock.map(s => s.product?.categoryId).filter(Boolean));
        const totalCategories = categories.size;
        const totalProducts = warehouse.stock.length;

        // Find Highest and Lowest Stock Product
        let highestStockProduct = null;
        let lowestStockProduct = null;

        if (warehouse.stock.length > 0) {
            highestStockProduct = warehouse.stock.reduce((prev, current) => (prev.quantity > current.quantity) ? prev : current);
            lowestStockProduct = warehouse.stock.reduce((prev, current) => (prev.quantity < current.quantity) ? prev : current);
        }

        // Format Inventory List
        const inventoryList = (warehouse.stock || []).map(stock => ({
            id: stock.id,
            category: stock.product?.category?.name || 'Uncategorized',
            product: stock.product?.name,
            unit: stock.product?.unit || 'Units',
            quantity: stock.quantity
        }));

        const data = {
            ...warehouse,
            stats: {
                totalCategories,
                totalProducts,
                totalStockUnits,
                highestStockProduct: highestStockProduct ? `${highestStockProduct.product.name} (${highestStockProduct.quantity})` : '-',
                lowestStockProduct: lowestStockProduct ? `${lowestStockProduct.product.name} (${lowestStockProduct.quantity})` : '-'
            },
            inventory: inventoryList
        };

        res.status(200).json({ success: true, data });
    } catch (error) {
        console.error('Error fetching warehouse:', error);
        res.status(500).json({ success: false, message: error.message });
    }
}


module.exports = {
    createWarehouse,
    getWarehouses,
    updateWarehouse,
    deleteWarehouse,
    getWarehouseById
};
