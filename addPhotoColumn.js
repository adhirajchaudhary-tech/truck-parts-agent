const Database = require('better-sqlite3');

const dbPath = process.env.NODE_ENV === 'production' ? '/data/durauto.db' : 'durauto.db';
const db = new Database(dbPath);

try {
    db.exec(`ALTER TABLE products ADD COLUMN photo_url TEXT`);
    console.log('✅ photo_url column added to products table');
} catch (err) {
    if (err.message.includes('duplicate column')) {
        console.log('Column already exists — skipping');
    } else {
        console.error('Error:', err.message);
    }
}

db.close();