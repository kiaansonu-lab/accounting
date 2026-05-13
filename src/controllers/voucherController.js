const { PrismaClient } = require('../../prisma/generated/client');
const prisma = new PrismaClient();

// Create Voucher
const createVoucher = async (req, res) => {
    try {
        const {
            voucherNumber,
            voucherType,
            date,
            companyName,
            logo,
            paidFromLedgerId,
            paidToLedgerId,
            paidFromAccount,
            paidToParty,
            vendorId,
            customerId,
            items,
            notes,
            signature
        } = req.body;

        const companyId = req.body.companyId || req.user?.companyId;

        if (!companyId) {
            return res.status(400).json({ success: false, message: 'Company ID is required' });
        }

        if (req.body.isJournal) {
            const { journalRows, voucherNumber, date, notes, manualReceiptNo } = req.body;

            // Validate totals
            const totalDr = journalRows.reduce((sum, r) => sum + (parseFloat(r.debit) || 0), 0);
            const totalCr = journalRows.reduce((sum, r) => sum + (parseFloat(r.credit) || 0), 0);

            if (Math.abs(totalDr - totalCr) > 0.1) {
                return res.status(400).json({ success: false, message: 'Total Debit must equal Total Credit' });
            }

            // Check for duplicate voucher number
            const existingJE = await prisma.journalentry.findFirst({
                where: { voucherNumber, companyId: parseInt(companyId) }
            });
            if (existingJE) {
                return res.status(400).json({ success: false, message: `Journal Voucher ${voucherNumber} already exists.` });
            }

            // Create Journal Entry Header
            const je = await prisma.journalentry.create({
                data: {
                    voucherNumber,
                    date: date ? new Date(date) : new Date(),
                    narration: notes,
                    companyId: parseInt(companyId)
                }
            });

            // Split and Match Logic
            let drs = journalRows.filter(r => r.type === 'Dr').map(r => ({ ...r, accountId: parseInt(r.accountId), remaining: parseFloat(r.debit) || 0 }));
            let crs = journalRows.filter(r => r.type === 'Cr').map(r => ({ ...r, accountId: parseInt(r.accountId), remaining: parseFloat(r.credit) || 0 }));

            let transactions = [];
            let dIdx = 0, cIdx = 0;

            while (dIdx < drs.length && cIdx < crs.length) {
                let d = drs[dIdx];
                let c = crs[cIdx];
                let amount = Math.min(d.remaining, c.remaining);

                if (amount > 0) {
                    // Fetch Ledger Groups to determine Normal Balance
                    const dLedger = await prisma.ledger.findUnique({ where: { id: d.accountId }, include: { accountgroup: true } });
                    const cLedger = await prisma.ledger.findUnique({ where: { id: c.accountId }, include: { accountgroup: true } });

                    // Helper to get change
                    // Asset/Expense: Dr (+) Cr (-)
                    // Liab/Equity/Income: Dr (-) Cr (+)
                    const isDrNormal = (type) => ['ASSETS', 'EXPENSES'].includes(type);

                    // Update Debit Ledger (It is being Debited)
                    // If DrNormal: Inc. If CrNormal: Dec.
                    let drChange = isDrNormal(dLedger.accountgroup.type) ? amount : -amount;
                    await prisma.ledger.update({ where: { id: d.accountId }, data: { currentBalance: { increment: drChange } } });

                    // Update Credit Ledger (It is being Credited)
                    // If DrNormal: Dec. If CrNormal: Inc.
                    let crChange = isDrNormal(cLedger.accountgroup.type) ? -amount : amount;
                    await prisma.ledger.update({ where: { id: c.accountId }, data: { currentBalance: { increment: crChange } } });

                    transactions.push({
                        date: date ? new Date(date) : new Date(),
                        amount: amount,
                        debitLedgerId: d.accountId,
                        creditLedgerId: c.accountId,
                        voucherType: 'JOURNAL',
                        voucherNumber,
                        narration: (d.narration || c.narration || notes || '').trim(),
                        companyId: parseInt(companyId),
                        journalEntryId: je.id
                    });
                }

                d.remaining -= amount;
                c.remaining -= amount;

                if (d.remaining < 0.01) dIdx++;
                if (c.remaining < 0.01) cIdx++;
            }

            await prisma.transaction.createMany({ data: transactions });

            // Also save to voucher table so it appears in the voucher list
            const totalDrAmount = journalRows.reduce((sum, r) => sum + (parseFloat(r.debit) || 0), 0);

            // Map journal rows to voucher items for visibility in "View Voucher" modal
            const voucherItems = await Promise.all(journalRows.map(async (row) => {
                const ledger = await prisma.ledger.findUnique({ where: { id: parseInt(row.accountId) } });
                return {
                    ledgerName: ledger?.name || 'Unknown',
                    ledgerId: parseInt(row.accountId),
                    debit: parseFloat(row.debit) || 0,
                    credit: parseFloat(row.credit) || 0,
                    narration: row.narration || '',
                    amount: (parseFloat(row.debit) || 0) + (parseFloat(row.credit) || 0) // used for legacy storage
                };
            }));

            await prisma.voucher.create({
                data: {
                    voucherNumber,
                    voucherType: 'JOURNAL',
                    date: date ? new Date(date) : new Date(),
                    companyId: parseInt(companyId),
                    notes: notes || '',
                    totalAmount: totalDrAmount,
                    subtotal: totalDrAmount,
                    logo,
                    signature,
                    voucheritem: {
                        create: voucherItems
                    }
                }
            });

            return res.status(201).json({ success: true, message: 'Journal Voucher created successfully', data: je });
        }

        if (!voucherNumber || !voucherType || !items || items.length === 0) {
            return res.status(400).json({ success: false, message: 'Please provide all required fields' });
        }

        // Calculate totals
        const subtotal = items.reduce((sum, item) => sum + (parseFloat(item.amount) || 0), 0);
        const totalAmount = subtotal;

        // Map items to voucher items with accounting fields for the view modal
        const voucherItems = items.map(item => ({
            productId: item.productId ? parseInt(item.productId) : null,
            productName: item.productName || item.name,
            ledgerName: item.productName || item.name || 'Account Detail',
            description: item.description,
            quantity: parseFloat(item.quantity) || 1,
            rate: parseFloat(item.rate) || 0,
            amount: parseFloat(item.amount) || 0,
            debit: voucherType.toUpperCase() === 'EXPENSE' ? parseFloat(item.amount) : 0,
            credit: voucherType.toUpperCase() === 'INCOME' ? parseFloat(item.amount) : 0,
            narration: item.description || ''
        }));

        const voucher = await prisma.voucher.create({
            data: {
                voucherNumber,
                voucherType: voucherType.toUpperCase(),
                date: date ? new Date(date) : new Date(),
                companyId: parseInt(companyId),
                companyName,
                logo,
                paidFromLedgerId: paidFromLedgerId ? parseInt(paidFromLedgerId) : null,
                paidToLedgerId: paidToLedgerId ? parseInt(paidToLedgerId) : null,
                paidFromAccount,
                paidToParty,
                vendorId: vendorId ? parseInt(vendorId) : null,
                customerId: customerId ? parseInt(customerId) : null,
                subtotal,
                totalAmount,
                notes,
                signature,
                voucheritem: {
                    create: voucherItems
                }
            },
            include: {
                voucheritem: {
                    include: {
                        product: true
                    }
                },
                vendor: true,
                customer: true,
                paidFromLedger: true,
                paidToLedger: true
            }
        });

        // --- ACCOUNTING INTEGRATION ---
        if (parseFloat(totalAmount) > 0) {
            let debitLedgerId = null;
            let creditLedgerId = null;
            // Map generic voucher types to transaction types if possible. 
            // Assuming transaction_voucherType has PAYMENT, RECEIPT, CONTRA, JOURNAL
            let txnType = 'JOURNAL';

            try {
                if (voucher.voucherType === 'EXPENSE') {
                    txnType = 'PAYMENT';
                    creditLedgerId = paidFromLedgerId ? parseInt(paidFromLedgerId) : null;

                    if (vendorId) {
                        const vendor = await prisma.vendor.findUnique({ where: { id: parseInt(vendorId) } });
                        if (vendor) debitLedgerId = vendor.ledgerId;
                    } else if (customerId) {
                        const customer = await prisma.customer.findUnique({ where: { id: parseInt(customerId) } });
                        if (customer) debitLedgerId = customer.ledgerId;
                    } else if (paidToLedgerId) {
                        debitLedgerId = parseInt(paidToLedgerId);
                    }

                } else if (voucher.voucherType === 'INCOME') {
                    txnType = 'RECEIPT';
                    debitLedgerId = paidFromLedgerId ? parseInt(paidFromLedgerId) : null;

                    if (customerId) {
                        const customer = await prisma.customer.findUnique({ where: { id: parseInt(customerId) } });
                        if (customer) creditLedgerId = customer.ledgerId;
                    } else if (vendorId) {
                        const vendor = await prisma.vendor.findUnique({ where: { id: parseInt(vendorId) } });
                        if (vendor) creditLedgerId = vendor.ledgerId;
                    } else if (paidToLedgerId) {
                        creditLedgerId = parseInt(paidToLedgerId);
                    }
                } else if (voucher.voucherType === 'CONTRA') {
                    txnType = 'CONTRA';
                    creditLedgerId = paidFromLedgerId ? parseInt(paidFromLedgerId) : null;
                    debitLedgerId = paidToLedgerId ? parseInt(paidToLedgerId) : null;
                }

                if (debitLedgerId && creditLedgerId) {
                    // Update Ledgers (Debit + / Credit -)
                    await prisma.ledger.update({
                        where: { id: parseInt(debitLedgerId) },
                        data: { currentBalance: { increment: parseFloat(totalAmount) } }
                    });
                    await prisma.ledger.update({
                        where: { id: parseInt(creditLedgerId) },
                        data: { currentBalance: { decrement: parseFloat(totalAmount) } }
                    });

                    // Create Transaction
                    await prisma.transaction.create({
                        data: {
                            date: date ? new Date(date) : new Date(),
                            amount: parseFloat(totalAmount),
                            debitLedgerId: parseInt(debitLedgerId),
                            creditLedgerId: parseInt(creditLedgerId),
                            voucherType: txnType,
                            voucherNumber: voucherNumber,
                            narration: notes || `${voucherType} Voucher ${voucherNumber}`,
                            companyId: parseInt(companyId)
                        }
                    });
                }
            } catch (accError) {
                console.error('Accounting Integration Error:', accError);
                // We don't block the response, just log the error. 
                // In production, you might want to rollback the voucher creation.
            }
        }

        res.status(201).json({ success: true, data: voucher });
    } catch (error) {
        console.error('Create Voucher Error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
};

// Get All Vouchers
const getVouchers = async (req, res) => {
    try {
        const companyId = req.user?.companyId || req.query.companyId;
        const { voucherType, startDate, endDate } = req.query;

        const where = { companyId: parseInt(companyId) };

        if (voucherType) {
            where.voucherType = voucherType.toUpperCase();
        }

        if (startDate && endDate) {
            where.date = {
                gte: new Date(startDate),
                lte: new Date(endDate)
            };
        }

        const vouchers = await prisma.voucher.findMany({
            where,
            include: {
                voucheritem: {
                    include: {
                        product: true
                    }
                },
                vendor: true,
                customer: true,
                paidFromLedger: true,
                paidToLedger: true
            },
            orderBy: { createdAt: 'desc' }
        });

        res.status(200).json({ success: true, data: vouchers });
    } catch (error) {
        console.error('Get Vouchers Error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
};

// Get Voucher by ID
const getVoucherById = async (req, res) => {
    try {
        const { id } = req.params;
        const companyId = req.user?.companyId || req.query.companyId;

        const voucher = await prisma.voucher.findFirst({
            where: {
                id: parseInt(id),
                companyId: parseInt(companyId)
            },
            include: {
                voucheritem: {
                    include: {
                        product: true
                    }
                },
                vendor: true,
                customer: true,
                paidFromLedger: true,
                paidToLedger: true
            }
        });

        if (!voucher) {
            return res.status(404).json({ success: false, message: 'Voucher not found' });
        }

        res.status(200).json({ success: true, data: voucher });
    } catch (error) {
        console.error('Get Voucher By ID Error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
};

// Update Voucher
const updateVoucher = async (req, res) => {
    try {
        const { id } = req.params;
        const {
            voucherNumber,
            voucherType,
            date,
            companyName,
            logo,
            paidFromLedgerId,
            paidToLedgerId,
            paidFromAccount,
            paidToParty,
            vendorId,
            customerId,
            items,
            notes,
            signature
        } = req.body;

        const companyId = req.user.companyId;

        const existingVoucher = await prisma.voucher.findFirst({
            where: { id: parseInt(id), companyId: parseInt(companyId) }
        });

        if (!existingVoucher) {
            return res.status(404).json({ success: false, message: 'Voucher not found' });
        }

        // Calculate totals
        const subtotal = items.reduce((sum, item) => sum + (parseFloat(item.amount) || 0), 0);
        const totalAmount = subtotal;

        // Delete old items
        await prisma.voucheritem.deleteMany({
            where: { voucherId: parseInt(id) }
        });

        // Use the same item mapping logic as 'create' for consistency
        const voucherItems = items.map(item => ({
            productId: item.productId ? parseInt(item.productId) : null,
            productName: item.productName || item.name,
            ledgerName: item.ledgerName || item.productName || item.name || 'Account Detail',
            description: item.description,
            quantity: parseFloat(item.quantity) || 1,
            rate: parseFloat(item.rate) || 0,
            amount: parseFloat(item.amount) || 0,
            debit: item.debit || (voucherType?.toUpperCase() === 'EXPENSE' ? parseFloat(item.amount) : 0),
            credit: item.credit || (voucherType?.toUpperCase() === 'INCOME' ? parseFloat(item.amount) : 0),
            narration: item.narration || item.description || ''
        }));

        const updatedVoucher = await prisma.voucher.update({
            where: { id: parseInt(id) },
            data: {
                voucherNumber,
                voucherType: voucherType ? voucherType.toUpperCase() : undefined,
                date: date ? new Date(date) : undefined,
                companyName,
                logo,
                paidFromLedgerId: paidFromLedgerId ? parseInt(paidFromLedgerId) : null,
                paidToLedgerId: paidToLedgerId ? parseInt(paidToLedgerId) : null,
                paidFromAccount,
                paidToParty,
                vendorId: vendorId ? parseInt(vendorId) : null,
                customerId: customerId ? parseInt(customerId) : null,
                subtotal,
                totalAmount,
                notes,
                signature,
                voucheritem: {
                    create: voucherItems
                }
            },
            include: {
                voucheritem: {
                    include: {
                        product: true
                    }
                },
                vendor: true,
                customer: true,
                paidFromLedger: true,
                paidToLedger: true
            }
        });

        res.status(200).json({ success: true, data: updatedVoucher });
    } catch (error) {
        console.error('Update Voucher Error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
};

// Delete Voucher
const deleteVoucher = async (req, res) => {
    try {
        const { id } = req.params;
        const companyId = req.user.companyId;

        const voucher = await prisma.voucher.findFirst({
            where: { id: parseInt(id), companyId: parseInt(companyId) },
            include: { voucheritem: true }
        });

        if (!voucher) {
            return res.status(404).json({ success: false, message: 'Voucher not found' });
        }

        await prisma.$transaction(async (tx) => {
            // 1. Revert Accounting Entries if it was a Journal or other financial voucher
            // Journal entries are linked via transactions sharing the same voucherNumber and companyId
            const txs = await tx.transaction.findMany({
                where: {
                    companyId: parseInt(companyId),
                    voucherNumber: voucher.voucherNumber,
                    voucherType: { in: ['JOURNAL', 'PAYMENT', 'RECEIPT', 'CONTRA'] }
                }
            });

            for (const t of txs) {
                // Reverse balances based on the same logic as creation
                // Debit side (Decrement because it was Incremented)
                await tx.ledger.update({
                    where: { id: t.debitLedgerId },
                    data: { currentBalance: { decrement: t.amount } }
                });
                // Credit side (Increment because it was Decremented)
                await tx.ledger.update({
                    where: { id: t.creditLedgerId },
                    data: { currentBalance: { increment: t.amount } }
                });
            }

            // 2. Delete Transactions and associated Journal Entries
            const journalEntryIds = [...new Set(txs.map(t => t.journalEntryId).filter(Boolean))];
            await tx.transaction.deleteMany({
                where: {
                    companyId: parseInt(companyId),
                    voucherNumber: voucher.voucherNumber,
                    voucherType: { in: ['JOURNAL', 'PAYMENT', 'RECEIPT', 'CONTRA'] }
                }
            });

            if (journalEntryIds.length > 0) {
                await tx.journalentry.deleteMany({
                    where: { id: { in: journalEntryIds } }
                });
            }

            // 3. Delete Voucher Items and Voucher
            await tx.voucheritem.deleteMany({ where: { voucherId: voucher.id } });
            await tx.voucher.delete({ where: { id: voucher.id } });
        });

        res.status(200).json({ success: true, message: 'Voucher deleted successfully' });
    } catch (error) {
        console.error('Delete Voucher Error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
};

module.exports = {
    createVoucher,
    getVouchers,
    getVoucherById,
    updateVoucher,
    deleteVoucher
};
