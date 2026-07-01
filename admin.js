const Database = require('better-sqlite3');
const readline = require('readline');

const db = new Database('durauto.db');

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

function question(prompt) {
    return new Promise(resolve => rl.question(prompt, resolve));
}

// ─── Display All Customers ────────────────────────────────────────────────────

function listCustomers() {
    const customers = db.prepare(`
        SELECT * FROM customers ORDER BY created_at DESC
    `).all();

    if (customers.length === 0) {
        console.log('\nNo customers yet.\n');
        return;
    }

    console.log(`\n${'─'.repeat(70)}`);
    console.log(`${'ID'.padEnd(12)} ${'Store Name'.padEnd(25)} ${'Contact'.padEnd(20)} ${'Phone'.padEnd(15)}`);
    console.log(`${'─'.repeat(70)}`);

    for (const c of customers) {
        console.log(
            `${(c.customer_id || '').padEnd(12)} ` +
            `${(c.store_name || '').padEnd(25)} ` +
            `${(c.contact_name || '').padEnd(20)} ` +
            `${(c.phone || '').padEnd(15)}`
        );
    }
    console.log(`${'─'.repeat(70)}\n`);
}

// ─── Display All Orders ───────────────────────────────────────────────────────

function listOrders() {
    const orders = db.prepare(`
        SELECT o.*, c.store_name 
        FROM orders o
        LEFT JOIN customers c ON o.customer_id = c.customer_id
        ORDER BY o.created_at DESC
        LIMIT 50
    `).all();

    if (orders.length === 0) {
        console.log('\nNo orders yet.\n');
        return;
    }

    console.log(`\n${'─'.repeat(70)}`);
    console.log(`${'Order ID'.padEnd(12)} ${'Store'.padEnd(25)} ${'Date'.padEnd(22)} ${'Status'.padEnd(12)}`);
    console.log(`${'─'.repeat(70)}`);

    for (const order of orders) {
        console.log(
            `${(order.order_id || '').padEnd(12)} ` +
            `${(order.store_name || 'Unknown').padEnd(25)} ` +
            `${(order.created_at || '').padEnd(22)} ` +
            `${(order.status || '').padEnd(12)}`
        );

        const items = db.prepare(`
            SELECT * FROM order_items WHERE order_id = ?
        `).all(order.order_id);

        for (const item of items) {
            console.log(`             • ${item.durauto_part_number} — ${item.part_name} x${item.quantity}`);
        }
    }
    console.log(`${'─'.repeat(70)}\n`);
}

// ─── Add New Customer ─────────────────────────────────────────────────────────

async function addCustomer() {
    console.log('\n── Add New Customer ──\n');

    const storeName = await question('Store name: ');
    const contactName = await question('Contact person name: ');
    const phone = await question('WhatsApp phone number (with country code, e.g. +12125551234): ');
    const email = await question('Email (press Enter to skip): ');
    const address = await question('Address (press Enter to skip): ');

    const existing = db.prepare('SELECT * FROM customers WHERE phone = ?').get(phone);
    if (existing) {
        console.log(`\n⚠️  A customer with that phone number already exists: ${existing.store_name} (${existing.customer_id})\n`);
        return;
    }

    const count = db.prepare('SELECT COUNT(*) as count FROM customers').get();
    const customerId = `CUST-${(count.count + 1).toString().padStart(3, '0')}`;

    db.prepare(`
        INSERT INTO customers (customer_id, store_name, contact_name, phone, email, address)
        VALUES (?, ?, ?, ?, ?, ?)
    `).run(customerId, storeName, contactName, phone, email || '', address || '');

    console.log(`\n✅ Customer added successfully!`);
    console.log(`   ID: ${customerId}`);
    console.log(`   Store: ${storeName}`);
    console.log(`   Contact: ${contactName}`);
    console.log(`   Phone: ${phone}\n`);
}

// ─── Edit Existing Customer ───────────────────────────────────────────────────

async function editCustomer() {
    console.log('\n── Edit Customer ──\n');
    listCustomers();

    const customerId = await question('Enter Customer ID to edit (e.g. CUST-001): ');
    const customer = db.prepare('SELECT * FROM customers WHERE customer_id = ?').get(customerId);

    if (!customer) {
        console.log('\n⚠️  Customer not found.\n');
        return;
    }

    console.log(`\nEditing: ${customer.store_name}`);
    console.log('Press Enter to keep the current value.\n');

    const storeName = await question(`Store name (${customer.store_name}): `);
    const contactName = await question(`Contact name (${customer.contact_name}): `);
    const phone = await question(`Phone (${customer.phone}): `);
    const email = await question(`Email (${customer.email || 'none'}): `);
    const address = await question(`Address (${customer.address || 'none'}): `);

    db.prepare(`
        UPDATE customers SET
            store_name = ?,
            contact_name = ?,
            phone = ?,
            email = ?,
            address = ?
        WHERE customer_id = ?
    `).run(
        storeName || customer.store_name,
        contactName || customer.contact_name,
        phone || customer.phone,
        email || customer.email,
        address || customer.address,
        customerId
    );

    console.log('\n✅ Customer updated successfully!\n');
}

// ─── Update Order Status ──────────────────────────────────────────────────────

async function updateOrderStatus() {
    console.log('\n── Update Order Status ──\n');
    listOrders();

    const orderId = await question('Enter Order ID to update (e.g. DRA1002): ');
    const order = db.prepare('SELECT * FROM orders WHERE order_id = ?').get(orderId);

    if (!order) {
        console.log('\n⚠️  Order not found.\n');
        return;
    }

    console.log('\nStatus options: confirmed, processing, shipped, delivered, cancelled\n');
    const status = await question(`New status (current: ${order.status}): `);

    const validStatuses = ['confirmed', 'processing', 'shipped', 'delivered', 'cancelled'];
    if (!validStatuses.includes(status)) {
        console.log('\n⚠️  Invalid status. Choose from: confirmed, processing, shipped, delivered, cancelled\n');
        return;
    }

    db.prepare('UPDATE orders SET status = ? WHERE order_id = ?').run(status, orderId);
    console.log(`\n✅ Order ${orderId} updated to: ${status}\n`);
}

// ─── Manage Customer Pricing ──────────────────────────────────────────────────

async function managePricing() {
    console.log('\n── Manage Customer Pricing ──\n');
    console.log('1. View prices for a customer');
    console.log('2. Set a price for a customer');
    console.log('3. Remove a custom price');
    console.log('4. Back to main menu\n');

    const choice = await question('Choose an option (1-4): ');

    switch (choice.trim()) {
        case '1': {
            listCustomers();
            const customerId = await question('Enter Customer ID: ');
            const prices = db.prepare(`
                SELECT cp.*, p.part_name
                FROM customer_pricing cp
                LEFT JOIN products p ON cp.durauto_part_number = p.durauto_part_number
                WHERE cp.customer_id = ?
                ORDER BY cp.durauto_part_number
            `).all(customerId);

            if (prices.length === 0) {
                console.log('\nNo custom prices set for this customer. List prices apply.\n');
            } else {
                console.log(`\n${'─'.repeat(65)}`);
                console.log(`${'Part #'.padEnd(15)} ${'Part Name'.padEnd(35)} ${'Price'.padEnd(10)}`);
                console.log(`${'─'.repeat(65)}`);
                for (const p of prices) {
                    console.log(
                        `${(p.durauto_part_number || '').padEnd(15)} ` +
                        `${(p.part_name || '').padEnd(35)} ` +
                        `$${p.price.toFixed(2)}`
                    );
                }
                console.log(`${'─'.repeat(65)}\n`);
            }
            break;
        }

        case '2': {
            listCustomers();
            const customerId = await question('Enter Customer ID: ');
            const customer = db.prepare('SELECT * FROM customers WHERE customer_id = ?').get(customerId);
            if (!customer) {
                console.log('\n⚠️  Customer not found.\n');
                break;
            }

            const partNumber = await question('Enter Durauto Part # (e.g. DP-SC20): ');
            const product = db.prepare('SELECT * FROM products WHERE durauto_part_number = ?').get(partNumber);
            if (!product) {
                console.log('\n⚠️  Part not found in catalog.\n');
                break;
            }

            console.log(`\nPart: ${product.part_name}`);
            console.log(`Current list price: ${product.price || 'Not set'}\n`);

            const priceInput = await question('Enter custom price (e.g. 45.99): ');
            const price = parseFloat(priceInput);
            if (isNaN(price) || price < 0) {
                console.log('\n⚠️  Invalid price.\n');
                break;
            }

            const notes = await question('Notes (press Enter to skip): ');

            db.prepare(`
                INSERT OR REPLACE INTO customer_pricing 
                (customer_id, durauto_part_number, price, notes)
                VALUES (?, ?, ?, ?)
            `).run(customerId, partNumber, price, notes || '');

            console.log(`\n✅ Price set: ${customer.store_name} — ${partNumber} — $${price.toFixed(2)}\n`);
            break;
        }

        case '3': {
            listCustomers();
            const customerId = await question('Enter Customer ID: ');
            const partNumber = await question('Enter Durauto Part # to remove: ');

            const existing = db.prepare(`
                SELECT * FROM customer_pricing 
                WHERE customer_id = ? AND durauto_part_number = ?
            `).get(customerId, partNumber);

            if (!existing) {
                console.log('\n⚠️  No custom price found for that customer and part.\n');
                break;
            }

            db.prepare(`
                DELETE FROM customer_pricing 
                WHERE customer_id = ? AND durauto_part_number = ?
            `).run(customerId, partNumber);

            console.log('\n✅ Custom price removed. List price will now apply.\n');
            break;
        }

        case '4':
            return;

        default:
            console.log('\n⚠️  Invalid option.\n');
    }
}

// ─── Main Menu ────────────────────────────────────────────────────────────────

async function mainMenu() {
    console.log('\n╔════════════════════════════════════╗');
    console.log('║   Durauto Parts — Admin Panel      ║');
    console.log('╠════════════════════════════════════╣');
    console.log('║  1. View all customers             ║');
    console.log('║  2. View all orders                ║');
    console.log('║  3. Add new customer               ║');
    console.log('║  4. Edit customer                  ║');
    console.log('║  5. Update order status            ║');
    console.log('║  6. Manage customer pricing        ║');
    console.log('║  7. Exit                           ║');
    console.log('╚════════════════════════════════════╝\n');

    const choice = await question('Choose an option (1-7): ');

    switch (choice.trim()) {
        case '1':
            listCustomers();
            await mainMenu();
            break;
        case '2':
            listOrders();
            await mainMenu();
            break;
        case '3':
            await addCustomer();
            await mainMenu();
            break;
        case '4':
            await editCustomer();
            await mainMenu();
            break;
        case '5':
            await updateOrderStatus();
            await mainMenu();
            break;
        case '6':
            await managePricing();
            await mainMenu();
            break;
        case '7':
            console.log('\nGoodbye.\n');
            rl.close();
            db.close();
            break;
        default:
            console.log('\n⚠️  Invalid option. Please choose 1-7.\n');
            await mainMenu();
    }
}

mainMenu();