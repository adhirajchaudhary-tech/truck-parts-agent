const Database = require('better-sqlite3');
const fs = require('fs');
const { parse } = require('csv-parse/sync');

const db = new Database('durauto.db');

// Add inventory columns if they don't exist
try {
    db.exec(`ALTER TABLE products ADD COLUMN stock_quantity INTEGER DEFAULT 0`);
    console.log('✅ stock_quantity column added');
} catch (err) {
    if (err.message.includes('duplicate column')) {
        console.log('ℹ️ stock_quantity column already exists');
    }
}

try {
    db.exec(`ALTER TABLE products ADD COLUMN restock_date TEXT`);
    console.log('✅ restock_date column added');
} catch (err) {
    if (err.message.includes('duplicate column')) {
        console.log('ℹ️ restock_date column already exists');
    }
}

try {
    db.exec(`ALTER TABLE products ADD COLUMN stock_notes TEXT`);
    console.log('✅ stock_notes column added');
} catch (err) {
    if (err.message.includes('duplicate column')) {
        console.log('ℹ️ stock_notes column already exists');
    }
}

const csvContent = fs.readFileSync('inventory.csv', 'utf8');
const records = parse(csvContent, {
    columns: true,
    skip_empty_lines: true,
    trim: true
});

console.log(`\nFound ${records.length} inventory rows\n`);

let successCount = 0;
let errorCount = 0;

for (const record of records) {
    const partNumber = record['durauto_part_number'] || '';
    const stockQty = parseInt(record['stock_quantity'] || '0');
    const restockDate = record['restock_date'] || '';
    const notes = record['notes'] || '';

    if (!partNumber) continue;

    try {
        const result = db.prepare(`
            UPDATE products SET
                stock_quantity = ?,
                restock_date = ?,
                stock_notes = ?
            WHERE durauto_part_number = ?
        `).run(stockQty, restockDate, notes, partNumber);

        if (result.changes > 0) {
            console.log(`✅ ${partNumber} — ${stockQty} units`);
            successCount++;
        } else {
            console.log(`⚠️ ${partNumber} — not found in catalog`);
            errorCount++;
        }
    } catch (err) {
        console.error(`❌ ${partNumber}: ${err.message}`);
        errorCount++;
    }
}

console.log(`\nDone!`);
console.log(`✅ Updated: ${successCount} products`);
console.log(`❌ Errors: ${errorCount}`);

db.close();