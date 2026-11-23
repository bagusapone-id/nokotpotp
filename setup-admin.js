/**
 * setup-admin.js
 * Run once to create admin + test user accounts in Firebase Auth.
 * Usage: node setup-admin.js
 */
require('dotenv').config();
const { auth, db } = require('./src/config/firebase');

async function setup() {
  console.log('Setting up Firebase accounts...\n');

  // Create admin user
  try {
    const adminUser = await auth.createUser({
      email: 'admin@nokos.com',
      password: 'admin123456',
      displayName: 'Admin',
    });
    console.log('Admin created:', adminUser.uid);

    // Update .env with admin UID
    const fs = require('fs');
    let envContent = fs.readFileSync('.env', 'utf8');
    envContent = envContent.replace('ADMIN_SECRET_UID=your-admin-uid', `ADMIN_SECRET_UID=${adminUser.uid}`);
    fs.writeFileSync('.env', envContent);
    console.log('Updated .env with ADMIN_SECRET_UID =', adminUser.uid);
  } catch (err) {
    if (err.code === 'auth/email-already-exists') {
      console.log('Admin already exists, skipping...');
      const existing = await auth.getUserByEmail('admin@nokos.com');
      
      const fs = require('fs');
      let envContent = fs.readFileSync('.env', 'utf8');
      if (envContent.includes('your-admin-uid')) {
        envContent = envContent.replace('ADMIN_SECRET_UID=your-admin-uid', `ADMIN_SECRET_UID=${existing.uid}`);
        fs.writeFileSync('.env', envContent);
        console.log('Updated .env with ADMIN_SECRET_UID =', existing.uid);
      } else {
        console.log('ADMIN_SECRET_UID already set in .env');
      }
    } else {
      console.error('Error creating admin:', err.message);
    }
  }

  // Create test user with balance
  try {
    const testUser = await auth.createUser({
      email: 'user@nokos.com',
      password: 'user123456',
      displayName: 'Test User',
    });
    console.log('\nTest user created:', testUser.uid);

    // Set balance in Firebase
    await db.ref(`users/${testUser.uid}`).set({
      username: 'test_user',
      username_lower: 'test_user',
      created_at: Date.now(),
      balance: 100000,
    });
    console.log('Test user balance set: Rp 100.000');
    console.log('\nTest user login: user@nokos.com / user123456');
  } catch (err) {
    if (err.code === 'auth/email-already-exists') {
      console.log('\nTest user already exists, skipping...');
    } else {
      console.error('Error creating test user:', err.message);
    }
  }

  console.log('\nAdmin login: admin@nokos.com / admin123456');
  console.log('\nDone! Restart server after this.');
  process.exit(0);
}

setup().catch(console.error);
