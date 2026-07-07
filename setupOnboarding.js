const Database = require('better-sqlite3');

const db = new Database('durauto.db');

// Add status column to customers
try {
    db.exec(`ALTER TABLE customers ADD COLUMN status TEXT DEFAULT 'pending'`);
    console.log('✅ status column added to customers');
} catch (err) {
    if (err.message.includes('duplicate column')) {
        console.log('ℹ️ status column already exists');
    } else {
        console.error('❌', err.message);
    }
}

// Create onboarding table
try {
    db.exec(`
        CREATE TABLE IF NOT EXISTS onboarding (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            customer_phone TEXT UNIQUE,
            store_name TEXT,
            address TEXT,
            city_state TEXT,
            email TEXT,
            contact_name TEXT,
            designation TEXT,
            business_phone TEXT,
            referral TEXT,
            step INTEGER DEFAULT 0,
            created_at TEXT DEFAULT (datetime('now'))
        )
    `);
    console.log('✅ onboarding table created');
} catch (err) {
    console.error('❌', err.message);
}

db.close();
console.log('Done!');