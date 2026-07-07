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

// ─── Send WhatsApp Message ────────────────────────────────────────────────────

async function sendMessage(to, body) {
    const toNumber = to.startsWith('whatsapp:') ? to : `whatsapp:${to}`;
    await twilioClient.messages.create({
        from: process.env.TWILIO_WHATSAPP_NUMBER,
        to: toNumber,
        body
    });
}

// ─── Onboarding Flow ──────────────────────────────────────────────────────────

const ONBOARDING_STEPS = [
    { field: 'store_name',     question: "What's the name of your store or business?" },
    { field: 'address',        question: "What's your full street address?" },
    { field: 'city_state',     question: "What city and state are you in?" },
    { field: 'email',          question: "What's the best email address for your account?" },
    { field: 'contact_name',   question: "What's the name of the main contact person?" },
    { field: 'designation',    question: "What's their role? (e.g. Owner, Manager, Purchasing Agent)" },
    { field: 'business_phone', question: "What's your business phone number?" },
    { field: 'referral',       question: "Last one — how did you hear about Durauto Parts? (type Skip to skip)" },
];

function getOnboarding(phone) {
    return db.prepare('SELECT * FROM onboarding WHERE customer_phone = ?').get(phone);
}

function createOnboarding(phone) {
    try {
        db.prepare('INSERT INTO onboarding (customer_phone, step) VALUES (?, 0)').run(phone);
    } catch (err) {}
    return getOnboarding(phone);
}

function updateOnboardingStep(phone, field, value, nextStep) {
    db.prepare(`UPDATE onboarding SET ${field} = ?, step = ? WHERE customer_phone = ?`)
        .run(value, nextStep, phone);
}

async function handleOnboarding(phone, message) {
    let onboarding = getOnboarding(phone);

    if (!onboarding) {
        onboarding = createOnboarding(phone);
        const welcomeMsg = `👋 Welcome to *Durauto Parts LLC* — Houston's heavy-duty truck parts distributor!\n\nTo get started as a Durauto customer, I need a few quick details. Your application will be reviewed and approved within 24 hours.\n\nLet's begin! 🚛\n\n${ONBOARDING_STEPS[0].question}`;
        await sendMessage(phone, welcomeMsg);
        saveConversationMessage(phone, 'vertus', welcomeMsg);
        return true;
    }

    const currentStep = onboarding.step;

    if (currentStep >= ONBOARDING_STEPS.length) {
        const waitMsg = `Your application is under review. We'll notify you as soon as you're approved — usually within 24 hours. 🕐`;
        await sendMessage(phone, waitMsg);
        saveConversationMessage(phone, 'vertus', waitMsg);
        return true;
    }

    const currentField = ONBOARDING_STEPS[currentStep].field;
    const answer = message.trim().toLowerCase() === 'skip' ? '' : message.trim();
    const nextStep = currentStep + 1;

    updateOnboardingStep(phone, currentField, answer, nextStep);
    saveConversationMessage(phone, 'customer', message);

    if (nextStep < ONBOARDING_STEPS.length) {
        const nextQuestion = ONBOARDING_STEPS[nextStep].question;
        await sendMessage(phone, nextQuestion);
        saveConversationMessage(phone, 'vertus', nextQuestion);
    } else {
        const updated = getOnboarding(phone);

        db.prepare(`
            UPDATE customers SET
                store_name = ?,
                contact_name = ?,
                email = ?,
                address = ?,
                status = 'pending'
            WHERE phone = ?
        `).run(
            updated.store_name || 'Unknown Store',
            updated.contact_name || 'Unknown Contact',
            updated.email || '',
            `${updated.address || ''}, ${updated.city_state || ''}`.trim(),
            phone
        );

        const doneMsg = `✅ Thanks! Here's a summary of your application:\n\n🏪 Store: ${updated.store_name}\n📍 Address: ${updated.address}, ${updated.city_state}\n📧 Email: ${updated.email}\n👤 Contact: ${updated.contact_name} (${updated.designation})\n📞 Phone: ${updated.business_phone}\n\nYour application has been submitted to the Durauto team. We'll review it and reach out within 24 hours.\n\nTalk soon! 🚛`;
        await sendMessage(phone, doneMsg);
        saveConversationMessage(phone, 'vertus', doneMsg);
    }

    return true;
}

// ─── Database Functions ───────────────────────────────────────────────────────

function findProduct(searchTerm) {
    const term = searchTerm.trim().toUpperCase();

    let product = db.prepare(`SELECT * FROM products WHERE UPPER(durauto_part_number) = ?`).get(term);

    if (!product) {
        const ref = db.prepare(`SELECT durauto_part_number FROM cross_references WHERE UPPER(cross_ref_number) = ?`).get(term);
        if (ref) {
            product = db.prepare(`SELECT * FROM products WHERE durauto_part_number = ?`).get(ref.durauto_part_number);
        }
    }

    if (!product) {
        product = db.prepare(`SELECT * FROM products WHERE UPPER(durauto_part_number) LIKE ?`).get(`%${term}%`);
    }

    if (product) {
        const crossRefs = db.prepare(`SELECT cross_ref_number FROM cross_references WHERE durauto_part_number = ?`).all(product.durauto_part_number);
        product.cross_references = crossRefs.map(r => r.cross_ref_number);
    }

    return product;
}

function getCustomerPrice(customerId, durautoPartNumber) {
    const customPrice = db.prepare(`SELECT price FROM customer_pricing WHERE customer_id = ? AND durauto_part_number = ?`).get(customerId, durautoPartNumber);
    if (customPrice) return customPrice.price.toFixed(2);

    const product = db.prepare(`SELECT price FROM products WHERE durauto_part_number = ?`).get(durautoPartNumber);
    return product && product.price ? product.price : null;
}

function searchByCategory(searchTerm) {
    const term = searchTerm.trim().toUpperCase();
    return db.prepare(`
        SELECT durauto_part_number, part_name, category, sub_category, price
        FROM products
        WHERE UPPER(category) LIKE ? OR UPPER(sub_category) LIKE ? OR UPPER(part_name) LIKE ? OR UPPER(description) LIKE ?
        ORDER BY category, sub_category, part_name
    `).all(`%${term}%`, `%${term}%`, `%${term}%`, `%${term}%`);
}

function generateOrderId() {
    const count = db.prepare('SELECT COUNT(*) as count FROM orders').get();
    return `DRA${1001 + count.count + 1}`;
}

function saveOrder(customerId, items) {
    const orderId = generateOrderId();
    db.prepare(`INSERT INTO orders (order_id, customer_id, status) VALUES (?, ?, 'confirmed')`).run(orderId, customerId);
    for (const item of items) {
        db.prepare(`INSERT INTO order_items (order_id, durauto_part_number, part_name, quantity, price_at_order) VALUES (?, ?, ?, ?, ?)`).run(orderId, item.durauto_part_number, item.part_name, item.quantity, item.price);
    }
    return orderId;
}

function getOrderHistory(customerId) {
    const orders = db.prepare(`SELECT * FROM orders WHERE customer_id = ? ORDER BY created_at DESC LIMIT 10`).all(customerId);
    for (const order of orders) {
        order.items = db.prepare(`SELECT * FROM order_items WHERE order_id = ?`).all(order.order_id);
    }
    return orders;
}

function findOrCreateCustomer(phone) {
    const normalizedPhone = phone.replace('whatsapp:', '');
    let customer = db.prepare(`SELECT * FROM customers WHERE phone = ? OR phone = ?`).get(normalizedPhone, phone);

    if (!customer) {
        const count = db.prepare('SELECT COUNT(*) as count FROM customers').get();
        const customerId = `CUST-${(count.count + 1).toString().padStart(3, '0')}`;
        db.prepare(`INSERT INTO customers (customer_id, phone, store_name, contact_name, paused, status) VALUES (?, ?, 'Unknown Store', 'Unknown Contact', 0, 'pending')`).run(customerId, normalizedPhone);
        customer = db.prepare(`SELECT * FROM customers WHERE phone = ?`).get(normalizedPhone);
        console.log(`New customer created: ${customerId} — ${normalizedPhone}`);
    }

    return customer;
}

function saveConversationMessage(phone, role, message) {
    try {
        db.prepare(`INSERT INTO conversations (customer_phone, role, message) VALUES (?, ?, ?)`).run(phone.replace('whatsapp:', ''), role, message);
    } catch (err) {}
}

// ─── System Prompt ────────────────────────────────────────────────────────────

const systemPrompt = `
You are Vertus, the ordering assistant for Durauto Parts LLC — a distributor of heavy-duty truck parts based in Houston, TX.

You help retail customers do the following:
1. Place new orders by part number and quantity
2. View their order history
3. Reorder from a previous order with option to adjust quantities
4. Get product specifications
5. View product photos
6. Browse products by category

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

How you handle category browsing:
- When a customer asks what products you carry in a category, list them clearly and concisely
- Show the part number and name for each product
- Keep the list clean — just part number and name, no specs unless asked
- After listing, invite them to ask for details on any specific part
- If they ask what you carry generally, tell them the categories and how many products in each

What you don't do:
- Never guess product details
- Never finalize without confirmation
- Never discuss topics unrelated to Durauto Parts LLC
- Never send more than one message in response to a customer message
`;

// ─── Main Chat Function ───────────────────────────────────────────────────────

async function chat(customerPhone, userMessage) {
    const normalizedPhone = customerPhone.replace('whatsapp:', '');
    const customer = findOrCreateCustomer(customerPhone);

    if (!customer.status || customer.status === 'pending') {
        const onboarding = getOnboarding(normalizedPhone);
        const isComplete = onboarding && onboarding.step >= ONBOARDING_STEPS.length;

        if (isComplete) {
            const waitMsg = `Your application is still under review. We'll notify you as soon as you're approved — usually within 24 hours. 🕐`;
            await sendMessage(normalizedPhone, waitMsg);
            saveConversationMessage(normalizedPhone, 'vertus', waitMsg);
            return null;
        }

        await handleOnboarding(normalizedPhone, userMessage);
        return null;
    }

    if (customer.status === 'rejected') {
        const rejectedMsg = `Sorry, your application was not approved at this time. Please contact us directly at adhirajchaudhary@gmail.com for more information.`;
        await sendMessage(normalizedPhone, rejectedMsg);
        saveConversationMessage(normalizedPhone, 'vertus', rejectedMsg);
        return null;
    }

    if (customer.paused) {
        saveConversationMessage(normalizedPhone, 'customer', userMessage);
        console.log(`Customer ${customerPhone} is paused — message logged, no auto-reply`);
        return null;
    }

    if (!conversations[customerPhone]) conversations[customerPhone] = [];
    const history = conversations[customerPhone];
    const messageLower = userMessage.toLowerCase();

    // ─── Category Browse ──────────────────────────────────────────────────────
    const browseKeywords = ['brake shoe', 'brake chamber', 'slack adjuster', 'manual slack', 'air brake', 'coolant reservoir', 'hub cap', 'air hose', 'what do you have', 'what have you got', 'show me all', 'list all', 'types of', 'kinds of', 'all your', 'what parts', 'what products', 'do you carry', 'do you sell', 'what brake', 'what slack', 'how many', 'what kind of'];
    const categorySearchTerms = [
        { keyword: 'brake shoe', search: 'brake shoe' },
        { keyword: 'brake chamber', search: 'brake chamber' },
        { keyword: 'slack adjuster', search: 'slack adjuster' },
        { keyword: 'manual slack', search: 'manual slack' },
        { keyword: 'air hose', search: 'air hose' },
        { keyword: 'coolant reservoir', search: 'coolant reservoir' },
        { keyword: 'hub cap', search: 'hub cap' },
        { keyword: 'air brake', search: 'air brake' },
        { keyword: 'wheel', search: 'wheel' },
        { keyword: 'cooling', search: 'cooling' },
    ];

    let categoryContext = '';
    const matchedKeyword = browseKeywords.find(kw => messageLower.includes(kw));

    if (matchedKeyword) {
        const matched = categorySearchTerms.find(c => messageLower.includes(c.keyword));
        if (matched) {
            const results = searchByCategory(matched.search);
            if (results.length > 0) {
                categoryContext = `\nCATEGORY SEARCH RESULTS for "${matched.search}":\n`;
                results.forEach((p, i) => { categoryContext += `${i + 1}. ${p.durauto_part_number} — ${p.part_name}\n`; });
                categoryContext += `\nTotal: ${results.length} products found.\n`;
            }
        } else {
            const allCategories = db.prepare(`SELECT category, COUNT(*) as count FROM products GROUP BY category ORDER BY category`).all();
            categoryContext = '\nPRODUCT CATALOG SUMMARY:\n';
            allCategories.forEach(cat => { categoryContext += `- ${cat.category}: ${cat.count} products\n`; });
        }
    }

    // ─── Product Lookup ───────────────────────────────────────────────────────
    const words = userMessage.split(/\s+/);
    let productContext = '';

    for (const word of words) {
        const cleaned = word.replace(/[^a-zA-Z0-9\-]/g, '');
        if (cleaned.length > 3) {
            const product = findProduct(cleaned);
            if (product) {
                const customerPrice = getCustomerPrice(customer.customer_id, product.durauto_part_number);
                productContext += `\nPRODUCT FOUND:\n- Durauto Part #: ${product.durauto_part_number}\n- Name: ${product.part_name}\n- Category: ${product.category} > ${product.sub_category}\n- Brand: ${product.brand}\n- Description: ${product.description}\n- Application: ${product.application}\n- Specification: ${product.specification}\n- Price: ${customerPrice ? '$' + customerPrice : 'Contact us for pricing'}\n- Weight: ${product.weight}\n- Cross References: ${product.cross_references.join(', ')}\n- Photo Available: ${product.photo_url ? 'Yes' : 'No'}\n`;
                break;
            }
        }
    }

    // ─── Order History ────────────────────────────────────────────────────────
    let orderContext = '';
    if (messageLower.includes('history') || messageLower.includes('last order') || messageLower.includes('previous order') || messageLower.includes('what did i order')) {
        const orderHistory = getOrderHistory(customer.customer_id);
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

    const systemData = `\n\n[SYSTEM DATA — DO NOT SHOW RAW]:\n${productContext}${categoryContext}${orderContext}\nCustomer: ${customer.store_name} (${customer.customer_id})`;

    saveConversationMessage(normalizedPhone, 'customer', userMessage);
    history.push({ role: "user", content: userMessage + systemData });

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
            item.durauto_part_number && item.durauto_part_number !== 'undefined' && item.durauto_part_number !== 'X' &&
            item.quantity > 0 && item.part_name && item.part_name !== 'Z'
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

                saveConversationMessage(normalizedPhone, 'vertus', vertusReply);
                history.push({ role: "assistant", content: vertusReply });
                return { reply: vertusReply, invoiceUrl, photoUrl: null };
            } catch (invoiceError) {
                console.error('Invoice generation error:', invoiceError.message);
            }
        } else {
            vertusReply = vertusReply.replace(/\[SAVE_ORDER:[^\]]+\]/g, '').trim();
        }
    }

    // ─── Handle Photo Requests ────────────────────────────────────────────────
    const photoMatch = vertusReply.match(/\[SEND_PHOTO: partNumber=([^\]]+)\]/);
    let photoUrl = null;

    if (photoMatch) {
        const partNumber = photoMatch[1].trim();
        const productWithPhoto = db.prepare(`SELECT photo_url FROM products WHERE durauto_part_number = ?`).get(partNumber);
        if (productWithPhoto && productWithPhoto.photo_url) {
            photoUrl = productWithPhoto.photo_url;
        }
        vertusReply = vertusReply.replace(/\[SEND_PHOTO:[^\]]+\]/g, '').trim();
    }

    saveConversationMessage(normalizedPhone, 'vertus', vertusReply);
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
        const result = await chat(fromNumber, incomingMessage);
        if (!result) return res.sendStatus(200);

        const { reply, invoiceUrl, photoUrl } = result;

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
        }

        if (photoUrl) {
            await twilioClient.messages.create({
                from: process.env.TWILIO_WHATSAPP_NUMBER,
                to: fromNumber,
                body: '📸 Here is the product photo:',
                mediaUrl: [photoUrl]
            });
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

// ─── Admin Dashboard ──────────────────────────────────────────────────────────

app.get('/admin/dashboard', (req, res) => {
    const { secret } = req.query;
    if (secret !== 'durauto2026') return res.status(403).send('Forbidden');
    res.sendFile(path.resolve('dashboard.html'));
});
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Vertus Admin Dashboard</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f0f2f5; height: 100vh; overflow: hidden; }
        .header { background: #1a5276; color: white; padding: 14px 24px; display: flex; align-items: center; justify-content: space-between; }
        .header h1 { font-size: 18px; font-weight: 600; }
        .status { font-size: 12px; background: #27ae60; padding: 4px 10px; border-radius: 12px; }
        .tabs { display: flex; background: #154360; padding: 0 16px; }
        .tab { padding: 10px 20px; color: rgba(255,255,255,0.6); cursor: pointer; font-size: 13px; font-weight: 500; border-bottom: 3px solid transparent; transition: all 0.2s; }
        .tab:hover { color: white; }
        .tab.active { color: white; border-bottom-color: #3498db; }
        .tab-content { display: none; height: calc(100vh - 88px); }
        .tab-content.active { display: flex; }
        .sidebar { width: 300px; background: white; border-right: 1px solid #e0e0e0; overflow-y: auto; flex-shrink: 0; display: flex; flex-direction: column; }
        .sidebar-header { padding: 14px 16px; border-bottom: 1px solid #e0e0e0; font-weight: 600; color: #333; font-size: 13px; flex-shrink: 0; }
        .customer-item { padding: 12px 16px; border-bottom: 1px solid #f5f5f5; cursor: pointer; }
        .customer-item:hover { background: #f8f8f8; }
        .customer-item.active { background: #ebf3fb; border-left: 3px solid #1a5276; }
        .customer-name { font-weight: 600; font-size: 13px; color: #222; }
        .customer-phone { font-size: 11px; color: #999; margin-top: 2px; }
        .customer-preview { font-size: 11px; color: #bbb; margin-top: 3px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .customer-time { font-size: 10px; color: #ccc; float: right; }
        .badge-paused { font-size: 9px; background: #e74c3c; color: white; padding: 1px 5px; border-radius: 8px; margin-left: 4px; }
        .chat-area { flex: 1; display: flex; flex-direction: column; min-width: 0; }
        .chat-header { padding: 12px 20px; background: white; border-bottom: 1px solid #e0e0e0; display: flex; align-items: center; justify-content: space-between; flex-shrink: 0; }
        .chat-header-info h2 { font-size: 15px; font-weight: 600; color: #222; }
        .chat-header-info p { font-size: 11px; color: #999; margin-top: 2px; }
        .pause-btn { padding: 7px 14px; border: none; border-radius: 7px; cursor: pointer; font-size: 12px; font-weight: 600; }
        .pause-btn.active { background: #27ae60; color: white; }
        .pause-btn.paused { background: #e74c3c; color: white; }
        .messages { flex: 1; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 10px; }
        .message { max-width: 72%; }
        .message.customer { align-self: flex-end; }
        .message.vertus { align-self: flex-start; }
        .message.admin { align-self: flex-end; }
        .bubble { padding: 9px 13px; border-radius: 12px; font-size: 13px; line-height: 1.5; word-wrap: break-word; white-space: pre-wrap; }
        .message.customer .bubble { background: #dcf8c6; color: #222; border-bottom-right-radius: 3px; }
        .message.vertus .bubble { background: white; color: #222; border-bottom-left-radius: 3px; box-shadow: 0 1px 2px rgba(0,0,0,0.08); }
        .message.admin .bubble { background: #3498db; color: white; border-bottom-right-radius: 3px; }
        .msg-meta { font-size: 10px; color: #bbb; margin-top: 3px; }
        .message.customer .msg-meta, .message.admin .msg-meta { text-align: right; }
        .msg-label { font-size: 10px; color: #aaa; margin-bottom: 2px; }
        .message.admin .msg-label { text-align: right; }
        .paused-banner { background: #fdf2f2; border-top: 1px solid #f5c6cb; padding: 7px 16px; font-size: 12px; color: #e74c3c; text-align: center; flex-shrink: 0; }
        .reply-box { padding: 10px 14px; background: white; border-top: 1px solid #e0e0e0; display: flex; gap: 8px; align-items: flex-end; flex-shrink: 0; }
        .reply-box textarea { flex: 1; padding: 9px 14px; border: 1px solid #ddd; border-radius: 20px; font-size: 13px; resize: none; outline: none; font-family: inherit; }
        .reply-box textarea:focus { border-color: #1a5276; }
        .send-btn { padding: 9px 18px; background: #1a5276; color: white; border: none; border-radius: 20px; cursor: pointer; font-size: 13px; font-weight: 600; white-space: nowrap; }
        .send-btn:disabled { opacity: 0.5; }
        .refresh-bar { padding: 5px; background: #f8f8f8; border-top: 1px solid #eee; font-size: 10px; color: #ccc; text-align: center; flex-shrink: 0; }
        .empty-state { flex: 1; display: flex; align-items: center; justify-content: center; color: #bbb; font-size: 13px; }
        .cnt-badge { background: #e74c3c; color: white; font-size: 10px; padding: 1px 6px; border-radius: 10px; margin-left: 5px; }
        .cnt-pending { background: #f39c12; color: white; font-size: 10px; padding: 1px 6px; border-radius: 10px; margin-left: 5px; }
        .pending-area { flex: 1; overflow-y: auto; padding: 20px; background: #f0f2f5; }
        .pending-card { background: white; border-radius: 10px; padding: 18px; margin-bottom: 14px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
        .pending-card h3 { font-size: 15px; font-weight: 600; margin-bottom: 12px; color: #222; }
        .pf { display: flex; margin-bottom: 7px; font-size: 13px; }
        .pl { color: #999; width: 130px; flex-shrink: 0; }
        .pv { color: #222; font-weight: 500; }
        .pending-actions { display: flex; gap: 10px; margin-top: 14px; }
        .approve-btn { padding: 9px 22px; background: #27ae60; color: white; border: none; border-radius: 7px; cursor: pointer; font-size: 13px; font-weight: 600; }
        .reject-btn { padding: 9px 22px; background: #e74c3c; color: white; border: none; border-radius: 7px; cursor: pointer; font-size: 13px; font-weight: 600; }
        .approve-btn:disabled, .reject-btn:disabled { opacity: 0.5; cursor: not-allowed; }
        .no-pending { text-align: center; color: #bbb; padding: 60px 20px; font-size: 13px; }
        .no-customers { padding: 16px; text-align: center; color: #bbb; font-size: 12px; }
    </style>
</head>
<body>
<div class="header">
    <h1>🚛 Vertus Admin Dashboard</h1>
    <span class="status">● Live</span>
</div>
<div class="tabs">
    <div class="tab active" id="tab-conv" onclick="switchTab('conv')">Conversations <span id="convBadge"></span></div>
    <div class="tab" id="tab-pend" onclick="switchTab('pend')">Pending Approvals <span id="pendBadge"></span></div>
</div>

<div class="tab-content active" id="content-conv">
    <div class="sidebar">
        <div class="sidebar-header">Customers <span id="custCount"></span></div>
        <div id="custList"></div>
    </div>
    <div class="chat-area">
        <div class="chat-header" id="chatHeader">
            <div class="chat-header-info"><h2>Select a customer</h2><p>Click a customer to view their conversation</p></div>
        </div>
        <div class="messages" id="msgArea"><div class="empty-state">👈 Select a customer</div></div>
        <div class="paused-banner" id="pausedBanner" style="display:none">🔴 Vertus is paused — you are in manual mode</div>
        <div class="reply-box" id="replyBox" style="display:none">
            <textarea id="replyText" placeholder="Type a message to send directly to customer..." rows="1"></textarea>
            <button class="send-btn" id="sendBtn" onclick="sendMsg()">Send</button>
        </div>
        <div class="refresh-bar">Auto-refreshes every 10 seconds</div>
    </div>
</div>

<div class="tab-content" id="content-pend">
    <div class="pending-area" id="pendingArea"><div class="no-pending">Loading...</div></div>
</div>

<script>
const secret = new URLSearchParams(window.location.search).get('secret');
let selPhone = null;

function switchTab(t) {
    document.getElementById('tab-conv').classList.toggle('active', t === 'conv');
    document.getElementById('tab-pend').classList.toggle('active', t === 'pend');
    document.getElementById('content-conv').classList.toggle('active', t === 'conv');
    document.getElementById('content-pend').classList.toggle('active', t === 'pend');
    if (t === 'pend') loadPending();
}

function esc(str) {
    return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

async function loadCustomers() {
    try {
        const r = await fetch('/admin/api/customers?secret=' + secret);
        const data = await r.json();
        const approved = data.filter(c => c.status === 'approved');
        document.getElementById('custCount').innerHTML = '<span class="cnt-badge">' + approved.length + '</span>';
        document.getElementById('convBadge').innerHTML = approved.length > 0 ? '<span class="cnt-badge">' + approved.length + '</span>' : '';
        const list = document.getElementById('custList');
        if (approved.length === 0) {
            list.innerHTML = '<div class="no-customers">No approved customers yet.</div>';
            return;
        }
        list.innerHTML = '';
        approved.forEach(c => {
            const div = document.createElement('div');
            div.className = 'customer-item' + (selPhone === c.phone ? ' active' : '');
            div.dataset.phone = c.phone;
            div.dataset.store = c.store_name || 'Unknown';
            div.dataset.contact = c.contact_name || '';
            div.dataset.paused = c.paused;
            div.onclick = function() {
                selectCust(this.dataset.phone, this.dataset.store, this.dataset.contact, parseInt(this.dataset.paused));
            };
            const time = c.last_message_time ? new Date(c.last_message_time + ' UTC').toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}) : '';
            const preview = (c.last_message || 'No messages yet').replace(/\n/g,' ').substring(0, 50);

            const timeSpan = document.createElement('span');
            timeSpan.className = 'customer-time';
            timeSpan.textContent = time;

            const nameDiv = document.createElement('div');
            nameDiv.className = 'customer-name';
            nameDiv.textContent = c.store_name || 'Unknown';
            if (c.paused) {
                const badge = document.createElement('span');
                badge.className = 'badge-paused';
                badge.textContent = 'PAUSED';
                nameDiv.appendChild(badge);
            }

            const phoneDiv = document.createElement('div');
            phoneDiv.className = 'customer-phone';
            phoneDiv.textContent = c.phone;

            const previewDiv = document.createElement('div');
            previewDiv.className = 'customer-preview';
            previewDiv.textContent = preview;

            div.appendChild(timeSpan);
            div.appendChild(nameDiv);
            div.appendChild(phoneDiv);
            div.appendChild(previewDiv);
            list.appendChild(div);
        });
        if (selPhone) {
            const cur = approved.find(c => c.phone === selPhone);
            if (cur) updatePauseBtn(cur.paused);
        }
    } catch(e) { console.error(e); }
}

async function loadPending() {
    try {
        const r = await fetch('/admin/api/pending?secret=' + secret);
        const data = await r.json();
        document.getElementById('pendBadge').innerHTML = data.length > 0 ? '<span class="cnt-pending">' + data.length + '</span>' : '';
        const area = document.getElementById('pendingArea');
        if (data.length === 0) { area.innerHTML = '<div class="no-pending">✅ No pending applications right now.</div>'; return; }
        area.innerHTML = '';
        data.forEach(app => {
            const card = document.createElement('div');
            card.className = 'pending-card';
            card.innerHTML = '<h3>' + esc(app.store_name || 'Unknown Store') + '</h3>' +
                '<div class="pf"><span class="pl">📍 Address</span><span class="pv">' + esc(app.address) + '</span></div>' +
                '<div class="pf"><span class="pl">🏙️ City/State</span><span class="pv">' + esc(app.city_state) + '</span></div>' +
                '<div class="pf"><span class="pl">📧 Email</span><span class="pv">' + esc(app.email) + '</span></div>' +
                '<div class="pf"><span class="pl">👤 Contact</span><span class="pv">' + esc(app.contact_name) + '</span></div>' +
                '<div class="pf"><span class="pl">💼 Designation</span><span class="pv">' + esc(app.designation) + '</span></div>' +
                '<div class="pf"><span class="pl">📞 Business Phone</span><span class="pv">' + esc(app.business_phone) + '</span></div>' +
                '<div class="pf"><span class="pl">📱 WhatsApp</span><span class="pv">' + esc(app.customer_phone) + '</span></div>' +
                '<div class="pf"><span class="pl">📅 Applied</span><span class="pv">' + new Date(app.created_at + ' UTC').toLocaleDateString() + '</span></div>' +
                (app.referral ? '<div class="pf"><span class="pl">🔗 Referral</span><span class="pv">' + esc(app.referral) + '</span></div>' : '') +
                '<div class="pending-actions"><button class="approve-btn" id="ab-' + esc(app.customer_phone) + '" onclick="approveCust(' + JSON.stringify(app.customer_phone) + ')">✅ Approve</button><button class="reject-btn" id="rb-' + esc(app.customer_phone) + '" onclick="rejectCust(' + JSON.stringify(app.customer_phone) + ')">❌ Reject</button></div>';
            area.appendChild(card);
        });
    } catch(e) { console.error(e); }
}

async function approveCust(phone) {
    const btn = document.getElementById('ab-' + phone);
    if (btn) { btn.disabled = true; btn.textContent = 'Approving...'; }
    try {
        const r = await fetch('/admin/api/approve', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({secret, phone}) });
        const d = await r.json();
        if (d.success) { loadPending(); loadCustomers(); }
        else { alert('Error: ' + (d.error || 'Unknown')); if (btn) { btn.disabled = false; btn.textContent = '✅ Approve'; } }
    } catch(e) { alert('Error'); if (btn) { btn.disabled = false; btn.textContent = '✅ Approve'; } }
}

async function rejectCust(phone) {
    if (!confirm('Reject this application?')) return;
    const btn = document.getElementById('rb-' + phone);
    if (btn) { btn.disabled = true; btn.textContent = 'Rejecting...'; }
    try {
        const r = await fetch('/admin/api/reject', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({secret, phone}) });
        const d = await r.json();
        if (d.success) loadPending();
        else { alert('Error: ' + (d.error || 'Unknown')); if (btn) { btn.disabled = false; btn.textContent = '❌ Reject'; } }
    } catch(e) { alert('Error'); if (btn) { btn.disabled = false; btn.textContent = '❌ Reject'; } }
}

function selectCust(phone, storeName, contactName, paused) {
    selPhone = phone;
    document.getElementById('chatHeader').innerHTML =
        '<div class="chat-header-info"><h2>' + esc(storeName || 'Unknown') + '</h2><p>' + esc(contactName || '') + ' &bull; ' + esc(phone) + '</p></div>' +
        '<button class="pause-btn ' + (paused ? 'paused' : 'active') + '" id="pauseBtn" onclick="togglePause()">' + (paused ? '▶ Resume Vertus' : '⏸ Pause Vertus') + '</button>';
    document.getElementById('replyBox').style.display = 'flex';
    document.getElementById('pausedBanner').style.display = paused ? 'block' : 'none';
    loadMsgs(phone);
    loadCustomers();
}

function updatePauseBtn(paused) {
    const btn = document.getElementById('pauseBtn');
    if (!btn) return;
    btn.textContent = paused ? '▶ Resume Vertus' : '⏸ Pause Vertus';
    btn.className = 'pause-btn ' + (paused ? 'paused' : 'active');
    const banner = document.getElementById('pausedBanner');
    if (banner) banner.style.display = paused ? 'block' : 'none';
}

async function togglePause() {
    if (!selPhone) return;
    const btn = document.getElementById('pauseBtn');
    if (btn) btn.disabled = true;
    try {
        const r = await fetch('/admin/api/toggle-pause?secret=' + secret + '&phone=' + encodeURIComponent(selPhone), {method:'POST'});
        const d = await r.json();
        updatePauseBtn(d.paused);
        loadCustomers();
    } catch(e) { console.error(e); }
    if (btn) btn.disabled = false;
}

async function sendMsg() {
    if (!selPhone) return;
    const ta = document.getElementById('replyText');
    const msg = ta.value.trim();
    if (!msg) return;
    const btn = document.getElementById('sendBtn');
    btn.disabled = true; btn.textContent = 'Sending...';
    try {
        const r = await fetch('/admin/api/send-message', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({secret, phone: selPhone, message: msg}) });
        const d = await r.json();
        if (d.success) { ta.value = ''; loadMsgs(selPhone); }
        else alert('Failed: ' + (d.error || 'Unknown'));
    } catch(e) { alert('Error sending'); }
    btn.disabled = false; btn.textContent = 'Send';
}

document.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey && document.activeElement.id === 'replyText') {
        e.preventDefault(); sendMsg();
    }
});

async function loadMsgs(phone) {
    try {
        const r = await fetch('/admin/api/messages?secret=' + secret + '&phone=' + encodeURIComponent(phone));
        const data = await r.json();
        const area = document.getElementById('msgArea');
        area.innerHTML = '';
        if (data.length === 0) { area.innerHTML = '<div class="empty-state">No messages yet</div>'; return; }
        data.forEach(msg => {
            const div = document.createElement('div');
            div.className = 'message ' + msg.role;
            const time = new Date(msg.created_at + ' UTC').toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});
            const labels = {customer:'👤 Customer', vertus:'🤖 Vertus', admin:'👨‍💼 You'};
            div.innerHTML = '<div class="msg-label">' + (labels[msg.role] || msg.role) + '</div><div class="bubble">' + esc(msg.message) + '</div><div class="msg-meta">' + time + '</div>';
            area.appendChild(div);
        });
        area.scrollTop = area.scrollHeight;
    } catch(e) { console.error(e); }
}

setInterval(() => { loadCustomers(); if (selPhone) loadMsgs(selPhone); }, 10000);
loadCustomers();
</script>
</body>
</html>`;

    res.send(html);
});

// ─── Admin API ────────────────────────────────────────────────────────────────

app.get('/admin/api/customers', (req, res) => {
    const { secret } = req.query;
    if (secret !== 'durauto2026') return res.status(403).send('Forbidden');
    try {
        const customers = db.prepare(`
            SELECT c.customer_id, c.store_name, c.contact_name, c.phone, c.paused, c.status,
                conv.message as last_message, conv.created_at as last_message_time
            FROM customers c
            LEFT JOIN conversations conv ON c.phone = conv.customer_phone
                AND conv.id = (SELECT MAX(id) FROM conversations WHERE customer_phone = c.phone)
            ORDER BY COALESCE(conv.created_at, c.created_at) DESC
        `).all();
        res.json(customers);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/admin/api/pending', (req, res) => {
    const { secret } = req.query;
    if (secret !== 'durauto2026') return res.status(403).send('Forbidden');
    try {
        const pending = db.prepare(`
            SELECT o.*, c.status FROM onboarding o
            LEFT JOIN customers c ON c.phone = o.customer_phone
            WHERE o.step >= ? AND (c.status = 'pending' OR c.status IS NULL)
            ORDER BY o.created_at DESC
        `).all(ONBOARDING_STEPS.length);
        res.json(pending);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/admin/api/approve', async (req, res) => {
    const { secret, phone } = req.body;
    if (secret !== 'durauto2026') return res.status(403).send('Forbidden');
    try {
        const onboarding = db.prepare('SELECT * FROM onboarding WHERE customer_phone = ?').get(phone);
        db.prepare(`UPDATE customers SET status = 'approved' WHERE phone = ?`).run(phone);

        const contactName = onboarding ? (onboarding.contact_name || '') : '';
        const storeName = onboarding ? (onboarding.store_name || 'there') : 'there';

        const welcomeMsg = `🎉 Welcome to Durauto Parts, ${contactName || storeName}!\n\nYour account has been approved. Here's what Vertus can help you with:\n\n🔍 Look up any part by number or category\n💰 Get your custom pricing instantly\n📸 View product photos\n🛒 Place orders and get instant PDF invoices\n📋 Check your order history\n\nJust send me a message to get started!`;
        await sendMessage(phone, welcomeMsg);
        saveConversationMessage(phone, 'vertus', welcomeMsg);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/admin/api/reject', async (req, res) => {
    const { secret, phone } = req.body;
    if (secret !== 'durauto2026') return res.status(403).send('Forbidden');
    try {
        db.prepare(`UPDATE customers SET status = 'rejected' WHERE phone = ?`).run(phone);
        const rejectMsg = `Thank you for your interest in Durauto Parts. Unfortunately, we are unable to approve your application at this time. Please contact us at adhirajchaudhary@gmail.com for more information.`;
        await sendMessage(phone, rejectMsg);
        saveConversationMessage(phone, 'vertus', rejectMsg);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/admin/api/messages', (req, res) => {
    const { secret, phone } = req.query;
    if (secret !== 'durauto2026') return res.status(403).send('Forbidden');
    try {
        const messages = db.prepare(`SELECT role, message, created_at FROM conversations WHERE customer_phone = ? ORDER BY created_at ASC`).all(phone);
        res.json(messages);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/admin/api/toggle-pause', (req, res) => {
    const { secret, phone } = req.query;
    if (secret !== 'durauto2026') return res.status(403).send('Forbidden');
    try {
        const customer = db.prepare('SELECT * FROM customers WHERE phone = ?').get(phone);
        if (!customer) return res.status(404).json({ error: 'Not found' });
        const newPaused = customer.paused ? 0 : 1;
        db.prepare('UPDATE customers SET paused = ? WHERE phone = ?').run(newPaused, phone);
        res.json({ success: true, paused: newPaused });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/admin/api/send-message', async (req, res) => {
    const { secret, phone, message } = req.body;
    if (secret !== 'durauto2026') return res.status(403).send('Forbidden');
    try {
        await sendMessage(phone, message);
        saveConversationMessage(phone, 'admin', message);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Admin Routes ─────────────────────────────────────────────────────────────

app.get('/admin/migrate', (req, res) => {
    const { secret } = req.query;
    if (secret !== 'durauto2026') return res.status(403).send('Forbidden');
    const results = [];

    const migrations = [
        [`ALTER TABLE products ADD COLUMN photo_url TEXT`, 'photo_url column'],
        [`ALTER TABLE customers ADD COLUMN paused INTEGER DEFAULT 0`, 'paused column'],
        [`ALTER TABLE customers ADD COLUMN status TEXT DEFAULT 'pending'`, 'status column'],
    ];

    for (const [sql, name] of migrations) {
        try {
            db.exec(sql);
            results.push(`✅ ${name} added`);
        } catch (err) {
            if (err.message.includes('duplicate column')) results.push(`ℹ️ ${name} already exists`);
            else results.push(`❌ ${name}: ${err.message}`);
        }
    }

    const tables = [
        [`CREATE TABLE IF NOT EXISTS conversations (id INTEGER PRIMARY KEY AUTOINCREMENT, customer_phone TEXT, role TEXT, message TEXT, created_at TEXT DEFAULT (datetime('now')))`, 'conversations table'],
        [`CREATE TABLE IF NOT EXISTS onboarding (id INTEGER PRIMARY KEY AUTOINCREMENT, customer_phone TEXT UNIQUE, store_name TEXT, address TEXT, city_state TEXT, email TEXT, contact_name TEXT, designation TEXT, business_phone TEXT, referral TEXT, step INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')))`, 'onboarding table'],
    ];

    for (const [sql, name] of tables) {
        try { db.exec(sql); results.push(`✅ ${name} ready`); }
        catch (err) { results.push(`❌ ${name}: ${err.message}`); }
    }

    res.json({ success: true, results });
});

app.get('/admin/view', (req, res) => {
    const { secret } = req.query;
    if (secret !== 'durauto2026') return res.status(403).send('Forbidden');
    const customers = db.prepare('SELECT customer_id, phone, store_name, status FROM customers').all();
    const pricing = db.prepare('SELECT * FROM customer_pricing').all();
    res.json({ customers, pricing });
});

app.get('/admin/set-price', (req, res) => {
    const { customer_id, part_number, price, secret } = req.query;
    if (secret !== 'durauto2026') return res.status(403).send('Forbidden');
    if (!customer_id || !part_number || !price) return res.send('Missing params.');
    try {
        const customer = db.prepare('SELECT * FROM customers WHERE customer_id = ?').get(customer_id);
        if (!customer) return res.json({ error: 'Customer not found', all: db.prepare('SELECT customer_id, phone FROM customers').all() });
        db.prepare(`INSERT OR REPLACE INTO customer_pricing (customer_id, durauto_part_number, price, notes) VALUES (?, ?, ?, ?)`).run(customer_id, part_number, parseFloat(price), 'Set via admin URL');
        res.json({ success: true, customer: customer.store_name, part: part_number, price: parseFloat(price) });
    } catch (err) { res.status(500).send('Error: ' + err.message); }
});

app.get('/admin/approve-customer', (req, res) => {
    const { secret, customer_id } = req.query;
    if (secret !== 'durauto2026') return res.status(403).send('Forbidden');
    try {
        db.prepare(`UPDATE customers SET status = 'approved' WHERE customer_id = ?`).run(customer_id);
        res.json({ success: true, message: `Customer ${customer_id} approved` });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/admin/import-pricing', async (req, res) => {
    const { secret } = req.query;
    if (secret !== 'durauto2026') return res.status(403).send('Forbidden');
    try {
        const axios = require('axios');
        const { parse } = require('csv-parse/sync');
        const response = await axios.get('https://raw.githubusercontent.com/adhirajchaudhary-tech/truck-parts-agent/main/pricing.csv');
        const records = parse(response.data, { columns: true, skip_empty_lines: true, trim: true });
        const insertPrice = db.prepare(`INSERT OR REPLACE INTO customer_pricing (customer_id, durauto_part_number, price, notes) VALUES (?, ?, ?, ?)`);
        let successCount = 0, errorCount = 0;
        const results = [];
        for (const record of records) {
            const customerId = record['customer_id'] || '';
            const partNumber = record['durauto_part_number'] || '';
            const price = parseFloat(record['price'] || '0');
            const notes = record['notes'] || '';
            if (!customerId || !partNumber || isNaN(price)) { errorCount++; continue; }
            try { insertPrice.run(customerId, partNumber, price, notes); results.push(`✅ ${customerId} — ${partNumber}`); successCount++; }
            catch (err) { results.push(`❌ ${partNumber}: ${err.message}`); errorCount++; }
        }
        res.json({ success: true, imported: successCount, errors: errorCount, details: results });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/admin/import-photos', async (req, res) => {
    const { secret } = req.query;
    if (secret !== 'durauto2026') return res.status(403).send('Forbidden');
    try {
        const axios = require('axios');
        const { parse } = require('csv-parse/sync');
        const response = await axios.get('https://raw.githubusercontent.com/adhirajchaudhary-tech/truck-parts-agent/main/photos.csv');
        const records = parse(response.data, { columns: true, skip_empty_lines: true, trim: true });
        let successCount = 0, errorCount = 0;
        const results = [];
        for (const record of records) {
            const partNumber = record['durauto_part_number'] || '';
            const photoUrl = record['photo_url'] || '';
            if (!partNumber || !photoUrl) { errorCount++; continue; }
            try {
                const result = db.prepare(`UPDATE products SET photo_url = ? WHERE durauto_part_number = ?`).run(photoUrl, partNumber);
                if (result.changes > 0) { results.push(`✅ ${partNumber}`); successCount++; }
                else { results.push(`⚠️ ${partNumber} not found`); errorCount++; }
            } catch (err) { results.push(`❌ ${partNumber}: ${err.message}`); errorCount++; }
        }
        res.json({ success: true, updated: successCount, errors: errorCount, details: results });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Health Check ─────────────────────────────────────────────────────────────

app.get('/', (req, res) => { res.send('Vertus is running.'); });

// ─── Start Server ─────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Vertus server running on port ${PORT}`);
    console.log(`Waiting for WhatsApp messages...`);
});