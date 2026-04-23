// ═══════════════════════════════════════════════════════════════════════
// WOLF ADVISOR — Cloudflare Worker v2 (autonome 24/7)
// ───────────────────────────────────────────────────────────────────────
// Rôles :
//  1. Proxy HTTP vers Yahoo Finance + RSS (inchangé depuis v1)
//  2. Cron autonome toutes les 5 min pendant les heures Euronext
//     qui scanne la watchlist PEA, calcule les scores Wolf, émet des
//     signaux DIP ACHAT et envoie des notifications Discord
//  3. Stockage persistant des signaux via Cloudflare KV
//  4. Routes HTTP /signals et /state pour qu'index.html lise le résultat
//
// Bindings requis (configurer dans Cloudflare → Settings → Variables) :
//   - KV namespace "WOLF_DATA" → binding variable "WOLF_DATA"
//   - Secret "DISCORD_WEBHOOK" → URL complète du webhook Discord
//   - Cron trigger: */5 * * * *  (toutes les 5 minutes)
//
// Sécurité : CORS ouvert (*) — c'est un proxy personnel protégé par
// l'obscurité de l'URL workers.dev. Pour restreindre à ton domaine
// GitHub Pages, change ALLOWED_ORIGIN ci-dessous.
// ═══════════════════════════════════════════════════════════════════════

const ALLOWED_ORIGIN = 'https://benjaminc83.github.io';

// ─── Authentification par token ───
// Les routes sensibles (/signals, /state, /scan-now) requièrent un header
// X-Wolf-Token identique au secret WOLF_TOKEN configuré dans Cloudflare.
// Les routes proxy (/yahoo, /rss, /health) restent ouvertes car elles
// ne contiennent aucune donnée personnelle.
function checkAuth(request, env) {
  const token = env.WOLF_TOKEN;
  if (!token) return true; // pas de token configuré = pas de protection (backward compat)
  const header = request.headers.get('X-Wolf-Token') || '';
  return header === token;
}

// ─── Watchlist PEA (94 instruments, extraite d'INSTRUMENTS côté front) ───
const WATCHLIST = [
  // ETF PEA Monde/US/Europe/Émergents
  'CW8.PA','AWLD.PA','IWSW.PA','EWLD.PA','WPEA.PA','XWD9.PA',
  'ESPE.PA','ESPS.PA','500.PA','P500.PA','PSP5.PA',
  'PUST.PA','PANX.PA',
  'C40.PA','BCAC.PA','CAC.PA','DX2J.PA','ESE.PA','PC1.PA',
  'PRIEU.PA','EEUR.PA','MSE.PA','CSSX5E.PA','EUE.PA','H50E.PA','MMS.PA','PREU.PA','MEU.PA','EXSA.PA','MEUD.PA','EXS1.PA',
  'DAXX.PA','IBEX.PA','IMIB.PA',
  'PAEEM.PA','PLEM.PA','PTPXE.PA','PNKY.PA','SMCP.PA','IEUS.PA','RS2K.PA',
  'ENRG.PA','HLTH.PA','WFIN.PA','INDU.PA','WTCH.PA','COND.PA','UTIL.PA',
  'LVC.PA','SHC.PA','LVE.PA',
  'OBLI.PA','AGG.PA',
  // Actions CAC 40 + mid-caps principales
  'MC.PA','TTE.PA','AIR.PA','SAN.PA','BNP.PA','RMS.PA','CS.PA','STLAM.PA','SU.PA','SAF.PA',
  'KER.PA','BN.PA','DG.PA','AI.PA','OR.PA','RI.PA','ML.PA','GLE.PA','ACA.PA','EL.PA',
  'CAP.PA','STM.PA','ENGI.PA','ORA.PA','HO.PA','LR.PA','SGO.PA','RNO.PA','EN.PA','PUB.PA',
  'ALO.PA','DSY.PA','TEP.PA','ERF.PA','SW.PA','GTT.PA','BIM.PA','DIM.PA','IPN.PA','SOI.PA','FGR.PA',
];

const CAC_SYMBOL = '%5EFCHI';

const SCAN_PARAMS = {
  MIN_SCORE:       60,
  MIN_CHG_PCT:     -1.5,
  MAX_VOL:         5,
  DEDUP_DAYS:      7,
  SIGNAL_LIFE_DAYS: 30,
  MIN_NET_PERF:    6,
  TRADE_TICKET:    600,
  STARTER_PCT:     0.0035,
  CRASH_THRESHOLD: -2,
  // Ratio volume jour / moyenne 20j minimum pour valider un dip.
  // 1.0 = volume au moins égal à la moyenne (dip "convaincant").
  // Mettre 0 pour désactiver le filtre.
  MIN_VOL_RATIO:   1.0,
};

const RSS_SOURCES = {
  finance:     'https://news.google.com/rss/search?q=bourse+CAC+40+marchés+actions&hl=fr&gl=FR&ceid=FR:fr',
  geopolitics: 'https://news.google.com/rss/search?q=économie+géopolitique+BCE+Fed+tarifs&hl=fr&gl=FR&ceid=FR:fr',
  yahoo_fr:    'https://feeds.finance.yahoo.com/rss/2.0/headline?s=%5EFCHI&region=FR&lang=fr-FR',
  boursorama:  'https://news.google.com/rss/search?q=bourse+CAC+40+marchés+actions&hl=fr&gl=FR&ceid=FR:fr',
  lesechos:    'https://news.google.com/rss/search?q=économie+géopolitique+BCE+Fed+tarifs&hl=fr&gl=FR&ceid=FR:fr',
};

const CACHE_TTL = { yahoo_http: 15, yahoo_kv: 240, rss: 300 };

const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  ALLOWED_ORIGIN,
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Wolf-Token',
  'Access-Control-Max-Age':       '86400',
};

const FETCH_HEADERS = {
  'User-Agent':      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept':          'application/json, text/xml, */*',
  'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8',
};

// ═══════════════════════════════════════════════════════════════════════
// ENTRY POINTS
// ═══════════════════════════════════════════════════════════════════════

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '');
    try {
      if (path === '/health' || path === '') {
        return jsonResponse({
          ok: true, worker: 'wolf-advisor', version: 'v2',
          time: new Date().toISOString(),
          watchlist_size: WATCHLIST.length,
        });
      }
      if (path.startsWith('/yahoo/')) {
        const symbol = decodeURIComponent(path.slice(7));
        if (!symbol || !/^[A-Z0-9.\-=^%]+$/i.test(symbol)) return errorResponse(400, 'Symbole invalide');
        const range    = url.searchParams.get('range')    || '3mo';
        const interval = url.searchParams.get('interval') || '1d';
        return await handleYahooHttp(symbol, range, interval, ctx);
      }
      if (path.startsWith('/rss/')) {
        const source = path.slice(5);
        if (!RSS_SOURCES[source]) return errorResponse(404, `Source RSS inconnue. Disponibles : ${Object.keys(RSS_SOURCES).join(', ')}`);
        return await handleRss(source, ctx);
      }
      // ── Nouvelles routes v2 (protégées par token) ─────────────
      if (path === '/signals') {
        if (!checkAuth(request, env)) return errorResponse(403, 'Token invalide');
        return await handleGetSignals(env);
      }
      if (path.startsWith('/signals/close/')) {
        if (!checkAuth(request, env)) return errorResponse(403, 'Token invalide');
        if (request.method !== 'POST') return errorResponse(405, 'POST requis');
        const id = path.slice(15);
        return await handleCloseSignal(env, id);
      }
      if (path === '/state') {
        if (!checkAuth(request, env)) return errorResponse(403, 'Token invalide');
        return await handleGetState(env);
      }
      if (path === '/scan-now') {
        if (!checkAuth(request, env)) return errorResponse(403, 'Token invalide');
        const result = await runScan(env, ctx);
        return jsonResponse({ ok: true, scan: result });
      }
      // ── Routes alertes côté Worker (priorité 2) ─────────────
      if (path === '/alerts') {
        if (!checkAuth(request, env)) return errorResponse(403, 'Token invalide');
        if (request.method === 'POST') {
          return await handleAddAlert(env, request);
        }
        return await handleGetAlerts(env);
      }
      if (path.startsWith('/alerts/delete/')) {
        if (!checkAuth(request, env)) return errorResponse(403, 'Token invalide');
        if (request.method !== 'POST') return errorResponse(405, 'POST requis');
        const alertId = path.slice(15);
        return await handleDeleteAlert(env, alertId);
      }
      return errorResponse(404, 'Route inconnue');
    } catch (err) {
      return errorResponse(500, 'Erreur Worker : ' + err.message);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runScan(env, ctx));
  },
};

// ═══════════════════════════════════════════════════════════════════════
// SCAN AUTONOME
// ═══════════════════════════════════════════════════════════════════════

async function runScan(env, ctx) {
  const startedAt = Date.now();
  const log = {
    startedAt: new Date(startedAt).toISOString(),
    status: 'pending',
    scanned: 0, errors: 0, new_signals: 0,
    low_volume_skipped: 0, stooq_fallback: 0,
    skipped_reason: null,
  };

  // Cache local au scan : évite les re-fetch en cascade (scoring + P&L + alertes).
  const scanCache = new Map();

  try {
    if (!isMarketTradingTime()) {
      log.status = 'skipped';
      log.skipped_reason = 'market_closed_or_edge_time';
      await appendScanLog(env, log);
      return log;
    }

    const cacData = await fetchYahooForScan(env, CAC_SYMBOL, scanCache);
    if (cacData && cacData.chgPct <= SCAN_PARAMS.CRASH_THRESHOLD) {
      log.status = 'skipped';
      log.skipped_reason = `crash_filter_cac_${cacData.chgPct.toFixed(2)}pct`;
      log.cac_chg = cacData.chgPct;
      await appendScanLog(env, log);
      return log;
    }
    log.cac_chg = cacData ? round(cacData.chgPct, 2) : null;

    const signals = await getSignals(env);
    const newSignals = [];

    for (const symbol of WATCHLIST) {
      try {
        const data = await fetchYahooForScan(env, symbol, scanCache);
        if (!data || !data.closes || data.closes.length < 20) {
          log.errors++;
          continue;
        }
        if (data.source === 'stooq') log.stooq_fallback++;
        log.scanned++;

        const chg = data.chgPct || 0;
        const closes = data.closes;
        const volumes = data.volumes || [];
        const rsi = calcRSI(closes, 14);
        const vol = calcVol(closes, 20);
        const score = computeWolfScore(chg, rsi, vol);

        if (score < SCAN_PARAMS.MIN_SCORE) continue;
        if (chg > SCAN_PARAMS.MIN_CHG_PCT) continue;
        if (vol !== null && vol > SCAN_PARAMS.MAX_VOL) continue;

        // Filtre volume : un dip sans volume = piège (vente en faible conviction).
        const avgVol20 = calcAvgVolume(volumes, 20);
        const todayVol = volumes.length ? volumes[volumes.length - 1] : 0;
        let volRatio = null;
        if (SCAN_PARAMS.MIN_VOL_RATIO > 0 && avgVol20 && todayVol > 0) {
          volRatio = todayVol / avgVol20;
          if (volRatio < SCAN_PARAMS.MIN_VOL_RATIO) {
            log.low_volume_skipped++;
            continue;
          }
        }

        const recent = signals.find(s =>
          s.sym === symbol &&
          s.status === 'pending' &&
          Date.now() - s.emittedAt < SCAN_PARAMS.DEDUP_DAYS * 86400000
        );
        if (recent) continue;

        const sig = {
          id: 'sig_' + Date.now() + '_' + symbol.replace(/[^A-Z0-9]/gi, ''),
          sym: symbol,
          name: symbol,
          emittedAt: Date.now(),
          emittedDate: new Date().toISOString().slice(0, 10),
          buyPrice: round(data.price, 2),
          score: score,
          rsi: rsi,
          vol: vol !== null ? round(vol, 2) : null,
          volRatio: volRatio !== null ? round(volRatio, 2) : null,
          chgAtEmission: round(chg, 2),
          ticket: SCAN_PARAMS.TRADE_TICKET,
          status: 'pending',
          currentPrice: round(data.price, 2),
          peakPct: 0,
          peakAt: null,
          netPct: null,
          netPnl: null,
          dataSource: data.source || 'yahoo',
          source: 'worker_cron',
        };
        signals.unshift(sig);
        newSignals.push(sig);
      } catch (e) {
        log.errors++;
      }
    }

    // ── Suivi P&L live des signaux pending (priorité 1) ──
    // À chaque scan, on recalcule le cours actuel de chaque signal en cours,
    // on met à jour le high watermark, et on notifie Discord si seuil approché/atteint.
    const pnlAlerts = await updateSignalsPnL(env, signals, scanCache);

    autoCloseExpiredSignals(signals);
    await saveSignals(env, signals);

    for (const sig of newSignals) {
      await sendDiscordSignal(env, sig);
    }
    // Envoi des alertes P&L après les signaux (pour ne pas spammer)
    for (const alert of pnlAlerts) {
      await sendDiscordPnLAlert(env, alert);
    }

    // ── Vérification des alertes utilisateur côté Worker (priorité 2) ──
    const alertResults = await checkWorkerAlerts(env, scanCache);
    log.alerts_triggered = alertResults.length;

    log.status = 'ok';
    log.new_signals = newSignals.length;
    log.pnl_alerts = pnlAlerts.length;
    log.total_signals_tracked = signals.length;
    log.durationMs = Date.now() - startedAt;
    await appendScanLog(env, log);
    await env.WOLF_DATA.put('last_scan', JSON.stringify(log));

    // ── Résumé Discord quotidien (priorité 4) ──
    // Envoyé une seule fois entre 17h35 et 17h39 (heure Paris)
    await maybeSendDailySummary(env, log, signals, cacData);

    return log;
  } catch (err) {
    log.status = 'error';
    log.error = err.message;
    log.durationMs = Date.now() - startedAt;
    await appendScanLog(env, log).catch(() => {});
    throw err;
  }
}

// ═══════════════════════════════════════════════════════════════════════
// INDICATEURS
// ═══════════════════════════════════════════════════════════════════════

function calcRSI(closes, period = 14) {
  if (!closes || closes.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff; else losses += Math.abs(diff);
  }
  const rs = (gains / period) / ((losses / period) || 0.001);
  return Math.round(100 - (100 / (1 + rs)));
}

function calcVol(closes, period = 20) {
  if (!closes || closes.length < period + 1) return null;
  const slice = closes.slice(-(period + 1));
  const rets = [];
  for (let i = 1; i < slice.length; i++) rets.push((slice[i] - slice[i - 1]) / slice[i - 1]);
  const mean = rets.reduce((s, r) => s + r, 0) / rets.length;
  const variance = rets.reduce((s, r) => s + (r - mean) * (r - mean), 0) / rets.length;
  return Math.sqrt(variance) * 100;
}

function computeWolfScore(chgPct, rsi, vol) {
  let score = 0;
  if (chgPct < -4) score += 35;
  else if (chgPct < -2.5) score += 25;
  else if (chgPct < -1.5) score += 12;
  if (rsi < 30) score += 30;
  else if (rsi < 40) score += 20;
  else if (rsi < 50) score += 10;
  score += 10;
  if (vol !== null) {
    if (vol > 4) score -= 25;
    else if (vol > 2.5) score -= 15;
    else if (vol > 1.5) score -= 5;
  }
  return Math.max(0, Math.min(100, score));
}

function autoCloseExpiredSignals(signals) {
  const now = Date.now();
  for (const sig of signals) {
    if (sig.status !== 'pending') continue;
    if (now - sig.emittedAt > SCAN_PARAMS.SIGNAL_LIFE_DAYS * 86400000) {
      const netPct = parseFloat(sig.netPct || 0);
      sig.status = netPct >= SCAN_PARAMS.MIN_NET_PERF ? 'hit' : 'miss';
      sig.closedDate = new Date().toISOString().slice(0, 10);
      sig.closeReason = 'expired_30d';
    }
  }
}

// ─── Suivi P&L live des signaux (priorité 1) ────────────────────────
// Recalcule le cours actuel, le P&L net, et le high watermark de chaque
// signal en cours. Retourne un tableau d'alertes Discord à envoyer.
// Seuils de notification : 50%, 75%, 100% de l'objectif (+6% net).
// Un signal ne notifie qu'une seule fois par palier (via lastAlertPct).
async function updateSignalsPnL(env, signals, scanCache = null) {
  const alerts = [];
  const pending = signals.filter(s => s.status === 'pending');
  if (!pending.length) return alerts;

  for (const sig of pending) {
    try {
      const data = await fetchYahooForScan(env, sig.sym, scanCache);
      if (!data || !data.price) continue;

      const buyPrice = parseFloat(sig.buyPrice);
      const currentPrice = data.price;
      const ticket = sig.ticket || SCAN_PARAMS.TRADE_TICKET;
      const qty = Math.floor(ticket / buyPrice);
      if (qty < 1) continue;

      const amount = qty * buyPrice;
      const buyFee = amount * SCAN_PARAMS.STARTER_PCT;
      const sellAmt = qty * currentPrice;
      const sellFee = sellAmt * SCAN_PARAMS.STARTER_PCT;
      const netPnl = sellAmt - amount - buyFee - sellFee;
      const netPct = (netPnl / amount) * 100;

      // Mise à jour du signal
      sig.currentPrice = round(currentPrice, 2);
      sig.netPct = round(netPct, 2);
      sig.netPnl = round(netPnl, 2);

      // High watermark
      const prevPeak = sig.peakPct || 0;
      if (netPct > prevPeak) {
        sig.peakPct = round(netPct, 2);
        sig.peakAt = new Date().toISOString();
      }

      // Alertes par palier — ne notifie qu'une fois par seuil franchi
      const target = SCAN_PARAMS.MIN_NET_PERF; // 6%
      const lastAlert = sig.lastAlertPct || 0;
      const thresholds = [
        { pct: target * 0.50, label: '50%',  emoji: '🟡' },
        { pct: target * 0.75, label: '75%',  emoji: '🟠' },
        { pct: target,        label: '100%', emoji: '🟢' },
      ];

      for (const t of thresholds) {
        if (netPct >= t.pct && lastAlert < t.pct) {
          sig.lastAlertPct = round(t.pct, 2);
          alerts.push({
            emoji: t.emoji,
            label: t.label,
            sym: sig.sym,
            name: sig.name || sig.sym,
            netPct: round(netPct, 2),
            target: target,
            buyPrice: buyPrice,
            currentPrice: round(currentPrice, 2),
            peakPct: sig.peakPct,
            ageDays: Math.round((Date.now() - sig.emittedAt) / 86400000),
          });
          break; // un seul palier par scan
        }
      }
    } catch (e) {
      // Erreur sur un signal individuel, on continue les autres
    }
  }
  return alerts;
}

async function sendDiscordPnLAlert(env, alert) {
  const webhook = env.DISCORD_WEBHOOK;
  if (!webhook) return;
  const content = [
    `${alert.emoji} **Signal Wolf — ${alert.label} objectif** · ${alert.name}`,
    `Perf. nette : **${alert.netPct >= 0 ? '+' : ''}${alert.netPct}%** / +${alert.target}%`,
    `Cours : ${alert.buyPrice}€ → ${alert.currentPrice}€ · Peak : +${alert.peakPct || alert.netPct}%`,
    `⏱ ${alert.ageDays}j depuis le signal`,
  ].join('\n');
  try {
    await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: '🐺 Wolf Advisor', content }),
    });
  } catch (e) {}
}

// ─── Résumé Discord quotidien (priorité 4) ──────────────────────────
// Envoyé une seule fois par jour entre 17h35 et 17h39 (heure Paris).
// Anti-doublon via KV : on stocke la date du dernier résumé envoyé.
async function maybeSendDailySummary(env, log, signals, cacData) {
  const webhook = env.DISCORD_WEBHOOK;
  if (!webhook) return;

  const now = new Date();
  const paris = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Paris' }));
  const minutes = paris.getHours() * 60 + paris.getMinutes();
  const day = paris.getDay();

  // Seulement entre 17h35 et 17h39, en semaine
  if (day === 0 || day === 6) return;
  if (minutes < 1055 || minutes > 1059) return;

  // Anti-doublon : vérifier si déjà envoyé aujourd'hui
  const todayStr = paris.toISOString().slice(0, 10);
  try {
    const lastSummary = await env.WOLF_DATA.get('last_daily_summary');
    if (lastSummary === todayStr) return;
  } catch (e) {}

  // Construire le résumé
  const pending = signals.filter(s => s.status === 'pending');
  const todaySignals = signals.filter(s => {
    const d = s.emittedDate || new Date(s.emittedAt).toISOString().slice(0, 10);
    return d === todayStr;
  });

  const cacStr = cacData && cacData.chgPct !== undefined
    ? (cacData.chgPct >= 0 ? '+' : '') + round(cacData.chgPct, 2) + '%'
    : '—';

  // P&L résumé des signaux pending
  let pnlSummary = '';
  if (pending.length) {
    const best = pending.reduce((a, b) => (parseFloat(a.netPct || 0) > parseFloat(b.netPct || 0) ? a : b));
    const worst = pending.reduce((a, b) => (parseFloat(a.netPct || 0) < parseFloat(b.netPct || 0) ? a : b));
    pnlSummary = '\n📊 **Signaux en cours** (' + pending.length + ')'
      + '\n> Meilleur : ' + (best.name || best.sym) + ' ' + (parseFloat(best.netPct || 0) >= 0 ? '+' : '') + (best.netPct || 0) + '% net'
      + '\n> Pire : ' + (worst.name || worst.sym) + ' ' + (parseFloat(worst.netPct || 0) >= 0 ? '+' : '') + (worst.netPct || 0) + '% net';
  }

  const dayNames = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];
  const nextDay = day === 5 ? 'lundi' : dayNames[day + 1];

  const content = [
    '🐺 **Bilan Wolf — ' + todayStr + '**',
    '> ' + log.scanned + ' titres scannés · ' + todaySignals.length + ' signal(s) émis aujourd\'hui',
    '> CAC 40 : ' + cacStr + ' · Erreurs scan : ' + (log.errors || 0),
    pnlSummary,
    '⏱ Prochain scan : ' + nextDay + ' 9h15',
  ].filter(Boolean).join('\n');

  try {
    await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: '🐺 Wolf Advisor', content }),
    });
    // Marquer comme envoyé
    await env.WOLF_DATA.put('last_daily_summary', todayStr);
  } catch (e) {}
}

// ═══════════════════════════════════════════════════════════════════════
// FETCH MARCHÉ (scan) — cache local + KV + fallback Stooq
// ───────────────────────────────────────────────────────────────────────
// Ordre de priorité :
//   1. Cache en mémoire du scan en cours (scanCache Map) — mutualise
//      les appels entre scoring, suivi P&L et alertes (1 fetch par symbole
//      et par scan au lieu de 2-3).
//   2. Cache KV (240s) partagé entre scans proches.
//   3. Yahoo Finance (source primaire).
//   4. Stooq (fallback gratuit si Yahoo échoue — pas de clé requise).
//
// Retourne { price, chgPct, closes, volumes, fetchedAt, source }.
// Les tableaux closes/volumes sont alignés (même index = même jour).
// ═══════════════════════════════════════════════════════════════════════

async function fetchYahooForScan(env, symbol, scanCache = null) {
  if (scanCache && scanCache.has(symbol)) return scanCache.get(symbol);

  const cacheKey = 'cache:yahoo:' + symbol;
  try {
    const cached = await env.WOLF_DATA.get(cacheKey, 'json');
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL.yahoo_kv * 1000) {
      if (scanCache) scanCache.set(symbol, cached.data);
      return cached.data;
    }
  } catch (e) {}

  let data = await tryFetchYahoo(symbol);
  if (!data) data = await tryFetchStooq(symbol);

  if (data) {
    await env.WOLF_DATA.put(cacheKey, JSON.stringify({ data, fetchedAt: Date.now() }), {
      expirationTtl: Math.max(60, CACHE_TTL.yahoo_kv * 2),
    }).catch(() => {});
    if (scanCache) scanCache.set(symbol, data);
  }
  return data;
}

async function tryFetchYahoo(symbol) {
  const yahooUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=3mo`;
  let attempts = 0;
  while (attempts < 2) {
    try {
      const r = await fetch(yahooUrl, { headers: FETCH_HEADERS });
      if (!r.ok) { attempts++; continue; }
      const json = await r.json();
      const q = json?.chart?.result?.[0];
      if (!q) { attempts++; continue; }
      const meta = q.meta;
      const rawCloses = q.indicators?.quote?.[0]?.close || [];
      const rawVolumes = q.indicators?.quote?.[0]?.volume || [];
      const closes = [];
      const volumes = [];
      for (let i = 0; i < rawCloses.length; i++) {
        if (rawCloses[i] !== null && rawCloses[i] !== undefined) {
          closes.push(rawCloses[i]);
          volumes.push(rawVolumes[i] != null ? rawVolumes[i] : 0);
        }
      }
      const price = meta.regularMarketPrice || meta.previousClose;
      const prev = meta.chartPreviousClose || meta.previousClose;
      return {
        price: price,
        chgPct: prev ? ((price - prev) / prev) * 100 : 0,
        closes: closes,
        volumes: volumes,
        fetchedAt: Date.now(),
        source: 'yahoo',
      };
    } catch (e) {
      attempts++;
    }
  }
  return null;
}

// Stooq : fallback CSV gratuit. Mapping Paris : SYM.PA → sym.fr, ^FCHI → ^cac.
function mapToStooq(symbol) {
  const s = decodeURIComponent(symbol).toUpperCase();
  if (s === '^FCHI') return '^cac';
  if (s.endsWith('.PA')) return s.slice(0, -3).toLowerCase() + '.fr';
  return null;
}

async function tryFetchStooq(symbol) {
  const stooqSym = mapToStooq(symbol);
  if (!stooqSym) return null;
  try {
    // Stooq CSV daily : Date,Open,High,Low,Close,Volume (ordre chronologique).
    const url = `https://stooq.com/q/d/l/?s=${encodeURIComponent(stooqSym)}&i=d`;
    const r = await fetch(url, { headers: FETCH_HEADERS });
    if (!r.ok) return null;
    const csv = await r.text();
    const lines = csv.trim().split(/\r?\n/);
    if (lines.length < 22) return null;
    if (!/^date,/i.test(lines[0])) return null;
    const closes = [];
    const volumes = [];
    for (let i = 1; i < lines.length; i++) {
      const parts = lines[i].split(',');
      const close = parseFloat(parts[4]);
      const volume = parseFloat(parts[5]);
      if (!isNaN(close)) {
        closes.push(close);
        volumes.push(isNaN(volume) ? 0 : volume);
      }
    }
    if (closes.length < 2) return null;
    const price = closes[closes.length - 1];
    const prev = closes[closes.length - 2];
    return {
      price: price,
      chgPct: prev ? ((price - prev) / prev) * 100 : 0,
      closes: closes,
      volumes: volumes,
      fetchedAt: Date.now(),
      source: 'stooq',
    };
  } catch (e) {
    return null;
  }
}

function calcAvgVolume(volumes, period = 20) {
  if (!volumes || volumes.length < period + 1) return null;
  const slice = volumes.slice(-(period + 1), -1);
  let sum = 0, n = 0;
  for (const v of slice) {
    if (v && v > 0) { sum += v; n++; }
  }
  return n > 0 ? sum / n : null;
}

// ═══════════════════════════════════════════════════════════════════════
// KV
// ═══════════════════════════════════════════════════════════════════════

async function getSignals(env) {
  try {
    const raw = await env.WOLF_DATA.get('signals');
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) { return []; }
}

async function saveSignals(env, signals) {
  const trimmed = signals.slice(0, 200);
  await env.WOLF_DATA.put('signals', JSON.stringify(trimmed));
}

async function appendScanLog(env, entry) {
  try {
    const raw = await env.WOLF_DATA.get('scan_log');
    const log = raw ? JSON.parse(raw) : [];
    log.unshift(entry);
    await env.WOLF_DATA.put('scan_log', JSON.stringify(log.slice(0, 50)));
  } catch (e) {}
}

// ═══════════════════════════════════════════════════════════════════════
// DISCORD
// ═══════════════════════════════════════════════════════════════════════

async function sendDiscordSignal(env, sig) {
  const webhook = env.DISCORD_WEBHOOK;
  if (!webhook) return;
  const chgStr = sig.chgAtEmission >= 0 ? '+' + sig.chgAtEmission : String(sig.chgAtEmission);
  const volStr = sig.vol !== null ? ' · Vol20j ' + sig.vol + '%' : '';
  const content = [
    '🟢 **Nouveau signal Wolf** — ' + sig.sym,
    'Score : **' + sig.score + '/100** · RSI ' + sig.rsi + volStr,
    'Cours : ' + sig.buyPrice + '€ (' + chgStr + '%)',
    'Ticket simulé : ' + sig.ticket + '€ · Objectif : +' + SCAN_PARAMS.MIN_NET_PERF + '% net',
    '⏱ ' + new Date(sig.emittedAt).toLocaleString('fr-FR', { timeZone: 'Europe/Paris' }),
  ].join('\n');
  try {
    await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: '🐺 Wolf Advisor', content: content }),
    });
  } catch (e) {}
}

// ═══════════════════════════════════════════════════════════════════════
// MARKET HOURS
// ═══════════════════════════════════════════════════════════════════════

function isMarketTradingTime() {
  const now = new Date();
  const paris = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Paris' }));
  const day = paris.getDay();
  if (day === 0 || day === 6) return false;
  const minutes = paris.getHours() * 60 + paris.getMinutes();
  return minutes >= 555 && minutes <= 1035;
}

// ═══════════════════════════════════════════════════════════════════════
// HTTP HANDLERS
// ═══════════════════════════════════════════════════════════════════════

async function handleYahooHttp(symbol, range, interval, ctx) {
  const cacheKey = new Request(`https://wolf-cache.local/yahoo/${symbol}?r=${range}&i=${interval}`);
  const cache = caches.default;
  let cached = await cache.match(cacheKey);
  if (cached) return withCors(cached, { 'X-Wolf-Cache': 'HIT' });

  const yahooUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${interval}&range=${range}`;
  const upstream = await fetch(yahooUrl, {
    headers: FETCH_HEADERS,
    cf: { cacheTtl: CACHE_TTL.yahoo_http, cacheEverything: true },
  });
  if (!upstream.ok) return errorResponse(upstream.status, `Yahoo ${upstream.status}`);
  const body = await upstream.text();
  const response = new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': `public, max-age=${CACHE_TTL.yahoo_http}`,
      'X-Wolf-Cache': 'MISS',
    },
  });
  ctx.waitUntil(cache.put(cacheKey, response.clone()));
  return withCors(response);
}

async function handleRss(source, ctx) {
  const cacheKey = new Request(`https://wolf-cache.local/rss/${source}`);
  const cache = caches.default;
  let cached = await cache.match(cacheKey);
  if (cached) return withCors(cached, { 'X-Wolf-Cache': 'HIT' });

  const upstream = await fetch(RSS_SOURCES[source], {
    headers: FETCH_HEADERS,
    cf: { cacheTtl: CACHE_TTL.rss, cacheEverything: true },
  });
  if (!upstream.ok) return errorResponse(upstream.status, `${source} ${upstream.status}`);
  const body = await upstream.text();
  const response = new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'Cache-Control': `public, max-age=${CACHE_TTL.rss}`,
      'X-Wolf-Cache': 'MISS',
    },
  });
  ctx.waitUntil(cache.put(cacheKey, response.clone()));
  return withCors(response);
}

async function handleGetSignals(env) {
  const signals = await getSignals(env);
  return jsonResponse({ ok: true, count: signals.length, signals: signals });
}

async function handleCloseSignal(env, id) {
  const signals = await getSignals(env);
  const sig = signals.find(s => s.id === id);
  if (!sig) return errorResponse(404, 'Signal introuvable');
  const netPct = parseFloat(sig.netPct || 0);
  sig.status = netPct >= SCAN_PARAMS.MIN_NET_PERF ? 'hit' : 'miss';
  sig.closedDate = new Date().toISOString().slice(0, 10);
  sig.closeReason = 'manual';
  await saveSignals(env, signals);
  return jsonResponse({ ok: true, signal: sig });
}

async function handleGetState(env) {
  const [lastScanRaw, scanLogRaw, signals] = await Promise.all([
    env.WOLF_DATA.get('last_scan'),
    env.WOLF_DATA.get('scan_log'),
    getSignals(env),
  ]);
  return jsonResponse({
    ok: true,
    market_open: isMarketTradingTime(),
    watchlist_size: WATCHLIST.length,
    signals_count: signals.length,
    signals_pending: signals.filter(s => s.status === 'pending').length,
    last_scan: lastScanRaw ? JSON.parse(lastScanRaw) : null,
    scan_log: scanLogRaw ? JSON.parse(scanLogRaw).slice(0, 10) : [],
  });
}

// ═══════════════════════════════════════════════════════════════════════
// ALERTES CÔTÉ WORKER (priorité 2)
// ═══════════════════════════════════════════════════════════════════════

async function getWorkerAlerts(env) {
  try {
    const raw = await env.WOLF_DATA.get('alerts');
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) { return []; }
}

async function saveWorkerAlerts(env, alerts) {
  await env.WOLF_DATA.put('alerts', JSON.stringify(alerts.slice(0, 100)));
}

async function handleGetAlerts(env) {
  const alerts = await getWorkerAlerts(env);
  return jsonResponse({ ok: true, count: alerts.length, alerts });
}

async function handleAddAlert(env, request) {
  try {
    const body = await request.json();
    if (!body.sym || !body.cond) return errorResponse(400, 'sym et cond requis');
    const alerts = await getWorkerAlerts(env);
    const alert = {
      id: 'wa_' + Date.now() + '_' + (body.sym || '').replace(/[^A-Z0-9]/gi, ''),
      sym: body.sym,
      assetName: body.assetName || body.sym,
      isin: body.isin || '',
      cond: body.cond,
      val: parseFloat(body.val) || 0,
      expires: body.expires || null,
      discord: body.discord !== false,
      push: body.push || false,
      triggered: false,
      expired: false,
      createdAt: Date.now(),
    };
    alerts.unshift(alert);
    await saveWorkerAlerts(env, alerts);
    return jsonResponse({ ok: true, alert });
  } catch (e) {
    return errorResponse(400, 'JSON invalide : ' + e.message);
  }
}

async function handleDeleteAlert(env, alertId) {
  const alerts = await getWorkerAlerts(env);
  const idx = alerts.findIndex(a => a.id === alertId);
  if (idx === -1) return errorResponse(404, 'Alerte introuvable');
  const removed = alerts.splice(idx, 1)[0];
  await saveWorkerAlerts(env, alerts);
  return jsonResponse({ ok: true, removed });
}

// ─── Vérification des alertes pendant le cron scan ───
// Conditions supportées : drop_pct, rise_pct, below_price, above_price,
// rsi_below, rsi_above, wolf_score.
// Les alertes MA et vs_cac nécessitent un historique de cours que le Worker
// possède déjà via fetchYahooForScan.
async function checkWorkerAlerts(env, scanCache = null) {
  const alerts = await getWorkerAlerts(env);
  const triggered = [];
  const now = Date.now();

  for (const a of alerts) {
    // Expiration
    if (a.expires && new Date(a.expires).getTime() < now && !a.triggered) {
      a.expired = true;
      continue;
    }
    if (a.triggered || a.expired) continue;

    try {
      const data = await fetchYahooForScan(env, a.sym, scanCache);
      if (!data || !data.price) continue;

      let hit = false;
      let extra = '';
      const chg = data.chgPct || 0;
      const closes = data.closes || [];

      switch (a.cond) {
        case 'drop_pct':
          if (chg <= -a.val) hit = true;
          break;
        case 'rise_pct':
          if (chg >= a.val) hit = true;
          break;
        case 'below_price':
          if (data.price <= a.val) hit = true;
          break;
        case 'above_price':
          if (data.price >= a.val) hit = true;
          break;
        case 'rsi_below': {
          const rsi = calcRSI(closes, 14);
          if (closes.length >= 15 && rsi <= a.val) { hit = true; extra = 'RSI : ' + rsi; }
          break;
        }
        case 'rsi_above': {
          const rsi = calcRSI(closes, 14);
          if (closes.length >= 15 && rsi >= a.val) { hit = true; extra = 'RSI : ' + rsi; }
          break;
        }
        case 'wolf_score': {
          const score = computeWolfScore(chg, calcRSI(closes, 14), calcVol(closes, 20));
          if (score >= a.val) { hit = true; extra = 'Score : ' + score + '/100'; }
          break;
        }
      }

      if (hit) {
        a.triggered = true;
        a.triggeredAt = new Date().toISOString();
        a.triggerPrice = round(data.price, 2);
        triggered.push(a);

        // Notification Discord
        if (a.discord) {
          const extraStr = extra ? ' · ' + extra : '';
          const content = [
            '🔔 **Alerte Wolf** — ' + (a.assetName || a.sym),
            '> ' + a.cond + ' ' + (a.val || '') + ' atteint' + extraStr,
            '> Cours : ' + round(data.price, 2) + '€ (' + (chg >= 0 ? '+' : '') + round(chg, 2) + '%)',
            '> ISIN : ' + (a.isin || a.sym),
          ].join('\n');
          const webhook = env.DISCORD_WEBHOOK;
          if (webhook) {
            try {
              await fetch(webhook, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username: '🐺 Wolf Advisor', content }),
              });
            } catch (e) {}
          }
        }
      }
    } catch (e) {
      // Erreur sur une alerte individuelle, on continue
    }
  }

  await saveWorkerAlerts(env, alerts);
  return triggered;
}

// ═══════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════

function withCors(response, extraHeaders = {}) {
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(CORS_HEADERS)) headers.set(k, v);
  for (const [k, v] of Object.entries(extraHeaders))  headers.set(k, v);
  return new Response(response.body, { status: response.status, headers });
}

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS_HEADERS },
  });
}

function errorResponse(status, message) {
  return jsonResponse({ error: true, status, message }, status);
}

function round(n, digits = 2) {
  const m = Math.pow(10, digits);
  return Math.round(n * m) / m;
}