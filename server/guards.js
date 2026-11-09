// Access checks shared by route modules.
const { HttpError } = require('./http');

function requireUser(ctx) {
  if (!ctx.user) throw new HttpError(401, 'Please log in.');
  return ctx.user;
}

function requireAdmin(ctx) {
  const u = requireUser(ctx);
  if (u.role !== 'admin') throw new HttpError(403, 'Admins only.');
  return u;
}

// Admins see every senior; family members only the ones they are linked to (others look like 404).
function requireSenior(app, ctx, id) {
  const u = requireUser(ctx);
  const s = app.db.prepare('SELECT * FROM seniors WHERE id = ?').get(Number(id));
  if (!s) throw new HttpError(404, 'Not found.');
  if (u.role !== 'admin' && !app.db.prepare('SELECT 1 FROM family_links WHERE user_id = ? AND senior_id = ?').get(u.id, s.id)) {
    throw new HttpError(404, 'Not found.');
  }
  return s;
}

module.exports = { requireUser, requireAdmin, requireSenior };
