import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { pool } from '../src/db.js';

// Creates one teacher per branch per khat type (15 total — 5 branches × 3
// scripts), with the Naskh teacher in each branch also flagged as that
// branch's coordinator. Also imports 3 pre-approved TR numbers per branch so
// you can test the real signup FORM in the frontend rather than pre-seeding
// student accounts directly — that's the one flow worth testing end-to-end
// rather than shortcutting.
//
// Safe to re-run: existing emails/TR numbers are skipped, not duplicated.

const BRANCH_CODES: Record<string, string> = {
  Nairobi: 'NBI',
  Karachi: 'KHI',
  Surat: 'SUR',
  Sidhpur: 'SDH',
  'Marol / Mumbai': 'MAR',
};

async function main() {
  const { rows: branches } = await pool.query(`SELECT id, name FROM branches`);
  const { rows: khatTypes } = await pool.query(`SELECT id, code, display_name FROM khat_types`);
  if (branches.length === 0 || khatTypes.length === 0) {
    throw new Error('No branches or khat_types found — did you run the main schema.sql seed yet?');
  }

  const tempPassword = 'Teacher123!'; // same for every seeded account — change on first login, same as the admin bootstrap
  const passwordHash = await bcrypt.hash(tempPassword, 10);

  const createdTeachers: { email: string; branch: string; khatType: string; isCoordinator: boolean }[] = [];

  for (const branch of branches) {
    let isFirstInBranch = true;
    for (const khatType of khatTypes) {
      const email = `teacher.${khatType.code}.${branch.name.toLowerCase().replace(/[^a-z]/g, '')}@aljamea.org`;
      const name = `${khatType.display_name} Teacher — ${branch.name}`;
      const isCoordinator = isFirstInBranch; // one coordinator per branch, arbitrary pick

      const { rows: userRows } = await pool.query(
        `INSERT INTO users (role, name, email, password_hash, branch_id, is_coordinator, must_change_password)
         VALUES ('teacher', $1, $2, $3, $4, $5, true)
         ON CONFLICT (email) DO NOTHING
         RETURNING id`,
        [name, email, passwordHash, branch.id, isCoordinator]
      );

      if (userRows[0]) {
        await pool.query(
          `INSERT INTO teacher_khat_assignments (teacher_id, khat_type_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [userRows[0].id, khatType.id]
        );
        createdTeachers.push({ email, branch: branch.name, khatType: khatType.display_name, isCoordinator });
      }
      isFirstInBranch = false;
    }
  }

  const createdTrNumbers: string[] = [];
  for (const branch of branches) {
    const code = BRANCH_CODES[branch.name] ?? branch.name.slice(0, 3).toUpperCase();
    for (let i = 1; i <= 3; i++) {
      const trNumber = `TR-${code}-${String(i).padStart(3, '0')}`;
      const { rowCount } = await pool.query(
        `INSERT INTO approved_tr_numbers (tr_number, branch_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [trNumber, branch.id]
      );
      if (rowCount) createdTrNumbers.push(`${trNumber} (${branch.name})`);
    }
  }

  console.log('\n=== Seeded teacher accounts ===');
  console.log(`Shared temp password for all: ${tempPassword}\n`);
  for (const t of createdTeachers) {
    console.log(`  ${t.email}${t.isCoordinator ? '  [COORDINATOR]' : ''}  —  ${t.branch} / ${t.khatType}`);
  }
  if (createdTeachers.length === 0) console.log('  (none new — all emails already existed)');

  console.log('\n=== Pre-approved TR numbers (use these to test real student signup) ===');
  for (const tr of createdTrNumbers) console.log(`  ${tr}`);
  if (createdTrNumbers.length === 0) console.log('  (none new — all TR numbers already existed)');

  console.log('\nDone. Every teacher must change their password on first login (must_change_password = true).');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
