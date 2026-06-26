const Database = require('better-sqlite3');

const db = new Database('durauto.db');

// Delete any rows where part number is empty, null, or just whitespace
const result = db.prepare(`
    DELETE FROM products 
    WHERE durauto_part_number IS NULL 
    OR TRIM(durauto_part_number) = ''
`).run();

console.log(`Deleted ${result.changes} blank rows`);

// Also clean up any orphaned cross references
db.prepare(`
    DELETE FROM cross_references 
    WHERE durauto_part_number IS NULL 
    OR TRIM(durauto_part_number) = ''
`).run();

console.log('Done');
db.close();