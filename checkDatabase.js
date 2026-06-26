const Database = require('better-sqlite3');

const db = new Database('durauto.db');

// Show all products
const products = db.prepare('SELECT * FROM products').all();
console.log(`Total products: ${products.length}\n`);

// Print each one
for (const product of products) {
    console.log(`${product.durauto_part_number} — ${product.part_name} — ${product.category}`);
}

// Show cross references
console.log('\n--- Cross References ---');
const refs = db.prepare('SELECT * FROM cross_references').all();
console.log(`Total cross references: ${refs.length}\n`);
for (const ref of refs) {
    console.log(`${ref.durauto_part_number} → ${ref.cross_ref_number}`);
}

db.close();