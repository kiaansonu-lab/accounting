const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const createPayment = async (req, res) => {
    try {
        const {
            paymentNumber,
            date,
            vendorId,
            purchaseBillId,
            amount,
            paymentMode,
            referenceNumber,
            cashBankAccountId,
            notes
        } = req.body;
        const companyId = req.user?.companyId || req.query.companyId || req.body.companyId;

        if (!vendorId || !amount || !cashBankAccountId) {
            return res.status(400).json({ success: false, message: 'Missing required fields' });
        }

        const vendor = await prisma.vendor.findUnique({
            where: { id: parseInt(vendorId) },
            include: { ledger: true }
        });

        const bankLedger = await prisma.ledger.findUnique({
            where: { id: parseInt(cashBankAccountId) }
        });

        if (!vendor || !vendor.ledgerId || !bankLedger) {
            return res.status(400).json({ success: false, message: 'Invalid vendor or bank/cash account' });
        }

        // Normalize payment mode for Prisma enum
        const modeMap = {
            'Bank Transfer': 'BANK',
            'Online': 'BANK',
            'UPI': 'UPI',
            'Cash': 'CASH',
            'Credit Card': 'CARD',
            'Cheque': 'CHEQUE'
        };
        const normalizedMode = modeMap[paymentMode] || 'OTHER';

        const result = await prisma.$transaction(async (tx) => {
            const payment = await tx.payment.create({
                data: {
                    paymentNumber: paymentNumber || `PAY-${Date.now()}`,
                    date: date ? new Date(date) : new Date(),
                    vendorId: parseInt(vendorId),
                    purchaseBillId: purchaseBillId ? parseInt(purchaseBillId) : null,
                    amount: parseFloat(amount),
                    paymentMode: normalizedMode,
                    referenceNumber,
                    cashBankAccountId: parseInt(cashBankAccountId),
                    companyId: parseInt(companyId),
                    notes
                }
            });

            // 1. Update Bill Balance
            if (purchaseBillId) {
                const bill = await tx.purchasebill.findUnique({
                    where: { id: parseInt(purchaseBillId) }
                });

                if (bill) {
                    const newPaidAmount = (bill.paidAmount || 0) + parseFloat(amount);
                    const newBalanceAmount = bill.totalAmount - newPaidAmount;
                    const newStatus = newBalanceAmount <= 0 ? 'PAID' : 'PARTIAL';

                    await tx.purchasebill.update({
                        where: { id: parseInt(purchaseBillId) },
                        data: {
                            paidAmount: newPaidAmount,
                            balanceAmount: newBalanceAmount,
                            status: newStatus
                        }
                    });
                }
            }

            // 2. Accounting Entries
            // DR Vendor (Liability Decreases), CR Cash/Bank (Asset Decreases)
            await tx.ledger.update({
                where: { id: vendor.ledgerId },
                data: { currentBalance: { decrement: parseFloat(amount) } }
            });

            // Update vendor table balance for consistency
            await tx.vendor.update({
                where: { id: parseInt(vendorId) },
                data: { accountBalance: { decrement: parseFloat(amount) } }
            });

            await tx.ledger.update({
                where: { id: bankLedger.id },
                data: { currentBalance: { decrement: parseFloat(amount) } }
            });

            // Log Transaction
            await tx.transaction.create({
                data: {
                    date: date ? new Date(date) : new Date(),
                    voucherType: 'PAYMENT',
                    voucherNumber: paymentNumber || payment.paymentNumber,
                    debitLedgerId: vendor.ledgerId,
                    creditLedgerId: bankLedger.id,
                    amount: parseFloat(amount),
                    narration: `Payment to ${vendor.name}${purchaseBillId ? ' for Bill ' + purchaseBillId : ''}`,
                    companyId: parseInt(companyId),
                    paymentId: payment.id,
                    purchaseBillId: purchaseBillId ? parseInt(purchaseBillId) : null
                }
            });

            return payment;
        }, {
            timeout: 30000
        });

        res.status(201).json({ success: true, data: result });
    } catch (error) {
        console.error('Create Payment Error:', error);
        res.status(500).json({ error: error.message });
    }
};

const getPayments = async (req, res) => {
    try {
        const {
            companyId,
            vendorId,
            startDate,
            endDate
        } = req.query;

        const currentCompanyId = req.user?.companyId || companyId;

        let where = {};
        if (currentCompanyId) where.companyId = parseInt(currentCompanyId);
        if (vendorId) where.vendorId = parseInt(vendorId);
        if (startDate && endDate) {
            where.date = {
                gte: new Date(startDate),
                lte: new Date(endDate)
            };
        }

        const payments = await prisma.payment.findMany({
            where,
            include: {
                vendor: true,
                purchasebill: true
            },
            orderBy: {
                date: 'desc'
            }
        });

        res.json(payments);
    } catch (error) {
        console.error('Get Payments Error:', error);
        res.status(500).json({ error: error.message });
    }
};

const getPaymentById = async (req, res) => {
    try {
        const { id } = req.params;
        const companyId = req.user?.companyId || req.query.companyId;

        const payment = await prisma.payment.findUnique({
            where: { id: parseInt(id), companyId: parseInt(companyId) },
            include: {
                vendor: { include: { ledger: true } },
                purchasebill: true,
                company: true
            }
        });
        if (!payment) return res.status(404).json({ message: 'Payment not found' });
        res.json(payment);
    } catch (error) {
        console.error('Get Payment By ID Error:', error);
        res.status(500).json({ error: error.message });
    }
};

const updatePayment = async (req, res) => {
    try {
        const { id } = req.params;
        const {
            paymentNumber,
            date,
            vendorId,
            purchaseBillId,
            amount,
            paymentMode,
            referenceNumber,
            cashBankAccountId,
            notes
        } = req.body;
        const currentCompanyId = req.user?.companyId || req.query.companyId || req.body.companyId;

        const existingPayment = await prisma.payment.findUnique({
            where: { id: parseInt(id) },
            include: { vendor: true }
        });

        if (!existingPayment) {
            return res.status(404).json({ message: 'Payment not found' });
        }

        const modeMap = {
            'Bank Transfer': 'BANK',
            'Online': 'BANK',
            'UPI': 'UPI',
            'Cash': 'CASH',
            'Credit Card': 'CARD',
            'Cheque': 'CHEQUE'
        };
        const normalizedMode = modeMap[paymentMode] || 'OTHER';

        const result = await prisma.$transaction(async (tx) => {
            // 1. REVERSE PREVIOUS EFFECTS
            // Reverse Bill
            if (existingPayment.purchaseBillId) {
                const oldBill = await tx.purchasebill.findUnique({ where: { id: existingPayment.purchaseBillId } });
                if (oldBill) {
                    const revPaid = Math.max(0, (oldBill.paidAmount || 0) - existingPayment.amount);
                    await tx.purchasebill.update({
                        where: { id: existingPayment.purchaseBillId },
                        data: {
                            paidAmount: revPaid,
                            balanceAmount: oldBill.totalAmount - revPaid,
                            status: (oldBill.totalAmount - revPaid) >= oldBill.totalAmount ? 'UNPAID' : 'PARTIAL'
                        }
                    });
                }
            }

            // Reverse Ledger & Vendor
            if (existingPayment.vendor?.ledgerId) {
                const vendorLedger = await tx.ledger.findUnique({ where: { id: existingPayment.vendor.ledgerId } });
                if (vendorLedger) {
                    await tx.ledger.update({
                        where: { id: existingPayment.vendor.ledgerId },
                        data: { currentBalance: { increment: existingPayment.amount } }
                    });
                }
                await tx.vendor.update({
                    where: { id: existingPayment.vendorId },
                    data: { accountBalance: { increment: existingPayment.amount } }
                });
            }

            if (existingPayment.cashBankAccountId) {
                const bankLedger = await tx.ledger.findUnique({ where: { id: existingPayment.cashBankAccountId } });
                if (bankLedger) {
                    await tx.ledger.update({
                        where: { id: existingPayment.cashBankAccountId },
                        data: { currentBalance: { increment: existingPayment.amount } }
                    });
                }
            }

            // Delete old transactions
            await tx.transaction.deleteMany({ where: { paymentId: existingPayment.id } });

            // 2. APPLY NEW EFFECTS
            const updatedPayment = await tx.payment.update({
                where: { id: parseInt(id) },
                data: {
                    paymentNumber,
                    date: date ? new Date(date) : undefined,
                    vendorId: vendorId ? parseInt(vendorId) : undefined,
                    purchaseBillId: purchaseBillId ? parseInt(purchaseBillId) : null,
                    amount: amount ? parseFloat(amount) : undefined,
                    paymentMode: normalizedMode,
                    referenceNumber,
                    cashBankAccountId: cashBankAccountId ? parseInt(cashBankAccountId) : undefined,
                    notes
                },
                include: { vendor: { include: { ledger: true } } }
            });

            // Apply to new Bill
            if (purchaseBillId) {
                const newBill = await tx.purchasebill.findUnique({ where: { id: parseInt(purchaseBillId) } });
                if (newBill) {
                    const newPaid = (newBill.paidAmount || 0) + parseFloat(amount);
                    await tx.purchasebill.update({
                        where: { id: parseInt(purchaseBillId) },
                        data: {
                            paidAmount: newPaid,
                            balanceAmount: newBill.totalAmount - newPaid,
                            status: (newBill.totalAmount - newPaid) <= 0 ? 'PAID' : 'PARTIAL'
                        }
                    });
                }
            }

            // Apply to new Ledger & Vendor
            const newVendor = updatedPayment.vendor;
            const newBankId = cashBankAccountId ? parseInt(cashBankAccountId) : updatedPayment.cashBankAccountId;

            if (newVendor?.ledgerId) {
                const vendorLedger = await tx.ledger.findUnique({ where: { id: newVendor.ledgerId } });
                if (vendorLedger) {
                    await tx.ledger.update({
                        where: { id: newVendor.ledgerId },
                        data: { currentBalance: { decrement: parseFloat(amount) } }
                    });
                }
                await tx.vendor.update({
                    where: { id: newVendor.id },
                    data: { accountBalance: { decrement: parseFloat(amount) } }
                });
            }

            if (newBankId) {
                const newBankLedger = await tx.ledger.findUnique({ where: { id: newBankId } });
                if (newBankLedger) {
                    await tx.ledger.update({
                        where: { id: newBankId },
                        data: { currentBalance: { decrement: parseFloat(amount) } }
                    });
                }
            }

            // Create new transaction
            await tx.transaction.create({
                data: {
                    date: date ? new Date(date) : updatedPayment.date,
                    voucherType: 'PAYMENT',
                    voucherNumber: paymentNumber || updatedPayment.paymentNumber,
                    debitLedgerId: newVendor.ledgerId,
                    creditLedgerId: newBankId,
                    amount: parseFloat(amount),
                    narration: `Updated Payment to ${newVendor.name}`,
                    companyId: parseInt(currentCompanyId),
                    paymentId: updatedPayment.id,
                    purchaseBillId: purchaseBillId ? parseInt(purchaseBillId) : null
                }
            });

            return updatedPayment;
        }, {
            timeout: 30000
        });

        res.json(result);
    } catch (error) {
        console.error('Update Payment Error:', error);
        res.status(500).json({ error: error.message });
    }
};

const deletePayment = async (req, res) => {
    try {
        const { id } = req.params;
        const companyId = req.user?.companyId || req.query.companyId;

        const payment = await prisma.payment.findFirst({
            where: { id: parseInt(id), companyId: parseInt(companyId) },
            include: { vendor: true }
        });

        if (!payment) return res.status(404).json({ message: 'Payment not found' });

        await prisma.$transaction(async (tx) => {
            // 1. Reverse Bill Balance
            if (payment.purchaseBillId) {
                const bill = await tx.purchasebill.findUnique({
                    where: { id: payment.purchaseBillId }
                });

                if (bill) {
                    const newPaidAmount = Math.max(0, (bill.paidAmount || 0) - payment.amount);
                    const newBalanceAmount = bill.totalAmount - newPaidAmount;
                    const newStatus = newBalanceAmount >= bill.totalAmount ? 'UNPAID' : (newBalanceAmount > 0 ? 'PARTIAL' : 'PAID');

                    await tx.purchasebill.update({
                        where: { id: payment.purchaseBillId },
                        data: {
                            paidAmount: newPaidAmount,
                            balanceAmount: newBalanceAmount,
                            status: newStatus
                        }
                    });
                }
            }

            // 2. Reverse Accounting Entries
            // CR Vendor (Liability Increases), DR Cash/Bank (Asset Increases)
            if (payment.vendor?.ledgerId) {
                const vendorLedger = await tx.ledger.findUnique({ where: { id: payment.vendor.ledgerId } });
                if (vendorLedger) {
                    await tx.ledger.update({
                        where: { id: payment.vendor.ledgerId },
                        data: { currentBalance: { increment: payment.amount } }
                    });
                }
                await tx.vendor.update({
                    where: { id: payment.vendorId },
                    data: { accountBalance: { increment: payment.amount } }
                });
            }

            if (payment.cashBankAccountId) {
                const bankLedger = await tx.ledger.findUnique({ where: { id: payment.cashBankAccountId } });
                if (bankLedger) {
                    await tx.ledger.update({
                        where: { id: payment.cashBankAccountId },
                        data: { currentBalance: { increment: payment.amount } }
                    });
                }
            }

            // 3. Delete Transactions and Payment
            await tx.transaction.deleteMany({
                where: { paymentId: payment.id }
            });

            await tx.payment.delete({
                where: { id: parseInt(id), companyId: parseInt(companyId) }
            });
        }, {
            timeout: 30000
        });

        res.json({ success: true, message: 'Payment deleted successfully' });
    } catch (error) {
        console.error('Delete Payment Error:', error);
        res.status(500).json({ error: error.message });
    }
};

module.exports = {
    createPayment,
    getPayments,
    getPaymentById,
    updatePayment,
    deletePayment
};
