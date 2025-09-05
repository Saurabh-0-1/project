// server.js
const express = require('express');
const fs = require('fs');
const path = require('path');
const bodyParser = require('body-parser');
const multer = require('multer');

const app = express();
const PORT = 3000;

// ensure data folder exists
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

// ensure files exist
const ensureFile = (p, defaultContent) => {
  if (!fs.existsSync(p)) fs.writeFileSync(p, defaultContent);
};
ensureFile(path.join(dataDir, 'reports.json'), '[]');
ensureFile(path.join(dataDir, 'users.json'), '[]');
ensureFile(path.join(dataDir, 'verifications.json'), '[]');

// static public
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

// serve uploads
const uploadDir = path.join(dataDir, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
app.use('/uploads', express.static(uploadDir));

// multer setup
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.jpg';
    const name = Date.now() + '-' + Math.round(Math.random() * 1e9) + ext;
    cb(null, name);
  }
});
const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) return cb(new Error('Only images allowed'), false);
    cb(null, true);
  },
  limits: { fileSize: 5 * 1024 * 1024 } // 5MB
});

// helpers
const readJson = (p) => {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return []; }
};
const writeJson = (p, obj) => fs.writeFileSync(p, JSON.stringify(obj, null, 2));

// --- Reports API ---
app.get('/api/reports', (req, res) => {
  res.json(readJson(path.join(dataDir, 'reports.json')));
});

app.post('/api/reports', (req, res) => {
  try {
    const arr = readJson(path.join(dataDir, 'reports.json'));
    const rec = req.body;
    rec.id = Date.now();
    rec.timestamp = new Date().toISOString();
    arr.push(rec);
    writeJson(path.join(dataDir, 'reports.json'), arr);
    res.json({ status: 'ok', rec });
  } catch (e) {
    res.status(500).json({ status: 'error' });
  }
});

// --- Users API (leaderboard persistence) ---
app.get('/api/users', (req, res) => {
  res.json(readJson(path.join(dataDir, 'users.json')));
});

app.post('/api/users', (req, res) => {
  try {
    const u = req.body; // { name, email?, points, co2 }
    const file = path.join(dataDir, 'users.json');
    const arr = readJson(file);
    const idx = arr.findIndex(x => x.name === u.name);
    if (idx >= 0) {
      arr[idx] = Object.assign(arr[idx], u);
    } else {
      arr.push(u);
    }
    writeJson(file, arr);
    res.json({ status: 'ok' });
  } catch (e) {
    res.status(500).json({ status: 'error' });
  }
});

// --- Verification (image) API ---
app.post('/api/verify', upload.single('image'), (req, res) => {
  try {
    const user = req.body.user;
    const action = req.body.action;
    if (!user || !action || !req.file) return res.status(400).json({ status: 'error', message: 'Missing fields' });

    const verFile = path.join(dataDir, 'verifications.json');
    const arr = readJson(verFile);

    // simple auto-accept heuristic: accept if image size > 2KB
    const accepted = req.file.size > 2048;

    const record = {
      id: Date.now(),
      user,
      action,
      filename: req.file.filename,
      originalName: req.file.originalname,
      status: accepted ? 'accepted' : 'pending',
      timestamp: new Date().toISOString()
    };

    arr.push(record);
    writeJson(verFile, arr);

    // mapping for award amounts
    const mapping = { plant: { points: 20, co2: 20 }, clean: { points: 10, co2: 10 }, awareness: { points: 5, co2: 5 } };

    // if accepted immediately, credit to user in users.json
    if (accepted) {
      const award = mapping[action.toLowerCase()] || { points: 0, co2: 0 };
      // upsert user
      const usersFile = path.join(dataDir, 'users.json');
      const users = readJson(usersFile);
      const idx = users.findIndex(x => x.name === user);
      if (idx >= 0) {
        users[idx].points = (users[idx].points || 0) + award.points;
        users[idx].co2 = (users[idx].co2 || 0) + award.co2;
      } else {
        users.push({ name: user, points: award.points, co2: award.co2 });
      }
      writeJson(usersFile, users);
      return res.json({ status: 'accepted', id: record.id, award });
    }

    // pending
    res.json({ status: 'pending', id: record.id, filename: record.filename });
  } catch (err) {
    console.error(err);
    res.status(500).json({ status: 'error' });
  }
});

// list verifications
app.get('/api/verifications', (req, res) => {
  res.json(readJson(path.join(dataDir, 'verifications.json')));
});

// admin approve
app.post('/api/verifications/approve', (req, res) => {
  try {
    const { id } = req.body;
    const file = path.join(dataDir, 'verifications.json');
    const arr = readJson(file);
    const idx = arr.findIndex(x => x.id == id);
    if (idx === -1) return res.status(404).json({ status: 'error', message: 'Not found' });
    // set accepted
    arr[idx].status = 'accepted';
    writeJson(file, arr);

    // award user
    const action = arr[idx].action;
    const mapping = { plant: { points: 20, co2: 20 }, clean: { points: 10, co2: 10 }, awareness: { points: 5, co2: 5 } };
    const award = mapping[action.toLowerCase()] || { points: 0, co2: 0 };

    const usersFile = path.join(dataDir, 'users.json');
    const users = readJson(usersFile);
    const userName = arr[idx].user;
    const uidx = users.findIndex(x => x.name === userName);
    if (uidx >= 0) {
      users[uidx].points = (users[uidx].points || 0) + award.points;
      users[uidx].co2 = (users[uidx].co2 || 0) + award.co2;
    } else {
      users.push({ name: userName, points: award.points, co2: award.co2 });
    }
    writeJson(usersFile, users);

    res.json({ status: 'ok', award });
  } catch (err) {
    console.error(err);
    res.status(500).json({ status: 'error' });
  }
});

// start
app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});


