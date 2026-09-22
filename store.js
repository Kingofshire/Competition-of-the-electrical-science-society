
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_FILE = path.join(__dirname, 'data.json');

function defaultData() {
  return {
    users: [],       // { id, username, studentId, passwordHash, salt, createdAt }
    allowedStudentIds: [],
    questions: [],    // { id, type: 'mcq'|'code', title, prompt, points,
                      //   options?, correctIndex?,  (mcq)
                      //   language?, starterCode?, stdin?, expectedOutput?  (code)
                      //   order }
    submissions: {},  // { [username]: { [questionId]: { answer, correct, points, output, error, submittedAt } } }
    config: {
      competitionEndTime: null, // ISO string; leaderboard locked until this time
      leaderboardForceOpen: false,
      contestDurationMinutes: 60,
      title: 'مسابقه برنامه‌نویسی'
    }
  };
}

let cache = null;
let writeQueue = Promise.resolve();

function load() {
  if (cache) return cache;
  if (!fs.existsSync(DATA_FILE)) {
    cache = defaultData();
    persist();
  } else {
    try {
      cache = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    } catch (e) {
      console.error('خطا در خواندن data.json، با داده خالی شروع می‌کنیم:', e.message);
      cache = defaultData();
    }
  }
  return cache;
}

function persist() {

  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cache, null, 2), 'utf8');
  fs.renameSync(tmp, DATA_FILE);
}


function mutate(fn) {
  writeQueue = writeQueue.then(async () => {
    load();
    const result = await fn(cache);
    persist();
    return result;
  });
  return writeQueue;
}

function read() {
  return load();
}

function hashPassword(password, salt) {
  salt = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}

function verifyPassword(password, salt, hash) {
  const check = crypto.scryptSync(password, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(check), Buffer.from(hash));
}

function newId(prefix) {
  return prefix + '_' + crypto.randomBytes(6).toString('hex');
}

module.exports = { read, mutate, hashPassword, verifyPassword, newId };
