const Database = require('better-sqlite3');
const db = new Database('durauto.db');

try {
    db.exec(`
        CREATE TABLE IF NOT EXISTS order_requests (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            order_id TEXT,
            customer_id TEXT,
            request_type TEXT,
            reason TEXT,
            change_details TEXT,
            photo_url TEXT,
            status TEXT DEFAULT 'pending',
            admin_notes TEXT,
            created_at TEXT DEFAULT (datetime('now')),
            resolved_at TEXT
        )
    `);
    console.log('✅ order_requests table created');
} catch (err) {
    console.error('❌', err.message);
}

db.close();
console.log('Done!');