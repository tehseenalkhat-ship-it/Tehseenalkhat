import type { FastifyInstance } from 'fastify';
import bcrypt from 'bcryptjs';
import { randomBytes, createHash } from 'node:crypto';
import { pool } from '../db.js';
import { sendEmail } from '../email.js';
import { config } from '../config.js';
import type { AuthUser } from '../plugins/auth.js';
import { notify } from '../services/notify.js';

type LoginBody = { email: string; password: string };
type SignupBody = { trNumber: string; name: string; email: string; password: string; branchId: string };
type ChangePasswordBody = { currentPassword: string; newPassword: string };
type ForgotPasswordBody = { email: string };
type ResetPasswordBody = { token: string; newPassword: string };

const RESET_TOKEN_EXPIRY_MINUTES = 30;

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export async function authRoutes(app: FastifyInstance) {
  app.post<{ Body: LoginBody }>('/login', async (request, reply) => {
    const { email, password } = request.body;
    if (!email || !password) {
      return reply.code(400).send({ error: 'Email and password are required' });
    }

    const { rows } = await pool.query(
      `SELECT id, name, email, password_hash, role, branch_id, is_coordinator, must_change_password
       FROM users WHERE email = $1 AND deleted_at IS NULL`,
      [email]
    );
    const user = rows[0];

    // Same error for "no such user" and "wrong password" — don't reveal which one it was.
    if (!user) return reply.code(401).send({ error: 'Invalid email or password' });

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return reply.code(401).send({ error: 'Invalid email or password' });

    const token = app.jwt.sign(
      { id: user.id, role: user.role, branchId: user.branch_id, isCoordinator: user.is_coordinator },
      { expiresIn: '7d' }
    );

    // Powers the GitHub-style activity heatmap — one row per user per day.
    await pool.query(
      `INSERT INTO activity_log (user_id, activity_date, login_count)
       VALUES ($1, CURRENT_DATE, 1)
       ON CONFLICT (user_id, activity_date) DO UPDATE SET login_count = activity_log.login_count + 1`,
      [user.id]
    );

    return {
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        branchId: user.branch_id,
        isCoordinator: user.is_coordinator,
        mustChangePassword: user.must_change_password,
      },
    };
  });

  // ---- Student signup — validated against admin-imported TR numbers ----
  app.post<{ Body: SignupBody }>('/signup', async (request, reply) => {
    const { trNumber, name, email, password, branchId } = request.body;
    if (!trNumber || !name || !email || !password || !branchId) {
      return reply.code(400).send({ error: 'trNumber, name, email, password, and branchId are required' });
    }

    const normalizedEmail = email.trim().toLowerCase();
    if (!/^[^\s@]+@jameasaifiyah\.edu$/.test(normalizedEmail)) {
      return reply.code(400).send({ error: 'Use your Jamea Saifiyah email address ending in @jameasaifiyah.edu.' });
    }

    const normalizedTrNumber = trNumber.trim().toUpperCase();
    const { rows: trRows } = await pool.query(`SELECT * FROM approved_tr_numbers WHERE upper(trim(tr_number)) = $1`, [normalizedTrNumber]);
    const trRecord = trRows[0];
    if (!trRecord) return reply.code(400).send({ error: 'This TR number is not recognized' });
    if (trRecord.used) return reply.code(409).send({ error: 'This TR number has already been used to sign up' });
    if (trRecord.branch_id && trRecord.branch_id !== branchId) {
      return reply.code(400).send({ error: 'This TR number is registered to a different branch' });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: userRows } = await client.query(
        `INSERT INTO users (role, name, email, password_hash, branch_id, tr_number, must_change_password)
         VALUES ('student', $1, $2, $3, $4, $5, false) RETURNING id, name, email, role, branch_id, is_coordinator`,
        [name.trim(), normalizedEmail, passwordHash, branchId, normalizedTrNumber]
      );
      const newUser = userRows[0];
      await client.query(`UPDATE approved_tr_numbers SET used = true, student_id = $1 WHERE tr_number = $2`, [
        newUser.id,
        trRecord.tr_number,
      ]);
      await client.query('COMMIT');

      const token = app.jwt.sign(
        { id: newUser.id, role: newUser.role, branchId: newUser.branch_id, isCoordinator: newUser.is_coordinator },
        { expiresIn: '7d' }
      );
      return reply.code(201).send({
        token,
        user: {
          id: newUser.id,
          name: newUser.name,
          email: newUser.email,
          role: newUser.role,
          branchId: newUser.branch_id,
          isCoordinator: newUser.is_coordinator,
        },
      });
    } catch (err) {
      await client.query('ROLLBACK');
      request.log.error(err);
      return reply.code(400).send({ error: 'Signup failed — that email may already be in use' });
    } finally {
      client.release();
    }
  });

  // ---- Change password (any logged-in role) ----
  app.post<{ Body: ChangePasswordBody }>(
    '/change-password',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const userId = (request.user as AuthUser).id;
      const { currentPassword, newPassword } = request.body;
      if (!currentPassword || !newPassword) {
        return reply.code(400).send({ error: 'currentPassword and newPassword are required' });
      }

      const { rows } = await pool.query(`SELECT password_hash FROM users WHERE id = $1`, [userId]);
      const valid = await bcrypt.compare(currentPassword, rows[0].password_hash);
      if (!valid) return reply.code(401).send({ error: 'Current password is incorrect' });

      const newHash = await bcrypt.hash(newPassword, 10);
      await pool.query(`UPDATE users SET password_hash = $1, must_change_password = false WHERE id = $2`, [
        newHash,
        userId,
      ]);
      await notify(userId, 'password_changed', {});
      return { success: true };
    }
  );

  // ---- Forgot password — always returns the same response whether or not
  // the email exists, so this can't be used to check which emails are registered ----
  app.post<{ Body: ForgotPasswordBody }>('/forgot-password', async (request, reply) => {
    const { email } = request.body;
    if (!email) return reply.code(400).send({ error: 'email is required' });

    const { rows } = await pool.query(`SELECT id, name FROM users WHERE email = $1 AND deleted_at IS NULL`, [email]);
    const user = rows[0];

    if (user) {
      const rawToken = randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.now() + RESET_TOKEN_EXPIRY_MINUTES * 60 * 1000);
      await pool.query(`INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)`, [
        user.id,
        hashToken(rawToken),
        expiresAt,
      ]);
      const resetLink = `${config.frontendUrl}/#reset-password?token=${rawToken}`;
      await sendEmail(
        email,
        'Reset your password',
        `Hi ${user.name},\n\nUse this link to reset your password (expires in ${RESET_TOKEN_EXPIRY_MINUTES} minutes):\n${resetLink}\n\nIf you didn't request this, you can ignore this email.`
      );
    }

    return { message: 'If that email is registered, a reset link has been sent.' };
  });

  // ---- Reset password using the emailed token ----
  app.post<{ Body: ResetPasswordBody }>('/reset-password', async (request, reply) => {
    const { token, newPassword } = request.body;
    if (!token || !newPassword) return reply.code(400).send({ error: 'token and newPassword are required' });

    const tokenHash = hashToken(token);
    const { rows } = await pool.query(
      `SELECT * FROM password_reset_tokens WHERE token_hash = $1 AND used = false AND expires_at > now()`,
      [tokenHash]
    );
    const resetRecord = rows[0];
    if (!resetRecord) return reply.code(400).send({ error: 'This reset link is invalid or has expired' });

    const newHash = await bcrypt.hash(newPassword, 10);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`UPDATE users SET password_hash = $1, must_change_password = false WHERE id = $2`, [
        newHash,
        resetRecord.user_id,
      ]);
      await client.query(`UPDATE password_reset_tokens SET used = true WHERE id = $1`, [resetRecord.id]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    await notify(resetRecord.user_id, 'password_reset', {});
    return { success: true };
  });
}
