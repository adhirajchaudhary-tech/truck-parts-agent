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

async function sendMessage(to, body) {
    const toNumber = to.startsWith('whatsapp:') ? to : `whatsapp:${to}`;
    await twilioClient.messages.create({
        from: process.env.TWILIO_WHATSAPP_NUMBER,
        to: toNumber,
        body
    });
}

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
    try { db.prepare('INSERT INTO onboarding (customer_phone, step) VALUES (?, 0)').run(phone); } catch (err) {}
    return getOnboarding(phone);
}

function updateOnboardingStep(phone, field, value, nextStep) {
    db.prepare(`UPDATE onboarding SET ${field} = ?, step = ? WHERE customer_phone = ?`).run(value, nextStep, phone);
}

function cleanAnswer(field, rawAnswer) {
    let answer = rawAnswer.trim();
    if (field === 'store_name') {
        answer = answer
            .replace(/^my store( name)? is\s*/i, '')
            .replace(/^the store( name)? is\s*/i, '')
            .replace(/^it'?s?\s+(called\s+)?/i, '')
            .replace(/^we are\s*/i, '')
            .replace(/^our (store|business|shop)( name)? is\s*/i, '')
            .replace(/^(store|business|shop) name[:\s]+/i, '')
            .replace(/^name[:\s]+/i, '')
            .trim();
    }
    if (field === 'contact_name') {
        answer = answer
            .replace(/^my name is\s*/i, '')
            .replace(/^the contact is\s*/i, '')
            .replace(/^contact[:\s]+/i, '')
            .replace(/^i'?m\s*/i, '')
            .replace(/^it'?s?\s*/i, '')
            .trim();
    }
    if (field === 'email') {
        const emailMatch = answer.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/);
        if (emailMatch) answer = emailMatch[0];
    }
    if (field === 'business_phone') {
        const phoneMatch = answer.match(/[\+\d\s\-\(\)]{7,}/);
        if (phoneMatch) answer = phoneMatch[0].trim();
    }
    return answer;
}

async function handleOnboarding(phone, message) {
    let onboarding = getOnboarding(phone);
    if (!onboarding) {
        onboarding = createOnboarding(phone);
        const welcomeMsg = `👋 Welcome to *Durauto Parts LLC* — Houston's heavy-duty truck parts distributor!\n\nTo get started as a Durauto customer, I need a few quick details. Your application will be reviewed and approved within 24 hours.\n\nLet's begin! 🚛\n\n${ONBOARDING_STEPS[0].question}`;
        await sendMessage(phone, welcomeMsg);
        saveConversationMessage(phone, 'vertus', welcomeMsg);
        return;
    }
    const currentStep = onboarding.step;
    if (currentStep >= ONBOARDING_STEPS.length) {
        const waitMsg = `Your application is under review. We'll notify you as soon as you're approved — usually within 24 hours. 🕐`;
        await sendMessage(phone, waitMsg);
        saveConversationMessage(phone, 'vertus', waitMsg);
        return;
    }
    const currentField = ONBOARDING_STEPS[currentStep].field;
    const rawAnswer = message.trim().toLowerCase() === 'skip' ? '' : message.trim();
    const answer = rawAnswer ? cleanAnswer(currentField, rawAnswer) : '';
    const nextStep = currentStep + 1;
    updateOnboardingStep(phone, currentField, answer, nextStep);
    saveConversationMessage(phone, 'customer', message);
    if (nextStep < ONBOARDING_STEPS.length) {
        const nextQuestion = ONBOARDING_STEPS[nextStep].question;
        await sendMessage(phone, nextQuestion);
        saveConversationMessage(phone, 'vertus', nextQuestion);
    } else {
        const updated = getOnboarding(phone);
        db.prepare(`UPDATE customers SET store_name = ?, contact_name = ?, email = ?, address = ?, status = 'pending' WHERE phone = ?`).run(
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
}

function findProduct(searchTerm) {
    const term = searchTerm.trim().toUpperCase();
    let product = db.prepare(`SELECT * FROM products WHERE UPPER(durauto_part_number) = ?`).get(term);
    if (!product) {
        const ref = db.prepare(`SELECT durauto_part_number FROM cross_references WHERE UPPER(cross_ref_number) = ?`).get(term);
        if (ref) product = db.prepare(`SELECT * FROM products WHERE durauto_part_number = ?`).get(ref.durauto_part_number);
    }
    if (!product) product = db.prepare(`SELECT * FROM products WHERE UPPER(durauto_part_number) LIKE ?`).get(`%${term}%`);
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
    return db.prepare(`SELECT durauto_part_number, part_name, category, sub_category, stock_quantity FROM products WHERE UPPER(category) LIKE ? OR UPPER(sub_category) LIKE ? OR UPPER(part_name) LIKE ? OR UPPER(description) LIKE ? ORDER BY category, part_name`).all(`%${term}%`, `%${term}%`, `%${term}%`, `%${term}%`);
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

function getTrackingUrl(carrier, trackingNumber) {
    const carriers = {
        'fedex': `https://www.fedex.com/fedextrack/?trknbr=${trackingNumber}`,
        'ups': `https://www.ups.com/track?tracknum=${trackingNumber}`,
        'usps': `https://tools.usps.com/go/TrackConfirmAction?qtc_tLabels1=${trackingNumber}`,
        'dhl': `https://www.dhl.com/en/express/tracking.html?AWB=${trackingNumber}`,
    };
    const key = carrier.toLowerCase().replace(/\s+/g, '');
    return carriers[key] || null;
}

// ─── Pending Return State ─────────────────────────────────────────────────────
// Tracks customers who are mid-return flow waiting to send a photo
const pendingReturns = {};

const systemPrompt = `
You are Vertus, the ordering assistant for Durauto Parts LLC — a distributor of heavy-duty truck parts based in Houston, TX.

You help retail customers do the following:
1. Place new orders by part number and quantity
2. View their order history and track shipments
3. Reorder from a previous order with option to adjust quantities
4. Get product specifications
5. View product photos
6. Browse products by category
7. Check stock availability
8. Request order cancellations, changes, or returns

Your personality:
- Friendly, professional, and efficient
- Keep responses short and clear — customers are on WhatsApp, not a computer
- Use plain text formatting — avoid markdown tables, use simple lists instead
- Always confirm orders before finalizing
- Never make up product details
- CRITICAL: Send only ONE message per customer message. Never say "OK" or "Okay" as a separate message. Get straight to the point.

How you handle orders:
- Extract part number and quantity from the customer's message
- Confirm the order back clearly before finalizing
- When the customer confirms with yes, include this exact tag in your response:
  [SAVE_ORDER: partNumber=X, quantity=Y, partName=Z, price=P]
- For multiple items use one tag per item on separate lines
- Only include the SAVE_ORDER tag after the customer confirms with yes

How you handle photo requests:
- When a customer asks to see a photo, include: [SEND_PHOTO: partNumber=X]
- Only if Photo Available is Yes

How you handle product lookups:
- Use ONLY the product data provided
- Plain text, no markdown tables
- Show details for all products found

How you handle stock availability:
- 0 stock = out of stock
- Above 0 = in stock
- Only give exact number if asked

How you handle order tracking:
- Share carrier, tracking number, expected delivery and URL if available

How you handle cancellation requests:
- When a customer wants to cancel an order, include this tag:
  [REQUEST_CANCEL: orderId=X, reason=Y]
- Tell them the request has been logged and team will confirm within 24 hours
- Do NOT auto-cancel

How you handle change requests:
- When a customer wants to change an order, include this tag:
  [REQUEST_CHANGE: orderId=X, details=Y]
- Tell them the request has been logged and team will confirm within 24 hours
- Do NOT auto-change

How you handle return requests:
- When a customer wants to return an order, first ask for the reason
- Once they give a reason, include this tag and ask them to send a photo:
  [REQUEST_RETURN: orderId=X, reason=Y]
- Tell them to send a photo of the item as proof
- Photo proof is required for all returns

What you don't do:
- Never guess product details
- Never finalize orders without confirmation
- Never auto-cancel, auto-change, or auto-approve returns
- Never discuss topics unrelated to Durauto Parts LLC
- Never send more than one message per customer message
`;

async function chat(customerPhone, userMessage, mediaUrl) {
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
        const rejectedMsg = `Sorry, your application was not approved at this time. Please contact us at adhirajchaudhary@gmail.com for more information.`;
        await sendMessage(normalizedPhone, rejectedMsg);
        saveConversationMessage(normalizedPhone, 'vertus', rejectedMsg);
        return null;
    }

    if (customer.paused) {
        saveConversationMessage(normalizedPhone, 'customer', userMessage);
        console.log(`Customer ${customerPhone} is paused — message logged`);
        return null;
    }

    // ─── Handle Return Photo Upload ───────────────────────────────────────────
    if (mediaUrl && pendingReturns[normalizedPhone]) {
        const pending = pendingReturns[normalizedPhone];
        db.prepare(`
            UPDATE order_requests SET photo_url = ?, status = 'pending_review'
            WHERE id = ?
        `).run(mediaUrl, pending.requestId);
        delete pendingReturns[normalizedPhone];

        const confirmMsg = `📸 Photo received! Your return request for *${pending.orderId}* is now complete.\n\nOur team will review it and get back to you within 24 hours with next steps.`;
        await sendMessage(normalizedPhone, confirmMsg);
        saveConversationMessage(normalizedPhone, 'vertus', confirmMsg);
        saveConversationMessage(normalizedPhone, 'customer', '[Photo uploaded]');
        console.log(`Return photo received for ${pending.orderId}`);
        return null;
    }

    if (!conversations[customerPhone]) conversations[customerPhone] = [];
    const history = conversations[customerPhone];
    const messageLower = userMessage.toLowerCase();

    // ─── Order Tracking ───────────────────────────────────────────────────────
    let trackingContext = '';
    const trackingMatch = userMessage.match(/DRA\d+/i);
    if (trackingMatch || messageLower.includes('track') || messageLower.includes('where is my order') || messageLower.includes('status of my order')) {
        const orderId = trackingMatch ? trackingMatch[0].toUpperCase() : null;
        if (orderId) {
            const order = db.prepare(`SELECT * FROM orders WHERE order_id = ? AND customer_id = ?`).get(orderId, customer.customer_id);
            if (order) {
                const orderItems = db.prepare(`SELECT * FROM order_items WHERE order_id = ?`).all(orderId);
                const trackingUrl = order.carrier && order.tracking_number ? getTrackingUrl(order.carrier, order.tracking_number) : null;
                trackingContext = `\nORDER TRACKING:\n- Order ID: ${order.order_id}\n- Status: ${order.status}\n- Placed: ${order.created_at}\n`;
                if (order.carrier) trackingContext += `- Carrier: ${order.carrier}\n`;
                if (order.tracking_number) trackingContext += `- Tracking #: ${order.tracking_number}\n`;
                if (order.estimated_delivery) trackingContext += `- Expected Delivery: ${order.estimated_delivery}\n`;
                if (order.shipped_at) trackingContext += `- Shipped: ${order.shipped_at}\n`;
                if (trackingUrl) trackingContext += `- Tracking URL: ${trackingUrl}\n`;
                trackingContext += `Items:\n`;
                orderItems.forEach(item => { trackingContext += `  • ${item.durauto_part_number} — ${item.part_name} x${item.quantity}\n`; });
            } else {
                trackingContext = `\nORDER TRACKING: Order ${orderId} not found for this customer.\n`;
            }
        } else {
            const recentOrders = db.prepare(`SELECT * FROM orders WHERE customer_id = ? ORDER BY created_at DESC LIMIT 5`).all(customer.customer_id);
            if (recentOrders.length > 0) {
                trackingContext = '\nRECENT ORDER STATUSES:\n';
                recentOrders.forEach(order => {
                    trackingContext += `\n${order.order_id} — ${order.status}`;
                    if (order.carrier) trackingContext += ` — ${order.carrier}`;
                    if (order.tracking_number) trackingContext += ` #${order.tracking_number}`;
                    if (order.estimated_delivery) trackingContext += ` — ETA: ${order.estimated_delivery}`;
                    trackingContext += '\n';
                });
            }
        }
    }

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
                results.forEach((p, i) => {
                    const stockStatus = p.stock_quantity > 0 ? `In Stock` : 'Out of Stock';
                    categoryContext += `${i + 1}. ${p.durauto_part_number} — ${p.part_name} — ${stockStatus}\n`;
                });
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
    const foundProducts = [];

    for (const word of words) {
        const cleaned = word.replace(/[^a-zA-Z0-9\-]/g, '');
        if (cleaned.length > 3) {
            const product = findProduct(cleaned);
            if (product && !foundProducts.find(p => p.durauto_part_number === product.durauto_part_number)) {
                foundProducts.push(product);
            }
        }
    }

    if (foundProducts.length > 0) {
        foundProducts.forEach(product => {
            const customerPrice = getCustomerPrice(customer.customer_id, product.durauto_part_number);
            const stockQty = product.stock_quantity || 0;
            const stockStatus = stockQty > 0
                ? `In Stock (${stockQty} units available)`
                : product.restock_date
                    ? `Out of Stock — Expected restock: ${product.restock_date}`
                    : 'Out of Stock — Contact us for availability';
            productContext += `\nPRODUCT FOUND:\n- Durauto Part #: ${product.durauto_part_number}\n- Name: ${product.part_name}\n- Category: ${product.category} > ${product.sub_category}\n- Brand: ${product.brand}\n- Description: ${product.description}\n- Application: ${product.application}\n- Specification: ${product.specification}\n- Price: ${customerPrice ? '$' + customerPrice : 'Contact us for pricing'}\n- Weight: ${product.weight}\n- Stock Status: ${stockStatus}\n- Cross References: ${product.cross_references.join(', ')}\n- Photo Available: ${product.photo_url ? 'Yes' : 'No'}\n`;
        });
    }

    // ─── Order History ────────────────────────────────────────────────────────
    let orderContext = '';
    if (messageLower.includes('history') || messageLower.includes('last order') || messageLower.includes('previous order') || messageLower.includes('what did i order')) {
        const orderHistory = getOrderHistory(customer.customer_id);
        if (orderHistory.length > 0) {
            orderContext = '\nORDER HISTORY:\n';
            for (const order of orderHistory) {
                orderContext += `\nOrder ${order.order_id} — ${order.created_at} — ${order.status}`;
                if (order.carrier) orderContext += ` — ${order.carrier}`;
                if (order.tracking_number) orderContext += ` #${order.tracking_number}`;
                orderContext += '\n';
                for (const item of order.items) orderContext += `  • ${item.durauto_part_number} — ${item.part_name} x${item.quantity}\n`;
            }
        } else {
            orderContext = '\nORDER HISTORY: No previous orders found.\n';
        }
    }

    const systemData = `\n\n[SYSTEM DATA — DO NOT SHOW RAW]:\n${productContext}${categoryContext}${trackingContext}${orderContext}\nCustomer: ${customer.store_name} (${customer.customer_id})`;

    saveConversationMessage(normalizedPhone, 'customer', userMessage);
    history.push({ role: "user", content: userMessage + systemData });

    const response = await client.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 1024,
        system: systemPrompt,
        messages: history
    });

    let vertusReply = response.content[0].text;

    // ─── Handle Cancel Request ────────────────────────────────────────────────
    const cancelMatch = vertusReply.match(/\[REQUEST_CANCEL: orderId=([^,\]]+),\s*reason=([^\]]+)\]/);
    if (cancelMatch) {
        const orderId = cancelMatch[1].trim();
        const reason = cancelMatch[2].trim();
        const order = db.prepare('SELECT * FROM orders WHERE order_id = ? AND customer_id = ?').get(orderId, customer.customer_id);
        if (order) {
            db.prepare(`INSERT INTO order_requests (order_id, customer_id, request_type, reason) VALUES (?, ?, 'cancel', ?)`).run(orderId, customer.customer_id, reason);
            console.log(`Cancel request logged for ${orderId}`);
        }
        vertusReply = vertusReply.replace(/\[REQUEST_CANCEL:[^\]]+\]/g, '').trim();
    }

    // ─── Handle Change Request ────────────────────────────────────────────────
    const changeMatch = vertusReply.match(/\[REQUEST_CHANGE: orderId=([^,\]]+),\s*details=([^\]]+)\]/);
    if (changeMatch) {
        const orderId = changeMatch[1].trim();
        const details = changeMatch[2].trim();
        const order = db.prepare('SELECT * FROM orders WHERE order_id = ? AND customer_id = ?').get(orderId, customer.customer_id);
        if (order) {
            db.prepare(`INSERT INTO order_requests (order_id, customer_id, request_type, change_details) VALUES (?, ?, 'change', ?)`).run(orderId, customer.customer_id, details);
            console.log(`Change request logged for ${orderId}`);
        }
        vertusReply = vertusReply.replace(/\[REQUEST_CHANGE:[^\]]+\]/g, '').trim();
    }

    // ─── Handle Return Request ────────────────────────────────────────────────
    const returnMatch = vertusReply.match(/\[REQUEST_RETURN: orderId=([^,\]]+),\s*reason=([^\]]+)\]/);
    if (returnMatch) {
        const orderId = returnMatch[1].trim();
        const reason = returnMatch[2].trim();
        const order = db.prepare('SELECT * FROM orders WHERE order_id = ? AND customer_id = ?').get(orderId, customer.customer_id);
        if (order) {
            const result = db.prepare(`INSERT INTO order_requests (order_id, customer_id, request_type, reason, status) VALUES (?, ?, 'return', ?, 'awaiting_photo')`).run(orderId, customer.customer_id, reason);
            pendingReturns[normalizedPhone] = { requestId: result.lastInsertRowid, orderId };
            console.log(`Return request logged for ${orderId} — awaiting photo`);
        }
        vertusReply = vertusReply.replace(/\[REQUEST_RETURN:[^\]]+\]/g, '').trim();
    }

    // ─── Handle Order Saving ──────────────────────────────────────────────────
    const saveOrderMatches = [...vertusReply.matchAll(/\[SAVE_ORDER: partNumber=([^,]+), quantity=(\d+), partName=([^,]+), price=([^\]]*)\]/g)];
    if (saveOrderMatches.length > 0) {
        const items = saveOrderMatches.map(match => ({
            durauto_part_number: match[1].trim(),
            quantity: parseInt(match[2]),
            part_name: match[3].trim(),
            price: match[4].trim()
        }));
        const allValid = items.every(item => item.durauto_part_number && item.durauto_part_number !== 'undefined' && item.durauto_part_number !== 'X' && item.quantity > 0 && item.part_name && item.part_name !== 'Z');
        if (allValid) {
            const orderId = saveOrder(customer.customer_id, items);
            vertusReply = vertusReply.replace(/\[SAVE_ORDER:[^\]]+\]/g, '').trim();
            console.log(`Order ${orderId} saved for ${customer.store_name}`);
            try {
                const order = db.prepare('SELECT * FROM orders WHERE order_id = ?').get(orderId);
                const orderItems = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(orderId);
                await generateInvoice(order, customer, orderItems);
                const invoiceUrl = `https://truck-parts-agent.onrender.com/invoices/invoice_${orderId}.pdf`;
                saveConversationMessage(normalizedPhone, 'vertus', vertusReply);
                history.push({ role: "assistant", content: vertusReply });
                return { reply: vertusReply, invoiceUrl, photoUrl: null };
            } catch (invoiceError) {
                console.error('Invoice error:', invoiceError.message);
            }
        } else {
            vertusReply = vertusReply.replace(/\[SAVE_ORDER:[^\]]+\]/g, '').trim();
        }
    }

    // ─── Handle Photo Requests ────────────────────────────────────────────────
    const photoMatch = vertusReply.match(/\[SEND_PHOTO: partNumber=([^\]]+)\]/);
    let photoUrl = null;
    if (photoMatch) {
        const productWithPhoto = db.prepare(`SELECT photo_url FROM products WHERE durauto_part_number = ?`).get(photoMatch[1].trim());
        if (productWithPhoto && productWithPhoto.photo_url) photoUrl = productWithPhoto.photo_url;
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
    const numMedia = parseInt(req.body.NumMedia || '0');
    const mediaUrl = numMedia > 0 ? req.body.MediaUrl0 : null;
    const mediaType = numMedia > 0 ? req.body.MediaContentType0 : null;

    if (!fromNumber) return res.sendStatus(200);
    if (messageStatus && !messageSid) return res.sendStatus(200);
    if (fromNumber === process.env.TWILIO_WHATSAPP_NUMBER) return res.sendStatus(200);

    // Allow image-only messages for return photo uploads
    if (!incomingMessage && !mediaUrl) return res.sendStatus(200);

    const messageText = incomingMessage || '[Photo]';
    console.log(`Message from ${fromNumber}: ${messageText}`);

    try {
        const result = await chat(fromNumber, messageText, mediaUrl);
        if (!result) return res.sendStatus(200);

        const { reply, invoiceUrl, photoUrl } = result;
        console.log('--- VERTUS REPLY ---');
        console.log(reply);
        console.log('--------------------');

        await twilioClient.messages.create({ from: process.env.TWILIO_WHATSAPP_NUMBER, to: fromNumber, body: reply });

        if (invoiceUrl) {
            await twilioClient.messages.create({ from: process.env.TWILIO_WHATSAPP_NUMBER, to: fromNumber, body: '📄 Your invoice:', mediaUrl: [invoiceUrl] });
        }
        if (photoUrl) {
            await twilioClient.messages.create({ from: process.env.TWILIO_WHATSAPP_NUMBER, to: fromNumber, body: '📸 Here is the product photo:', mediaUrl: [photoUrl] });
        }

        console.log(`Reply sent to ${fromNumber}`);
    } catch (error) {
        console.error('Error:', error.message);
    }

    res.sendStatus(200);
});

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

app.get('/admin/dashboard', (req, res) => {
    const { secret } = req.query;
    if (secret !== 'durauto2026') return res.status(403).send('Forbidden');
    res.sendFile(path.resolve('dashboard.html'));
});

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

app.get('/admin/api/orders', (req, res) => {
    const { secret } = req.query;
    if (secret !== 'durauto2026') return res.status(403).send('Forbidden');
    try {
        const orders = db.prepare(`
            SELECT o.*, c.store_name, c.phone
            FROM orders o
            LEFT JOIN customers c ON o.customer_id = c.customer_id
            ORDER BY o.created_at DESC LIMIT 100
        `).all();
        for (const order of orders) {
            order.items = db.prepare(`SELECT * FROM order_items WHERE order_id = ?`).all(order.order_id);
        }
        res.json(orders);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/admin/api/requests', (req, res) => {
    const { secret } = req.query;
    if (secret !== 'durauto2026') return res.status(403).send('Forbidden');
    try {
        const requests = db.prepare(`
            SELECT r.*, c.store_name, c.phone
            FROM order_requests r
            LEFT JOIN customers c ON r.customer_id = c.customer_id
            ORDER BY r.created_at DESC
        `).all();
        res.json(requests);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/admin/api/resolve-request', async (req, res) => {
    const { secret, request_id, action, admin_notes } = req.body;
    if (secret !== 'durauto2026') return res.status(403).send('Forbidden');
    try {
        const request = db.prepare('SELECT * FROM order_requests WHERE id = ?').get(request_id);
        if (!request) return res.status(404).json({ error: 'Request not found' });

        const customer = db.prepare('SELECT * FROM customers WHERE customer_id = ?').get(request.customer_id);
        const resolvedAt = new Date().toISOString().split('T')[0];

        db.prepare(`UPDATE order_requests SET status = ?, admin_notes = ?, resolved_at = ? WHERE id = ?`).run(action, admin_notes || '', resolvedAt, request_id);

        let customerMsg = '';

        if (request.request_type === 'cancel') {
            if (action === 'approved') {
                db.prepare(`UPDATE orders SET status = 'cancelled' WHERE order_id = ?`).run(request.order_id);
                customerMsg = `✅ Your cancellation request for order *${request.order_id}* has been approved. The order has been cancelled.${admin_notes ? `\n\nNote: ${admin_notes}` : ''}`;
            } else {
                customerMsg = `❌ Unfortunately we were unable to cancel order *${request.order_id}* as it has already been processed.${admin_notes ? `\n\nNote: ${admin_notes}` : ''}`;
            }
        } else if (request.request_type === 'change') {
            if (action === 'approved') {
                customerMsg = `✅ Your change request for order *${request.order_id}* has been approved.${admin_notes ? `\n\nDetails: ${admin_notes}` : ''}\n\nWe'll send an updated invoice shortly.`;
            } else {
                customerMsg = `❌ Unfortunately we were unable to process your change request for order *${request.order_id}*.${admin_notes ? `\n\nReason: ${admin_notes}` : ''}`;
            }
        } else if (request.request_type === 'return') {
            if (action === 'approved') {
                db.prepare(`UPDATE orders SET status = 'return_approved' WHERE order_id = ?`).run(request.order_id);
                customerMsg = `✅ Your return request for order *${request.order_id}* has been approved!\n\nPlease ship the items back to:\nDurauto Parts LLC\n9100 Galveston Rd\nHouston, TX 77034${admin_notes ? `\n\nNote: ${admin_notes}` : ''}`;
            } else {
                customerMsg = `❌ Your return request for order *${request.order_id}* was not approved.${admin_notes ? `\n\nReason: ${admin_notes}` : ''}\n\nPlease contact us at adhirajchaudhary@gmail.com if you have questions.`;
            }
        }

        if (customerMsg && customer) {
            await sendMessage(customer.phone, customerMsg);
            saveConversationMessage(customer.phone, 'vertus', customerMsg);
        }

        res.json({ success: true });
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
        const welcomeMsg = `🎉 Welcome to Durauto Parts, ${contactName || storeName}!\n\nYour account has been approved. Here's what Vertus can help you with:\n\n🔍 Look up any part by number or category\n💰 Get your custom pricing instantly\n📸 View product photos\n🛒 Place orders and get instant PDF invoices\n📋 Check your order history\n📦 Check stock availability\n🚚 Track your shipments\n\nJust send me a message to get started!`;
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

app.post('/admin/api/ship-order', async (req, res) => {
    const { secret, order_id, carrier, tracking_number, estimated_delivery } = req.body;
    if (secret !== 'durauto2026') return res.status(403).send('Forbidden');
    try {
        const order = db.prepare('SELECT * FROM orders WHERE order_id = ?').get(order_id);
        if (!order) return res.status(404).json({ error: 'Order not found' });
        const customer = db.prepare('SELECT * FROM customers WHERE customer_id = ?').get(order.customer_id);
        if (!customer) return res.status(404).json({ error: 'Customer not found' });
        const shippedAt = new Date().toISOString().split('T')[0];
        db.prepare(`UPDATE orders SET status = 'shipped', carrier = ?, tracking_number = ?, estimated_delivery = ?, shipped_at = ? WHERE order_id = ?`).run(carrier, tracking_number, estimated_delivery || '', shippedAt, order_id);
        const orderItems = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(order_id);
        const itemsList = orderItems.map(item => `• ${item.quantity}x ${item.part_name} (${item.durauto_part_number})`).join('\n');
        const trackingUrl = getTrackingUrl(carrier, tracking_number);
        const shipMsg = `📦 Your order *${order_id}* has shipped!\n\nItems:\n${itemsList}\n\nCarrier: ${carrier}\nTracking #: ${tracking_number}${estimated_delivery ? `\nExpected delivery: ${estimated_delivery}` : ''}${trackingUrl ? `\nTrack here: ${trackingUrl}` : ''}\n\nReply "track ${order_id}" anytime to check your status.`;
        await sendMessage(customer.phone, shipMsg);
        saveConversationMessage(customer.phone, 'vertus', shipMsg);
        res.json({ success: true, message: `Order ${order_id} shipped, customer notified` });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/admin/ship-order', async (req, res) => {
    const { secret, order_id, carrier, tracking, delivery } = req.query;
    if (secret !== 'durauto2026') return res.status(403).send('Forbidden');
    if (!order_id || !carrier || !tracking) return res.send('Missing params. Need: order_id, carrier, tracking, delivery(optional)');
    try {
        const order = db.prepare('SELECT * FROM orders WHERE order_id = ?').get(order_id);
        if (!order) return res.status(404).json({ error: 'Order not found' });
        const customer = db.prepare('SELECT * FROM customers WHERE customer_id = ?').get(order.customer_id);
        if (!customer) return res.status(404).json({ error: 'Customer not found' });
        const shippedAt = new Date().toISOString().split('T')[0];
        db.prepare(`UPDATE orders SET status = 'shipped', carrier = ?, tracking_number = ?, estimated_delivery = ?, shipped_at = ? WHERE order_id = ?`).run(carrier, tracking, delivery || '', shippedAt, order_id);
        const orderItems = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(order_id);
        const itemsList = orderItems.map(item => `• ${item.quantity}x ${item.part_name} (${item.durauto_part_number})`).join('\n');
        const trackingUrl = getTrackingUrl(carrier, tracking);
        const shipMsg = `📦 Your order *${order_id}* has shipped!\n\nItems:\n${itemsList}\n\nCarrier: ${carrier}\nTracking #: ${tracking}${delivery ? `\nExpected delivery: ${delivery}` : ''}${trackingUrl ? `\nTrack here: ${trackingUrl}` : ''}\n\nReply "track ${order_id}" anytime to check your status.`;
        await sendMessage(customer.phone, shipMsg);
        saveConversationMessage(customer.phone, 'vertus', shipMsg);
        res.json({ success: true, message: `Order ${order_id} shipped, customer notified at ${customer.phone}` });
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

app.get('/admin/migrate', (req, res) => {
    const { secret } = req.query;
    if (secret !== 'durauto2026') return res.status(403).send('Forbidden');
    const results = [];
    const migrations = [
        [`ALTER TABLE products ADD COLUMN photo_url TEXT`, 'photo_url column'],
        [`ALTER TABLE customers ADD COLUMN paused INTEGER DEFAULT 0`, 'paused column'],
        [`ALTER TABLE customers ADD COLUMN status TEXT DEFAULT 'pending'`, 'status column'],
        [`ALTER TABLE products ADD COLUMN stock_quantity INTEGER DEFAULT 0`, 'stock_quantity column'],
        [`ALTER TABLE products ADD COLUMN restock_date TEXT`, 'restock_date column'],
        [`ALTER TABLE products ADD COLUMN stock_notes TEXT`, 'stock_notes column'],
        [`ALTER TABLE orders ADD COLUMN carrier TEXT`, 'carrier column'],
        [`ALTER TABLE orders ADD COLUMN tracking_number TEXT`, 'tracking_number column'],
        [`ALTER TABLE orders ADD COLUMN estimated_delivery TEXT`, 'estimated_delivery column'],
        [`ALTER TABLE orders ADD COLUMN shipped_at TEXT`, 'shipped_at column'],
    ];
    for (const [sql, name] of migrations) {
        try { db.exec(sql); results.push(`✅ ${name} added`); }
        catch (err) {
            if (err.message.includes('duplicate column')) results.push(`ℹ️ ${name} already exists`);
            else results.push(`❌ ${name}: ${err.message}`);
        }
    }
    const tables = [
        [`CREATE TABLE IF NOT EXISTS conversations (id INTEGER PRIMARY KEY AUTOINCREMENT, customer_phone TEXT, role TEXT, message TEXT, created_at TEXT DEFAULT (datetime('now')))`, 'conversations table'],
        [`CREATE TABLE IF NOT EXISTS onboarding (id INTEGER PRIMARY KEY AUTOINCREMENT, customer_phone TEXT UNIQUE, store_name TEXT, address TEXT, city_state TEXT, email TEXT, contact_name TEXT, designation TEXT, business_phone TEXT, referral TEXT, step INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')))`, 'onboarding table'],
        [`CREATE TABLE IF NOT EXISTS order_requests (id INTEGER PRIMARY KEY AUTOINCREMENT, order_id TEXT, customer_id TEXT, request_type TEXT, reason TEXT, change_details TEXT, photo_url TEXT, status TEXT DEFAULT 'pending', admin_notes TEXT, created_at TEXT DEFAULT (datetime('now')), resolved_at TEXT)`, 'order_requests table'],
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
        if (!customer) return res.json({ error: 'Not found' });
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

app.get('/admin/update-customer', (req, res) => {
    const { secret, customer_id, store_name, contact_name, email, address } = req.query;
    if (secret !== 'durauto2026') return res.status(403).send('Forbidden');
    if (!customer_id) return res.send('Missing customer_id');
    try {
        const updates = [];
        const values = [];
        if (store_name) { updates.push('store_name = ?'); values.push(store_name); }
        if (contact_name) { updates.push('contact_name = ?'); values.push(contact_name); }
        if (email) { updates.push('email = ?'); values.push(email); }
        if (address) { updates.push('address = ?'); values.push(address); }
        if (updates.length === 0) return res.send('No fields to update');
        values.push(customer_id);
        db.prepare(`UPDATE customers SET ${updates.join(', ')} WHERE customer_id = ?`).run(...values);
        res.json({ success: true, message: `Customer ${customer_id} updated` });
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

app.get('/admin/import-inventory', async (req, res) => {
    const { secret } = req.query;
    if (secret !== 'durauto2026') return res.status(403).send('Forbidden');
    try {
        const axios = require('axios');
        const { parse } = require('csv-parse/sync');
        const response = await axios.get('https://raw.githubusercontent.com/adhirajchaudhary-tech/truck-parts-agent/main/inventory.csv');
        const records = parse(response.data, { columns: true, skip_empty_lines: true, trim: true });
        let successCount = 0, errorCount = 0;
        const results = [];
        for (const record of records) {
            const partNumber = record['durauto_part_number'] || '';
            const stockQty = parseInt(record['stock_quantity'] || '0');
            const restockDate = record['restock_date'] || '';
            const notes = record['notes'] || '';
            if (!partNumber) { errorCount++; continue; }
            try {
                const result = db.prepare(`UPDATE products SET stock_quantity = ?, restock_date = ?, stock_notes = ? WHERE durauto_part_number = ?`).run(stockQty, restockDate, notes, partNumber);
                if (result.changes > 0) { results.push(`✅ ${partNumber} — ${stockQty} units`); successCount++; }
                else { results.push(`⚠️ ${partNumber} not found`); errorCount++; }
            } catch (err) { results.push(`❌ ${partNumber}: ${err.message}`); errorCount++; }
        }
        res.json({ success: true, updated: successCount, errors: errorCount, details: results });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/', (req, res) => { res.send('Vertus is running.'); });

const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Vertus server running on port ${PORT}`);
    console.log(`Waiting for WhatsApp messages...`);
});