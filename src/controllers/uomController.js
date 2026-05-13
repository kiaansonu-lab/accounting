const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

// Get all UOMs
const getUOMs = async (req, res) => {
    try {
        const companyId = req.user.companyId || req.body.companyId;
        if (!companyId) return res.status(400).json({ success: false, message: 'Company ID is required' });

        const uoms = await prisma.uom.findMany({
            where: { companyId: parseInt(companyId) },
            orderBy: { createdAt: 'desc' }
        });

        res.status(200).json({ success: true, data: uoms });
    } catch (error) {
        console.error('Error fetching UOMs:', error);
        res.status(500).json({ success: false, message: error.message });
    }
};

// Get UOM by ID
const getUOMById = async (req, res) => {
    try {
        const { id } = req.params;
        const companyId = req.user?.companyId || req.query.companyId;

        if (!companyId) {
            return res.status(400).json({ success: false, message: 'Company ID is required' });
        }

        const uom = await prisma.uom.findFirst({
            where: {
                id: parseInt(id),
                companyId: parseInt(companyId)
            }
        });

        if (!uom) return res.status(404).json({ success: false, message: 'UOM not found' });

        res.status(200).json({ success: true, data: uom });
    } catch (error) {
        console.error('Error fetching UOM:', error);
        res.status(500).json({ success: false, message: error.message });
    }
};

// Create UOM
const createUOM = async (req, res) => {
    try {
        const companyId = req.user.companyId || req.body.companyId;
        const { category, unitName, weightPerUnit } = req.body;

        if (!companyId) return res.status(400).json({ success: false, message: 'Company ID is required' });
        if (!category || !unitName) {
            return res.status(400).json({ success: false, message: 'Category and Unit Name are required' });
        }

        const existingUOM = await prisma.uom.findFirst({
            where: { companyId: parseInt(companyId), category, unitName }
        });

        if (existingUOM) {
            return res.status(400).json({ success: false, message: 'UOM already exists for this category' });
        }

        const uom = await prisma.uom.create({
            data: {
                category,
                unitName,
                weightPerUnit,
                companyId: parseInt(companyId)
            }
        });

        res.status(201).json({ success: true, message: 'UOM created successfully', data: uom });
    } catch (error) {
        console.error('Error creating UOM:', error);
        res.status(500).json({ success: false, message: error.message });
    }
};

// Update UOM
const updateUOM = async (req, res) => {
    try {
        const { id } = req.params;
        const { category, unitName, weightPerUnit } = req.body;
        const companyId = req.user?.companyId || req.query.companyId;

        if (!companyId) {
            return res.status(400).json({ success: false, message: 'Company ID is required' });
        }

        // Verify ownership
        const existing = await prisma.uom.findFirst({
            where: { id: parseInt(id), companyId: parseInt(companyId) }
        });

        if (!existing) {
            return res.status(404).json({ success: false, message: 'UOM not found' });
        }

        const uom = await prisma.uom.update({
            where: { id: parseInt(id) },
            data: {
                category,
                unitName,
                weightPerUnit
            }
        });

        res.status(200).json({ success: true, message: 'UOM updated successfully', data: uom });
    } catch (error) {
        console.error('Error updating UOM:', error);
        res.status(500).json({ success: false, message: error.message });
    }
};

// Delete UOM
const deleteUOM = async (req, res) => {
    try {
        const { id } = req.params;
        const companyId = req.user?.companyId || req.query.companyId;

        if (!companyId) {
            return res.status(400).json({ success: false, message: 'Company ID is required' });
        }

        // Verify ownership
        const existing = await prisma.uom.findFirst({
            where: { id: parseInt(id), companyId: parseInt(companyId) }
        });

        if (!existing) {
            return res.status(404).json({ success: false, message: 'UOM not found' });
        }

        await prisma.uom.delete({
            where: { id: parseInt(id) }
        });

        res.status(200).json({ success: true, message: 'UOM deleted successfully' });
    } catch (error) {
        console.error('Error deleting UOM:', error);
        res.status(500).json({ success: false, message: error.message });
    }
};

module.exports = {
    getUOMs,
    getUOMById,
    createUOM,
    updateUOM,
    deleteUOM
};
