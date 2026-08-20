const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync("data/misfinanzas.db");
console.log("accounts cols:", db.prepare("PRAGMA table_info(accounts)").all().map(c=>c.name).join(","));
console.log("transactions cols:", db.prepare("PRAGMA table_info(transactions)").all().map(c=>c.name).join(","));
const bal = db.prepare("SELECT * FROM accounts LIMIT 2").all();
console.log("sample accounts:", JSON.stringify(bal));
