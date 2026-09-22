// server.js — سیستم مسابقه: ثبت‌نام/ورود، سوالات تستی و کدی، لیدربورد قفل‌شونده، پنل ادمین
const express = require('express');
const session = require('express-session');
const path = require('path');
const ExcelJS = require('exceljs');
const store = require('./store');
const judge = require('./judge');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123'; // حتماً قبل از استقرار واقعی عوض کنید
const SESSION_SECRET = process.env.SESSION_SECRET || 'change-this-secret-before-deploying';

app.use(express.json({ limit: '1mb' }));
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 12 } // ۱۲ ساعت
}));
app.use(express.static(path.join(__dirname, 'public')));

// ---------- کمک‌تابع‌ها ----------
function requireAuth(req, res, next) {
  if (!req.session.username) return res.status(401).json({ error: 'ابتدا وارد شوید.' });
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session.isAdmin) return res.status(401).json({ error: 'دسترسی ادمین لازم است.' });
  next();
}

function normalizeStudentId(value) {
  return String(value || '')
    .trim()
    .replace(/[۰-۹]/g, digit => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(digit)))
    .replace(/[٠-٩]/g, digit => String('٠١٢٣٤٥٦٧٨٩'.indexOf(digit)));
}

function publicQuestion(q) {
  // فقط اطلاعاتی که شرکت‌کننده باید ببیند (بدون جواب درست)
  const base = { id: q.id, type: q.type, difficulty: q.difficulty || 'medium', title: q.title, prompt: q.prompt, points: q.points };
  if (q.type === 'mcq') base.options = q.options;
  if (q.type === 'code') {
    base.language = q.language;
    base.starterCode = q.starterCode || '';
    base.testCaseCount = (q.testCases || []).length;
  }
  return base;
}

function computeScore(data, username) {
  const subs = data.submissions[username] || {};
  let score = 0;
  for (const qid in subs) {
    if (subs[qid].correct) score += subs[qid].points || 0;
  }
  return score;
}

function leaderboardData(data) {
  return data.users
    .map(u => ({
      username: u.username,
      score: computeScore(data, u.username),
      answered: Object.keys(data.submissions[u.username] || {}).length
    }))
    .sort((a, b) => b.score - a.score || a.answered - b.answered);
}

function isLeaderboardLocked(data) {
  if (data.config.leaderboardForceOpen) return false;
  if (!data.config.competitionEndTime) return true; // اگر زمانی تعیین نشده، قفل بماند
  return new Date() < new Date(data.config.competitionEndTime);
}

function getContestState(data, username) {
  const user = data.users.find(u => u.username === username);
  if (!user || !user.contestStartedAt || !user.contestEndsAt) {
    return { started: false, expired: false, endsAt: null };
  }
  const expired = Date.now() >= new Date(user.contestEndsAt).getTime();
  return { started: true, expired, endsAt: user.contestEndsAt };
}

async function buildLeaderboardWorkbook(data, entries) {
  const wb = new ExcelJS.Workbook();
  wb.creator = data.config.title || 'مسابقه';
  const sheet = wb.addWorksheet('لیدربورد', { views: [{ rightToLeft: true }] });

  sheet.columns = [
    { header: 'رتبه', key: 'rank', width: 8 },
    { header: 'نام کاربری', key: 'username', width: 28 },
    { header: 'امتیاز', key: 'score', width: 12 },
    { header: 'تعداد پاسخ‌داده', key: 'answered', width: 18 }
  ];
  sheet.getRow(1).font = { bold: true };
  sheet.getRow(1).alignment = { horizontal: 'center' };

  entries.forEach((e, i) => {
    sheet.addRow({ rank: i + 1, username: e.username, score: e.score, answered: e.answered });
  });

  sheet.eachRow(row => { row.alignment = { horizontal: 'center' }; });
  return wb;
}

// ---------- ثبت‌نام / ورود ----------
app.post('/api/register', async (req, res) => {
  const { username, studentId, password } = req.body || {};
  const normalizedStudentId = normalizeStudentId(studentId);
  if (!username || !password || username.length < 3 || password.length < 4) {
    return res.status(400).json({ error: 'نام کاربری حداقل ۳ کاراکتر و رمز عبور حداقل ۴ کاراکتر باشد.' });
  }
  if (!/^\d{8}$/.test(normalizedStudentId)) {
    return res.status(400).json({ error: 'شماره دانشجویی باید دقیقاً ۸ رقم باشد.' });
  }
  const data = store.read();
  if (data.users.find(u => u.username.toLowerCase() === username.toLowerCase())) {
    return res.status(400).json({ error: 'این نام کاربری قبلاً ثبت شده است.' });
  }
  if (data.users.find(u => u.studentId === normalizedStudentId)) {
    return res.status(400).json({ error: 'این شماره دانشجویی قبلاً ثبت شده است.' });
  }
  if (!Array.isArray(data.allowedStudentIds) || !data.allowedStudentIds.includes(normalizedStudentId)) {
    return res.status(400).json({ error: 'این شماره دانشجویی در فهرست مجاز مسابقه نیست.' });
  }
  const { salt, hash } = store.hashPassword(password);
  await store.mutate(d => {
    d.users.push({ id: store.newId('u'), username, studentId: normalizedStudentId, passwordHash: hash, salt, createdAt: new Date().toISOString() });
    d.submissions[username] = {};
  });
  req.session.username = username;
  res.json({ ok: true, username });
});

app.post('/api/login', (req, res) => {
  const { username, studentId, password } = req.body || {};
  const data = store.read();
  const user = data.users.find(u => u.username.toLowerCase() === (username || '').toLowerCase());
  if (!user || !store.verifyPassword(password || '', user.salt, user.passwordHash)) {
    return res.status(400).json({ error: 'نام کاربری یا رمز عبور اشتباه است.' });
  }
  req.session.username = user.username;
  res.json({ ok: true, username: user.username });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/me', (req, res) => {
  res.json({ username: req.session.username || null, isAdmin: !!req.session.isAdmin });
});

// ---------- Q ----------
app.get('/api/questions', requireAuth, (req, res) => {
  const data = store.read();
  const mySubs = data.submissions[req.session.username] || {};
  const progress = {
    answered: Object.keys(mySubs).length,
    total: data.questions.length
  };
  const contest = getContestState(data, req.session.username);
  if (!contest.started || contest.expired) {
    return res.json({ title: data.config.title, questions: [], contest, progress });
  }
  const qs = [...data.questions]
    .sort((a, b) => (a.order || 0) - (b.order || 0))
    .map(q => {
      const pub = publicQuestion(q);
      const sub = mySubs[q.id];
      pub.answered = !!sub;
      pub.correct = sub ? sub.correct : null;
      return pub;
    });
  res.json({ title: data.config.title, questions: qs, contest, progress });
});

app.post('/api/contest/start', requireAuth, async (req, res) => {
  const data = store.read();
  const existing = getContestState(data, req.session.username);
  if (existing.started) return res.json({ ok: true, contest: existing });
  const duration = Number(data.config.contestDurationMinutes) || 60;
  const startedAt = new Date();
  const endsAt = new Date(startedAt.getTime() + duration * 60 * 1000);
  await store.mutate(d => {
    const user = d.users.find(u => u.username === req.session.username);
    user.contestStartedAt = startedAt.toISOString();
    user.contestEndsAt = endsAt.toISOString();
  });
  res.json({ ok: true, contest: { started: true, expired: false, endsAt: endsAt.toISOString() } });
});

app.post('/api/submit', requireAuth, async (req, res) => {
  const { questionId, answer } = req.body || {};
  const data = store.read();
  const contest = getContestState(data, req.session.username);
  if (!contest.started || contest.expired) {
    return res.status(403).json({ error: contest.started ? 'زمان مسابقه تمام شده است.' : 'ابتدا مسابقه را شروع کنید.' });
  }
  const q = data.questions.find(q => q.id === questionId);
  if (!q) return res.status(404).json({ error: 'سوال پیدا نشد.' });

  const username = req.session.username;
  const already = (data.submissions[username] || {})[questionId];
  if (already) return res.status(400).json({ error: 'قبلاً به این سوال پاسخ داده‌اید.', result: already });

  let result;
  if (q.type === 'mcq') {
    const correct = Number(answer) === Number(q.correctIndex);
    result = { answer, correct, points: correct ? q.points : 0, submittedAt: new Date().toISOString() };
  } else if (q.type === 'code') {
    const testCases = (q.testCases && q.testCases.length) ? q.testCases : [{ stdin: '', expectedOutput: '' }];

    // اول تست اول رو اجرا می‌کنیم تا اگه خطای کامپایل بود، بقیه رو الکی صدا نزنیم
    const first = await judge.runCode({ language: q.language, code: answer, stdin: testCases[0].stdin });
    if (!first.ok) return res.status(502).json({ error: first.error });

    let testResults;
    if (first.compileError) {
      testResults = testCases.map(() => ({ passed: false, compileError: true }));
      testResults[0].stderr = first.stderr;
    } else {
      testResults = new Array(testCases.length);
      testResults[0] = {
        passed: judge.normalizeOutput(first.stdout) === judge.normalizeOutput(testCases[0].expectedOutput),
        stdout: first.stdout,
        stderr: first.stderr
      };

      if (testCases.length > 1) {
        const rest = await Promise.all(
          testCases.slice(1).map(tc => judge.runCode({ language: q.language, code: answer, stdin: tc.stdin }))
        );
        rest.forEach((run, i) => {
          const tc = testCases[i + 1];
          if (!run.ok) {
            testResults[i + 1] = { passed: false, error: run.error };
          } else {
            testResults[i + 1] = {
              passed: !run.compileError && judge.normalizeOutput(run.stdout) === judge.normalizeOutput(tc.expectedOutput),
              stdout: run.stdout, stderr: run.stderr, compileError: !!run.compileError
            };
          }
        });
      }
    }

    const correct = testResults.every(t => t.passed);
    result = {
      answer, correct, points: correct ? q.points : 0,
      testResults, submittedAt: new Date().toISOString()
    };
  } else {
    return res.status(400).json({ error: 'نوع سوال نامعتبر است.' });
  }

  await store.mutate(d => {
    if (!d.submissions[username]) d.submissions[username] = {};
    d.submissions[username][questionId] = result;
  });

  res.json({ ok: true, result });
});

app.get('/api/results', requireAuth, (req, res) => {
  const data = store.read();
  const username = req.session.username;
  const subs = data.submissions[username] || {};
  const details = data.questions.map(q => ({
    id: q.id, title: q.title, type: q.type, points: q.points,
    submitted: !!subs[q.id],
    correct: subs[q.id] ? subs[q.id].correct : null,
    earned: subs[q.id] && subs[q.id].correct ? q.points : 0
  }));
  res.json({
    score: computeScore(data, username),
    total: data.questions.reduce((s, q) => s + q.points, 0),
    answeredCount: Object.keys(subs).length,
    totalQuestions: data.questions.length,
    details
  });
});

// ---------- Leader Board ----------
app.get('/api/leaderboard', requireAuth, (req, res) => {
  const data = store.read();
  const locked = isLeaderboardLocked(data);
  if (locked) {
    return res.json({ locked: true, endTime: data.config.competitionEndTime });
  }
  res.json({ locked: false, endTime: data.config.competitionEndTime, entries: leaderboardData(data) });
});

// ---------- Admin ----------
app.post('/api/admin/login', (req, res) => {
  const { password } = req.body || {};
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'رمز ادمین اشتباه است.' });
  req.session.isAdmin = true;
  res.json({ ok: true });
});

app.post('/api/admin/logout', (req, res) => {
  req.session.isAdmin = false;
  res.json({ ok: true });
});

app.get('/api/admin/questions', requireAdmin, (req, res) => {
  const data = store.read();
  res.json({ questions: data.questions });
});

app.post('/api/admin/questions', requireAdmin, async (req, res) => {
  const q = req.body || {};
  const difficulties = ['easy', 'medium', 'hard'];
  if (!q.type || !q.title || !q.prompt || !q.points) {
    return res.status(400).json({ error: 'فیلدهای type، title، prompt و points الزامی است.' });
  }
  if (!difficulties.includes(q.difficulty)) {
    return res.status(400).json({ error: 'سختی سوال باید آسان، متوسط یا سخت باشد.' });
  }
  if (q.type === 'mcq' && (!Array.isArray(q.options) || q.options.length < 2 || !Number.isInteger(q.correctIndex) || q.correctIndex < 0 || q.correctIndex >= q.options.length)) {
    return res.status(400).json({ error: 'برای سوال تستی، گزینه‌ها و شماره گزینه درست معتبر الزامی است.' });
  }
  if (q.type === 'code' && (!q.language || !Array.isArray(q.testCases) || q.testCases.length === 0 || q.testCases.some(tc => !tc.expectedOutput || !tc.expectedOutput.trim()))) {
    return res.status(400).json({ error: 'برای سوال کدی، language و حداقل یک testCase با expectedOutput الزامی است.' });
  }
  const newQ = { ...q, id: store.newId('q'), order: Date.now() };
  await store.mutate(d => { d.questions.push(newQ); });
  res.json({ ok: true, question: newQ });
});

app.delete('/api/admin/questions/:id', requireAdmin, async (req, res) => {
  await store.mutate(d => {
    d.questions = d.questions.filter(q => q.id !== req.params.id);
    for (const u in d.submissions) delete d.submissions[u][req.params.id];
  });
  res.json({ ok: true });
});

app.put('/api/admin/config', requireAdmin, async (req, res) => {
  const { competitionEndTime, leaderboardForceOpen, contestDurationMinutes, title } = req.body || {};
  if (contestDurationMinutes !== undefined && (!Number.isInteger(Number(contestDurationMinutes)) || Number(contestDurationMinutes) < 1)) {
    return res.status(400).json({ error: 'مدت مسابقه باید حداقل ۱ دقیقه باشد.' });
  }
  await store.mutate(d => {
    if (competitionEndTime !== undefined) d.config.competitionEndTime = competitionEndTime;
    if (leaderboardForceOpen !== undefined) d.config.leaderboardForceOpen = leaderboardForceOpen;
    if (contestDurationMinutes !== undefined) d.config.contestDurationMinutes = Number(contestDurationMinutes);
    if (title !== undefined) d.config.title = title;
  });
  res.json({ ok: true, config: store.read().config });
});

app.get('/api/admin/config', requireAdmin, (req, res) => {
  res.json({ config: store.read().config });
});

app.get('/api/admin/leaderboard', requireAdmin, (req, res) => {
  const data = store.read();
  res.json({ entries: leaderboardData(data), locked: isLeaderboardLocked(data) });
});

app.get('/api/admin/leaderboard/export', requireAdmin, async (req, res) => {
  const data = store.read();
  const wb = await buildLeaderboardWorkbook(data, leaderboardData(data));
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="leaderboard.xlsx"');
  await wb.xlsx.write(res);
  res.end();
});

app.get('/api/admin/users', requireAdmin, (req, res) => {
  const data = store.read();
  res.json({ users: data.users.map(u => ({ username: u.username, studentId: u.studentId || '-', createdAt: u.createdAt })) });
});

app.get('/api/admin/student-ids', requireAdmin, (req, res) => {
  const data = store.read();
  res.json({ studentIds: Array.isArray(data.allowedStudentIds) ? data.allowedStudentIds : [] });
});

app.put('/api/admin/student-ids', requireAdmin, async (req, res) => {
  const rawIds = Array.isArray(req.body?.studentIds) ? req.body.studentIds : [];
  const studentIds = [...new Set(rawIds.map(normalizeStudentId).filter(Boolean))];
  const invalid = studentIds.filter(id => !/^\d{8}$/.test(id));
  if (invalid.length > 0) {
    return res.status(400).json({ error: `این شماره‌ها باید دقیقاً ۸ رقم باشند: ${invalid.join('، ')}` });
  }
  await store.mutate(data => { data.allowedStudentIds = studentIds; });
  res.json({ ok: true, studentIds });
});

app.listen(PORT, () => {
  console.log(`✅ Server is active in port ${PORT} : http://localhost:${PORT}`);
  console.log(`🔑 Admin Password: ${ADMIN_PASSWORD}${process.env.ADMIN_PASSWORD ? '' : 'Change the default password!'}`);
});
