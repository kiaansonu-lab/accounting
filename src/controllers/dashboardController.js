const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

// Super Admin Dashboard Stats
const getSuperAdminDashboardStats = async (req, res) => {
    try {
        const totalCompanies = await prisma.company.count();
        const totalRequests = await prisma.planrequest.count();

        const payments = await prisma.paymentrecord.findMany({
            where: { status: 'Success' }
        });
        const totalRevenue = payments.reduce((acc, curr) => acc + curr.amount, 0);

        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const todaySignups = await prisma.company.count({
            where: {
                createdAt: {
                    gte: today
                }
            }
        });

        // Monthly signups for charts
        const startOfYear = new Date(new Date().getFullYear(), 0, 1);
        const companies = await prisma.company.findMany({
            where: {
                createdAt: { gte: startOfYear }
            },
            select: { createdAt: true }
        });

        const monthlySignups = Array(12).fill(0);
        companies.forEach(c => {
            const month = new Date(c.createdAt).getMonth();
            monthlySignups[month]++;
        });

        const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        const growthData = months.map((month, index) => ({
            name: month,
            val: monthlySignups[index]
        }));

        // Monthly revenue for charts
        const successfulPayments = await prisma.paymentrecord.findMany({
            where: {
                status: 'Success',
                date: { gte: startOfYear }
            }
        });

        const monthlyRevenue = Array(12).fill(0);
        successfulPayments.forEach(p => {
            const month = new Date(p.date).getMonth();
            monthlyRevenue[month] += p.amount;
        });

        const revenueData = months.map((month, index) => ({
            name: month,
            val: monthlyRevenue[index]
        }));

        res.json({
            stats: {
                totalCompanies,
                totalRequests,
                totalRevenue,
                todaySignups
            },
            charts: {
                growthData,
                revenueData
            }
        });
    } catch (error) {
        console.error('Super Admin Dashboard Stats Error:', error);
        res.status(500).json({ error: error.message });
    }
};

// Company Dashboard Stats
const getCompanyDashboardStats = async (req, res) => {
    try {
        const companyId = req.user.companyId || req.query.companyId || (req.body && req.body.companyId);

        if (!companyId) {
            return res.status(400).json({ success: false, message: 'Company ID is required' });
        }

        const compId = parseInt(companyId);

        // 1. Calculate Total Revenue (Invoices + Income Vouchers)
        const invoices = await prisma.invoice.findMany({
            where: {
                companyId: compId,
                NOT: { status: 'CANCELLED' }
            },
            select: { totalAmount: true }
        });
        const invoiceRevenue = invoices.reduce((sum, inv) => sum + inv.totalAmount, 0);

        const incomeTx = await prisma.transaction.findMany({
            where: {
                companyId: compId,
                voucherType: 'INCOME'
            },
            select: { amount: true }
        });
        const incomeRevenue = incomeTx.reduce((sum, tx) => sum + tx.amount, 0);

        const totalRevenue = invoiceRevenue + incomeRevenue;

        // 2. Calculate Total Expenses (Purchase Bills + Expense Vouchers)
        const bills = await prisma.purchasebill.findMany({
            where: {
                companyId: compId,
                NOT: { status: 'CANCELLED' }
            },
            select: { totalAmount: true }
        });
        const billExpenses = bills.reduce((sum, bill) => sum + bill.totalAmount, 0);

        const expenseTx = await prisma.transaction.findMany({
            where: {
                companyId: compId,
                voucherType: 'EXPENSE'
            },
            select: { amount: true }
        });
        const voucherExpenses = expenseTx.reduce((sum, tx) => sum + tx.amount, 0);

        const totalExpenses = billExpenses + voucherExpenses;

        // 3. Calculate Net Profit
        const netProfit = totalRevenue - totalExpenses;

        // 3.5. General Counts
        const customerCount = await prisma.customer.count({ where: { companyId: compId } });
        const vendorCount = await prisma.vendor.count({ where: { companyId: compId } });
        const productCount = await prisma.product.count({ where: { companyId: compId } });
        const saleInvoiceCount = invoices.length;
        const purchaseBillCount = bills.length;

        // 4. Recent Transactions (Limit 5)
        const recentTransactions = await prisma.transaction.findMany({
            where: { companyId: compId },
            orderBy: { date: 'desc' },
            take: 5,
            include: {
                ledger_transaction_debitLedgerIdToledger: { select: { name: true } },
                ledger_transaction_creditLedgerIdToledger: { select: { name: true } }
            }
        });

        const formattedTransactions = recentTransactions.map(tx => ({
            id: tx.id,
            date: tx.date,
            description: tx.narration,
            amount: tx.amount,
            type: tx.voucherType,
            status: 'Completed'
        }));

        // 5. Monthly Data for Charts
        const monthsList = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        const currentYear = new Date().getFullYear();

        const yearInvoices = await prisma.invoice.findMany({
            where: {
                companyId: compId,
                date: { gte: new Date(currentYear, 0, 1) },
                NOT: { status: 'CANCELLED' }
            },
            select: { date: true, totalAmount: true }
        });

        const yearBills = await prisma.purchasebill.findMany({
            where: {
                companyId: compId,
                date: { gte: new Date(currentYear, 0, 1) },
                NOT: { status: 'CANCELLED' }
            },
            select: { date: true, totalAmount: true }
        });

        const revenueArr = Array(12).fill(0);
        const expenseArr = Array(12).fill(0);

        yearInvoices.forEach(item => {
            const m = new Date(item.date).getMonth();
            revenueArr[m] += item.totalAmount || 0;
        });

        yearBills.forEach(item => {
            const m = new Date(item.date).getMonth();
            expenseArr[m] += item.totalAmount || 0;
        });

        const chartData = monthsList.map((m, i) => ({
            name: m,
            revenue: revenueArr[i],
            expense: expenseArr[i]
        }));

        // 6. Top Selling Products (Calculated from Invoice Items)
        const topProductItems = await prisma.invoiceitem.groupBy({
            by: ['productId'],
            where: {
                invoice: { companyId: compId, NOT: { status: 'CANCELLED' } },
                productId: { not: null }
            },
            _sum: { quantity: true },
            orderBy: { _sum: { quantity: 'desc' } },
            take: 5
        });

        const topProducts = await Promise.all(topProductItems.map(async (item) => {
            const product = await prisma.product.findUnique({
                where: { id: item.productId },
                select: { name: true, salePrice: true, image: true }
            });
            return {
                ...product,
                quantity: item._sum.quantity
            };
        }));

        // 7. Low Stock Products
        const lowStock = await prisma.stock.findMany({
            where: {
                product: { companyId: compId },
                quantity: { lte: prisma.stock.fields.minOrderQty }
            },
            include: { product: { select: { name: true, image: true } } },
            take: 5
        });

        const lowStockProducts = lowStock.map(s => ({
            name: s.product.name,
            quantity: s.quantity,
            minQty: s.minOrderQty,
            image: s.product.image
        }));

        // 8. Top Customers (By Revenue)
        const topCustomerInvoices = await prisma.invoice.groupBy({
            by: ['customerId'],
            where: { companyId: compId, NOT: { status: 'CANCELLED' } },
            _sum: { totalAmount: true },
            orderBy: { _sum: { totalAmount: 'desc' } },
            take: 5
        });

        const topCustomers = await Promise.all(topCustomerInvoices.map(async (item) => {
            const customer = await prisma.customer.findUnique({
                where: { id: item.customerId },
                select: { name: true, email: true, profileImage: true }
            });
            return {
                ...customer,
                totalSales: item._sum.totalAmount
            };
        }));

        res.json({
            success: true,
            data: {
                totalRevenue,
                totalExpenses,
                netProfit,
                customerCount,
                vendorCount,
                productCount,
                saleInvoiceCount,
                purchaseBillCount,
                recentTransactions: formattedTransactions,
                chartData,
                topProducts,
                lowStockProducts,
                topCustomers
            }
        });

    } catch (error) {
        console.error('Company Dashboard Stats Error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
};

const createAnnouncement = async (req, res) => {
    try {
        const { title, content, status } = req.body;
        const announcement = await prisma.dashboardannouncement.create({
            data: { title, content, status: status || 'Active' }
        });
        res.status(201).json(announcement);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

const getAnnouncements = async (req, res) => {
    try {
        const announcements = await prisma.dashboardannouncement.findMany({
            orderBy: { createdAt: 'desc' }
        });
        res.json(announcements);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

const getAnnouncementById = async (req, res) => {
    try {
        const announcement = await prisma.dashboardannouncement.findUnique({
            where: { id: parseInt(req.params.id) }
        });
        if (!announcement) return res.status(404).json({ message: 'Announcement not found' });
        res.json(announcement);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

const updateAnnouncement = async (req, res) => {
    try {
        const { title, content, status } = req.body;
        const announcement = await prisma.dashboardannouncement.update({
            where: { id: parseInt(req.params.id) },
            data: { title, content, status }
        });
        res.json(announcement);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

const deleteAnnouncement = async (req, res) => {
    try {
        await prisma.dashboardannouncement.delete({
            where: { id: parseInt(req.params.id) }
        });
        res.json({ message: 'Announcement deleted successfully' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

module.exports = {
    getSuperAdminDashboardStats,
    getCompanyDashboardStats,
    createAnnouncement,
    getAnnouncements,
    getAnnouncementById,
    updateAnnouncement,
    deleteAnnouncement
};
