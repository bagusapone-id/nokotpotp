/**
 * Print the canonical Firebase Realtime Database rules for manual deployment.
 * Run: node set-db-rules.js
 */
const fs = require('fs');
const path = require('path');

const rulesPath = path.join(__dirname, 'firebase-rules.json');
const rules = JSON.parse(fs.readFileSync(rulesPath, 'utf8'));

console.log('='.repeat(60));
console.log('PENTING: Set Firebase Database Rules di Firebase Console!');
console.log('='.repeat(60));
console.log('\nPaste isi firebase-rules.json berikut:\n');
console.log(JSON.stringify(rules, null, 2));
console.log('\nNote: Backend (Admin SDK) melewati rules ini secara otomatis.');
