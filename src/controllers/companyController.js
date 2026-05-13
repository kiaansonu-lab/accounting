const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');
const prisma = new PrismaClient();
const chartOfAccountsService = require('../services/chartOfAccountsService');
const { isCloudinaryConfigured } = require('../utils/cloudinaryConfig');

const createCompany = async (req, res) => {
    try {
        const { name, email, phone, address, startDate, endDate, planId, planType, password } = req.body;

        let logoUrl = null;
        if (req.file) {
            if (isCloudinaryConfigured) {
                logoUrl = req.file.path; // Cloudinary URL
            } else {
                console.warn('File received but Cloudinary not configured. Logo not saved.');
            }
        }

        // Check if company or user already exists
        const existingCompany = await prisma.company.findUnique({ where: { email } });
        if (existingCompany) return res.status(400).json({ error: 'Company with this email already exists' });

        const existingUser = await prisma.user.findUnique({ where: { email } });
        if (existingUser) return res.status(400).json({ error: 'User with this email already exists' });

        // Hash password for the company admin
        if (!password) {
            return res.status(400).json({ error: 'Password is required for creating a company account' });
        }
        const hashedPassword = await bcrypt.hash(password, 10);

        // Create Company and Admin User in a transaction
        const result = await prisma.$transaction(async (tx) => {
            const company = await tx.company.create({
                data: {
                    name,
                    email,
                    phone,
                    address,
                    startDate: startDate ? new Date(startDate) : null,
                    endDate: endDate ? new Date(endDate) : null,
                    planId: planId ? parseInt(planId) : null,
                    planType,
                    logo: logoUrl
                }
            });

            // Derive permissions from Plan Modules
            let modulesArray = [];
            try {
                if (planId) {
                    const plan = await tx.plan.findUnique({ where: { id: parseInt(planId) } });
                    if (plan && plan.modules) {
                        modulesArray = JSON.parse(plan.modules);
                    }
                }
            } catch (e) {
                console.error("Module parse error:", e);
            }

            const enabledModules = modulesArray.filter(m => m.enabled).map(m => (m.name || m.module_name || "").toLowerCase());

            // Base permissions (always included for company admin - requested default menus)
            let defaultPermissions = [
                "show dashboard",
                "manage voucher", "create voucher", "edit voucher", "delete voucher",
                "manage reports", "view reports",
                "manage user", "create user", "edit user", "delete user",
                "manage role", "create role", "edit role", "delete role",
                "manage settings", "edit settings", "view settings"
            ];

            // Module specific mapping (gated menus)
            const moduleMapping = {
                'account': ["manage accounts", "create accounts", "edit accounts", "delete accounts", "view accounts"],
                'accounts': ["manage accounts", "create accounts", "edit accounts", "delete accounts", "view accounts"],
                'inventory': ["manage inventory", "create inventory", "edit inventory", "delete inventory", "view inventory"],
                'sales': ["manage sales", "create sales", "edit sales", "delete sales", "show sales", "send sales", "view sales"],
                'purchase': ["manage purchases", "create purchases", "edit purchases", "delete purchases", "view purchases"],
                'purchases': ["manage purchases", "create purchases", "edit purchases", "delete purchases", "view purchases"],
                'pos': ["manage pos", "create pos", "edit pos", "delete pos", "view pos"]
            };

            enabledModules.forEach(modName => {
                for (const key in moduleMapping) {
                    if (modName.includes(key)) {
                        defaultPermissions = [...new Set([...defaultPermissions, ...moduleMapping[key]])];
                    }
                }
            });

            const role = await tx.role.create({
                data: {
                    name: 'COMPANY',
                    companyId: company.id,
                    permissions: JSON.stringify(defaultPermissions)
                }
            });

            const user = await tx.user.create({
                data: {
                    name,
                    email,
                    password: hashedPassword,
                    role: 'COMPANY',
                    roleId: role.id,
                    companyId: company.id
                }
            });

            return { company, user };
        }, {
            timeout: 15000
        });

        // Initialize Chart of Accounts for the new company
        try {
            await chartOfAccountsService.initializeChartOfAccounts(result.company.id);
        } catch (coaError) {
            console.error('COA Initialization Error (Skipping):', coaError);
        }

        res.status(201).json(result.company);
    } catch (error) {
        console.error('Create Company Error:', error);
        res.status(500).json({
            error: error.message || 'Internal Server Error'
        });
    }
};

const getCompanies = async (req, res) => {
    try {
        const companies = await prisma.company.findMany({
            include: {
                user: true,
                plan: true
            }
        });
        const companiesWithStorage = companies.map(company => {
            if (company.inventoryConfig) {
                try {
                    const config = JSON.parse(company.inventoryConfig);
                    company.storageCapacity = config.storageCapacity;
                } catch (e) {}
            }
            return company;
        });
        res.json(companiesWithStorage);
    } catch (error) {
        console.error('Get Companies Error:', error);
        res.status(500).json({ error: error.message });
    }
};

const getCompanyById = async (req, res) => {
    try {
        const company = await prisma.company.findUnique({
            where: { id: parseInt(req.params.id) },
            include: {
                user: true,
                plan: true
            }
        });
        if (company && company.inventoryConfig) {
            try {
                const config = JSON.parse(company.inventoryConfig);
                company.storageCapacity = config.storageCapacity;
            } catch (e) {}
        }
        res.json(company);
    } catch (error) {
        console.error('Get Company By ID Error:', error);
        res.status(500).json({ error: error.message });
    }
};

const updateCompany = async (req, res) => {
    try {
        console.log('📥 Received company update request');
        console.log('Company ID:', req.params.id);
        console.log('Request body fields:', Object.keys(req.body));
        console.log('Files received:', req.files ? Object.keys(req.files) : 'None');

        const {
            name, email, phone, website, address, city, state, zip, country, currency,
            startDate, endDate, planId, planType,
            invoiceTemplate, invoiceColor, showQrCode,
            bankName, accountHolder, accountNumber,
            ifsc,
            terms,
            notes,
            inventoryConfig,
            storageCapacity
        } = req.body;

        // Fetch current company to get existing inventoryConfig
        const currentCompany = await prisma.company.findUnique({
            where: { id: parseInt(req.params.id) }
        });

        let finalInventoryConfig = currentCompany.inventoryConfig || '{}';
        try {
            let configObj = typeof finalInventoryConfig === 'string' ? JSON.parse(finalInventoryConfig) : finalInventoryConfig;
            if (storageCapacity !== undefined) {
                configObj.storageCapacity = storageCapacity;
            }
            if (inventoryConfig !== undefined) {
                // Merge other inventory config if provided
                const newConfig = typeof inventoryConfig === 'string' ? JSON.parse(inventoryConfig) : inventoryConfig;
                configObj = { ...configObj, ...newConfig };
            }
            finalInventoryConfig = JSON.stringify(configObj);
        } catch (e) {
            console.error('Error parsing inventoryConfig:', e);
        }

        const updateData = {
            name,
            email,
            phone,
            website,
            address,
            city,
            state,
            zip,
            country,
            currency,
            startDate: startDate ? new Date(startDate) : undefined,
            endDate: endDate ? new Date(endDate) : undefined,
            planId: planId ? parseInt(planId) : undefined,
            planType: planType || undefined,
            invoiceTemplate,
            invoiceColor,
            showQrCode: showQrCode === 'true' || showQrCode === true,
            bankName,
            accountHolder,
            accountNumber,
            ifsc,
            terms,
            notes,
            inventoryConfig: finalInventoryConfig
        };

        console.log('💾 Updating company with data:', updateData);

        const company = await prisma.company.update({
            where: { id: parseInt(req.params.id) },
            data: updateData,
            include: { plan: true }
        });

        // Add storageCapacity to the response object for frontend
        if (company.inventoryConfig) {
            try {
                const config = JSON.parse(company.inventoryConfig);
                company.storageCapacity = config.storageCapacity;
            } catch (e) {}
        }

        console.log('✅ Company updated successfully!');
        res.json(company);
    } catch (error) {
        console.error('❌ Update Company Error:', error);
        res.status(500).json({
            error: error.message || 'Internal Server Error'
        });
    }
};

const deleteCompany = async (req, res) => {
    try {
        // Transaction to delete company and its users
        await prisma.$transaction(async (tx) => {
            await tx.user.deleteMany({ where: { companyId: parseInt(req.params.id) } });
            await tx.company.delete({ where: { id: parseInt(req.params.id) } });
        });
        res.json({ message: 'Company and its users deleted successfully' });
    } catch (error) {
        console.error('Delete Company Error:', error);
        res.status(500).json({ error: error.message });
    }
};

module.exports = {
    createCompany,
    getCompanies,
    getCompanyById,
    updateCompany,
    deleteCompany
};
