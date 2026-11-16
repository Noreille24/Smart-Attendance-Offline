'use strict';
// Smart Attendance Interface - backend (zero dependencies: Node 22+ built-ins only)
process.env.TZ = process.env.TZ || 'Asia/Manila';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const { DatabaseSync } = require('node:sqlite');

const PORT = Number(process.env.PORT) || 3000;
const DB_FILE = process.env.DB_PATH || path.join(__dirname, 'data', 'attendance.db');
if (DB_FILE !== ':memory:') fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });

const db = new DatabaseSync(DB_FILE);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  role TEXT NOT NULL CHECK (role IN ('student','teacher')),
  school_id TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  salt TEXT NOT NULL,
  pass_hash TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS classes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  teacher_id INTEGER NOT NULL REFERENCES users(id),
  subject TEXT NOT NULL,
  code TEXT NOT NULL UNIQUE,
  days TEXT NOT NULL,
  start TEXT NOT NULL,
  end TEXT NOT NULL,
  grace INTEGER NOT NULL DEFAULT 15,
  created_date TEXT NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0,
  archived_date TEXT
);
CREATE TABLE IF NOT EXISTS class_schedules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  effective_date TEXT NOT NULL,
  days TEXT NOT NULL,
  start TEXT NOT NULL,
  end TEXT NOT NULL,
  grace INTEGER NOT NULL,
  UNIQUE (class_id, effective_date)
);
CREATE TABLE IF NOT EXISTS class_pauses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  start_date TEXT NOT NULL,
  end_date TEXT
);
CREATE TABLE IF NOT EXISTS enrollments (
  class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  student_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  section TEXT NOT NULL,
  enrolled_date TEXT NOT NULL,
  PRIMARY KEY (class_id, student_id)
);
CREATE TABLE IF NOT EXISTS attendance (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  student_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('present','late','absent')),
  checked_at TEXT,
  method TEXT NOT NULL,
  UNIQUE (class_id, student_id, date)
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  user_id INTEGER,
  class_id INTEGER,
  type TEXT NOT NULL,
  code TEXT,
  duration_ms INTEGER
);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  teacher_id INTEGER NOT NULL REFERENCES users(id),
  class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  details TEXT NOT NULL
);
`);
const classColumns = db.prepare('PRAGMA table_info(classes)').all().map((column) => column.name);
if (!classColumns.includes('archived')) db.exec('ALTER TABLE classes ADD COLUMN archived INTEGER NOT NULL DEFAULT 0');
if (!classColumns.includes('archived_date')) db.exec('ALTER TABLE classes ADD COLUMN archived_date TEXT');
const scheduleCount = db.prepare('SELECT COUNT(*) n FROM class_schedules').get().n;
if (!scheduleCount) {
  const classesToMigrate = db.prepare('SELECT * FROM classes').all();
  const insertSchedule = db.prepare('INSERT OR IGNORE INTO class_schedules (class_id, effective_date, days, start, end, grace) VALUES (?,?,?,?,?,?)');
  for (const c of classesToMigrate) insertSchedule.run(c.id, c.created_date, c.days, c.start, c.end, c.grace);
}

/* ---------- time helpers (with a demo clock so the 15-minute rule can be tested any time) ---------- */
const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const hm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const toMin = (s) => { const [h, m] = s.split(':').map(Number); return h * 60 + m; };
const minOf = (d) => d.getHours() * 60 + d.getMinutes();
const parseYmd = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const clock = { offset: 0, label: null };
const now = () => new Date(Date.now() + clock.offset);
const scheduleForDate = (c, date) => db.prepare(`SELECT days, start, end, grace FROM class_schedules
  WHERE class_id=? AND effective_date<=? ORDER BY effective_date DESC LIMIT 1`).get(c.id, date) || c;
const nextDate = (date) => { const d = parseYmd(date); d.setDate(d.getDate() + 1); return ymd(d); };
const previousDate = (date) => { const d = parseYmd(date); d.setDate(d.getDate() - 1); return ymd(d); };
const fmt12 = (s) => { const [h, m] = s.split(':').map(Number); return `${((h + 11) % 12) + 1}:${pad(m)} ${h >= 12 ? 'PM' : 'AM'}`; };
const DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const classDays = (c) => c.days.split(',').filter(Boolean).map(Number);
function dayLabel(c) {
  const d = classDays(c).slice().sort();
  if (d.join() === '1,2,3,4,5') return 'Mon–Fri';
  return d.map((x) => DAY[x]).join(', ');
}
function clockInfo() {
  const d = now();
  return { iso: `${ymd(d)}T${hm(d)}:${pad(d.getSeconds())}`, date: ymd(d), time: hm(d), demo: clock.label !== null, label: clock.label };
}

/* ---------- the attendance rule from the design notes ----------
   start .. start+grace  -> present      (e.g. 2:00-2:15 PM)
   after grace .. end    -> late         (e.g. 2:16-4:00 PM)
   otherwise             -> cannot check in (recorded as absent)            */
function windowState(c, d) {
  const m = minOf(d), s = toMin(c.start), e = toMin(c.end);
  if (m < s) return 'early';
  if (m <= s + c.grace) return 'present';
  if (m <= e) return 'late';
  return 'closed';
}
function meetingDates(c, fromDate, d) {
  const out = [];
  const today = ymd(d);
  const start = fromDate > c.created_date ? fromDate : c.created_date;
  const pauses = db.prepare('SELECT start_date, end_date FROM class_pauses WHERE class_id=?').all(c.id);
  for (let cur = parseYmd(start), i = 0; i < 500; i++, cur.setDate(cur.getDate() + 1)) {
    const s = ymd(cur);
    if (s > today) break;
    if (c.archived_date && s > c.archived_date) break;
    if (pauses.some((p) => p.start_date <= s && (!p.end_date || p.end_date >= s))) continue;
    const schedule = scheduleForDate(c, s);
    if (!classDays(schedule).includes(cur.getDay())) continue;
    if (s === today && minOf(d) < toMin(schedule.start)) continue;
    out.push(s);
  }
  return out;
}
function statusFor(c, rec, dateStr, d) {
  if (rec) return { status: rec.status, checked_at: rec.checked_at, method: rec.method, implicit: false };
  const today = ymd(d);
  if (dateStr < today || (dateStr === today && minOf(d) > toMin(scheduleForDate(c, dateStr).end))) return { status: 'absent', implicit: true };
  return { status: 'pending', implicit: true };
}

/* ---------- errors, validation, passwords ---------- */
class HttpError extends Error {
  constructor(status, code, message, hint) { super(message); this.status = status; this.code = code; this.hint = hint; }
}
const E = (s, c, m, h) => new HttpError(s, c, m, h);
const text = (v, min, max, label) => {
  const s = typeof v === 'string' ? v.trim().replace(/\s+/g, ' ') : '';
  if (s.length < min || s.length > max) throw E(400, 'invalid', `${label} must be ${min}–${max} characters.`);
  return s;
};
function hashPw(password, salt) { return crypto.scryptSync(password, salt, 32).toString('hex'); }
function makeUser(role, schoolId, name, password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const r = db.prepare('INSERT INTO users (role, school_id, name, salt, pass_hash) VALUES (?,?,?,?,?)')
    .run(role, schoolId, name, salt, hashPw(password, salt));
  return Number(r.lastInsertRowid);
}
function checkPw(user, password) {
  const a = Buffer.from(hashPw(String(password), user.salt), 'hex');
  const b = Buffer.from(user.pass_hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CHECKIN_SECRET = crypto.randomBytes(32);
function checkinCode(c, d) {
  const slot = Math.floor(d.getTime() / 30000);
  const bytes = crypto.createHmac('sha256', CHECKIN_SECRET).update(`${c.id}:${slot}`).digest();
  return Array.from(bytes.subarray(0, 8), (byte) => CODE_CHARS[byte % CODE_CHARS.length]).join('');
}
function checkinOpen(c, d) {
  const date = ymd(d), schedule = scheduleForDate(c, date);
  return !c.archived && date >= c.created_date && classDays(schedule).includes(d.getDay())
    && ['present', 'late'].includes(windowState(schedule, d));
}
function audit(user, classId, action, details) {
  db.prepare('INSERT INTO audit_log (ts, teacher_id, class_id, action, details) VALUES (?,?,?,?,?)')
    .run(new Date().toISOString(), user.id, classId, action, JSON.stringify(details));
}
function newCode() {
  for (;;) {
    let c = '';
    for (let i = 0; i < 6; i++) c += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)];
    if (!db.prepare('SELECT 1 FROM classes WHERE code=?').get(c)) return c;
  }
}
const normCode = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const logEvent = (user, classId, type, code, ms) => {
  try {
    db.prepare('INSERT INTO events (ts, user_id, class_id, type, code, duration_ms) VALUES (?,?,?,?,?,?)')
      .run(new Date().toISOString(), user ? user.id : null, classId || null, type, code || null, ms == null ? null : ms);
  } catch { /* metrics are best-effort */ }
};

/* ---------- seed demo data ---------- */
function seed() {
  if (db.prepare('SELECT COUNT(*) n FROM users').get().n) return;
  const t1 = makeUser('teacher', 'teacher1', 'Prof. Maria Santos', 'teacher123');
  const t2 = makeUser('teacher', 'teacher2', 'Prof. Jose Reyes', 'teacher123');
  const names = ['Juan Dela Cruz', 'Ana Reyes', 'Mark Villanueva', 'Bea Navarro', 'Carlo Mendoza',
    'Liza Ramos', 'Paolo Garcia', 'Kyla Bautista', 'Miguel Torres', 'Sofia Aquino'];
  const students = names.map((n, i) => {
    const sid = `2024-${String(i + 1).padStart(3, '0')}`;
    return { id: makeUser('student', sid, n, sid), sid, section: i < 5 ? 'A' : 'B' };
  });
  const today = new Date(); const created = new Date(today); created.setDate(created.getDate() - 21);
  const createdStr = ymd(created);
  const mk = (teacher, subject, start, end, code) => {
    const r = db.prepare('INSERT INTO classes (teacher_id, subject, code, days, start, end, grace, created_date) VALUES (?,?,?,?,?,?,?,?)')
      .run(teacher, subject, code, '1,2,3,4,5', start, end, 15, createdStr);
    const id = Number(r.lastInsertRowid);
    for (const s of students) db.prepare('INSERT INTO enrollments VALUES (?,?,?,?)').run(id, s.id, s.section, createdStr);
    return db.prepare('SELECT * FROM classes WHERE id=?').get(id);
  };
  const classes = [mk(t1, 'HCI', '15:00', '16:00', 'K7M4PX'), mk(t2, 'Rizal', '13:00', '14:00', 'R2Z9WD')];
  let seedN = 12345;
  const rnd = () => { seedN = (seedN * 1664525 + 1013904223) % 4294967296; return seedN / 4294967296; };
  const real = new Date();
  for (const c of classes) {
    for (const date of meetingDates(c, createdStr, real)) {
      if (date === ymd(real)) continue; // today stays open for the live demo
      for (const s of students) {
        const r = rnd();
        if (r > 0.9) continue; // absent (no record)
        const late = r > 0.78;
        const mins = toMin(c.start) + (late ? 16 + Math.floor(rnd() * 20) : Math.floor(rnd() * 12));
        db.prepare('INSERT INTO attendance (class_id, student_id, date, status, checked_at, method) VALUES (?,?,?,?,?,?)')
          .run(c.id, s.id, date, late ? 'late' : 'present', `${date}T${pad(Math.floor(mins / 60))}:${pad(mins % 60)}:00`, rnd() > 0.3 ? 'qr' : 'code');
      }
    }
  }
}
seed();
db.exec(`INSERT OR IGNORE INTO class_schedules (class_id, effective_date, days, start, end, grace)
  SELECT c.id, c.created_date, c.days, c.start, c.end, c.grace FROM classes c
  WHERE NOT EXISTS (SELECT 1 FROM class_schedules s WHERE s.class_id=c.id)`);

/* ---------- roster / report helpers ---------- */
function rosterFor(c, dateStr, d) {
  const rows = db.prepare(`SELECT u.id, u.school_id, u.name, e.section FROM enrollments e JOIN users u ON u.id=e.student_id
    WHERE e.class_id=? ORDER BY e.section, u.name`).all(c.id);
  const recs = new Map(db.prepare('SELECT * FROM attendance WHERE class_id=? AND date=?').all(c.id, dateStr).map((r) => [r.student_id, r]));
  const counts = { present: 0, late: 0, absent: 0, pending: 0, total: rows.length };
  const sections = new Map();
  for (const r of rows) {
    const st = statusFor(c, recs.get(r.id), dateStr, d);
    counts[st.status]++;
    if (!sections.has(r.section)) sections.set(r.section, []);
    sections.get(r.section).push({ student_id: r.id, school_id: r.school_id, name: r.name, ...st });
  }
  return { counts, sections: [...sections].map(([section, students]) => ({ section, students })) };
}
function classInfo(c, d) {
  const date = ymd(d), schedule = scheduleForDate(c, date);
  const meets = classDays(schedule).includes(d.getDay());
  return {
    id: c.id, subject: c.subject, archived: Boolean(c.archived), days: classDays(schedule), days_label: dayLabel(schedule),
    start: schedule.start, end: schedule.end, grace: schedule.grace, meets_today: meets,
    window: meets ? windowState(schedule, d) : null,
  };
}
function computeReport(c, d) {
  const students = db.prepare(`SELECT u.id, u.school_id, u.name, e.section, e.enrolled_date FROM enrollments e
    JOIN users u ON u.id=e.student_id WHERE e.class_id=? ORDER BY e.section, u.name`).all(c.id);
  const recs = new Map(db.prepare('SELECT * FROM attendance WHERE class_id=?').all(c.id).map((r) => [`${r.student_id}|${r.date}`, r]));
  const dateMap = new Map();
  const out = students.map((s) => {
    const row = { student_id: s.id, school_id: s.school_id, name: s.name, section: s.section, present: 0, late: 0, absent: 0, total: 0 };
    for (const date of meetingDates(c, s.enrolled_date, d)) {
      const st = statusFor(c, recs.get(`${s.id}|${date}`), date, d).status;
      if (st === 'pending') continue;
      row[st]++; row.total++;
      if (!dateMap.has(date)) dateMap.set(date, { date, present: 0, late: 0, absent: 0 });
      dateMap.get(date)[st]++;
    }
    row.rate = row.total ? Math.round(((row.present + row.late) / row.total) * 100) : null;
    return row;
  });
  const byDate = [...dateMap.values()].sort((a, b) => (a.date < b.date ? 1 : -1));
  const tot = out.reduce((a, r) => ({ present: a.present + r.present, late: a.late + r.late, absent: a.absent + r.absent, total: a.total + r.total }),
    { present: 0, late: 0, absent: 0, total: 0 });
  return { students: out, by_date: byDate, totals: { ...tot, sessions: byDate.length, rate: tot.total ? Math.round(((tot.present + tot.late) / tot.total) * 100) : null } };
}
const ownedClass = (user, id) => {
  const c = db.prepare('SELECT * FROM classes WHERE id=? AND teacher_id=?').get(Number(id), user.id);
  if (!c) throw E(404, 'no_class', 'We couldn’t find that class.');
  return c;
};

/* ---------- check-in logic ---------- */
function evaluateCheckin(user, raw) {
  const code = normCode(raw);
  if (code.length !== 8) throw E(400, 'bad_code', 'That code doesn’t look right.', 'Check-in codes have 8 letters or numbers and change every 30 seconds.');
  const d = now();
  const c = db.prepare('SELECT * FROM classes WHERE archived=0').all()
    .find((item) => checkinOpen(item, d) && checkinCode(item, d) === code);
  if (!c) throw E(409, 'expired_code', 'This check-in code has expired or class check-in is closed.', 'Scan the current QR code shown by your teacher during scheduled class time.');
  const enr = db.prepare('SELECT * FROM enrollments WHERE class_id=? AND student_id=?').get(c.id, user.id);
  if (!enr) throw E(403, 'not_enrolled', `You’re not registered in ${c.subject}.`, 'Ask your teacher to add your Student ID to the class.');
  const today = ymd(d);
  const existing = db.prepare('SELECT * FROM attendance WHERE class_id=? AND student_id=? AND date=?').get(c.id, user.id, today);
  if (existing) return { c, enr, d, today, already: true, existing };
  const schedule = scheduleForDate(c, today);
  if (!classDays(schedule).includes(d.getDay())) throw E(409, 'not_today', `${c.subject} doesn’t meet today.`, `It meets ${dayLabel(schedule)}.`);
  const w = windowState(schedule, d);
  if (w === 'early') throw E(409, 'too_early', `${c.subject} starts at ${fmt12(c.start)}.`, 'You can check in once class starts.');
  if (w === 'closed') throw E(409, 'closed', `Check-in for ${c.subject} closed at ${fmt12(c.end)}.`, 'You’re marked Absent for today. Ask your teacher if this is a mistake.');
  return { c, enr, d, today, already: false, status: w };
}

/* ---------- routes ---------- */
const routes = [];
const add = (method, pattern, role, fn) => {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ method, re, keys, role, fn });
};
const loginTries = new Map();

add('GET', '/api/config', null, ({ req }) => {
  const host = req.headers.host || `localhost:${PORT}`;
  let base = `${req.headers['x-forwarded-proto'] || 'http'}://${host}`;
  if (/^(localhost|127\.0\.0\.1|\[::1\])(:|$)/.test(host)) {
    const lan = Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal);
    if (lan) base = `http://${lan.address}:${PORT}`;
  }
  return { base_url: base };
});
add('GET', '/api/me', null, ({ user }) => ({ user: user && { id: user.id, role: user.role, school_id: user.school_id, name: user.name }, clock: clockInfo() }));
add('POST', '/api/login', null, ({ req, body, res }) => {
  const id = text(body.id, 1, 40, 'ID');
  const key = `${req.socket.remoteAddress}|${id.toLowerCase()}`;
  const t = loginTries.get(key) || { n: 0, at: Date.now() };
  if (Date.now() - t.at > 600000) { t.n = 0; t.at = Date.now(); }
  if (t.n >= 8) throw E(429, 'rate_limited', 'Too many attempts.', 'Please wait a few minutes and try again.');
  const u = db.prepare('SELECT * FROM users WHERE school_id = ?').get(id);
  if (!u || !checkPw(u, body.password)) {
    t.n++; loginTries.set(key, t);
    throw E(401, 'bad_login', 'That ID or password isn’t right.', 'Check them and try again.');
  }
  loginTries.delete(key);
  const token = crypto.randomBytes(24).toString('hex');
  db.prepare('INSERT INTO sessions VALUES (?,?,?)').run(token, u.id, Date.now());
  res.setHeader('Set-Cookie', `sid=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800`);
  return { user: { id: u.id, role: u.role, school_id: u.school_id, name: u.name } };
});
add('POST', '/api/logout', null, ({ req, res }) => {
  const m = /(?:^|;\s*)sid=([a-f0-9]+)/.exec(req.headers.cookie || '');
  if (m) db.prepare('DELETE FROM sessions WHERE token=?').run(m[1]);
  res.setHeader('Set-Cookie', 'sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
  return { ok: true };
});
add('POST', '/api/demo-clock', 'teacher', ({ body }) => {
  if (body.reset) { clock.offset = 0; clock.label = null; return { clock: clockInfo() }; }
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(String(body.datetime || ''));
  if (!m) throw E(400, 'invalid', 'Pick a valid date and time.');
  const target = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], 0);
  if (isNaN(target)) throw E(400, 'invalid', 'Pick a valid date and time.');
  clock.offset = target.getTime() - Date.now();
  clock.label = `${DAY[target.getDay()]} ${ymd(target)} ${fmt12(hm(target))}`;
  return { clock: clockInfo() };
});

/* ----- student ----- */
const studentClasses = (u) => db.prepare(`SELECT c.*, e.section, e.enrolled_date, t.name teacher_name FROM enrollments e
  JOIN classes c ON c.id=e.class_id JOIN users t ON t.id=c.teacher_id WHERE e.student_id=? ORDER BY c.start`).all(u.id);

add('GET', '/api/student/home', 'student', ({ user }) => {
  const d = now(); const today = ymd(d);
  const items = studentClasses(user).filter((c) => !c.archived && classDays(scheduleForDate(c, today)).includes(d.getDay())).map((c) => {
    const schedule = scheduleForDate(c, today);
    const rec = db.prepare('SELECT * FROM attendance WHERE class_id=? AND student_id=? AND date=?').get(c.id, user.id, today);
    const st = statusFor(c, rec, today, d);
    return { class_id: c.id, subject: c.subject, start: schedule.start, end: schedule.end, section: c.section, teacher: c.teacher_name,
      status: st.status, checked_at: st.checked_at || null, window: windowState(schedule, d) };
  });
  return { clock: clockInfo(), classes: items };
});
add('GET', '/api/student/schedule', 'student', ({ user }) => ({
  clock: clockInfo(),
  classes: studentClasses(user).filter((c) => !c.archived).map((c) => ({ class_id: c.id, subject: c.subject, days: classDays(c), start: c.start, end: c.end, section: c.section, teacher: c.teacher_name })),
}));
add('GET', '/api/student/history', 'student', ({ user, url }) => {
  const d = now(); const only = Number(url.searchParams.get('class_id')) || null;
  const classes = studentClasses(user).filter((c) => !only || c.id === only);
  const items = []; const sum = { present: 0, late: 0, absent: 0, total: 0 };
  for (const c of classes) {
    const recs = new Map(db.prepare('SELECT * FROM attendance WHERE class_id=? AND student_id=?').all(c.id, user.id).map((r) => [r.date, r]));
    for (const date of meetingDates(c, c.enrolled_date, d)) {
      const st = statusFor(c, recs.get(date), date, d);
      if (st.status === 'pending') continue;
      sum[st.status]++; sum.total++;
      items.push({ date, class_id: c.id, subject: c.subject, start: c.start, status: st.status, checked_at: st.checked_at || null });
    }
  }
  items.sort((a, b) => (a.date === b.date ? (a.start < b.start ? 1 : -1) : a.date < b.date ? 1 : -1));
  return { summary: { ...sum, rate: sum.total ? Math.round(((sum.present + sum.late) / sum.total) * 100) : null },
    items: items.slice(0, 150), classes: studentClasses(user).map((c) => ({ id: c.id, subject: c.subject })) };
});
const checkinAttempts = new Map();
const checkinWrap = (user, fn) => {
  const key = user.id, cutoff = Date.now() - 60000;
  const attempts = (checkinAttempts.get(key) || []).filter((ts) => ts > cutoff);
  if (attempts.length >= 20) throw E(429, 'rate_limited', 'Too many code attempts.', 'Wait a minute, then scan the current code again.');
  try { return fn(); } catch (e) {
    if (e instanceof HttpError) {
      logEvent(user, null, 'error', e.code);
      if (e.code === 'bad_code' || e.code === 'expired_code') attempts.push(Date.now());
      checkinAttempts.set(key, attempts);
    }
    throw e;
  }
};
add('POST', '/api/checkin/preview', 'student', ({ user, body }) => checkinWrap(user, () => {
  const r = evaluateCheckin(user, body.code);
  return {
    class: { subject: r.c.subject, start: r.c.start, end: r.c.end, section: r.enr.section, teacher: db.prepare('SELECT name FROM users WHERE id=?').get(r.c.teacher_id).name },
    student: { name: user.name, school_id: user.school_id },
    already: r.already, status: r.already ? r.existing.status : r.status, checked_at: r.already ? r.existing.checked_at : null,
  };
}));
add('POST', '/api/checkin', 'student', ({ user, body }) => checkinWrap(user, () => {
  const r = evaluateCheckin(user, body.code);
  if (r.already) return { already: true, status: r.existing.status, checked_at: r.existing.checked_at, subject: r.c.subject };
  const at = `${r.today}T${hm(r.d)}:${pad(r.d.getSeconds())}`;
  db.prepare('INSERT INTO attendance (class_id, student_id, date, status, checked_at, method) VALUES (?,?,?,?,?,?)')
    .run(r.c.id, user.id, r.today, r.status, at, body.method === 'qr' ? 'qr' : 'code');
  const ms = Math.max(0, Math.min(600000, Math.round(Number(body.duration_ms) || 0)));
  logEvent(user, r.c.id, 'ok', body.method === 'qr' ? 'qr' : 'code', ms);
  return { already: false, status: r.status, checked_at: at, subject: r.c.subject };
}));

/* ----- teacher ----- */
add('GET', '/api/classes', 'teacher', ({ user }) => {
  const d = now(); const today = ymd(d);
  const list = db.prepare('SELECT * FROM classes WHERE teacher_id=? ORDER BY start').all(user.id).map((c) => {
    const info = classInfo(c, d);
    return { ...info, student_count: db.prepare('SELECT COUNT(*) n FROM enrollments WHERE class_id=?').get(c.id).n,
      counts: !c.archived && info.meets_today ? rosterFor(c, today, d).counts : null };
  });
  return { clock: clockInfo(), classes: list };
});
add('POST', '/api/classes', 'teacher', ({ user, body }) => {
  const subject = text(body.subject, 2, 60, 'Subject');
  const days = [...new Set((Array.isArray(body.days) ? body.days : []).map(Number))].filter((x) => x >= 0 && x <= 6).sort();
  if (!days.length) throw E(400, 'invalid', 'Pick at least one class day.');
  const t = /^([01]\d|2[0-3]):[0-5]\d$/;
  if (!t.test(body.start || '') || !t.test(body.end || '')) throw E(400, 'invalid', 'Enter a start and end time.');
  if (toMin(body.end) <= toMin(body.start)) throw E(400, 'invalid', 'End time must be after the start time.');
  const grace = Number(body.grace);
  if (!Number.isInteger(grace) || grace < 0 || grace > 60) throw E(400, 'invalid', 'The on-time window must be 0–60 minutes.');
  const r = db.prepare('INSERT INTO classes (teacher_id, subject, code, days, start, end, grace, created_date) VALUES (?,?,?,?,?,?,?,?)')
    .run(user.id, subject, newCode(), days.join(','), body.start, body.end, grace, ymd(now()));
  const id = Number(r.lastInsertRowid), created = ymd(now());
  db.prepare('INSERT INTO class_schedules (class_id, effective_date, days, start, end, grace) VALUES (?,?,?,?,?,?)')
    .run(id, created, days.join(','), body.start, body.end, grace);
  audit(user, id, 'class_created', { subject, days, start: body.start, end: body.end, grace });
  return { id };
});
add('GET', '/api/classes/:id', 'teacher', ({ user, params, url }) => {
  const c = ownedClass(user, params.id); const d = now();
  let date = url.searchParams.get('date') || ymd(d);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) date = ymd(d);
  const selected = new Date(`${date}T${hm(d)}:00`);
  const checkin = date === ymd(d) && checkinOpen(c, d)
    ? { code: checkinCode(c, d), expires_in: Math.ceil((30000 - (d.getTime() % 30000)) / 1000) }
    : null;
  return { clock: clockInfo(), class: classInfo(c, selected),
    editable: { subject: c.subject, days: classDays(c), start: c.start, end: c.end, grace: c.grace },
    checkin, date, ...rosterFor(c, date, d) };
});
add('PUT', '/api/classes/:id', 'teacher', ({ user, params, body }) => {
  const c = ownedClass(user, params.id);
  const subject = text(body.subject, 2, 60, 'Subject');
  const days = [...new Set((Array.isArray(body.days) ? body.days : []).map(Number))].filter((x) => x >= 0 && x <= 6).sort();
  if (!days.length) throw E(400, 'invalid', 'Pick at least one class day.');
  const t = /^([01]\d|2[0-3]):[0-5]\d$/;
  if (!t.test(body.start || '') || !t.test(body.end || '')) throw E(400, 'invalid', 'Enter a start and end time.');
  if (toMin(body.end) <= toMin(body.start)) throw E(400, 'invalid', 'End time must be after the start time.');
  const grace = Number(body.grace);
  if (!Number.isInteger(grace) || grace < 0 || grace > 60) throw E(400, 'invalid', 'The on-time window must be 0–60 minutes.');
  const effective = nextDate(ymd(now()));
  const previous = scheduleForDate(c, effective);
  db.prepare('UPDATE classes SET subject=?, days=?, start=?, end=?, grace=? WHERE id=?')
    .run(subject, days.join(','), body.start, body.end, grace, c.id);
  db.prepare(`INSERT INTO class_schedules (class_id, effective_date, days, start, end, grace) VALUES (?,?,?,?,?,?)
    ON CONFLICT (class_id, effective_date) DO UPDATE SET days=excluded.days, start=excluded.start, end=excluded.end, grace=excluded.grace`)
    .run(c.id, effective, days.join(','), body.start, body.end, grace);
  audit(user, c.id, 'class_edited', { effective_date: effective, previous, next: { subject, days, start: body.start, end: body.end, grace } });
  return { ok: true, effective_date: effective };
});
add('POST', '/api/classes/:id/archive', 'teacher', ({ user, params, body }) => {
  const c = ownedClass(user, params.id), archived = Boolean(body.archived);
  if (archived && !c.archived) {
    db.prepare('INSERT INTO class_pauses (class_id, start_date) VALUES (?,?)').run(c.id, nextDate(ymd(now())));
  } else if (!archived && c.archived) {
    db.prepare('UPDATE class_pauses SET end_date=? WHERE class_id=? AND end_date IS NULL').run(previousDate(ymd(now())), c.id);
  }
  db.prepare('UPDATE classes SET archived=?, archived_date=? WHERE id=?').run(archived ? 1 : 0, archived ? ymd(now()) : null, c.id);
  audit(user, c.id, archived ? 'class_archived' : 'class_restored', { subject: c.subject });
  return { ok: true, archived };
});
add('POST', '/api/classes/:id/students', 'teacher', ({ user, params, body }) => {
  const c = ownedClass(user, params.id);
  const defSection = String(body.section || '').replace(/^sec(tion)?\.?\s*/i, '').trim().toUpperCase().slice(0, 20) || 'A';
  const lines = String(body.text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) throw E(400, 'invalid', 'Paste at least one student.', 'Use one line per student: ID, Full Name, Section');
  if (lines.length > 300) throw E(400, 'invalid', 'Please add 300 students or fewer at a time.');
  const res = { added: 0, updated: 0, errors: [] };
  lines.forEach((line, i) => {
    const p = line.split(/[,\t;]/).map((x) => x.trim());
    const sid = p[0], name = (p[1] || '').replace(/\s+/g, ' ');
    const section = (p[2] || '').replace(/^sec(tion)?\.?\s*/i, '').trim().toUpperCase().slice(0, 20) || defSection;
    if (!/^[A-Za-z0-9-]{3,20}$/.test(sid)) return res.errors.push({ line: i + 1, text: line, message: 'Student ID should be 3–20 letters, numbers or dashes.' });
    if (name.length < 2 || name.length > 60) return res.errors.push({ line: i + 1, text: line, message: 'Add the student’s name after the ID, separated by a comma.' });
    let u = db.prepare('SELECT * FROM users WHERE school_id=?').get(sid);
    if (u && u.role !== 'student') return res.errors.push({ line: i + 1, text: line, message: 'That ID belongs to a teacher account.' });
    if (!u) u = { id: makeUser('student', sid, name, sid) };
    const ex = db.prepare('SELECT 1 FROM enrollments WHERE class_id=? AND student_id=?').get(c.id, u.id);
    if (ex) { db.prepare('UPDATE enrollments SET section=? WHERE class_id=? AND student_id=?').run(section, c.id, u.id); res.updated++; }
    else { db.prepare('INSERT INTO enrollments VALUES (?,?,?,?)').run(c.id, u.id, section, ymd(now())); res.added++; }
  });
  return res;
});
add('DELETE', '/api/classes/:id/students/:sid', 'teacher', ({ user, params }) => {
  const c = ownedClass(user, params.id);
  db.prepare('DELETE FROM enrollments WHERE class_id=? AND student_id=?').run(c.id, Number(params.sid));
  audit(user, c.id, 'student_removed', { student_id: Number(params.sid) });
  return { ok: true };
});
add('PATCH', '/api/classes/:id/students/:sid', 'teacher', ({ user, params, body }) => {
  const c = ownedClass(user, params.id), sid = Number(params.sid);
  const enrollment = db.prepare(`SELECT e.section, u.name FROM enrollments e JOIN users u ON u.id=e.student_id
    WHERE e.class_id=? AND e.student_id=?`).get(c.id, sid);
  if (!enrollment) throw E(404, 'no_student', 'That student isn’t in this class.');
  const name = text(body.name, 2, 60, 'Student name');
  const section = text(body.section, 1, 20, 'Section').toUpperCase();
  db.prepare('UPDATE users SET name=? WHERE id=?').run(name, sid);
  db.prepare('UPDATE enrollments SET section=? WHERE class_id=? AND student_id=?').run(section, c.id, sid);
  audit(user, c.id, 'student_edited', { student_id: sid, before: { name: enrollment.name, section: enrollment.section }, after: { name, section } });
  return { ok: true };
});
add('PUT', '/api/classes/:id/attendance', 'teacher', ({ user, params, body }) => {
  const c = ownedClass(user, params.id); const d = now();
  const date = String(body.date || ymd(d));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date > ymd(d)) throw E(400, 'invalid', 'You can only change attendance for today or earlier.');
  const sid = Number(body.student_id);
  if (!db.prepare('SELECT 1 FROM enrollments WHERE class_id=? AND student_id=?').get(c.id, sid)) throw E(404, 'no_student', 'That student isn’t in this class.');
  const prev = db.prepare('SELECT status FROM attendance WHERE class_id=? AND student_id=? AND date=?').get(c.id, sid, date);
  if (body.status === 'clear') db.prepare('DELETE FROM attendance WHERE class_id=? AND student_id=? AND date=?').run(c.id, sid, date);
  else if (['present', 'late', 'absent'].includes(body.status)) {
    db.prepare(`INSERT INTO attendance (class_id, student_id, date, status, checked_at, method) VALUES (?,?,?,?,?,'teacher')
      ON CONFLICT (class_id, student_id, date) DO UPDATE SET status=excluded.status, method='teacher'`)
      .run(c.id, sid, date, body.status, `${ymd(d)}T${hm(d)}:${pad(d.getSeconds())}`);
  } else throw E(400, 'invalid', 'Choose Present, Late or Absent.');
  const reason = typeof body.reason === 'string' ? body.reason.trim().slice(0, 200) : '';
  audit(user, c.id, 'attendance_corrected', { student_id: sid, date, from: prev ? prev.status : 'clear', to: body.status, reason });
  return { ok: true, previous: prev ? prev.status : 'clear' };
});
add('GET', '/api/classes/:id/audit', 'teacher', ({ user, params }) => {
  const c = ownedClass(user, params.id);
  return { items: db.prepare(`SELECT a.ts, a.action, a.details, u.name teacher FROM audit_log a
    JOIN users u ON u.id=a.teacher_id WHERE a.class_id=? ORDER BY a.id DESC LIMIT 100`).all(c.id)
    .map((item) => ({ ...item, details: JSON.parse(item.details) })) };
});
add('GET', '/api/classes/:id/report', 'teacher', ({ user, params }) => {
  const c = ownedClass(user, params.id);
  return { clock: clockInfo(), class: classInfo(c, now()), ...computeReport(c, now()) };
});
add('GET', '/api/classes/:id/report.csv', 'teacher', ({ user, params }) => {
  const c = ownedClass(user, params.id); const r = computeReport(c, now());
  const cell = (v) => { let s = String(v ?? ''); if (/^[=+\-@]/.test(s)) s = "'" + s; return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const rows = [['Student ID', 'Name', 'Section', 'Present', 'Late', 'Absent', 'Sessions', 'Attendance rate %'],
    ...r.students.map((s) => [s.school_id, s.name, s.section, s.present, s.late, s.absent, s.total, s.rate ?? ''])];
  return { raw: { type: 'text/csv; charset=utf-8', filename: `${c.subject.replace(/[^\w-]+/g, '_')}-attendance.csv`, body: rows.map((x) => x.map(cell).join(',')).join('\n') } };
});
add('GET', '/api/metrics', 'teacher', () => {
  const ok = db.prepare("SELECT duration_ms FROM events WHERE type='ok' AND duration_ms IS NOT NULL ORDER BY duration_ms").all().map((r) => r.duration_ms);
  const errs = db.prepare("SELECT code, COUNT(*) n FROM events WHERE type='error' GROUP BY code ORDER BY n DESC").all();
  const errTotal = errs.reduce((a, r) => a + r.n, 0);
  const okTotal = db.prepare("SELECT COUNT(*) n FROM events WHERE type='ok'").get().n;
  const corrections = db.prepare("SELECT COUNT(*) n FROM attendance WHERE method='teacher'").get().n;
  const records = db.prepare('SELECT COUNT(*) n FROM attendance').get().n;
  return {
    checkins_ok: okTotal, errors: errTotal, errors_by_code: errs,
    success_rate: okTotal + errTotal ? Math.round((okTotal / (okTotal + errTotal)) * 100) : null,
    median_seconds: ok.length ? Math.round(ok[Math.floor(ok.length / 2)] / 100) / 10 : null,
    teacher_corrections: corrections, records,
  };
});

/* ---------- http plumbing ---------- */
function getUser(req) {
  const m = /(?:^|;\s*)sid=([a-f0-9]+)/.exec(req.headers.cookie || '');
  if (!m) return null;
  const s = db.prepare('SELECT u.*, s.created FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=?').get(m[1]);
  if (!s) return null;
  if (Date.now() - s.created > 7 * 86400000) { db.prepare('DELETE FROM sessions WHERE token=?').run(m[1]); return null; }
  return s;
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > 1e6) { reject(E(413, 'too_big', 'That request is too large.')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { const j = JSON.parse(Buffer.concat(chunks).toString('utf8')); resolve(j && typeof j === 'object' ? j : {}); }
      catch { reject(E(400, 'bad_json', 'We couldn’t read that request.')); }
    });
    req.on('error', reject);
  });
}
function send(res, status, body, type = 'application/json; charset=utf-8', extra = {}) {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extra });
  res.end(body);
}
const sendJson = (res, status, obj) => send(res, status, JSON.stringify(obj));
function sendError(res, e) {
  if (e instanceof HttpError) return sendJson(res, e.status, { error: { code: e.code, message: e.message, hint: e.hint } });
  console.error(e);
  return sendJson(res, 500, { error: { code: 'server', message: 'Something went wrong on our side. Please try again.' } });
}
async function handleApi(req, res, url) {
  let matched = null, pathMatched = false;
  for (const r of routes) {
    const m = r.re.exec(url.pathname);
    if (!m) continue;
    pathMatched = true;
    if (r.method !== req.method) continue;
    matched = { r, params: Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])])) };
    break;
  }
  if (!matched) throw pathMatched ? E(405, 'method', 'Method not allowed.') : E(404, 'not_found', 'Not found.');
  const user = getUser(req);
  const role = matched.r.role;
  if (role) {
    if (!user) throw E(401, 'auth', 'Please sign in to continue.');
    if (role !== 'any' && user.role !== role) throw E(403, 'forbidden', 'That page is for a different kind of account.');
  }
  let body = {};
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
    if (!/application\/json/.test(req.headers['content-type'] || '') && Number(req.headers['content-length'] || 0) > 0) throw E(415, 'type', 'Unsupported request.');
    body = await readBody(req);
  }
  const out = await matched.r.fn({ req, res, user, params: matched.params, body, url });
  if (out && out.raw) return send(res, 200, out.raw.body, out.raw.type, { 'Content-Disposition': `attachment; filename="${out.raw.filename}"` });
  return sendJson(res, 200, out);
}
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.ico': 'image/x-icon', '.png': 'image/png' };
const PUB = path.join(__dirname, 'public');
function serveStatic(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') throw E(405, 'method', 'Method not allowed.');
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';
  let file = path.join(PUB, rel);
  if (!file.startsWith(PUB + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(PUB, 'index.html');
  const csp = "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; media-src 'self'; frame-ancestors 'none'";
  send(res, 200, fs.readFileSync(file), MIME[path.extname(file)] || 'application/octet-stream', { 'Content-Security-Policy': csp, 'Cache-Control': 'no-cache' });
}
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) await handleApi(req, res, url);
    else serveStatic(req, res, url);
  } catch (e) { sendError(res, e); }
});
if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`\nSmart Attendance Interface running:\n  http://localhost:${PORT}`);
    for (const i of Object.values(os.networkInterfaces()).flat()) if (i && i.family === 'IPv4' && !i.internal) console.log(`  http://${i.address}:${PORT}   (open on your phone, same Wi-Fi)`);
    console.log('\nDemo logins:\n  Teacher  teacher1 / teacher123   (teaches HCI)\n  Student  2024-001 / 2024-001     (Juan Dela Cruz, Sec A)\n');
  });
}
module.exports = { server, closeDb: () => db.close() };
