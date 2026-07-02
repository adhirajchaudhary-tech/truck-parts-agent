require('dotenv').config({ path: '/app/.env' });
const express = require('express');
const twilio = require('twilio');
const Anthropic = require('@anthropic-ai/sdk');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const { generateInvoice } = require('./generateInvoice');

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const client = new Anthropic();
const dbPath = process.env.NODE_ENV === 'production' ? '/data/durauto.db' : 'durauto.db';
const db = new Database(dbPath);
console.log('TWILIO_SID exists:', !!process.env.TWILIO_ACCOUNT_SID);
console.log('TWILIO_TOKEN exists:', !!process.env.TWILIO_AUTH_TOKEN);
console.log('ANTHROPIC_KEY exists:', !!process.env.ANTHROPIC_API_KEY);

const twilioClient = twilio(
    process.env.TWILIO_ACCOUNT_SID,
    process.env.TWILIO_AUTH_TOKEN
);

const conversations = {};

// ─── Database Functions ───────────────────────────────────────────────────────

function findProduct(searchTerm) {
    const term = searchTerm.trim().toUpperCase();

    let product = db.prepare(`
        SELECT * FROM products 
        WHERE UPPER(durauto_part_number) = ?
    `).get(term);

    if (!product) {
        const ref = db.prepare(`
            SELECT durauto_part_number FROM cross_references 
            WHERE UPPER(cross_ref_number) = ?
        `).get(term);

        if (ref) {
            product = db.prepare(`
                SELECT * FROM products 
                WHERE durauto_part_number = ?
            `).get(ref.durauto_part_number);
        }
    }

    if (!product) {
        product = db.prepare(`
            SELECT * FROM products 
            WHERE UPPER(durauto_part_number) LIKE ?
        `).get(`%${term}%`);
    }

    if (product) {
        const crossRefs = db.prepare(`
            SELECT cross_ref_number FROM cross_references 
            WHERE durauto_part_number = ?
        `).all(product.durauto_part_number);
        product.cross_references = crossRefs.map(r => r.cross_ref_number);
    }

    return product;
}

function getCustomerPrice(customerId, durautoPartNumber) {
    const customPrice = db.prepare(`
        SELECT price FROM customer_pricing
        WHERE customer_id = ? AND durauto_part_number = ?
    `).get(customerId, durautoPartNumber);

    if (customPrice) {
        return customPrice.price.toFixed(2);
    }

    const product = db.prepare(`
        SELECT price FROM products
        WHERE durauto_part_number = ?
    `).get(durautoPartNumber);

    return product && product.price ? product.price : null;
}

function generateOrderId() {
    const count = db.prepare('SELECT COUNT(*) as count FROM orders').get();
    const next = 1001 + count.count + 1;
    return `DRA${next}`;
}

function saveOrder(customerId, items) {
    const orderId = generateOrderId();
    db.prepare(`
        INSERT INTO orders (order_id, customer_id, status)
        VALUES (?, ?, 'confirmed')
    `).run(orderId, customerId);

    for (const item of items) {
        db.prepare(`
            INSERT INTO order_items (order_id, durauto_part_number, part_name, quantity, price_at_order)
            VALUES (?, ?, ?, ?, ?)
        `).run(orderId, item.durauto_part_number, item.part_name, item.quantity, item.price);
    }

    return orderId;
}

function getOrderHistory(customerId) {
    const orders = db.prepare(`
        SELECT * FROM orders 
        WHERE customer_id = ?
        ORDER BY created_at DESC
        LIMIT 10
    `).all(customerId);

    for (const order of orders) {
        order.items = db.prepare(`
            SELECT * FROM order_items WHERE order_id = ?
        `).all(order.order_id);
    }

    return orders;
}

function findOrCreateCustomer(phone) {
    const normalizedPhone = phone.replace('whatsapp:', '');

    let customer = db.prepare(`
        SELECT * FROM customers WHERE phone = ? OR phone = ?
    `).get(normalizedPhone, phone);

    if (!customer) {
        const count = db.prepare('SELECT COUNT(*) as count FROM customers').get();
        const customerId = `CUST-${(count.count + 1).toString().padStart(3, '0')}`;

        db.prepare(`
            INSERT INTO customers (customer_id, phone, store_name, contact_name)
            VALUES (?, ?, 'Unknown Store', 'Unknown Contact')
        `).run(customerId, normalizedPhone);

        customer = db.prepare(`
            SELECT * FROM customers WHERE phone = ?
        `).get(normalizedPhone);

        console.log(`New customer created: ${customerId} — ${normalizedPhone}`);
    }

    return customer;
}

// ─── System Prompt ────────────────────────────────────────────────────────────

const systemPrompt = `
You are Vertus, the ordering assistant for Durauto Parts LLC — a distributor of heavy-duty truck parts.

You help retail customers do the following:
1. Place new orders by part number and quantity
2. View their order history
3. Reorder from a previous order with option to adjust quantities
4. Get product specifications
5. View product photos

Your personality:
- Friendly, professional, and efficient
- Keep responses short and clear — customers are on WhatsApp, not a computer
- Use plain text formatting — avoid markdown tables, use simple lists instead
- Always confirm orders before finalizing
- Never make up product details
- CRITICAL: Send only ONE message per customer message. Never send a follow up. Never say "OK" or "Okay" as a separate message or at the start of a reply. Get straight to the point.

How you handle orders:
- Extract part number and quantity from the customer's message
- Confirm the order back clearly before finalizing
- When the customer confirms with yes, include this exact tag in your response:
  [SAVE_ORDER: partNumber=X, quantity=Y, partName=Z, price=P]
- For multiple items use one tag per item on separate lines
- Only include the SAVE_ORDER tag after the customer confirms with yes

How you handle photo requests:
- When a customer asks to see a photo or image of a product, include this exact tag in your response:
  [SEND_PHOTO: partNumber=X]
- Replace X with the exact Durauto Part # of the product
- Only include this tag if Photo Available is Yes for that product
- If Photo Available is No, tell the customer no photo is available yet

How you handle product lookups:
- Use ONLY the product data provided to you
- Present specs in simple plain text — no markdown tables

What you don't do:
- Never guess product details
- Never finalize without confirmation
- Never discuss topics unrelated to Durauto Parts LLC
- Never send more than one message in response to a customer message
`;

// ─── Main Chat Function ───────────────────────────────────────────────────────

async function chat(customerPhone, userMessage) {
    const customer = findOrCreateCustomer(customerPhone);

    if (!conversations[customerPhone]) {
        conversations[customerPhone] = [];
    }

    const history = conversations[customerPhone];

    const words = userMessage.split(/\s+/);
    let productContext = '';

    for (const word of words) {
        const cleaned = word.replace(/[^a-zA-Z0-9\-]/g, '');
        if (cleaned.length > 3) {
            const product = findProduct(cleaned);
            if (product) {
                const customerPrice = getCustomerPrice(customer.customer_id, product.durauto_part_number);

                productContext += `
PRODUCT FOUND:
- Durauto Part #: ${product.durauto_part_number}
- Name: ${product.part_name}
- Category: ${product.category} > ${product.sub_category}
- Brand: ${product.brand}
- Description: ${product.description}
- Application: ${product.application}
- Specification: ${product.specification}
- Price: ${customerPrice ? '$' + customerPrice : 'Contact us for pricing'}
- Weight: ${product.weight}
- Cross References: ${product.cross_references.join(', ')}
- Photo Available: ${product.photo_url ? 'Yes' : 'No'}
`;
                break;
            }
        }
    }

    const messageLower = userMessage.toLowerCase();
    let orderContext = '';
    if (messageLower.includes('history') ||
        messageLower.includes('last order') ||
        messageLower.includes('previous order') ||
        messageLower.includes('what did i order')) {
        const orderHistory = getOrderHistory(customer.customer_id);
        console.log(`Order history lookup for ${customer.customer_id}: found ${orderHistory.length} orders`);
        if (orderHistory.length > 0) {
            orderContext = '\nORDER HISTORY:\n';
            for (const order of orderHistory) {
                orderContext += `\nOrder ${order.order_id} — ${order.created_at} — ${order.status}\n`;
                for (const item of order.items) {
                    orderContext += `  • ${item.durauto_part_number} — ${item.part_name} x${item.quantity}\n`;
                }
            }
        } else {
            orderContext = '\nORDER HISTORY: No previous orders found.\n';
        }
    }

    const systemData = `\n\n[SYSTEM DATA — DO NOT SHOW RAW]:\n${productContext}${orderContext}\nCustomer: ${customer.store_name} (${customer.customer_id})`;

    history.push({
        role: "user",
        content: userMessage + systemData
    });

    const response = await client.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 1024,
        system: systemPrompt,
        messages: history
    });

    let vertusReply = response.content[0].text;

    // ─── Handle Order Saving ──────────────────────────────────────────────────
    const saveOrderMatches = [...vertusReply.matchAll(/\[SAVE_ORDER: partNumber=([^,]+), quantity=(\d+), partName=([^,]+), price=([^\]]*)\]/g)];

    if (saveOrderMatches.length > 0) {
        const items = saveOrderMatches.map(match => ({
            durauto_part_number: match[1].trim(),
            quantity: parseInt(match[2]),
            part_name: match[3].trim(),
            price: match[4].trim()
        }));

        const allValid = items.every(item =>
            item.durauto_part_number &&
            item.durauto_part_number !== 'undefined' &&
            item.durauto_part_number !== 'X' &&
            item.quantity > 0 &&
            item.part_name &&
            item.part_name !== 'Z'
        );

        if (allValid) {
            const orderId = saveOrder(customer.customer_id, items);
            vertusReply = vertusReply.replace(/\[SAVE_ORDER:[^\]]+\]/g, '').trim();
            console.log(`Order ${orderId} saved for ${customer.store_name}`);

            try {
                const order = db.prepare('SELECT * FROM orders WHERE order_id = ?').get(orderId);
                const orderItems = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(orderId);
                const invoiceFilePath = await generateInvoice(order, customer, orderItems);
                const invoiceFileName = `invoice_${orderId}.pdf`;
                const invoiceUrl = `https://truck-parts-agent.onrender.com/invoices/${invoiceFileName}`;
                console.log(`Invoice generated: ${invoiceFilePath}`);
                console.log(`Invoice URL: ${invoiceUrl}`);

                history.push({ role: "assistant", content: vertusReply });
                return { reply: vertusReply, invoiceUrl, photoUrl: null };
            } catch (invoiceError) {
                console.error('Invoice generation error:', invoiceError.message);
            }
        } else {
            vertusReply = vertusReply.replace(/\[SAVE_ORDER:[^\]]+\]/g, '').trim();
            console.log('Blocked invalid SAVE_ORDER tag');
        }
    }

    // ─── Handle Photo Requests ────────────────────────────────────────────────
    const photoMatch = vertusReply.match(/\[SEND_PHOTO: partNumber=([^\]]+)\]/);
    let photoUrl = null;

    if (photoMatch) {
        const partNumber = photoMatch[1].trim();
        const productWithPhoto = db.prepare(`
            SELECT photo_url FROM products 
            WHERE durauto_part_number = ?
        `).get(partNumber);

        if (productWithPhoto && productWithPhoto.photo_url) {
            photoUrl = productWithPhoto.photo_url;
            console.log(`Photo found for ${partNumber}: ${photoUrl}`);
        }

        vertusReply = vertusReply.replace(/\[SEND_PHOTO:[^\]]+\]/g, '').trim();
    }

    history.push({ role: "assistant", content: vertusReply });
    return { reply: vertusReply, invoiceUrl: null, photoUrl };
}

// ─── WhatsApp Webhook ─────────────────────────────────────────────────────────

app.post('/webhook', async (req, res) => {
    console.log('--- INCOMING REQUEST ---');
    console.log(JSON.stringify(req.body, null, 2));
    console.log('------------------------');

    const incomingMessage = req.body.Body;
    const fromNumber = req.body.From;
    const messageSid = req.body.MessageSid;
    const messageStatus = req.body.MessageStatus;

    if (!incomingMessage || !fromNumber) return res.sendStatus(200);
    if (messageStatus && !messageSid) return res.sendStatus(200);
    if (fromNumber === process.env.TWILIO_WHATSAPP_NUMBER) return res.sendStatus(200);

    console.log(`Message from ${fromNumber}: ${incomingMessage}`);

    try {
        const { reply, invoiceUrl, photoUrl } = await chat(fromNumber, incomingMessage);

        console.log('--- VERTUS REPLY ---');
        console.log(reply);
        console.log('--------------------');

        await twilioClient.messages.create({
            from: process.env.TWILIO_WHATSAPP_NUMBER,
            to: fromNumber,
            body: reply
        });

        if (invoiceUrl) {
            await twilioClient.messages.create({
                from: process.env.TWILIO_WHATSAPP_NUMBER,
                to: fromNumber,
                body: '📄 Your invoice:',
                mediaUrl: [invoiceUrl]
            });
            console.log(`Invoice sent: ${invoiceUrl}`);
        }

        if (photoUrl) {
            await twilioClient.messages.create({
                from: process.env.TWILIO_WHATSAPP_NUMBER,
                to: fromNumber,
                body: '📸 Here is the product photo:',
                mediaUrl: [photoUrl]
            });
            console.log(`Photo sent: ${photoUrl}`);
        }

        console.log(`Reply sent to ${fromNumber}`);
    } catch (error) {
        console.error('Error:', error.message);
    }

    res.sendStatus(200);
});

// ─── Serve Invoice PDFs ───────────────────────────────────────────────────────

app.get('/invoices/:filename', (req, res) => {
    const filePath = `/tmp/invoices/${req.params.filename}`;
    if (fs.existsSync(filePath)) {
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${req.params.filename}"`);
        res.sendFile(path.resolve(filePath));
    } else {
        res.status(404).send('Invoice not found');
    }
});

// ─── Admin Routes ─────────────────────────────────────────────────────────────

app.get('/admin/view', (req, res) => {
    const { secret } = req.query;
    if (secret !== 'durauto2026') return res.status(403).send('Forbidden');

    const customers = db.prepare('SELECT customer_id, phone, store_name FROM customers').all();
    const pricing = db.prepare('SELECT * FROM customer_pricing').all();
    res.json({ customers, pricing });
});

app.get('/admin/set-price', (req, res) => {
    const { customer_id, part_number, price, secret } = req.query;
    if (secret !== 'durauto2026') return res.status(403).send('Forbidden');

    if (!customer_id || !part_number || !price) {
        return res.send('Missing params. Use: ?secret=durauto2026&customer_id=CUST-001&part_number=DP-SC20&price=49.99');
    }

    try {
        const customer = db.prepare('SELECT * FROM customers WHERE customer_id = ?').get(customer_id);
        if (!customer) {
            const all = db.prepare('SELECT customer_id, phone, store_name FROM customers').all();
            return res.json({ error: 'Customer not found', existing_customers: all });
        }

        db.prepare(`
            INSERT OR REPLACE INTO customer_pricing 
            (customer_id, durauto_part_number, price, notes)
            VALUES (?, ?, ?, ?)
        `).run(customer_id, part_number, parseFloat(price), 'Set via admin URL');

        res.json({
            success: true,
            customer: customer.store_name,
            part: part_number,
            price: parseFloat(price)
        });
    } catch (err) {
        res.status(500).send('Error: ' + err.message);
    }
});

app.get('/admin/import-pricing', async (req, res) => {
    const { secret } = req.query;
    if (secret !== 'durauto2026') return res.status(403).send('Forbidden');

    try {
        const axios = require('axios');
        const { parse } = require('csv-parse/sync');

        const response = await axios.get(
            'https://raw.githubusercontent.com/adhirajchaudhary-tech/truck-parts-agent/main/pricing.csv'
        );

        const records = parse(response.data, {
            columns: true,
            skip_empty_lines: true,
            trim: true
        });

        const insertPrice = db.prepare(`
            INSERT OR REPLACE INTO customer_pricing 
            (customer_id, durauto_part_number, price, notes)
            VALUES (?, ?, ?, ?)
        `);

        let successCount = 0;
        let errorCount = 0;
        const results = [];

        for (const record of records) {
            const customerId = record['customer_id'] || '';
            const partNumber = record['durauto_part_number'] || '';
            const price = parseFloat(record['price'] || '0');
            const notes = record['notes'] || '';

            if (!customerId || !partNumber || isNaN(price)) {
                errorCount++;
                continue;
            }

            try {
                insertPrice.run(customerId, partNumber, price, notes);
                results.push(`✅ ${customerId} — ${partNumber} — $${price.toFixed(2)}`);
                successCount++;
            } catch (err) {
                results.push(`❌ ${partNumber}: ${err.message}`);
                errorCount++;
            }
        }

        res.json({
            success: true,
            imported: successCount,
            errors: errorCount,
            details: results
        });

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/admin/import-photos', async (req, res) => {
    const { secret } = req.query;
    if (secret !== 'durauto2026') return res.status(403).send('Forbidden');

    try {
        const axios = require('axios');
        const { parse } = require('csv-parse/sync');

        const response = await axios.get(
            'https://raw.githubusercontent.com/adhirajchaudhary-tech/truck-parts-agent/main/photos.csv'
        );

        const records = parse(response.data, {
            columns: true,
            skip_empty_lines: true,
            trim: true
        });

        let successCount = 0;
        let errorCount = 0;
        const results = [];

        for (const record of records) {
            const partNumber = record['durauto_part_number'] || '';
            const photoUrl = record['photo_url'] || '';

            if (!partNumber || !photoUrl) {
                errorCount++;
                continue;
            }

            try {
                const result = db.prepare(`
                    UPDATE products SET photo_url = ? 
                    WHERE durauto_part_number = ?
                `).run(photoUrl, partNumber);

                if (result.changes > 0) {
                    results.push(`✅ ${partNumber} — photo set`);
                    successCount++;
                } else {
                    results.push(`⚠️ ${partNumber} — part not found`);
                    errorCount++;
                }
            } catch (err) {
                results.push(`❌ ${partNumber}: ${err.message}`);
                errorCount++;
            }
        }

        res.json({
            success: true,
            updated: successCount,
            errors: errorCount,
            details: results
        });

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── Health Check ─────────────────────────────────────────────────────────────

app.get('/', (req, res) => {
    res.send('Vertus is running.');
});

// ─── Start Server ─────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Vertus server running on port ${PORT}`);
    console.log(`Waiting for WhatsApp messages...`);
});