import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { pool } from '../src/db.js';

async function main() {
  const email = process.env.ADMIN_EMAIL ?? 'admin@aljamea.org';
  const password = process.env.ADMIN_PASSWORD ?? 'ChangeMe123!';
  const name = process.env.ADMIN_NAME ?? 'Platform Admin';

  const { rows: branchRows } = await pool.query('SELECT id FROM branches ORDER BY name LIMIT 1');
  if (!branchRows[0]) {
    throw new Error('No branches found — did you run khat-platform-schema.sql against this database yet?');
  }

  const passwordHash = await bcrypt.hash(password, 10);

  await pool.query(
    `INSERT INTO users (role, name, email, password_hash, branch_id, must_change_password)
     VALUES ('admin', $1, $2, $3, $4, true)
     ON CONFLICT (email) DO NOTHING`,
    [name, email, passwordHash, branchRows[0].id]
  );

  console.log(`Admin account ready.`);
  console.log(`  email:    ${email}`);
  console.log(`  password: ${password}`);
  console.log('Log in once, then change this password — must_change_password is set to true.');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
