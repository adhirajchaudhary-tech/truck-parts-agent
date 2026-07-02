const Database = require('better-sqlite3');
const fs = require('fs');
const { parse } = require('csv-parse/sync');

const db = new Database('durauto.db');

const csvContent = fs.readFileSync('pricing.csv', 'utf8');
const records = parse(csvContent, {
    columns: true,
    skip_empty_lines: true,
    trim: true
});

console.log(`Found ${records.length} pricing rows in CSV\n`);

const insertPrice = db.prepare(`
    INSERT OR REPLACE INTO customer_pricing 
    (customer_id, durauto_part_number, price, notes)
    VALUES (?, ?, ?, ?)
`);

let successCount = 0;
let errorCount = 0;

for (const record of records) {
    const customerId = record['customer_id'] || record['Customer ID'] || '';
    const partNumber = record['durauto_part_number'] || record['Durauto Part #'] || '';
    const price = parseFloat(record['price'] || record['Price'] || '0');
    const notes = record['notes'] || record['Notes'] || '';

    if (!customerId || !partNumber) {
        console.log(`Skipping empty row`);
        continue;
    }

    if (isNaN(price)) {
        console.log(`⚠️  Invalid price for ${partNumber}: ${record['price']}`);
        errorCount++;
        continue;
    }

    try {
        insertPrice.run(customerId, partNumber, price, notes);
        console.log(`✅ ${customerId} — ${partNumber} — $${price.toFixed(2)}`);
        successCount++;
    } catch (err) {
        console.error(`❌ Error for ${partNumber}: ${err.message}`);
        errorCount++;
    }
}

console.log(`\nDone!`);
console.log(`✅ Imported: ${successCount} prices`);
console.log(`❌ Errors: ${errorCount}`);

db.close();