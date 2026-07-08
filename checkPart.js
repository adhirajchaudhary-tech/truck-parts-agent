const Database = require('better-sqlite3');
const db = new Database('durauto.db');

const parts = db.prepare(`
    SELECT durauto_part_number, part_name, stock_quantity 
    FROM products 
    WHERE durauto_part_number LIKE '%ABH%'
`).all();

console.log('ABH parts in database:');
console.log(parts);

db.close();
