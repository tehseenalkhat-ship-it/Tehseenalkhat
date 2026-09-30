import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { pool } from '../src/db.js';

async function main() {
  console.log('Seeding demo data...\n');

  const { rows: branches } = await pool.query(`SELECT id, name FROM branches ORDER BY name`);
  const nairobi = branches.find((b) => b.name === 'Nairobi');
  const karachi = branches.find((b) => b.name === 'Karachi');
  const { rows: khatTypes } = await pool.query(`SELECT id, code FROM khat_types`);
  const naskh = khatTypes.find((k) => k.code === 'naskh');
  const sulus = khatTypes.find((k) => k.code === 'sulus');
  const nastaaleeq = khatTypes.find((k) => k.code === 'nastaaleeq');

  if (!nairobi || !karachi || !naskh || !sulus || !nastaaleeq) {
    throw new Error('Branches/khat types not found — did you run the main schema + seed first?');
  }

  const credentials: { role: string; email: string; password: string }[] = [];

  async function createStaff(opts: {
    role: 'teacher' | 'admin';
    name: string;
    email: string;
    branchId: string;
    isCoordinator?: boolean;
    khatTypeIds?: string[];
  }) {
    const password = 'DemoPass123!';
    const passwordHash = await bcrypt.hash(password, 10);
    const { rows } = await pool.query(
      `INSERT INTO users (role, name, email, password_hash, branch_id, is_coordinator, must_change_password)
       VALUES ($1, $2, $3, $4, $5, $6, true)
       ON CONFLICT (email) DO NOTHING RETURNING id`,
      [opts.role, opts.name, opts.email, passwordHash, opts.branchId, Boolean(opts.isCoordinator)]
    );
    const id = rows[0]?.id;
    if (id && opts.khatTypeIds) {
      for (const khatTypeId of opts.khatTypeIds) {
        await pool.query(`INSERT INTO teacher_khat_assignments (teacher_id, khat_type_id) VALUES ($1, $2)`, [
          id,
          khatTypeId,
        ]);
      }
    }
    credentials.push({ role: opts.role + (opts.isCoordinator ? ' (coordinator)' : ''), email: opts.email, password });
    return id;
  }

  // Two Nairobi teachers, different script assignments — enough to test
  // same-branch routing and the load threshold.
  await createStaff({
    role: 'teacher',
    name: 'Ustadh Ismail Khatri',
    email: 'ismail@demo.org',
    branchId: nairobi.id,
    khatTypeIds: [naskh.id, sulus.id],
  });
  await createStaff({
    role: 'teacher',
    name: 'Ustadha Amina Noor',
    email: 'amina@demo.org',
    branchId: nairobi.id,
    khatTypeIds: [nastaaleeq.id],
  });
  // A Karachi branch coordinator, for testing the coordinator-only endpoints.
  await createStaff({
    role: 'teacher',
    name: 'Ustadha Zahra Abbas',
    email: 'zahra@demo.org',
    branchId: karachi.id,
    isCoordinator: true,
    khatTypeIds: [naskh.id],
  });

  // A batch of TR numbers for testing student signup — half tagged to
  // Nairobi, half unrestricted.
  const trNumbers = Array.from({ length: 10 }, (_, i) => `TR-DEMO-${1000 + i}`);
  for (let i = 0; i < trNumbers.length; i++) {
    await pool.query(`INSERT INTO approved_tr_numbers (tr_number, branch_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [
      trNumbers[i],
      i < 5 ? nairobi.id : null,
    ]);
  }

  // A starter Naskh certification course: 5 practice levels + 1 checkpoint —
  // media/sheet files are left empty; upload real files via the Course
  // Builder once the frontend is wired, this just gives you structure to
  // click through immediately.
  const { rows: courseRows } = await pool.query(
    `INSERT INTO courses (khat_type_id, category, title, description, is_deletable)
     VALUES ($1, 'certification', 'Naskh — The Complete Hand', 'Seeded starter course', false)
     ON CONFLICT DO NOTHING RETURNING id`,
    [naskh.id]
  );
  const courseId = courseRows[0]?.id;
  if (courseId) {
    const levelDefs: { title: string; levelType: 'mufradat' | 'writing' | 'test'; badgeTier?: string }[] = [
      { title: 'The round letters', levelType: 'mufradat' },
      { title: 'Tall and angular letters', levelType: 'mufradat' },
      { title: 'Mufradāt set one', levelType: 'mufradat' },
      { title: 'Mufradāt set two', levelType: 'mufradat' },
      { title: 'Checkpoint · Foundation', levelType: 'test', badgeTier: 'foundation' },
      { title: 'Joining at the baseline', levelType: 'writing' },
    ];
    for (let i = 0; i < levelDefs.length; i++) {
      const def = levelDefs[i];
      await pool.query(
        `INSERT INTO levels (course_id, order_index, level_type, title, media, sheet_files, badge_tier)
         VALUES ($1, $2, $3, $4, '[]', '{}', $5)`,
        [courseId, i, def.levelType, def.title, def.badgeTier ?? null]
      );
    }
  }

  console.log('Seed complete. Demo accounts (all use the same password for convenience):\n');
  for (const c of credentials) {
    console.log(`  ${c.role.padEnd(22)} ${c.email.padEnd(20)} ${c.password}`);
  }
  console.log(`\nTR numbers for signup testing: ${trNumbers.join(', ')}`);
  console.log('(TR-DEMO-1000 through 1004 are Nairobi-only; 1005-1009 work with any branch)');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
