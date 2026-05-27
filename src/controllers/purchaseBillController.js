const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const {
    getInventoryConfig,
    recordStockIn,
    reverseStockIn,
    calculateNetRate
} = require('../services/inventoryValuationService');

// Create Purchase Bill (Financial Posting)
const createBill = async (req, res) => {
    try {
        const { billNumber, date, dueDate, vendorId, purchaseOrderId, grnId, items, notes, discountAmount, taxAmount, totalAmount, billingName, billingAddress, billingCity, billingState, billingZipCode, billingCountry, shippingName, shippingAddress, shippingCity, shippingState, shippingZipCode, shippingCountry, overallDiscount, overallDiscountType, currency, exchangeRate } = req.body;
        const companyId = req.user?.companyId || req.query.companyId || req.body.companyId;

        const docCurrency = currency || 'USD';
        const docExchangeRate = parseFloat(exchangeRate) || 1.0;

        if (!billNumber || !vendorId || !items || items.length === 0) {
            return res.status(400).json({ success: false, message: 'Please provide all required fields' });
        }

        // Check if Purchase Bill with this number already exists
        const existingBill = await prisma.purchasebill.findFirst({
            where: {
                companyId: parseInt(companyId),
                billNumber: billNumber
            }
        });

        if (existingBill) {
            return res.status(400).json({
                success: false,
                message: `Purchase Bill with number '${billNumber}' already exists. Please use a unique bill number.`
            });
        }

        // Check if Journal Entry / Voucher Number is already in use
        const existingJournal = await prisma.journalentry.findFirst({
            where: {
                companyId: parseInt(companyId),
                voucherNumber: billNumber
            }
        });

        if (existingJournal) {
            return res.status(400).json({
                success: false,
                message: `Voucher Number '${billNumber}' is already in use by another transaction (e.g. Sales Invoice or POS Invoice). Please use a unique bill number.`
            });
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
                    currency: docCurrency,
                    exchangeRate: docExchangeRate,
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
            const discountReceivedLedger = await resolveLedger('Discount Received on Purchase', 'INCOME') || await resolveLedger('Discount Received', 'INCOME');

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
            
            const ledgerProductAmount = totalProductAmount * docExchangeRate;
            const ledgerServiceAmount = totalServiceAmount * docExchangeRate;
            const ledgerTaxAmount = parseFloat(taxAmount || 0) * docExchangeRate;
            const ledgerDiscountAmount = parseFloat(discountAmount || 0) * docExchangeRate;
            const ledgerTotalAmount = parseFloat(totalAmount || 0) * docExchangeRate;

            // Entry for Products (Debit Inventory)
            if (totalProductAmount > 0 && inventoryLedger) {
                await tx.transaction.create({
                    data: {
                        date: new Date(date),
                        amount: ledgerProductAmount,
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
                await tx.ledger.update({ where: { id: inventoryLedger.id }, data: { currentBalance: { increment: ledgerProductAmount } } });
                
                // Update Physical Stock AND Inventory Valuation Layers
                if (!grnId) {
                    // Get inventory valuation method
                    const invConfig = await getInventoryConfig(companyId);
                    const valuationMethod = invConfig.valuationMethod || 'WAC';

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

                            // Calculate net rate after line discount
                            const netRate = calculateNetRate(item.rate, item.quantity, item.discount * item.quantity);

                            // Record inventory valuation layer (FIFO or WAC)
                            await recordStockIn(tx, {
                                companyId,
                                productId: item.productId,
                                warehouseId: item.warehouseId,
                                quantity: item.quantity,
                                rate: netRate,
                                purchaseBillId: bill.id,
                                method: valuationMethod
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
                        amount: ledgerServiceAmount,
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
                await tx.ledger.update({ where: { id: finalPurchaseLedger.id }, data: { currentBalance: { increment: ledgerServiceAmount } } });
            }

            // Handle Tax if applicable (Debit Tax Input, Credit Vendor)
            if (parseFloat(taxAmount) > 0) {
                const taxInputLedger = await resolveLedger('Tax', 'ASSETS') || await resolveLedger('Tax', 'LIABILITIES');
                if (taxInputLedger) {
                    await tx.transaction.create({
                        data: {
                            date: new Date(date),
                            amount: ledgerTaxAmount,
                            debitLedgerId: taxInputLedger.id,
                            creditLedgerId: creditLedgerId,
                            voucherType: 'PURCHASE',
                            voucherNumber: billNumber,
                            companyId: parseInt(companyId),
                            journalEntryId: journalEntry.id,
                            purchaseBillId: bill.id,
                            narration: 'Tax on Purchase'
                        }
                    });
                    await tx.ledger.update({ where: { id: taxInputLedger.id }, data: { currentBalance: { increment: ledgerTaxAmount } } });
                }
            }

            // Handle Discount Received if applicable (Debit Vendor, Credit Discount Received)
            if (parseFloat(discountAmount) > 0 && discountReceivedLedger) {
                await tx.transaction.create({
                    data: {
                        date: new Date(date),
                        amount: ledgerDiscountAmount,
                        debitLedgerId: creditLedgerId, // Vendor (reduces liability with debit)
                        creditLedgerId: discountReceivedLedger.id, // Discount Received (increases income with credit)
                        voucherType: 'PURCHASE',
                        voucherNumber: billNumber,
                        companyId: parseInt(companyId),
                        journalEntryId: journalEntry.id,
                        purchaseBillId: bill.id,
                        narration: 'Discount Received on Purchase'
                    }
                });
                await tx.ledger.update({ where: { id: discountReceivedLedger.id }, data: { currentBalance: { increment: ledgerDiscountAmount } } });
            }

            // Update Vendor Balance (Credit increases Liability)
            await tx.vendor.update({
                where: { id: parseInt(vendorId) },
                data: { accountBalance: { increment: ledgerTotalAmount } }
            });
            await tx.ledger.update({
                where: { id: creditLedgerId },
                data: { currentBalance: { increment: ledgerTotalAmount } }
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
            include: {
                transactions: true,
                vendor: { include: { ledger: true } }
            }
        });

        if (!bill) return res.status(404).json({ success: false, message: 'Bill not found' });

        await prisma.$transaction(async (tx) => {
            // 1. Revert Ledger Balances using transactions
            const vendorLedgerId = bill.vendor?.ledger?.id;
            for (const trans of bill.transactions) {
                if (vendorLedgerId && trans.debitLedgerId === vendorLedgerId) {
                    // Discount received transaction: Dr Vendor (decreased Vendor liability), Cr Discount (increased Discount income)
                    // Reversion: Cr Vendor (increment Vendor ledger), Dr Discount (decrement Discount ledger)
                    await tx.ledger.update({
                        where: { id: trans.debitLedgerId },
                        data: { currentBalance: { increment: trans.amount } }
                    });
                    await tx.ledger.update({
                        where: { id: trans.creditLedgerId },
                        data: { currentBalance: { decrement: trans.amount } }
                    });
                } else {
                    // Standard debit trans (Dr Inventory/Expense/Tax, Cr Vendor)
                    // Reversion: decrement both
                    await tx.ledger.update({
                        where: { id: trans.debitLedgerId },
                        data: { currentBalance: { decrement: trans.amount } }
                    });
                    await tx.ledger.update({
                        where: { id: trans.creditLedgerId },
                        data: { currentBalance: { decrement: trans.amount } }
                    });
                }
            }

            // Retroactive tax balance decrement for older bills
            const hasTaxTrans = bill.transactions.some(t => t.narration === 'Tax on Purchase');
            if (!hasTaxTrans && parseFloat(bill.taxAmount) > 0) {
                const taxInputLedger = await tx.ledger.findFirst({
                    where: { companyId: parseInt(companyId), name: { contains: 'Tax' } }
                });
                if (taxInputLedger) {
                    await tx.ledger.update({
                        where: { id: taxInputLedger.id },
                        data: { currentBalance: { decrement: parseFloat(bill.taxAmount) } }
                    });
                }
            }

            // 2. Revert Vendor Balance
            await tx.vendor.update({
                where: { id: bill.vendorId },
                data: { accountBalance: { decrement: bill.totalAmount * (bill.exchangeRate || 1.0) } }
            });

            // 3. Delete related transactions and journal entries
            const journalEntryIds = [...new Set(bill.transactions.map(t => t.journalEntryId).filter(Boolean))];

            await tx.transaction.deleteMany({ where: { purchaseBillId: bill.id } });
            await tx.journalentry.deleteMany({ where: { id: { in: journalEntryIds } } });

            // Also delete any orphaned journal entries with same voucherNumber (permanent delete guarantee)
            await tx.journalentry.deleteMany({
                where: {
                    companyId: parseInt(companyId),
                    voucherNumber: bill.billNumber,
                    transactions: { none: {} } // only truly orphaned entries (no transactions left)
                }
            });

            // 4. Reverse Inventory Valuation Layers
            const invConfig = await getInventoryConfig(companyId);
            const valuationMethod = invConfig.valuationMethod || 'WAC';

            // Get bill items for WAC reversal
            const billItemsForReversal = await tx.purchasebillitem.findMany({
                where: { purchaseBillId: bill.id }
            });

            await reverseStockIn(tx, {
                purchaseBillId: bill.id,
                billItems: billItemsForReversal.map(i => ({
                    productId: i.productId,
                    warehouseId: i.warehouseId,
                    quantity: i.quantity,
                    rate: i.rate
                })),
                method: valuationMethod
            });

            // 5. Delete Bill Items and Bill
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
        const { notes, dueDate, items, totalAmount, taxAmount, discountAmount, billingName, billingAddress, billingCity, billingState, billingZipCode, billingCountry, shippingName, shippingAddress, shippingCity, shippingState, shippingZipCode, shippingCountry, overallDiscount, overallDiscountType, currency, exchangeRate } = req.body;
        const companyId = req.user?.companyId || req.query.companyId || req.body.companyId;

        const updated = await prisma.$transaction(async (tx) => {
            const oldBill = await tx.purchasebill.findFirst({
                where: { id: parseInt(id), companyId: parseInt(companyId) },
                include: {
                    transactions: true,
                    vendor: { include: { ledger: true } }
                }
            });
            if (!oldBill) throw new Error('Bill not found');

            // 1. Revert Old Vendor Balance
            await tx.vendor.update({
                where: { id: oldBill.vendorId },
                data: { accountBalance: { decrement: oldBill.totalAmount * (oldBill.exchangeRate || 1.0) } }
            });

            // 2. Revert Old Ledger Balances using old transactions
            const vendorLedgerId = oldBill.vendor?.ledger?.id;
            for (const trans of oldBill.transactions) {
                if (vendorLedgerId && trans.debitLedgerId === vendorLedgerId) {
                    await tx.ledger.update({
                        where: { id: trans.debitLedgerId },
                        data: { currentBalance: { increment: trans.amount } }
                    });
                    await tx.ledger.update({
                        where: { id: trans.creditLedgerId },
                        data: { currentBalance: { decrement: trans.amount } }
                    });
                } else {
                    await tx.ledger.update({
                        where: { id: trans.debitLedgerId },
                        data: { currentBalance: { decrement: trans.amount } }
                    });
                    await tx.ledger.update({
                        where: { id: trans.creditLedgerId },
                        data: { currentBalance: { decrement: trans.amount } }
                    });
                }
            }

            // Retroactive tax balance decrement for older bills
            const oldHasTaxTrans = oldBill.transactions.some(t => t.narration === 'Tax on Purchase');
            if (!oldHasTaxTrans && parseFloat(oldBill.taxAmount) > 0) {
                const taxInputLedger = await tx.ledger.findFirst({
                    where: { companyId: parseInt(companyId), name: { contains: 'Tax' } }
                });
                if (taxInputLedger) {
                    await tx.ledger.update({
                        where: { id: taxInputLedger.id },
                        data: { currentBalance: { decrement: parseFloat(oldBill.taxAmount) } }
                    });
                }
            }

            // Revert direct Vendor ledger balance for legacy bills that did not have correct transaction tracking
            const oldHasDiscountTrans = oldBill.transactions.some(t => t.narration === 'Discount Received on Purchase');
            if (!oldHasDiscountTrans || !oldHasTaxTrans) {
                const diff = parseFloat(oldBill.totalAmount) - (oldBill.transactions.reduce((sum, t) => sum + (t.creditLedgerId === vendorLedgerId ? t.amount : 0), 0) - oldBill.transactions.reduce((sum, t) => sum + (t.debitLedgerId === vendorLedgerId ? t.amount : 0), 0));
                if (vendorLedgerId && Math.abs(diff) > 0.01) {
                    await tx.ledger.update({
                        where: { id: vendorLedgerId },
                        data: { currentBalance: { decrement: diff } }
                    });
                }
            }

            // 3. Delete old transactions associated with the bill
            await tx.transaction.deleteMany({ where: { purchaseBillId: oldBill.id } });

            // 4. Delete old items and write new ones
            if (items && items.length > 0) {
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

            const finalTotalAmount = totalAmount !== undefined ? parseFloat(totalAmount) : oldBill.totalAmount;
            const finalTaxAmount = taxAmount !== undefined ? parseFloat(taxAmount) : oldBill.taxAmount;
            const finalDiscountAmount = discountAmount !== undefined ? parseFloat(discountAmount) : oldBill.discountAmount;

            // Fetch final items (either new ones or old ones if items were not provided in req.body)
            const finalBillItems = items && items.length > 0 ? items.map(item => ({
                productId: item.productId ? parseInt(item.productId) : null,
                warehouseId: item.warehouseId ? parseInt(item.warehouseId) : null,
                description: item.description,
                quantity: parseFloat(item.quantity),
                rate: parseFloat(item.rate),
                discount: parseFloat(item.discount || 0),
                taxRate: parseFloat(item.taxRate || 0),
                amount: parseFloat(item.amount)
            })) : await tx.purchasebillitem.findMany({ where: { purchaseBillId: parseInt(id) } });

            // Resolve standard accounts
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
            const discountReceivedLedger = await resolveLedger('Discount Received on Purchase', 'INCOME') || await resolveLedger('Discount Received', 'INCOME');

            // Find or Create Journal Entry
            let journalEntry = await tx.journalentry.findFirst({
                where: { voucherNumber: oldBill.billNumber, companyId: parseInt(companyId) }
            });
            if (!journalEntry) {
                journalEntry = await tx.journalentry.create({
                    data: {
                        date: new Date(oldBill.date),
                        voucherNumber: oldBill.billNumber,
                        narration: `Purchase Bill #${oldBill.billNumber}`,
                        companyId: parseInt(companyId),
                    }
                });
            }

            let totalProductAmount = 0;
            let totalServiceAmount = 0;

            for (const item of finalBillItems) {
                if (item.productId) {
                    totalProductAmount += item.amount;
                    await tx.product.update({
                        where: { id: item.productId },
                        data: { purchasePrice: item.rate }
                    });
                } else {
                    totalServiceAmount += item.amount;
                }
            }

            // Post Transactions and Update Ledgers
            const docCurrency = currency !== undefined ? currency : oldBill.currency;
            const docExchangeRate = exchangeRate !== undefined ? parseFloat(exchangeRate) : (oldBill.exchangeRate || 1.0);

            const ledgerProductAmount = totalProductAmount * docExchangeRate;
            const ledgerServiceAmount = totalServiceAmount * docExchangeRate;
            const ledgerTaxAmount = parseFloat(finalTaxAmount || 0) * docExchangeRate;
            const ledgerDiscountAmount = parseFloat(finalDiscountAmount || 0) * docExchangeRate;
            const ledgerTotalAmount = parseFloat(finalTotalAmount || 0) * docExchangeRate;

            if (totalProductAmount > 0 && inventoryLedger) {
                await tx.transaction.create({
                    data: {
                        date: new Date(oldBill.date),
                        amount: ledgerProductAmount,
                        debitLedgerId: inventoryLedger.id,
                        creditLedgerId: vendorLedgerId,
                        voucherType: 'PURCHASE',
                        voucherNumber: oldBill.billNumber,
                        companyId: parseInt(companyId),
                        journalEntryId: journalEntry.id,
                        purchaseBillId: oldBill.id,
                        narration: 'Product Inventory Purchase'
                    }
                });
                await tx.ledger.update({ where: { id: inventoryLedger.id }, data: { currentBalance: { increment: ledgerProductAmount } } });
            }

            const finalPurchaseLedger = purchaseLedger || inventoryLedger;
            if (totalServiceAmount > 0 && finalPurchaseLedger) {
                await tx.transaction.create({
                    data: {
                        date: new Date(oldBill.date),
                        amount: ledgerServiceAmount,
                        debitLedgerId: finalPurchaseLedger.id,
                        creditLedgerId: vendorLedgerId,
                        voucherType: 'PURCHASE',
                        voucherNumber: oldBill.billNumber,
                        companyId: parseInt(companyId),
                        journalEntryId: journalEntry.id,
                        purchaseBillId: oldBill.id,
                        narration: 'Service/General Purchase'
                    }
                });
                await tx.ledger.update({ where: { id: finalPurchaseLedger.id }, data: { currentBalance: { increment: ledgerServiceAmount } } });
            }

            if (parseFloat(finalTaxAmount) > 0) {
                const taxInputLedger = await resolveLedger('Tax', 'ASSETS') || await resolveLedger('Tax', 'LIABILITIES');
                if (taxInputLedger) {
                    await tx.transaction.create({
                        data: {
                            date: new Date(oldBill.date),
                            amount: ledgerTaxAmount,
                            debitLedgerId: taxInputLedger.id,
                            creditLedgerId: vendorLedgerId,
                            voucherType: 'PURCHASE',
                            voucherNumber: oldBill.billNumber,
                            companyId: parseInt(companyId),
                            journalEntryId: journalEntry.id,
                            purchaseBillId: oldBill.id,
                            narration: 'Tax on Purchase'
                        }
                    });
                    await tx.ledger.update({ where: { id: taxInputLedger.id }, data: { currentBalance: { increment: ledgerTaxAmount } } });
                }
            }

            if (parseFloat(finalDiscountAmount) > 0 && discountReceivedLedger) {
                await tx.transaction.create({
                    data: {
                        date: new Date(oldBill.date),
                        amount: ledgerDiscountAmount,
                        debitLedgerId: vendorLedgerId,
                        creditLedgerId: discountReceivedLedger.id,
                        voucherType: 'PURCHASE',
                        voucherNumber: oldBill.billNumber,
                        companyId: parseInt(companyId),
                        journalEntryId: journalEntry.id,
                        purchaseBillId: oldBill.id,
                        narration: 'Discount Received on Purchase'
                    }
                });
                await tx.ledger.update({ where: { id: discountReceivedLedger.id }, data: { currentBalance: { increment: ledgerDiscountAmount } } });
            }

            // Update Vendor Balance (Credit increases Liability)
            await tx.vendor.update({
                where: { id: oldBill.vendorId },
                data: { accountBalance: { increment: ledgerTotalAmount } }
            });
            await tx.ledger.update({
                where: { id: vendorLedgerId },
                data: { currentBalance: { increment: ledgerTotalAmount } }
            });

            // Finally update the purchasebill itself
            return await tx.purchasebill.update({
                where: { id: parseInt(id), companyId: parseInt(companyId) },
                data: {
                    notes,
                    dueDate: dueDate ? new Date(dueDate) : undefined,
                    totalAmount: totalAmount ? parseFloat(totalAmount) : undefined,
                    taxAmount: taxAmount ? parseFloat(taxAmount) : undefined,
                    discountAmount: discountAmount ? parseFloat(discountAmount) : undefined,
                    balanceAmount: totalAmount ? parseFloat(totalAmount) : undefined,
                    currency: currency !== undefined ? currency : undefined,
                    exchangeRate: exchangeRate !== undefined ? parseFloat(exchangeRate) : undefined,
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

        const cid = parseInt(companyId);

        // Scan ALL existing purchase bills with PB- prefix
        const allBills = await prisma.purchasebill.findMany({
            where: { companyId: cid, billNumber: { startsWith: 'PB-' } },
            select: { billNumber: true }
        });

        // Scan ALL journal entries with PB- prefix voucher numbers (catches soft-deleted bills)
        const allJournals = await prisma.journalentry.findMany({
            where: { companyId: cid, voucherNumber: { startsWith: 'PB-' } },
            select: { voucherNumber: true }
        });

        // Extract max numeric suffix from both sources
        let maxNum = 100; // Start from PB-101
        for (const b of allBills) {
            const numStr = (b.billNumber || '').replace(/^PB-/, '');
            const num = parseInt(numStr);
            if (!isNaN(num) && num > maxNum) maxNum = num;
        }
        for (const j of allJournals) {
            const numStr = (j.voucherNumber || '').replace(/^PB-/, '');
            const num = parseInt(numStr);
            if (!isNaN(num) && num > maxNum) maxNum = num;
        }

        const nextNumber = `PB-${maxNum + 1}`;
        res.status(200).json({ success: true, nextNumber });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

// One-time cleanup: remove orphaned journal entries (no linked transactions)
// These are left behind from bills that were deleted before the fix was applied
const cleanupOrphanedJournals = async (req, res) => {
    try {
        const companyId = req.user?.companyId || req.query.companyId;
        const whereClause = {
            transactions: { none: {} }
        };
        if (companyId) {
            whereClause.companyId = parseInt(companyId);
        }

        // Find orphaned journal entries first (for reporting)
        const orphaned = await prisma.journalentry.findMany({
            where: whereClause,
            select: { id: true, voucherNumber: true, narration: true }
        });

        if (orphaned.length === 0) {
            return res.status(200).json({
                success: true,
                message: 'No orphaned journal entries found. Database is already clean!',
                deletedCount: 0
            });
        }

        // Delete them all
        const result = await prisma.journalentry.deleteMany({ where: whereClause });

        return res.status(200).json({
            success: true,
            message: `Cleaned up ${result.count} orphaned journal entries. You can now create bills without voucher number conflicts.`,
            deletedCount: result.count,
            deleted: orphaned.map(j => ({ id: j.id, voucherNumber: j.voucherNumber }))
        });
    } catch (error) {
        console.error('Cleanup Error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
};

module.exports = {
    createBill,
    getBills,
    getBillById,
    updateBill,
    deleteBill,
    getNextNumber,
    cleanupOrphanedJournals
};
