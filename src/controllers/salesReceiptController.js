const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

// Create Customer Receipt (Payment)
const createReceipt = async (req, res) => {
    try {
        const { receiptNumber, date, customerId, invoiceId, amount, paymentMode, referenceNumber, cashBankAccountId, notes, discountAmount, discountLedgerId } = req.body;
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
                    notes,
                    discountAmount: parseFloat(discountAmount || 0),
                    discountLedgerId: discountLedgerId ? parseInt(discountLedgerId) : null
                }
            });

            let ledgerAmount = parseFloat(amount);
            let ledgerDiscountAmount = parseFloat(discountAmount || 0);
            // 2. Update Invoice Balance if applicable
            if (invoiceId) {
                const invoice = await tx.invoice.findUnique({ where: { id: parseInt(invoiceId) } });
                if (invoice) {
                    const newPaid = (invoice.paidAmount || 0) + parseFloat(amount) + parseFloat(discountAmount || 0);
                    const newBalance = (invoice.totalAmount || 0) - newPaid;

                    await tx.invoice.update({
                        where: { id: parseInt(invoiceId) },
                        data: {
                            paidAmount: newPaid,
                            balanceAmount: newBalance,
                            status: newBalance <= 0 ? 'PAID' : 'PARTIAL'
                        }
                    });

                    if (invoice.exchangeRate) {
                        ledgerAmount = parseFloat(amount) * invoice.exchangeRate;
                        ledgerDiscountAmount = parseFloat(discountAmount || 0) * invoice.exchangeRate;
                    }
                }
            }

            // 3. Accounting Entries
            // DR Cash/Bank
            await tx.ledger.update({
                where: { id: bankLedger.id },
                data: { currentBalance: { increment: ledgerAmount } }
            });

            // DR Discount Expense Ledger
            if (discountLedgerId && ledgerDiscountAmount > 0) {
                await tx.ledger.update({
                    where: { id: parseInt(discountLedgerId) },
                    data: { currentBalance: { increment: ledgerDiscountAmount } }
                });
            }

            // CR Customer
            await tx.ledger.update({
                where: { id: customer.ledgerId },
                data: { currentBalance: { decrement: ledgerAmount + ledgerDiscountAmount } }
            });

            // Log Cash/Bank Transaction
            await tx.transaction.create({
                data: {
                    date: new Date(date),
                    voucherType: 'RECEIPT',
                    voucherNumber: receiptNumber,
                    debitLedgerId: bankLedger.id,
                    creditLedgerId: customer.ledgerId,
                    amount: ledgerAmount,
                    narration: `Payment received from ${customer.name}${invoiceId ? ' for Invoice ' + invoiceId : ''}`,
                    companyId: parseInt(companyId),
                    receiptId: receipt.id,
                    invoiceId: invoiceId ? parseInt(invoiceId) : null
                }
            });

            // Log Discount Transaction
            if (discountLedgerId && ledgerDiscountAmount > 0) {
                await tx.transaction.create({
                    data: {
                        date: new Date(date),
                        voucherType: 'RECEIPT',
                        voucherNumber: receiptNumber,
                        debitLedgerId: parseInt(discountLedgerId),
                        creditLedgerId: customer.ledgerId,
                        amount: ledgerDiscountAmount,
                        narration: `Discount allowed to ${customer.name}${invoiceId ? ' for Invoice ' + invoiceId : ''}`,
                        companyId: parseInt(companyId),
                        receiptId: receipt.id,
                        invoiceId: invoiceId ? parseInt(invoiceId) : null
                    }
                });
            }

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
        const { date, amount, paymentMode, referenceNumber, cashBankAccountId, notes, discountAmount, discountLedgerId } = req.body;
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
            let revertAmount = existingReceipt.amount;
            let revertDiscountAmount = existingReceipt.discountAmount || 0;

            if (existingReceipt.invoiceId) {
                const invoice = await tx.invoice.findUnique({ where: { id: existingReceipt.invoiceId } });
                if (invoice) {
                    const revPaid = (invoice.paidAmount || 0) - existingReceipt.amount - (existingReceipt.discountAmount || 0);
                    const revBalance = (invoice.totalAmount || 0) - revPaid;
                    await tx.invoice.update({
                        where: { id: existingReceipt.invoiceId },
                        data: { paidAmount: revPaid, balanceAmount: revBalance, status: revBalance <= 0 ? 'PAID' : revPaid > 0 ? 'PARTIAL' : 'UNPAID' }
                    });
                    if (invoice.exchangeRate) {
                        revertAmount = existingReceipt.amount * invoice.exchangeRate;
                        revertDiscountAmount = (existingReceipt.discountAmount || 0) * invoice.exchangeRate;
                    }
                }
            }

            // Reverse ledger balances
            if (existingReceipt.cashBankAccountId) {
                const bankLedger = await tx.ledger.findUnique({ where: { id: existingReceipt.cashBankAccountId } });
                if (bankLedger) {
                    await tx.ledger.update({
                        where: { id: existingReceipt.cashBankAccountId },
                        data: { currentBalance: { decrement: revertAmount } }
                    });
                }
            }

            if (existingReceipt.discountLedgerId && revertDiscountAmount > 0) {
                const discountLedger = await tx.ledger.findUnique({ where: { id: existingReceipt.discountLedgerId } });
                if (discountLedger) {
                    await tx.ledger.update({
                        where: { id: existingReceipt.discountLedgerId },
                        data: { currentBalance: { decrement: revertDiscountAmount } }
                    });
                }
            }

            if (existingReceipt.customer && existingReceipt.customer.ledgerId) {
                const customerLedger = await tx.ledger.findUnique({ where: { id: existingReceipt.customer.ledgerId } });
                if (customerLedger) {
                    await tx.ledger.update({
                        where: { id: existingReceipt.customer.ledgerId },
                        data: { currentBalance: { increment: revertAmount + revertDiscountAmount } }
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
                    notes,
                    discountAmount: discountAmount !== undefined ? parseFloat(discountAmount || 0) : undefined,
                    discountLedgerId: discountLedgerId !== undefined ? (discountLedgerId ? parseInt(discountLedgerId) : null) : undefined
                }
            });

            const finalAmount = amount ? parseFloat(amount) : existingReceipt.amount;
            const finalDiscount = discountAmount !== undefined ? parseFloat(discountAmount || 0) : (existingReceipt.discountAmount || 0);
            const finalBankId = cashBankAccountId ? parseInt(cashBankAccountId) : existingReceipt.cashBankAccountId;
            const finalDiscountLedgerId = discountLedgerId !== undefined ? (discountLedgerId ? parseInt(discountLedgerId) : null) : existingReceipt.discountLedgerId;

            let finalLedgerAmount = finalAmount;
            let finalLedgerDiscount = finalDiscount;

            if (existingReceipt.invoiceId) {
                const invoice = await tx.invoice.findUnique({ where: { id: existingReceipt.invoiceId } });
                if (invoice) {
                    const newPaid = (invoice.paidAmount || 0) + finalAmount + finalDiscount;
                    const newBalance = (invoice.totalAmount || 0) - newPaid;
                    await tx.invoice.update({
                        where: { id: existingReceipt.invoiceId },
                        data: { paidAmount: newPaid, balanceAmount: newBalance, status: newBalance <= 0 ? 'PAID' : 'PARTIAL' }
                    });
                    if (invoice.exchangeRate) {
                        finalLedgerAmount = finalAmount * invoice.exchangeRate;
                        finalLedgerDiscount = finalDiscount * invoice.exchangeRate;
                    }
                }
            }

            if (finalBankId) {
                const bankLedger = await tx.ledger.findUnique({ where: { id: finalBankId } });
                if (bankLedger) {
                    await tx.ledger.update({
                        where: { id: finalBankId },
                        data: { currentBalance: { increment: finalLedgerAmount } }
                    });
                }
            }

            if (finalDiscountLedgerId && finalLedgerDiscount > 0) {
                const discountLedger = await tx.ledger.findUnique({ where: { id: finalDiscountLedgerId } });
                if (discountLedger) {
                    await tx.ledger.update({
                        where: { id: finalDiscountLedgerId },
                        data: { currentBalance: { increment: finalLedgerDiscount } }
                    });
                }
            }

            if (existingReceipt.customer && existingReceipt.customer.ledgerId) {
                const customerLedger = await tx.ledger.findUnique({ where: { id: existingReceipt.customer.ledgerId } });
                if (customerLedger) {
                    await tx.ledger.update({
                        where: { id: existingReceipt.customer.ledgerId },
                        data: { currentBalance: { decrement: finalLedgerAmount + finalLedgerDiscount } }
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
                    amount: finalLedgerAmount,
                    narration: `Updated Payment from ${existingReceipt.customer.name}`,
                    companyId: parseInt(companyId),
                    receiptId: parseInt(id),
                    invoiceId: existingReceipt.invoiceId
                }
            });

            if (finalDiscountLedgerId && finalLedgerDiscount > 0) {
                await tx.transaction.create({
                    data: {
                        date: date ? new Date(date) : existingReceipt.date,
                        voucherType: 'RECEIPT',
                        voucherNumber: existingReceipt.receiptNumber,
                        debitLedgerId: finalDiscountLedgerId,
                        creditLedgerId: existingReceipt.customer.ledgerId,
                        amount: finalLedgerDiscount,
                        narration: `Updated Discount allowed to ${existingReceipt.customer.name}`,
                        companyId: parseInt(companyId),
                        receiptId: parseInt(id),
                        invoiceId: existingReceipt.invoiceId
                    }
                });
            }

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
            let revertAmount = existingReceipt.amount;
            let revertDiscountAmount = existingReceipt.discountAmount || 0;

            if (existingReceipt.invoiceId) {
                const invoice = await tx.invoice.findUnique({ where: { id: existingReceipt.invoiceId } });
                if (invoice) {
                    const revPaid = (invoice.paidAmount || 0) - existingReceipt.amount - (existingReceipt.discountAmount || 0);
                    const revBalance = (invoice.totalAmount || 0) - revPaid;
                    await tx.invoice.update({
                        where: { id: existingReceipt.invoiceId },
                        data: { paidAmount: revPaid, balanceAmount: revBalance, status: revBalance <= 0 ? 'PAID' : revPaid > 0 ? 'PARTIAL' : 'UNPAID' }
                    });
                    if (invoice.exchangeRate) {
                        revertAmount = existingReceipt.amount * invoice.exchangeRate;
                        revertDiscountAmount = (existingReceipt.discountAmount || 0) * invoice.exchangeRate;
                    }
                }
            }

            if (existingReceipt.cashBankAccountId) {
                const bankLedger = await tx.ledger.findUnique({ where: { id: existingReceipt.cashBankAccountId } });
                if (bankLedger) {
                    await tx.ledger.update({
                        where: { id: existingReceipt.cashBankAccountId },
                        data: { currentBalance: { decrement: revertAmount } }
                    });
                }
            }

            if (existingReceipt.discountLedgerId && revertDiscountAmount > 0) {
                const discountLedger = await tx.ledger.findUnique({ where: { id: existingReceipt.discountLedgerId } });
                if (discountLedger) {
                    await tx.ledger.update({
                        where: { id: existingReceipt.discountLedgerId },
                        data: { currentBalance: { decrement: revertDiscountAmount } }
                    });
                }
            }

            if (existingReceipt.customer && existingReceipt.customer.ledgerId) {
                const customerLedger = await tx.ledger.findUnique({ where: { id: existingReceipt.customer.ledgerId } });
                if (customerLedger) {
                    await tx.ledger.update({
                        where: { id: existingReceipt.customer.ledgerId },
                        data: { currentBalance: { increment: revertAmount + revertDiscountAmount } }
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
                invoice: { select: { id: true, invoiceNumber: true, balanceAmount: true, totalAmount: true, paidAmount: true, date: true, dueDate: true, status: true } },
                cashBankAccount: { select: { id: true, name: true } },
                discountLedger: { select: { id: true, name: true } }
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
                },
                cashBankAccount: true,
                discountLedger: true
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
