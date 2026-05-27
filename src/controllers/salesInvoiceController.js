const prisma = require('../config/prisma');
const {
    getInventoryConfig,
    consumeStock,
    reverseStockOut
} = require('../services/inventoryValuationService');

// Create Sales Invoice
const createInvoice = async (req, res) => {
    try {
        const { invoiceNumber, date, dueDate, customerId, salesOrderId, deliveryChallanId, items, notes, taxAmount, overallDiscount, overallDiscountType, billingName, billingAddress, billingCity, billingState, billingZipCode, billingCountry, shippingName, shippingAddress, shippingCity, shippingState, shippingZipCode, shippingCountry, currency, exchangeRate } = req.body;
        // Fallback to req.body.companyId if req.user is missing (custom frontend case)
        const companyId = req.user?.companyId || req.body.companyId;

        const docCurrency = currency || 'USD';
        const docExchangeRate = parseFloat(exchangeRate) || 1.0;

        if (!companyId) {
            return res.status(400).json({ success: false, message: 'Company ID is missing' });
        }

        if (!invoiceNumber || !customerId || !items || items.length === 0) {
            return res.status(400).json({ success: false, message: 'Please provide all required fields' });
        }

        // Pre-flight: Check if this invoice number / voucher number is already in use
        const existingInvoice = await prisma.invoice.findFirst({
            where: { companyId: parseInt(companyId), invoiceNumber }
        });
        if (existingInvoice) {
            return res.status(400).json({
                success: false,
                message: `Invoice number '${invoiceNumber}' already exists. Please use a unique invoice number.`
            });
        }

        const existingJournal = await prisma.journalentry.findFirst({
            where: { companyId: parseInt(companyId), voucherNumber: invoiceNumber }
        });
        if (existingJournal) {
            return res.status(400).json({
                success: false,
                message: `Voucher number '${invoiceNumber}' is already used by another entry. Please use a unique invoice number.`
            });
        }

        // 1. Get Customer and its Ledger
        const customer = await prisma.customer.findUnique({
            where: { id: parseInt(customerId) },
            include: { ledger: true }
        });

        if (!customer || !customer.ledgerId) {
            return res.status(400).json({ success: false, message: 'Customer ledger not found' });
        }

        // 2. Resolve Standard Ledgers (Auto-create if missing)
        const resolveLedger = async (txOrPrisma, namePattern, type) => {
            let ledger = await txOrPrisma.ledger.findFirst({
                where: { companyId: parseInt(companyId), name: { contains: namePattern } }
            });
            if (!ledger) {
                const group = await txOrPrisma.accountgroup.findFirst({ where: { companyId: parseInt(companyId), type: type } });
                if (group) {
                    ledger = await txOrPrisma.ledger.create({
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

        const salesLedger = await resolveLedger(prisma, 'Sales Income', 'INCOME');
        const cogsLedger = await resolveLedger(prisma, 'Cost of Goods Sold', 'EXPENSES');
        const inventoryLedger = await resolveLedger(prisma, 'Inventory Asset', 'ASSETS');
        const taxLedger = await resolveLedger(prisma, 'Tax', 'LIABILITIES');

        if (!salesLedger) throw new Error('Could not resolve or create Sales Income ledger');



        let subtotal = 0;
        let totalDiscount = 0;
        let lineTaxSum = 0;

        const invoiceItems = items.map(item => {
            const itemQty = parseFloat(item.quantity) || 0;
            const itemRate = parseFloat(item.rate) || 0;
            const itemDiscount = parseFloat(item.discount) || 0;
            const itemTaxRate = parseFloat(item.taxRate) || 0;

            const lineGross = itemQty * itemRate;
            const lineTaxable = lineGross - itemDiscount;
            const lineTax = (lineTaxable * itemTaxRate) / 100;
            const lineTotal = lineTaxable + lineTax;

            subtotal += lineGross;
            totalDiscount += itemDiscount;
            lineTaxSum += lineTax;

            return {
                productId: item.productId ? parseInt(item.productId) : null,
                serviceId: item.serviceId ? parseInt(item.serviceId) : null,
                description: item.description || 'Sales Item',
                quantity: itemQty,
                rate: itemRate,
                discount: itemDiscount,
                amount: lineTotal,
                taxRate: itemTaxRate,
                warehouseId: item.warehouseId ? parseInt(item.warehouseId) : null
            };
        });

        const finalTax = parseFloat(taxAmount) || lineTaxSum;
        const baseTotal = (subtotal - totalDiscount) + finalTax;
        let totalAmount = baseTotal;
        if (overallDiscount && overallDiscountType === 'percentage') {
            totalAmount = baseTotal - (baseTotal * overallDiscount / 100);
        } else if (overallDiscount) {
            totalAmount = baseTotal - overallDiscount;
        }

        const result = await prisma.$transaction(async (tx) => {
            // A. Create Invoice
            const invoice = await tx.invoice.create({
                data: {
                    invoiceNumber,
                    date: new Date(date),
                    dueDate: dueDate ? new Date(dueDate) : null,
                    customerId: parseInt(customerId),
                    companyId: parseInt(companyId),
                    salesOrderId: salesOrderId ? parseInt(salesOrderId) : null,
                    deliveryChallanId: deliveryChallanId ? parseInt(deliveryChallanId) : null,
                    subtotal,
                    discountAmount: totalDiscount,
                    taxAmount: finalTax,
                    totalAmount,
                    balanceAmount: totalAmount,
                    currency: docCurrency,
                    exchangeRate: docExchangeRate,
                    notes,
                    overallDiscount: parseFloat(overallDiscount) || 0,
                    overallDiscountType: overallDiscountType || 'percentage',
                    billingName: req.body.billingName,
                    billingAddress: req.body.billingAddress,
                    billingCity: req.body.billingCity,
                    billingState: req.body.billingState,
                    billingZipCode: billingZipCode,
                    billingCountry: billingCountry,
                    shippingName: shippingName,
                    shippingAddress: shippingAddress,
                    shippingCity: shippingCity,
                    shippingState: shippingState,
                    shippingZipCode: shippingZipCode,
                    shippingCountry: shippingCountry,
                    invoiceitem: {
                        create: invoiceItems.map(i => ({
                            productId: i.productId,
                            serviceId: i.serviceId,
                            description: i.description,
                            quantity: i.quantity,
                            rate: i.rate,
                            discount: i.discount,
                            amount: i.amount,
                            taxRate: i.taxRate,
                            warehouseId: i.warehouseId
                        }))
                    }
                }
            });

            // B. Inventory OUT Logic
            const company = await tx.company.findUnique({ where: { id: parseInt(companyId) } });
            let config = {};
            try {
                config = company?.inventoryConfig
                    ? (typeof company.inventoryConfig === 'string' ? JSON.parse(company.inventoryConfig) : company.inventoryConfig)
                    : {};
            } catch (e) { config = {}; }

            if (deliveryChallanId) {
                // Invoiced from Challan
                const challan = await tx.deliverychallan.findUnique({
                    where: { id: parseInt(deliveryChallanId) },
                    include: { deliverychallanitem: true }
                });

                if (challan) {
                    await tx.deliverychallan.update({
                        where: { id: challan.id },
                        data: { status: 'DELIVERED' } // Marks as completed
                    });

                    // If Challan only RESERVED, we must ISSUE now
                    if (config.challanAction === 'RESERVE') {
                        for (const item of invoiceItems) {
                            if (item.productId && item.warehouseId) {
                                // 1. Clear Challan Reservation
                                await tx.stock.updateMany({
                                    where: { productId: item.productId, warehouseId: item.warehouseId },
                                    data: {
                                        reservedQuantity: { decrement: item.quantity },
                                        quantity: { decrement: item.quantity }
                                    }
                                });

                                // 2. Log Transaction
                                await tx.inventorytransaction.create({
                                    data: {
                                        type: 'SALE',
                                        productId: item.productId,
                                        fromWarehouseId: item.warehouseId,
                                        quantity: item.quantity,
                                        reason: `Invoice from Reserved Challan: ${invoiceNumber}`,
                                        companyId: parseInt(companyId)
                                    }
                                });
                            }
                        }
                    }
                }
            } else if (salesOrderId) {
                // Invoiced from SO (Directly)
                const so = await tx.salesorder.findUnique({
                    where: { id: parseInt(salesOrderId) },
                    include: { salesorderitem: true }
                });

                if (so) {
                    await tx.salesorder.update({
                        where: { id: so.id },
                        data: { status: 'COMPLETED' }
                    });

                    for (const item of invoiceItems) {
                        if (item.productId && item.warehouseId) {
                            // 1. Clear SO Reservation if it was active
                            if (config.reserveOnSO) {
                                await tx.stock.updateMany({
                                    where: { productId: item.productId, warehouseId: item.warehouseId },
                                    data: { reservedQuantity: { decrement: item.quantity } }
                                });
                            }

                            // 2. Decrement Stock
                            await tx.stock.updateMany({
                                where: { productId: item.productId, warehouseId: item.warehouseId },
                                data: { quantity: { decrement: item.quantity } }
                            });

                            // 3. Log Transaction
                            await tx.inventorytransaction.create({
                                data: {
                                    type: 'SALE',
                                    productId: item.productId,
                                    fromWarehouseId: item.warehouseId,
                                    quantity: item.quantity,
                                    reason: `Invoice from SO: ${invoiceNumber}`,
                                    companyId: parseInt(companyId)
                                }
                            });
                        }
                    }
                }
            } else {
                // Direct Invoice
                for (const item of invoiceItems) {
                    if (item.productId && item.warehouseId) {
                        await tx.stock.updateMany({
                            where: { productId: item.productId, warehouseId: item.warehouseId },
                            data: { quantity: { decrement: item.quantity } }
                        });

                        await tx.inventorytransaction.create({
                            data: {
                                type: 'SALE',
                                productId: item.productId,
                                fromWarehouseId: item.warehouseId,
                                companyId: parseInt(companyId),
                                quantity: item.quantity,
                                reason: `Direct Invoice: ${invoiceNumber}`
                            }
                        });
                    }
                }
            }

            // C. Accounting Entries (Double Entry)
            const ledgerTotalAmount = totalAmount * docExchangeRate;
            const ledgerSubtotal = subtotal * docExchangeRate;
            const ledgerTax = finalTax * docExchangeRate;

            // 1. DR Customer, CR Sales Income
            const journal = await tx.journalentry.create({
                data: {
                    voucherNumber: invoiceNumber,
                    date: new Date(date),
                    narration: `Sales Invoice: ${invoiceNumber}`,
                    companyId: parseInt(companyId)
                }
            });

            await tx.transaction.create({
                data: {
                    date: new Date(date),
                    voucherType: 'SALES',
                    voucherNumber: invoiceNumber,
                    debitLedgerId: customer.ledgerId,
                    creditLedgerId: salesLedger.id,
                    amount: ledgerTotalAmount,
                    narration: `Sales to ${customer.name}`,
                    companyId: parseInt(companyId),
                    journalEntryId: journal.id,
                    invoiceId: invoice.id
                }
            });

            // Update Customer Ledger (Asset Increases with Debit)
            await tx.ledger.update({
                where: { id: customer.ledgerId },
                data: { currentBalance: { increment: ledgerTotalAmount } }
            });

            // Update Sales Ledger (Income Increases with Credit)
            await tx.ledger.update({
                where: { id: salesLedger.id },
                data: { currentBalance: { increment: ledgerSubtotal } }
            });

            // 2. Handle Tax (CR Tax Payable)
            if (finalTax > 0 && taxLedger) {
                await tx.ledger.update({
                    where: { id: taxLedger.id },
                    data: { currentBalance: { increment: ledgerTax } }
                });
            }

            // 3. COGS using Inventory Valuation Method (FIFO or WAC)
            const invConfig = await getInventoryConfig(companyId);
            const valuationMethod = invConfig.valuationMethod || 'WAC';
            const autoCogsEntry = invConfig.autoCogsEntry !== false; // default ON
            const negativeStockAllow = invConfig.negativeStockAllow !== false; // default ON

            let totalCOGS = 0;
            for (const item of invoiceItems) {
                if (item.productId) {
                    // Auto-resolve warehouse if not provided: find first warehouse with stock/batch for this product
                    let resolvedWarehouseId = item.warehouseId;
                    if (!resolvedWarehouseId) {
                        // Try FIFO batch first
                        const firstBatch = await tx.inventory_batch.findFirst({
                            where: { productId: parseInt(item.productId), qtyRemaining: { gt: 0 } },
                            orderBy: { createdAt: 'asc' },
                            select: { warehouseId: true }
                        });
                        if (firstBatch) {
                            resolvedWarehouseId = firstBatch.warehouseId;
                        } else {
                            // Fallback: try stock table
                            const firstStock = await tx.stock.findFirst({
                                where: { productId: parseInt(item.productId), quantity: { gt: 0 } },
                                orderBy: { quantity: 'desc' },
                                select: { warehouseId: true }
                            });
                            if (firstStock) {
                                resolvedWarehouseId = firstStock.warehouseId;
                            }
                        }
                    }

                    if (resolvedWarehouseId) {
                        // Also update stock deduction if original warehouseId was missing
                        if (!item.warehouseId) {
                            await tx.stock.updateMany({
                                where: { productId: parseInt(item.productId), warehouseId: resolvedWarehouseId },
                                data: { quantity: { decrement: item.quantity } }
                            });
                        }

                        const itemCOGS = await consumeStock(tx, {
                            companyId,
                            productId: item.productId,
                            warehouseId: resolvedWarehouseId,
                            quantity: item.quantity,
                            invoiceId: invoice.id,
                            method: valuationMethod,
                            negativeStockAllow
                        });
                        totalCOGS += itemCOGS;
                    } else {
                        // No warehouse at all: still calculate WAC COGS from product averageCost
                        const prod = await tx.product.findUnique({
                            where: { id: parseInt(item.productId) },
                            select: { averageCost: true, purchasePrice: true, initialCost: true }
                        });
                        const cost = parseFloat(prod?.averageCost || prod?.purchasePrice || prod?.initialCost || 0);
                        totalCOGS += cost * item.quantity;
                    }
                }
            }

            if (autoCogsEntry && totalCOGS > 0 && cogsLedger && inventoryLedger) {
                await tx.transaction.create({
                    data: {
                        date: new Date(date),
                        voucherType: 'JOURNAL',
                        voucherNumber: `COGS-${invoiceNumber}`,
                        debitLedgerId: cogsLedger.id,
                        creditLedgerId: inventoryLedger.id,
                        amount: totalCOGS,
                        narration: `COGS for Invoice: ${invoiceNumber}`,
                        companyId: parseInt(companyId),
                        journalEntryId: journal.id,
                        invoiceId: invoice.id
                    }
                });

                await tx.ledger.update({ where: { id: cogsLedger.id }, data: { currentBalance: { increment: totalCOGS } } });
                await tx.ledger.update({ where: { id: inventoryLedger.id }, data: { currentBalance: { decrement: totalCOGS } } });
            }


            // Update Sales Order status if fully invoiced
            if (salesOrderId) {
                await tx.salesorder.update({
                    where: { id: parseInt(salesOrderId) },
                    data: { status: 'COMPLETED' }
                });
            }

            return invoice;
        }, {
            timeout: 90000 // 90 seconds timeout
        });

        res.status(201).json({ success: true, data: result });
    } catch (error) {
        console.error('Invoice Creation Error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
};

// Get All Invoices
const getInvoices = async (req, res) => {
    try {
        const companyId = req.user?.companyId || req.query.companyId;
        if (!companyId) return res.status(400).json({ success: false, message: 'Company ID Missing' });

        const [invoices, posInvoices] = await Promise.all([
            prisma.invoice.findMany({
                where: { companyId: parseInt(companyId) },
                include: {
                    customer: { select: { id: true, name: true, email: true, ledgerId: true } },
                    invoiceitem: {
                        include: {
                            product: true,
                            service: true,
                            warehouse: true
                        }
                    },
                    salesorder: true,
                    deliverychallan: true,
                    salesreturn: {
                        include: {
                            salesreturnitem: true
                        }
                    }
                },
                orderBy: { createdAt: 'desc' }
            }),
            prisma.posinvoice.findMany({
                where: { companyId: parseInt(companyId) },
                include: {
                    customer: { select: { id: true, name: true, email: true, ledgerId: true } },
                    posinvoiceitem: {
                        include: { product: true, warehouse: true }
                    }
                },
                orderBy: { createdAt: 'desc' }
            })
        ]);

        // Merge POS invoices into the unified list
        const unifiedInvoices = [
            ...invoices.map(inv => ({ ...inv, type: 'TAX_INVOICE' })),
            ...posInvoices.map(pos => ({
                ...pos,
                type: 'POS_INVOICE',
                invoiceitem: pos.posinvoiceitem,
                salesreturn: [],
                dueDate: pos.date,
                status: pos.balanceAmount > 0 ? 'PARTIAL' : 'PAID'
            }))
        ].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

        res.status(200).json({ success: true, data: unifiedInvoices });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

// Get Invoice By ID
const getInvoiceById = async (req, res) => {
    try {
        const { id } = req.params;
        const companyId = req.user?.companyId || req.query.companyId;
        // Note: req.query.companyId might not be passed for getById standardly, but consistent with getAll

        if (!companyId) return res.status(400).json({ success: false, message: 'Company ID Missing' });

        const invoice = await prisma.invoice.findFirst({
            where: { id: parseInt(id), companyId: parseInt(companyId) },
            include: {
                invoiceitem: {
                    include: {
                        product: true,
                        service: true,
                        warehouse: true
                    }
                },
                customer: true,
                salesorder: true,
                receipt: true
            }
        });

        if (!invoice) return res.status(404).json({ success: false, message: 'Invoice not found' });

        res.status(200).json({ success: true, data: invoice });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

// Update Invoice
const updateInvoice = async (req, res) => {
    try {
        const { id } = req.params;
        const { items, overallDiscount, overallDiscountType, billingName, billingAddress, billingCity, billingState, billingZipCode, billingCountry, shippingName, shippingAddress, shippingCity, shippingState, shippingZipCode, shippingCountry, currency, exchangeRate, ...data } = req.body;
        const companyId = req.user?.companyId || req.body.companyId;

        if (!companyId) {
            return res.status(400).json({ success: false, message: 'Company ID is missing' });
        }

        // 1. Get existing invoice
        const existingInvoice = await prisma.invoice.findFirst({
            where: { id: parseInt(id), companyId: parseInt(companyId) },
            include: { invoiceitem: true }
        });

        if (!existingInvoice) {
            return res.status(404).json({ success: false, message: 'Invoice not found' });
        }

        // 2. Calculate new totals if items are provided
        let subtotal = existingInvoice.subtotal;
        let totalDiscount = existingInvoice.discountAmount;
        let taxAmount = existingInvoice.taxAmount;
        let totalAmount = existingInvoice.totalAmount;

        let invoiceItemsData = undefined;

        if (items) {
            subtotal = 0;
            totalDiscount = 0;
            let lineTaxSum = 0;

            invoiceItemsData = items.map(item => {
                const itemQty = parseFloat(item.quantity) || 0;
                const itemRate = parseFloat(item.rate) || 0;
                const itemDiscount = parseFloat(item.discount) || 0;
                const itemTaxRate = parseFloat(item.taxRate) || 0;

                const lineGross = itemQty * itemRate;
                const lineTaxable = lineGross - itemDiscount;
                const lineTax = (lineTaxable * itemTaxRate) / 100;
                const lineTotal = lineTaxable + lineTax;

                subtotal += lineGross;
                totalDiscount += itemDiscount;
                lineTaxSum += lineTax;

                return {
                    productId: item.productId ? parseInt(item.productId) : null,
                    serviceId: item.serviceId ? parseInt(item.serviceId) : null,
                    description: item.description || 'Sales Item',
                    quantity: itemQty,
                    rate: itemRate,
                    discount: itemDiscount,
                    amount: lineTotal,
                    taxRate: itemTaxRate,
                    warehouseId: item.warehouseId ? parseInt(item.warehouseId) : null
                };
            });

            taxAmount = parseFloat(req.body.taxAmount) || lineTaxSum;
            const baseTotal = (subtotal - totalDiscount) + taxAmount;
            totalAmount = baseTotal;
            if (overallDiscount && overallDiscountType === 'percentage') {
                totalAmount = baseTotal - (baseTotal * overallDiscount / 100);
            } else if (overallDiscount) {
                totalAmount = baseTotal - overallDiscount;
            }
        } else {
            // Recalculate with overall discount if items didn't change but discount did
            const baseTotal = (existingInvoice.subtotal - existingInvoice.discountAmount) + existingInvoice.taxAmount;
            totalAmount = baseTotal;
            const ovDiscount = overallDiscount !== undefined ? overallDiscount : existingInvoice.overallDiscount;
            const ovType = overallDiscountType !== undefined ? overallDiscountType : existingInvoice.overallDiscountType;
            if (ovDiscount && ovType === 'percentage') {
                totalAmount = baseTotal - (baseTotal * ovDiscount / 100);
            } else if (ovDiscount) {
                totalAmount = baseTotal - ovDiscount;
            }
        }

        // 3. Update Invoice in a transaction to handle accounting adjustments
        const result = await prisma.$transaction(async (tx) => {
            // A. Revert old ledger balances
            const oldTransactions = await tx.transaction.findMany({
                where: { invoiceId: parseInt(id) }
            });

            for (const t of oldTransactions) {
                await tx.ledger.update({
                    where: { id: t.debitLedgerId },
                    data: { currentBalance: { decrement: t.amount } }
                });
                await tx.ledger.update({
                    where: { id: t.creditLedgerId },
                    data: { currentBalance: { decrement: t.amount } }
                });
            }

            // B. Revert old stock + FIFO/WAC if items changed
            if (items) {
                // Also reverse old COGS inventory valuation (FIFO batches + WAC)
                await reverseStockOut(tx, {
                    invoiceId: parseInt(id),
                    invoiceItems: existingInvoice.invoiceitem.map(i => ({
                        productId: i.productId,
                        warehouseId: i.warehouseId,
                        quantity: i.quantity
                    }))
                });

                for (const item of existingInvoice.invoiceitem) {
                    if (item.productId) {
                        // Find which warehouse was used (warehouseId may be in item or resolved earlier)
                        const wId = item.warehouseId;
                        if (wId) {
                            await tx.stock.updateMany({
                                where: { productId: item.productId, warehouseId: wId },
                                data: { quantity: { increment: item.quantity } }
                            });
                        }
                    }
                }
            }

            // C. Update Invoice record
            const updatedInvoice = await tx.invoice.update({
                where: { id: parseInt(id) },
                data: {
                    invoiceNumber: data.invoiceNumber,
                    date: data.date ? new Date(data.date) : undefined,
                    dueDate: data.dueDate ? new Date(data.dueDate) : undefined,
                    customerId: data.customerId ? parseInt(data.customerId) : undefined,
                    notes: data.notes,
                    subtotal,
                    discountAmount: totalDiscount,
                    taxAmount,
                    totalAmount,
                    balanceAmount: totalAmount - (existingInvoice.paidAmount || 0),
                    currency: currency !== undefined ? currency : undefined,
                    exchangeRate: exchangeRate !== undefined ? parseFloat(exchangeRate) : undefined,
                    overallDiscount: parseFloat(overallDiscount) || 0,
                    overallDiscountType: overallDiscountType || 'percentage',
                    billingName: billingName,
                    billingAddress: billingAddress,
                    billingCity: billingCity,
                    billingState: billingState,
                    billingZipCode: billingZipCode,
                    billingCountry: billingCountry,
                    shippingName: shippingName,
                    shippingAddress: shippingAddress,
                    shippingCity: shippingCity,
                    shippingState: shippingState,
                    shippingZipCode: shippingZipCode,
                    shippingCountry: shippingCountry,
                    invoiceitem: items ? {
                        deleteMany: {},
                        create: invoiceItemsData
                    } : undefined
                },
                include: { customer: { include: { ledger: true } } }
            });

            // D. Apply new stock if items changed
            if (items) {
                for (const item of (invoiceItemsData || [])) {
                    if (item.productId) {
                        // Auto-resolve warehouse if not provided
                        let resolvedWId = item.warehouseId;
                        if (!resolvedWId) {
                            const firstBatch = await tx.inventory_batch.findFirst({
                                where: { productId: parseInt(item.productId), qtyRemaining: { gt: 0 } },
                                orderBy: { createdAt: 'asc' },
                                select: { warehouseId: true }
                            });
                            if (firstBatch) {
                                resolvedWId = firstBatch.warehouseId;
                            } else {
                                const firstStock = await tx.stock.findFirst({
                                    where: { productId: parseInt(item.productId), quantity: { gt: 0 } },
                                    orderBy: { quantity: 'desc' },
                                    select: { warehouseId: true }
                                });
                                if (firstStock) resolvedWId = firstStock.warehouseId;
                            }
                        }
                        if (resolvedWId) {
                            await tx.stock.updateMany({
                                where: { productId: parseInt(item.productId), warehouseId: resolvedWId },
                                data: { quantity: { decrement: item.quantity } }
                            });
                        }
                    }
                }
            }

            // E. Update/Create new transactions
            // For simplicity, we delete old and create new
            const oldTxs = await tx.transaction.findMany({ where: { invoiceId: parseInt(id) } });
            const oldJournalIds = oldTxs.map(t => t.journalEntryId).filter(Boolean);

            await tx.transaction.deleteMany({ where: { invoiceId: parseInt(id) } });
            if (oldJournalIds.length > 0) {
                await tx.journalentry.deleteMany({ where: { id: { in: oldJournalIds } } });
            }

            const customer = updatedInvoice.customer;
            // Find Sales Income Ledger (same logic as create)
            let salesLedger = await tx.ledger.findFirst({
                where: { companyId: parseInt(companyId), name: { contains: 'Sales' }, accountgroup: { type: 'INCOME' } }
            });

            if (customer && customer.ledgerId && salesLedger) {
                const docExchangeRate = updatedInvoice.exchangeRate || 1.0;
                const ledgerTotalAmount = totalAmount * docExchangeRate;

                // Create new journal entry for the updated invoice
                const journal = await tx.journalentry.create({
                    data: {
                        voucherNumber: updatedInvoice.invoiceNumber,
                        date: updatedInvoice.date,
                        narration: `Updated Sales Invoice: ${updatedInvoice.invoiceNumber}`,
                        companyId: parseInt(companyId)
                    }
                });

                await tx.transaction.create({
                    data: {
                        date: updatedInvoice.date,
                        voucherType: 'SALES',
                        voucherNumber: updatedInvoice.invoiceNumber,
                        debitLedgerId: customer.ledgerId,
                        creditLedgerId: salesLedger.id,
                        amount: ledgerTotalAmount,
                        narration: `Updated Sales to ${customer.name}`,
                        companyId: parseInt(companyId),
                        invoiceId: updatedInvoice.id,
                        journalEntryId: journal.id
                    }
                });

                // Update ledger balances with new amounts
                await tx.ledger.update({
                    where: { id: customer.ledgerId },
                    data: { currentBalance: { increment: ledgerTotalAmount } }
                });
                await tx.ledger.update({
                    where: { id: salesLedger.id },
                    data: { currentBalance: { increment: ledgerTotalAmount } }
                });
            }

            // F. Re-post COGS entry (was completely missing from update flow!)
            if (items && invoiceItemsData) {
                const invConfig = await getInventoryConfig(companyId);
                const valuationMethod = invConfig.valuationMethod || 'WAC';
                const autoCogsEntry = invConfig.autoCogsEntry !== false;
                const negativeStockAllow = invConfig.negativeStockAllow !== false;

                // Resolve ledgers
                const cogsLedger = await tx.ledger.findFirst({
                    where: { companyId: parseInt(companyId), name: { contains: 'Cost of Goods Sold' } }
                }) || await tx.ledger.findFirst({
                    where: { companyId: parseInt(companyId), name: { contains: 'COGS' } }
                });
                const inventoryLedger = await tx.ledger.findFirst({
                    where: { companyId: parseInt(companyId), name: { contains: 'Inventory Asset' } }
                }) || await tx.ledger.findFirst({
                    where: { companyId: parseInt(companyId), name: { contains: 'Inventory' } }
                });

                let totalCOGS = 0;
                for (const item of invoiceItemsData) {
                    if (item.productId) {
                        let resolvedWarehouseId = item.warehouseId;
                        if (!resolvedWarehouseId) {
                            const firstBatch = await tx.inventory_batch.findFirst({
                                where: { productId: parseInt(item.productId), qtyRemaining: { gt: 0 } },
                                orderBy: { createdAt: 'asc' },
                                select: { warehouseId: true }
                            });
                            if (firstBatch) {
                                resolvedWarehouseId = firstBatch.warehouseId;
                            } else {
                                const firstStock = await tx.stock.findFirst({
                                    where: { productId: parseInt(item.productId), quantity: { gt: 0 } },
                                    orderBy: { quantity: 'desc' },
                                    select: { warehouseId: true }
                                });
                                if (firstStock) resolvedWarehouseId = firstStock.warehouseId;
                            }
                        }

                        if (resolvedWarehouseId) {
                            const itemCOGS = await consumeStock(tx, {
                                companyId,
                                productId: item.productId,
                                warehouseId: resolvedWarehouseId,
                                quantity: item.quantity,
                                invoiceId: updatedInvoice.id,
                                method: valuationMethod,
                                negativeStockAllow
                            });
                            totalCOGS += itemCOGS;
                        } else {
                            // No warehouse: fallback to product cost
                            const prod = await tx.product.findUnique({
                                where: { id: parseInt(item.productId) },
                                select: { averageCost: true, purchasePrice: true, initialCost: true }
                            });
                            const cost = parseFloat(prod?.averageCost || prod?.purchasePrice || prod?.initialCost || 0);
                            totalCOGS += cost * item.quantity;
                        }
                    }
                }

                if (autoCogsEntry && totalCOGS > 0 && cogsLedger && inventoryLedger) {
                    // Find the journal entry we just created for this invoice
                    const journalForCOGS = await tx.journalentry.findFirst({
                        where: { companyId: parseInt(companyId), voucherNumber: updatedInvoice.invoiceNumber }
                    });

                    await tx.transaction.create({
                        data: {
                            date: updatedInvoice.date,
                            voucherType: 'JOURNAL',
                            voucherNumber: `COGS-${updatedInvoice.invoiceNumber}`,
                            debitLedgerId: cogsLedger.id,
                            creditLedgerId: inventoryLedger.id,
                            amount: totalCOGS,
                            narration: `COGS for Updated Invoice: ${updatedInvoice.invoiceNumber}`,
                            companyId: parseInt(companyId),
                            invoiceId: updatedInvoice.id,
                            journalEntryId: journalForCOGS?.id || null
                        }
                    });

                    await tx.ledger.update({ where: { id: cogsLedger.id }, data: { currentBalance: { increment: totalCOGS } } });
                    await tx.ledger.update({ where: { id: inventoryLedger.id }, data: { currentBalance: { decrement: totalCOGS } } });
                }
            }

            return updatedInvoice;
        }, { timeout: 90000 });

        res.status(200).json({ success: true, data: result });
    } catch (error) {
        console.error('Invoice Update Error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
};

// Delete Invoice
const deleteInvoice = async (req, res) => {
    try {
        const { id } = req.params;
        const companyId = req.user?.companyId || req.query.companyId;

        const invoice = await prisma.invoice.findUnique({
            where: { id: parseInt(id) },
            include: { invoiceitem: true, transaction: true }
        });

        if (!invoice) {
            return res.status(404).json({ success: false, message: 'Invoice not found' });
        }

        await prisma.$transaction(async (tx) => {
            // 1. Revert Ledger Balances
            for (const t of invoice.transaction) {
                await tx.ledger.update({
                    where: { id: t.debitLedgerId },
                    data: { currentBalance: { decrement: t.amount } }
                });
                await tx.ledger.update({
                    where: { id: t.creditLedgerId },
                    data: { currentBalance: { decrement: t.amount } }
                });
            }

            // 2. Revert Stock
            for (const item of invoice.invoiceitem) {
                if (item.productId && item.warehouseId) {
                    await tx.stock.updateMany({
                        where: { productId: item.productId, warehouseId: item.warehouseId },
                        data: { quantity: { increment: item.quantity } }
                    });

                    // Log inventory return
                    await tx.inventorytransaction.create({
                        data: {
                            type: 'RETURN',
                            productId: item.productId,
                            toWarehouseId: item.warehouseId,
                            quantity: item.quantity,
                            reason: `Invoice Deleted: ${invoice.invoiceNumber}`,
                            companyId: invoice.companyId
                        }
                    });
                }
            }

            // 3. Delete Transactions, Journal Entries, and Invoice
            const journalEntryIds = [...new Set(invoice.transaction.map(t => t.journalEntryId).filter(Boolean))];

            await tx.transaction.deleteMany({ where: { invoiceId: invoice.id } });

            if (journalEntryIds.length > 0) {
                await tx.journalentry.deleteMany({ where: { id: { in: journalEntryIds } } });
            }

            // Also delete any orphaned journal entries with same voucherNumber (permanent delete guarantee)
            await tx.journalentry.deleteMany({
                where: {
                    companyId: invoice.companyId,
                    voucherNumber: invoice.invoiceNumber,
                    transactions: { none: {} }
                }
            });

            await tx.invoice.delete({ where: { id: invoice.id } });
        }, { timeout: 30000 });

        res.status(200).json({ success: true, message: 'Invoice deleted successfully' });
    } catch (error) {
        console.error('Invoice Delete Error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
};

// Get Next Invoice Number
const getNextNumber = async (req, res) => {
    try {
        const companyId = req.user?.companyId || req.query.companyId;
        if (!companyId) return res.status(400).json({ success: false, message: 'Company ID Missing' });

        const cid = parseInt(companyId);

        // Scan ALL existing invoices to find max number used
        const allInvoices = await prisma.invoice.findMany({
            where: { companyId: cid },
            select: { invoiceNumber: true }
        });

        // Scan ALL journal entries to find max number used (catches soft-deleted invoices)
        const allJournals = await prisma.journalentry.findMany({
            where: { companyId: cid },
            select: { voucherNumber: true }
        });

        // Extract max numeric suffix from both sources
        let maxNum = 100; // Start from 101
        for (const inv of allInvoices) {
            const numStr = (inv.invoiceNumber || '').replace(/\D/g, '');
            const num = parseInt(numStr);
            if (!isNaN(num) && num > maxNum) maxNum = num;
        }
        for (const j of allJournals) {
            const numStr = (j.voucherNumber || '').replace(/\D/g, '');
            const num = parseInt(numStr);
            if (!isNaN(num) && num > maxNum) maxNum = num;
        }

        const nextNumber = (maxNum + 1).toString();
        res.status(200).json({ success: true, nextNumber });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

const getPublicInvoiceById = async (req, res) => {
    try {
        const { id } = req.params;
        const invoice = await prisma.invoice.findUnique({
            where: { id: parseInt(id) },
            include: {
                invoiceitem: {
                    include: {
                        product: true,
                        service: true,
                        warehouse: true
                    }
                },
                customer: true,
                salesorder: true,
                company: true
            }
        });

        if (!invoice) return res.status(404).json({ success: false, message: 'Invoice not found' });
        res.status(200).json({ success: true, data: invoice });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

// One-time cleanup: remove orphaned journal entries (no linked transactions)
const cleanupOrphanedJournals = async (req, res) => {
    try {
        const companyId = req.user?.companyId || req.query.companyId;
        const whereClause = { transactions: { none: {} } };
        if (companyId) whereClause.companyId = parseInt(companyId);

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

        const result = await prisma.journalentry.deleteMany({ where: whereClause });

        return res.status(200).json({
            success: true,
            message: `Cleaned up ${result.count} orphaned journal entries.`,
            deletedCount: result.count,
            deleted: orphaned.map(j => ({ id: j.id, voucherNumber: j.voucherNumber }))
        });
    } catch (error) {
        console.error('Cleanup Error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
};

module.exports = {
    createInvoice,
    getInvoices,
    getInvoiceById,
    updateInvoice,
    deleteInvoice,
    getNextNumber,
    getPublicInvoiceById,
    cleanupOrphanedJournals
};