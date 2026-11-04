// server.js — سیستم مسابقه: ثبت‌نام/ورود، سوالات تستی و کدی، لیدربورد قفل‌شونده، پنل ادمین
const express = require('express');
const session = require('express-session');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const ExcelJS = require('exceljs');
const store = require('./store');
const judge = require('./judge');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123'; // حتماً قبل از استقرار واقعی عوض کنید
const SESSION_SECRET = process.env.SESSION_SECRET || 'change-this-secret-before-deploying';
const REGISTRATION_CODE_SECRET = process.env.REGISTRATION_CODE_SECRET;
const ENABLE_CODE_QUESTIONS = process.env.ENABLE_CODE_QUESTIONS === 'true';
const PROFANITY_FILE = path.join(__dirname, 'profanity.json');
const REGISTRATION_CODES_FILE = path.join(__dirname, 'Code.txt');

function loadProfanityWords() {
  try {
    const words = JSON.parse(fs.readFileSync(PROFANITY_FILE, 'utf8'));
    if (!Array.isArray(words) && words && typeof words === 'object') {
      return Object.values(words)
        .flat()
        .map(word => String(word).trim())
        .filter(Boolean);
    }
    return Array.isArray(words) ? words.map(word => String(word).trim()).filter(Boolean) : [];
  } catch (error) {
    console.error(`Could not load ${PROFANITY_FILE}: ${error.message}`);
    return [];
  }
}

const USERNAME_PROFANITY_WORDS = process.env.USERNAME_PROFANITY_WORDS
  ? process.env.USERNAME_PROFANITY_WORDS.split(',').map(word => word.trim()).filter(Boolean)
  : loadProfanityWords();
const adminLoginAttempts = new Map();
const ADMIN_MAX_LOGIN_ATTEMPTS = 5;
const ADMIN_LOGIN_WINDOW_MS = 15 * 60 * 1000;
const registrationCodeAttempts = new Map();
const REGISTRATION_CODE_MAX_ATTEMPTS = 10;
const REGISTRATION_CODE_WINDOW_MS = 15 * 60 * 1000;

app.use(express.json({ limit: '1mb' }));
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 12 } // ۱۲ ساعت
}));

const audioAssets = {
  background: path.join(__dirname, 'public', 'music', 'Instrumental Hook (1).mp3'),
  tick: path.join(__dirname, 'public', 'music', 'tick.mp3')
};

app.get('/media/audio/:track', (req, res) => {
  const filePath = audioAssets[req.params.track];
  if (!filePath) return res.sendStatus(404);

  res.set({
    'Content-Type': 'application/octet-stream',
    'Content-Disposition': 'inline',
    'Cache-Control': 'public, max-age=3600'
  });
  fs.createReadStream(filePath)
    .on('error', () => res.destroy())
    .pipe(res);
});

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

function normalizeRegistrationCode(value) {
  return String(value || '')
    .trim()
    .replace(/[۰-۹]/g, digit => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(digit)))
    .replace(/[٠-٩]/g, digit => String('٠١٢٣٤٥٦٧٨٩'.indexOf(digit)));
}

function normalizeStudentId(value) {
  return String(value || '')
    .trim()
    .replace(/[۰-۹]/g, digit => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(digit)))
    .replace(/[٠-٩]/g, digit => String('٠١٢٣٤٥٦٧٨٩'.indexOf(digit)));
}

function parseRegistrationCodeLine(line) {
  const values = String(line || '').split(/[,\t]/);
  const [rawCode, rawStudentId = ''] = values;
  return {
    code: normalizeRegistrationCode(rawCode),
    studentId: normalizeStudentId(rawStudentId) || null,
    validColumns: values.length <= 2
  };
}

function matchingRegistrationCode(codes, hash) {
  const expected = Buffer.from(hash, 'hex');
  return codes.find(code => {
    if (!code || !/^[\da-f]{64}$/i.test(code.hash || '')) return false;
    return crypto.timingSafeEqual(expected, Buffer.from(code.hash, 'hex'));
  });
}

function shuffleQuestionIds(questionIds) {
  const shuffled = [...questionIds];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = crypto.randomInt(index + 1);
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
  }
  return shuffled;
}

function hasCompleteQuestionOrder(order, questionIds) {
  if (!Array.isArray(order) || order.length !== questionIds.length) return false;
  const orderSet = new Set(order);
  return orderSet.size === questionIds.length && questionIds.every(id => orderSet.has(id));
}

function createQuestionOrder(questionIds, users, username) {
  const existingOrders = users
    .filter(user => user.username !== username && hasCompleteQuestionOrder(user.questionOrder, questionIds))
    .map(user => JSON.stringify(user.questionOrder));

  let order;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    order = shuffleQuestionIds(questionIds);
    if (!existingOrders.includes(JSON.stringify(order))) return order;
  }
  return order;
}

async function ensureQuestionOrder(username) {
  const data = store.read();
  const user = data.users.find(entry => entry.username === username);
  if (!user) return [];
  const questionIds = data.questions.map(question => question.id);
  if (hasCompleteQuestionOrder(user.questionOrder, questionIds)) return user.questionOrder;

  return store.mutate(currentData => {
    const currentUser = currentData.users.find(entry => entry.username === username);
    if (!currentUser) return [];
    const currentQuestionIds = currentData.questions.map(question => question.id);
    if (hasCompleteQuestionOrder(currentUser.questionOrder, currentQuestionIds)) {
      return currentUser.questionOrder;
    }
    currentUser.questionOrder = createQuestionOrder(currentQuestionIds, currentData.users, username);
    return currentUser.questionOrder;
  });
}

async function importRegistrationCodes() {
  await store.mutate(data => {
    if (!REGISTRATION_CODE_SECRET || REGISTRATION_CODE_SECRET.length < 32) {
      throw new Error('Set REGISTRATION_CODE_SECRET to a random secret of at least 32 characters.');
    }
    if (data.registrationCodesImported) return;
    if (!fs.existsSync(REGISTRATION_CODES_FILE)) {
      throw new Error('Code.txt was not found; registration codes could not be imported.');
    }

    const rawLines = fs.readFileSync(REGISTRATION_CODES_FILE, 'utf8')
      .split(/\r?\n/)
      .filter(line => line.trim());
    const entries = rawLines.map(parseRegistrationCodeLine);
    const invalidEntries = entries.filter(entry =>
      !entry.validColumns ||
      !/^\d{5}$/.test(entry.code) ||
      (entry.studentId && !/^\d{6,20}$/.test(entry.studentId))
    );
    if (invalidEntries.length) {
      throw new Error(`Code.txt contains ${invalidEntries.length} invalid line(s); use a five-digit code and optionally a 6-20 digit student ID separated by a comma.`);
    }

    const codeToStudentId = new Map();
    const studentIdToCode = new Map();
    for (const entry of entries) {
      if (codeToStudentId.has(entry.code) && codeToStudentId.get(entry.code) !== entry.studentId) {
        throw new Error('Code.txt assigns different student IDs to the same registration code.');
      }
      if (entry.studentId && studentIdToCode.has(entry.studentId) && studentIdToCode.get(entry.studentId) !== entry.code) {
        throw new Error('Code.txt assigns the same student ID to multiple registration codes.');
      }
      codeToStudentId.set(entry.code, entry.studentId);
      if (entry.studentId) studentIdToCode.set(entry.studentId, entry.code);
    }

    const codes = [...codeToStudentId.entries()]
      .map(([code, studentId]) => ({ code, studentId }));
    const hashes = codes
      .map(({ code, studentId }) => ({
        hash: store.hashRegistrationCode(code, REGISTRATION_CODE_SECRET),
        studentId
      }));
    data.registrationCodes = hashes.map(({ hash, studentId }) => ({ hash, studentId, usedAt: null, usedBy: null }));
    data.registrationCodesImported = true;
    console.log(`Imported ${hashes.length} registration code(s) from Code.txt.`);
  });
}

function registrationCodeRateLimited(ip) {
  const now = Date.now();
  const attempt = registrationCodeAttempts.get(ip);
  if (!attempt || now - attempt.startedAt >= REGISTRATION_CODE_WINDOW_MS) {
    registrationCodeAttempts.set(ip, { startedAt: now, count: 0 });
    return false;
  }
  return attempt.count >= REGISTRATION_CODE_MAX_ATTEMPTS;
}

function recordRegistrationCodeFailure(ip) {
  const attempt = registrationCodeAttempts.get(ip);
  if (attempt) attempt.count += 1;
}

function maskUsername(value) {
  let username = String(value || '').trim();
  for (const word of USERNAME_PROFANITY_WORDS) {
    const escapedWord = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    username = username.replace(new RegExp(escapedWord, 'giu'), '*'.repeat(Array.from(word).length));
  }
  return username;
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
      studentId: u.studentId || '-',
      score: computeScore(data, u.username),
      answered: Object.keys(data.submissions[u.username] || {}).length
    }))
    .sort((a, b) => b.score - a.score || a.answered - b.answered);
}

function isLeaderboardLocked(data) {
  if (data.config.leaderboardForceOpen) return false;
  const unlockTime = leaderboardUnlockTime(data);
  if (!unlockTime) return true; // اگر زمانی تعیین نشده، قفل بماند
  return Date.now() < unlockTime.getTime();
}

function leaderboardUnlockTime(data) {
  if (!data.config.competitionEndTime) return null;
  const unlockTime = new Date(data.config.competitionEndTime);
  if (!data.config.competitionStartTime) return unlockTime;

  for (const user of data.users) {
    if (!user.contestEndsAt) continue;
    const userEndTime = new Date(user.contestEndsAt);
    if (Number.isFinite(userEndTime.getTime()) && userEndTime > unlockTime) {
      unlockTime.setTime(userEndTime.getTime());
    }
  }
  return unlockTime;
}

function getContestState(data, username) {
  const user = data.users.find(u => u.username === username);
  if (!user) {
    return { started: false, expired: false, startedAt: null, endsAt: null };
  }
  if (user.contestStartedAt && user.contestEndsAt) {
    const expired = Date.now() >= new Date(user.contestEndsAt).getTime();
    return { started: true, expired, startedAt: user.contestStartedAt, endsAt: user.contestEndsAt };
  }

  const { competitionStartTime, competitionEndTime } = data.config;
  if (competitionStartTime && competitionEndTime) {
    const startsAt = new Date(competitionStartTime);
    const startWindowEndsAt = new Date(competitionEndTime);
    const now = Date.now();
    const startWindow = {
      scheduled: true,
      startsAt: startsAt.toISOString(),
      startWindowEndsAt: startWindowEndsAt.toISOString()
    };
    if (now < startsAt.getTime()) {
      return {
        started: false,
        expired: false,
        canStart: false,
        ...startWindow
      };
    }
    if (now >= startWindowEndsAt.getTime()) {
      return { started: false, expired: true, canStart: false, startWindowClosed: true, ...startWindow };
    }
    return { started: false, expired: false, canStart: true, ...startWindow };
  }
  if (!user.contestStartedAt || !user.contestEndsAt) {
    return { started: false, expired: false, startedAt: null, endsAt: null };
  }
  const expired = Date.now() >= new Date(user.contestEndsAt).getTime();
  return { started: true, expired, startedAt: user.contestStartedAt, endsAt: user.contestEndsAt };
}

async function buildLeaderboardWorkbook(data, entries) {
  const wb = new ExcelJS.Workbook();
  wb.creator = data.config.title || 'مسابقه';
  const sheet = wb.addWorksheet('لیدربورد', { views: [{ rightToLeft: true }] });

  sheet.columns = [
    { header: 'رتبه', key: 'rank', width: 8 },
    { header: 'نام کاربری', key: 'username', width: 28 },
    { header: 'شماره دانشجویی', key: 'studentId', width: 20 },
    { header: 'امتیاز', key: 'score', width: 12 },
    { header: 'تعداد پاسخ‌داده', key: 'answered', width: 18 }
  ];
  sheet.getRow(1).font = { bold: true };
  sheet.getRow(1).alignment = { horizontal: 'center' };

  entries.forEach((e, i) => {
    sheet.addRow({ rank: i + 1, username: e.username, studentId: e.studentId, score: e.score, answered: e.answered });
  });

  sheet.eachRow(row => { row.alignment = { horizontal: 'center' }; });
  return wb;
}

async function buildUsersWorkbook(data) {
  const wb = new ExcelJS.Workbook();
  wb.creator = data.config.title || 'مسابقه';
  const sheet = wb.addWorksheet('شرکت‌کننده‌ها', { views: [{ rightToLeft: true }] });

  sheet.columns = [
    { header: 'نام کاربری', key: 'username', width: 28 },
    { header: 'شماره دانشجویی', key: 'studentId', width: 20 },
    { header: 'تعداد سوال جواب داده', key: 'answered', width: 24 },
    { header: 'امتیاز', key: 'score', width: 14 }
  ];
  sheet.getRow(1).font = { bold: true };
  sheet.getRow(1).alignment = { horizontal: 'center' };

  data.users.forEach(user => {
    sheet.addRow({
      username: user.username,
      studentId: user.studentId || '-',
      answered: Object.keys(data.submissions[user.username] || {}).length,
      score: computeScore(data, user.username)
    });
  });

  sheet.eachRow(row => { row.alignment = { horizontal: 'center' }; });
  return wb;
}

// ---------- ثبت‌نام / ورود ----------
app.post('/api/register', async (req, res) => {
  const { registrationCode, password } = req.body || {};
  const username = maskUsername(req.body?.username);
  const rawUsername = String(req.body?.username || '').trim();
  const normalizedCode = normalizeRegistrationCode(registrationCode);
  if (!username || !password || username.length < 3 || password.length < 4) {
    return res.status(400).json({ error: 'نام کاربری حداقل ۳ کاراکتر و رمز عبور حداقل ۴ کاراکتر باشد.' });
  }
  if (!/^\d{5}$/.test(normalizedCode)) {
    return res.status(400).json({ error: 'کد ثبت‌نام باید دقیقاً ۵ رقم باشد.' });
  }
  if (registrationCodeRateLimited(req.ip)) {
    return res.status(429).json({ error: 'تعداد تلاش‌ها زیاد است. ۱۵ دقیقه دیگر دوباره تلاش کنید.' });
  }
  const codeHash = store.hashRegistrationCode(normalizedCode, REGISTRATION_CODE_SECRET);
  const currentData = store.read();
  if (currentData.users.find(u => maskUsername(u.username).toLowerCase() === username.toLowerCase() || u.username.toLowerCase() === rawUsername.toLowerCase())) {
    return res.status(400).json({ error: 'این نام کاربری قبلاً ثبت شده است.' });
  }
  const registrationCodes = Array.isArray(currentData.registrationCodes) ? currentData.registrationCodes : [];
  const availableCode = matchingRegistrationCode(registrationCodes, codeHash);
  if (!availableCode || availableCode.usedAt || !availableCode.studentId) {
    recordRegistrationCodeFailure(req.ip);
    return res.status(400).json({ error: 'کد ثبت‌نام نامعتبر، مصرف‌شده یا هنوز به شماره دانشجویی متصل نشده است.' });
  }
  const studentId = availableCode.studentId;
  if (currentData.users.some(user => user.studentId === studentId)) {
    return res.status(400).json({ error: 'این شماره دانشجویی قبلاً برای یک حساب ثبت شده است.' });
  }
  const { salt, hash } = store.hashPassword(password);
  const result = await store.mutate(data => {
    if (data.users.find(u => maskUsername(u.username).toLowerCase() === username.toLowerCase() || u.username.toLowerCase() === rawUsername.toLowerCase())) {
      return { error: 'این نام کاربری قبلاً ثبت شده است.' };
    }
    const codes = Array.isArray(data.registrationCodes) ? data.registrationCodes : [];
    const code = matchingRegistrationCode(codes, codeHash);
    if (!code || code.usedAt || code.studentId !== studentId) {
      return { error: 'کد ثبت‌نام نامعتبر، مصرف‌شده یا هنوز به شماره دانشجویی متصل نشده است.', invalidCode: true };
    }
    if (data.users.some(user => user.studentId === studentId)) {
      return { error: 'این شماره دانشجویی قبلاً برای یک حساب ثبت شده است.' };
    }

    const createdAt = new Date().toISOString();
    data.users.push({ id: store.newId('u'), username, studentId, passwordHash: hash, salt, createdAt });
    data.submissions[username] = {};
    code.usedAt = createdAt;
    code.usedBy = username;
    return { username };
  });
  if (result.error) {
    if (result.invalidCode) recordRegistrationCodeFailure(req.ip);
    return res.status(400).json({ error: result.error });
  }
  registrationCodeAttempts.delete(req.ip);
  req.session.username = username;
  res.json({ ok: true, username });
});

app.post('/api/login', (req, res) => {
  const { password } = req.body || {};
  const rawUsername = String(req.body?.username || '').trim();
  const username = maskUsername(req.body?.username);
  const data = store.read();
  const user = data.users.find(u => u.username.toLowerCase() === username.toLowerCase() || u.username.toLowerCase() === rawUsername.toLowerCase());
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
app.get('/api/questions', requireAuth, async (req, res) => {
  let data = store.read();
  const mySubs = data.submissions[req.session.username] || {};
  const progress = {
    answered: Object.keys(mySubs).length,
    total: data.questions.length
  };
  const contest = getContestState(data, req.session.username);
  if (!contest.started || contest.expired) {
    return res.json({ title: data.config.title, questions: [], contest, progress });
  }
  const questionOrder = await ensureQuestionOrder(req.session.username);
  data = store.read();
  const orderById = new Map(questionOrder.map((id, index) => [id, index]));
  const qs = [...data.questions]
    .filter(q => ENABLE_CODE_QUESTIONS || q.type !== 'code')
    .sort((a, b) => orderById.get(a.id) - orderById.get(b.id))
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
  if (existing.scheduled && !existing.canStart && !existing.started) {
    const error = existing.startWindowClosed
      ? 'مهلت شروع مسابقه به پایان رسیده است.'
      : 'مسابقه هنوز به زمان شروع نرسیده است.';
    return res.status(403).json({ error });
  }
  if (existing.expired) {
    return res.status(403).json({ error: 'زمان مسابقه تمام شده است.' });
  }
  if (existing.started) return res.json({ ok: true, contest: existing });
  const duration = Number(data.config.contestDurationMinutes) || 60;
  const contest = await store.mutate(d => {
    const user = d.users.find(u => u.username === req.session.username);
    const currentContest = getContestState(d, req.session.username);
    if (currentContest.started) return { contest: currentContest };
    if (currentContest.scheduled && !currentContest.canStart) {
      return {
        error: currentContest.startWindowClosed
          ? 'مهلت شروع مسابقه به پایان رسیده است.'
          : 'مسابقه هنوز به زمان شروع نرسیده است.'
      };
    }

    const startedAt = new Date();
    const endsAt = new Date(startedAt.getTime() + duration * 60 * 1000);
    user.contestStartedAt = startedAt.toISOString();
    user.contestEndsAt = endsAt.toISOString();
    user.questionOrder = createQuestionOrder(
      d.questions.map(question => question.id),
      d.users,
      user.username
    );
    return {
      contest: {
        started: true,
        expired: false,
        startedAt: startedAt.toISOString(),
        endsAt: endsAt.toISOString()
      }
    };
  });
  if (contest.error) return res.status(403).json({ error: contest.error });
  res.json({ ok: true, contest: contest.contest });
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
  if (q.type === 'code' && !ENABLE_CODE_QUESTIONS) {
    return res.status(403).json({ error: 'سوالات کدنویسی غیرفعال هستند.' });
  }

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

  let submitError;
  let submitStatus = 403;
  await store.mutate(d => {
    const currentContest = getContestState(d, username);
    if (!currentContest.started || currentContest.expired) {
      submitError = 'زمان مسابقه هنگام ثبت پاسخ به پایان رسید؛ پاسخ ثبت نشد.';
      return;
    }
    if (!d.submissions[username]) d.submissions[username] = {};
    if (d.submissions[username][questionId]) {
      submitError = 'قبلاً به این سوال پاسخ داده‌اید.';
      submitStatus = 400;
      return;
    }
    d.submissions[username][questionId] = result;
  });

  if (submitError) return res.status(submitStatus).json({ error: submitError });
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
    return res.json({ locked: true, endTime: leaderboardUnlockTime(data)?.toISOString() || null });
  }
  res.json({ locked: false, endTime: leaderboardUnlockTime(data)?.toISOString() || null, entries: leaderboardData(data) });
});

// ---------- Admin ----------
app.post('/api/admin/login', (req, res) => {
  const clientKey = req.ip;
  const now = Date.now();
  const attempt = adminLoginAttempts.get(clientKey);

  if (attempt && now - attempt.firstAttemptAt < ADMIN_LOGIN_WINDOW_MS && attempt.failures >= ADMIN_MAX_LOGIN_ATTEMPTS) {
    const retryAfter = Math.ceil((ADMIN_LOGIN_WINDOW_MS - (now - attempt.firstAttemptAt)) / 1000);
    res.set('Retry-After', String(retryAfter));
    return res.status(429).json({ error: 'تلاش‌های ناموفق زیاد است. چند دقیقه بعد دوباره امتحان کنید.' });
  }

  if (!attempt || now - attempt.firstAttemptAt >= ADMIN_LOGIN_WINDOW_MS) {
    adminLoginAttempts.set(clientKey, { failures: 0, firstAttemptAt: now });
  }

  const { password } = req.body || {};
  if (password !== ADMIN_PASSWORD) {
    const current = adminLoginAttempts.get(clientKey);
    current.failures += 1;
    return res.status(401).json({ error: 'رمز ادمین اشتباه است.' });
  }

  adminLoginAttempts.delete(clientKey);
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
  const validationError = validateQuestion(q);
  if (validationError) return res.status(400).json({ error: validationError });
  const newQ = { ...q, id: store.newId('q'), order: Date.now() };
  await store.mutate(d => { d.questions.push(newQ); });
  res.json({ ok: true, question: newQ });
});

function validateQuestion(q) {
  const difficulties = ['easy', 'medium', 'hard'];
  if (!q.type || !q.title || !q.prompt || !q.points) {
    return 'فیلدهای type، title، prompt و points الزامی است.';
  }
  if (q.type === 'code' && !ENABLE_CODE_QUESTIONS) {
    return 'سوالات کدنویسی فعلاً غیرفعال هستند.';
  }
  if (!difficulties.includes(q.difficulty)) {
    return 'سختی سوال باید آسان، متوسط یا سخت باشد.';
  }
  if (q.type === 'mcq' && (!Array.isArray(q.options) || q.options.length < 2 || !Number.isInteger(q.correctIndex) || q.correctIndex < 0 || q.correctIndex >= q.options.length)) {
    return 'برای سوال تستی، گزینه‌ها و شماره گزینه درست معتبر الزامی است.';
  }
  if (q.type === 'code' && (!q.language || !Array.isArray(q.testCases) || q.testCases.length === 0 || q.testCases.some(tc => !tc.expectedOutput || !tc.expectedOutput.trim()))) {
    return 'برای سوال کدی، language و حداقل یک testCase با expectedOutput الزامی است.';
  }
  return null;
}

app.put('/api/admin/questions/:id', requireAdmin, async (req, res) => {
  const validationError = validateQuestion(req.body || {});
  if (validationError) return res.status(400).json({ error: validationError });
  let updatedQuestion;
  await store.mutate(d => {
    const index = d.questions.findIndex(q => q.id === req.params.id);
    if (index === -1) return;
    updatedQuestion = { ...req.body, id: req.params.id, order: d.questions[index].order };
    d.questions[index] = updatedQuestion;
  });
  if (!updatedQuestion) return res.status(404).json({ error: 'سوال پیدا نشد.' });
  res.json({ ok: true, question: updatedQuestion });
});

app.delete('/api/admin/questions/:id', requireAdmin, async (req, res) => {
  await store.mutate(d => {
    d.questions = d.questions.filter(q => q.id !== req.params.id);
    for (const u in d.submissions) delete d.submissions[u][req.params.id];
  });
  res.json({ ok: true });
});

app.put('/api/admin/config', requireAdmin, async (req, res) => {
  const { competitionStartTime, competitionEndTime, leaderboardForceOpen, contestDurationMinutes, title } = req.body || {};
  const startTime = competitionStartTime || null;
  const endTime = competitionEndTime || null;
  if (startTime && !Number.isFinite(Date.parse(startTime))) {
    return res.status(400).json({ error: 'زمان شروع مسابقه معتبر نیست.' });
  }
  if (endTime && !Number.isFinite(Date.parse(endTime))) {
    return res.status(400).json({ error: 'زمان پایان مسابقه معتبر نیست.' });
  }
  if (startTime && !endTime) {
    return res.status(400).json({ error: 'برای تنظیم شروع زمان‌بندی‌شده، زمان پایان را هم مشخص کنید.' });
  }
  if (startTime && endTime && Date.parse(endTime) <= Date.parse(startTime)) {
    return res.status(400).json({ error: 'زمان پایان باید بعد از زمان شروع باشد.' });
  }
  if (contestDurationMinutes !== undefined && (!Number.isInteger(Number(contestDurationMinutes)) || Number(contestDurationMinutes) < 1)) {
    return res.status(400).json({ error: 'مدت مسابقه باید حداقل ۱ دقیقه باشد.' });
  }
  await store.mutate(d => {
    if (competitionStartTime !== undefined) d.config.competitionStartTime = startTime;
    if (competitionEndTime !== undefined) d.config.competitionEndTime = endTime;
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

app.get('/api/admin/users/export', requireAdmin, async (req, res) => {
  const data = store.read();
  const wb = await buildUsersWorkbook(data);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="participants.xlsx"');
  await wb.xlsx.write(res);
  res.end();
});

app.get('/api/admin/registration-codes', requireAdmin, (req, res) => {
  const data = store.read();
  const codes = Array.isArray(data.registrationCodes) ? data.registrationCodes : [];
  res.json({
    availableCount: codes.filter(code => !code.usedAt).length,
    usedCount: codes.filter(code => code.usedAt).length,
    unmappedCount: codes.filter(code => !code.studentId).length
  });
});

app.post('/api/admin/registration-codes', requireAdmin, async (req, res) => {
  const rawEntries = Array.isArray(req.body?.registrationCodes) ? req.body.registrationCodes : [];
  const entries = rawEntries.map(entry => ({
    code: normalizeRegistrationCode(entry?.code),
    studentId: normalizeStudentId(entry?.studentId)
  }));
  if (!entries.length || entries.some(entry =>
    !/^\d{5}$/.test(entry.code) || !/^\d{6,20}$/.test(entry.studentId)
  )) {
    return res.status(400).json({ error: 'هر خط باید شامل کد ۵ رقمی و شماره دانشجویی ۶ تا ۲۰ رقمی باشد.' });
  }
  const entriesByCode = new Map();
  const codesByStudentId = new Map();
  for (const entry of entries) {
    const previousStudentId = entriesByCode.get(entry.code);
    if (previousStudentId && previousStudentId !== entry.studentId) {
      return res.status(400).json({ error: 'برای یک کد، چند شماره دانشجویی متفاوت وارد شده است.' });
    }
    const previousCode = codesByStudentId.get(entry.studentId);
    if (previousCode && previousCode !== entry.code) {
      return res.status(400).json({ error: 'هر شماره دانشجویی باید فقط به یک کد متصل باشد.' });
    }
    entriesByCode.set(entry.code, entry.studentId);
    codesByStudentId.set(entry.studentId, entry.code);
  }
  const mappedEntries = [...entriesByCode.entries()].map(([code, studentId]) => ({
    hash: store.hashRegistrationCode(code, REGISTRATION_CODE_SECRET),
    studentId
  }));
  const result = await store.mutate(data => {
    if (!Array.isArray(data.registrationCodes)) data.registrationCodes = [];
    const codes = data.registrationCodes;
    const users = data.users;
    const plans = mappedEntries.map(entry => {
      const code = codes.find(item => item.hash === entry.hash);
      const linkedUser = code?.usedBy ? users.find(user => user.username === code.usedBy) : null;
      return { ...entry, code, linkedUser };
    });

    for (const plan of plans) {
      if (plan.code?.studentId && plan.code.studentId !== plan.studentId) {
        return { error: 'این کد قبلاً به شماره دانشجویی دیگری متصل شده است.' };
      }
      if (plan.linkedUser?.studentId && plan.linkedUser.studentId !== plan.studentId) {
        return { error: 'شماره دانشجویی این حساب قبلاً ثبت شده و با مقدار واردشده متفاوت است.' };
      }
      if (codes.some(code => code.hash !== plan.hash && code.studentId === plan.studentId)) {
        return { error: 'این شماره دانشجویی قبلاً به کد دیگری متصل شده است.' };
      }
      if (users.some(user => user.studentId === plan.studentId && user !== plan.linkedUser)) {
        return { error: 'این شماره دانشجویی قبلاً برای حساب دیگری ثبت شده است.' };
      }
    }

    let addedCount = 0;
    let mappedCount = 0;
    let updatedUserCount = 0;
    for (const plan of plans) {
      if (!plan.code) {
        codes.push({ hash: plan.hash, studentId: plan.studentId, usedAt: null, usedBy: null });
        addedCount += 1;
      } else if (!plan.code.studentId) {
        plan.code.studentId = plan.studentId;
        mappedCount += 1;
      }
      if (plan.linkedUser && !plan.linkedUser.studentId) {
        plan.linkedUser.studentId = plan.studentId;
        updatedUserCount += 1;
      }
    }
    return { addedCount, mappedCount, updatedUserCount };
  });
  if (result.error) return res.status(400).json({ error: result.error });
  const codes = store.read().registrationCodes;
  res.json({
    ok: true,
    ...result,
    availableCount: codes.filter(code => !code.usedAt).length,
    usedCount: codes.filter(code => code.usedAt).length,
    unmappedCount: codes.filter(code => !code.studentId).length
  });
});

app.delete('/api/admin/registration-codes', requireAdmin, async (req, res) => {
  const rawCodes = Array.isArray(req.body?.registrationCodes) ? req.body.registrationCodes : [];
  const registrationCodes = [...new Set(rawCodes.map(normalizeRegistrationCode).filter(Boolean))];
  if (!registrationCodes.length || registrationCodes.some(code => !/^\d{5}$/.test(code))) {
    return res.status(400).json({ error: 'کدها باید هرکدام دقیقاً ۵ رقم باشند.' });
  }
  const hashes = new Set(registrationCodes.map(code => store.hashRegistrationCode(code, REGISTRATION_CODE_SECRET)));
  let revokedCount = 0;
  await store.mutate(data => {
    const codes = Array.isArray(data.registrationCodes) ? data.registrationCodes : [];
    data.registrationCodes = codes.filter(code => {
      if (!code.usedAt && hashes.has(code.hash)) {
        revokedCount += 1;
        return false;
      }
      return true;
    });
  });
  const codes = store.read().registrationCodes;
  res.json({
    ok: true,
    revokedCount,
    availableCount: codes.filter(code => !code.usedAt).length,
    usedCount: codes.filter(code => code.usedAt).length
  });
});

importRegistrationCodes().then(() => {
  app.listen(PORT, () => {
    console.log(`✅ Server is active in port ${PORT} : http://localhost:${PORT}`);
    console.log(`🔑 Admin Password: ${ADMIN_PASSWORD}${process.env.ADMIN_PASSWORD ? '' : 'Change the default password!'}`);
  });
}).catch(error => {
  console.error(`Failed to initialize registration codes: ${error.message}`);
  process.exitCode = 1;
});
