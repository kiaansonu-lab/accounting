const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

// Create Purchase Bill (Financial Posting)
const createBill = async (req, res) => {
    try {
        const { billNumber, date, dueDate, vendorId, purchaseOrderId, grnId, items, notes, discountAmount, taxAmount, totalAmount, billingName, billingAddress, billingCity, billingState, billingZipCode, billingCountry, shippingName, shippingAddress, shippingCity, shippingState, shippingZipCode, shippingCountry, overallDiscount, overallDiscountType } = req.body;
        const companyId = req.user?.companyId || req.query.companyId || req.body.companyId;

        if (!billNumber || !vendorId || !items || items.length === 0) {
            return res.status(400).json({ success: false, message: 'Please provide all required fields' });
        }

        const billItems = items.map(item => ({
            productId: item.productId ? parseInt(item.productId) : null,
            warehouseId: item.warehouseId ? parseInt(item.warehouseId) : null,
            description: item.description,
            quantity: parseFloat(item.quantity),
            rate: parseFloat(item.rate),
            discount: parseFloat(item.discount || 0),
            taxRate: parseFloat(item.taxRate || 0),
            amount: parseFloat(item.amount)
        }));

        const result = await prisma.$transaction(async (tx) => {
            // 1. Create Purchase Bill
            const bill = await tx.purchasebill.create({
                data: {
                    billNumber,
                    date: new Date(date),
                    dueDate: dueDate ? new Date(dueDate) : null,
                    vendorId: parseInt(vendorId),
                    purchaseOrderId: purchaseOrderId ? parseInt(purchaseOrderId) : null,
                    grnId: grnId ? parseInt(grnId) : null,
                    companyId: parseInt(companyId),
                    subtotal: parseFloat(totalAmount) - parseFloat(taxAmount) + parseFloat(discountAmount), // Approx
                    discountAmount: parseFloat(discountAmount),
                    taxAmount: parseFloat(taxAmount),
                    totalAmount: parseFloat(totalAmount),
                    balanceAmount: parseFloat(totalAmount),
                    status: 'UNPAID',
                    notes,
                    billingName,
                    billingAddress,
                    billingCity,
                    billingState,
                    billingZipCode,
                    billingCountry,
                    shippingName,
                    shippingAddress,
                    shippingCity,
                    shippingState,
                    shippingZipCode,
                    shippingCountry,
                    overallDiscount: overallDiscount ? parseFloat(overallDiscount) : 0,
                    overallDiscountType: overallDiscountType || 'percentage',
                    purchasebillitem: {
                        create: billItems
                    }
                },
                include: { purchasebillitem: true }
            });

            // Update linked PO status if exists
            if (purchaseOrderId) {
                await tx.purchaseorder.update({
                    where: { id: parseInt(purchaseOrderId) },
                    data: { status: 'COMPLETED' }
                });
            }

            // Update linked GRN status if exists
            if (grnId) {
                await tx.goodsreceiptnote.update({
                    where: { id: parseInt(grnId) },
                    data: { status: 'Invoiced' }
                });
            }

            // 2. Ledger Posting (Dr Inventory/Purchase, Cr Vendor)
            const vendor = await tx.vendor.findUnique({ where: { id: parseInt(vendorId) }, include: { ledger: true } });
            if (!vendor || !vendor.ledger) throw new Error('Vendor ledger not found. Please link a ledger to this vendor first.');

            // Helper to resolve ledgers (Auto-create if missing)
            const resolveLedger = async (namePattern, type) => {
                let ledger = await tx.ledger.findFirst({
                    where: { companyId: parseInt(companyId), name: { contains: namePattern } }
                });
                if (!ledger) {
                    const group = await tx.accountgroup.findFirst({ where: { companyId: parseInt(companyId), type: type } });
                    if (group) {
                        ledger = await tx.ledger.create({
                            data: {
                                name: namePattern,
                                groupId: group.id,
                                companyId: parseInt(companyId),
                                isControlAccount: true
                            }
                        });
                    }
                }
                return ledger;
            };


            const inventoryLedger = await resolveLedger('Inventory Asset', 'ASSETS') || await resolveLedger('Inventory', 'ASSETS');
            const purchaseLedger = await resolveLedger('Purchases', 'EXPENSES') || await resolveLedger('Purchase', 'EXPENSES');

            // 3. Create Journal Entry
            const journalEntry = await tx.journalentry.create({
                data: {
                    date: new Date(date),
                    voucherNumber: billNumber,
                    narration: `Purchase Bill #${billNumber}`,
                    companyId: parseInt(companyId),
                }
            });

            // 4. Process Items for Accounting and Price Updates
            let totalProductAmount = 0;
            let totalServiceAmount = 0;

            for (const item of billItems) {
                if (item.productId) {
                    totalProductAmount += item.amount;
                    // Update Product Purchase Price
                    await tx.product.update({
                        where: { id: item.productId },
                        data: { purchasePrice: item.rate }
                    });
                } else {
                    totalServiceAmount += item.amount;
                }
            }

            // 5. DR Inventory / Purchases, CR Vendor
            const creditLedgerId = vendor.ledger.id;

            // Entry for Products (Debit Inventory)
            if (totalProductAmount > 0 && inventoryLedger) {
                await tx.transaction.create({
                    data: {
                        date: new Date(date),
                        amount: totalProductAmount,
                        debitLedgerId: inventoryLedger.id,
                        creditLedgerId: creditLedgerId,
                        voucherType: 'PURCHASE',
                        voucherNumber: billNumber,
                        companyId: parseInt(companyId),
                        journalEntryId: journalEntry.id,
                        purchaseBillId: bill.id,
                        narration: 'Product Inventory Purchase'
                    }
                });
                await tx.ledger.update({ where: { id: inventoryLedger.id }, data: { currentBalance: { increment: totalProductAmount } } });
                
                // NEW: Update Physical Stock if no GRN was linked
                if (!grnId) {
                    for (const item of billItems) {
                        if (item.productId && item.warehouseId) {
                            await tx.stock.upsert({
                                where: { warehouseId_productId: { warehouseId: item.warehouseId, productId: item.productId } },
                                update: { quantity: { increment: item.quantity } },
                                create: { warehouseId: item.warehouseId, productId: item.productId, quantity: item.quantity }
                            });

                            await tx.inventorytransaction.create({
                                data: {
                                    date: new Date(date),
                                    type: 'PURCHASE',
                                    productId: item.productId,
                                    toWarehouseId: item.warehouseId,
                                    quantity: item.quantity,
                                    reason: `Direct Purchase Bill: ${billNumber}`,
                                    companyId: parseInt(companyId)
                                }
                            });
                        }
                    }
                }
            }


            // Entry for Services/Others (Debit Purchases Expense)
            const finalPurchaseLedger = purchaseLedger || inventoryLedger; // Fallback
            if (totalServiceAmount > 0 && finalPurchaseLedger) {
                await tx.transaction.create({
                    data: {
                        date: new Date(date),
                        amount: totalServiceAmount,
                        debitLedgerId: finalPurchaseLedger.id,
                        creditLedgerId: creditLedgerId,
                        voucherType: 'PURCHASE',
                        voucherNumber: billNumber,
                        companyId: parseInt(companyId),
                        journalEntryId: journalEntry.id,
                        purchaseBillId: bill.id,
                        narration: 'Service/General Purchase'
                    }
                });
                await tx.ledger.update({ where: { id: finalPurchaseLedger.id }, data: { currentBalance: { increment: totalServiceAmount } } });
            }

            // Handle Tax if applicable (Debit Tax Input)
            if (parseFloat(taxAmount) > 0) {
                const taxInputLedger = await resolveLedger('Tax', 'ASSETS') || await resolveLedger('Tax', 'LIABILITIES');
                if (taxInputLedger) {
                    await tx.ledger.update({ where: { id: taxInputLedger.id }, data: { currentBalance: { increment: parseFloat(taxAmount) } } });
                }
            }

            // Update Vendor Balance (Credit increases Liability)
            await tx.vendor.update({
                where: { id: parseInt(vendorId) },
                data: { accountBalance: { increment: parseFloat(totalAmount) } }
            });
            await tx.ledger.update({
                where: { id: creditLedgerId },
                data: { currentBalance: { increment: parseFloat(totalAmount) } }
            });


            return bill;
        }, {
            timeout: 30000
        });

        res.status(201).json({ success: true, data: result });
    } catch (error) {
        console.error('Create Purchase Bill Error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
};

const getBills = async (req, res) => {
    try {
        const companyId = req.user?.companyId || req.query.companyId;
        const bills = await prisma.purchasebill.findMany({
            where: { companyId: parseInt(companyId) },
            include: {
                vendor: true,
                purchasebillitem: {
                    include: {
                        product: true,
                        warehouse: true
                    }
                },
                purchaseorder: true,
                goodsreceiptnote: true,
                purchasereturn: true
            },
            orderBy: { createdAt: 'desc' }
        });
        res.status(200).json({ success: true, data: bills });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

const getBillById = async (req, res) => {
    try {
        const { id } = req.params;
        const companyId = req.user?.companyId || req.query.companyId;
        const bill = await prisma.purchasebill.findFirst({
            where: { id: parseInt(id), companyId: parseInt(companyId) },
            include: {
                vendor: true,
                purchasebillitem: {
                    include: {
                        product: true,
                        warehouse: true
                    }
                },
                purchaseorder: true,
                goodsreceiptnote: true,
                payment: true
            }
        });
        if (!bill) return res.status(404).json({ success: false, message: 'Bill not found' });
        res.status(200).json({ success: true, data: bill });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

const deleteBill = async (req, res) => {
    try {
        const { id } = req.params;
        const companyId = req.user?.companyId || req.query.companyId;

        const bill = await prisma.purchasebill.findFirst({
            where: { id: parseInt(id), companyId: parseInt(companyId) },
            include: { transactions: true }
        });

        if (!bill) return res.status(404).json({ success: false, message: 'Bill not found' });

        await prisma.$transaction(async (tx) => {
            // 1. Revert Ledger Balances using transactions
            for (const trans of bill.transactions) {
                await tx.ledger.update({
                    where: { id: trans.debitLedgerId },
                    data: { currentBalance: { decrement: trans.amount } }
                });
                await tx.ledger.update({
                    where: { id: trans.creditLedgerId },
                    data: { currentBalance: { decrement: trans.amount } }
                });
            }

            // 2. Revert Vendor Balance
            await tx.vendor.update({
                where: { id: bill.vendorId },
                data: { accountBalance: { decrement: bill.totalAmount } }
            });

            // 3. Delete related transactions and journal entries
            const journalEntryIds = [...new Set(bill.transactions.map(t => t.journalEntryId).filter(Boolean))];

            await tx.transaction.deleteMany({ where: { purchaseBillId: bill.id } });
            await tx.journalentry.deleteMany({ where: { id: { in: journalEntryIds } } });

            // 4. Delete Bill Items and Bill
            await tx.purchasebillitem.deleteMany({ where: { purchaseBillId: bill.id } });
            await tx.purchasebill.delete({ where: { id: bill.id } });
        }, {
            timeout: 30000
        });

        res.status(200).json({ success: true, message: 'Bill deleted successfully' });
    } catch (error) {
        console.error('Delete Bill Error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
};

const updateBill = async (req, res) => {
    try {
        const { id } = req.params;
        const { notes, dueDate, items, totalAmount, taxAmount, discountAmount, billingName, billingAddress, billingCity, billingState, billingZipCode, billingCountry, shippingName, shippingAddress, shippingCity, shippingState, shippingZipCode, shippingCountry, overallDiscount, overallDiscountType } = req.body;
        const companyId = req.user?.companyId || req.query.companyId || req.body.companyId;

        const updated = await prisma.$transaction(async (tx) => {
            // If items are provided, we should ideally handle the complexity of ledger re-balancing.
            // For now, let's update the bill and its items.

            if (items && items.length > 0) {
                // Delete old items
                await tx.purchasebillitem.deleteMany({
                    where: { purchaseBillId: parseInt(id) }
                });

                // Create new items
                const billItems = items.map(item => ({
                    productId: item.productId ? parseInt(item.productId) : null,
                    warehouseId: item.warehouseId ? parseInt(item.warehouseId) : null,
                    description: item.description,
                    quantity: parseFloat(item.quantity),
                    rate: parseFloat(item.rate),
                    discount: parseFloat(item.discount || 0),
                    taxRate: parseFloat(item.taxRate || 0),
                    amount: parseFloat(item.amount),
                    purchaseBillId: parseInt(id)
                }));

                await tx.purchasebillitem.createMany({
                    data: billItems
                });
            }

            return await tx.purchasebill.update({
                where: { id: parseInt(id), companyId: parseInt(companyId) },
                data: {
                    notes,
                    dueDate: dueDate ? new Date(dueDate) : undefined,
                    totalAmount: totalAmount ? parseFloat(totalAmount) : undefined,
                    taxAmount: taxAmount ? parseFloat(taxAmount) : undefined,
                    discountAmount: discountAmount ? parseFloat(discountAmount) : undefined,
                    // If totalAmount changed, we might need to update balanceAmount too.
                    balanceAmount: totalAmount ? parseFloat(totalAmount) : undefined,
                    billingName,
                    billingAddress,
                    billingCity,
                    billingState,
                    billingZipCode,
                    billingCountry,
                    shippingName,
                    shippingAddress,
                    shippingCity,
                    shippingState,
                    shippingZipCode,
                    shippingCountry,
                    overallDiscount: overallDiscount ? parseFloat(overallDiscount) : undefined,
                    overallDiscountType: overallDiscountType || undefined
                },
                include: {
                    purchasebillitem: {
                        include: {
                            product: true,
                            warehouse: true
                        }
                    }
                }
            });
        }, {
            timeout: 30000
        });

        res.status(200).json({ success: true, data: updated });
    } catch (error) {
        console.error('Update Purchase Bill Error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
};

const getNextNumber = async (req, res) => {
    try {
        const companyId = req.user?.companyId || req.query.companyId;
        if (!companyId) return res.status(400).json({ success: false, message: 'Company ID Missing' });

        const lastBill = await prisma.purchasebill.findFirst({
            where: { companyId: parseInt(companyId) },
            orderBy: { id: 'desc' }
        });

        let nextNumber = 'PB-101'; // Default start
        if (lastBill && lastBill.billNumber) {
            // Try to extract number
            const lastNumStr = lastBill.billNumber.replace(/\D/g, '');
            if (lastNumStr) {
                const lastNum = parseInt(lastNumStr);
                nextNumber = `PB-${lastNum + 1}`;
            }
        }

        res.status(200).json({ success: true, nextNumber });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

module.exports = {
    createBill,
    getBills,
    getBillById,
    updateBill,
    deleteBill,
    getNextNumber
};
