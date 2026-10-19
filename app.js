(function(){
  "use strict";

  // Logins are plain usernames; Firebase Auth only knows emails, so each
  // username maps to a synthetic address on a reserved, non-routable TLD
  // (RFC 2606) — these aren't real inboxes and nothing is ever sent there.
  var EMAIL_DOMAIN = "season2627.invalid";
  var USERNAME_RE = /^[a-z0-9_]{3,20}$/;
  // League keys double as league ids. No 0/O/1/I so they're easy to dictate.
  var KEY_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  var KEY_LEN = 8;
  var LAST_LEAGUE_STORAGE = "season2627.lastLeague";
  var STAGES = ["league", "europe"];
  var STAGE_LABEL = { league: "Лиги", europe: "Еврокубки" };
  // The original four keep their hand-picked colours; everyone else gets a
  // hue derived from their username (see applyPlayerColor).
  var FIXED_COLORS = { egor: true, ivan: true, sasha_r: true, sasha_t: true };

  function emailFor(username){ return username + "@" + EMAIL_DOMAIN; }
  function usernameFromEmail(email){
    if(!email) return null;
    var suffix = "@" + EMAIL_DOMAIN;
    if(email.slice(-suffix.length).toLowerCase() !== suffix) return null;
    var local = email.slice(0, -suffix.length).toLowerCase();
    return USERNAME_RE.test(local) ? local : null;
  }
  function normalizeUsername(s){ return (s || "").trim().toLowerCase(); }
  function normalizeKey(s){ return (s || "").toUpperCase().replace(/[^A-Z0-9]/g, ""); }

  function generateKey(){
    var bytes = new Uint8Array(KEY_LEN);
    window.crypto.getRandomValues(bytes);
    var key = "";
    for(var i = 0; i < KEY_LEN; i++) key += KEY_ALPHABET[bytes[i] % KEY_ALPHABET.length];
    return key;
  }

  function num(el){
    if(!el) return null;
    var v = el.value.trim();
    if(v === "") return null;
    var n = Number(v);
    return isNaN(n) ? null : n;
  }

  // Renders an ISO kickoff timestamp (as learned by the sync bot from
  // API-Football) in Central European time, correctly following the
  // CET/CEST daylight-saving switch — no manual offset math needed.
  var kickoffFormatter = (typeof Intl !== "undefined") ? new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Europe/Berlin",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit"
  }) : null;
  function formatKickoffCET(iso){
    if(!iso || !kickoffFormatter) return "";
    var d = new Date(iso);
    if(isNaN(d.getTime())) return "";
    return kickoffFormatter.format(d) + " CET";
  }
  function updateKickoffNote(card, iso){
    var note = card.querySelector("[data-fd-kickoff-note]");
    if(!note) return;
    var text = formatKickoffCET(iso);
    note.textContent = text;
    note.hidden = !text;
  }

  // A match counts as "started" once there's an actual result to go on (a
  // score — the same signal used to award points), OR its cached kickoff
  // time has passed. The kickoff check matters because the sync bot only
  // checks a live match every ~10 minutes: without it, predictions would
  // stay open for however long after the real kickoff until the bot's next
  // run first writes a score. Manually-entered matches have no kickoff time
  // to go on, so for those this still only locks once a real score is
  // typed in.
  function isMatchStarted(card){
    var aH = num(card.querySelector(".actual-home"));
    var aA = num(card.querySelector(".actual-away"));
    if(aH !== null && aA !== null) return true;

    var kickoff = card.dataset.fdKickoff;
    return !!kickoff && Date.now() >= new Date(kickoff).getTime();
  }

  // Group-stage scoring — same formula for both "Лиги" and "Еврокубки" for
  // now (90 minutes only, no extra time/penalties format to guess). When
  // the eurocup knockout rounds start this will need a time-format bonus
  // again; see git history for the previous europeScorePoints/timePoints.
  function leaguePoints(aH,aA,pH,pA){
    if(aH===null||aA===null||pH===null||pA===null) return null;
    var pts = 0;
    var aSign = Math.sign(aH-aA), pSign = Math.sign(pH-pA);
    if(aSign === pSign) pts += 1;
    if((aH-aA) === (pH-pA)) pts += 1;
    if(aH===pH && aA===pA) pts += 2;
    return pts;
  }

  function badgeClass(pts, maxExact){
    if(pts === null) return "badge-pending";
    if(pts === 0) return "badge-zero";
    if(pts >= maxExact) return "badge-exact";
    return "badge-partial";
  }

  function setBadge(el, pts, maxExact){
    el.classList.remove("badge-pending","badge-zero","badge-partial","badge-exact");
    el.classList.add(badgeClass(pts, maxExact));
    el.textContent = pts === null ? "–" : (pts > 0 ? "+" + pts : String(pts));
  }

  // ---------- state ----------

  var db = null;
  var me = null;                 // signed-in username
  var myLeagues = null;          // league id -> true, null until first loaded
  var leagueNames = {};          // league id -> name (for the switcher)
  var leagueId = null;           // league currently on screen
  var league = { name: "", owner: "", members: {} }; // members: username -> joinedAt
  var names = {};                // username -> display name
  var nameWatched = {};          // username -> true once its name is being watched
  var matchCache = { league: {}, europe: {} }; // stage -> matchId -> last remote data
  var rounds = { league: 0, europe: 0 };       // stage -> current round number
  var sessionListeners = [];     // live for the whole sign-in
  var leagueListeners = [];      // live while one league is on screen
  var leagueConnected = false;

  function listen(bucket, ref, event, fn, onError){
    ref.on(event, fn, onError);
    bucket.push({ ref: ref, event: event, fn: fn });
  }
  function detachAll(bucket){
    bucket.forEach(function(l){ l.ref.off(l.event, l.fn); });
    bucket.length = 0;
  }

  function isAdmin(){ return !!me && me === league.owner; }

  function memberList(){
    var m = league.members || {};
    return Object.keys(m).sort(function(a, b){
      var da = Number(m[a]) || 0, dbb = Number(m[b]) || 0;
      if(da !== dbb) return da - dbb;
      return a < b ? -1 : (a > b ? 1 : 0);
    });
  }

  function labelFor(username){ return names[username] || username; }

  function hueFor(username){
    var h = 0;
    for(var i = 0; i < username.length; i++) h = (h * 31 + username.charCodeAt(i)) % 360;
    return h;
  }
  function applyPlayerColor(el, username){
    if(FIXED_COLORS[username]){
      el.classList.add("player-tag--" + username);
    } else {
      el.classList.add("player-tag--auto");
      el.style.setProperty("--h", String(hueFor(username)));
    }
  }

  // ---------- screens ----------

  function el(id){ return document.getElementById(id); }

  function showOnly(which){
    el("auth-screen").hidden = which !== "auth";
    el("league-screen").hidden = which !== "leagues";
    el("app-wrap").hidden = which !== "app";
    el("stage-tabs").hidden = which !== "app";
    el("session-bar").hidden = which === "auth";
  }

  function showLeagueScreen(){
    el("league-error").textContent = "";
    el("league-created").hidden = true;
    el("league-create-form").hidden = false;
    el("league-join-form").hidden = false;
    el("league-back").hidden = !leagueId;
    showOnly("leagues");
  }

  function setSyncStatus(text, mode){
    var s = el("sync-status");
    if(!s) return;
    s.textContent = text;
    s.classList.remove("sync-on","sync-off","sync-local");
    s.classList.add(mode);
  }

  // ---------- match cards ----------

  function panelFor(stage){
    return document.querySelector('.stage[data-stage-panel="' + stage + '"]');
  }

  // Each stage has two grids: the current round, and every earlier round.
  function gridFor(stage, view){
    return document.querySelector('.card-grid[data-stage-grid="' + stage + '"][data-view="' + (view || "current") + '"]');
  }

  function cardFor(stage, matchId){
    return panelFor(stage).querySelector('.match-card[data-match-id="' + matchId + '"]');
  }

  function cardRound(card){ return Number(card.dataset.round) || 0; }

  // Newest first. Firebase push keys sort chronologically as plain strings;
  // the old static seed-* cards are the oldest of all, so they always go last.
  function newestFirst(a, b){
    var ka = a.dataset.matchId || "", kb = b.dataset.matchId || "";
    var sa = ka.indexOf("seed-") === 0, sb = kb.indexOf("seed-") === 0;
    if(sa !== sb) return sa ? 1 : -1;
    return ka < kb ? 1 : (ka > kb ? -1 : 0);
  }

  // Puts every card of a stage into the right grid: the current round's
  // matches after the "add match" tile, and older rounds under the "past"
  // view, grouped by round, latest round first.
  function layoutStage(stage){
    var panel = panelFor(stage);
    var current = gridFor(stage, "current");
    var past = gridFor(stage, "past");
    var cur = rounds[stage];
    var cards = Array.prototype.slice.call(panel.querySelectorAll(".match-card")).sort(newestFirst);

    var tile = current.querySelector(".add-tile");
    if(tile) current.appendChild(tile);
    var pastCards = [];
    cards.forEach(function(card){
      if(cardRound(card) >= cur) current.appendChild(card); else pastCards.push(card);
    });

    past.querySelectorAll(".round-heading").forEach(function(h){ h.remove(); });
    pastCards.sort(function(a, b){ return (cardRound(b) - cardRound(a)) || newestFirst(a, b); });
    var lastRound = null;
    pastCards.forEach(function(card){
      var r = cardRound(card);
      if(r !== lastRound){
        var heading = document.createElement("h3");
        heading.className = "round-heading";
        heading.textContent = "Тур " + r;
        past.appendChild(heading);
        lastRound = r;
      }
      past.appendChild(card);
    });

    panel.querySelectorAll("[data-round-label]").forEach(function(l){ l.textContent = "Тур " + cur; });
    panel.querySelector("[data-past-count]").textContent = String(pastCards.length);
    updateStageView(stage);
  }

  function updateStageView(stage){
    var panel = panelFor(stage);
    var view = panel.dataset.view || "current";
    panel.querySelectorAll(".subtab").forEach(function(b){
      var on = b.dataset.view === view;
      b.classList.toggle("is-active", on);
      b.setAttribute("aria-selected", on ? "true" : "false");
    });
    var currentCount = gridFor(stage, "current").querySelectorAll(".match-card").length;
    var pastCount = gridFor(stage, "past").querySelectorAll(".match-card").length;
    gridFor(stage, "current").hidden = view !== "current";
    gridFor(stage, "past").hidden = view !== "past";
    panel.querySelector('[data-empty="current"]').hidden = view !== "current" || currentCount > 0 || isAdmin() || !leagueId;
    panel.querySelector('[data-empty="past"]').hidden = view !== "past" || pastCount > 0 || !leagueId;
  }

  function buildPlayerRow(username){
    var row = el("tpl-player-row").content.firstElementChild.cloneNode(true);
    row.dataset.player = username;
    var tag = row.querySelector(".player-tag");
    applyPlayerColor(tag, username);
    return row;
  }

  // Makes a card's prediction rows match the league's current member list
  // (in join order), adding rows for newcomers and dropping departed ones.
  function syncPlayerRows(card){
    var grid = card.querySelector(".players-grid");
    var wanted = memberList();
    grid.querySelectorAll(".player-row").forEach(function(row){
      if(wanted.indexOf(row.dataset.player) === -1) row.remove();
    });
    wanted.forEach(function(username){
      var row = grid.querySelector('.player-row[data-player="' + username + '"]');
      if(!row) row = buildPlayerRow(username);
      grid.appendChild(row); // (re)appending keeps rows in member order
      var label = labelFor(username);
      row.querySelector(".player-tag").textContent = label;
      row.querySelector(".pred-home").setAttribute("aria-label", "Прогноз " + label + ", голы хозяев");
      row.querySelector(".pred-away").setAttribute("aria-label", "Прогноз " + label + ", голы гостей");
    });
  }

  function buildCard(stage, matchId){
    var card = el("tpl-match").content.firstElementChild.cloneNode(true);
    card.dataset.stage = stage;
    card.dataset.matchId = matchId;
    syncPlayerRows(card);
    return card;
  }

  function isEditingWithin(node){
    var active = document.activeElement;
    return !!(node && active && node.contains(active));
  }

  // Applies a remote snapshot to a rendered card. Match-level fields (score,
  // team names, kickoff time, auto-sync status) are applied unconditionally
  // and immediately — predictions locking at kickoff must never wait on
  // anything. Only an individual player's own prediction row is left
  // untouched while that exact row is being typed into, so a remote update
  // elsewhere never yanks someone's in-progress keystrokes — it still gets
  // locked the moment the match starts, since locking is driven by
  // applyPermissionsToCard()/recompute(), not by whether its value refreshed.
  function applyDataToCard(card, data){
    data = data || {};
    var round = Number(data.round) || 0;
    card.dataset.round = String(round);
    card.querySelector(".match-eyebrow").textContent = STAGE_LABEL[card.dataset.stage] + " · Тур " + round;

    var home = card.querySelector(".team-home");
    var away = card.querySelector(".team-away");
    if(document.activeElement !== home) home.textContent = data.home || "";
    if(document.activeElement !== away) away.textContent = data.away || "";

    var actualHome = card.querySelector(".actual-home");
    var actualAway = card.querySelector(".actual-away");
    if(document.activeElement !== actualHome) actualHome.value = data.aH || "";
    if(document.activeElement !== actualAway) actualAway.value = data.aA || "";

    card.dataset.fdKickoff = data.fdKickoff || "";
    updateKickoffNote(card, data.fdKickoff);
    var fdIdInput = card.querySelector(".fd-id-input");
    if(fdIdInput && document.activeElement !== fdIdInput) fdIdInput.value = data.fdId || "";
    var autoSyncOn = !!data.fdId;
    card.querySelector("[data-autosync-note]").hidden = !autoSyncOn;
    actualHome.disabled = autoSyncOn;
    actualAway.disabled = autoSyncOn;

    card.querySelectorAll(".player-row").forEach(function(row){
      if(isEditingWithin(row)) return;
      var pd = (data.players && data.players[row.dataset.player]) || {};
      row.querySelector(".pred-home").value = pd.pH || "";
      row.querySelector(".pred-away").value = pd.pA || "";
    });
  }

  // A prediction row is editable by its owner, or by the league's creator
  // (who may fill in anyone's prediction) — and by nobody once the match
  // has started. Called both when permissions change and from recompute()
  // on every data change, so either trigger keeps it correct.
  function applyRowLock(row, started){
    var mine = row.dataset.player === me || isAdmin();
    row.classList.toggle("is-locked", !mine);
    row.classList.toggle("is-final", mine && started);
    row.querySelectorAll("input, button").forEach(function(input){
      input.disabled = !mine || started;
    });
    row.title = !mine
      ? "Прогноз редактирует только " + labelFor(row.dataset.player)
      : (started ? "Матч начался — прогнозы больше нельзя менять" : "");
  }

  function applyPermissionsToCard(card){
    var admin = isAdmin();
    card.querySelector(".match-remove").hidden = !admin;
    card.querySelector(".autosync-field").hidden = !admin;
    var started = isMatchStarted(card);
    card.querySelectorAll(".player-row").forEach(function(row){ applyRowLock(row, started); });
  }

  function applyPermissions(){
    document.querySelectorAll(".match-card").forEach(applyPermissionsToCard);
    document.querySelectorAll(".add-tile, .round-add").forEach(function(btn){ btn.hidden = !isAdmin(); });
    STAGES.forEach(updateStageView);
  }

  // Re-renders every card against the current member list and cached data —
  // used when someone joins the league or a display name changes.
  function refreshAllCards(){
    STAGES.forEach(function(stage){
      panelFor(stage).querySelectorAll(".match-card").forEach(function(card){
        syncPlayerRows(card);
        applyDataToCard(card, matchCache[stage][card.dataset.matchId]);
      });
      layoutStage(stage);
    });
    applyPermissions();
    recompute();
  }

  function clearCards(){
    document.querySelectorAll(".match-card, .round-heading").forEach(function(node){ node.remove(); });
    matchCache = { league: {}, europe: {} };
  }

  // ---------- scoring ----------

  function recompute(){
    var members = memberList();
    var leagueTotals = {}, europeTotals = {}, totals = {};
    members.forEach(function(u){ leagueTotals[u] = 0; europeTotals[u] = 0; });

    document.querySelectorAll(".match-card").forEach(function(card){
      var stage = card.dataset.stage;
      var aH = num(card.querySelector(".actual-home"));
      var aA = num(card.querySelector(".actual-away"));
      var statusEl = card.querySelector("[data-status]");
      var played = isMatchStarted(card);

      statusEl.textContent = played ? "Матч сыгран" : "Ожидается";
      statusEl.classList.toggle("is-final", !!played);
      statusEl.classList.toggle("badge-pending", !played);

      card.querySelectorAll(".player-row").forEach(function(row){
        var u = row.dataset.player;
        var pts = leaguePoints(aH, aA, num(row.querySelector(".pred-home")), num(row.querySelector(".pred-away")));
        applyRowLock(row, played);
        if(pts !== null && u in leagueTotals){
          if(stage === "league") leagueTotals[u] += pts; else europeTotals[u] += pts;
        }
        setBadge(row.querySelector(".points-badge"), pts, 4);
      });
    });

    members.forEach(function(u){ totals[u] = leagueTotals[u] + europeTotals[u]; });
    renderLeaderboard(members, totals, leagueTotals, europeTotals);
  }

  function renderLeaderboard(members, totals, leagueTotals, europeTotals){
    var grid = el("lb-grid");
    grid.textContent = "";
    var order = members.slice().sort(function(a, b){ return totals[b] - totals[a]; });
    order.forEach(function(u, i){
      var rank = i + 1;
      var cardEl = document.createElement("div");
      cardEl.className = "lb-card" + (rank === 1 && totals[u] > 0 ? " is-first" : "");

      var rankEl = document.createElement("span");
      rankEl.className = "lb-rank";
      rankEl.textContent = rank + " место";

      var nameEl = document.createElement("div");
      nameEl.className = "lb-name player-tag";
      applyPlayerColor(nameEl, u);
      nameEl.textContent = labelFor(u) + (u === me ? " (вы)" : "");

      var totalEl = document.createElement("div");
      totalEl.className = "lb-total";
      totalEl.textContent = String(totals[u]);
      var unit = document.createElement("span");
      unit.className = "lb-total-unit";
      unit.textContent = "баллов";
      totalEl.appendChild(unit);

      var split = document.createElement("div");
      split.className = "lb-split";
      var s1 = document.createElement("span"); s1.textContent = "лиги " + leagueTotals[u];
      var s2 = document.createElement("span"); s2.textContent = "еврокубки " + europeTotals[u];
      split.appendChild(s1); split.appendChild(s2);

      cardEl.appendChild(rankEl); cardEl.appendChild(nameEl); cardEl.appendChild(totalEl); cardEl.appendChild(split);
      grid.appendChild(cardEl);
    });
  }

  // ---------- Firebase writes ----------

  var writeTimers = Object.create(null);
  var pendingPatches = Object.create(null); // ref path -> merged patch awaiting write

  // Merges `patch` into whatever is already pending for `refPath` and
  // (re)starts its debounce timer, so editing two fields of the same node in
  // quick succession sends both instead of the later write clobbering the
  // earlier one.
  function scheduleFieldWrite(refPath, patch, delay){
    if(!db) return;
    var merged = pendingPatches[refPath] || {};
    Object.assign(merged, patch);
    pendingPatches[refPath] = merged;
    clearTimeout(writeTimers[refPath]);
    writeTimers[refPath] = setTimeout(function(){
      var toSend = pendingPatches[refPath];
      delete pendingPatches[refPath];
      db.ref(refPath).update(toSend).catch(function(err){
        console.warn("Firebase: не удалось сохранить:", err);
      });
    }, delay || 350);
  }

  function matchPath(stage, matchId){
    return "leagues/" + leagueId + "/matches/" + stage + "/" + matchId;
  }
  function pushMatchField(stage, matchId, patch){ scheduleFieldWrite(matchPath(stage, matchId), patch); }
  function pushPlayerField(stage, matchId, username, patch){
    scheduleFieldWrite(matchPath(stage, matchId) + "/players/" + username, patch);
  }

  function addMatch(stage){
    if(!db || !leagueId || !isAdmin()) return;
    var data = { home:"", away:"", aH:"", aA:"", round: rounds[stage] };
    db.ref("leagues/" + leagueId + "/matches/" + stage).push().set(data).catch(function(err){
      console.warn("Firebase: не удалось добавить матч:", err);
      window.alert("Не удалось добавить матч: " + (err && err.message ? err.message : err));
    });
  }

  // Starting the next round is all it takes to move the current round's
  // matches to "past" — a card's view follows from its round number alone.
  function addRound(stage){
    if(!db || !leagueId || !isAdmin()) return;
    var next = rounds[stage] + 1;
    var count = gridFor(stage, "current").querySelectorAll(".match-card").length;
    var question = "Начать тур " + next + " в разделе «" + STAGE_LABEL[stage] + "»?"
      + (count ? "\nМатчи тура " + rounds[stage] + " (" + count + ") перейдут в прошедшие." : "");
    if(!window.confirm(question)) return;
    db.ref("leagues/" + leagueId + "/rounds/" + stage).set(next).then(function(){
      panelFor(stage).dataset.view = "current";
      updateStageView(stage);
    }).catch(function(err){
      console.warn("Firebase: не удалось добавить тур:", err);
      window.alert("Не удалось добавить тур: " + (err && err.message ? err.message : err));
    });
  }

  function removeMatch(card){
    if(!db || !leagueId || !isAdmin()) return;
    db.ref(matchPath(card.dataset.stage, card.dataset.matchId)).remove().catch(function(err){
      console.warn("Firebase: не удалось удалить матч:", err);
      window.alert("Не удалось удалить матч: " + (err && err.message ? err.message : err));
    });
  }

  // ---------- names ----------

  function watchName(username){
    if(nameWatched[username]) return;
    nameWatched[username] = true;
    listen(sessionListeners, db.ref("users/" + username + "/name"), "value", function(snap){
      var v = snap.val();
      if(v) names[username] = v; else delete names[username];
      if(username === me) el("session-name").textContent = labelFor(me);
      if(league.members && username in league.members) refreshAllCards();
    });
  }

  // ---------- one league on screen ----------

  function renderLeagueHeader(){
    el("lb-league-name").textContent = league.name || "";
    var chip = el("league-key-chip");
    chip.hidden = !isAdmin();
    el("league-key-value").textContent = leagueId || "";
  }

  function watchStage(stage, ref){
    listen(leagueListeners, ref, "child_added", function(snap){
      var matchId = snap.key;
      matchCache[stage][matchId] = snap.val();
      var card = cardFor(stage, matchId);
      if(!card){
        card = buildCard(stage, matchId);
        gridFor(stage, "current").appendChild(card);
      }
      applyDataToCard(card, snap.val());
      layoutStage(stage);
      applyPermissionsToCard(card);
      recompute();
    });

    listen(leagueListeners, ref, "child_changed", function(snap){
      matchCache[stage][snap.key] = snap.val();
      var card = cardFor(stage, snap.key);
      if(!card) return;
      var oldRound = card.dataset.round;
      applyDataToCard(card, snap.val());
      if(card.dataset.round !== oldRound) layoutStage(stage);
      applyPermissionsToCard(card);
      recompute();
    });

    listen(leagueListeners, ref, "child_removed", function(snap){
      delete matchCache[stage][snap.key];
      var card = cardFor(stage, snap.key);
      if(card) card.remove();
      layoutStage(stage);
      recompute();
    });
  }

  function closeLeague(){
    detachAll(leagueListeners);
    clearCards();
    leagueId = null;
    league = { name: "", owner: "", members: {} };
    rounds = { league: 0, europe: 0 };
    STAGES.forEach(function(stage){
      panelFor(stage).dataset.view = "current";
      layoutStage(stage);
    });
    el("lb-grid").textContent = "";
  }

  function openLeague(id){
    closeLeague();
    leagueId = id;
    try{ localStorage.setItem(LAST_LEAGUE_STORAGE, id); }catch(e){}
    renderLeagueSelect();
    renderLeagueHeader();
    applyPermissions();
    showOnly("app");

    var base = db.ref("leagues/" + id);
    // Losing read access (wrong id, or no longer a member) cancels the
    // listener — fall back to the league picker instead of a blank page.
    var onDenied = function(err){
      console.warn("Firebase: нет доступа к лиге " + id + ":", err);
      if(leagueId !== id) return;
      closeLeague();
      showLeagueScreen();
      el("league-error").textContent = "Нет доступа к этой лиге.";
    };

    listen(leagueListeners, base.child("name"), "value", function(snap){
      league.name = snap.val() || "";
      leagueNames[id] = league.name;
      renderLeagueHeader();
      renderLeagueSelect();
    }, onDenied);
    listen(leagueListeners, base.child("owner"), "value", function(snap){
      league.owner = snap.val() || "";
      renderLeagueHeader();
      applyPermissions();
    }, onDenied);
    listen(leagueListeners, base.child("rounds"), "value", function(snap){
      var v = snap.val() || {};
      STAGES.forEach(function(stage){
        rounds[stage] = Number(v[stage]) || 0;
        layoutStage(stage);
      });
    }, onDenied);
    listen(leagueListeners, base.child("members"), "value", function(snap){
      league.members = snap.val() || {};
      Object.keys(league.members).forEach(watchName);
      refreshAllCards();
    }, onDenied);
    STAGES.forEach(function(stage){ watchStage(stage, base.child("matches/" + stage)); });
  }

  // ---------- my leagues ----------

  function renderLeagueSelect(){
    var select = el("league-select");
    var ids = Object.keys(myLeagues || {});
    el("league-switch").hidden = ids.length < 2;
    select.textContent = "";
    ids.sort(function(a, b){
      var na = leagueNames[a] || a, nb = leagueNames[b] || b;
      return na.localeCompare(nb, "ru");
    }).forEach(function(id){
      var opt = document.createElement("option");
      opt.value = id;
      opt.textContent = leagueNames[id] || id;
      if(id === leagueId) opt.selected = true;
      select.appendChild(opt);
    });
  }

  function loadLeagueName(id){
    if(leagueNames[id] !== undefined) return;
    leagueNames[id] = id;
    db.ref("leagues/" + id + "/name").once("value").then(function(snap){
      leagueNames[id] = snap.val() || id;
      renderLeagueSelect();
    }).catch(function(){ /* not a member any more — leave the id as label */ });
  }

  function onMyLeaguesChanged(snap){
    var first = myLeagues === null;
    myLeagues = snap.val() || {};
    var ids = Object.keys(myLeagues);
    ids.forEach(loadLeagueName);
    renderLeagueSelect();

    if(leagueId && !myLeagues[leagueId]){ closeLeague(); }
    if(leagueId) return;
    if(!ids.length){
      if(first || el("league-screen").hidden) showLeagueScreen();
      return;
    }
    if(!el("league-screen").hidden && !first) return; // user is in the middle of the league screen
    var last = null;
    try{ last = localStorage.getItem(LAST_LEAGUE_STORAGE); }catch(e){}
    openLeague(last && myLeagues[last] ? last : ids[0]);
  }

  // ---------- creating / joining leagues ----------

  function serverNow(){ return firebase.database.ServerValue.TIMESTAMP; }

  function createLeague(name, attempt){
    attempt = attempt || 1;
    var key = generateKey();
    var data = { name: name, owner: me, createdAt: serverNow(), rounds: { league: 1, europe: 1 }, members: {} };
    data.members[me] = serverNow();
    return db.ref("leagues/" + key).set(data).then(function(){
      return db.ref("users/" + me + "/leagues/" + key).set(true);
    }).then(function(){
      leagueNames[key] = name;
      return key;
    }, function(err){
      // A key collision with an existing league is rejected by the rules
      // (leagues can only be created, never overwritten) — just try another.
      if(attempt < 3) return createLeague(name, attempt + 1);
      throw err;
    });
  }

  function joinLeague(key){
    if(myLeagues && myLeagues[key]) return Promise.resolve(key);
    return db.ref("leagues/" + key + "/members/" + me).set(serverNow()).catch(function(err){
      // Already a member (e.g. added by migration) but not in our own index?
      return db.ref("leagues/" + key + "/name").once("value").then(function(snap){
        if(!snap.exists()) throw err;
      }, function(){ throw err; });
    }).then(function(){
      return db.ref("users/" + me + "/leagues/" + key).set(true);
    }).then(function(){ return key; });
  }

  function copyText(text, button){
    var done = function(){
      var old = button.textContent;
      button.textContent = "Скопировано";
      setTimeout(function(){ button.textContent = old; }, 1500);
    };
    if(navigator.clipboard && navigator.clipboard.writeText){
      navigator.clipboard.writeText(text).then(done, function(){ window.prompt("Скопируйте ключ:", text); });
    } else {
      window.prompt("Скопируйте ключ:", text);
    }
  }

  function setupLeagueUI(){
    var errorEl = el("league-error");
    var createdKey = null;

    el("league-create-form").addEventListener("submit", function(e){
      e.preventDefault();
      var name = el("league-name").value.trim();
      if(!name){ errorEl.textContent = "Введите название лиги."; return; }
      var btn = el("league-create");
      btn.disabled = true;
      errorEl.textContent = "";
      createLeague(name).then(function(key){
        createdKey = key;
        el("league-name").value = "";
        el("league-created-name").textContent = name;
        el("league-created-key").textContent = key;
        el("league-created").hidden = false;
        el("league-create-form").hidden = true;
        el("league-join-form").hidden = true;
        el("league-back").hidden = true;
      }).catch(function(err){
        errorEl.textContent = "Не удалось создать лигу: " + (err && err.message ? err.message : err);
      }).then(function(){ btn.disabled = false; });
    });

    el("league-join-form").addEventListener("submit", function(e){
      e.preventDefault();
      var key = normalizeKey(el("league-key").value);
      if(key.length !== KEY_LEN){ errorEl.textContent = "Ключ — это " + KEY_LEN + " символов, латиница и цифры."; return; }
      var btn = el("league-join");
      btn.disabled = true;
      errorEl.textContent = "";
      joinLeague(key).then(function(id){
        el("league-key").value = "";
        openLeague(id);
      }).catch(function(){
        errorEl.textContent = "Лига с таким ключом не найдена.";
      }).then(function(){ btn.disabled = false; });
    });

    el("league-created-copy").addEventListener("click", function(){
      if(createdKey) copyText(createdKey, el("league-created-copy"));
    });
    el("league-created-open").addEventListener("click", function(){
      if(createdKey) openLeague(createdKey);
    });
    el("league-back").addEventListener("click", function(){
      if(leagueId) showOnly("app");
    });
    el("leagues-btn").addEventListener("click", showLeagueScreen);
    el("league-select").addEventListener("change", function(e){
      if(e.target.value && e.target.value !== leagueId) openLeague(e.target.value);
    });
    el("league-key-copy").addEventListener("click", function(){
      if(leagueId) copyText(leagueId, el("league-key-copy"));
    });
  }

  // ---------- auth ----------

  function setupAuthUI(){
    var form = el("auth-form");
    var loginInput = el("auth-login");
    var nameInput = el("auth-name");
    var passwordInput = el("auth-password");
    var submitBtn = el("auth-submit");
    var errorEl = el("auth-error");
    var mode = "login";

    function setMode(next){
      mode = next;
      document.querySelectorAll(".auth-mode").forEach(function(b){
        var on = b.dataset.mode === mode;
        b.classList.toggle("is-active", on);
        b.setAttribute("aria-selected", on ? "true" : "false");
      });
      form.querySelector(".auth-register-only").hidden = mode !== "register";
      el("auth-title").textContent = mode === "register" ? "Новый игрок" : "С возвращением";
      el("auth-hint").textContent = mode === "register"
        ? "Логин — латиница, цифры и «_», от 3 до 20 символов. Имя увидят остальные игроки в таблице."
        : "Войдите под своим логином.";
      submitBtn.textContent = mode === "register" ? "Зарегистрироваться" : "Войти";
      passwordInput.setAttribute("autocomplete", mode === "register" ? "new-password" : "current-password");
      errorEl.textContent = "";
      refreshSubmit();
    }

    function refreshSubmit(){
      var ok = loginInput.value.trim() && passwordInput.value.length > 0;
      if(mode === "register") ok = ok && nameInput.value.trim();
      submitBtn.disabled = !ok;
    }

    document.querySelectorAll(".auth-mode").forEach(function(b){
      b.addEventListener("click", function(){ setMode(b.dataset.mode); });
    });
    [loginInput, nameInput, passwordInput].forEach(function(input){
      input.addEventListener("input", refreshSubmit);
    });

    form.addEventListener("submit", function(e){
      e.preventDefault();
      if(submitBtn.disabled) return;
      var username = normalizeUsername(loginInput.value);
      var password = passwordInput.value;
      errorEl.textContent = "";

      if(!USERNAME_RE.test(username)){
        errorEl.textContent = "Логин: латиница, цифры и «_», от 3 до 20 символов.";
        return;
      }
      submitBtn.disabled = true;

      if(mode === "login"){
        firebase.auth().signInWithEmailAndPassword(emailFor(username), password).catch(function(err){
          var messages = {
            "auth/invalid-credential": "Неверный логин или пароль.",
            "auth/wrong-password": "Неверный логин или пароль.",
            "auth/user-not-found": "Неверный логин или пароль.",
            "auth/too-many-requests": "Слишком много попыток, подождите немного и попробуйте снова."
          };
          errorEl.textContent = messages[err.code] || ("Ошибка входа: " + err.message);
        }).then(refreshSubmit);
        return;
      }

      var displayName = nameInput.value.trim().slice(0, 30);
      firebase.auth().createUserWithEmailAndPassword(emailFor(username), password).then(function(cred){
        return db.ref("users/" + username + "/name").set(displayName);
      }).catch(function(err){
        var messages = {
          "auth/email-already-in-use": "Такой логин уже занят.",
          "auth/weak-password": "Пароль слишком короткий — минимум 6 символов.",
          "auth/invalid-email": "Недопустимый логин.",
          "auth/too-many-requests": "Слишком много попыток, подождите немного и попробуйте снова."
        };
        errorEl.textContent = messages[err.code] || ("Ошибка регистрации: " + err.message);
      }).then(refreshSubmit);
    });

    el("logout-btn").addEventListener("click", function(){ firebase.auth().signOut(); });
  }

  function onSignedIn(user){
    var username = usernameFromEmail(user.email);
    if(!username){ firebase.auth().signOut(); return; }
    me = username;
    el("session-name").textContent = labelFor(me);
    el("auth-password").value = "";
    watchName(me);
    listen(sessionListeners, db.ref("users/" + me + "/leagues"), "value", onMyLeaguesChanged);
    listen(sessionListeners, db.ref(".info/connected"), "value", function(snap){
      leagueConnected = snap.val() === true;
      setSyncStatus(leagueConnected ? "Синхронизировано" : "Подключение…", leagueConnected ? "sync-on" : "sync-off");
    });
  }

  function onSignedOut(){
    closeLeague();
    detachAll(sessionListeners);
    me = null;
    myLeagues = null;
    leagueNames = {};
    names = {};
    nameWatched = {};
    showOnly("auth");
  }

  function isFirebaseConfigured(){
    var c = window.FIREBASE_CONFIG;
    return !!(c && c.apiKey && c.databaseURL && c.apiKey.indexOf("ВСТАВЬТЕ") === -1);
  }

  // ---------- wiring: clicks & inputs ----------

  document.body.addEventListener("click", function(e){
    var addBtn = e.target.closest(".add-tile");
    if(addBtn){ addMatch(addBtn.dataset.addStage); return; }
    var roundBtn = e.target.closest(".round-add");
    if(roundBtn){ addRound(roundBtn.dataset.addRound); return; }
    var subtab = e.target.closest(".subtab");
    if(subtab){
      var panel = subtab.closest(".stage");
      panel.dataset.view = subtab.dataset.view;
      updateStageView(panel.dataset.stagePanel);
      return;
    }
    var rmBtn = e.target.closest(".match-remove");
    if(rmBtn){
      var card = rmBtn.closest(".match-card");
      if(card) removeMatch(card);
    }
  });

  document.querySelectorAll(".tab-btn").forEach(function(btn){
    btn.addEventListener("click", function(){
      document.querySelectorAll(".tab-btn").forEach(function(b){
        b.classList.remove("is-active");
        b.setAttribute("aria-selected","false");
      });
      btn.classList.add("is-active");
      btn.setAttribute("aria-selected","true");
      var target = btn.dataset.tab;
      document.querySelectorAll(".stage").forEach(function(s){
        s.classList.toggle("is-active", s.dataset.stagePanel === target);
      });
    });
  });

  document.body.addEventListener("input", function(e){
    var input = e.target;
    var card = input.closest && input.closest(".match-card");
    if(!card || !leagueId) return;
    var stage = card.dataset.stage;
    var matchId = card.dataset.matchId;

    if(input.matches(".actual-home, .actual-away")){
      recompute();
      pushMatchField(stage, matchId, {
        aH: card.querySelector(".actual-home").value,
        aA: card.querySelector(".actual-away").value
      });
      return;
    }
    if(input.matches(".team-home")){ pushMatchField(stage, matchId, { home: input.textContent.trim() }); return; }
    if(input.matches(".team-away")){ pushMatchField(stage, matchId, { away: input.textContent.trim() }); return; }
    if(input.matches(".fd-id-input")){
      if(!isAdmin()) return;
      pushMatchField(stage, matchId, { fdId: input.value.trim() || null });
      return;
    }
    if(input.matches(".pred-home, .pred-away")){
      recompute();
      var row = input.closest(".player-row");
      pushPlayerField(stage, matchId, row.dataset.player, {
        pH: row.querySelector(".pred-home").value,
        pA: row.querySelector(".pred-away").value
      });
    }
  });

  // ---------- boot ----------

  // Kickoff-time locking (see isMatchStarted) depends on wall-clock time,
  // not just on data changing — without this, a card left open in a
  // browser wouldn't lock until *something* else triggered a recompute.
  setInterval(recompute, 20000);

  if(!isFirebaseConfigured() || typeof firebase === "undefined"){
    showOnly("auth");
    el("auth-error").textContent = "Firebase не настроен — заполните firebase-config.js.";
    return;
  }

  firebase.initializeApp(window.FIREBASE_CONFIG);
  db = firebase.database();
  setupAuthUI();
  setupLeagueUI();
  firebase.auth().onAuthStateChanged(function(user){
    if(user) onSignedIn(user); else onSignedOut();
  });
})();
