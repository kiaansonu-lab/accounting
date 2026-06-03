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
            notes,
            discountAmount,
            discountLedgerId
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
                    notes,
                    discountAmount: parseFloat(discountAmount || 0),
                    discountLedgerId: discountLedgerId ? parseInt(discountLedgerId) : null
                }
            });

            let ledgerAmount = parseFloat(amount);
            let ledgerDiscountAmount = parseFloat(discountAmount || 0);
            // 1. Update Bill Balance
            if (purchaseBillId) {
                const bill = await tx.purchasebill.findUnique({
                    where: { id: parseInt(purchaseBillId) }
                });

                if (bill) {
                    const newPaidAmount = (bill.paidAmount || 0) + parseFloat(amount) + parseFloat(discountAmount || 0);
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

                    if (bill.exchangeRate) {
                        ledgerAmount = parseFloat(amount) * bill.exchangeRate;
                        ledgerDiscountAmount = parseFloat(discountAmount || 0) * bill.exchangeRate;
                    }
                }
            }

            // 2. Accounting Entries
            // DR Vendor (Liability Decreases)
            await tx.ledger.update({
                where: { id: vendor.ledgerId },
                data: { currentBalance: { decrement: ledgerAmount + ledgerDiscountAmount } }
            });

            // Update vendor table balance for consistency
            await tx.vendor.update({
                where: { id: parseInt(vendorId) },
                data: { accountBalance: { decrement: ledgerAmount + ledgerDiscountAmount } }
            });

            // CR Cash/Bank (Asset Decreases)
            await tx.ledger.update({
                where: { id: bankLedger.id },
                data: { currentBalance: { decrement: ledgerAmount } }
            });

            // CR Discount Received Ledger (Income increases)
            if (discountLedgerId && ledgerDiscountAmount > 0) {
                await tx.ledger.update({
                    where: { id: parseInt(discountLedgerId) },
                    data: { currentBalance: { increment: ledgerDiscountAmount } }
                });
            }

            // Log Cash/Bank Transaction
            await tx.transaction.create({
                data: {
                    date: date ? new Date(date) : new Date(),
                    voucherType: 'PAYMENT',
                    voucherNumber: paymentNumber || payment.paymentNumber,
                    debitLedgerId: vendor.ledgerId,
                    creditLedgerId: bankLedger.id,
                    amount: ledgerAmount,
                    narration: `Payment to ${vendor.name}${purchaseBillId ? ' for Bill ' + purchaseBillId : ''}`,
                    companyId: parseInt(companyId),
                    paymentId: payment.id,
                    purchaseBillId: purchaseBillId ? parseInt(purchaseBillId) : null
                }
            });

            // Log Discount Received Transaction
            if (discountLedgerId && ledgerDiscountAmount > 0) {
                await tx.transaction.create({
                    data: {
                        date: date ? new Date(date) : new Date(),
                        voucherType: 'PAYMENT',
                        voucherNumber: paymentNumber || payment.paymentNumber,
                        debitLedgerId: vendor.ledgerId,
                        creditLedgerId: parseInt(discountLedgerId),
                        amount: ledgerDiscountAmount,
                        narration: `Discount received from ${vendor.name}${purchaseBillId ? ' for Bill ' + purchaseBillId : ''}`,
                        companyId: parseInt(companyId),
                        paymentId: payment.id,
                        purchaseBillId: purchaseBillId ? parseInt(purchaseBillId) : null
                    }
                });
            }

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
                purchasebill: true,
                bankLedger: { select: { id: true, name: true } },
                discountLedger: { select: { id: true, name: true } }
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
                company: true,
                bankLedger: true,
                discountLedger: true
            }
        });
        if (!payment) return res.status(404).json({ message: 'Payment not found' });
        res.json(payment);
    } catch (error) {
        console.error('Get Payment By ID Error:', error);
        res.status(500).json({ error: error.message });
    }
};

// Update Payment
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
            notes,
            discountAmount,
            discountLedgerId
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
                    const revPaid = Math.max(0, (oldBill.paidAmount || 0) - existingPayment.amount - (existingPayment.discountAmount || 0));
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
            const oldDiscountAmt = existingPayment.discountAmount || 0;
            if (existingPayment.vendor?.ledgerId) {
                const vendorLedger = await tx.ledger.findUnique({ where: { id: existingPayment.vendor.ledgerId } });
                if (vendorLedger) {
                    await tx.ledger.update({
                        where: { id: existingPayment.vendor.ledgerId },
                        data: { currentBalance: { increment: existingPayment.amount + oldDiscountAmt } }
                    });
                }
                await tx.vendor.update({
                    where: { id: existingPayment.vendorId },
                    data: { accountBalance: { increment: existingPayment.amount + oldDiscountAmt } }
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

            if (existingPayment.discountLedgerId && oldDiscountAmt > 0) {
                const discountLedger = await tx.ledger.findUnique({ where: { id: existingPayment.discountLedgerId } });
                if (discountLedger) {
                    await tx.ledger.update({
                        where: { id: existingPayment.discountLedgerId },
                        data: { currentBalance: { decrement: oldDiscountAmt } }
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
                    notes,
                    discountAmount: discountAmount !== undefined ? parseFloat(discountAmount || 0) : undefined,
                    discountLedgerId: discountLedgerId !== undefined ? (discountLedgerId ? parseInt(discountLedgerId) : null) : undefined
                },
                include: { vendor: { include: { ledger: true } } }
            });

            // Apply to new Bill
            const finalAmount = amount ? parseFloat(amount) : existingPayment.amount;
            const finalDiscount = discountAmount !== undefined ? parseFloat(discountAmount || 0) : (existingPayment.discountAmount || 0);

            if (purchaseBillId) {
                const newBill = await tx.purchasebill.findUnique({ where: { id: parseInt(purchaseBillId) } });
                if (newBill) {
                    const newPaid = (newBill.paidAmount || 0) + finalAmount + finalDiscount;
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
            const finalDiscountLedgerId = discountLedgerId !== undefined ? (discountLedgerId ? parseInt(discountLedgerId) : null) : updatedPayment.discountLedgerId;

            if (newVendor?.ledgerId) {
                const vendorLedger = await tx.ledger.findUnique({ where: { id: newVendor.ledgerId } });
                if (vendorLedger) {
                    await tx.ledger.update({
                        where: { id: newVendor.ledgerId },
                        data: { currentBalance: { decrement: finalAmount + finalDiscount } }
                    });
                }
                await tx.vendor.update({
                    where: { id: newVendor.id },
                    data: { accountBalance: { decrement: finalAmount + finalDiscount } }
                });
            }

            if (newBankId) {
                const newBankLedger = await tx.ledger.findUnique({ where: { id: newBankId } });
                if (newBankLedger) {
                    await tx.ledger.update({
                        where: { id: newBankId },
                        data: { currentBalance: { decrement: finalAmount } }
                    });
                }
            }

            if (finalDiscountLedgerId && finalDiscount > 0) {
                const discountLedger = await tx.ledger.findUnique({ where: { id: finalDiscountLedgerId } });
                if (discountLedger) {
                    await tx.ledger.update({
                        where: { id: finalDiscountLedgerId },
                        data: { currentBalance: { increment: finalDiscount } }
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
                    amount: finalAmount,
                    narration: `Updated Payment to ${newVendor.name}`,
                    companyId: parseInt(currentCompanyId),
                    paymentId: updatedPayment.id,
                    purchaseBillId: purchaseBillId ? parseInt(purchaseBillId) : null
                }
            });

            if (finalDiscountLedgerId && finalDiscount > 0) {
                await tx.transaction.create({
                    data: {
                        date: date ? new Date(date) : updatedPayment.date,
                        voucherType: 'PAYMENT',
                        voucherNumber: paymentNumber || updatedPayment.paymentNumber,
                        debitLedgerId: newVendor.ledgerId,
                        creditLedgerId: finalDiscountLedgerId,
                        amount: finalDiscount,
                        narration: `Updated Discount received from ${newVendor.name}`,
                        companyId: parseInt(currentCompanyId),
                        paymentId: updatedPayment.id,
                        purchaseBillId: purchaseBillId ? parseInt(purchaseBillId) : null
                    }
                });
            }

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
                    const newPaidAmount = Math.max(0, (bill.paidAmount || 0) - payment.amount - (payment.discountAmount || 0));
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
            const oldDiscountAmt = payment.discountAmount || 0;
            if (payment.vendor?.ledgerId) {
                const vendorLedger = await tx.ledger.findUnique({ where: { id: payment.vendor.ledgerId } });
                if (vendorLedger) {
                    await tx.ledger.update({
                        where: { id: payment.vendor.ledgerId },
                        data: { currentBalance: { increment: payment.amount + oldDiscountAmt } }
                    });
                }
                await tx.vendor.update({
                    where: { id: payment.vendorId },
                    data: { accountBalance: { increment: payment.amount + oldDiscountAmt } }
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

            if (payment.discountLedgerId && oldDiscountAmt > 0) {
                const discountLedger = await tx.ledger.findUnique({ where: { id: payment.discountLedgerId } });
                if (discountLedger) {
                    await tx.ledger.update({
                        where: { id: payment.discountLedgerId },
                        data: { currentBalance: { decrement: oldDiscountAmt } }
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
