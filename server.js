require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const MONGODB_URI = process.env.MONGODB_URI;

app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// --- MONGODB SXEMALARI ---

const QuestionSchema = new mongoose.Schema(
  {
    text: { type: String, required: true },
    options: { type: [String], required: true },
    correctIndex: { type: Number, required: true }
  },
  { _id: false }
);

const TestSchema = new mongoose.Schema({
  code: { type: String, required: true, unique: true, index: true },
  title: { type: String, required: true },
  timeLimit: { type: Number, default: 0 }, // daqiqada (0 = vaqtsiz)
  shuffleQuestions: { type: Boolean, default: false },
  shuffleOptions: { type: Boolean, default: false },
  questions: { type: [QuestionSchema], required: true },
  createdAt: { type: Date, default: Date.now }
});

const ResultSchema = new mongoose.Schema({
  testCode: { type: String, required: true, index: true },
  studentName: { type: String, required: true },
  correctCount: { type: Number, required: true },
  total: { type: Number, required: true },
  percent: { type: Number, required: true },
  timeSpentSec: { type: Number, default: 0 },
  timedOut: { type: Boolean, default: false },
  submittedAt: { type: Date, default: Date.now }
});

const Test = mongoose.model('Test', TestSchema);
const Result = mongoose.model('Result', ResultSchema);

// --- YORDAMCHI FUNKSIYALAR ---

function shuffleArray(arr) {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function requireAdmin(req, res, next) {
  const pass = req.headers['x-admin-password'];
  if (pass !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: "Parol noto'g'ri yoki ruxsat yo'q" });
  }
  next();
}

// --- SAHIFALAR ---

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// --- ADMIN API ---

app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  if (password === ADMIN_PASSWORD) {
    return res.json({ ok: true });
  }
  return res.status(401).json({ error: "Parol noto'g'ri" });
});

app.get('/api/admin/tests', requireAdmin, async (req, res) => {
  try {
    const tests = await Test.find().sort({ createdAt: -1 }).lean();
    const counts = await Result.aggregate([
      { $group: { _id: '$testCode', count: { $sum: 1 } } }
    ]);

    const countMap = new Map(counts.map((c) => [c._id, c.count]));

    const list = tests.map((t) => ({
      code: t.code,
      title: t.title,
      timeLimit: t.timeLimit || 0,
      shuffleQuestions: Boolean(t.shuffleQuestions),
      shuffleOptions: Boolean(t.shuffleOptions),
      questionCount: t.questions.length,
      resultsCount: countMap.get(t.code) || 0,
      createdAt: t.createdAt
    }));

    res.json(list);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Testlarni yuklashda server xatoligi' });
  }
});

app.post('/api/admin/tests', requireAdmin, async (req, res) => {
  try {
    const { code, title, timeLimit, shuffleQuestions, shuffleOptions, questions } = req.body;

    if (!/^\d{6}$/.test(String(code || ''))) {
      return res.status(400).json({ error: "Test kodi aniq 6 xonali son bo'lishi kerak" });
    }

    if (!title || !title.trim()) {
      return res.status(400).json({ error: 'Test nomini kiriting' });
    }

    const parsedTime = Number(timeLimit) || 0;
    if (parsedTime < 0 || parsedTime > 300) {
      return res.status(400).json({ error: "Vaqt chegarasi 0 dan 300 daqiqagacha bo'lishi kerak" });
    }

    if (!Array.isArray(questions) || questions.length === 0) {
      return res.status(400).json({ error: 'Kamida 1 ta savol kiritilishi kerak' });
    }

    for (let i = 0; i < questions.length; i++) {
      const q = questions[i];
      if (!q.text || !Array.isArray(q.options) || q.options.length < 2) {
        return res.status(400).json({ error: `${i + 1}-savol to'liq emas (kamida 2 ta variant kerak)` });
      }
      if (typeof q.correctIndex !== 'number' || q.correctIndex < 0 || q.correctIndex >= q.options.length) {
        return res.status(400).json({ error: `${i + 1}-savolning to'g'ri javobi belgilanmagan` });
      }
    }

    const exists = await Test.exists({ code: String(code) });
    if (exists) {
      return res.status(409).json({ error: `${code} kodi allaqachon band. Boshqa kod tanlang.` });
    }

    await Test.create({
      code: String(code),
      title: title.trim(),
      timeLimit: Math.floor(parsedTime),
      shuffleQuestions: Boolean(shuffleQuestions),
      shuffleOptions: Boolean(shuffleOptions),
      questions: questions.map((q) => ({
        text: q.text.trim(),
        options: q.options.map((o) => o.trim()),
        correctIndex: q.correctIndex
      }))
    });

    res.json({ ok: true, code: String(code) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Testni saqlashda xatolik yuz berdi' });
  }
});

app.delete('/api/admin/tests/:code', requireAdmin, async (req, res) => {
  try {
    const { code } = req.params;
    await Test.deleteOne({ code });
    await Result.deleteMany({ testCode: code });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "O'chirishda xatolik" });
  }
});

app.get('/api/admin/results/:code', requireAdmin, async (req, res) => {
  try {
    const { code } = req.params;
    const test = await Test.findOne({ code }).lean();
    if (!test) {
      return res.status(404).json({ error: 'Test topilmadi' });
    }

    const results = await Result.find({ testCode: code }).sort({ submittedAt: -1 }).lean();

    res.json({
      title: test.title,
      code: test.code,
      results
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Natijalarni olishda xatolik' });
  }
});

// --- O'QUVCHI API ---

app.get('/api/tests/:code', async (req, res) => {
  try {
    const { code } = req.params;
    if (!/^\d{6}$/.test(code)) {
      return res.status(400).json({ error: "Kod 6 xonali raqam bo'lishi kerak" });
    }

    const test = await Test.findOne({ code }).lean();
    if (!test) {
      return res.status(404).json({ error: 'Bunday kodli test topilmadi' });
    }

    // Har bir savol va variant o'zining asl indeksini (qIndex, oIndex) saqlab qoladi
    let preparedQuestions = test.questions.map((q, qIndex) => {
      let opts = q.options.map((text, oIndex) => ({ oIndex, text }));
      if (test.shuffleOptions) {
        opts = shuffleArray(opts);
      }
      return {
        qIndex,
        text: q.text,
        options: opts
      };
    });

    if (test.shuffleQuestions) {
      preparedQuestions = shuffleArray(preparedQuestions);
    }

    res.json({
      code: test.code,
      title: test.title,
      timeLimit: test.timeLimit || 0,
      shuffleQuestions: Boolean(test.shuffleQuestions),
      shuffleOptions: Boolean(test.shuffleOptions),
      questions: preparedQuestions
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Testni yuklashda xatolik' });
  }
});

app.post('/api/tests/:code/submit', async (req, res) => {
  try {
    const { code } = req.params;
    const { studentName, answers, timeSpentSec, timedOut } = req.body;

    const test = await Test.findOne({ code }).lean();
    if (!test) {
      return res.status(404).json({ error: 'Test topilmadi' });
    }

    const safeName = (studentName || "Noma'lum o'quvchi").trim().slice(0, 60);
    const submittedList = Array.isArray(answers) ? answers : [];
    const total = test.questions.length;

    // Har bir asl savol indeksi bo'yicha javobni xavfsiz yig'ish
    const submittedMap = new Map();
    const reviewOrder = [];

    for (const item of submittedList) {
      if (
        item &&
        typeof item.qIndex === 'number' &&
        item.qIndex >= 0 &&
        item.qIndex < total &&
        !submittedMap.has(item.qIndex)
      ) {
        submittedMap.set(item.qIndex, item);
        reviewOrder.push(item.qIndex);
      }
    }

    // Agar biron savol ro'yxatda qolib ketgan bo'lsa qo'shib qo'yish
    for (let i = 0; i < total; i++) {
      if (!submittedMap.has(i)) {
        reviewOrder.push(i);
      }
    }

    let correctCount = 0;

    const details = reviewOrder.map((qIndex) => {
      const q = test.questions[qIndex];
      const entry = submittedMap.get(qIndex);
      const selectedOIndex =
        entry && typeof entry.selectedOIndex === 'number' ? entry.selectedOIndex : -1;

      const isCorrect = selectedOIndex === q.correctIndex;
      if (isCorrect) correctCount++;

      // Variantlarni o'quvchi ko'rgan tartibda ko'rsatish
      let optionOrder = q.options.map((_, idx) => idx);
      if (
        entry &&
        Array.isArray(entry.optionOrder) &&
        entry.optionOrder.length === q.options.length &&
        new Set(entry.optionOrder).size === q.options.length &&
        entry.optionOrder.every((idx) => Number.isInteger(idx) && idx >= 0 && idx < q.options.length)
      ) {
        optionOrder = entry.optionOrder;
      }

      const displayOptions = optionOrder.map((oIdx) => ({
        oIndex: oIdx,
        text: q.options[oIdx]
      }));

      return {
        text: q.text,
        options: displayOptions,
        selectedOIndex,
        correctOIndex: q.correctIndex,
        isCorrect
      };
    });

    const percent = Math.round((correctCount / total) * 100);
    const safeTimeSec = Math.max(0, Math.floor(Number(timeSpentSec) || 0));

    await Result.create({
      testCode: code,
      studentName: safeName,
      correctCount,
      total,
      percent,
      timeSpentSec: safeTimeSec,
      timedOut: Boolean(timedOut)
    });

    res.json({
      studentName: safeName,
      correctCount,
      total,
      percent,
      timeSpentSec: safeTimeSec,
      timedOut: Boolean(timedOut),
      details
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Natijani saqlashda xatolik' });
  }
});

// --- SERVERNI ISHGA TUSHIRISH ---

async function start() {
  if (!MONGODB_URI) {
    console.error('XATOLIK: MONGODB_URI environment variable kiritilmagan!');
    process.exit(1);
  }

  try {
    await mongoose.connect(MONGODB_URI);
    console.log('MongoDB Atlas bilan ulanish muvaffaqiyatli.');
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`Server ishga tushdi: http://localhost:${PORT}`);
    });
  } catch (err) {
    console.error('MongoDB ulanish xatoligi:', err.message);
    process.exit(1);
  }
}

start();
