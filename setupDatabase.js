const Database = require('better-sqlite3');
const fs = require('fs');
const { parse } = require('csv-parse/sync');

const db = new Database('durauto.db');

// ─── Products Table ───────────────────────────────────────────────────────────

db.exec(`
    CREATE TABLE IF NOT EXISTS products (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        category TEXT,
        sub_category TEXT,
        part_name TEXT,
        durauto_part_number TEXT UNIQUE,
        brand TEXT,
        description TEXT,
        application TEXT,
        specification TEXT,
        availability TEXT,
        price TEXT,
        weight TEXT
    )
`);

// ─── Cross References Table ───────────────────────────────────────────────────

db.exec(`
    CREATE TABLE IF NOT EXISTS cross_references (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        durauto_part_number TEXT,
        cross_ref_number TEXT
    )
`);

// ─── Customers Table ──────────────────────────────────────────────────────────

db.exec(`
    CREATE TABLE IF NOT EXISTS customers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        customer_id TEXT UNIQUE,
        store_name TEXT,
        contact_name TEXT,
        phone TEXT UNIQUE,
        email TEXT,
        address TEXT,
        created_at TEXT DEFAULT (datetime('now'))
    )
`);

// ─── Orders Table ─────────────────────────────────────────────────────────────

db.exec(`
    CREATE TABLE IF NOT EXISTS orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        order_id TEXT UNIQUE,
        customer_id TEXT,
        status TEXT DEFAULT 'confirmed',
        created_at TEXT DEFAULT (datetime('now'))
    )
`);

// ─── Order Items Table ────────────────────────────────────────────────────────

db.exec(`
    CREATE TABLE IF NOT EXISTS order_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        order_id TEXT,
        durauto_part_number TEXT,
        part_name TEXT,
        quantity INTEGER,
        price_at_order TEXT
    )
`);

console.log("All tables created successfully");

// ─── Load Products from CSV ───────────────────────────────────────────────────

const csvContent = fs.readFileSync('products.csv', 'utf8');
const records = parse(csvContent, {
    columns: true,
    skip_empty_lines: true,
    trim: true
});

console.log(`Found ${records.length} products in CSV`);

const insertProduct = db.prepare(`
    INSERT OR REPLACE INTO products (
        category, sub_category, part_name, durauto_part_number,
        brand, description, application, specification,
        availability, price, weight
    ) VALUES (
        @category, @sub_category, @part_name, @durauto_part_number,
        @brand, @description, @application, @specification,
        @availability, @price, @weight
    )
`);

const insertCrossRef = db.prepare(`
    INSERT INTO cross_references (durauto_part_number, cross_ref_number)
    VALUES (@durauto_part_number, @cross_ref_number)
`);

// Clear existing cross references to avoid duplicates on re-run
db.prepare('DELETE FROM cross_references').run();

let successCount = 0;
let errorCount = 0;

for (const record of records) {
    const partNumber = record['Durauto Part #'] || '';
    if (!partNumber.trim()) continue;

    try {
        insertProduct.run({
            category: record['Category'] || '',
            sub_category: record['Sub Category'] || '',
            part_name: record['Part Name on Website'] || '',
            durauto_part_number: partNumber,
            brand: record['Brand'] || '',
            description: record['Description'] || '',
            application: record['Application'] || '',
            specification: record['Specification'] || '',
            availability: record['Availaibility'] || '',
            price: record['Price'] || '',
            weight: record['Weight'] || ''
        });

        const crossRefs = record['Cross Reference #'] || '';
        if (crossRefs) {
            const refList = crossRefs.split(',').map(r => r.trim()).filter(r => r);
            for (const ref of refList) {
                insertCrossRef.run({
                    durauto_part_number: partNumber,
                    cross_ref_number: ref
                });
            }
        }

        successCount++;
    } catch (err) {
        console.error(`Error inserting ${partNumber}:`, err.message);
        errorCount++;
    }
}

console.log(`\nDone!`);
console.log(`✅ Products loaded: ${successCount}`);
console.log(`❌ Errors: ${errorCount}`);

db.close();