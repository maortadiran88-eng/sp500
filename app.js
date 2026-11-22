// ── STATE ──────────────────────────────────────
let scanning    = false;
let countdown   = null;
let prevData    = {};   // { sym: { price, ma } }
let rows        = {};   // { sym: rowData }
let alerts      = [];
let scanAlerts  = [];   // התראות של הסריקה הנוכחית (להיסטוריה)
let activeList  = null; // key of LISTS
let timeframe   = 'daily';
let maPeriod    = 150;
let nearPct     = 2;
let intervalSec = 300;
let sortCol     = 'sym';
let sortAsc     = true;
let filterMode  = 'all';
let soundOn     = true;

// ── UTILS ──────────────────────────────────────
const $ = id => document.getElementById(id);
const fmt$ = p => (p != null && isFinite(p)) ? '$' + p.toFixed(2) : '—';
const fmtP = p => (p != null && isFinite(p)) ? (p >= 0 ? '+' : '') + p.toFixed(2) + '%' : '—';
const fmtT = () => new Date().toLocaleTimeString('he-IL');
const sleep = ms => new Promise(r => setTimeout(r, ms));

function readSettings() {
  maPeriod    = Math.max(2, parseInt($('maPeriod').value)   || 150);
  nearPct     = Math.max(0.1, parseFloat($('nearPct').value) || 2);
  intervalSec = parseInt($('interval').value) || 300;
  timeframe   = $('tfDaily').classList.contains('active') ? 'daily' : 'weekly';
}

// ── SAVE / LOAD SETTINGS ───────────────────────
const SK = 'sma_scanner_v4';
function saveSettings() {
  readSettings();
  try {
    localStorage.setItem(SK, JSON.stringify({
      activeList, timeframe, maPeriod, nearPct, intervalSec, soundOn,
      savedAt: new Date().toLocaleString('he-IL')
    }));
  } catch(e) {}
}
function loadAndApply() {
  try {
    const s = JSON.parse(localStorage.getItem(SK));
    if (!s) return;
    if (s.maPeriod)    $('maPeriod').value = s.maPeriod;
    if (s.nearPct)     $('nearPct').value  = s.nearPct;
    if (s.intervalSec) $('interval').value = s.intervalSec;
    if (s.timeframe === 'weekly') setTf('weekly');
    if (s.soundOn === false) { soundOn = false; updateSoundBtn(); }
    if (s.activeList && LISTS[s.activeList]) selectList(s.activeList);
    showToast(s);
    readSettings();
  } catch(e) {}
}
function showToast(s) {
  const el = document.createElement('div');
  el.id = 'toast';
  el.innerHTML = `<strong>📂 הגדרות אחרונות</strong>
    <div style="margin:6px 0;font-size:12px;line-height:1.8">
      ${s.activeList ? LISTS[s.activeList]?.label : '—'} ·
      ${s.timeframe === 'weekly' ? 'שבועי' : 'יומי'} SMA${s.maPeriod} ·
      קרוב ${s.nearPct}%<br>נשמר: ${s.savedAt}
    </div>
    <button onclick="document.getElementById('toast').remove()" class="toast-ok">✓ הבנתי</button>`;
  document.body.appendChild(el);
  setTimeout(() => { const t = $('toast'); if (t) t.remove(); }, 8000);
}

// ── TIMEFRAME ──────────────────────────────────
function setTf(tf) {
  timeframe = tf;
  $('tfDaily').classList.toggle('active',  tf === 'daily');
  $('tfWeekly').classList.toggle('active', tf === 'weekly');
  saveSettings();
}

// ── LIST SELECTOR ──────────────────────────────
function selectList(key) {
  activeList = key;
  document.querySelectorAll('.list-btn').forEach(b => b.classList.remove('active'));
  const btn = $('btn_' + key);
  if (btn) btn.classList.add('active');
  $('listLabel').textContent = LISTS[key].label + ' (' + LISTS[key].count + ')';
  rows = {}; prevData = {};
  renderTable();
  saveSettings();
}

// ── SOUND ──────────────────────────────────────
function toggleSound() {
  soundOn = !soundOn;
  updateSoundBtn();
  saveSettings();
}
function updateSoundBtn() {
  const b = $('soundBtn');
  b.textContent = soundOn ? '🔔' : '🔕';
  b.title = soundOn ? 'קול פעיל — לחץ לכיבוי' : 'קול כבוי — לחץ להפעלה';
}
function beep(type) {
  if (!soundOn) return;
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (type === 'buy') {
      [[523,0],[659,0.15],[784,0.30]].forEach(([f,d]) => {
        const o = ctx.createOscillator(), g = ctx.createGain();
        o.connect(g); g.connect(ctx.destination);
        o.frequency.value = f; o.type = 'sine';
        const t = ctx.currentTime + d;
        g.gain.setValueAtTime(0.25, t);
        g.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
        o.start(t); o.stop(t + 0.3);
      });
    } else {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.connect(g); g.connect(ctx.destination);
      o.frequency.value = type === 'up' ? 800 : 400; o.type = 'sine';
      g.gain.setValueAtTime(0.2, ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
      o.start(); o.stop(ctx.currentTime + 0.3);
    }
  } catch(e) {}
}

// ── FETCH ──────────────────────────────────────
async function fetchStock(sym) {
  readSettings();
  sym = String(sym).replace(/\./g, '-');   // BRK.B -> BRK-B (פורמט Yahoo)
  const interval = timeframe === 'weekly' ? '1wk' : '1d';
  const range    = timeframe === 'weekly'
    ? (maPeriod <= 52 ? '2y' : '5y')
    : (maPeriod <= 100 ? '1y' : '2y');

  const url   = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=${interval}&range=${range}`;
  const proxy = `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`;
  const res   = await fetch(proxy, { signal: AbortSignal.timeout(12000) });
  if (!res.ok) throw new Error(res.status);
  const json = await res.json();

  const result = json?.chart?.result?.[0];
  if (!result) throw new Error('no data');

  const meta    = result.meta;
  const quote   = result.indicators?.quote?.[0] || {};
  const closes  = (quote.close  || []).filter(c => c > 0 && isFinite(c));
  const volumes = (quote.volume || []).filter(v => v > 0);

  const price   = meta.regularMarketPrice;
  const prev    = meta.chartPreviousClose || meta.previousClose;
  const chgPct  = (price && prev) ? ((price - prev) / prev) * 100 : 0;

  // SMA
  const slice = closes.slice(-maPeriod);
  const ma    = slice.length >= Math.min(maPeriod, 5)
    ? slice.reduce((a, b) => a + b, 0) / slice.length : null;

  // MA slope: compare to 5 (daily) or 3 (weekly) candles ago
  let slope = null, slopePct = null;
  const lb = timeframe === 'weekly' ? 3 : 5;
  if (ma && closes.length >= maPeriod + lb) {
    const old = closes.slice(-(maPeriod + lb), -lb);
    const maOld = old.reduce((a, b) => a + b, 0) / old.length;
    slopePct = ((ma - maOld) / maOld) * 100;
    slope = slopePct > 0.1 ? 'up' : slopePct < -0.1 ? 'down' : 'flat';
  }

  // Volume ratio vs 20-period avg
  const vol20   = volumes.slice(-20);
  const avgVol  = vol20.length ? vol20.reduce((a, b) => a + b, 0) / vol20.length : 0;
  const curVol  = meta.regularMarketVolume || volumes.slice(-1)[0] || 0;
  const volRatio = avgVol > 0 ? curVol / avgVol : null;

  // Historical cross detection (first scan only) — last 2 candles
  let histCross = null;
  if (closes.length >= maPeriod + 4) {
    const maAt = offset => {
      const s = closes.slice(-(maPeriod + offset), offset === 0 ? undefined : -offset);
      return s.reduce((a, b) => a + b, 0) / s.length;
    };
    const n = closes.length;
    const p = [closes[n-4], closes[n-3], closes[n-2], closes[n-1]];
    const m = [maAt(3), maAt(2), maAt(1), maAt(0)];
    // 1 candle ago
    if (p[1] < m[1] && p[2] >= m[2]) histCross = { dir: 'up',   ago: 1 };
    else if (p[1] > m[1] && p[2] <= m[2]) histCross = { dir: 'down', ago: 1 };
    // 2 candles ago
    else if (p[0] < m[0] && p[1] >= m[1]) histCross = { dir: 'up',   ago: 2 };
    else if (p[0] > m[0] && p[1] <= m[1]) histCross = { dir: 'down', ago: 2 };
  }

  return { price, chgPct, ma, slope, slopePct, curVol, avgVol, volRatio, histCross };
}

// ── BUY SIGNAL CHECK ───────────────────────────
function isBuy(dir, slope, price, ma, histAgo) {
  if (dir !== 'up') return false;
  if (!ma || slope === 'down') return false;
  const diff = Math.abs(((price - ma) / ma) * 100);
  const limit = histAgo > 0 ? nearPct * 2 : nearPct;
  return diff <= limit;
}

// ── ALERT ──────────────────────────────────────
function addAlert(sym, name, price, ma, dir, slope, volRatio, ago) {
  readSettings();
  const buy   = isBuy(dir, slope, price, ma, ago);
  const tf    = timeframe === 'weekly' ? 'שבועי' : 'יומי';
  const isH   = ago > 0;
  const alertObj = { sym, name, price, ma, dir, slope, volRatio, ago, buy, isH, tf, mp: maPeriod, time: fmtT() };
  alerts.unshift(alertObj);
  scanAlerts.push(alertObj);
  if (alerts.length > 100) alerts.pop();
  $('alertCount').textContent = alerts.length + ' התראות';
  $('crossStat').textContent  = alerts.length;
  renderAlerts();
  beep(buy ? (isH ? 'up' : 'buy') : dir);
  if (!isH && Notification.permission === 'granted') {
    new Notification((buy ? '🟢 קנייה: ' : '📊 חציה: ') + sym, {
      body: (dir === 'up' ? '▲ מעלה' : '▼ מטה') + ' | $' + price.toFixed(2) + ' | SMA $' + ma.toFixed(2)
    });
  }
}

// ── RENDER ALERTS ──────────────────────────────
function renderAlerts() {
  const c = $('alertsBox');
  if (!alerts.length) { c.innerHTML = '<div class="empty">אין התראות עדיין</div>'; return; }
  c.innerHTML = alerts.map(a => {
    const slopeIcon = a.slope === 'up' ? '↗' : a.slope === 'flat' ? '→' : '↘';
    const slopeClr  = a.slope === 'up' ? '#00ff88' : a.slope === 'flat' ? '#ffb800' : '#ff3355';
    const volOk     = a.volRatio != null && a.volRatio >= 1.5;
    const buyBadge  = a.buy
      ? (a.isH ? `<span class="badge amber">🕐 קנייה לפני ${a.ago} נרות</span>` : `<span class="badge green anim">🟢 קנייה</span>`)
      : '';
    const volBadge  = volOk ? `<span class="badge vol">📊 נפח גבוה</span>` : '';
    return `<div class="alert-row ${a.dir === 'up' ? 'aup' : 'adn'}${a.buy && !a.isH ? ' abuy' : ''}">
      <span class="alert-dir">${a.dir === 'up' ? '▲ מעלה' : '▼ מטה'}</span>
      <span class="alert-sym">${a.sym}</span>
      <span class="alert-name">${a.name}</span>
      <span class="alert-price">${fmt$(a.price)}</span>
      <span style="font-size:11px;color:${slopeClr}">SMA ${slopeIcon}</span>
      ${buyBadge}${volBadge}
      <span class="alert-ma">SMA${a.mp}: ${fmt$(a.ma)}</span>
      <span class="alert-time">${a.time}</span>
    </div>`;
  }).join('');
}

// ── RENDER TABLE ───────────────────────────────
function renderTable() {
  readSettings();
  const search = ($('searchBox')?.value || '').toUpperCase().trim();
  let data = Object.values(rows);
  if (data.length === 0) {
    $('tbody').innerHTML = `<tr><td colspan="8" class="empty">${activeList ? 'ממתין לסריקה...' : 'בחר אינדקס להתחלה'}</td></tr>`;
    updateStats();
    return;
  }

  // filter
  data = data.filter(d => {
    if (search && !d.sym.includes(search) && !d.name.toUpperCase().includes(search)) return false;
    if (!d.ma) return filterMode === 'all';
    const diff   = ((d.price - d.ma) / d.ma) * 100;
    const near   = Math.abs(diff) <= nearPct;
    const volOk  = d.volRatio != null && d.volRatio >= 1.5;
    const buyOk  = d.crossed && d.slope !== 'down' && d.price >= d.ma;
    switch (filterMode) {
      case 'above':   return d.price >= d.ma;
      case 'below':   return d.price < d.ma;
      case 'near':    return near;
      case 'crossed': return d.crossed;
      case 'buy':     return buyOk;
      case 'vol':     return volOk;
      default:        return true;
    }
  });

  // sort
  data.sort((a, b) => {
    let va, vb;
    switch (sortCol) {
      case 'price': va = a.price || 0;  vb = b.price || 0; break;
      case 'chg':   va = a.chgPct || 0; vb = b.chgPct || 0; break;
      case 'diff':
        va = (a.ma && a.price) ? ((a.price - a.ma) / a.ma) * 100 : -999;
        vb = (b.ma && b.price) ? ((b.price - b.ma) / b.ma) * 100 : -999;
        break;
      case 'vol': va = a.volRatio || 0; vb = b.volRatio || 0; break;
      default:    va = a.sym; vb = b.sym;
    }
    return typeof va === 'string'
      ? (sortAsc ? va.localeCompare(vb) : vb.localeCompare(va))
      : (sortAsc ? va - vb : vb - va);
  });

  $('tableCount').textContent = data.length + ' מניות';

  $('tbody').innerHTML = data.map(d => {
    if (!d.ma) return `<tr>
      <td class="tsym">${d.sym}</td><td class="tname">${d.name}</td>
      <td>${fmt$(d.price)}</td>
      <td class="${(d.chgPct||0)>=0?'up':'dn'}">${fmtP(d.chgPct)}</td>
      <td colspan="4" style="color:var(--muted);font-size:11px">טוען...</td></tr>`;

    const diff     = ((d.price - d.ma) / d.ma) * 100;
    const near     = Math.abs(diff) <= nearPct;
    const slopeIcon = d.slope === 'up' ? '↗' : d.slope === 'flat' ? '→' : '↘';
    const slopeClr  = d.slope === 'up' ? 'var(--green)' : d.slope === 'flat' ? 'var(--amber)' : 'var(--red)';
    const volOk     = d.volRatio != null && d.volRatio >= 1.5;
    const volLow    = d.volRatio != null && d.volRatio < 0.5;
    const volClr    = volOk ? 'var(--green)' : volLow ? 'var(--muted)' : 'var(--blue)';
    const volBar    = d.volRatio != null
      ? `<div style="display:flex;align-items:center;gap:4px">
          <div style="width:40px;height:4px;background:var(--bdr);border-radius:2px">
            <div style="width:${Math.min(d.volRatio/2,1)*100}%;height:100%;background:${volClr};border-radius:2px"></div>
          </div>
          <span style="color:${volClr};font-size:11px">${d.volRatio.toFixed(1)}x</span>
         </div>` : '—';

    const buyOk  = d.crossed && d.slope !== 'down' && d.price >= d.ma;
    const isHist = d.crossedAgo > 0;
    let status = '';
    if (d.price >= d.ma) {
      if (buyOk) status = isHist
        ? `<span class="badge amber" style="font-size:9px">🕐${d.crossedAgo}נ׳</span> <span class="up">▲</span>`
        : `<span class="badge green anim" style="font-size:9px">🟢</span> <span class="up">▲</span>`;
      else status = (near ? '<span class="badge amber" style="font-size:9px">קרוב</span> ' : '') + '<span class="up">▲ מעל</span>';
    } else {
      status = (near ? '<span class="badge amber" style="font-size:9px">קרוב</span> ' : '') + '<span class="dn">▼ מתחת</span>';
    }

    const rowBg = buyOk && !isHist ? 'background:rgba(0,255,136,0.05)'
                : buyOk && isHist  ? 'background:rgba(255,184,0,0.04)' : '';

    return `<tr style="${rowBg}">
      <td class="tsym">${d.sym}</td>
      <td class="tname">${d.name}</td>
      <td>${fmt$(d.price)}</td>
      <td class="${d.chgPct>=0?'up':'dn'}">${fmtP(d.chgPct)}</td>
      <td style="color:var(--blue)">${fmt$(d.ma)}</td>
      <td class="${diff>=0?'up':'dn'}">${fmtP(diff)}</td>
      <td><span style="color:${slopeClr}">${slopeIcon} ${d.slope==='up'?'עולה':d.slope==='flat'?'ישר':'יורד'}</span></td>
      <td>${volBar}</td>
      <td>${status}</td>
    </tr>`;
  }).join('');

  updateStats();
}

function updateStats() {
  readSettings();
  const all   = Object.values(rows).filter(d => d.ma);
  const above = all.filter(d => d.price >= d.ma).length;
  const below = all.filter(d => d.price < d.ma).length;
  const near  = all.filter(d => Math.abs(((d.price - d.ma) / d.ma) * 100) <= nearPct).length;
  $('totalStat').textContent = Object.keys(rows).length;
  $('aboveStat').textContent = above;
  $('belowStat').textContent = below;
  $('nearStat').textContent  = near;
}

function setSort(col) {
  sortAsc = sortCol === col ? !sortAsc : true;
  sortCol = col;
  renderTable();
}
function setFilter(f, el) {
  filterMode = f;
  document.querySelectorAll('.flt').forEach(b => b.classList.remove('active'));
  el.classList.add('active');
  renderTable();
}

// ── SCAN ───────────────────────────────────────
async function runScan() {
  readSettings();
  const list = activeList ? LISTS[activeList].data : null;
  if (!list) return;

  scanAlerts = [];
  $('statusDot').className = 'dot scanning';
  $('statusText').textContent = 'סורק...';
  $('progWrap').style.display = 'block';

  for (let i = 0; i < list.length; i++) {
    if (!scanning) break;
    const [sym, name] = list[i];
    $('progLabel').textContent = `${i+1}/${list.length} — ${sym}`;
    $('progBar').style.width   = `${((i+1)/list.length)*100}%`;

    try {
      const d       = await fetchStock(sym);
      const isFirst = !prevData[sym];
      let crossed = false, crossedAgo = 0;

      if (isFirst && d.histCross && d.histCross.dir === 'up') {
        crossed    = true;
        crossedAgo = d.histCross.ago;
        addAlert(sym, name, d.price, d.ma, d.histCross.dir, d.slope, d.volRatio, d.histCross.ago);
      } else if (!isFirst) {
        const prev = prevData[sym];
        if (prev.ma && d.ma) {
          if (prev.price < prev.ma && d.price >= d.ma) {
            crossed = true;
            addAlert(sym, name, d.price, d.ma, 'up', d.slope, d.volRatio, 0);
          } else if (prev.price > prev.ma && d.price <= d.ma) {
            crossed = true;
            addAlert(sym, name, d.price, d.ma, 'down', d.slope, d.volRatio, 0);
          }
        }
      }

      prevData[sym] = { price: d.price, ma: d.ma };
      rows[sym] = {
        sym, name,
        price:     d.price,
        chgPct:    d.chgPct,
        ma:        d.ma,
        slope:     d.slope,
        slopePct:  d.slopePct,
        volRatio:  d.volRatio,
        crossed:   crossed || rows[sym]?.crossed,
        crossedAgo,
        updated:   fmtT()
      };
    } catch(e) {
      if (!rows[sym]) rows[sym] = { sym, name, price: null, chgPct: null, ma: null, slope: null, volRatio: null, crossed: false, crossedAgo: 0 };
    }

    if ((i + 1) % 8 === 0 || i === list.length - 1) renderTable();
    await sleep(380);
  }

  const completed = scanning;   // false אם נלחץ "עצור" באמצע
  $('progWrap').style.display = 'none';
  if (completed) {
    $('statusDot').className = 'dot live';
    const tf = timeframe === 'weekly' ? 'שבועי' : 'יומי';
    $('statusText').textContent = `הושלם · ${fmtT()} · ${tf} SMA${maPeriod}`;
  }
  renderTable();
  saveScanToHistory(!completed);   // שמירת הממצאים להיסטוריה
  if (completed) startCountdown();
}

function startCountdown() {
  clearInterval(countdown);
  let left = intervalSec;
  countdown = setInterval(() => {
    left--;
    $('nextScan').textContent = `סריקה הבאה בעוד ${left} שנ׳`;
    if (left <= 0) { clearInterval(countdown); $('nextScan').textContent = ''; if (scanning) runScan(); }
  }, 1000);
}

// ── START / STOP ────────────────────────────────
function startScan() {
  if (!activeList) { alert('בחר אינדקס להתחלה'); return; }
  if (Notification.permission === 'default') Notification.requestPermission();
  scanning = true; rows = {}; prevData = {};
  $('startBtn').style.display = 'none';
  $('stopBtn').style.display  = 'inline-block';
  saveSettings();
  runScan();
}
function stopScan() {
  scanning = false; clearInterval(countdown);
  $('startBtn').style.display = 'inline-block';
  $('stopBtn').style.display  = 'none';
  $('statusDot').className = 'dot';
  $('statusText').textContent = 'עצור';
  $('nextScan').textContent = '';
  $('progWrap').style.display = 'none';
}
function clearAll() {
  alerts = [];
  Object.values(rows).forEach(r => { r.crossed = false; r.crossedAgo = 0; });
  $('alertCount').textContent = '0 התראות';
  $('crossStat').textContent  = '0';
  renderAlerts(); renderTable();
}

// ── INIT ───────────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
  updateSoundBtn();
  renderAlerts();
  loadCachedLists();      // רשימות מעודכנות שנשמרו (אם יש)
  renderTable();
  loadHistory();
  renderHistory();
  loadAndApply();
  autoUpdateLists();      // עדכון ברקע אם עברו 7 ימים
});


// ═══════════════════════════════════════════════════════════
//  עדכון רשימות האינדקסים (S&P 500 / S&P 100 / Nasdaq 100)
//  המקור: Wikipedia (API רשמי עם CORS — לא צריך proxy)
// ═══════════════════════════════════════════════════════════
const LK            = 'sma_scanner_lists_v1';
const LIST_MAX_AGE  = 7 * 24 * 3600 * 1000;           // שבוע
const LIST_PAGES    = { SP500: 'List_of_S&P_500_companies', SP100: 'S&P_100', NQ100: 'Nasdaq-100' };
const LIST_MIN      = { SP500: 480, SP100: 95, NQ100: 95 };   // הגנה מרשימה חלקית/שבורה
let   listsUpdating = false;

function normSym(s) {
  return String(s || '').replace(/\[.*?\]/g, '').trim().toUpperCase().replace(/\./g, '-');
}
function cleanName(s) {
  return String(s || '').replace(/\[.*?\]/g, '').replace(/\s+/g, ' ').trim();
}

async function fetchWikiList(key) {
  const url = 'https://en.wikipedia.org/w/api.php?action=parse&format=json&formatversion=2'
            + '&prop=text&redirects=1&origin=*&page=' + encodeURIComponent(LIST_PAGES[key]);
  const res = await fetch(url, { signal: AbortSignal.timeout(25000) });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const json = await res.json();
  const html = json?.parse?.text;
  if (!html) throw new Error('no page');
  const doc  = new DOMParser().parseFromString(html, 'text/html');
  let best = [];
  doc.querySelectorAll('table.wikitable').forEach(t => {
    const trs = [...t.querySelectorAll('tr')];
    const hi  = trs.findIndex(r => r.querySelector('th'));
    if (hi < 0) return;
    const hdr = [...trs[hi].children].map(h => h.textContent.trim().toLowerCase());
    const si  = hdr.findIndex(h => /^(symbol|ticker)/.test(h));
    const ni  = hdr.findIndex(h => /^(company|security|name)/.test(h));
    if (si < 0 || ni < 0) return;
    const seen = new Set(), out = [];
    trs.slice(hi + 1).forEach(r => {
      const c = r.children;
      if (c.length <= Math.max(si, ni)) return;
      const sym = normSym(c[si].textContent);
      if (!/^[A-Z]{1,5}(-[A-Z])?$/.test(sym) || seen.has(sym)) return;
      seen.add(sym);
      out.push([sym, cleanName(c[ni].textContent) || sym]);
    });
    if (out.length > best.length) best = out;
  });
  if (best.length < LIST_MIN[key]) throw new Error('רשימה קצרה מדי (' + best.length + ')');
  return best;
}

function applyList(key, arr, source) {
  LISTS[key].data   = arr;
  LISTS[key].count  = arr.length;
  LISTS[key].source = source;
}

function refreshListUI() {
  Object.keys(LISTS).forEach(k => {
    const el = $('cnt_' + k);
    if (el) el.textContent = LISTS[k].count;
  });
  if (activeList && LISTS[activeList])
    $('listLabel').textContent = LISTS[activeList].label + ' (' + LISTS[activeList].count + ')';
}

function setListsInfo(msg, color) {
  const el = $('listsInfo');
  if (!el) return;
  el.textContent = msg;
  el.style.color = color || 'var(--muted)';
}

function loadCachedLists() {
  try {
    const c = JSON.parse(localStorage.getItem(LK));
    if (!c || !c.lists) return;
    Object.keys(c.lists).forEach(k => {
      if (LISTS[k] && Array.isArray(c.lists[k]) && c.lists[k].length >= LIST_MIN[k])
        applyList(k, c.lists[k], 'wiki');
    });
    refreshListUI();
    setListsInfo('רשימות עודכנו: ' + new Date(c.ts).toLocaleString('he-IL'));
  } catch (e) {}
}

function autoUpdateLists() {
  let ts = 0;
  try { ts = JSON.parse(localStorage.getItem(LK))?.ts || 0; } catch (e) {}
  if (Date.now() - ts > LIST_MAX_AGE) updateLists(false);
}

async function updateLists(manual) {
  if (listsUpdating) return;
  listsUpdating = true;
  const btn = $('updListsBtn');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ מעדכן...'; }
  setListsInfo('מוריד רשימות עדכניות...', 'var(--amber)');
  const keys = Object.keys(LIST_PAGES);
  const results = await Promise.allSettled(keys.map(fetchWikiList));
  let cached = {};
  try { cached = JSON.parse(localStorage.getItem(LK))?.lists || {}; } catch (e) {}
  const ok = [], fail = [];
  results.forEach((r, i) => {
    const k = keys[i];
    if (r.status === 'fulfilled') { applyList(k, r.value, 'wiki'); cached[k] = r.value; ok.push(k); }
    else fail.push(k);
  });
  if (ok.length) {
    try { localStorage.setItem(LK, JSON.stringify({ ts: Date.now(), lists: cached })); } catch (e) {}
  }
  refreshListUI();
  if (activeList && !scanning && ok.includes(activeList)) { rows = {}; prevData = {}; renderTable(); }
  if (btn) { btn.disabled = false; btn.textContent = '🔄 עדכן רשימות'; }
  const names = k => LISTS[k].label + ' ' + LISTS[k].count;
  if (!fail.length)
    setListsInfo('✓ עודכן: ' + ok.map(names).join(' · '), 'var(--green)');
  else if (ok.length)
    setListsInfo('עודכן חלקית: ' + ok.map(names).join(' · ') + ' | נכשל: ' + fail.map(k => LISTS[k].label).join(', '), 'var(--amber)');
  else
    setListsInfo(manual ? '✗ העדכון נכשל — נשארת הרשימה השמורה' : 'עדכון אוטומטי נכשל — נשארת הרשימה השמורה', 'var(--red)');
  listsUpdating = false;
}

// ═══════════════════════════════════════════════════════════
//  היסטוריית סריקות — נשמרת אחרי כל סריקה, עם אפשרות מחיקה
// ═══════════════════════════════════════════════════════════
const HK       = 'sma_scanner_history_v1';
const HIST_MAX = 30;                 // מקסימום סריקות שנשמרות
let history    = [];
const histOpen = new Set();

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function loadHistory() {
  try { history = JSON.parse(localStorage.getItem(HK)) || []; } catch (e) { history = []; }
  if (!Array.isArray(history)) history = [];
}
function persistHistory() {
  for (;;) {
    try { localStorage.setItem(HK, JSON.stringify(history)); return; }
    catch (e) { if (history.length <= 1) return; history.pop(); }   // אין מקום — מוחקים את הישנה ביותר
  }
}

function saveScanToHistory(partial) {
  const all  = Object.values(rows);
  const live = all.filter(d => d.ma && d.price);
  if (!live.length) return;
  readSettings();
  const found = new Map();
  scanAlerts.forEach(al => {
    if (found.has(al.sym)) return;
    found.set(al.sym, {
      sym: al.sym, name: al.name, price: al.price, ma: al.ma,
      diff: ((al.price - al.ma) / al.ma) * 100,
      type: al.buy ? 'buy' : (al.dir === 'up' ? 'up' : 'down'),
      ago: al.ago || 0, slope: al.slope, vol: al.volRatio
    });
  });
  live.forEach(d => {
    if (found.has(d.sym)) return;
    const diff = ((d.price - d.ma) / d.ma) * 100;
    if (Math.abs(diff) <= nearPct)
      found.set(d.sym, { sym: d.sym, name: d.name, price: d.price, ma: d.ma, diff,
                         type: 'near', ago: 0, slope: d.slope, vol: d.volRatio });
  });
  const order = { buy: 0, up: 1, down: 2, near: 3 };
  const items = [...found.values()].sort((x, y) => order[x.type] - order[y.type] || x.sym.localeCompare(y.sym));
  history.unshift({
    id: Date.now(),
    time: new Date().toLocaleString('he-IL'),
    list: activeList ? LISTS[activeList].label : '—',
    tf: timeframe === 'weekly' ? 'שבועי' : 'יומי',
    mp: maPeriod, near: nearPct,
    scanned: all.length,
    above: live.filter(d => d.price >= d.ma).length,
    below: live.filter(d => d.price <  d.ma).length,
    partial: !!partial,
    found: items
  });
  if (history.length > HIST_MAX) history.length = HIST_MAX;
  persistHistory();
  renderHistory();
}

const H_TYPE = {
  buy:  ['🟢 קנייה',     'up'],
  up:   ['▲ חצה מעלה',   'up'],
  down: ['▼ חצה מטה',    'dn'],
  near: ['⚡ קרוב ל-SMA', '']
};

function renderHistory() {
  const box = $('histBox');
  if (!box) return;
  $('histCount').textContent = history.length + ' סריקות';
  if ($('histClearBtn')) $('histClearBtn').style.display = history.length ? '' : 'none';
  if (!history.length) {
    box.innerHTML = '<div class="empty">אין היסטוריה עדיין — הממצאים נשמרים אוטומטית אחרי כל סריקה</div>';
    return;
  }
  box.innerHTML = history.map(h => {
    const cnt = t => h.found.filter(f => f.type === t).length;
    const body = h.found.length ? `<div class="tbl-wrap" style="max-height:320px"><table class="hist-tbl">
        <thead><tr><th>סימול</th><th>שם</th><th>סוג</th><th>מחיר</th><th>SMA</th><th>פער %</th><th>נפח</th></tr></thead>
        <tbody>${h.found.map(f => {
          const [lbl, cls] = H_TYPE[f.type] || ['', ''];
          return `<tr>
            <td class="tsym">${esc(f.sym)}</td>
            <td class="tname">${esc(f.name)}</td>
            <td class="${cls}">${lbl}${f.ago > 0 ? ' (לפני ' + f.ago + ' נרות)' : ''}</td>
            <td>${fmt$(f.price)}</td>
            <td style="color:var(--blue)">${fmt$(f.ma)}</td>
            <td class="${f.diff >= 0 ? 'up' : 'dn'}">${fmtP(f.diff)}</td>
            <td>${f.vol != null ? f.vol.toFixed(1) + 'x' : '—'}</td></tr>`;
        }).join('')}</tbody></table></div>`
      : '<div class="empty">לא נמצאו חציות / סיגנלים בסריקה הזו</div>';
    return `<details class="hist-item"${histOpen.has(h.id) ? ' open' : ''} ontoggle="histToggle(${h.id}, this.open)">
      <summary>
        <span class="hist-time">${esc(h.time)}</span>
        <span class="hist-meta">${esc(h.list)} · ${esc(h.tf)} SMA${h.mp} · קרוב ${h.near}%</span>
        <span class="badge green">🟢 ${cnt('buy')}</span>
        <span class="badge amber">🔔 ${cnt('up') + cnt('down')}</span>
        <span class="badge vol">⚡ ${cnt('near')}</span>
        <span class="hist-meta">נסרקו ${h.scanned} · ↑${h.above} ↓${h.below}${h.partial ? ' · <b style="color:var(--amber)">חלקית</b>' : ''}</span>
        <button type="button" class="icon-btn hist-del" title="מחק סריקה זו" onclick="event.preventDefault();deleteHistoryItem(${h.id})">🗑</button>
      </summary>${body}</details>`;
  }).join('');
}

function histToggle(id, open) { open ? histOpen.add(id) : histOpen.delete(id); }

function deleteHistoryItem(id) {
  history = history.filter(h => h.id !== id);
  histOpen.delete(id);
  persistHistory();
  renderHistory();
}

function clearHistory() {
  if (!history.length) return;
  if (!confirm('למחוק את כל היסטוריית הסריקות? (' + history.length + ' סריקות)')) return;
  history = [];
  histOpen.clear();
  try { localStorage.removeItem(HK); } catch (e) {}
  renderHistory();
}
