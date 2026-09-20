//for more info go to README

const PAIZA_BASE = 'https://api.paiza.io';
const API_KEY = 'guest';


const LANGUAGE_MAP = {
  c: 'c',
  cpp: 'cpp',
  'c++': 'cpp',
  java: 'java',
  python: 'python3',
  python3: 'python3',
  javascript: 'javascript',
  js: 'javascript',
  csharp: 'csharp',
  go: 'go',
  ruby: 'ruby',
  php: 'php',
  swift: 'swift',
  scala: 'scala',
  haskell: 'haskell',
  perl: 'perl',
  bash: 'bash'
};

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function runCode({ language, code, stdin }) {
  const lang = LANGUAGE_MAP[(language || '').toLowerCase()];
  if (!lang) {
    return { ok: false, error: `زبان "${language}" پشتیبانی نمی‌شود.` };
  }

  try {

    const createRes = await fetch(`${PAIZA_BASE}/runners/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        api_key: API_KEY,
        source_code: code,
        language: lang,
        input: stdin || ''
      })
    });

    if (!createRes.ok) {
      const text = await createRes.text().catch(() => '');
      return { ok: false, error: `سرویس اجرای کد خطا داد (${createRes.status}): ${text.slice(0, 300)}` };
    }

    const createData = await createRes.json();
    if (createData.error) {
      return { ok: false, error: 'خطا از سرویس اجرای کد: ' + createData.error };
    }
    const id = createData.id;

    // (Poll status)
    let status = createData.status;
    for (let i = 0; i < 15 && status !== 'completed'; i++) {
      await sleep(1000);
      const statusRes = await fetch(`${PAIZA_BASE}/runners/get_status?id=${encodeURIComponent(id)}&api_key=${API_KEY}`);
      const statusData = await statusRes.json();
      status = statusData.status;
    }
    if (status !== 'completed') {
      return { ok: false, error: 'اجرای کد بیش از حد طول کشید (timeout).' };
    }

    // (Get Details)
    const detailsRes = await fetch(`${PAIZA_BASE}/runners/get_details?id=${encodeURIComponent(id)}&api_key=${API_KEY}`);
    const d = await detailsRes.json();

    if (d.build_result && d.build_result !== 'success') {
      return {
        ok: true,
        stdout: '',
        stderr: d.build_stderr || 'خطای کامپایل',
        compileError: true
      };
    }

    return {
      ok: true,
      stdout: d.stdout || '',
      stderr: d.stderr || '',
      exitCode: d.exit_code,
      compileError: false
    };
  } catch (e) {
    return { ok: false, error: 'اتصال به سرویس اجرای کد برقرار نشد: ' + e.message };
  }
}

function normalizeOutput(s) {
  return (s || '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map(line => line.trimEnd())
    .join('\n')
    .trim();
}

module.exports = { runCode, normalizeOutput, LANGUAGE_MAP };
