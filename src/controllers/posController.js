const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const { getInventoryConfig, consumeStock } = require('../services/inventoryValuationService');

// Create POS Invoice
const createPOSInvoice = async (req, res) => {
    try {
        const {
            companyId,
            customerId, // Optional (for walk-in)
            items,
            paymentMode,
            discountAmount,
            notes,
            receivedAmount, // The actual amount paid by customer
            accountId,   // Explicit ledger selection for payment (Cash/Bank)
            dueAccountId // Explicit ledger selection for the sale debit (Customer/Receivable)
        } = req.body;

        const currentCompanyId = req.user?.companyId || companyId;

        if (!currentCompanyId || !items || items.length === 0) {
            return res.status(400).json({ success: false, message: 'Invalid data provided' });
        }

        // 1. Calculate Totals
        let subtotal = 0;
        let totalTax = 0;
        const processedItems = items.map(item => {
            const qty = parseFloat(item.quantity);
            const rate = parseFloat(item.rate);
            const disc = parseFloat(item.discount || 0);
            const tax = parseFloat(item.taxRate || 0);

            const gross = qty * rate;
            const taxable = gross - disc;
            const taxAmt = (taxable * tax) / 100;
            const total = taxable + taxAmt;

            subtotal += gross;
            totalTax += taxAmt;

            return {
                ...item,
                qty, rate, disc, tax, taxAmt, total, taxable,
                uomId: item.uomId ? parseInt(item.uomId) : null
            };
        });

        const invoiceTotal = parseFloat((subtotal - (parseFloat(discountAmount) || 0) + totalTax).toFixed(2));
        const finalDiscount = parseFloat(discountAmount) || 0;
        const finalReceived = parseFloat(receivedAmount) || 0;
        const balance = parseFloat((invoiceTotal - finalReceived).toFixed(2));

        // 2. Start Transaction
        const result = await prisma.$transaction(async (tx) => {

            // A. Generate Invoice Number
            const count = await tx.posinvoice.count({ where: { companyId: parseInt(currentCompanyId) } });
            const invoiceNumber = `POS-${String(count + 1).padStart(6, '0')}`;

            // B. Find/Create Ledgers

            // Sales Ledger (Income)
            let salesLedger = await tx.ledger.findFirst({
                where: { companyId: parseInt(currentCompanyId), name: { contains: 'Sales' }, accountgroup: { type: 'INCOME' } }
            });

            if (!salesLedger) {
                let refGroup = await tx.accountgroup.findFirst({ where: { companyId: parseInt(currentCompanyId), type: 'INCOME' } });
                if (!refGroup) {
                    refGroup = await tx.accountgroup.create({
                        data: { name: 'Direct Income', type: 'INCOME', companyId: parseInt(currentCompanyId) }
                    });
                }
                salesLedger = await tx.ledger.create({
                    data: {
                        name: 'Sales Income (POS)',
                        groupId: refGroup.id,
                        companyId: parseInt(currentCompanyId)
                    }
                });
            }

            // Debit Ledger (Who owes us? / Customer Receivable)
            let debitLedgerId = dueAccountId ? parseInt(dueAccountId) : null;

            if (!debitLedgerId && customerId) {
                const customer = await tx.customer.findUnique({ where: { id: parseInt(customerId) } });
                if (customer?.ledgerId) {
                    debitLedgerId = customer.ledgerId;
                }
            }

            // If still no debitLedgerId (Walk-in), use/create a generic one
            if (!debitLedgerId) {
                let walkinLedger = await tx.ledger.findFirst({
                    where: { companyId: parseInt(currentCompanyId), name: { contains: 'Walk-in' } }
                });
                if (!walkinLedger) {
                    let assetGroup = await tx.accountgroup.findFirst({ where: { companyId: parseInt(currentCompanyId), type: 'ASSETS' } });
                    if (!assetGroup) {
                        assetGroup = await tx.accountgroup.create({
                            data: { name: 'Current Assets', type: 'ASSETS', companyId: parseInt(currentCompanyId) }
                        });
                    }
                    walkinLedger = await tx.ledger.create({
                        data: { name: 'Walk-in Customer Ledger', groupId: assetGroup.id, companyId: parseInt(currentCompanyId) }
                    });
                }
                debitLedgerId = walkinLedger.id;
            }

            // C. Create POS Invoice
            const posInvoice = await tx.posinvoice.create({
                data: {
                    invoiceNumber,
                    companyId: parseInt(currentCompanyId),
                    customerId: customerId ? parseInt(customerId) : null,
                    subtotal: subtotal,
                    discountAmount: finalDiscount,
                    taxAmount: totalTax,
                    totalAmount: invoiceTotal,
                    paidAmount: finalReceived,
                    balanceAmount: balance,
                    paymentMode: paymentMode || 'CASH',
                    status: balance <= 0 ? 'Paid' : (finalReceived > 0 ? 'Partial' : 'Due'),
                    updatedAt: new Date(),
                    notes: notes || null,
                    posinvoiceitem: {
                        create: processedItems.map(i => ({
                            productId: parseInt(i.productId),
                            warehouseId: parseInt(i.warehouseId),
                            description: i.description || 'POS Item',
                            quantity: i.qty,
                            rate: i.rate,
                            amount: parseFloat(i.total),
                            taxRate: parseFloat(i.tax),
                            uomId: i.uomId ? parseInt(i.uomId) : null,
                            updatedAt: new Date()
                        }))
                    }
                }
            });

            // D. Inventory Update & COGS Calculation
            let totalCOGS = 0;
            const invConfig = await getInventoryConfig(currentCompanyId);
            const valuationMethod = invConfig.valuationMethod || 'WAC';
            const autoCogsEntry = invConfig.autoCogsEntry !== false; // default ON
            const negativeStockAllow = invConfig.negativeStockAllow !== false; // default ON

            for (const item of processedItems) {
                const wId = parseInt(item.warehouseId);
                const pId = parseInt(item.productId);

                if (isNaN(wId) || isNaN(pId)) {
                    throw new Error(`Invalid warehouseId (${item.warehouseId}) or productId (${item.productId}) for item ${item.description || 'unknown'}`);
                }

                // Fetch Product with Base UoM
                const prod = await tx.product.findUnique({
                    where: { id: pId },
                    include: { uom: true }
                });
                const transUom = item.uomId ? await tx.uom.findUnique({ where: { id: item.uomId } }) : null;
                const baseUom = prod?.uom;

                const { convertToBaseQuantity } = require('../services/uomConversionService');
                const baseQty = convertToBaseQuantity(item.qty, transUom, baseUom);

                const stock = await tx.stock.findUnique({
                    where: { warehouseId_productId: { warehouseId: wId, productId: pId } }
                });

                if (stock) {
                    await tx.stock.update({
                        where: { id: stock.id },
                        data: { quantity: { decrement: baseQty } }
                    });
                } else {
                    await tx.stock.create({
                        data: {
                            warehouseId: wId,
                            productId: pId,
                            quantity: -baseQty,
                            updatedAt: new Date()
                        }
                    });
                }

                await tx.inventorytransaction.create({
                    data: {
                        date: new Date(),
                        type: 'SALE',
                        productId: pId,
                        fromWarehouseId: wId,
                        quantity: baseQty,
                        reason: `POS Sale: ${invoiceNumber}`,
                        companyId: parseInt(currentCompanyId),
                        updatedAt: new Date()
                    }
                });

                // Calculate and consume stock valuation for COGS using baseQty
                const itemCOGS = await consumeStock(tx, {
                    companyId: currentCompanyId,
                    productId: pId,
                    warehouseId: wId,
                    quantity: baseQty,
                    invoiceId: null, // No standard invoiceId
                    method: valuationMethod,
                    negativeStockAllow,
                    isPOS: true // Bypass inventory_consumption table due to foreign key constraints
                });
                totalCOGS += itemCOGS;
            }

            // E. Accounting Entries

            // 1. Initial Sale (Dr Customer/Walk-in, Cr Sales)
            await tx.transaction.create({
                data: {
                    date: new Date(),
                    voucherType: 'POS_INVOICE',
                    voucherNumber: invoiceNumber,
                    companyId: parseInt(currentCompanyId),
                    debitLedgerId: debitLedgerId,
                    creditLedgerId: salesLedger.id,
                    amount: invoiceTotal,
                    narration: `POS Sale generated - ${invoiceNumber}`,
                    posInvoiceId: posInvoice.id,
                    updatedAt: new Date()
                }
            });

            await tx.ledger.update({ where: { id: debitLedgerId }, data: { currentBalance: { increment: invoiceTotal } } });
            await tx.ledger.update({ where: { id: salesLedger.id }, data: { currentBalance: { increment: invoiceTotal } } });

            // 2. Receipt Entry (Recording actual payment)
            if (finalReceived > 0) {
                let receiptLedgerId = accountId ? parseInt(accountId) : null;

                if (!receiptLedgerId) {
                    // Fallback to auto-finding Cash/Bank
                    const modeName = paymentMode === 'CASH' ? 'Cash' : 'Bank';
                    let fallbackLedger = await tx.ledger.findFirst({
                        where: { companyId: parseInt(currentCompanyId), name: { contains: modeName }, accountgroup: { type: 'ASSETS' } }
                    });
                    if (!fallbackLedger) {
                        const assetGroup = await tx.accountgroup.findFirst({ where: { companyId: parseInt(currentCompanyId), type: 'ASSETS' } });
                        fallbackLedger = await tx.ledger.create({
                            data: { name: `${modeName} Account`, groupId: assetGroup.id, companyId: parseInt(currentCompanyId) }
                        });
                    }
                    receiptLedgerId = fallbackLedger.id;
                }

                await tx.transaction.create({
                    data: {
                        date: new Date(),
                        voucherType: 'RECEIPT',
                        voucherNumber: `RCP-${invoiceNumber}`,
                        companyId: parseInt(currentCompanyId),
                        debitLedgerId: receiptLedgerId, // Money enters this account
                        creditLedgerId: debitLedgerId,    // Money leaves customer owing
                        amount: finalReceived,
                        narration: `Payment received for POS ${invoiceNumber} via ${paymentMode}`,
                        posInvoiceId: posInvoice.id,
                        updatedAt: new Date()
                    }
                });

                await tx.ledger.update({ where: { id: receiptLedgerId }, data: { currentBalance: { increment: finalReceived } } });
                await tx.ledger.update({ where: { id: debitLedgerId }, data: { currentBalance: { decrement: finalReceived } } });
            }

            // 3. Post COGS journal entry (Debit COGS / Credit Inventory Asset)
            if (autoCogsEntry && totalCOGS > 0) {
                const resolveLedger = async (namePattern, type) => {
                    let ledger = await tx.ledger.findFirst({
                        where: { companyId: parseInt(currentCompanyId), name: { contains: namePattern } }
                    });
                    if (!ledger) {
                        const group = await tx.accountgroup.findFirst({ where: { companyId: parseInt(currentCompanyId), type: type } });
                        if (group) {
                            ledger = await tx.ledger.create({
                                data: {
                                    name: namePattern,
                                    groupId: group.id,
                                    companyId: parseInt(currentCompanyId),
                                    isControlAccount: true
                                }
                            });
                        }
                    }
                    return ledger;
                };

                const cogsLedger = await resolveLedger('Point Of Sale', 'EXPENSES');
                const inventoryAssetLedger = await resolveLedger('Inventory Asset', 'ASSETS') || await resolveLedger('Inventory', 'ASSETS');

                if (cogsLedger && inventoryAssetLedger) {
                    await tx.transaction.create({
                        data: {
                            date: new Date(),
                            voucherType: 'JOURNAL',
                            voucherNumber: `COGS-${invoiceNumber}`,
                            debitLedgerId: cogsLedger.id,
                            creditLedgerId: inventoryAssetLedger.id,
                            amount: totalCOGS,
                            narration: `COGS for POS Sale: ${invoiceNumber}`,
                            companyId: parseInt(currentCompanyId),
                            posInvoiceId: posInvoice.id,
                            updatedAt: new Date()
                        }
                    });

                    await tx.ledger.update({ where: { id: cogsLedger.id }, data: { currentBalance: { increment: totalCOGS } } });
                    await tx.ledger.update({ where: { id: inventoryAssetLedger.id }, data: { currentBalance: { decrement: totalCOGS } } });
                }
            }

            return posInvoice;
        }, {
            maxWait: 15000,
            timeout: 90000
        });

        res.status(201).json({ success: true, data: result });

    } catch (error) {
        console.error('Create POS Error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
};

// Get All POS
const getPOSInvoices = async (req, res) => {
    try {
        const companyId = req.user?.companyId || req.query.companyId;
        const invoices = await prisma.posinvoice.findMany({
            where: { companyId: parseInt(companyId) },
            include: {
                customer: true,
                posinvoiceitem: { include: { product: true, warehouse: true } }
            },
            orderBy: { createdAt: 'desc' }
        });
        res.status(200).json({ success: true, data: invoices });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

// Get Single POS
const getPOSInvoiceById = async (req, res) => {
    try {
        const { id } = req.params;
        const companyId = req.user?.companyId || req.query.companyId || req.body.companyId;

        const invoice = await prisma.posinvoice.findUnique({
            where: { id: parseInt(id) },
            include: {
                customer: true,
                posinvoiceitem: { include: { product: true, warehouse: true } },
                transaction: true
            }
        });

        if (!invoice || invoice.companyId !== parseInt(companyId)) {
            return res.status(404).json({ success: false, message: 'POS Invoice not found' });
        }
        res.status(200).json({ success: true, data: invoice });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

// Delete POS (Void)
const deletePOSInvoice = async (req, res) => {
    try {
        const { id } = req.params;
        const companyId = req.user?.companyId || req.query.companyId || req.body.companyId;

        // Implementation of Void/Delete
        // 1. Reverse Stock
        // 2. Reverse Ledgers? Or just delete if testing?
        // User asked for "delete".
        // Robust way: Delete Transaction entries (reverse ledger balances first), then delete Invoice.

        await prisma.$transaction(async (tx) => {
            const invoice = await tx.posinvoice.findUnique({
                where: { id: parseInt(id) },
                include: { posinvoiceitem: true, transaction: true }
            });

            if (!invoice || invoice.companyId !== parseInt(companyId)) {
                throw new Error('Invoice not found or unauthorized');
            }

            // 1. Reverse Accounting
            // Loop transactions and reverse balances
            for (const t of invoice.transaction) {
                // Reverse Debit
                await tx.ledger.update({ where: { id: t.debitLedgerId }, data: { currentBalance: { decrement: t.amount } } });
                // Reverse Credit
                await tx.ledger.update({ where: { id: t.creditLedgerId }, data: { currentBalance: { decrement: t.amount } } }); // Wait, Credit Increase = Credit. Decrementing reverses Increase?
                // Standard: Cr Income increases balance (Credit Balance).
                // Logic: 
                // If Asset (Debit Normal): Debit increases (+), Credit decreases (-).
                // If Income (Credit Normal): Credit increases (+), Debit decreases (-).

                // My logic used in create:
                // update({ currentBalance: { increment: amount } }) for Debit Ledger (usually Asset/Expense - Debit Balance) -> Correct.
                // update({ currentBalance: { increment: amount } }) for Credit Ledger (Income - Credit Balance) -> Correct.
                // So "decrement" reverses both. Correct.

                await tx.transaction.delete({ where: { id: t.id } });
            }

            // 2. Reverse Stock & Product WAC Valuation
            const { convertToBaseQuantity } = require('../services/uomConversionService');

            for (const item of invoice.posinvoiceitem) {
                if (item.productId && item.warehouseId) {
                    const prod = await tx.product.findUnique({
                        where: { id: item.productId },
                        include: { uom: true }
                    });
                    const transUom = item.uomId ? await tx.uom.findUnique({ where: { id: item.uomId } }) : null;
                    const baseQty = convertToBaseQuantity(item.quantity, transUom, prod?.uom);

                    // Restore physical stock
                    await tx.stock.update({
                        where: { warehouseId_productId: { warehouseId: item.warehouseId, productId: item.productId } },
                        data: { quantity: { increment: baseQty } }
                    });

                    // Log return transaction
                    await tx.inventorytransaction.create({
                        data: {
                            date: new Date(),
                            type: 'RETURN', // Internal Return
                            productId: item.productId,
                            toWarehouseId: item.warehouseId,
                            quantity: baseQty,
                            reason: `Void POS: ${invoice.invoiceNumber}`,
                            companyId: parseInt(companyId || invoice.companyId)
                        }
                    });

                    // Restore WAC inventory tracking
                    const currentProduct = await tx.product.findUnique({
                        where: { id: parseInt(item.productId) },
                        select: { totalQty: true, totalInventoryValue: true, averageCost: true }
                    });

                    if (currentProduct) {
                        const averageCost = parseFloat(currentProduct.averageCost || 0);
                        const restorationValue = baseQty * averageCost;

                        const newTotalQty = parseFloat(currentProduct.totalQty || 0) + baseQty;
                        const newTotalValue = parseFloat(currentProduct.totalInventoryValue || 0) + restorationValue;

                        await tx.product.update({
                            where: { id: parseInt(item.productId) },
                            data: {
                                totalQty: newTotalQty,
                                totalInventoryValue: newTotalValue,
                                averageCost: newTotalQty > 0 ? newTotalValue / newTotalQty : averageCost
                            }
                        });
                    }
                }
            }

            // 3. Delete Invoice
            await tx.posinvoice.delete({ where: { id: parseInt(id) } });
        }, {
            maxWait: 15000,
            timeout: 90000
        });

        res.status(200).json({ success: true, message: 'POS Invoice deleted successfully' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

const getPublicPOSInvoiceById = async (req, res) => {
    try {
        const { id } = req.params;
        const invoice = await prisma.posinvoice.findUnique({
            where: { id: parseInt(id) },
            include: {
                customer: true,
                posinvoiceitem: { include: { product: true, warehouse: true } },
                company: true
            }
        });

        if (!invoice) return res.status(404).json({ success: false, message: 'POS Invoice not found' });
        res.status(200).json({ success: true, data: invoice });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

module.exports = {
    createPOSInvoice,
    getPOSInvoices,
    getPOSInvoiceById,
    deletePOSInvoice,
    getPublicPOSInvoiceById
};
