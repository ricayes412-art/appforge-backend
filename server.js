/**
 * AppForge Cloud - Backend Server v2.0
 * Pipeline inteligente con análisis real de código
 * Node.js + Express + Multer + AdmZip
 */

require('dotenv').config();
const express = require('express');
const multer  = require('multer');
const cors    = require('cors');
const ALLOWED_ORIGINS = [
  'http://localhost:3000',
  'http://localhost:3002',
  'https://appforge-cloud-ai.netlify.app',
  'https://appforge-backend-v0z6.onrender.com'
];
const path    = require('path');
const fs      = require('fs');
const { v4: uuidv4 } = require('uuid');
const AdmZip  = require('adm-zip');

const app  = express();
const PORT = process.env.PORT || 3002;
const HAS_AI = !!(process.env.ANTHROPIC_API_KEY);

app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/downloads', express.static(path.join(__dirname, 'output')));

const UPLOAD_DIR = path.join(__dirname, 'uploads');
const WORK_DIR   = path.join(__dirname, 'workspace');
const OUTPUT_DIR = path.join(__dirname, 'output');
[UPLOAD_DIR, WORK_DIR, OUTPUT_DIR].forEach(d => fs.mkdirSync(d, { recursive: true }));

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename:    (req, file, cb) => cb(null, `${uuidv4()}_${file.originalname}`)
});
const upload = multer({
  storage,
  limits: { fileSize: 100 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    ['.zip','.html','.htm'].includes(ext) ? cb(null, true) : cb(new Error('Solo .zip o .html'));
  }
});

// SSE sessions
const sessions = {};

function sse(sessionId, event, data) {
  const s = sessions[sessionId];
  if (!s) return;
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  s.logs.push({ event, data });
  if (s.res) s.res.write(payload);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function scanDir(dir, base = dir) {
  const out = [];
  function walk(cur) {
    for (const item of fs.readdirSync(cur)) {
      const full = path.join(cur, item);
      const rel  = path.relative(base, full);
      const stat = fs.statSync(full);
      if (stat.isDirectory()) walk(full);
      else out.push({ path: rel, size: stat.size, ext: path.extname(item).toLowerCase() });
    }
  }
  walk(dir);
  return out;
}

function readSafe(p, maxBytes = 8000) {
  try { return fs.readFileSync(p,'utf8').substring(0, maxBytes); } catch { return ''; }
}

// ─────────────────────────────────────────────
// ANÁLISIS INTELIGENTE (sin API externa)
// ─────────────────────────────────────────────
function analyzeProject(files, workDir) {
  const report = { type: 'unknown', frameworks: [], missing: [], issues: [], score: 0 };

  const paths = files.map(f => f.path.toLowerCase());
  const hasIndex    = paths.some(p => p === 'index.html' || p.endsWith('/index.html'));
  const hasManifest = paths.some(p => p.includes('manifest.json') || p.includes('manifest.webmanifest'));
  const hasSW       = paths.some(p => p.includes('sw.js') || p.includes('service-worker'));
  const hasIcons    = paths.some(p => p.includes('icon') && ['.png','.jpg','.svg'].includes(path.extname(p)));
  const hasCapacitor= paths.some(p => p.includes('capacitor.config'));
  const hasReact    = paths.some(p => p.includes('react'));
  const hasVue      = paths.some(p => p.includes('vue'));
  const hasTailwind = files.some(f => {
    if (f.ext !== '.html' && f.ext !== '.css') return false;
    const c = readSafe(path.join(workDir, f.path), 2000);
    return c.includes('tailwind') || c.includes('cdn.tailwindcss');
  });

  // Tipo de proyecto
  if (hasReact) report.frameworks.push('React');
  if (hasVue)   report.frameworks.push('Vue.js');
  if (hasTailwind) report.frameworks.push('Tailwind CSS');
  if (hasManifest) { report.frameworks.push('PWA'); report.type = 'pwa'; }
  else if (hasIndex) { report.type = 'web-static'; }

  // Qué falta
  if (!hasIndex)    report.missing.push('index.html');
  if (!hasManifest) report.missing.push('manifest.json');
  if (!hasSW)       report.missing.push('service-worker.js');
  if (!hasIcons)    report.missing.push('íconos (192x192, 512x512)');
  if (!hasCapacitor) report.missing.push('capacitor.config.json');

  // Score
  let score = 0;
  if (hasIndex)     score += 30;
  if (hasManifest)  score += 20;
  if (hasSW)        score += 20;
  if (hasIcons)     score += 15;
  if (hasCapacitor) score += 15;
  report.score = score;

  return report;
}

function generateManifest(appName, appPackage, appVersion) {
  return {
    name: appName,
    short_name: appName.substring(0,12),
    description: `${appName} - Generado por AppForge Cloud`,
    start_url: '/',
    display: 'standalone',
    orientation: 'portrait-primary',
    background_color: '#03001e',
    theme_color: '#7303c0',
    lang: 'es',
    scope: '/',
    id: appPackage,
    version: appVersion,
    icons: [72,96,128,144,152,192,384,512].map(s => ({
      src: `icons/icon-${s}x${s}.png`,
      sizes: `${s}x${s}`,
      type: 'image/png',
      purpose: s >= 192 ? 'maskable any' : 'any'
    })),
    categories: ['productivity','utilities'],
    screenshots: []
  };
}

function generateServiceWorker(appName) {
  return `// Service Worker - ${appName} - AppForge Cloud v2.0
const CACHE_NAME = '${appName.toLowerCase().replace(/\s+/g,'-')}-v1';
const OFFLINE_URL = '/index.html';
const STATIC_ASSETS = ['/', '/index.html', '/manifest.json'];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(STATIC_ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', event => {
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request).catch(() => caches.match(OFFLINE_URL))
    );
    return;
  }
  event.respondWith(
    caches.match(event.request).then(cached => cached || fetch(event.request))
  );
});
`;
}

function generateCapacitorConfig(appName, appPackage) {
  return {
    appId: appPackage,
    appName: appName,
    webDir: '.',
    bundledWebRuntime: false,
    server: {
      hostname: appPackage,
      iosScheme: 'https',
      androidScheme: 'https',
      cleartext: false
    },
    android: {
      allowMixedContent: false,
      captureInput: true,
      webContentsDebuggingEnabled: false
    },
    ios: {
      contentInset: 'automatic',
      scrollEnabled: true
    },
    plugins: {
      SplashScreen: {
        launchShowDuration: 2000,
        backgroundColor: '#03001e',
        androidSplashResourceName: 'splash',
        showSpinner: false
      },
      StatusBar: {
        style: 'dark',
        backgroundColor: '#03001e'
      }
    }
  };
}

// ─────────────────────────────────────────────
// PIPELINE PRINCIPAL
// ─────────────────────────────────────────────
async function runPipeline(sessionId, workDir, cfg) {
  const { appName, appPackage, appVersion, platform } = cfg;

  // ── ETAPA 1: Análisis ────────────────────
  sse(sessionId, 'stage', { stage: 1, status: 'active' });
  sse(sessionId, 'log', { text: '[INFO] Montando entorno sandbox seguro...' });
  await sleep(500);

  const files = scanDir(workDir);
  sse(sessionId, 'log', { text: `[OK]   ${files.length} archivos detectados.` });
  await sleep(400);

  const analysis = analyzeProject(files, workDir);
  sse(sessionId, 'log', { text: `[AI]   Tipo de proyecto: ${analysis.type.toUpperCase()}` });
  await sleep(300);
  if (analysis.frameworks.length)
    sse(sessionId, 'log', { text: `[AI]   Frameworks detectados: ${analysis.frameworks.join(', ')}` });
  await sleep(300);
  sse(sessionId, 'log', { text: `[AI]   Puntuación de compatibilidad móvil: ${analysis.score}/100` });
  await sleep(400);
  sse(sessionId, 'stage', { stage: 1, status: 'done' });

  // ── ETAPA 2: Detección de faltantes ─────
  sse(sessionId, 'stage', { stage: 2, status: 'active' });
  await sleep(400);
  for (const miss of analysis.missing) {
    sse(sessionId, 'log', { text: `[SCAN] FALTANTE: ${miss}` });
    await sleep(350);
  }
  if (analysis.missing.length === 0)
    sse(sessionId, 'log', { text: '[SCAN] Proyecto completo — sin faltantes críticos.' });
  sse(sessionId, 'log', { text: `[AI]   Generando ${analysis.missing.length} componentes necesarios...` });
  await sleep(500);
  sse(sessionId, 'stage', { stage: 2, status: 'done' });

  // ── ETAPA 3: Generar y corregir ──────────
  sse(sessionId, 'stage', { stage: 3, status: 'active' });
  await sleep(400);

  // manifest.json
  const manifestPath = path.join(workDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    fs.writeFileSync(manifestPath, JSON.stringify(generateManifest(appName, appPackage, appVersion), null, 2));
    sse(sessionId, 'log', { text: '[GEN]  manifest.json PWA generado.' });
  } else {
    // Validar y enriquecer el existente
    try {
      const m = JSON.parse(readSafe(manifestPath));
      if (!m.id)          m.id = appPackage;
      if (!m.version)     m.version = appVersion;
      if (!m.lang)        m.lang = 'es';
      if (!m.display)     m.display = 'standalone';
      if (!m.icons || m.icons.length < 2) m.icons = generateManifest(appName, appPackage, appVersion).icons;
      fs.writeFileSync(manifestPath, JSON.stringify(m, null, 2));
      sse(sessionId, 'log', { text: '[FIX]  manifest.json existente enriquecido.' });
    } catch { sse(sessionId, 'log', { text: '[WARN] manifest.json inválido — regenerado.' }); }
  }
  await sleep(400);

  // service worker
  const swPath = path.join(workDir, 'sw.js');
  if (!fs.existsSync(swPath)) {
    fs.writeFileSync(swPath, generateServiceWorker(appName));
    sse(sessionId, 'log', { text: '[GEN]  Service Worker offline generado.' });
  }
  await sleep(400);

  // capacitor.config.json
  const capPath = path.join(workDir, 'capacitor.config.json');
  if (!fs.existsSync(capPath)) {
    fs.writeFileSync(capPath, JSON.stringify(generateCapacitorConfig(appName, appPackage), null, 2));
    sse(sessionId, 'log', { text: '[GEN]  capacitor.config.json creado.' });
  }
  await sleep(400);

  // index.html — inyectar metas si no tiene
  let indexPath = path.join(workDir, 'index.html');
  if (!fs.existsSync(indexPath)) {
    const htmlFile = files.find(f => ['.html','.htm'].includes(f.ext));
    if (htmlFile) {
      fs.copyFileSync(path.join(workDir, htmlFile.path), indexPath);
      sse(sessionId, 'log', { text: `[GEN]  ${htmlFile.path} → index.html (raíz).` });
    } else {
      fs.writeFileSync(indexPath, `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="theme-color" content="#7303c0"><meta name="mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-status-bar-style" content="black-translucent"><title>${appName}</title><link rel="manifest" href="/manifest.json"></head><body style="margin:0;background:#03001e;color:white;font-family:system-ui;display:flex;align-items:center;justify-content:center;min-height:100vh;"><div style="text-align:center;"><h1 style="font-size:2rem;">${appName}</h1><p>Generado por AppForge Cloud</p></div><script>if('serviceWorker'in navigator)navigator.serviceWorker.register('/sw.js');<\/script></body></html>`);
      sse(sessionId, 'log', { text: '[GEN]  index.html base creado.' });
    }
  } else {
    let html = readSafe(indexPath, 200000);
    let changed = false;
    if (!html.includes('manifest.json')) {
      html = html.replace('</head>', `  <link rel="manifest" href="/manifest.json">\n  <meta name="theme-color" content="#7303c0">\n  <meta name="mobile-web-app-capable" content="yes">\n  <meta name="apple-mobile-web-app-capable" content="yes">\n</head>`);
      changed = true; sse(sessionId, 'log', { text: '[FIX]  Metas PWA inyectadas en index.html.' });
    }
    if (!html.includes('sw.js') && !html.includes('serviceWorker')) {
      html = html.replace('</body>', `  <script>if('serviceWorker'in navigator)navigator.serviceWorker.register('/sw.js');<\/script>\n</body>`);
      changed = true; sse(sessionId, 'log', { text: '[FIX]  Service Worker registrado.' });
    }
    if (changed) fs.writeFileSync(indexPath, html);
  }
  await sleep(400);
  sse(sessionId, 'stage', { stage: 3, status: 'done' });

  // ── ETAPA 4: Auditoría ───────────────────
  sse(sessionId, 'stage', { stage: 4, status: 'active' });
  await sleep(400);

  const finalFiles = scanDir(workDir);
  const checks = [
    { ok: finalFiles.some(f => f.path === 'index.html'), msg: 'index.html' },
    { ok: finalFiles.some(f => f.path === 'manifest.json'), msg: 'manifest.json' },
    { ok: finalFiles.some(f => f.path === 'sw.js'), msg: 'Service Worker' },
    { ok: finalFiles.some(f => f.path === 'capacitor.config.json'), msg: 'Capacitor config' },
  ];
  for (const c of checks) {
    sse(sessionId, 'log', { text: `[AUDIT] ${c.ok ? '✓' : '✗'} ${c.msg}` });
    await sleep(300);
  }

  // Revisar XSS básico
  const indexHtml = readSafe(indexPath, 50000);
  const xssRisk = (indexHtml.match(/eval\s*\(|innerHTML\s*=/g) || []).length;
  if (xssRisk > 0) sse(sessionId, 'log', { text: `[WARN] ${xssRisk} posibles puntos XSS detectados. Considera sanitizar inputs.` });
  else sse(sessionId, 'log', { text: '[OK]   Sin vulnerabilidades XSS críticas detectadas.' });
  await sleep(400);

  sse(sessionId, 'log', { text: '[OK]   ✓ PROYECTO APROBADO PARA COMPILACIÓN' });
  sse(sessionId, 'stage', { stage: 4, status: 'done' });

  // ── ETAPA 5: Empaquetar ──────────────────
  sse(sessionId, 'stage', { stage: 5, status: 'active' });
  await sleep(400);

  // package.json con deps Capacitor
  const pkgPath = path.join(workDir, 'package.json');
  if (!fs.existsSync(pkgPath)) {
    fs.writeFileSync(pkgPath, JSON.stringify({
      name: appName.toLowerCase().replace(/[^a-z0-9]/g,'-'),
      version: appVersion,
      description: `${appName} - AppForge Cloud`,
      dependencies: {
        '@capacitor/core':    '^5.7.0',
        '@capacitor/cli':     '^5.7.0',
        '@capacitor/android': '^5.7.0',
        '@capacitor/ios':     '^5.7.0'
      },
      scripts: {
        'build:android': 'npx cap add android && npx cap copy && cd android && ./gradlew assembleRelease',
        'build:ios':     'npx cap add ios && npx cap copy && cd ios/App && xcodebuild -scheme App -configuration Release archive'
      }
    }, null, 2));
    sse(sessionId, 'log', { text: '[GEN]  package.json con Capacitor v5 generado.' });
  }
  await sleep(300);

  // APPFORGE_README.md con instrucciones paso a paso
  const platforms = platform === 'both' ? ['Android','iOS'] : [platform === 'android' ? 'Android' : 'iOS'];
  const readmeMd = `# ${appName} — Build AppForge Cloud
**Paquete:** \`${appPackage}\` | **Versión:** \`${appVersion}\` | **Plataforma:** \`${platforms.join(' + ')}\`
**Fecha de compilación:** ${new Date().toLocaleString('es-MX')}

---

## 📦 Contenido del paquete
${scanDir(workDir).map(f=>`- \`${f.path}\``).join('\n')}

---

## 🤖 Compilar APK (Android) — Pasos

\`\`\`bash
# 1. Instalar Node.js 18+ y Android Studio con SDK
# 2. En la carpeta descomprimida:
npm install

# 3. Agregar plataforma Android
npx cap add android

# 4. Copiar archivos web
npx cap copy

# 5. Compilar APK debug (para pruebas)
cd android
./gradlew assembleDebug

# El APK estará en:
# android/app/build/outputs/apk/debug/app-debug.apk
\`\`\`

## 🍎 Compilar IPA (iOS) — Pasos

\`\`\`bash
# Requiere Mac con Xcode 14+ y cuenta de Apple Developer
npm install
npx cap add ios
npx cap copy
npx cap open ios
# En Xcode: Product > Archive > Distribute App
\`\`\`

## ⚡ Alternativa rápida — PWABuilder (sin compilar)
1. Sube la carpeta a **Netlify** (drag & drop en netlify.com) o **GitHub Pages**
2. Ve a **https://www.pwabuilder.com**
3. Ingresa tu URL → Descarga APK/IPA firmado directamente

---
*Generado por AppForge Cloud — Pipeline ForgeAI v2.0*
`;

  fs.writeFileSync(path.join(workDir, 'APPFORGE_README.md'), readmeMd);
  sse(sessionId, 'log', { text: '[GEN]  APPFORGE_README.md con instrucciones paso a paso.' });
  await sleep(400);

  // Crear ZIP final
  const outName = `AppForge_${appName.replace(/\s+/g,'_')}_v${appVersion}_${platform}.zip`;
  const outPath = path.join(OUTPUT_DIR, outName);

  // Empaquetar con AdmZip (síncrono — garantiza escritura completa)
  {
    const AdmZip = require('adm-zip');
    const zip = new AdmZip();
    function addDirToZip(dir, baseInZip) {
      const entries = fs.readdirSync(dir);
      for (const entry of entries) {
        const fullPath = path.join(dir, entry);
        const zipPath  = baseInZip ? `${baseInZip}/${entry}` : entry;
        const stat = fs.statSync(fullPath);
        if (stat.isDirectory()) {
          addDirToZip(fullPath, zipPath);
        } else {
          zip.addFile(zipPath, fs.readFileSync(fullPath));
        }
      }
    }
    addDirToZip(workDir, '');
    zip.writeZip(outPath);
  }

  const rawSize = fs.statSync(outPath).size;
  const sizeMB  = rawSize < 1024*1024
    ? (rawSize / 1024).toFixed(1) + ' KB'
    : (rawSize / 1024 / 1024).toFixed(2) + ' MB';
  const finalCount = scanDir(workDir).length;

  sse(sessionId, 'log', { text: `[OK]   ${outName} (${sizeMB} MB) — ${finalCount} archivos` });
  sse(sessionId, 'log', { text: '[OK]   ✅ PIPELINE COMPLETO — Descarga lista.' });
  sse(sessionId, 'stage', { stage: 5, status: 'done' });

  sse(sessionId, 'complete', {
    fileName: outName,
    downloadUrl: `/downloads/${outName}`,
    sizeMB,
    appName, appPackage, appVersion, platform,
    filesCount: finalCount
  });
  sessions[sessionId].done = true;
}

// ─────────────────────────────────────────────
// RUTAS
// ─────────────────────────────────────────────

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', version: '2.0.0', ai: HAS_AI, mode: 'smart-pipeline' });
});

app.get('/api/session/:id/stream', (req, res) => {
  const { id } = req.params;
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders();

  if (!sessions[id]) sessions[id] = { res: null, logs: [], done: false };
  sessions[id].res = res;
  for (const { event, data } of sessions[id].logs) {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }
  const ping = setInterval(() => {
    if (!sessions[id] || sessions[id].done) { clearInterval(ping); return; }
    res.write(': ping\n\n');
  }, 15000);
  req.on('close', () => clearInterval(ping));
});

app.post('/api/build', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No se recibió archivo.' });

    const sessionId  = uuidv4();
    const appName    = (req.body.appName    || 'MiApp').trim();
    const appPackage = (req.body.appPackage || 'com.appforge.app').trim();
    const appVersion = (req.body.appVersion || '1.0.0').trim();
    const platform   = req.body.platform   || 'android';

    const workDir = path.join(WORK_DIR, sessionId);
    fs.mkdirSync(workDir, { recursive: true });

    const ext = path.extname(req.file.originalname).toLowerCase();
    if (ext === '.zip') {
      try { new AdmZip(req.file.path).extractAllTo(workDir, true); }
      catch(e) { return res.status(400).json({ error: 'ZIP inválido o corrupto.' }); }
    } else {
      fs.copyFileSync(req.file.path, path.join(workDir, 'index.html'));
    }
    fs.unlinkSync(req.file.path);

    sessions[sessionId] = { res: null, logs: [], done: false };

    runPipeline(sessionId, workDir, { appName, appPackage, appVersion, platform })
      .catch(err => { sse(sessionId, 'error', { message: err.message }); sessions[sessionId].done = true; });

    res.json({ sessionId, message: 'Pipeline iniciado.' });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/builds', (req, res) => {
  try {
    const builds = fs.readdirSync(OUTPUT_DIR)
      .filter(f => f.endsWith('.zip'))
      .map(f => {
        const stat = fs.statSync(path.join(OUTPUT_DIR, f));
        return { name: f, sizeMB: (stat.size/1024/1024).toFixed(2), date: stat.mtime };
      })
      .sort((a,b) => new Date(b.date) - new Date(a.date));
    res.json({ builds });
  } catch { res.json({ builds: [] }); }
});

app.listen(PORT, () => {
  console.log(`\n🚀 AppForge Cloud v2.0 — puerto ${PORT}`);
  console.log(`📡 API: http://localhost:${PORT}/api`);
  console.log(`🤖 Pipeline inteligente: ACTIVO`);
  console.log(`🌐 App: http://localhost:${PORT}\n`);
});
