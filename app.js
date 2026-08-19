(function(){
  "use strict";

  var PLAYERS = ["egor","ivan","sasha_r","sasha_t"];
  var PLAYER_LABEL = {egor:"Егор Б.", ivan:"Иван Г.", sasha_r:"Александр Р.", sasha_t:"Александр Т."};
  var STORAGE_KEY = "season2627.predictions.v1";

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

      var played = stage === "league"
        ? (aH!==null && aA!==null)
        : (aH!==null && aA!==null) || actualTime;

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

  // ---------- persistence (localStorage + optional Firebase sync) ----------

  function collectMatch(card, stage){
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
      var pd = {
        pH: row.querySelector(".pred-home").value,
        pA: row.querySelector(".pred-away").value
      };
      if(stage === "europe"){
        pd.time = selectedValue(row.querySelector('.toggle-group[data-role="pred-time"]'));
      }
      data.players[pid] = pd;
    });
    return data;
  }

  function collectState(){
    var state = { activeTab: document.querySelector(".tab-btn.is-active").dataset.tab, league: [], europe: [] };
    ["league","europe"].forEach(function(stage){
      document.querySelectorAll('.card-grid[data-stage-grid="' + stage + '"] .match-card').forEach(function(card){
        state[stage].push(collectMatch(card, stage));
      });
    });
    return state;
  }

  function loadState(){
    try{
      var raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    }catch(e){
      return null;
    }
  }

  // ---- Firebase Realtime Database (optional shared sync) ----
  // Filled in via firebase-config.js. Without it, the app keeps working
  // on localStorage alone (single browser, no cross-device sync).
  var fbRef = null;
  var fbReady = false;
  var lastPushedJSON = null;
  var pushTimer = null;
  var pendingRemoteState = null;

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

  function isEditingInGrid(){
    var el = document.activeElement;
    return !!(el && el.closest && el.closest(".card-grid"));
  }

  function applyRemoteState(state){
    // Don't yank a field out from under someone mid-edit — queue it
    // and apply as soon as they leave the grid.
    if(isEditingInGrid()){
      pendingRemoteState = state;
      return;
    }
    applyState(state);
    recompute();
  }

  document.addEventListener("focusout", function(e){
    if(!pendingRemoteState) return;
    if(!(e.target && e.target.closest && e.target.closest(".card-grid"))) return;
    var state = pendingRemoteState;
    pendingRemoteState = null;
    setTimeout(function(){
      if(!isEditingInGrid()){ applyState(state); recompute(); }
    }, 50);
  });

  function initFirebaseSync(){
    if(!isFirebaseConfigured() || typeof firebase === "undefined") return false;
    try{
      firebase.initializeApp(window.FIREBASE_CONFIG);
      fbRef = firebase.database().ref("predictions");
      fbReady = true;

      fbRef.on("value", function(snap){
        var data = snap.val();
        if(!data) return; // nothing shared yet — keep local/default state
        var json = JSON.stringify(data);
        if(json === lastPushedJSON) return; // our own write echoing back
        applyRemoteState(data);
      });

      firebase.database().ref(".info/connected").on("value", function(snap){
        setSyncStatus(snap.val() === true ? "Синхронизировано" : "Подключение…", snap.val() === true ? "sync-on" : "sync-off");
      });

      return true;
    }catch(err){
      console.warn("Firebase sync недоступен, работаем локально:", err);
      setSyncStatus("Только в этом браузере", "sync-local");
      return false;
    }
  }

  function saveState(){
    var state = collectState();
    try{
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    }catch(e){ /* storage unavailable (e.g. private mode) — silently skip */ }

    if(fbReady && fbRef){
      clearTimeout(pushTimer);
      pushTimer = setTimeout(function(){
        var json = JSON.stringify(state);
        lastPushedJSON = json;
        fbRef.set(state).catch(function(err){ console.warn("Не удалось отправить данные в Firebase:", err); });
      }, 400);
    }
  }

  function buildCardFromData(stage, data){
    var tpl = document.getElementById(stage === "league" ? "tpl-league" : "tpl-europe");
    var card = tpl.content.firstElementChild.cloneNode(true);
    card.querySelector(".team-home").textContent = data.home || "";
    card.querySelector(".team-away").textContent = data.away || "";
    card.querySelector(".actual-home").value = data.aH || "";
    card.querySelector(".actual-away").value = data.aA || "";
    if(stage === "europe" && data.time){
      selectToggle(card.querySelector(".time-row .toggle-group"), data.time);
    }
    PLAYERS.forEach(function(pid){
      var row = card.querySelector('.player-row[data-player="' + pid + '"]');
      var pd = (data.players && data.players[pid]) || {};
      row.querySelector(".pred-home").value = pd.pH || "";
      row.querySelector(".pred-away").value = pd.pA || "";
      if(stage === "europe" && pd.time){
        selectToggle(row.querySelector('.toggle-group[data-role="pred-time"]'), pd.time);
      }
    });
    return card;
  }

  function applyState(state){
    if(!state) return;
    ["league","europe"].forEach(function(stage){
      var grid = document.querySelector('.card-grid[data-stage-grid="' + stage + '"]');
      var tile = grid.querySelector(".add-tile");
      grid.querySelectorAll(".match-card").forEach(function(c){ c.remove(); });
      (state[stage] || []).forEach(function(m){
        grid.insertBefore(buildCardFromData(stage, m), tile);
      });
    });
    if(state.activeTab){
      var tabBtn = document.querySelector('.tab-btn[data-tab="' + state.activeTab + '"]');
      if(tabBtn) tabBtn.click();
    }
  }

  // ---------- interactions ----------

  function addMatch(stage){
    var tpl = document.getElementById(stage === "league" ? "tpl-league" : "tpl-europe");
    var grid = document.querySelector('.card-grid[data-stage-grid="' + stage + '"]');
    var tile = grid.querySelector(".add-tile");
    if(!tpl || !grid || !tile) return;
    var clone = tpl.content.firstElementChild.cloneNode(true);
    grid.insertBefore(clone, tile);
    recompute();
    saveState();
  }

  // clicks: add match, remove match, toggle buttons
  document.body.addEventListener("click", function(e){
    var addBtn = e.target.closest(".add-tile");
    if(addBtn){
      addMatch(addBtn.dataset.addStage);
      return;
    }
    var rmBtn = e.target.closest(".match-remove");
    if(rmBtn){
      var card = rmBtn.closest(".match-card");
      if(card) card.remove();
      recompute();
      saveState();
      return;
    }
    var btn = e.target.closest(".toggle-btn");
    if(btn){
      var group = btn.closest(".toggle-group");
      group.querySelectorAll(".toggle-btn").forEach(function(b){ b.classList.remove("is-selected"); });
      btn.classList.add("is-selected");
      recompute();
      saveState();
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

  // score / prediction inputs
  document.body.addEventListener("input", function(e){
    if(e.target.matches(".score-input, .pred-home, .pred-away")){
      recompute();
      saveState();
    } else if(e.target.matches(".team-name--edit")){
      saveState();
    }
  });

  applyState(loadState());
  recompute();

  if(initFirebaseSync()){
    setSyncStatus("Подключение…", "sync-off");
  } else {
    setSyncStatus("Только в этом браузере", "sync-local");
  }
})();
