const PDFDocument = require('pdfkit');
const cloudinary = require('cloudinary').v2;
const fs = require('fs');
const axios = require('axios');

cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});
console.log('Cloudinary config:', {
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME || 'MISSING',
    api_key: process.env.CLOUDINARY_API_KEY ? 'EXISTS' : 'MISSING',
    api_secret: process.env.CLOUDINARY_API_SECRET ? 'EXISTS' : 'MISSING'
});

async function generateInvoice(order, customer, items) {
    // Download logo first
    const logoPath = `/tmp/durauto_logo.png`;
    try {
        const logoResponse = await axios.get(
            'https://res.cloudinary.com/ulor4ikf/image/upload/v1782852493/Durauto_logo_truck_and_trailer_parts_print_ready_xbsptj.png',
            { responseType: 'arraybuffer' }
        );
        fs.writeFileSync(logoPath, logoResponse.data);
    } catch (err) {
        console.error('Could not download logo:', err.message);
    }

    return new Promise((resolve, reject) => {
        const doc = new PDFDocument({ margin: 50 });
        const tempPath = `/tmp/invoice_${order.order_id}.pdf`;
        const stream = fs.createWriteStream(tempPath);

        doc.pipe(stream);

        // ─── Colors ───────────────────────────────────────────
        const darkGray = '#333333';
        const lightGray = '#f5f5f5';
        const borderGray = '#dddddd';
        const blue = '#1a5276';

        // ─── Title ────────────────────────────────────────────
        doc.fontSize(22).fillColor(darkGray).font('Helvetica')
            .text('Invoice', { align: 'center' });
        doc.moveDown(0.5);
        doc.moveTo(50, doc.y).lineTo(562, doc.y).strokeColor(borderGray).stroke();
        doc.moveDown(0.5);

        // ─── Header: Logo + Company Info + Contact ────────────
        const headerTop = doc.y;

        // Logo
        if (fs.existsSync(logoPath)) {
            doc.image(logoPath, 50, headerTop, { width: 130 });
        }

        // Company info below logo
        doc.fontSize(11).fillColor(blue).font('Helvetica-Bold')
            .text('Durauto Parts LLC', 50, headerTop + 70);
        doc.fontSize(9).fillColor(darkGray).font('Helvetica')
            .text('9100 Galveston Rd', 50, doc.y + 3)
            .text('Houston, TX 77034, United States', 50, doc.y + 3)
            .text('Powering Through Loads', 50, doc.y + 3);

        // Contact info on the right
        doc.fontSize(9).fillColor(darkGray).font('Helvetica')
            .text('Email: adhirajchaudhary@gmail.com', 300, headerTop + 10, { align: 'right', width: 262 })
            .text('Website: https://durautopartsusa.com/', 300, doc.y + 4, { align: 'right', width: 262 });

        // Move past header
        doc.moveDown(3);
        doc.moveTo(50, doc.y).lineTo(562, doc.y).strokeColor(borderGray).stroke();
        doc.moveDown(0.5);

        // ─── Invoice Meta Row ──────────────────────────────────
        const metaTop = doc.y;
        const colW = 128;

        // Labels
        doc.fontSize(8).fillColor('#888888').font('Helvetica')
            .text('INVOICE NO', 50, metaTop)
            .text('INVOICE DATE', 50 + colW, metaTop)
            .text('PAYMENT STATUS', 50 + colW * 2, metaTop)
            .text('TOTAL AMOUNT', 50 + colW * 3, metaTop);

        // Calculate total
        let total = 0;
        items.forEach(item => {
            const price = parseFloat(item.price_at_order) || 0;
            total += price * item.quantity;
        });

        // Format date
        const invoiceDate = new Date(order.created_at).toLocaleDateString('en-US', {
            day: '2-digit', month: 'short', year: 'numeric'
        });

        // Values
        doc.fontSize(10).fillColor(darkGray).font('Helvetica-Bold')
            .text(`#${order.order_id}`, 50, metaTop + 15)
            .text(invoiceDate, 50 + colW, metaTop + 15);
        doc.font('Helvetica')
            .text('Net 30', 50 + colW * 2, metaTop + 15);
        doc.font('Helvetica-Bold')
            .text(`$ ${total.toFixed(2)}`, 50 + colW * 3, metaTop + 15);

        doc.moveDown(2.5);
        doc.moveTo(50, doc.y).lineTo(562, doc.y).strokeColor(borderGray).stroke();
        doc.moveDown(0.5);

        // ─── Billing / Shipping Address ────────────────────────
        const addrTop = doc.y;

        doc.fontSize(8).fillColor('#888888').font('Helvetica')
            .text('BILLING ADDRESS', 50, addrTop)
            .text('SHIPPING ADDRESS', 300, addrTop);

        const storeName = customer.store_name || 'Unknown Store';
        const address = customer.address || '';
        const phone = customer.phone ? customer.phone.replace('whatsapp:', '') : '';

        doc.fontSize(10).fillColor(darkGray).font('Helvetica-Bold')
            .text(storeName, 50, addrTop + 15)
            .text(storeName, 300, addrTop + 15);

        doc.fontSize(9).font('Helvetica')
            .text(address, 50, addrTop + 30, { width: 220 })
            .text(`Phone: ${phone}`, 50, addrTop + 45);

        doc.fontSize(9).font('Helvetica')
            .text(address, 300, addrTop + 30, { width: 220 })
            .text(`Phone: ${phone}`, 300, addrTop + 45);

        doc.moveDown(4);
        doc.moveTo(50, doc.y).lineTo(562, doc.y).strokeColor(borderGray).stroke();
        doc.moveDown(0.3);

        // ─── Items Table Header ────────────────────────────────
        const tableTop = doc.y;

        doc.rect(50, tableTop, 512, 22).fillColor(lightGray).fill();
        doc.fontSize(9).fillColor(darkGray).font('Helvetica-Bold')
            .text('#', 55, tableTop + 7)
            .text('Product Details', 100, tableTop + 7)
            .text('Unit Price', 320, tableTop + 7)
            .text('Qty', 400, tableTop + 7)
            .text('Tax', 440, tableTop + 7)
            .text('Amount', 500, tableTop + 7);

        doc.moveTo(50, tableTop + 22).lineTo(562, tableTop + 22)
            .strokeColor(borderGray).stroke();

        // ─── Items ────────────────────────────────────────────
        let rowY = tableTop + 30;
        items.forEach((item) => {
            const price = parseFloat(item.price_at_order) || 0;
            const amount = price * item.quantity;

            doc.fontSize(9).fillColor(darkGray).font('Helvetica-Bold')
                .text(item.durauto_part_number, 55, rowY);
            doc.font('Helvetica')
                .text(item.part_name, 100, rowY, { width: 210 })
                .text(`$ ${price.toFixed(2)}`, 320, rowY)
                .text(item.quantity.toString(), 408, rowY)
                .text('Tax Exempt', 435, rowY)
                .text(`$${amount.toFixed(2)}`, 500, rowY);

            rowY += 28;
            doc.moveTo(50, rowY - 5).lineTo(562, rowY - 5)
                .strokeColor(borderGray).stroke();
        });

        // ─── Totals ───────────────────────────────────────────
        const totalsX = 360;
        const totalsY = rowY + 10;

        doc.fontSize(9).fillColor(darkGray).font('Helvetica')
            .text('Sub Total', totalsX, totalsY)
            .text(`$ ${total.toFixed(2)}`, 500, totalsY)
            .text('Shipping Charges', totalsX, totalsY + 18)
            .text('$ 00.00', 500, totalsY + 18)
            .text('Advance Amount', totalsX, totalsY + 36)
            .text('$ 00.00', 500, totalsY + 36);

        doc.moveTo(totalsX, totalsY + 54).lineTo(562, totalsY + 54)
            .strokeColor(borderGray).stroke();

        doc.fontSize(10).font('Helvetica-Bold').fillColor(darkGray)
            .text('Total Amount', totalsX, totalsY + 62)
            .text(`$ ${total.toFixed(2)}`, 500, totalsY + 62);

        doc.end();

        stream.on('finish', async () => {
            try {
                // Upload PDF to Cloudinary
                const result = await cloudinary.uploader.upload(tempPath, {
    resource_type: 'raw',
    public_id: `invoices/invoice_${order.order_id}`,
    format: 'pdf'
});

// Clean up temp files
fs.unlinkSync(tempPath);
if (fs.existsSync(logoPath)) fs.unlinkSync(logoPath);

// Add .pdf extension so WhatsApp can open it
const pdfUrl = result.secure_url;
console.log(`Invoice uploaded: ${pdfUrl}`);
resolve(pdfUrl);
            } catch (err) {
                reject(err);
            }
        });

        stream.on('error', reject);
    });
}

module.exports = { generateInvoice };