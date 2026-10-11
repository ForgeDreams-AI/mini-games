/*****************************************************************
 * MINI GAMES — shared leaderboard backend (canonical multi-game)
 * Games: daily-race, daily-atlas, daily-baseball, daily-putt (add new games below)
 *
 * Tabs (auto-created on first use):
 *   users        — SHARED identity across all mini-games
 *                  username_key | display_name | phrase_hash | created_at
 *   daily-race   — scores: date | username_key | display_name | score | submitted_at
 *   daily-atlas  — scores: date | username_key | display_name | score | submitted_at
 *   daily-baseball — scores: date | username_key | display_name | score | submitted_at
 *                  (score is encoded: W*1e6 + (diff+50)*1e4 + runsFor*100 + runsAgainst)
 *
 * ---- DEPLOY (one time, ~3 minutes) ----
 * 1. Create a Google Sheet (name it e.g. "Mini Games Leaderboard").
 * 2. Extensions > Apps Script. Delete the default code, paste this file, Save.
 * 3. Deploy > New deployment > type "Web app".
 *    - Execute as: Me
 *    - Who has access: Anyone
 *    - Deploy, authorize, copy the Web app URL.
 * 4. Paste that URL into each game's LEADERBOARD_URL constant.
 *    daily-atlas: games/daily-atlas/index.html  (LEADERBOARD_URL)
 *    daily-race:  LEADERBOARD_URL in the race game file
 * 5. To add a new game later: add its id to GAME_IDS + BEST_MODE below,
 *    set its LEADERBOARD_URL — no backend changes needed.
 *
 * ---- USERNAME RULES ----
 * Usernames are claimable, first come first served. No accounts, no email.
 * Claim:  POST {action:'claim', username, hash}
 *         hash = SHA-256 hex of (lowercase_username + "|" + secret phrase)
 *         The server NEVER sees the phrase itself — only the hash.
 * Taken:  same call verifies the phrase; wrong phrase = rejected.
 * Note shown to players: "don't lose your phrase — there's no reset."
 * Allowed: 1-16 chars, letters / numbers / spaces. Case-insensitive unique,
 * original casing kept for display.
 *
 * ---- API ----
 * GET  ?action=board&game=<id>&date=YYYY-MM-DD
 *        -> {ok, count, entries:[{display, score}] (best first, max 100)}
 * GET  ?action=check&username=<name>      -> {ok, taken}
 * GET  ?action=verify&username=<name>&hash=<hex> -> {ok}
 * POST {action:'claim', username, hash}   -> {ok, claimed} | {ok:false, error}
 * POST {action:'submit', game, date, username, hash, score}
 *        -> {ok, rank, count, percentile} | {ok:false, error}
 * Score posts keep the BEST per username per day (min for race times,
 * max for quiz scores — see BEST_MODE).
 *****************************************************************/

var TAB_USERS = 'users';

// Game id -> score tab name (tab name = game id by convention)
var GAME_IDS = ['daily-race', 'daily-atlas', 'daily-baseball', 'daily-putt', 'daily-challenge'];

// Which score wins per game: 'min' = lower is better (race times, putt strokes),
// 'max' = higher is better (quiz scores, baseball encoded W/diff).
var BEST_MODE = {
  'daily-race': 'min',
  'daily-atlas': 'max',
  'daily-baseball': 'max',
  'daily-putt': 'min',
  'daily-challenge': 'min'  // composite: pos*1e6 + timeMs (lower wins = better position, tiebreak by time)
};

var USERS_HEADERS = ['username_key', 'display_name', 'phrase_hash', 'created_at'];
var SCORE_HEADERS = ['date', 'username_key', 'display_name', 'score', 'submitted_at'];

/* ---------------- HTTP entry points ---------------- */

function doGet(e) {
  var p = (e && e.parameter) || {};
  var action = String(p.action || '');
  if (action === 'board')  return _json(_board(String(p.game || ''), String(p.date || '')));
  if (action === 'check')  return _json(_check(String(p.username || '')));
  if (action === 'verify') return _json(_verify(String(p.username || ''), String(p.hash || '')));
  return _json({ ok: false, error: 'bad_action' });
}

function doPost(e) {
  var p = {};
  try { p = JSON.parse(e.postData.contents); } catch (err) { return _json({ ok: false, error: 'bad_json' }); }
  var action = String(p.action || '');
  if (action === 'claim')  return _json(_claim(p));
  if (action === 'submit') return _json(_submit(p));
  return _json({ ok: false, error: 'bad_action' });
}

/* ---------------- usernames (shared) ---------------- */

function _check(username) {
  var key = _key(username);
  if (!_validName(username)) return { ok: false, error: 'invalid_name' };
  var u = _findUser(_sheet(TAB_USERS, USERS_HEADERS), key);
  return { ok: true, taken: !!u };
}

function _verify(username, hash) {
  var u = _findUser(_sheet(TAB_USERS, USERS_HEADERS), _key(username));
  return { ok: !!u && u.hash === String(hash || '').toLowerCase() };
}

function _claim(p) {
  var display = String(p.username || '').trim();
  var key = _key(display);
  var hash = String(p.hash || '').toLowerCase();
  if (!_validName(display)) return { ok: false, error: 'invalid_name' };
  if (!/^[0-9a-f]{64}$/.test(hash)) return { ok: false, error: 'bad_hash' };

  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var sh = _sheet(TAB_USERS, USERS_HEADERS);
    var u = _findUser(sh, key);
    if (!u) {
      sh.appendRow([key, display, hash, new Date().toISOString()]);
      return { ok: true, claimed: true };
    }
    if (u.hash === hash) return { ok: true, claimed: false };
    return { ok: false, error: 'wrong_phrase' };
  } finally {
    lock.releaseLock();
  }
}

/* ---------------- scores (per game) ---------------- */

function _submit(p) {
  var game = String(p.game || '');
  var date = String(p.date || '');
  var display = String(p.username || '').trim();
  var key = _key(display);
  var hash = String(p.hash || '').toLowerCase();
  var score = Number(p.score);

  if (GAME_IDS.indexOf(game) < 0) return { ok: false, error: 'bad_game' };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { ok: false, error: 'bad_date' };
  if (!/^[0-9a-f]{64}$/.test(hash)) return { ok: false, error: 'bad_hash' };
  if (!isFinite(score)) return { ok: false, error: 'bad_score' };

  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var u = _findUser(_sheet(TAB_USERS, USERS_HEADERS), key);
    if (!u || u.hash !== hash) return { ok: false, error: 'auth' };

    var sh = _sheet(game, SCORE_HEADERS);
    var rows = _rows(sh);
    var idx = -1;
    for (var i = 0; i < rows.length; i++) {
      if (String(rows[i][0]) === date && String(rows[i][1]) === key) { idx = i; break; }
    }
    var better = _betterFn(game);
    var now = new Date().toISOString();
    if (idx >= 0) {
      if (better(score, Number(rows[idx][3]))) {
        sh.getRange(idx + 2, 3).setValue(u.display); // display_name
        sh.getRange(idx + 2, 4).setValue(score);     // score
        sh.getRange(idx + 2, 5).setValue(now);       // submitted_at
      }
    } else {
      sh.appendRow([date, key, u.display, score, now]);
    }

    var all = _rows(sh)
      .filter(function (r) { return String(r[0]) === date; })
      .map(function (r) { return { key: String(r[1]), display: String(r[2]), score: Number(r[3]) }; });
    all.sort(_sortFn(game));
    var rank = -1;
    for (var j = 0; j < all.length; j++) { if (all[j].key === key) { rank = j + 1; break; } }
    var beaten = all.filter(function (r) { return better(score, r.score); }).length;
    var percentile = all.length > 1 ? Math.round(100 * beaten / (all.length - 1)) : 100;
    return { ok: true, rank: rank, count: all.length, percentile: percentile };
  } finally {
    lock.releaseLock();
  }
}

function _board(game, date) {
  if (GAME_IDS.indexOf(game) < 0) return { ok: false, error: 'bad_game' };
  var sh = _sheet(game, SCORE_HEADERS);
  var all = _rows(sh)
    .filter(function (r) { return String(r[0]) === date; })
    .map(function (r) { return { display: String(r[2]), score: Number(r[3]) }; });
  all.sort(_sortFn(game));
  return { ok: true, count: all.length, entries: all.slice(0, 100) };
}

/* ---------------- helpers ---------------- */

function _json(o) {
  return ContentService.createTextOutput(JSON.stringify(o))
    .setMimeType(ContentService.MimeType.JSON);
}

function _sheet(name, headers) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.appendRow(headers);
    sh.setFrozenRows(1);
  }
  return sh;
}

function _rows(sh) {
  var vals = sh.getDataRange().getValues();
  return vals.length > 1 ? vals.slice(1) : [];
}

// Case-insensitive identity key; original casing kept for display.
function _key(u) { return String(u || '').trim().toLowerCase(); }

function _validName(u) {
  var s = String(u || '').trim();
  return s.length >= 1 && s.length <= 16 && /^[A-Za-z0-9 ]+$/.test(s);
}

function _findUser(sh, key) {
  var rows = _rows(sh);
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i][0]) === key) {
      return { row: i + 2, key: key, display: String(rows[i][1]), hash: String(rows[i][2]).toLowerCase() };
    }
  }
  return null;
}

function _betterFn(game) {
  return BEST_MODE[game] === 'min'
    ? function (a, b) { return a < b; }
    : function (a, b) { return a > b; };
}

function _sortFn(game) {
  return BEST_MODE[game] === 'min'
    ? function (a, b) { return a.score - b.score; }
    : function (a, b) { return b.score - a.score; };
}
