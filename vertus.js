require('dotenv').config();
const Anthropic = require('@anthropic-ai/sdk');
const Database = require('better-sqlite3');
const readline = require('readline');

const client = new Anthropic();
const db = new Database('durauto.db');

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
    const count = db.prepare('SELECT COUNT(*) as count FROM orders').get();
    const next = (count.count + 1).toString().padStart(4, '0');
    return `ORD-${next}`;
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
- Keep responses short and clear
- Always confirm orders before finalizing
- Never make up product details

How you handle orders:
- Extract part number and quantity from the customer's message
- Confirm the order back clearly before finalizing
- When the customer confirms with yes, include this exact tag in your response:
  [SAVE_ORDER: partNumber=X, quantity=Y, partName=Z, price=P]
- For multiple items use one tag per item on separate lines
- Only include the SAVE_ORDER tag after the customer has confirmed with yes

How you handle product lookups:
- Use ONLY the product data provided to you
- Never invent specifications or prices

What you don't do:
- Never guess product details
- Never finalize without confirmation
- Never discuss topics unrelated to Durauto Parts LLC
`;

// ─── Chat Logic ───────────────────────────────────────────────────────────────

const conversationHistory = [];
let currentCustomer = null;
let pendingOrder = null;

async function chat(userMessage) {
    // Find products mentioned in the message
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
            }
        }
    }

    // Add order history context if customer asks
    const messageLower = userMessage.toLowerCase();
    let orderContext = '';
    if (messageLower.includes('order') && 
        (messageLower.includes('history') || 
         messageLower.includes('last') || 
         messageLower.includes('previous') || 
         messageLower.includes('before'))) {
        const history = getOrderHistory(currentCustomer.customer_id);
        if (history.length > 0) {
            orderContext = '\nORDER HISTORY:\n';
            for (const order of history) {
                orderContext += `\nOrder ${order.order_id} — ${order.created_at} — ${order.status}\n`;
                for (const item of order.items) {
                    orderContext += `  • ${item.durauto_part_number} — ${item.part_name} x${item.quantity}\n`;
                }
            }
        } else {
            orderContext = '\nORDER HISTORY: No previous orders found for this customer.\n';
        }
    }

    const systemData = productContext || orderContext
        ? `\n\n[SYSTEM DATA — DO NOT SHOW RAW]:\n${productContext}${orderContext}\nCustomer: ${currentCustomer.store_name} (${currentCustomer.customer_id})`
        : `\n\n[Customer: ${currentCustomer.store_name} (${currentCustomer.customer_id})]`;

    conversationHistory.push({
        role: "user",
        content: userMessage + systemData
    });

    const response = await client.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 1024,
        system: systemPrompt,
        messages: conversationHistory
    });

    let vertusReply = response.content[0].text;

    // Check if Vertus wants to save an order
    const saveOrderMatches = [...vertusReply.matchAll(/\[SAVE_ORDER: partNumber=([^,]+), quantity=(\d+), partName=([^,]+), price=([^\]]+)\]/g)];

    if (saveOrderMatches.length > 0) {
        const items = saveOrderMatches.map(match => ({
            durauto_part_number: match[1].trim(),
            quantity: parseInt(match[2]),
            part_name: match[3].trim(),
            price: match[4].trim()
        }));

        const orderId = saveOrder(currentCustomer.customer_id, items);

        // Remove the tags from the reply shown to customer
        vertusReply = vertusReply.replace(/\[SAVE_ORDER:[^\]]+\]/g, '').trim();

        console.log(`\n[System: Order ${orderId} saved to database]`);
    }

    conversationHistory.push({
        role: "assistant",
        content: vertusReply
    });

    console.log("\nVertus:", vertusReply, "\n");
}

// ─── Terminal Interface ───────────────────────────────────────────────────────

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

async function start() {
    // For testing, use a test customer phone number
    currentCustomer = findOrCreateCustomer('+1234567890');
    console.log(`Customer identified: ${currentCustomer.store_name} (${currentCustomer.customer_id})\n`);
    console.log("Vertus is ready. Type your message below. Type 'exit' to quit.\n");
    askQuestion();
}

function askQuestion() {
    rl.question("You: ", async (input) => {
        const userInput = input.trim();

        if (userInput.toLowerCase() === 'exit') {
            console.log("Ending conversation.");
            rl.close();
            db.close();
            return;
        }

        await chat(userInput);
        askQuestion();
    });
}

start();