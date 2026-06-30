require('dotenv').config({ path: '/app/.env' });
const express = require('express');
const twilio = require('twilio');
const Anthropic = require('@anthropic-ai/sdk');
const Database = require('better-sqlite3');
const path = require('path');
const { generateInvoice } = require('./generateInvoice');

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const client = new Anthropic();
const db = new Database('durauto.db');
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

function generateOrderId() {
    // Start from DRA1002 (DRA1001 was the first manual invoice)
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
    let customer = db.prepare(`
        SELECT * FROM customers WHERE phone = ?
    `).get(phone);

    if (!customer) {
        const count = db.prepare('SELECT COUNT(*) as count FROM customers').get();
        const customerId = `CUST-${(count.count + 1).toString().padStart(3, '0')}`;

        db.prepare(`
            INSERT INTO customers (customer_id, phone, store_name, contact_name)
            VALUES (?, ?, 'Unknown Store', 'Unknown Contact')
        `).run(customerId, phone);

        customer = db.prepare(`
            SELECT * FROM customers WHERE phone = ?
        `).get(phone);

        console.log(`New customer created: ${customerId} — ${phone}`);
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
                productContext += `
PRODUCT FOUND:
- Durauto Part #: ${product.durauto_part_number}
- Name: ${product.part_name}
- Category: ${product.category} > ${product.sub_category}
- Brand: ${product.brand}
- Description: ${product.description}
- Application: ${product.application}
- Specification: ${product.specification}
- Price: ${product.price}
- Weight: ${product.weight}
- Cross References: ${product.cross_references.join(', ')}
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

            // Generate and send PDF invoice
            try {
                const order = db.prepare('SELECT * FROM orders WHERE order_id = ?').get(orderId);
                const orderItems = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(orderId);
                const invoiceUrl = await generateInvoice(order, customer, orderItems);

                // Return both the reply and invoice URL
                return { reply: vertusReply, invoiceUrl };
            } catch (invoiceError) {
                console.error('Invoice generation error:', invoiceError.message);
            }
        } else {
            vertusReply = vertusReply.replace(/\[SAVE_ORDER:[^\]]+\]/g, '').trim();
            console.log('Blocked invalid SAVE_ORDER tag');
        }
    }

    history.push({
        role: "assistant",
        content: vertusReply
    });

    return { reply: vertusReply, invoiceUrl: null };
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

    if (!incomingMessage || !fromNumber) {
        return res.sendStatus(200);
    }

    if (messageStatus && !messageSid) {
        return res.sendStatus(200);
    }

    if (fromNumber === process.env.TWILIO_WHATSAPP_NUMBER) {
        return res.sendStatus(200);
    }

    console.log(`Message from ${fromNumber}: ${incomingMessage}`);

    try {
        const { reply, invoiceUrl } = await chat(fromNumber, incomingMessage);

        console.log('--- VERTUS REPLY ---');
        console.log(reply);
        console.log('--------------------');

        // Send the text reply
        await twilioClient.messages.create({
            from: process.env.TWILIO_WHATSAPP_NUMBER,
            to: fromNumber,
            body: reply
        });

        // If there's an invoice, send it as a second message
        if (invoiceUrl) {
            await twilioClient.messages.create({
                from: process.env.TWILIO_WHATSAPP_NUMBER,
                to: fromNumber,
                body: '📄 Your invoice:',
                mediaUrl: [invoiceUrl]
            });
            console.log(`Invoice sent: ${invoiceUrl}`);
        }

        console.log(`Reply sent to ${fromNumber}`);
    } catch (error) {
        console.error('Error:', error.message);
    }

    res.sendStatus(200);
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