const Database = require('better-sqlite3');

const dbPath = process.env.NODE_ENV === 'production' ? '/data/durauto.db' : 'durauto.db';
const db = new Database(dbPath);

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

db.exec(`
    CREATE TABLE IF NOT EXISTS cross_references (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        durauto_part_number TEXT,
        cross_ref_number TEXT
    )
`);

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

db.exec(`
    CREATE TABLE IF NOT EXISTS orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        order_id TEXT UNIQUE,
        customer_id TEXT,
        status TEXT DEFAULT 'confirmed',
        created_at TEXT DEFAULT (datetime('now'))
    )
`);

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

db.exec(`
    CREATE TABLE IF NOT EXISTS customer_pricing (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        customer_id TEXT,
        durauto_part_number TEXT,
        price REAL,
        notes TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        UNIQUE(customer_id, durauto_part_number)
    )
`);

console.log('Customer pricing table ready');

db.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        customer_phone TEXT,
        role TEXT,
        message TEXT,
        created_at TEXT DEFAULT (datetime('now'))
    )
`);

console.log('Conversations table ready');

db.close();