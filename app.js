(function(){
  "use strict";

  var PLAYERS = ["egor","ivan","sasha_r","sasha_t"];
  var PLAYER_LABEL = {egor:"Егор Б.", ivan:"Иван Г.", sasha_r:"Александр Р.", sasha_t:"Александр Т."};
  var ADMIN_PLAYER = "sasha_r"; // only this player may add/remove matches
  var EMAIL_DOMAIN = "season2627.invalid"; // reserved non-routable TLD (RFC 2606) — these aren't real inboxes
  var STORAGE_KEY = "season2627.predictions.v1"; // legacy local-only fallback, used only without Firebase

  function playerEmail(pid){ return pid + "@" + EMAIL_DOMAIN; }
  function emailToPlayer(email){
    if(!email) return null;
    var at = email.indexOf("@");
    var local = at === -1 ? email : email.slice(0, at);
    return PLAYERS.indexOf(local) !== -1 ? local : null;
  }

  function num(el){
    if(!el) return null;
    var v = el.value.trim();
    if(v === "") return null;
    var n = Number(v);
    return isNaN(n) ? null : n;
  }

  function selectedValue(group){
    if(!group) return null;
    var btn = group.querySelector(".toggle-btn.is-selected");
    return btn ? btn.dataset.value : null;
  }

  function selectToggle(group, value){
    if(!group) return;
    group.querySelectorAll(".toggle-btn").forEach(function(b){
      b.classList.toggle("is-selected", b.dataset.value === value);
    });
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
  // score, or for eurocups how it ended — the same signal used to award
  // points), OR its cached kickoff time has passed. The kickoff check
  // matters because the sync bot only checks a live match every ~10
  // minutes: without it, predictions would stay open for however long
  // after the real kickoff until the bot's next run first writes a score.
  // Manually-entered matches have no kickoff time to go on, so for those
  // this still only locks once a real score is typed in.
  function isMatchStarted(card){
    var stage = card.dataset.stage;
    var aH = num(card.querySelector(".actual-home"));
    var aA = num(card.querySelector(".actual-away"));
    var hasScore = aH !== null && aA !== null;
    if(stage !== "league"){
      var actualTime = selectedValue(card.querySelector(".time-row .toggle-group"));
      hasScore = hasScore || !!actualTime;
    }
    if(hasScore) return true;

    var kickoff = card.dataset.fdKickoff;
    return !!kickoff && Date.now() >= new Date(kickoff).getTime();
  }

  function leaguePoints(aH,aA,pH,pA){
    if(aH===null||aA===null||pH===null||pA===null) return null;
    var pts = 0;
    var aSign = Math.sign(aH-aA), pSign = Math.sign(pH-pA);
    if(aSign === pSign) pts += 1;
    if((aH-aA) === (pH-pA)) pts += 1;
    if(aH===pH && aA===pA) pts += 2;
    return pts;
  }

  function europeScorePoints(aH,aA,pH,pA){
    if(aH===null||aA===null||pH===null||pA===null) return null;
    var pts = 0;
    var aSign = Math.sign(aH-aA), pSign = Math.sign(pH-pA);
    if(aSign === pSign) pts += 2;
    if((aH-aA) === (pH-pA)) pts += 1;
    if(aH===pH && aA===pA) pts += 2;
    return pts;
  }

  function timePoints(actualTime, predTime){
    if(!actualTime || !predTime) return null;
    if(actualTime === predTime) return 2;
    var isEtOrPen = function(v){ return v==="et" || v==="pen"; };
    if(isEtOrPen(actualTime) && isEtOrPen(predTime)) return 1;
    return 0;
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

  function recompute(){
    var totals = {};
    var leagueTotals = {};
    var europeTotals = {};
    PLAYERS.forEach(function(p){ totals[p]=0; leagueTotals[p]=0; europeTotals[p]=0; });

    document.querySelectorAll(".match-card").forEach(function(card){
      var stage = card.dataset.stage;
      var aH = num(card.querySelector(".actual-home"));
      var aA = num(card.querySelector(".actual-away"));
      var statusEl = card.querySelector("[data-status]");
      var actualTime = stage === "europe" ? selectedValue(card.querySelector('.time-row .toggle-group')) : null;

      var played = isMatchStarted(card);

      if(statusEl){
        statusEl.textContent = played ? "Матч сыгран" : "Ожидается";
        statusEl.classList.toggle("is-final", !!played);
        statusEl.classList.toggle("badge-pending", !played);
      }

      card.querySelectorAll(".player-row").forEach(function(row){
        var pid = row.dataset.player;
        var pH = num(row.querySelector(".pred-home"));
        var pA = num(row.querySelector(".pred-away"));
        var badge = row.querySelector(".points-badge");
        var pts;

        applyRowLock(row, played);

        if(stage === "league"){
          pts = leaguePoints(aH,aA,pH,pA);
          if(pts !== null) leagueTotals[pid] += pts;
          setBadge(badge, pts, 4);
        } else {
          var predTime = selectedValue(row.querySelector('.toggle-group[data-role="pred-time"]'));
          var sPts = europeScorePoints(aH,aA,pH,pA);
          var tPts = timePoints(actualTime, predTime);
          pts = (sPts===null && tPts===null) ? null : (sPts||0) + (tPts||0);
          if(pts !== null) europeTotals[pid] += pts;
          setBadge(badge, pts, 7);
        }
      });
    });

    PLAYERS.forEach(function(p){ totals[p] = leagueTotals[p] + europeTotals[p]; });

    renderLeaderboard(totals, leagueTotals, europeTotals);
  }

  function renderLeaderboard(totals, leagueTotals, europeTotals){
    var grid = document.getElementById("lb-grid");
    if(!grid) return;
    var order = PLAYERS.slice().sort(function(a,b){ return totals[b]-totals[a]; });
    var html = "";
    order.forEach(function(pid, i){
      var rank = i+1;
      html += '<div class="lb-card' + (rank===1 ? ' is-first' : '') + '">'
        + '<span class="lb-rank">' + rank + ' место</span>'
        + '<div class="lb-name player-tag player-tag--' + pid + '">' + PLAYER_LABEL[pid] + '</div>'
        + '<div class="lb-total">' + totals[pid] + '<span class="lb-total-unit">баллов</span></div>'
        + '<div class="lb-split"><span>лиги ' + leagueTotals[pid] + '</span><span>еврокубки ' + europeTotals[pid] + '</span></div>'
        + '</div>';
    });
    grid.innerHTML = html;
  }

  // ---------- reading/writing one match card's fields ----------

  function populateCardFields(card, stage, data){
    data = data || {};
    card.querySelector(".team-home").textContent = data.home || "";
    card.querySelector(".team-away").textContent = data.away || "";
    card.querySelector(".actual-home").value = data.aH || "";
    card.querySelector(".actual-away").value = data.aA || "";
    // Cached by the sync bot the first time it looks the fixture up — lets
    // us lock predictions exactly at kickoff instead of only once the bot's
    // next run actually writes a score (see isMatchStarted).
    card.dataset.fdKickoff = data.fdKickoff || "";
    updateKickoffNote(card, data.fdKickoff);
    if(stage === "europe"){
      selectToggle(card.querySelector(".time-row .toggle-group"), data.time || null);
    }

    var fdIdInput = card.querySelector(".fd-id-input");
    if(fdIdInput && document.activeElement !== fdIdInput) fdIdInput.value = data.fdId || "";
    var autoSyncOn = !!data.fdId;
    card.querySelector("[data-autosync-note]").hidden = !autoSyncOn;
    card.querySelector(".actual-home").disabled = autoSyncOn;
    card.querySelector(".actual-away").disabled = autoSyncOn;
    var actualTimeGroup = stage === "europe" ? card.querySelector(".time-row .toggle-group") : null;
    if(actualTimeGroup){
      actualTimeGroup.querySelectorAll(".toggle-btn").forEach(function(b){ b.disabled = autoSyncOn; });
    }
    PLAYERS.forEach(function(pid){
      var row = card.querySelector('.player-row[data-player="' + pid + '"]');
      var pd = (data.players && data.players[pid]) || {};
      row.querySelector(".pred-home").value = pd.pH || "";
      row.querySelector(".pred-away").value = pd.pA || "";
      if(stage === "europe"){
        selectToggle(row.querySelector('.toggle-group[data-role="pred-time"]'), pd.time || null);
      }
    });
  }

  function buildCard(stage, matchId, data){
    var tpl = document.getElementById(stage === "league" ? "tpl-league" : "tpl-europe");
    var card = tpl.content.firstElementChild.cloneNode(true);
    card.dataset.matchId = matchId;
    populateCardFields(card, stage, data);
    return card;
  }

  function gridFor(stage){
    return document.querySelector('.card-grid[data-stage-grid="' + stage + '"]');
  }

  function cardFor(stage, matchId){
    var grid = gridFor(stage);
    return grid ? grid.querySelector('.match-card[data-match-id="' + matchId + '"]') : null;
  }

  // ---------- legacy local-only mode (no Firebase configured) ----------

  function collectMatchLocal(card, stage){
    var data = {
      home: card.querySelector(".team-home").textContent.trim(),
      away: card.querySelector(".team-away").textContent.trim(),
      aH: card.querySelector(".actual-home").value,
      aA: card.querySelector(".actual-away").value,
      players: {}
    };
    if(stage === "europe"){
      data.time = selectedValue(card.querySelector(".time-row .toggle-group"));
    }
    card.querySelectorAll(".player-row").forEach(function(row){
      var pid = row.dataset.player;
      var pd = { pH: row.querySelector(".pred-home").value, pA: row.querySelector(".pred-away").value };
      if(stage === "europe"){
        pd.time = selectedValue(row.querySelector('.toggle-group[data-role="pred-time"]'));
      }
      data.players[pid] = pd;
    });
    return data;
  }

  function collectStateLocal(){
    var state = { league: {}, europe: {} };
    ["league","europe"].forEach(function(stage){
      gridFor(stage).querySelectorAll(".match-card").forEach(function(card){
        state[stage][card.dataset.matchId] = collectMatchLocal(card, stage);
      });
    });
    return state;
  }

  function saveLocal(){
    try{ localStorage.setItem(STORAGE_KEY, JSON.stringify(collectStateLocal())); }catch(e){}
  }

  function loadLocal(){
    try{
      var raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    }catch(e){ return null; }
  }

  function applyLocalState(state){
    if(!state) return;
    ["league","europe"].forEach(function(stage){
      var grid = gridFor(stage);
      var tile = grid.querySelector(".add-tile");
      var ids = Object.keys(state[stage] || {});
      // update/create known matches, keep the seed card if nothing saved yet for it
      ids.forEach(function(matchId){
        var card = cardFor(stage, matchId);
        if(card){
          populateCardFields(card, stage, state[stage][matchId]);
        } else {
          grid.insertBefore(buildCard(stage, matchId, state[stage][matchId]), tile);
        }
      });
      // remove local cards that no longer exist in saved state (except keep at least the DOM as-is if state is empty)
      if(ids.length){
        grid.querySelectorAll(".match-card").forEach(function(card){
          if(ids.indexOf(card.dataset.matchId) === -1) card.remove();
        });
      }
    });
  }

  var localMatchCounter = 0;
  function nextLocalId(stage){
    localMatchCounter += 1;
    return "local-" + stage + "-" + Date.now() + "-" + localMatchCounter;
  }

  // ---------- Firebase (Auth + per-field Realtime Database sync) ----------

  var db = null;
  var currentPlayer = null;
  var watchersAttached = false;
  var writeTimers = Object.create(null); // debounce key -> timer id

  function isFirebaseConfigured(){
    var c = window.FIREBASE_CONFIG;
    return !!(c && c.apiKey && c.databaseURL && c.apiKey.indexOf("ВСТАВЬТЕ") === -1);
  }

  function setSyncStatus(text, mode){
    var el = document.getElementById("sync-status");
    if(!el) return;
    el.textContent = text;
    el.classList.remove("sync-on","sync-off","sync-local");
    el.classList.add(mode);
  }

  function showAuthScreen(){
    document.getElementById("auth-screen").hidden = false;
    document.getElementById("app-wrap").hidden = true;
    document.getElementById("session-bar").hidden = true;
  }

  function showApp(){
    document.getElementById("auth-screen").hidden = true;
    document.getElementById("app-wrap").hidden = false;
    var bar = document.getElementById("session-bar");
    bar.hidden = false;
    document.getElementById("session-name").textContent = PLAYER_LABEL[currentPlayer] || currentPlayer;
  }

  var pendingPatches = Object.create(null); // ref path -> merged patch awaiting write

  // Merges `patch` into whatever is already pending for `refPath` and (re)starts
  // its debounce timer, so editing two different fields of the same node in
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

  function pushMatchField(stage, matchId, patch){
    scheduleFieldWrite("predictions/" + stage + "/" + matchId, patch);
  }

  function pushPlayerField(stage, matchId, pid, patch){
    scheduleFieldWrite("predictions/" + stage + "/" + matchId + "/players/" + pid, patch);
  }

  function addMatchRemote(stage){
    if(!db || currentPlayer !== ADMIN_PLAYER) return;
    db.ref("predictions/" + stage).push().set({ home:"", away:"", aH:"", aA:"" }).catch(function(err){
      console.warn("Firebase: не удалось добавить матч:", err);
      window.alert("Не удалось добавить матч: " + (err && err.message ? err.message : err));
    });
  }

  function removeMatchRemote(stage, matchId){
    if(!db || currentPlayer !== ADMIN_PLAYER) return;
    db.ref("predictions/" + stage + "/" + matchId).remove().catch(function(err){
      console.warn("Firebase: не удалось удалить матч:", err);
      window.alert("Не удалось удалить матч: " + (err && err.message ? err.message : err));
    });
  }

  function isEditingWithin(el){
    var active = document.activeElement;
    return !!(el && active && el.contains(active));
  }

  // Applies a remote snapshot to an already-rendered card. Match-level
  // fields (score, team names, kickoff time, auto-sync status) are applied
  // unconditionally and immediately — predictions locking at kickoff must
  // never wait on anything. Only an individual player's OWN prediction row
  // is left untouched while that exact row is being typed into, so a
  // remote update elsewhere never yanks someone's in-progress keystrokes —
  // but it still gets locked out the moment the match starts, since
  // locking is driven by applyPermissionsToCard()/recompute() below, not
  // by whether that row's displayed value happened to refresh.
  function applyRemoteToCard(card, stage, data){
    data = data || {};
    card.querySelector(".team-home").textContent = data.home || "";
    card.querySelector(".team-away").textContent = data.away || "";

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

    if(stage === "europe"){
      var timeGroup = card.querySelector(".time-row .toggle-group");
      if(!isEditingWithin(timeGroup)) selectToggle(timeGroup, data.time || null);
      timeGroup.querySelectorAll(".toggle-btn").forEach(function(b){ b.disabled = autoSyncOn; });
    }

    PLAYERS.forEach(function(pid){
      var row = card.querySelector('.player-row[data-player="' + pid + '"]');
      if(isEditingWithin(row)) return;
      var pd = (data.players && data.players[pid]) || {};
      row.querySelector(".pred-home").value = pd.pH || "";
      row.querySelector(".pred-away").value = pd.pA || "";
      if(stage === "europe"){
        selectToggle(row.querySelector('.toggle-group[data-role="pred-time"]'), pd.time || null);
      }
    });

    applyPermissionsToCard(card);
    recompute();
  }

  function watchStage(stage){
    var ref = db.ref("predictions/" + stage);
    var grid = gridFor(stage);
    var tile = grid.querySelector(".add-tile");

    ref.on("child_added", function(snap){
      var matchId = snap.key;
      var existing = cardFor(stage, matchId);
      if(existing){
        // seed card already in the static HTML — reconcile once its Firebase node appears
        applyRemoteToCard(existing, stage, snap.val());
      } else {
        var card = buildCard(stage, matchId, snap.val());
        grid.insertBefore(card, tile);
        applyPermissionsToCard(card);
        recompute();
      }
    });

    ref.on("child_changed", function(snap){
      var card = cardFor(stage, snap.key);
      if(!card) return;
      applyRemoteToCard(card, stage, snap.val());
    });

    ref.on("child_removed", function(snap){
      var card = cardFor(stage, snap.key);
      if(card) card.remove();
      recompute();
    });
  }

  function attachStageWatchers(){
    if(watchersAttached) return;
    watchersAttached = true;
    watchStage("league");
    watchStage("europe");

    firebase.database().ref(".info/connected").on("value", function(snap){
      var connected = snap.val() === true;
      setSyncStatus(connected ? "Синхронизировано" : "Подключение…", connected ? "sync-on" : "sync-off");
    });
  }

  // A prediction row is locked either because it isn't the signed-in
  // player's own row (and they aren't the admin, who may edit anyone's
  // prediction), or because the match has already started (once it has,
  // nobody — including its owner or the admin — may still change it).
  // Called both when permissions change (login, new card) and from
  // recompute() on every data change, so either trigger keeps it correct.
  function applyRowLock(row, started){
    var mine = !db || row.dataset.player === currentPlayer || currentPlayer === ADMIN_PLAYER;
    row.classList.toggle("is-locked", !mine);
    row.classList.toggle("is-final", mine && started);
    row.querySelectorAll("input, button").forEach(function(el){
      el.disabled = !mine || started;
    });
    row.title = !mine
      ? "Прогноз редактирует только " + PLAYER_LABEL[row.dataset.player]
      : (started ? "Матч начался — прогнозы больше нельзя менять" : "");
  }

  function applyPermissionsToCard(card){
    var isAdmin = currentPlayer === ADMIN_PLAYER;
    var removeBtn = card.querySelector(".match-remove");
    if(removeBtn) removeBtn.hidden = !isAdmin;
    var autoSyncField = card.querySelector(".autosync-field");
    if(autoSyncField) autoSyncField.hidden = !isAdmin;

    var started = isMatchStarted(card);
    card.querySelectorAll(".player-row").forEach(function(row){
      applyRowLock(row, started);
    });
  }

  function applyPermissions(){
    document.querySelectorAll(".match-card").forEach(applyPermissionsToCard);
    document.querySelectorAll(".add-tile").forEach(function(btn){
      btn.hidden = currentPlayer !== ADMIN_PLAYER;
    });
  }

  // ---------- auth UI ----------

  function setupAuthUI(){
    var pickWrap = document.getElementById("player-pick");
    var submitBtn = document.getElementById("auth-submit");
    var passwordInput = document.getElementById("auth-password");
    var errorEl = document.getElementById("auth-error");
    var selected = null;

    function refreshSubmit(){
      submitBtn.disabled = !(selected && passwordInput.value.length > 0);
    }

    pickWrap.querySelectorAll(".player-pick-btn").forEach(function(btn){
      btn.addEventListener("click", function(){
        pickWrap.querySelectorAll(".player-pick-btn").forEach(function(b){ b.classList.remove("is-selected"); });
        btn.classList.add("is-selected");
        selected = btn.dataset.player;
        errorEl.textContent = "";
        refreshSubmit();
      });
    });
    passwordInput.addEventListener("input", refreshSubmit);

    document.getElementById("auth-form").addEventListener("submit", function(e){
      e.preventDefault();
      if(!selected) return;
      submitBtn.disabled = true;
      errorEl.textContent = "";
      var email = playerEmail(selected);
      var password = passwordInput.value;

      // Modern Firebase Auth returns the same "auth/invalid-credential" for both
      // "no such account yet" and "wrong password" (email enumeration protection
      // hides which one it is) — so on any sign-in failure we try to create the
      // account; if it turns out the account already existed, createUser fails
      // with "email-already-in-use", which in this flow means "wrong password".
      firebase.auth().signInWithEmailAndPassword(email, password).catch(function(){
        return firebase.auth().createUserWithEmailAndPassword(email, password);
      }).catch(function(err){
        var messages = {
          "auth/email-already-in-use": "Неверный пароль.",
          "auth/weak-password": "Пароль слишком короткий — минимум 6 символов.",
          "auth/invalid-email": "Внутренняя ошибка идентификатора участника.",
          "auth/too-many-requests": "Слишком много попыток, подождите немного и попробуйте снова."
        };
        errorEl.textContent = messages[err.code] || ("Ошибка входа: " + err.message);
        submitBtn.disabled = false;
      });
    });

    document.getElementById("logout-btn").addEventListener("click", function(){
      firebase.auth().signOut();
    });
  }

  function initFirebase(){
    firebase.initializeApp(window.FIREBASE_CONFIG);
    db = firebase.database();
    setupAuthUI();

    firebase.auth().onAuthStateChanged(function(user){
      var pid = user ? emailToPlayer(user.email) : null;
      if(pid){
        currentPlayer = pid;
        showApp();
        applyPermissions();
        attachStageWatchers();
      } else {
        currentPlayer = null;
        showAuthScreen();
      }
    });
  }

  // ---------- wiring: clicks & inputs ----------

  function addMatch(stage){
    if(db){ addMatchRemote(stage); return; }
    var grid = gridFor(stage);
    var tile = grid.querySelector(".add-tile");
    grid.insertBefore(buildCard(stage, nextLocalId(stage), {}), tile);
    recompute();
    saveLocal();
  }

  function removeMatch(card){
    var stage = card.dataset.stage;
    var matchId = card.dataset.matchId;
    if(db){ removeMatchRemote(stage, matchId); return; }
    card.remove();
    recompute();
    saveLocal();
  }

  document.body.addEventListener("click", function(e){
    var addBtn = e.target.closest(".add-tile");
    if(addBtn){
      addMatch(addBtn.dataset.addStage);
      return;
    }
    var rmBtn = e.target.closest(".match-remove");
    if(rmBtn){
      var card = rmBtn.closest(".match-card");
      if(card) removeMatch(card);
      return;
    }
    var btn = e.target.closest(".toggle-btn");
    if(btn){
      if(btn.disabled) return;
      var group = btn.closest(".toggle-group");
      group.querySelectorAll(".toggle-btn").forEach(function(b){ b.classList.remove("is-selected"); });
      btn.classList.add("is-selected");
      recompute();

      var matchCard = btn.closest(".match-card");
      var stage = matchCard.dataset.stage;
      var matchId = matchCard.dataset.matchId;
      var row = btn.closest(".player-row");
      if(row){
        if(db){ pushPlayerField(stage, matchId, row.dataset.player, { time: btn.dataset.value }); }
      } else if(group.dataset.role === "actual-time"){
        if(db){ pushMatchField(stage, matchId, { time: btn.dataset.value }); }
      }
      if(!db) saveLocal();
    }
  });

  // tabs
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

  // score / prediction inputs + team names
  document.body.addEventListener("input", function(e){
    var el = e.target;
    var card = el.closest && el.closest(".match-card");
    if(!card) return;
    var stage = card.dataset.stage;
    var matchId = card.dataset.matchId;

    if(el.matches(".actual-home, .actual-away")){
      recompute();
      var aH = card.querySelector(".actual-home").value;
      var aA = card.querySelector(".actual-away").value;
      if(db){ pushMatchField(stage, matchId, { aH: aH, aA: aA }); } else { saveLocal(); }
      return;
    }
    if(el.matches(".team-home")){
      if(db){ pushMatchField(stage, matchId, { home: el.textContent.trim() }); } else { saveLocal(); }
      return;
    }
    if(el.matches(".team-away")){
      if(db){ pushMatchField(stage, matchId, { away: el.textContent.trim() }); } else { saveLocal(); }
      return;
    }
    if(el.matches(".fd-id-input")){
      if(currentPlayer !== ADMIN_PLAYER) return;
      var fdId = el.value.trim();
      if(db){ pushMatchField(stage, matchId, { fdId: fdId || null }); }
      return;
    }
    if(el.matches(".pred-home, .pred-away")){
      recompute();
      var row = el.closest(".player-row");
      var pid = row.dataset.player;
      var pH = row.querySelector(".pred-home").value;
      var pA = row.querySelector(".pred-away").value;
      if(db){ pushPlayerField(stage, matchId, pid, { pH: pH, pA: pA }); } else { saveLocal(); }
    }
  });

  // ---------- boot ----------

  recompute();

  // Kickoff-time locking (see isMatchStarted) depends on wall-clock time,
  // not just on data changing — without this, a card left open in a
  // browser wouldn't lock until *something* else triggered a recompute.
  setInterval(recompute, 20000);

  if(isFirebaseConfigured() && typeof firebase !== "undefined"){
    initFirebase();
  } else {
    document.getElementById("auth-screen").hidden = true;
    document.getElementById("app-wrap").hidden = false;
    setSyncStatus("Только в этом браузере", "sync-local");
    applyLocalState(loadLocal());
    recompute();
  }
})();
