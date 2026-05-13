const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

// Create Customer Receipt (Payment)
const createReceipt = async (req, res) => {
    try {
        const { receiptNumber, date, customerId, invoiceId, amount, paymentMode, referenceNumber, cashBankAccountId, notes } = req.body;
        const companyId = req.user?.companyId || req.body.companyId;

        if (!receiptNumber || !customerId || !amount || !cashBankAccountId) {
            return res.status(400).json({ success: false, message: 'Please provide all required fields' });
        }

        const customer = await prisma.customer.findUnique({
            where: { id: parseInt(customerId) },
            include: { ledger: true }
        });

        const bankLedger = await prisma.ledger.findUnique({
            where: { id: parseInt(cashBankAccountId) }
        });

        if (!customer || !customer.ledgerId || !bankLedger) {
            return res.status(400).json({ success: false, message: 'Invalid customer or bank/cash account' });
        }

        const result = await prisma.$transaction(async (tx) => {
            // 1. Create Receipt Record
            const receipt = await tx.receipt.create({
                data: {
                    receiptNumber,
                    date: new Date(date),
                    customerId: parseInt(customerId),
                    invoiceId: invoiceId ? parseInt(invoiceId) : null,
                    amount: parseFloat(amount),
                    paymentMode: paymentMode,
                    referenceNumber,
                    cashBankAccountId: parseInt(cashBankAccountId),
                    companyId: parseInt(companyId),
                    notes
                }
            });

            // 2. Update Invoice Balance if applicable
            if (invoiceId) {
                const invoice = await tx.invoice.findUnique({ where: { id: parseInt(invoiceId) } });
                const newPaid = (invoice.paidAmount || 0) + parseFloat(amount);
                const newBalance = (invoice.totalAmount || 0) - newPaid;

                await tx.invoice.update({
                    where: { id: parseInt(invoiceId) },
                    data: {
                        paidAmount: newPaid,
                        balanceAmount: newBalance,
                        status: newBalance <= 0 ? 'PAID' : 'PARTIAL'
                    }
                });
            }

            // 3. Accounting Entries
            // DR Cash/Bank, CR Customer
            await tx.ledger.update({
                where: { id: bankLedger.id },
                data: { currentBalance: { increment: parseFloat(amount) } }
            });

            await tx.ledger.update({
                where: { id: customer.ledgerId },
                data: { currentBalance: { decrement: parseFloat(amount) } }
            });

            // Log Transaction
            await tx.transaction.create({
                data: {
                    date: new Date(date),
                    voucherType: 'RECEIPT',
                    voucherNumber: receiptNumber,
                    debitLedgerId: bankLedger.id,
                    creditLedgerId: customer.ledgerId,
                    amount: parseFloat(amount),
                    narration: `Payment received from ${customer.name}${invoiceId ? ' for Invoice ' + invoiceId : ''}`,
                    companyId: parseInt(companyId),
                    receiptId: receipt.id,
                    invoiceId: invoiceId ? parseInt(invoiceId) : null
                }
            });

            return receipt;
        }, {
            timeout: 30000
        });

        res.status(201).json({ success: true, data: result });
    } catch (error) {
        console.error('Receipt Creation Error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
};

// Update Customer Receipt
const updateReceipt = async (req, res) => {
    try {
        const { id } = req.params;
        const { date, amount, paymentMode, referenceNumber, cashBankAccountId, notes } = req.body;
        const companyId = req.user?.companyId || req.body.companyId;

        const existingReceipt = await prisma.receipt.findUnique({
            where: { id: parseInt(id) },
            include: { customer: true, invoice: true }
        });

        if (!existingReceipt) {
            return res.status(404).json({ success: false, message: 'Receipt not found' });
        }

        const result = await prisma.$transaction(async (tx) => {
            // 1. Reverse previous effects
            if (existingReceipt.invoiceId) {
                const invoice = await tx.invoice.findUnique({ where: { id: existingReceipt.invoiceId } });
                if (invoice) {
                    const revPaid = (invoice.paidAmount || 0) - existingReceipt.amount;
                    const revBalance = (invoice.totalAmount || 0) - revPaid;
                    await tx.invoice.update({
                        where: { id: existingReceipt.invoiceId },
                        data: { paidAmount: revPaid, balanceAmount: revBalance, status: revBalance <= 0 ? 'PAID' : revPaid > 0 ? 'PARTIAL' : 'UNPAID' }
                    });
                }
            }

            // Reverse ledger balances
            if (existingReceipt.cashBankAccountId) {
                const bankLedger = await tx.ledger.findUnique({ where: { id: existingReceipt.cashBankAccountId } });
                if (bankLedger) {
                    await tx.ledger.update({
                        where: { id: existingReceipt.cashBankAccountId },
                        data: { currentBalance: { decrement: existingReceipt.amount } }
                    });
                }
            }

            if (existingReceipt.customer && existingReceipt.customer.ledgerId) {
                const customerLedger = await tx.ledger.findUnique({ where: { id: existingReceipt.customer.ledgerId } });
                if (customerLedger) {
                    await tx.ledger.update({
                        where: { id: existingReceipt.customer.ledgerId },
                        data: { currentBalance: { increment: existingReceipt.amount } }
                    });
                }
            }

            // Delete old transaction
            await tx.transaction.deleteMany({ where: { receiptId: parseInt(id) } });

            // 2. Apply new effects
            const updatedReceipt = await tx.receipt.update({
                where: { id: parseInt(id) },
                data: {
                    date: date ? new Date(date) : undefined,
                    amount: amount ? parseFloat(amount) : undefined,
                    paymentMode,
                    referenceNumber,
                    cashBankAccountId: cashBankAccountId ? parseInt(cashBankAccountId) : undefined,
                    notes
                }
            });

            const finalAmount = amount ? parseFloat(amount) : existingReceipt.amount;
            const finalBankId = cashBankAccountId ? parseInt(cashBankAccountId) : existingReceipt.cashBankAccountId;

            if (existingReceipt.invoiceId) {
                const invoice = await tx.invoice.findUnique({ where: { id: existingReceipt.invoiceId } });
                if (invoice) {
                    const newPaid = (invoice.paidAmount || 0) + finalAmount;
                    const newBalance = (invoice.totalAmount || 0) - newPaid;
                    await tx.invoice.update({
                        where: { id: existingReceipt.invoiceId },
                        data: { paidAmount: newPaid, balanceAmount: newBalance, status: newBalance <= 0 ? 'PAID' : 'PARTIAL' }
                    });
                }
            }

            if (finalBankId) {
                const bankLedger = await tx.ledger.findUnique({ where: { id: finalBankId } });
                if (bankLedger) {
                    await tx.ledger.update({
                        where: { id: finalBankId },
                        data: { currentBalance: { increment: finalAmount } }
                    });
                }
            }

            if (existingReceipt.customer && existingReceipt.customer.ledgerId) {
                const customerLedger = await tx.ledger.findUnique({ where: { id: existingReceipt.customer.ledgerId } });
                if (customerLedger) {
                    await tx.ledger.update({
                        where: { id: existingReceipt.customer.ledgerId },
                        data: { currentBalance: { decrement: finalAmount } }
                    });
                }
            }

            // Create new transaction
            await tx.transaction.create({
                data: {
                    date: date ? new Date(date) : existingReceipt.date,
                    voucherType: 'RECEIPT',
                    voucherNumber: existingReceipt.receiptNumber,
                    debitLedgerId: finalBankId,
                    creditLedgerId: existingReceipt.customer.ledgerId,
                    amount: finalAmount,
                    narration: `Updated Payment from ${existingReceipt.customer.name}`,
                    companyId: parseInt(companyId),
                    receiptId: parseInt(id),
                    invoiceId: existingReceipt.invoiceId
                }
            });

            return updatedReceipt;
        }, {
            timeout: 30000
        });

        res.status(200).json({ success: true, data: result });
    } catch (error) {
        console.error('Receipt Update Error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
};

// Delete Customer Receipt
const deleteReceipt = async (req, res) => {
    try {
        const { id } = req.params;
        const companyId = req.user?.companyId || req.query.companyId;

        const existingReceipt = await prisma.receipt.findUnique({
            where: { id: parseInt(id) },
            include: { customer: true, invoice: true }
        });

        if (!existingReceipt) {
            return res.status(404).json({ success: false, message: 'Receipt not found' });
        }

        await prisma.$transaction(async (tx) => {
            // Reverse effects
            if (existingReceipt.invoiceId) {
                const invoice = await tx.invoice.findUnique({ where: { id: existingReceipt.invoiceId } });
                if (invoice) {
                    const revPaid = (invoice.paidAmount || 0) - existingReceipt.amount;
                    const revBalance = (invoice.totalAmount || 0) - revPaid;
                    await tx.invoice.update({
                        where: { id: existingReceipt.invoiceId },
                        data: { paidAmount: revPaid, balanceAmount: revBalance, status: revBalance <= 0 ? 'PAID' : revPaid > 0 ? 'PARTIAL' : 'UNPAID' }
                    });
                }
            }

            if (existingReceipt.cashBankAccountId) {
                const bankLedger = await tx.ledger.findUnique({ where: { id: existingReceipt.cashBankAccountId } });
                if (bankLedger) {
                    await tx.ledger.update({
                        where: { id: existingReceipt.cashBankAccountId },
                        data: { currentBalance: { decrement: existingReceipt.amount } }
                    });
                }
            }

            if (existingReceipt.customer && existingReceipt.customer.ledgerId) {
                const customerLedger = await tx.ledger.findUnique({ where: { id: existingReceipt.customer.ledgerId } });
                if (customerLedger) {
                    await tx.ledger.update({
                        where: { id: existingReceipt.customer.ledgerId },
                        data: { currentBalance: { increment: existingReceipt.amount } }
                    });
                }
            }

            // Delete transactions and receipt
            await tx.transaction.deleteMany({ where: { receiptId: parseInt(id) } });
            await tx.receipt.delete({ where: { id: parseInt(id) } });
        }, {
            timeout: 30000
        });

        res.status(200).json({ success: true, message: 'Receipt deleted successfully' });
    } catch (error) {
        console.error('Receipt Delete Error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
};

// Get All Receipts
const getReceipts = async (req, res) => {
    try {
        const companyId = req.user?.companyId || req.query.companyId;
        const receipts = await prisma.receipt.findMany({
            where: { companyId: parseInt(companyId) },
            include: {
                customer: { select: { id: true, name: true, ledgerId: true } },
                invoice: { select: { id: true, invoiceNumber: true, balanceAmount: true, totalAmount: true, paidAmount: true, date: true, dueDate: true, status: true } }
            },
            orderBy: { createdAt: 'desc' }
        });
        res.status(200).json({ success: true, data: receipts });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

// Get Receipt by ID
const getReceiptById = async (req, res) => {
    try {
        const { id } = req.params;
        const companyId = req.user?.companyId || req.query.companyId;
        const receipt = await prisma.receipt.findFirst({
            where: {
                id: parseInt(id),
                companyId: parseInt(companyId)
            },
            include: {
                customer: true,
                invoice: {
                    include: {
                        invoiceitem: {
                            include: {
                                product: true,
                                service: true,
                                warehouse: true
                            }
                        }
                    }
                }
            }
        });

        if (!receipt) {
            return res.status(404).json({ success: false, message: 'Receipt not found' });
        }

        res.status(200).json({ success: true, data: receipt });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

module.exports = {
    createReceipt,
    getReceipts,
    getReceiptById,
    updateReceipt,
    deleteReceipt
};
