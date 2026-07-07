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
    { field: 'store_name',      question: "What's the name of your store or business?" },
    { field: 'address',         question: "What's your full street address?" },
    { field: 'city_state',      question: "What city and state are you in?" },
    { field: 'email',           question: "What's the best email address for your account?" },
    { field: 'contact_name',    question: "What's the name of the main contact person?" },
    { field: 'designation',     question: "What's their role or designation? (e.g. Owner, Manager, Purchasing Agent)" },
    { field: 'business_phone',  question: "What's your business phone number?" },
    { field: 'referral',        question: "Last one — how did you hear about Durauto Parts? (press Skip to skip)" },
];

function getOnboarding(phone) {
    return db.prepare(`SELECT * FROM onboarding WHERE customer_phone = ?`).get(phone);
}

function createOnboarding(phone) {
    try {
        db.prepare(`INSERT INTO onboarding (customer_phone, step) VALUES (?, 0)`).run(phone);
    } catch (err) {
        // already exists
    }
    return getOnboarding(phone);
}

function updateOnboardingStep(phone, field, value, nextStep) {
    db.prepare(`UPDATE onboarding SET ${field} = ?, step = ? WHERE customer_phone = ?`)
        .run(value, nextStep, phone);
}

async function handleOnboarding(phone, message) {
    let onboarding = getOnboarding(phone);

    if (!onboarding) {
        // First message ever — start onboarding
        onboarding = createOnboarding(phone);

        const welcomeMsg = `👋 Welcome to *Durauto Parts LLC* — Houston's heavy-duty truck parts distributor!

To get started as a Durauto customer, I need a few quick details. Your application will be reviewed and approved within 24 hours.

Let's begin! 🚛

${ONBOARDING_STEPS[0].question}`;

        await sendMessage(phone, welcomeMsg);
        saveConversationMessage(phone, 'vertus', welcomeMsg);
        return true;
    }

    const currentStep = onboarding.step;

    // All steps completed — waiting for approval
    if (currentStep >= ONBOARDING_STEPS.length) {
        const waitMsg = `Your application is under review. We'll notify you as soon as you're approved — usually within 24 hours. 

If you have urgent questions, call us directly at our Houston office.`;
        await sendMessage(phone, waitMsg);
        saveConversationMessage(phone, 'vertus', waitMsg);
        return true;
    }

    // Save the answer to current step
    const currentField = ONBOARDING_STEPS[currentStep].field;
    const answer = message.trim().toLowerCase() === 'skip' ? '' : message.trim();
    const nextStep = currentStep + 1;

    updateOnboardingStep(phone, currentField, answer, nextStep);
    saveConversationMessage(phone, 'customer', message);

    if (nextStep < ONBOARDING_STEPS.length) {
        // Ask next question
        const nextQuestion = ONBOARDING_STEPS[nextStep].question;
        await sendMessage(phone, nextQuestion);
        saveConversationMessage(phone, 'vertus', nextQuestion);
    } else {
        // All done — save to customers table and notify
        const updated = getOnboarding(phone);

        // Update customer record with collected info
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

        const doneMsg = `✅ Thanks! Here's a summary of your application:

🏪 Store: ${updated.store_name}
📍 Address: ${updated.address}, ${updated.city_state}
📧 Email: ${updated.email}
👤 Contact: ${updated.contact_name} (${updated.designation})
📞 Phone: ${updated.business_phone}

Your application has been submitted to the Durauto team. We'll review it and reach out within 24 hours to get you set up.

Talk soon! 🚛`;

        await sendMessage(phone, doneMsg);
        saveConversationMessage(phone, 'vertus', doneMsg);
    }

    return true;
}

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

function searchByCategory(searchTerm) {
    const term = searchTerm.trim().toUpperCase();

    const products = db.prepare(`
        SELECT durauto_part_number, part_name, category, sub_category, price
        FROM products
        WHERE UPPER(category) LIKE ?
        OR UPPER(sub_category) LIKE ?
        OR UPPER(part_name) LIKE ?
        OR UPPER(description) LIKE ?
        ORDER BY category, sub_category, part_name
    `).all(`%${term}%`, `%${term}%`, `%${term}%`, `%${term}%`);

    return products;
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
            INSERT INTO customers (customer_id, phone, store_name, contact_name, paused, status)
            VALUES (?, ?, 'Unknown Store', 'Unknown Contact', 0, 'pending')
        `).run(customerId, normalizedPhone);

        customer = db.prepare(`
            SELECT * FROM customers WHERE phone = ?
        `).get(normalizedPhone);

        console.log(`New customer created: ${customerId} — ${normalizedPhone}`);
    }

    return customer;
}

function saveConversationMessage(phone, role, message) {
    try {
        db.prepare(`
            INSERT INTO conversations (customer_phone, role, message)
            VALUES (?, ?, ?)
        `).run(phone.replace('whatsapp:', ''), role, message);
    } catch (err) {
        // conversations table might not exist yet
    }
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

    // ─── Check customer status ────────────────────────────────────────────────

    // Pending or no status — handle onboarding
    if (!customer.status || customer.status === 'pending') {
        const onboarding = getOnboarding(normalizedPhone);
        const isComplete = onboarding && onboarding.step >= ONBOARDING_STEPS.length;

        if (isComplete) {
            // Application submitted, waiting for approval
            const waitMsg = `Your application is still under review. We'll notify you as soon as you're approved — usually within 24 hours. 🕐`;
            await sendMessage(normalizedPhone, waitMsg);
            saveConversationMessage(normalizedPhone, 'vertus', waitMsg);
            return null;
        }

        // Continue onboarding
        await handleOnboarding(normalizedPhone, userMessage);
        return null;
    }

    // Rejected
    if (customer.status === 'rejected') {
        const rejectedMsg = `Sorry, your application was not approved at this time. Please contact us directly at adhirajchaudhary@gmail.com for more information.`;
        await sendMessage(normalizedPhone, rejectedMsg);
        saveConversationMessage(normalizedPhone, 'vertus', rejectedMsg);
        return null;
    }

    // If customer is paused, just log the message and skip AI
    if (customer.paused) {
        saveConversationMessage(normalizedPhone, 'customer', userMessage);
        console.log(`Customer ${customerPhone} is paused — message logged, no auto-reply`);
        return null;
    }

    // ─── Approved customer — normal chat flow ─────────────────────────────────

    if (!conversations[customerPhone]) {
        conversations[customerPhone] = [];
    }

    const history = conversations[customerPhone];
    const messageLower = userMessage.toLowerCase();

    // ─── Category Browse Detection ────────────────────────────────────────────
    const browseKeywords = [
        'brake shoe', 'brake chamber', 'slack adjuster', 'manual slack',
        'air brake', 'coolant reservoir', 'hub cap', 'air hose',
        'what do you have', 'what have you got', 'show me all', 'list all',
        'types of', 'kinds of', 'all your', 'what parts', 'what products',
        'do you carry', 'do you sell', 'what brake', 'what slack',
        'how many', 'what kind of'
    ];

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
                results.forEach((p, i) => {
                    categoryContext += `${i + 1}. ${p.durauto_part_number} — ${p.part_name}\n`;
                });
                categoryContext += `\nTotal: ${results.length} products found.\n`;
            }
        } else {
            const allCategories = db.prepare(`
                SELECT category, COUNT(*) as count 
                FROM products 
                GROUP BY category 
                ORDER BY category
            `).all();

            categoryContext = '\nPRODUCT CATALOG SUMMARY:\n';
            allCategories.forEach(cat => {
                categoryContext += `- ${cat.category}: ${cat.count} products\n`;
            });
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

    // ─── Order History ────────────────────────────────────────────────────────
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

    const systemData = `\n\n[SYSTEM DATA — DO NOT SHOW RAW]:\n${productContext}${categoryContext}${orderContext}\nCustomer: ${customer.store_name} (${customer.customer_id})`;

    saveConversationMessage(normalizedPhone, 'customer', userMessage);

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
        const productWithPhoto = db.prepare(`
            SELECT photo_url FROM products 
            WHERE durauto_part_number = ?
        `).get(partNumber);

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

    const html = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Vertus Admin Dashboard</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f0f2f5; }
        .header { background: #1a5276; color: white; padding: 16px 24px; display: flex; align-items: center; justify-content: space-between; }
        .header h1 { font-size: 20px; font-weight: 600; }
        .header .status { font-size: 12px; background: #27ae60; padding: 4px 10px; border-radius: 12px; }
        .tabs { display: flex; background: #154360; }
        .tab { padding: 10px 20px; color: rgba(255,255,255,0.7); cursor: pointer; font-size: 13px; font-weight: 500; border-bottom: 2px solid transparent; }
        .tab.active { color: white; border-bottom-color: #3498db; }
        .tab-content { display: none; }
        .tab-content.active { display: flex; height: calc(100vh - 96px); }
        .sidebar { width: 320px; background: white; border-right: 1px solid #e0e0e0; overflow-y: auto; flex-shrink: 0; }
        .sidebar-header { padding: 16px; border-bottom: 1px solid #e0e0e0; font-weight: 600; color: #333; font-size: 14px; }
        .customer-item { padding: 14px 16px; border-bottom: 1px solid #f0f0f0; cursor: pointer; transition: background 0.1s; }
        .customer-item:hover { background: #f5f5f5; }
        .customer-item.active { background: #ebf3fb; border-left: 3px solid #1a5276; }
        .customer-name { font-weight: 600; font-size: 14px; color: #222; }
        .customer-phone { font-size: 12px; color: #888; margin-top: 2px; }
        .customer-last { font-size: 12px; color: #aaa; margin-top: 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 260px; }
        .customer-time { font-size: 11px; color: #bbb; float: right; }
        .paused-badge { font-size: 10px; background: #e74c3c; color: white; padding: 2px 6px; border-radius: 10px; margin-left: 4px; }
        .pending-badge { font-size: 10px; background: #f39c12; color: white; padding: 2px 6px; border-radius: 10px; margin-left: 4px; }
        .chat-area { flex: 1; display: flex; flex-direction: column; min-width: 0; }
        .chat-header { padding: 12px 20px; background: white; border-bottom: 1px solid #e0e0e0; display: flex; align-items: center; justify-content: space-between; }
        .chat-header-info h2 { font-size: 16px; font-weight: 600; color: #222; }
        .chat-header-info p { font-size: 12px; color: #888; margin-top: 2px; }
        .header-btns { display: flex; gap: 8px; }
        .pause-btn { padding: 8px 16px; border: none; border-radius: 8px; cursor: pointer; font-size: 13px; font-weight: 600; transition: all 0.2s; }
        .pause-btn.paused { background: #e74c3c; color: white; }
        .pause-btn.active { background: #27ae60; color: white; }
        .pause-btn:disabled { opacity: 0.5; cursor: not-allowed; }
        .messages { flex: 1; overflow-y: auto; padding: 20px; display: flex; flex-direction: column; gap: 12px; }
        .message { max-width: 70%; }
        .message.customer { align-self: flex-end; }
        .message.vertus { align-self: flex-start; }
        .message.admin { align-self: flex-end; }
        .message-bubble { padding: 10px 14px; border-radius: 12px; font-size: 14px; line-height: 1.5; word-wrap: break-word; }
        .message.customer .message-bubble { background: #dcf8c6; color: #222; border-bottom-right-radius: 4px; }
        .message.vertus .message-bubble { background: white; color: #222; border-bottom-left-radius: 4px; box-shadow: 0 1px 2px rgba(0,0,0,0.1); }
        .message.admin .message-bubble { background: #3498db; color: white; border-bottom-right-radius: 4px; }
        .message-time { font-size: 11px; color: #aaa; margin-top: 4px; text-align: right; }
        .message.vertus .message-time { text-align: left; }
        .message-label { font-size: 11px; color: #888; margin-bottom: 3px; }
        .message.admin .message-label { text-align: right; }
        .empty-state { flex: 1; display: flex; align-items: center; justify-content: center; color: #aaa; font-size: 14px; flex-direction: column; gap: 8px; }
        .paused-banner { background: #fdf2f2; border-top: 1px solid #f5c6cb; padding: 8px 16px; font-size: 12px; color: #e74c3c; text-align: center; }
        .reply-box { padding: 12px 16px; background: white; border-top: 1px solid #e0e0e0; display: flex; gap: 10px; align-items: flex-end; }
        .reply-box textarea { flex: 1; padding: 10px 14px; border: 1px solid #ddd; border-radius: 20px; font-size: 14px; resize: none; outline: none; font-family: inherit; max-height: 100px; }
        .reply-box textarea:focus { border-color: #1a5276; }
        .send-btn { padding: 10px 20px; background: #1a5276; color: white; border: none; border-radius: 20px; cursor: pointer; font-size: 14px; font-weight: 600; }
        .send-btn:disabled { opacity: 0.5; }
        .refresh-bar { padding: 6px 16px; background: #f8f8f8; border-top: 1px solid #e0e0e0; font-size: 11px; color: #aaa; text-align: center; }
        .badge { background: #e74c3c; color: white; font-size: 10px; padding: 2px 6px; border-radius: 10px; margin-left: 6px; }
        .pending-count { background: #f39c12; color: white; font-size: 10px; padding: 2px 6px; border-radius: 10px; margin-left: 6px; }
        .no-customers { padding: 20px; text-align: center; color: #aaa; font-size: 13px; }
        .pending-list { flex: 1; overflow-y: auto; padding: 20px; }
        .pending-card { background: white; border-radius: 12px; padding: 20px; margin-bottom: 16px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
        .pending-card h3 { font-size: 16px; font-weight: 600; color: #222; margin-bottom: 12px; }
        .pending-field { display: flex; margin-bottom: 8px; font-size: 14px; }
        .pending-label { color: #888; width: 140px; flex-shrink: 0; }
        .pending-value { color: #222; font-weight: 500; }
        .pending-actions { display: flex; gap: 10px; margin-top: 16px; }
        .approve-btn { padding: 10px 24px; background: #27ae60; color: white; border: none; border-radius: 8px; cursor: pointer; font-size: 14px; font-weight: 600; }
        .reject-btn { padding: 10px 24px; background: #e74c3c; color: white; border: none; border-radius: 8px; cursor: pointer; font-size: 14px; font-weight: 600; }
        .approve-btn:disabled, .reject-btn:disabled { opacity: 0.5; cursor: not-allowed; }
        .no-pending { text-align: center; color: #aaa; padding: 60px 20px; font-size: 14px; }
    </style>
</head>
<body>
    <div class="header">
        <h1>🚛 Vertus Admin Dashboard</h1>
        <span class="status">● Live</span>
    </div>
    <div class="tabs">
        <div class="tab active" onclick="switchTab('conversations')">Conversations <span id="convCount"></span></div>
        <div class="tab" onclick="switchTab('pending')">Pending Approvals <span id="pendingCount"></span></div>
    </div>

    <!-- Conversations Tab -->
    <div class="tab-content active" id="tab-conversations">
        <div class="sidebar">
            <div class="sidebar-header">Customers <span id="customerCount"></span></div>
            <div id="customerList"></div>
        </div>
        <div class="chat-area">
            <div class="chat-header" id="chatHeader">
                <div class="chat-header-info">
                    <h2>Select a customer</h2>
                    <p>Click a customer on the left to view their conversation</p>
                </div>
            </div>
            <div class="messages" id="messageArea">
                <div class="empty-state">👈 Select a customer to view messages</div>
            </div>
            <div id="pausedBanner" style="display:none" class="paused-banner">
                🔴 Vertus is paused for this customer — you are in manual mode
            </div>
            <div class="reply-box" id="replyBox" style="display:none">
                <textarea id="replyText" placeholder="Type a message to send directly to customer..." rows="1"></textarea>
                <button class="send-btn" id="sendBtn" onclick="sendManualMessage()">Send</button>
            </div>
            <div class="refresh-bar">Auto-refreshes every 10 seconds</div>
        </div>
    </div>

    <!-- Pending Tab -->
    <div class="tab-content" id="tab-pending">
        <div class="pending-list" id="pendingList">
            <div class="no-pending">Loading...</div>
        </div>
    </div>

    <script>
        let selectedPhone = null;
        let selectedPaused = false;
        const secret = new URLSearchParams(window.location.search).get('secret');

        function switchTab(tab) {
            document.querySelectorAll('.tab').forEach((t, i) => {
                t.classList.toggle('active', (i === 0 && tab === 'conversations') || (i === 1 && tab === 'pending'));
            });
            document.getElementById('tab-conversations').classList.toggle('active', tab === 'conversations');
            document.getElementById('tab-pending').classList.toggle('active', tab === 'pending');
            if (tab === 'pending') loadPending();
        }

        async function loadCustomers() {
            try {
                const res = await fetch('/admin/api/customers?secret=' + secret);
                const data = await res.json();
                const approved = data.filter(c => c.status === 'approved' || !c.status);
                document.getElementById('customerCount').innerHTML = '<span class="badge">' + approved.length + '</span>';
                document.getElementById('convCount').innerHTML = '<span class="badge">' + approved.length + '</span>';

                const list = document.getElementById('customerList');
                if (approved.length === 0) {
                    list.innerHTML = '<div class="no-customers">No approved customers yet.</div>';
                    return;
                }
                list.innerHTML = '';
                approved.forEach(c => {
                    const div = document.createElement('div');
                    div.className = 'customer-item' + (selectedPhone === c.phone ? ' active' : '');
                    div.onclick = () => selectCustomer(c.phone, c.store_name, c.contact_name, c.paused);
                    const time = c.last_message_time ?
                        new Date(c.last_message_time + ' UTC').toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'}) : '';
                    const pausedBadge = c.paused ? '<span class="paused-badge">PAUSED</span>' : '';
                    div.innerHTML =
                        '<span class="customer-time">' + time + '</span>' +
                        '<div class="customer-name">' + (c.store_name || 'Unknown') + pausedBadge + '</div>' +
                        '<div class="customer-phone">' + c.phone + '</div>' +
                        '<div class="customer-last">' + (c.last_message || 'No messages yet') + '</div>';
                    list.appendChild(div);
                });
                if (selectedPhone) {
                    const current = approved.find(c => c.phone === selectedPhone);
                    if (current) updatePauseButton(current.paused);
                }
            } catch (err) {
                console.error('Error loading customers:', err);
            }
        }

        async function loadPending() {
            try {
                const res = await fetch('/admin/api/pending?secret=' + secret);
                const data = await res.json();
                document.getElementById('pendingCount').innerHTML =
                    data.length > 0 ? '<span class="pending-count">' + data.length + '</span>' : '';

                const list = document.getElementById('pendingList');
                if (data.length === 0) {
                    list.innerHTML = '<div class="no-pending">✅ No pending applications right now.</div>';
                    return;
                }
                list.innerHTML = '';
                data.forEach(app => {
                    const card = document.createElement('div');
                    card.className = 'pending-card';
                    card.innerHTML =
                        '<h3>' + (app.store_name || 'Unknown Store') + '</h3>' +
                        '<div class="pending-field"><span class="pending-label">📍 Address</span><span class="pending-value">' + (app.address || '—') + '</span></div>' +
                        '<div class="pending-field"><span class="pending-label">🏙️ City/State</span><span class="pending-value">' + (app.city_state || '—') + '</span></div>' +
                        '<div class="pending-field"><span class="pending-label">📧 Email</span><span class="pending-value">' + (app.email || '—') + '</span></div>' +
                        '<div class="pending-field"><span class="pending-label">👤 Contact</span><span class="pending-value">' + (app.contact_name || '—') + '</span></div>' +
                        '<div class="pending-field"><span class="pending-label">💼 Designation</span><span class="pending-value">' + (app.designation || '—') + '</span></div>' +
                        '<div class="pending-field"><span class="pending-label">📞 Business Phone</span><span class="pending-value">' + (app.business_phone || '—') + '</span></div>' +
                        '<div class="pending-field"><span class="pending-label">📱 WhatsApp</span><span class="pending-value">' + app.customer_phone + '</span></div>' +
                        '<div class="pending-field"><span class="pending-label">📅 Applied</span><span class="pending-value">' + new Date(app.created_at + ' UTC').toLocaleDateString() + '</span></div>' +
                        (app.referral ? '<div class="pending-field"><span class="pending-label">🔗 Referral</span><span class="pending-value">' + app.referral + '</span></div>' : '') +
                        '<div class="pending-actions">' +
                        '<button class="approve-btn" id="approve-' + app.customer_phone + '" onclick="approveCustomer(\'' + app.customer_phone + '\', \'' + (app.store_name || '') + '\', \'' + (app.contact_name || '') + '\')">✅ Approve</button>' +
                        '<button class="reject-btn" id="reject-' + app.customer_phone + '" onclick="rejectCustomer(\'' + app.customer_phone + '\')">❌ Reject</button>' +
                        '</div>';
                    list.appendChild(card);
                });
            } catch (err) {
                console.error('Error loading pending:', err);
            }
        }

        async function approveCustomer(phone, storeName, contactName) {
            const btn = document.getElementById('approve-' + phone);
            btn.disabled = true;
            btn.textContent = 'Approving...';

            try {
                const res = await fetch('/admin/api/approve', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({secret, phone})
                });
                const data = await res.json();
                if (data.success) {
                    loadPending();
                    loadCustomers();
                } else {
                    alert('Error: ' + (data.error || 'Unknown error'));
                    btn.disabled = false;
                    btn.textContent = '✅ Approve';
                }
            } catch (err) {
                alert('Error approving customer');
                btn.disabled = false;
                btn.textContent = '✅ Approve';
            }
        }

        async function rejectCustomer(phone) {
            if (!confirm('Are you sure you want to reject this application?')) return;
            const btn = document.getElementById('reject-' + phone);
            btn.disabled = true;
            btn.textContent = 'Rejecting...';

            try {
                const res = await fetch('/admin/api/reject', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({secret, phone})
                });
                const data = await res.json();
                if (data.success) {
                    loadPending();
                } else {
                    alert('Error: ' + (data.error || 'Unknown error'));
                    btn.disabled = false;
                    btn.textContent = '❌ Reject';
                }
            } catch (err) {
                alert('Error rejecting customer');
                btn.disabled = false;
                btn.textContent = '❌ Reject';
            }
        }

        async function selectCustomer(phone, storeName, contactName, paused) {
            selectedPhone = phone;
            selectedPaused = paused;
            document.getElementById('chatHeader').innerHTML =
                '<div class="chat-header-info">' +
                '<h2>' + (storeName || 'Unknown Store') + '</h2>' +
                '<p>' + (contactName || '') + ' &bull; ' + phone + '</p>' +
                '</div>' +
                '<div class="header-btns">' +
                '<button class="pause-btn" id="pauseBtn" onclick="togglePause()">' +
                (paused ? '▶ Resume Vertus' : '⏸ Pause Vertus') +
                '</button></div>';
            document.getElementById('pauseBtn').className = 'pause-btn ' + (paused ? 'paused' : 'active');
            document.getElementById('replyBox').style.display = 'flex';
            document.getElementById('pausedBanner').style.display = paused ? 'block' : 'none';
            loadMessages(phone);
            loadCustomers();
        }

        function updatePauseButton(paused) {
            selectedPaused = paused;
            const btn = document.getElementById('pauseBtn');
            if (btn) {
                btn.textContent = paused ? '▶ Resume Vertus' : '⏸ Pause Vertus';
                btn.className = 'pause-btn ' + (paused ? 'paused' : 'active');
            }
            const banner = document.getElementById('pausedBanner');
            if (banner) banner.style.display = paused ? 'block' : 'none';
        }

        async function togglePause() {
            if (!selectedPhone) return;
            const btn = document.getElementById('pauseBtn');
            btn.disabled = true;
            try {
                const res = await fetch('/admin/api/toggle-pause?secret=' + secret + '&phone=' + encodeURIComponent(selectedPhone), {method: 'POST'});
                const data = await res.json();
                updatePauseButton(data.paused);
                loadCustomers();
            } catch (err) {
                console.error('Error:', err);
            }
            btn.disabled = false;
        }

        async function sendManualMessage() {
            if (!selectedPhone) return;
            const textarea = document.getElementById('replyText');
            const message = textarea.value.trim();
            if (!message) return;
            const btn = document.getElementById('sendBtn');
            btn.disabled = true;
            btn.textContent = 'Sending...';
            try {
                const res = await fetch('/admin/api/send-message', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({secret, phone: selectedPhone, message})
                });
                const data = await res.json();
                if (data.success) {
                    textarea.value = '';
                    loadMessages(selectedPhone);
                } else {
                    alert('Failed: ' + (data.error || 'Unknown error'));
                }
            } catch (err) {
                alert('Error sending message');
            }
            btn.disabled = false;
            btn.textContent = 'Send';
        }

        document.addEventListener('keydown', function(e) {
            if (e.key === 'Enter' && !e.shiftKey && document.activeElement.id === 'replyText') {
                e.preventDefault();
                sendManualMessage();
            }
        });

        async function loadMessages(phone) {
            try {
                const res = await fetch('/admin/api/messages?secret=' + secret + '&phone=' + encodeURIComponent(phone));
                const data = await res.json();
                const area = document.getElementById('messageArea');
                area.innerHTML = '';
                if (data.length === 0) {
                    area.innerHTML = '<div class="empty-state">No messages yet</div>';
                    return;
                }
                data.forEach(msg => {
                    const div = document.createElement('div');
                    div.className = 'message ' + msg.role;
                    const time = new Date(msg.created_at + ' UTC').toLocaleTimeString([],
                        {hour: '2-digit', minute:'2-digit'});
                    const labels = {customer: '👤 Customer', vertus: '🤖 Vertus', admin: '👨‍💼 You'};
                    const label = labels[msg.role] || msg.role;
                    div.innerHTML =
                        '<div class="message-label">' + label + '</div>' +
                        '<div class="message-bubble">' + msg.message.replace(/\n/g, '<br>') + '</div>' +
                        '<div class="message-time">' + time + '</div>';
                    area.appendChild(div);
                });
                area.scrollTop = area.scrollHeight;
            } catch (err) {
                console.error('Error loading messages:', err);
            }
        }

        setInterval(() => {
            loadCustomers();
            if (selectedPhone) loadMessages(selectedPhone);
        }, 10000);

        loadCustomers();
    </script>
</body>
</html>`;

    res.send(html);
});

// ─── Admin API Routes ─────────────────────────────────────────────────────────

app.get('/admin/api/customers', (req, res) => {
    const { secret } = req.query;
    if (secret !== 'durauto2026') return res.status(403).send('Forbidden');

    try {
        const customers = db.prepare(`
            SELECT 
                c.customer_id, c.store_name, c.contact_name,
                c.phone, c.paused, c.status,
                conv.message as last_message,
                conv.created_at as last_message_time
            FROM customers c
            LEFT JOIN conversations conv ON c.phone = conv.customer_phone
                AND conv.id = (
                    SELECT MAX(id) FROM conversations 
                    WHERE customer_phone = c.phone
                )
            ORDER BY conv.created_at DESC
        `).all();
        res.json(customers);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/admin/api/pending', (req, res) => {
    const { secret } = req.query;
    if (secret !== 'durauto2026') return res.status(403).send('Forbidden');

    try {
        const pending = db.prepare(`
            SELECT o.*, c.status
            FROM onboarding o
            LEFT JOIN customers c ON c.phone = o.customer_phone
            WHERE o.step >= ? AND (c.status = 'pending' OR c.status IS NULL)
            ORDER BY o.created_at DESC
        `).all(ONBOARDING_STEPS.length);
        res.json(pending);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/admin/api/approve', async (req, res) => {
    const { secret, phone } = req.body;
    if (secret !== 'durauto2026') return res.status(403).send('Forbidden');

    try {
        const onboarding = db.prepare('SELECT * FROM onboarding WHERE customer_phone = ?').get(phone);
        if (!onboarding) return res.status(404).json({ error: 'Application not found' });

        // Update customer status to approved
        db.prepare(`UPDATE customers SET status = 'approved' WHERE phone = ?`).run(phone);

        // Send welcome message
        const storeName = onboarding.store_name || 'there';
        const contactName = onboarding.contact_name || '';

        const welcomeMsg = `🎉 Welcome to Durauto Parts, ${contactName || storeName}!

Your account has been approved. Here's what Vertus can help you with:

🔍 Look up any part by number or category
💰 Get your custom pricing instantly
📸 View product photos
🛒 Place orders and get instant PDF invoices
📋 Check your order history

Just send me a message to get started. What can I help you with today?`;

        await sendMessage(phone, welcomeMsg);
        saveConversationMessage(phone, 'vertus', welcomeMsg);

        console.log(`Customer ${phone} approved and welcomed`);
        res.json({ success: true });
    } catch (err) {
        console.error('Approval error:', err.message);
        res.status(500).json({ error: err.message });
    }
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
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/admin/api/messages', (req, res) => {
    const { secret, phone } = req.query;
    if (secret !== 'durauto2026') return res.status(403).send('Forbidden');

    try {
        const messages = db.prepare(`
            SELECT role, message, created_at
            FROM conversations
            WHERE customer_phone = ?
            ORDER BY created_at ASC
        `).all(phone);
        res.json(messages);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/admin/api/toggle-pause', (req, res) => {
    const { secret, phone } = req.query;
    if (secret !== 'durauto2026') return res.status(403).send('Forbidden');

    try {
        const customer = db.prepare('SELECT * FROM customers WHERE phone = ?').get(phone);
        if (!customer) return res.status(404).json({ error: 'Customer not found' });

        const newPaused = customer.paused ? 0 : 1;
        db.prepare('UPDATE customers SET paused = ? WHERE phone = ?').run(newPaused, phone);
        res.json({ success: true, paused: newPaused });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/admin/api/send-message', async (req, res) => {
    const { secret, phone, message } = req.body;
    if (secret !== 'durauto2026') return res.status(403).send('Forbidden');

    try {
        await sendMessage(phone, message);
        saveConversationMessage(phone, 'admin', message);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── Admin Routes ─────────────────────────────────────────────────────────────

app.get('/admin/migrate', (req, res) => {
    const { secret } = req.query;
    if (secret !== 'durauto2026') return res.status(403).send('Forbidden');

    const results = [];

    try {
        db.exec(`ALTER TABLE products ADD COLUMN photo_url TEXT`);
        results.push('✅ photo_url column added');
    } catch (err) {
        if (err.message.includes('duplicate column')) {
            results.push('ℹ️ photo_url already exists');
        } else results.push(`❌ ${err.message}`);
    }

    try {
        db.exec(`CREATE TABLE IF NOT EXISTS conversations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            customer_phone TEXT, role TEXT, message TEXT,
            created_at TEXT DEFAULT (datetime('now'))
        )`);
        results.push('✅ conversations table ready');
    } catch (err) {
        results.push(`❌ ${err.message}`);
    }

    try {
        db.exec(`ALTER TABLE customers ADD COLUMN paused INTEGER DEFAULT 0`);
        results.push('✅ paused column added');
    } catch (err) {
        if (err.message.includes('duplicate column')) {
            results.push('ℹ️ paused column already exists');
        } else results.push(`❌ ${err.message}`);
    }

    try {
        db.exec(`ALTER TABLE customers ADD COLUMN status TEXT DEFAULT 'pending'`);
        results.push('✅ status column added');
    } catch (err) {
        if (err.message.includes('duplicate column')) {
            results.push('ℹ️ status column already exists');
        } else results.push(`❌ ${err.message}`);
    }

    try {
        db.exec(`CREATE TABLE IF NOT EXISTS onboarding (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            customer_phone TEXT UNIQUE, store_name TEXT,
            address TEXT, city_state TEXT, email TEXT,
            contact_name TEXT, designation TEXT,
            business_phone TEXT, referral TEXT,
            step INTEGER DEFAULT 0,
            created_at TEXT DEFAULT (datetime('now'))
        )`);
        results.push('✅ onboarding table ready');
    } catch (err) {
        results.push(`❌ ${err.message}`);
    }

    res.json({ success: true, results });
});

app.get('/admin/approve-customer', (req, res) => {
    const { secret, customer_id } = req.query;
    if (secret !== 'durauto2026') return res.status(403).send('Forbidden');

    try {
        db.prepare(`UPDATE customers SET status = 'approved' WHERE customer_id = ?`).run(customer_id);
        res.json({ success: true, message: `Customer ${customer_id} approved` });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
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

    if (!customer_id || !part_number || !price) {
        return res.send('Missing params.');
    }

    try {
        const customer = db.prepare('SELECT * FROM customers WHERE customer_id = ?').get(customer_id);
        if (!customer) {
            const all = db.prepare('SELECT customer_id, phone, store_name FROM customers').all();
            return res.json({ error: 'Customer not found', existing_customers: all });
        }

        db.prepare(`INSERT OR REPLACE INTO customer_pricing (customer_id, durauto_part_number, price, notes) VALUES (?, ?, ?, ?)`)
            .run(customer_id, part_number, parseFloat(price), 'Set via admin URL');

        res.json({ success: true, customer: customer.store_name, part: part_number, price: parseFloat(price) });
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
            try {
                insertPrice.run(customerId, partNumber, price, notes);
                results.push(`✅ ${customerId} — ${partNumber} — $${price.toFixed(2)}`);
                successCount++;
            } catch (err) {
                results.push(`❌ ${partNumber}: ${err.message}`);
                errorCount++;
            }
        }

        res.json({ success: true, imported: successCount, errors: errorCount, details: results });
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
                else { results.push(`⚠️ ${partNumber} — not found`); errorCount++; }
            } catch (err) {
                results.push(`❌ ${partNumber}: ${err.message}`);
                errorCount++;
            }
        }

        res.json({ success: true, updated: successCount, errors: errorCount, details: results });
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