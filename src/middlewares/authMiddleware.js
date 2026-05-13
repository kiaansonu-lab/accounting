const jwt = require('jsonwebtoken');
const prisma = require('../config/prisma');

// Simple in-memory cache for company expiry checks
const expiryCache = new Map();
const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes

const authenticateToken = async (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
        return res.status(401).json({ message: 'Access token required' });
    }

    try {
        const user = jwt.verify(token, process.env.JWT_SECRET);
        
        // Check for company plan expiration
        if (user.role !== 'SUPERADMIN' && user.companyId) {
            const now = Date.now();
            const cached = expiryCache.get(user.companyId);

            let isExpired = false;
            let expiryDate = null;

            if (cached && (now - cached.timestamp < CACHE_DURATION)) {
                isExpired = cached.isExpired;
            } else {
                const company = await prisma.company.findUnique({
                    where: { id: parseInt(user.companyId) },
                    select: { endDate: true }
                });

                if (company && company.endDate) {
                    expiryDate = new Date(company.endDate);
                    const today = new Date();
                    today.setHours(0, 0, 0, 0);
                    isExpired = expiryDate < today;
                }

                // Update cache
                expiryCache.set(user.companyId, { timestamp: now, isExpired });
            }

            if (isExpired) {
                return res.status(403).json({ 
                    message: 'Your company plan has expired. Please contact super admin to renew your plan.',
                    isExpired: true 
                });
            }
        }

        req.user = user;
        next();
    } catch (err) {
        return res.status(403).json({ message: 'Invalid or expired token' });
    }
};

const authorizeRoles = (...allowedRoles) => {
    return (req, res, next) => {
        if (!req.user || !allowedRoles.includes(req.user.role)) {
            return res.status(403).json({ message: 'Access denied: Insufficient permissions' });
        }
        next();
    };
};

const authorizePermissions = (requiredPermission) => {
    return (req, res, next) => {
        if (!req.user) {
            return res.status(401).json({ message: 'Authentication required' });
        }

        // Superadmin and Company Owner bypass all permission checks
        if (req.user.role === 'SUPERADMIN' || req.user.role === 'COMPANY') {
            return next();
        }

        const permissions = req.user.permissions || [];
        
        if (!permissions.includes(requiredPermission)) {
            return res.status(403).json({ 
                message: `Access denied: You do not have permission to ${requiredPermission}`,
                requiredPermission 
            });
        }

        next();
    };
};

module.exports = { authenticateToken, authorizeRoles, authorizePermissions };
