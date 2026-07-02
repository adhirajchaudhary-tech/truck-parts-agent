const Database = require('better-sqlite3');
const fs = require('fs');
const { parse } = require('csv-parse/sync');

const db = new Database('durauto.db');

const csvContent = fs.readFileSync('photos.csv', 'utf8');
const records = parse(csvContent, {
    columns: true,
    skip_empty_lines: true,
    trim: true
});

console.log(`Found ${records.length} photos in CSV\n`);

let successCount = 0;
let errorCount = 0;

for (const record of records) {
    const partNumber = record['durauto_part_number'] || '';
    const photoUrl = record['photo_url'] || '';

    if (!partNumber || !photoUrl) {
        console.log('Skipping empty row');
        continue;
    }

    try {
        const result = db.prepare(`
            UPDATE products SET photo_url = ? 
            WHERE durauto_part_number = ?
        `).run(photoUrl, partNumber);

        if (result.changes > 0) {
            console.log(`✅ ${partNumber} — photo set`);
            successCount++;
        } else {
            console.log(`⚠️  ${partNumber} — part not found in database`);
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