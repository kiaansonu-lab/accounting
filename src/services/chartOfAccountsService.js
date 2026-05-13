const prisma = require('../config/prisma');

// Initialize Default Chart of Accounts for a Company
const initializeChartOfAccounts = async (companyId) => {
    try {
        // 1. Verify Company exists
        const company = await prisma.company.findUnique({
            where: { id: companyId }
        });

        if (!company) {
            return {
                success: false,
                message: `Company with ID ${companyId} not found. Please logout and login again.`
            };
        }

        // 2. Check if already initialized (at least one group exists)
        const existingGroups = await prisma.accountgroup.findFirst({
            where: { companyId }
        });

        if (existingGroups) {
            return {
                success: true,
                message: 'Chart of Accounts already initialized'
            };
        }

        // --- Helper for creating groups, subgroups, and ledgers ---
        const createCOA = async () => {
            // 1. ASSETS
            const assetsGroup = await prisma.accountgroup.create({
                data: { name: 'Assets', type: 'ASSETS', companyId }
            });

            const cashSub = await prisma.accountsubgroup.create({
                data: { name: 'Cash', groupId: assetsGroup.id, companyId }
            });
            await prisma.ledger.create({
                data: { name: 'Cash in Hand', groupId: assetsGroup.id, subGroupId: cashSub.id, companyId, openingBalance: 0, currentBalance: 0 }
            });

            const bankSub = await prisma.accountsubgroup.create({
                data: { name: 'Bank Accounts', groupId: assetsGroup.id, companyId }
            });
            await prisma.ledger.create({
                data: { name: 'Main Bank Account', groupId: assetsGroup.id, subGroupId: bankSub.id, companyId, openingBalance: 0, currentBalance: 0 }
            });

            const arSub = await prisma.accountsubgroup.create({
                data: { name: 'Accounts Receivable', groupId: assetsGroup.id, companyId }
            });

            const inventorySub = await prisma.accountsubgroup.create({
                data: { name: 'Inventory', groupId: assetsGroup.id, companyId }
            });
            await prisma.ledger.create({
                data: { name: 'Inventory Asset', groupId: assetsGroup.id, subGroupId: inventorySub.id, companyId, openingBalance: 0, currentBalance: 0 }
            });

            const fixedAssetsSub = await prisma.accountsubgroup.create({
                data: { name: 'Fixed Assets', groupId: assetsGroup.id, companyId }
            });

            // 2. LIABILITIES
            const liabilitiesGroup = await prisma.accountgroup.create({
                data: { name: 'Liabilities', type: 'LIABILITIES', companyId }
            });

            const apSub = await prisma.accountsubgroup.create({
                data: { name: 'Accounts Payable', groupId: liabilitiesGroup.id, companyId }
            });

            const taxSub = await prisma.accountsubgroup.create({
                data: { name: 'Duties & Taxes', groupId: liabilitiesGroup.id, companyId }
            });
            await prisma.ledger.create({
                data: { name: 'VAT / Sales Tax Payable', groupId: liabilitiesGroup.id, subGroupId: taxSub.id, companyId, openingBalance: 0, currentBalance: 0 }
            });

            const loansSub = await prisma.accountsubgroup.create({
                data: { name: 'Loans & Borrowings', groupId: liabilitiesGroup.id, companyId }
            });

            // 3. EQUITY
            const equityGroup = await prisma.accountgroup.create({
                data: { name: 'Equity', type: 'EQUITY', companyId }
            });

            const capitalSub = await prisma.accountsubgroup.create({
                data: { name: 'Share Capital', groupId: equityGroup.id, companyId }
            });
            await prisma.ledger.create({
                data: { name: 'Owner Investment / Capital', groupId: equityGroup.id, subGroupId: capitalSub.id, companyId, openingBalance: 0, currentBalance: 0 }
            });

            const equityItemsSub = await prisma.accountsubgroup.create({
                data: { name: 'Equity Items', groupId: equityGroup.id, companyId }
            });
            await prisma.ledger.create({
                data: { name: 'Opening Balance Equity', groupId: equityGroup.id, subGroupId: equityItemsSub.id, companyId, openingBalance: 0, currentBalance: 0 }
            });
            await prisma.ledger.create({
                data: { name: 'Retained Earnings', groupId: equityGroup.id, subGroupId: equityItemsSub.id, companyId, openingBalance: 0, currentBalance: 0 }
            });

            // 4. INCOME
            const incomeGroup = await prisma.accountgroup.create({
                data: { name: 'Income', type: 'INCOME', companyId }
            });

            const salesSub = await prisma.accountsubgroup.create({
                data: { name: 'Sales Income', groupId: incomeGroup.id, companyId }
            });
            await prisma.ledger.create({
                data: { name: 'Sales Revenue', groupId: incomeGroup.id, subGroupId: salesSub.id, companyId, openingBalance: 0, currentBalance: 0 }
            });

            const otherIncomeSub = await prisma.accountsubgroup.create({
                data: { name: 'Other Income', groupId: incomeGroup.id, companyId }
            });

            // 5. EXPENSES
            const expensesGroup = await prisma.accountgroup.create({
                data: { name: 'Expenses', type: 'EXPENSES', companyId }
            });

            const cogsSub = await prisma.accountsubgroup.create({
                data: { name: 'Direct Expenses / COGS', groupId: expensesGroup.id, companyId }
            });
            await prisma.ledger.create({
                data: { name: 'Cost of Goods Sold', groupId: expensesGroup.id, subGroupId: cogsSub.id, companyId, openingBalance: 0, currentBalance: 0 }
            });

            const operatingSub = await prisma.accountsubgroup.create({
                data: { name: 'Operating Expenses', groupId: expensesGroup.id, companyId }
            });
            await prisma.ledger.create({
                data: { name: 'Rent Expense', groupId: expensesGroup.id, subGroupId: operatingSub.id, companyId, openingBalance: 0, currentBalance: 0 }
            });
            await prisma.ledger.create({
                data: { name: 'Electricity & Utilities', groupId: expensesGroup.id, subGroupId: operatingSub.id, companyId, openingBalance: 0, currentBalance: 0 }
            });
            await prisma.ledger.create({
                data: { name: 'Salary & Wages', groupId: expensesGroup.id, subGroupId: operatingSub.id, companyId, openingBalance: 0, currentBalance: 0 }
            });
            await prisma.ledger.create({
                data: { name: 'Inventory Adjustment Expense', groupId: expensesGroup.id, subGroupId: operatingSub.id, companyId, openingBalance: 0, currentBalance: 0 }
            });
        };

        await createCOA();

        return {
            success: true,
            message: 'Professional Chart of Accounts initialized successfully'
        };
    } catch (error) {
        console.error('Error initializing COA:', error);
        throw error;
    }
};


// Get Chart of Accounts
const getChartOfAccounts = async (companyId, filters = {}) => {
    try {
        const { startDate, endDate, search } = filters;

        // Base filter for ledgers
        const ledgerWhere = {
            ...(search ? { name: { contains: search } } : {}),
            ...(startDate || endDate ? {
                createdAt: {
                    ...(startDate ? { gte: new Date(startDate) } : {}),
                    ...(endDate ? { lte: new Date(endDate) } : {})
                }
            } : {})
        };

        const groups = await prisma.accountgroup.findMany({
            where: { companyId },
            include: {
                accountsubgroup: {
                    include: {
                        ledger: {
                            where: {
                                ...ledgerWhere
                            },
                            include: {
                                ledger: true
                            }
                        }
                    }
                },
                ledger: {
                    where: {
                        subGroupId: null,
                        ...ledgerWhere
                    },
                    include: {
                        ledger: true
                    }
                }
            },
            orderBy: { type: 'asc' }
        });

        return groups;
    } catch (error) {
        console.error('Error fetching COA:', error);
        throw error;
    }
};

// Create Account Group
const createAccountGroup = async (data) => {
    try {
        const group = await prisma.accountgroup.create({
            data: {
                name: data.name,
                type: data.type,
                companyId: data.companyId
            }
        });

        return group;
    } catch (error) {
        console.error('Error creating account group:', error);
        throw error;
    }
};

// Create Account Sub Group
const createAccountSubGroup = async (data) => {
    try {
        const subGroup = await prisma.accountsubgroup.create({
            data: {
                name: data.name,
                groupId: data.groupId,
                companyId: data.companyId
            }
        });

        return subGroup;
    } catch (error) {
        console.error('Error creating account sub group:', error);
        throw error;
    }
};

// Helper to map frontend account types to backend AccountGroup types
const resolveGroupType = (accountType) => {
    const typeMap = {
        'current_asset': 'ASSETS',
        'inventory_asset': 'ASSETS',
        'non_current_asset': 'ASSETS',
        'current_liability': 'LIABILITIES',
        'long_term_liability': 'LIABILITIES',
        'share_capital': 'LIABILITIES',
        'retained_earnings': 'LIABILITIES',
        'owners_equity': 'EQUITY',
        'sales_revenue': 'INCOME',
        'other_revenue': 'INCOME',
        'inventory_gain': 'INCOME',
        'cogs': 'EXPENSES',
        'payroll': 'EXPENSES',
        'general': 'EXPENSES'
    };
    return typeMap[accountType] || null;
};

// Create Ledger
const createLedger = async (data) => {
    try {
        let groupId = data.groupId;

        // Logic to automatically resolve groupId if not provided
        if (!groupId) {
            // Priority: Derive from Account Type (Parent Logic Removed by User Request)
            if (data.accountType) {
                const groupType = resolveGroupType(data.accountType);
                if (groupType) {
                    const group = await prisma.accountgroup.findFirst({
                        where: {
                            companyId: data.companyId,
                            type: groupType
                        }
                    });
                    if (group) {
                        groupId = group.id;
                    } else {
                        console.log(`Debug COA: Group not found. CompanyID: ${data.companyId}, Type: ${groupType}`);
                        // Fallback: Try loose name match if enum types mismatched
                        const looseGroup = await prisma.accountgroup.findFirst({
                            where: { companyId: data.companyId, name: { contains: groupType === 'EXPENSES' ? 'Expense' : groupType } }
                        });
                        if (looseGroup) groupId = looseGroup.id;
                    }
                }
            }
        }

        if (!groupId) {
            throw new Error(`Could not resolve Account Group. Please provide valid Account Type. (Debug: Type=${data.accountType || 'None'})`);
        }

        const ledger = await prisma.ledger.create({
            data: {
                name: data.name,
                groupId: groupId,
                subGroupId: data.subGroupId,
                companyId: data.companyId,
                openingBalance: parseFloat(data.openingBalance || 0),
                currentBalance: parseFloat(data.openingBalance || 0),
                isControlAccount: data.isControlAccount || false,
                isEnabled: data.isEnabled !== undefined ? data.isEnabled : true,
                description: data.description,
                parentLedgerId: data.parentLedgerId ? parseInt(data.parentLedgerId) : null,
                updatedAt: new Date()
            },
            include: { accountgroup: true }
        });

        // Accounting Logic: Professional systems balance Opening Balances against "Opening Balance Equity"
        const openingBal = parseFloat(data.openingBalance || 0);
        if (openingBal !== 0) {
            try {
                // Find or Create Opening Balance Equity ledger
                let obeLedger = await prisma.ledger.findFirst({
                    where: { companyId: data.companyId, name: 'Opening Balance Equity' }
                });

                if (!obeLedger) {
                    const equityGroup = await prisma.accountgroup.findFirst({ where: { companyId: data.companyId, type: 'EQUITY' } });
                    if (equityGroup) {
                        obeLedger = await prisma.ledger.create({
                            data: {
                                name: 'Opening Balance Equity',
                                groupId: equityGroup.id,
                                companyId: data.companyId,
                                isControlAccount: true
                            }
                        });
                    }
                }

                if (obeLedger) {
                    const isDrNormal = ['ASSETS', 'EXPENSES'].includes(ledger.accountgroup.type);
                    
                    await prisma.transaction.create({
                        data: {
                            date: new Date(),
                            amount: Math.abs(openingBal),
                            debitLedgerId: isDrNormal ? ledger.id : obeLedger.id,
                            creditLedgerId: isDrNormal ? obeLedger.id : ledger.id,
                            voucherType: 'JOURNAL',
                            voucherNumber: `OB-${ledger.id}`,
                            narration: `Opening Balance for ${ledger.name}`,
                            companyId: data.companyId
                        }
                    });

                    // Update OBE balance
                    const obeChange = isDrNormal ? -openingBal : openingBal;
                    await prisma.ledger.update({
                        where: { id: obeLedger.id },
                        data: { currentBalance: { increment: obeChange } }
                    });
                }
            } catch (obeError) {
                console.error('Failed to create opening balance entry:', obeError);
            }
        }

        return ledger;

    } catch (error) {
        console.error('Error creating ledger:', error);
        throw error;
    }
};

// Get Ledger by ID
const getLedgerById = async (id, companyId) => {
    try {
        const ledger = await prisma.ledger.findFirst({
            where: {
                id: parseInt(id),
                companyId: companyId
            },
            include: {
                accountgroup: true,
                accountsubgroup: true,
                ledger: true,
                other_ledger: true,
                transaction_transaction_creditLedgerIdToledger: {
                    include: {
                        ledger_transaction_creditLedgerIdToledger: true
                    }
                },
                transaction_transaction_debitLedgerIdToledger: {
                    include: {
                        ledger_transaction_debitLedgerIdToledger: true
                    }
                }
            }
        });

        return ledger;
    } catch (error) {
        console.error('Error fetching ledger:', error);
        throw error;
    }
};

// Get Ledger Transactions
const getLedgerTransactions = async (ledgerId, companyId) => {
    try {
        const transactions = await prisma.transaction.findMany({
            where: {
                companyId: companyId,
                OR: [
                    { debitLedgerId: parseInt(ledgerId) },
                    { creditLedgerId: parseInt(ledgerId) }
                ]
            },
            include: {
                ledger_transaction_debitLedgerIdToledger: true,
                ledger_transaction_creditLedgerIdToledger: true,
                invoice: {
                    include: {
                        customer: {
                            select: { id: true, name: true, nameArabic: true, phone: true, email: true }
                        }
                    }
                },
                purchasebill: {
                    include: {
                        vendor: {
                            select: { id: true, name: true, nameArabic: true, phone: true, email: true }
                        }
                    }
                },
                receipt: {
                    include: {
                        customer: {
                            select: { id: true, name: true, nameArabic: true, phone: true, email: true }
                        }
                    }
                },
                payment: {
                    include: {
                        vendor: {
                            select: { id: true, name: true, nameArabic: true, phone: true, email: true }
                        }
                    }
                }
            },
            orderBy: { date: 'desc' }
        });

        return transactions;
    } catch (error) {
        console.error('Error fetching ledger transactions:', error);
        throw error;
    }
};

// Update Ledger Balance
const updateLedgerBalance = async (ledgerId, amount, isDebit) => {
    try {
        const ledger = await prisma.ledger.findUnique({
            where: { id: ledgerId }
        });

        const newBalance = isDebit
            ? ledger.currentBalance + amount
            : ledger.currentBalance - amount;

        await prisma.ledger.update({
            where: { id: ledgerId },
            data: { currentBalance: newBalance, updatedAt: new Date() }
        });

        return newBalance;
    } catch (error) {
        console.error('Error updating ledger balance:', error);
        throw error;
    }
};

// Get Account Group by ID
const getAccountGroupById = async (id, companyId) => {
    try {
        const group = await prisma.accountgroup.findFirst({
            where: {
                id: parseInt(id),
                companyId: companyId
            },
            include: {
                accountsubgroup: {
                    include: {
                        ledger: true
                    }
                },
                ledger: {
                    where: {
                        subGroupId: null
                    }
                }
            }
        });

        return group;
    } catch (error) {
        console.error('Error fetching account group:', error);
        throw error;
    }
};

// Update Account Group
const updateAccountGroup = async (id, companyId, data) => {
    try {
        const group = await prisma.accountgroup.updateMany({
            where: {
                id: parseInt(id),
                companyId: companyId
            },
            data: {
                name: data.name,
                type: data.type,
                updatedAt: new Date()
            }
        });

        if (group.count === 0) {
            throw new Error('Account group not found or no changes made');
        }

        return await prisma.accountgroup.findUnique({
            where: { id: parseInt(id) }
        });
    } catch (error) {
        console.error('Error updating account group:', error);
        throw error;
    }
};

// Delete Account Group
const deleteAccountGroup = async (id, companyId) => {
    try {
        const result = await prisma.accountgroup.deleteMany({
            where: {
                id: parseInt(id),
                companyId: companyId
            }
        });

        if (result.count === 0) {
            throw new Error('Account group not found');
        }

        return true;
    } catch (error) {
        console.error('Error deleting account group:', error);
        throw error;
    }
};

// Get Account Sub Group by ID
const getAccountSubGroupById = async (id, companyId) => {
    try {
        const subGroup = await prisma.accountsubgroup.findFirst({
            where: {
                id: parseInt(id),
                companyId: companyId
            },
            include: {
                accountgroup: true,
                ledger: true
            }
        });

        return subGroup;
    } catch (error) {
        console.error('Error fetching account sub-group:', error);
        throw error;
    }
};

// Update Account Sub Group
const updateAccountSubGroup = async (id, companyId, data) => {
    try {
        const subGroup = await prisma.accountsubgroup.updateMany({
            where: {
                id: parseInt(id),
                companyId: companyId
            },
            data: {
                name: data.name,
                groupId: parseInt(data.groupId),
                updatedAt: new Date()
            }
        });

        if (subGroup.count === 0) {
            throw new Error('Account sub-group not found or no changes made');
        }

        return await prisma.accountsubgroup.findUnique({
            where: { id: parseInt(id) },
            include: { accountgroup: true }
        });
    } catch (error) {
        console.error('Error updating account sub-group:', error);
        throw error;
    }
};

// Delete Account Sub Group
const deleteAccountSubGroup = async (id, companyId) => {
    try {
        const result = await prisma.accountsubgroup.deleteMany({
            where: {
                id: parseInt(id),
                companyId: companyId
            }
        });

        if (result.count === 0) {
            throw new Error('Account sub-group not found');
        }

        return true;
    } catch (error) {
        console.error('Error deleting account sub-group:', error);
        throw error;
    }
};

// Get All Ledgers
const getAllLedgers = async (companyId) => {
    try {
        const ledgers = await prisma.ledger.findMany({
            where: { companyId },
            include: {
                accountgroup: true,
                accountsubgroup: true,
                ledger: true
            },
            orderBy: { name: 'asc' }
        });

        return ledgers;
    } catch (error) {
        console.error('Error fetching ledgers:', error);
        throw error;
    }
};

// Update Ledger
const updateLedger = async (id, companyId, data) => {
    try {
        const ledger = await prisma.ledger.updateMany({
            where: {
                id: parseInt(id),
                companyId: companyId
            },
            data: {
                name: data.name,
                groupId: data.groupId,
                subGroupId: data.subGroupId,
                openingBalance: data.openingBalance,
                isControlAccount: data.isControlAccount,
                isEnabled: data.isEnabled,
                description: data.description,
                parentLedgerId: data.parentLedgerId ? parseInt(data.parentLedgerId) : null,
                updatedAt: new Date()
            }
        });

        if (ledger.count === 0) {
            throw new Error('Ledger not found or no changes made');
        }

        return await prisma.ledger.findUnique({
            where: { id: parseInt(id) },
            include: {
                accountgroup: true,
                accountsubgroup: true,
                ledger: true
            }
        });
    } catch (error) {
        console.error('Error updating ledger:', error);
        throw error;
    }
};

// Delete Ledger
const deleteLedger = async (id, companyId) => {
    try {
        const ledgerId = parseInt(id);

        // 1. Check for associated transactions
        const transactionCount = await prisma.transaction.count({
            where: {
                companyId: companyId,
                OR: [
                    { debitLedgerId: ledgerId },
                    { creditLedgerId: ledgerId }
                ]
            }
        });

        if (transactionCount > 0) {
            throw new Error('Cannot delete account because it has associated transactions. Please delete the transactions first.');
        }

        const result = await prisma.ledger.deleteMany({
            where: {
                id: ledgerId,
                companyId: companyId
            }
        });

        if (result.count === 0) {
            throw new Error('Ledger not found');
        }

        return true;
    } catch (error) {
        console.error('Error deleting ledger:', error);
        throw error;
    }
};

module.exports = {
    initializeChartOfAccounts,
    getChartOfAccounts,
    createAccountGroup,
    createAccountSubGroup,
    createLedger,
    getLedgerById,
    getLedgerTransactions,
    updateLedgerBalance,
    getAccountGroupById,
    updateAccountGroup,
    deleteAccountGroup,
    getAccountSubGroupById,
    updateAccountSubGroup,
    deleteAccountSubGroup,
    getAllLedgers,
    updateLedger,
    deleteLedger
};
