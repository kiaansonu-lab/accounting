const express = require('express');
const router = express.Router();
const posController = require('../controllers/posController');
const { authenticateToken } = require('../middlewares/authMiddleware'); // Assuming auth middleware exists

router.post('/', authenticateToken, posController.createPOSInvoice);
router.get('/', authenticateToken, posController.getPOSInvoices);
router.get('/:id', authenticateToken, posController.getPOSInvoiceById);
router.get('/public/:id', posController.getPublicPOSInvoiceById);
router.delete('/:id', authenticateToken, posController.deletePOSInvoice);

module.exports = router;
