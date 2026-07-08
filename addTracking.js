const Database = require('better-sqlite3');
const db = new Database('durauto.db');

try {
    db.exec(`ALTER TABLE orders ADD COLUMN carrier TEXT`);
    console.log('✅ carrier column added');
} catch (err) {
    if (err.message.includes('duplicate column')) console.log('ℹ️ carrier already exists');
    else console.error('❌', err.message);
}

try {
    db.exec(`ALTER TABLE orders ADD COLUMN tracking_number TEXT`);
    console.log('✅ tracking_number column added');
} catch (err) {
    if (err.message.includes('duplicate column')) console.log('ℹ️ tracking_number already exists');
    else console.error('❌', err.message);
}

try {
    db.exec(`ALTER TABLE orders ADD COLUMN estimated_delivery TEXT`);
    console.log('✅ estimated_delivery column added');
} catch (err) {
    if (err.message.includes('duplicate column')) console.log('ℹ️ estimated_delivery already exists');
    else console.error('❌', err.message);
}

try {
    db.exec(`ALTER TABLE orders ADD COLUMN shipped_at TEXT`);
    console.log('✅ shipped_at column added');
} catch (err) {
    if (err.message.includes('duplicate column')) console.log('ℹ️ shipped_at already exists');
    else console.error('❌', err.message);
}

console.log('Done!');
db.close();