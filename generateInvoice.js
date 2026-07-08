const PDFDocument = require('pdfkit');
const fs = require('fs');
const axios = require('axios');

async function generateInvoice(order, customer, items) {
    // Download logo
    const logoPath = `/tmp/durauto_logo_${order.order_id}.png`;
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
        const doc = new PDFDocument({ margin: 50, size: 'A4' });

        const publicDir = '/tmp/invoices';
        if (!fs.existsSync(publicDir)) {
            fs.mkdirSync(publicDir, { recursive: true });
        }

        const fileName = `invoice_${order.order_id}.pdf`;
        const filePath = `${publicDir}/${fileName}`;
        const stream = fs.createWriteStream(filePath);

        doc.pipe(stream);

        // ─── Colors ───────────────────────────────────────────────
        const darkGray = '#333333';
        const lightGray = '#f5f5f5';
        const borderGray = '#dddddd';
        const blue = '#1a5276';

        // ─── Title ────────────────────────────────────────────────
        doc.fontSize(20).fillColor(darkGray).font('Helvetica')
            .text('Invoice', 50, 40, { align: 'center', width: 495 });

        doc.moveTo(50, 65).lineTo(545, 65).strokeColor(borderGray).lineWidth(1).stroke();

        // ─── Header: Logo + Company Info + Contact ────────────────
        const headerTop = 75;

        if (fs.existsSync(logoPath)) {
            doc.image(logoPath, 50, headerTop, { width: 130 });
        }

        doc.fontSize(9).fillColor(darkGray).font('Helvetica')
            .text('Email: adhirajchaudhary@gmail.com', 300, headerTop + 10, { align: 'right', width: 245 })
            .text('Website: https://durautopartsusa.com/', 300, headerTop + 24, { align: 'right', width: 245 });

        doc.fontSize(11).fillColor(blue).font('Helvetica-Bold')
            .text('Durauto Parts LLC', 50, headerTop + 70);
        doc.fontSize(9).fillColor(darkGray).font('Helvetica')
            .text('9100 Galveston Rd', 50, headerTop + 84)
            .text('Houston, TX 77034, United States', 50, headerTop + 97)
            .text('Powering Through Loads', 50, headerTop + 110);

        doc.moveTo(50, 215).lineTo(545, 215).strokeColor(borderGray).lineWidth(1).stroke();

        // ─── Invoice Meta Row ──────────────────────────────────────
        const metaY = 225;
        const colW = 123;

        doc.fontSize(8).fillColor('#888888').font('Helvetica')
            .text('INVOICE NO', 50, metaY)
            .text('INVOICE DATE', 50 + colW, metaY)
            .text('PAYMENT STATUS', 50 + colW * 2, metaY)
            .text('TOTAL AMOUNT', 50 + colW * 3, metaY);

        // Calculate total
        let total = 0;
        items.forEach(item => {
            const price = parseFloat(item.price_at_order) || 0;
            total += price * item.quantity;
        });

        const invoiceDate = new Date(order.created_at).toLocaleDateString('en-US', {
            day: '2-digit', month: 'short', year: 'numeric'
        });

        doc.fontSize(10).fillColor(darkGray).font('Helvetica-Bold')
            .text(`#${order.order_id}`, 50, metaY + 14)
            .text(invoiceDate, 50 + colW, metaY + 14);
        doc.font('Helvetica')
            .text('Net 30', 50 + colW * 2, metaY + 14);
        doc.font('Helvetica-Bold')
            .text(`$ ${total.toFixed(2)}`, 50 + colW * 3, metaY + 14);

        doc.moveTo(50, metaY + 35).lineTo(545, metaY + 35).strokeColor(borderGray).lineWidth(1).stroke();

        // ─── Billing / Shipping Address ────────────────────────────
        const addrY = metaY + 45;

        doc.fontSize(8).fillColor('#888888').font('Helvetica')
            .text('BILLING ADDRESS', 50, addrY)
            .text('SHIPPING ADDRESS', 300, addrY);

        const storeName = customer.store_name || 'Unknown Store';
        const address = customer.address || '';
        const phone = customer.phone ? customer.phone.replace('whatsapp:', '') : '';
        const contactName = customer.contact_name || '';

        // Store name bold
        doc.fontSize(10).fillColor(darkGray).font('Helvetica-Bold')
            .text(storeName, 50, addrY + 15)
            .text(storeName, 300, addrY + 15);

        doc.fontSize(9).font('Helvetica').fillColor(darkGray);

        // Left column — Billing
        let leftY = addrY + 30;
        if (contactName && contactName !== 'Unknown Contact') {
            doc.text(contactName, 50, leftY, { width: 220 });
            leftY += 13;
        }
        if (address) {
            doc.text(address, 50, leftY, { width: 220 });
            leftY += 13;
        }
        if (phone) {
            doc.text(`Phone: ${phone}`, 50, leftY, { width: 220 });
        }

        // Right column — Shipping
        let rightY = addrY + 30;
        if (contactName && contactName !== 'Unknown Contact') {
            doc.text(contactName, 300, rightY, { width: 220 });
            rightY += 13;
        }
        if (address) {
            doc.text(address, 300, rightY, { width: 220 });
            rightY += 13;
        }
        if (phone) {
            doc.text(`Phone: ${phone}`, 300, rightY, { width: 220 });
        }

        // Divider after address section
        const afterAddrY = Math.max(leftY, rightY) + 20;
        doc.moveTo(50, afterAddrY).lineTo(545, afterAddrY).strokeColor(borderGray).lineWidth(1).stroke();

        // ─── Items Table Header ────────────────────────────────────
        const tableY = afterAddrY + 8;

        doc.rect(50, tableY, 495, 22).fillColor(lightGray).fill();
        doc.fontSize(9).fillColor(darkGray).font('Helvetica-Bold')
            .text('#', 55, tableY + 7)
            .text('Product Details', 105, tableY + 7)
            .text('Unit Price', 310, tableY + 7)
            .text('Qty', 390, tableY + 7)
            .text('Tax', 430, tableY + 7)
            .text('Amount', 490, tableY + 7);

        doc.moveTo(50, tableY + 22).lineTo(545, tableY + 22)
            .strokeColor(borderGray).lineWidth(1).stroke();

        // ─── Items ────────────────────────────────────────────────
        let rowY = tableY + 32;
        items.forEach((item) => {
            const price = parseFloat(item.price_at_order) || 0;
            const amount = price * item.quantity;

            doc.fontSize(9).fillColor(darkGray).font('Helvetica-Bold')
                .text(item.durauto_part_number, 55, rowY);
            doc.font('Helvetica')
                .text(item.part_name, 105, rowY, { width: 195 })
                .text(`$ ${price.toFixed(2)}`, 310, rowY)
                .text(item.quantity.toString(), 398, rowY)
                .text('Tax Exempt', 425, rowY)
                .text(`$${amount.toFixed(2)}`, 490, rowY);

            rowY += 28;
            doc.moveTo(50, rowY - 5).lineTo(545, rowY - 5)
                .strokeColor(borderGray).lineWidth(0.5).stroke();
        });

        // ─── Totals ───────────────────────────────────────────────
        const totalsX = 360;
        const totalsY = rowY + 10;

        doc.fontSize(9).fillColor(darkGray).font('Helvetica')
            .text('Sub Total', totalsX, totalsY, { width: 130 })
            .text(`$ ${total.toFixed(2)}`, 490, totalsY)
            .text('Shipping Charges', totalsX, totalsY + 18, { width: 130 })
            .text('$ 00.00', 490, totalsY + 18)
            .text('Advance Amount', totalsX, totalsY + 36, { width: 130 })
            .text('$ 00.00', 490, totalsY + 36);

        doc.moveTo(totalsX, totalsY + 52).lineTo(545, totalsY + 52)
            .strokeColor(borderGray).lineWidth(1).stroke();

        doc.fontSize(10).font('Helvetica-Bold').fillColor(darkGray)
            .text('Total Amount', totalsX, totalsY + 60, { width: 130 })
            .text(`$ ${total.toFixed(2)}`, 490, totalsY + 60);

        doc.end();

        stream.on('finish', () => {
            if (fs.existsSync(logoPath)) fs.unlinkSync(logoPath);
            console.log(`Invoice generated: ${filePath}`);
            resolve(filePath);
        });

        stream.on('error', reject);
    });
}

module.exports = { generateInvoice };