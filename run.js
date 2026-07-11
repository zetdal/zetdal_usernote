// ==UserScript==
// @name         Zeta User Note (Persona Sync)
// @namespace    // ==UserScript==
// @name         Zeta User Note (Persona Sync)
// @namespace    zeta-usernote
// @version      3.5.1-autosync-toggle
// @description  유저가 쓴 노트를 채팅이 아니라 유저 페르소나(user-chat-profiles) API로 직접 동기화. 화면/대화기록에 전혀 안 남음. 자동동기화(기본 OFF, 토글 가능) + plotId 캐시 개선.
// @match        https://zeta-ai.io/*
// @match        https://*.zeta-ai.io/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(() => {

    "use strict";

    // ==========================
    // Zeta User Note v3.5.0 (Persona Sync — base + note + autosync)
    //
    // v3.4.0 대비 변경점:
    // 1) sniffOutgoingUrl: 이전엔 "URL에서 찾은 방ID === 현재 활성 roomId"일 때만
    //    plotId를 캐시했음 → SPA 라우팅 타이밍이 어긋나면 영영 못 잡고
    //    결국 plotId 없이 프로필을 조회해서 "기본 프로필"이 붙는 문제 발생.
    //    지금은 URL에서 찾은 방ID 기준으로 무조건 캐시해두고,
    //    현재 방과 같을 때만 활성 변수에도 반영. (+ 콘솔 디버그 로그)
    // 2) manualRefreshPersona: lastPlotId가 비어있으면 localStorage 캐시로 폴백.
    // 3) maybeAutoSync(): 노트 입력 / 페르소나 감지(=패널 열림, 방 진입) 시
    //    서버 값과 다르면 자동으로 동기화. 수동 "저장 & 동기화" 버튼은 그대로 유지(원하면 눌러도 됨).
    // 4) testMaxLength(): 서버가 실제로 허용하는 글자수 상한을 이진탐색으로 찾는 콘솔 유틸.
    //    (UI의 500자 제한과 별개로 API 자체에 상한이 있어서 긴 노트가 400으로 실패할 수 있음)
    //
    // 원리(기존과 동일):
    // - 채팅 메시지를 건드리지 않는다.
    // - 제타의 "유저 페르소나"(user-chat-profiles) description 필드를
    //   API(PATCH)로 직접 갱신한다. 채팅 메시지가 아니라 별도 설정이라
    //   대화기록엔 안 남고, AI에게는 항상(매 턴) 배경 정보로 로드된다.
    // - "기존 프로필(base)"과 "노트"를 완전히 분리해서 관리한다.
    // - 인증 토큰(Authorization 헤더)은 site가 만드는 실제 요청에서
    //   실시간으로 훔쳐봐서(sniff) 재사용한다.
    // ==========================

    if (window.__ZETA_USERNOTE_RUNNING__) {
        console.log("📝 Zeta UserNote already running.");
        return;
    }
    window.__ZETA_USERNOTE_RUNNING__ = true;

    const VERSION = "3.5.1-autosync-toggle";
    const DEBUG = true; // 콘솔(F12)에 plotId/roomId 감지 로그를 남길지 여부

    const PROFILES_LIST_RE = /\/v1\/user-chat-profiles(?:\?|$)/;
    const PLOT_ROOM_RE = /\/plots\/([^/]+)\/rooms\/([^/]+)\//;
    const PROFILE_PATCH_URL = (id) => `https://api.zeta-ai.io/v1/user-chat-profiles/${id}`;

    const POS_KEY = "zeta-usernote-pos"; // 전역: 버튼/패널 위치(드래그 결과)

    //------------------------------------------
    // 위치 (전역)
    //------------------------------------------

    function getPos() {
        try {
            return JSON.parse(localStorage.getItem(POS_KEY)) || { left: 16, bottom: 80 };
        } catch {
            return { left: 16, bottom: 80 };
        }
    }

    function savePos(pos) {
        localStorage.setItem(POS_KEY, JSON.stringify(pos));
    }

    //------------------------------------------
    // 방(room) 감지 - SPA 라우팅 대응
    //------------------------------------------

    function currentRoomId() {
        return location.pathname.split("/").pop();
    }

    let roomId = currentRoomId();

    function noteKey(id) {
        return `zeta-usernote-${id}`;
    }

    function getNote() {
        return localStorage.getItem(noteKey(roomId)) || "";
    }

    function saveNote(text) {
        localStorage.setItem(noteKey(roomId), text || "");
    }

    function plotIdKey(id) {
        return `zeta-usernote-plotid-${id}`;
    }

    function getCachedPlotId(id) {
        return localStorage.getItem(plotIdKey(id));
    }

    function setCachedPlotId(id, plotId) {
        localStorage.setItem(plotIdKey(id), plotId);
    }

    function personaKey(id) {
        return `zeta-usernote-persona-${id}`;
    }

    function getCachedPersona(id) {
        try {
            return JSON.parse(localStorage.getItem(personaKey(id)));
        } catch {
            return null;
        }
    }

    function setCachedPersona(id, persona) {
        localStorage.setItem(personaKey(id), JSON.stringify(persona));
    }

    // "기존 프로필(base)"은 노트랑 완전히 별개로 저장한다.
    function baseDescKey(id) {
        return `zeta-usernote-basedesc-${id}`;
    }

    function getCachedBaseDesc(id) {
        const v = localStorage.getItem(baseDescKey(id));
        return v === null ? null : v; // null = "아직 한 번도 base를 못 잡음"
    }

    function setCachedBaseDesc(id, text) {
        localStorage.setItem(baseDescKey(id), text || "");
    }

    // ★ v3.5.1: 자동동기화 on/off (전역 설정, 기본 OFF).
    //   OFF일 때는 입력해도 로컬에만 저장되고, 실제 프로필(서버)엔 "지금 바로 동기화" 버튼을
    //   눌러야만 반영됨 — 기존 페르소나 편집창이 원치 않게 바뀌는 걸 막기 위한 안전장치.
    const AUTOSYNC_KEY = "zeta-usernote-autosync-enabled";

    function isAutoSyncEnabled() {
        return localStorage.getItem(AUTOSYNC_KEY) === "true";
    }

    function setAutoSyncEnabled(v) {
        localStorage.setItem(AUTOSYNC_KEY, v ? "true" : "false");
    }

    //------------------------------------------
    // 실시간 훔쳐보기 상태: 인증 토큰 / plotId / 현재 페르소나
    //------------------------------------------

    let capturedAuth = null;
    let lastPlotId = getCachedPlotId(roomId);
    let capturedPersona = getCachedPersona(roomId); // { id, name, description }

    function sniffOutgoingUrl(url) {
        if (!url) return;
        const m = PLOT_ROOM_RE.exec(url);
        if (m) {
            const plotId = m[1];
            const rId = m[2];
            // ★ v3.5: 현재 활성 roomId와 일치하는지 여부와 무관하게,
            //   URL에서 찾은 실제 방ID 기준으로 항상 캐시해둔다.
            //   (타이밍 어긋나서 못 잡는 문제 방지)
            setCachedPlotId(rId, plotId);
            if (rId === roomId) {
                lastPlotId = plotId;
            }
            if (DEBUG) {
                console.log("📝 UserNote[debug] plot/room 감지:", { url, plotId, rId, activeRoomId: roomId });
            }
        }
    }

    function extractAuthFromHeaders(headers) {
        if (!headers) return null;
        try {
            if (typeof headers.get === "function") {
                return headers.get("authorization") || headers.get("Authorization");
            }
            if (Array.isArray(headers)) {
                for (const pair of headers) {
                    if (pair && pair[0] && pair[0].toLowerCase() === "authorization") return pair[1];
                }
                return null;
            }
            for (const k in headers) {
                if (k.toLowerCase() === "authorization") return headers[k];
            }
        } catch { /* ignore */ }
        return null;
    }

    function handlePossiblePersonaListResponse(text, atRoomId) {
        try {
            const data = JSON.parse(text);
            const list = data && data.userChatProfiles;
            if (!Array.isArray(list)) return;
            const sel = list.find(p => p && p.selected);
            if (sel && sel.id) {
                const persona = { id: sel.id, name: sel.name, description: sel.description || "" };
                setCachedPersona(atRoomId, persona);

                if (getCachedBaseDesc(atRoomId) === null) {
                    setCachedBaseDesc(atRoomId, persona.description);
                }

                if (atRoomId === roomId) {
                    capturedPersona = persona;
                    updatePersonaStatus();
                    maybeAutoSync(); // ★ v3.5: 페르소나 감지될 때 자동으로 노트 반영 시도
                }
                console.log("📝 UserNote: 페르소나 감지됨 (목록):", atRoomId, persona.id, persona.name);
            }
        } catch { /* ignore */ }
    }

    //------------------------------------------
    // UI - Shadow DOM으로 완전히 격리
    //------------------------------------------

    const host = document.createElement("div");
    host.id = "zeta-usernote-host";
    document.documentElement.appendChild(host);
    const root = host.attachShadow({ mode: "open" });

    root.innerHTML = `
<style>
  :host {
    all: initial;
    position: fixed !important;
    top: 0; left: 0;
    z-index: 2147483647 !important;
  }
  * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }

  #btn {
    position: fixed;
    width: 32px; height: 32px; border-radius: 50%;
    background: #ff5d8f; color: #fff;
    display: flex; align-items: center; justify-content: center;
    cursor: pointer;
    box-shadow: 0 3px 12px rgba(0,0,0,.5);
    border: 2px solid #fff;
    touch-action: none;
    user-select: none;
    -webkit-user-select: none;
    -webkit-touch-callout: none;
  }
  #btn svg { width: 15px; height: 15px; pointer-events: none; }
  #btn.dragging { opacity: 0.7; }
  #btn .dot {
    position: absolute; top: -2px; right: -2px;
    width: 8px; height: 8px; border-radius: 50%;
    border: 1.5px solid #17171c;
    display: none;
  }
  #btn.ready .dot { display: block; background: #7CFC9C; }
  #btn.no-auth .dot { display: block; background: #ffb347; }

  #panel {
    position: fixed;
    width: 280px; max-height: 70vh; overflow-y: auto;
    background: #17171c; color: #fff;
    border: 1px solid #ff5d8f; border-radius: 12px;
    padding: 12px; font-size: 12px; line-height: 1.5;
    box-shadow: 0 6px 24px rgba(0,0,0,.6);
    display: none;
  }
  #panel.open { display: block; }

  textarea {
    width: 100%; height: 26vh; background: #0d0d10; color: #fff;
    border: 1px solid #444; border-radius: 8px; padding: 8px;
    font-size: 12px; resize: vertical;
  }
  .row { display: flex; gap: 6px; margin-top: 8px; align-items: center; }
  button {
    background: #333; color: #fff; border: none; border-radius: 8px;
    padding: 7px 6px; font-size: 11px; cursor: pointer; flex: 1;
  }
  button.primary { background: #ff5d8f; }
  .title { font-weight: bold; font-size: 13px; margin-bottom: 4px; display: flex; justify-content: space-between; align-items: center; }
  .room { color: #999; font-size: 10px; margin-bottom: 8px; word-break: break-all; }
  .count { color: #999; font-size: 10px; text-align: right; margin-top: 4px; }
  .saved-badge { color: #7CFC9C; font-size: 10px; opacity: 0; transition: opacity .3s; white-space:nowrap; }
  .saved-badge.show { opacity: 1; }

  .persona-status {
    font-size: 10px; color: #ccc; background: #0d0d10;
    border: 1px solid #333; border-radius: 8px; padding: 6px 8px;
    margin-bottom: 8px; word-break: break-all;
  }
  .persona-status.ok { border-color: #2f6b3f; color: #7CFC9C; }
  .persona-status.bad { border-color: #6b4a2f; color: #ffb347; }

  .auto-note {
    font-size: 9px; color: #888; margin-top: 4px;
  }

  #debug-toast {
    position: fixed;
    left: 8px; right: 8px; bottom: 8px;
    background: #000; color: #7CFC9C;
    font-family: monospace;
    font-size: 10px; line-height: 1.4;
    padding: 8px 10px; border-radius: 8px;
    border: 1px solid #ff5d8f;
    opacity: 0; pointer-events: none;
    transition: opacity .3s;
    white-space: pre-wrap; word-break: break-all;
    z-index: 2147483647;
  }
  #debug-toast.show { opacity: 0.95; }

  hr { border: none; border-top: 1px solid #333; margin: 10px 0; }
</style>

<div id="btn"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg><span class="dot"></span></div>
<div id="debug-toast"></div>
<div id="panel">
  <div class="title">
    <span>User Note (Persona)</span>
    <span style="font-weight:normal;font-size:10px;color:#999;">v${VERSION}</span>
  </div>
  <div class="room" id="room"></div>

  <div class="persona-status" id="persona-status">감지 중...</div>

  <div class="row" style="align-items:center;">
    <label style="display:flex;align-items:center;gap:6px;font-size:11px;flex:1;">
      <input type="checkbox" id="autosync-toggle" style="width:14px;height:14px;">
      자동동기화 (끄면 버튼 눌러야만 반영)
    </label>
  </div>

  <textarea id="note" placeholder="여기 쓴 내용만 '노트'로 저장됩니다.
기존 페르소나 프로필 내용(이름/나이/설정 등)은 그대로 따로 유지되고,
'자동동기화'가 켜져 있을 때만 자동 반영되고, 꺼져있으면 버튼을 눌러야 반영됩니다."></textarea>
  <div class="count" id="count">0자</div>
  <div class="auto-note" id="auto-note-hint">✎ 자동동기화 꺼짐 → 버튼을 눌러야 실제 프로필에 반영됩니다.</div>

  <div class="row">
    <button class="primary" id="sync">지금 바로 동기화</button>
    <span class="saved-badge" id="saved">저장됨</span>
  </div>
  <div class="row">
    <button id="refresh-persona">기존 프로필 새로고침 (base 재설정)</button>
  </div>
  <div class="row">
    <button id="clear">노트 비우기</button>
  </div>

  <hr>

  <div class="row">
    <button id="export">⬇ 내보내기</button>
    <button id="import">⬆ 불러오기</button>
  </div>
  <div class="count" id="export-hint">이 방의 노트 텍스트만 백업/복원</div>

  <hr>

  <div class="row">
    <button id="reset-pos">버튼 위치 초기화</button>
  </div>
</div>
`;

    const el = (id) => root.getElementById(id);

    const btnEl = el("btn");
    const panelEl = el("panel");
    const noteEl = el("note");
    const roomEl = el("room");
    const countEl = el("count");
    const savedEl = el("saved");
    const personaStatusEl = el("persona-status");
    const autoSyncToggleEl = el("autosync-toggle");
    const autoNoteHintEl = el("auto-note-hint");

    function refreshAutoSyncHint() {
        const on = isAutoSyncEnabled();
        autoSyncToggleEl.checked = on;
        autoNoteHintEl.textContent = on
            ? "✎ 자동동기화 켜짐 → 입력하면 잠시 뒤 자동으로 실제 프로필에 반영됩니다."
            : "✎ 자동동기화 꺼짐 → 버튼을 눌러야 실제 프로필에 반영됩니다.";
    }

    autoSyncToggleEl.addEventListener("change", () => {
        setAutoSyncEnabled(autoSyncToggleEl.checked);
        refreshAutoSyncHint();
        flashSaved(autoSyncToggleEl.checked ? "자동동기화 켜짐" : "자동동기화 꺼짐");
        if (autoSyncToggleEl.checked) maybeAutoSync();
    });

    refreshAutoSyncHint();

    const BTN_SIZE = 32;
    const BTN_MARGIN = 4;

    function applyPos(pos) {
        btnEl.style.left = pos.left + "px";
        btnEl.style.bottom = pos.bottom + "px";
        panelEl.style.left = pos.left + "px";
        panelEl.style.bottom = (pos.bottom + BTN_SIZE + 10) + "px";
    }

    applyPos(getPos());

    function updateCount() {
        countEl.textContent = `${noteEl.value.length.toLocaleString()}자`;
    }

    function flashSaved(text) {
        savedEl.textContent = text || "저장됨";
        savedEl.classList.add("show");
        clearTimeout(flashSaved._t);
        flashSaved._t = setTimeout(() => savedEl.classList.remove("show"), 1600);
    }

    const debugToastEl = el("debug-toast");
    function showDebugToast(text) {
        debugToastEl.textContent = text;
        debugToastEl.classList.add("show");
        clearTimeout(showDebugToast._t);
        showDebugToast._t = setTimeout(() => debugToastEl.classList.remove("show"), 6000);
    }

    function updatePersonaStatus() {
        if (capturedPersona && capturedPersona.id) {
            const base = getCachedBaseDesc(roomId);
            const baseLen = base === null ? null : base.length;
            const noteLen = noteEl.value.length;

            personaStatusEl.className = "persona-status ok";
            personaStatusEl.textContent =
                `✅ 연결됨: ${capturedPersona.name || "(이름없음)"} (${capturedPersona.id.slice(0, 8)}...)\n` +
                (baseLen === null
                    ? "⚠ 기존 프로필(base) 아직 못 잡음 → '프로필 새로고침' 눌러주세요"
                    : `기존 프로필(고정) ${baseLen}자 + 노트 ${noteLen}자 = 합계 ${baseLen + noteLen + (noteLen ? 2 : 0)}자`);
        } else {
            personaStatusEl.className = "persona-status bad";
            personaStatusEl.textContent =
                "⚠ 아직 페르소나 정보를 못 잡았어요.\n채팅방을 한번 새로고침하거나, 페르소나 화면을 한번 열어봐 주세요.";
        }
        btnEl.classList.toggle("no-auth", !capturedAuth);
        btnEl.classList.toggle("ready", !!(capturedAuth && capturedPersona));
    }

    function refreshRoomUI() {
        roomEl.textContent = `Room: ${roomId.slice(0, 24)}`;
        noteEl.value = getNote();
        updateCount();
        updatePersonaStatus();
        maybeAutoSync(); // ★ v3.5: 패널 열거나 방 전환 시에도 자동 반영 체크
    }

    refreshRoomUI();

    //------------------------------------------
    // 패널 토글 (드래그와 클릭 구분)
    //------------------------------------------

    let dragging = false;
    let moved = false;
    let startX = 0, startY = 0;
    let startPos = null;

    function pointFromEvent(e) {
        if (e.touches && e.touches[0]) return { x: e.touches[0].clientX, y: e.touches[0].clientY };
        return { x: e.clientX, y: e.clientY };
    }

    function onDragStart(e) {
        dragging = true;
        moved = false;
        const p = pointFromEvent(e);
        startX = p.x;
        startY = p.y;
        startPos = getPos();
        btnEl.classList.add("dragging");
    }

    function onDragMove(e) {
        if (!dragging) return;
        const p = pointFromEvent(e);
        const dx = p.x - startX;
        const dy = p.y - startY;

        if (Math.abs(dx) > 6 || Math.abs(dy) > 6) moved = true;
        if (!moved) return;

        const newLeft = Math.min(Math.max(startPos.left + dx, 4), window.innerWidth - (BTN_SIZE + BTN_MARGIN));
        const newBottom = Math.min(Math.max(startPos.bottom - dy, 4), window.innerHeight - (BTN_SIZE + BTN_MARGIN));

        applyPos({ left: newLeft, bottom: newBottom });
    }

    function onDragEnd(e) {
        if (!dragging) return;
        dragging = false;
        btnEl.classList.remove("dragging");

        if (e && e.type === "touchend") e.preventDefault();

        if (moved) {
            savePos({
                left: parseFloat(btnEl.style.left) || 16,
                bottom: parseFloat(btnEl.style.bottom) || 80
            });
        } else {
            setPanelOpen(!panelEl.classList.contains("open"));
        }
    }

    const supportsTouch = ("ontouchstart" in window) || navigator.maxTouchPoints > 0;

    if (supportsTouch) {
        btnEl.addEventListener("touchstart", onDragStart, { passive: true });
        window.addEventListener("touchmove", onDragMove, { passive: true });
        window.addEventListener("touchend", onDragEnd, { passive: false });
        window.addEventListener("touchcancel", () => { dragging = false; btnEl.classList.remove("dragging"); });
    } else {
        btnEl.addEventListener("mousedown", onDragStart);
        window.addEventListener("mousemove", onDragMove);
        window.addEventListener("mouseup", onDragEnd);
    }

    function setPanelOpen(open) {
        panelEl.classList.toggle("open", open);
        if (open) refreshRoomUI();
    }

    document.addEventListener("click", (e) => {
        if (!panelEl.classList.contains("open")) return;
        if (host.contains(e.target) || (e.composedPath && e.composedPath().includes(host))) return;
        setPanelOpen(false);
    }, true);

    document.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && panelEl.classList.contains("open")) setPanelOpen(false);
    });

    //------------------------------------------
    // 동기화 (핵심)
    //------------------------------------------

    async function syncNow() {
        const note = noteEl.value;
        saveNote(note);

        if (!capturedAuth) {
            flashSaved("인증 정보 없음 ❌");
            showDebugToast("⚠ 아직 인증 토큰을 못 잡았어요.\n사이트에서 아무 동작이나(스크롤, 메뉴 클릭 등) 한 번 해보고 다시 시도해주세요.");
            return;
        }
        if (!capturedPersona || !capturedPersona.id) {
            flashSaved("프로필 정보 없음 ❌");
            showDebugToast("⚠ 아직 페르소나 정보를 못 잡았어요.\n'프로필 새로고침' 버튼을 눌러보거나, 채팅방을 새로고침해주세요.");
            return;
        }

        let base = getCachedBaseDesc(roomId);
        if (base === null) {
            flashSaved("기존 프로필 정보 없음 ❌");
            showDebugToast("⚠ 기존 프로필(base)을 아직 못 잡았어요.\n'프로필 새로고침' 버튼을 먼저 눌러서 기존 내용을 확보해주세요.");
            return;
        }

        const trimmedNote = note.trim();
        const newDesc = trimmedNote ? (base.replace(/\s+$/, "") + "\n\n" + trimmedNote) : base;

        try {
            const res = await originalFetch(PROFILE_PATCH_URL(capturedPersona.id), {
                method: "PATCH",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": capturedAuth
                },
                body: JSON.stringify({ name: capturedPersona.name, description: newDesc })
            });

            if (res.ok) {
                capturedPersona.description = newDesc;
                setCachedPersona(roomId, capturedPersona);
                flashSaved("동기화 완료 ✅");
                showDebugToast(`✅ 프로필에 동기화됨 (총 ${newDesc.length}자, 마지막 200자)\n` + newDesc.slice(-200));
                updatePersonaStatus();
            } else {
                const t = await res.text().catch(() => "");
                flashSaved("동기화 실패 ❌");
                showDebugToast(`❌ 실패 (HTTP ${res.status}, 시도한 총 글자수: ${newDesc.length}자)\n서버 글자수 제한일 수 있어요. 콘솔에서 ZetaUserNote.testMaxLength() 실행해보세요.\n` + t.slice(0, 200));
            }
        } catch (err) {
            flashSaved("동기화 실패 ❌");
            showDebugToast("❌ 네트워크 오류: " + (err && err.message));
        }
    }

    // ★ v3.5: 자동 동기화. 서버에 저장된 description이 이미 base+note와 같으면 아무 것도 안 함(불필요한 PATCH 방지).
    let autoSyncTimer = null;
    function maybeAutoSync() {
        if (!isAutoSyncEnabled()) return; // ★ 토글 OFF면 자동으로는 절대 서버에 안 씀
        clearTimeout(autoSyncTimer);
        autoSyncTimer = setTimeout(() => {
            const note = getNote().trim();
            if (!capturedAuth || !capturedPersona || !capturedPersona.id) return;
            const base = getCachedBaseDesc(roomId);
            if (base === null) return; // base 아직 없음 → refresh-persona 필요, 억지로 시도 안 함
            const expected = note ? (base.replace(/\s+$/, "") + "\n\n" + note) : base;
            if ((capturedPersona.description || "") === expected) return; // 이미 동기화된 상태
            syncNow();
        }, 500);
    }

    async function manualRefreshPersona() {
        if (!capturedAuth) {
            showDebugToast("⚠ 아직 인증 토큰을 못 잡았어요. 사이트를 조작해본 뒤 다시 시도해주세요.");
            flashSaved("실패 ❌");
            return;
        }
        // ★ v3.5: lastPlotId가 비어있으면 localStorage 캐시로 폴백
        const plotId = lastPlotId || getCachedPlotId(roomId);
        if (!plotId) {
            showDebugToast("⚠ plotId를 아직 못 찾았어요. 콘솔(F12)에 'UserNote[debug] plot/room 감지' 로그가 뜨는지 확인해주세요.\n방 안에서 스크롤하거나 메시지를 하나 보내본 뒤 다시 시도해주세요.");
            flashSaved("실패 ❌ (plotId 없음)");
            return;
        }
        lastPlotId = plotId;
        const url = `https://api.zeta-ai.io/v1/user-chat-profiles?plotId=${plotId}`;
        try {
            const res = await originalFetch(url, { headers: { "Authorization": capturedAuth } });
            const bodyText = await res.text();

            if (res.ok) {
                let data = null;
                try { data = JSON.parse(bodyText); } catch { /* ignore */ }

                const list = data && data.userChatProfiles;
                const sel = Array.isArray(list) ? list.find(p => p && p.selected) : null;

                if (sel && sel.id) {
                    capturedPersona = { id: sel.id, name: sel.name, description: sel.description || "" };
                    setCachedPersona(roomId, capturedPersona);
                    setCachedBaseDesc(roomId, sel.description || "");
                    updatePersonaStatus();
                    flashSaved("프로필 새로고침됨 ✅");
                    showDebugToast(
                        "✅ 서버의 현재 description을 새 base로 저장했어요.\n" +
                        "⚠ 참고: Zeta 화면에서 직접 프로필을 수정한 게 아니라면, 이 값엔 이전에 동기화했던 노트가 이미 섞여 있을 수 있어요.\n" +
                        `사용된 plotId: ${plotId}`
                    );
                    maybeAutoSync();
                    return;
                }

                flashSaved("새로고침 실패 ❌ (선택된 페르소나 없음)");
                showDebugToast(
                    "❌ 요청은 성공(200)했지만 selected:true인 페르소나가 없어요.\n" +
                    "URL: " + url + "\n" +
                    "응답: " + bodyText.slice(0, 200)
                );
                return;
            }

            flashSaved("새로고침 실패 ❌");
            showDebugToast(`❌ 새로고침 실패 (HTTP ${res.status})\nURL: ${url}\n응답: ${bodyText.slice(0, 200)}`);
        } catch (err) {
            flashSaved("새로고침 실패 ❌");
            showDebugToast("❌ 네트워크 오류: " + (err && err.message) + "\nURL: " + url);
        }
    }

    // ★ 서버가 실제로 허용하는 최대 글자수를 이진탐색으로 찾는 콘솔 유틸.
    //   콘솔에서: await ZetaUserNote.testMaxLength()
    //   주의: 테스트 중 프로필 description이 임시로 더미문자(x)로 여러 번 덮어써집니다.
    //         테스트가 끝나면 반드시 패널에서 '지금 바로 동기화'를 눌러 실제 노트로 되돌리세요.
    async function testMaxLength() {
        if (!capturedAuth || !capturedPersona || !capturedPersona.id) {
            console.log("❌ auth/persona 없음. 패널을 한번 열고 다시 시도해주세요.");
            return null;
        }
        const base = getCachedBaseDesc(roomId) || "";
        let lo = 0, hi = 4000, lastOk = 0;
        console.log("🔍 서버 실제 글자수 제한 탐색 시작... (프로필이 임시로 여러 번 덮어써집니다)");
        while (lo <= hi) {
            const mid = Math.floor((lo + hi) / 2);
            const testDesc = base.replace(/\s+$/, "") + "\n\n" + "x".repeat(mid);
            try {
                const res = await originalFetch(PROFILE_PATCH_URL(capturedPersona.id), {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json", "Authorization": capturedAuth },
                    body: JSON.stringify({ name: capturedPersona.name, description: testDesc })
                });
                if (res.ok) { lastOk = mid; lo = mid + 1; }
                else { hi = mid - 1; }
            } catch (err) {
                console.log("❌ 테스트 중 네트워크 오류:", err && err.message);
                break;
            }
        }
        const totalMax = lastOk + base.length + 2;
        console.log(`✅ 대략적인 노트 최대 글자수: ${lastOk}자 (base ${base.length}자 포함 총 약 ${totalMax}자)`);
        console.log("⚠ 지금 프로필엔 테스트용 'x' 문자열이 남아있어요. 패널 열고 '지금 바로 동기화'를 눌러 실제 노트로 덮어써주세요.");
        return { noteMax: lastOk, base: base.length, total: totalMax };
    }

    let saveDebounce = null;
    noteEl.addEventListener("input", () => {
        updateCount();
        updatePersonaStatus();
        clearTimeout(saveDebounce);
        saveDebounce = setTimeout(() => {
            saveNote(noteEl.value);
            maybeAutoSync(); // ★ v3.5: 입력만 해도 자동 반영, 버튼 안 눌러도 됨
        }, 800);
    });

    el("sync").addEventListener("click", syncNow);
    el("refresh-persona").addEventListener("click", manualRefreshPersona);

    el("clear").addEventListener("click", () => {
        if (!confirm("노트를 비울까요? (기존 페르소나 프로필 내용은 영향 없어요)")) return;
        noteEl.value = "";
        saveNote("");
        updateCount();
        flashSaved("비움 (자동 반영됨)");
        maybeAutoSync();
    });

    el("reset-pos").addEventListener("click", () => {
        const defaultPos = { left: 16, bottom: 80 };
        savePos(defaultPos);
        applyPos(defaultPos);
        flashSaved("위치 초기화됨");
    });

    //------------------------------------------
    // 방 이동 감지 (SPA 라우팅 대응)
    //------------------------------------------

    setInterval(() => {
        const id = currentRoomId();
        if (id !== roomId) {
            roomId = id;
            lastPlotId = getCachedPlotId(roomId);
            capturedPersona = getCachedPersona(roomId);
            refreshRoomUI();
        }
    }, 1000);

    //------------------------------------------
    // fetch 훔쳐보기: 인증 헤더 + 페르소나 응답 + plotId 캐치
    //------------------------------------------

    const originalFetch = window.fetch;

    window.fetch = async function (input, init) {
        let url = "";
        const sendRoomId = roomId;
        try {
            url = typeof input === "string" ? input : (input && input.url) || "";
            const headers = (init && init.headers) || (typeof input !== "string" && input && input.headers);
            const authVal = extractAuthFromHeaders(headers);
            if (authVal) {
                if (!capturedAuth) console.log("📝 UserNote: 인증 토큰 감지됨 (fetch)");
                capturedAuth = authVal;
            }
            sniffOutgoingUrl(url);
        } catch (err) {
            console.error("❌ User Note 처리 실패 (fetch 요청단계)", err);
        }

        const res = await originalFetch.call(this, input, init);

        try {
            if (PROFILES_LIST_RE.test(url)) {
                res.clone().text().then(text => handlePossiblePersonaListResponse(text, sendRoomId)).catch(() => {});
            }
        } catch (err) {
            console.error("❌ User Note 처리 실패 (fetch 응답단계)", err);
        }

        return res;
    };

    //------------------------------------------
    // XMLHttpRequest 훔쳐보기 (제타 자체 API는 XHR을 씀)
    //------------------------------------------

    const OrigXHR = window.XMLHttpRequest;
    const origOpen = OrigXHR.prototype.open;
    const origSend = OrigXHR.prototype.send;
    const origSetHeader = OrigXHR.prototype.setRequestHeader;

    OrigXHR.prototype.open = function (method, url, ...rest) {
        this.__zetaMethod = (method || "GET").toUpperCase();
        this.__zetaURL = url;
        return origOpen.call(this, method, url, ...rest);
    };

    OrigXHR.prototype.setRequestHeader = function (name, value) {
        try {
            if (name && name.toLowerCase() === "authorization") {
                if (!capturedAuth) console.log("📝 UserNote: 인증 토큰 감지됨 (XHR)");
                capturedAuth = value;
            }
        } catch { /* ignore */ }
        return origSetHeader.call(this, name, value);
    };

    OrigXHR.prototype.send = function (body) {
        try {
            sniffOutgoingUrl(this.__zetaURL);

            if (this.__zetaMethod === "GET" && PROFILES_LIST_RE.test(this.__zetaURL || "")) {
                const sendRoomId = roomId;
                this.addEventListener("load", function () {
                    try { handlePossiblePersonaListResponse(this.responseText, sendRoomId); } catch { /* ignore */ }
                });
            }
        } catch (err) {
            console.error("❌ User Note 처리 실패 (XHR)", err);
        }

        return origSend.call(this, body);
    };

    //------------------------------------------
    // Export / Import (이 방의 노트 텍스트만)
    //------------------------------------------

    function downloadJson(obj, filename) {
        const blob = new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
    }

    function todayStr() {
        return new Date().toISOString().slice(0, 10);
    }

    function exportRoom() {
        const data = {
            kind: "zeta-usernote-room-backup",
            version: VERSION,
            roomId,
            exportedAt: Date.now(),
            note: getNote()
        };
        downloadJson(data, `zeta-usernote-room-${roomId}-${todayStr()}.json`);
        flashSaved("Export 완료");
    }

    function pickFile(onPicked) {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = "application/json";
        input.style.display = "none";
        input.addEventListener("change", () => {
            if (input.files && input.files[0]) onPicked(input.files[0]);
            input.remove();
        });
        document.body.appendChild(input);
        input.click();
    }

    function importRoomFile(file) {
        file.text().then(text => {
            try {
                const data = JSON.parse(text);
                if (data.kind !== "zeta-usernote-room-backup") {
                    alert("이 파일은 Room 백업 파일이 아닙니다.");
                    return;
                }
                if (!confirm(`현재 방(${roomId})의 노트를 백업 파일 내용으로 덮어씁니다. 계속할까요? (자동으로 동기화됩니다)`)) return;

                if (data.note != null) {
                    noteEl.value = data.note;
                    saveNote(data.note);
                    updateCount();
                    maybeAutoSync();
                }
                flashSaved("Import 완료");
            } catch (err) {
                console.error(err);
                alert("파일을 읽는 중 오류가 발생했습니다.");
            }
        });
    }

    el("export").addEventListener("click", exportRoom);
    el("import").addEventListener("click", () => {
        pickFile((file) => importRoomFile(file));
    });

    //------------------------------------------
    // Public API
    //------------------------------------------

    window.ZetaUserNote = {
        version: VERSION,
        getNote,
        saveNote,
        syncNow,
        manualRefreshPersona,
        testMaxLength,
        isAutoSyncEnabled,
        setAutoSyncEnabled: (v) => { setAutoSyncEnabled(v); refreshAutoSyncHint(); },
        get roomId() { return roomId; },
        get capturedPersona() { return capturedPersona; },
        get hasAuth() { return !!capturedAuth; }
    };

    console.log(`📝 Zeta UserNote v${VERSION} (Persona Sync, Auto-Sync) Ready`);

})();
zeta-usernote
// @version      3.5.0-autosync
// @description  유저가 쓴 노트를 채팅이 아니라 유저 페르소나(user-chat-profiles) API로 직접 동기화. 화면/대화기록에 전혀 안 남음. 자동동기화 + plotId 캐시 개선.
// @match        https://zeta-ai.io/*
// @match        https://*.zeta-ai.io/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(() => {

    "use strict";

    // ==========================
    // Zeta User Note v3.5.0 (Persona Sync — base + note + autosync)
    //
    // v3.4.0 대비 변경점:
    // 1) sniffOutgoingUrl: 이전엔 "URL에서 찾은 방ID === 현재 활성 roomId"일 때만
    //    plotId를 캐시했음 → SPA 라우팅 타이밍이 어긋나면 영영 못 잡고
    //    결국 plotId 없이 프로필을 조회해서 "기본 프로필"이 붙는 문제 발생.
    //    지금은 URL에서 찾은 방ID 기준으로 무조건 캐시해두고,
    //    현재 방과 같을 때만 활성 변수에도 반영. (+ 콘솔 디버그 로그)
    // 2) manualRefreshPersona: lastPlotId가 비어있으면 localStorage 캐시로 폴백.
    // 3) maybeAutoSync(): 노트 입력 / 페르소나 감지(=패널 열림, 방 진입) 시
    //    서버 값과 다르면 자동으로 동기화. 수동 "저장 & 동기화" 버튼은 그대로 유지(원하면 눌러도 됨).
    // 4) testMaxLength(): 서버가 실제로 허용하는 글자수 상한을 이진탐색으로 찾는 콘솔 유틸.
    //    (UI의 500자 제한과 별개로 API 자체에 상한이 있어서 긴 노트가 400으로 실패할 수 있음)
    //
    // 원리(기존과 동일):
    // - 채팅 메시지를 건드리지 않는다.
    // - 제타의 "유저 페르소나"(user-chat-profiles) description 필드를
    //   API(PATCH)로 직접 갱신한다. 채팅 메시지가 아니라 별도 설정이라
    //   대화기록엔 안 남고, AI에게는 항상(매 턴) 배경 정보로 로드된다.
    // - "기존 프로필(base)"과 "노트"를 완전히 분리해서 관리한다.
    // - 인증 토큰(Authorization 헤더)은 site가 만드는 실제 요청에서
    //   실시간으로 훔쳐봐서(sniff) 재사용한다.
    // ==========================

    if (window.__ZETA_USERNOTE_RUNNING__) {
        console.log("📝 Zeta UserNote already running.");
        return;
    }
    window.__ZETA_USERNOTE_RUNNING__ = true;

    const VERSION = "3.5.0-autosync";
    const DEBUG = true; // 콘솔(F12)에 plotId/roomId 감지 로그를 남길지 여부

    const PROFILES_LIST_RE = /\/v1\/user-chat-profiles(?:\?|$)/;
    const PLOT_ROOM_RE = /\/plots\/([^/]+)\/rooms\/([^/]+)\//;
    const PROFILE_PATCH_URL = (id) => `https://api.zeta-ai.io/v1/user-chat-profiles/${id}`;

    const POS_KEY = "zeta-usernote-pos"; // 전역: 버튼/패널 위치(드래그 결과)

    //------------------------------------------
    // 위치 (전역)
    //------------------------------------------

    function getPos() {
        try {
            return JSON.parse(localStorage.getItem(POS_KEY)) || { left: 16, bottom: 80 };
        } catch {
            return { left: 16, bottom: 80 };
        }
    }

    function savePos(pos) {
        localStorage.setItem(POS_KEY, JSON.stringify(pos));
    }

    //------------------------------------------
    // 방(room) 감지 - SPA 라우팅 대응
    //------------------------------------------

    function currentRoomId() {
        return location.pathname.split("/").pop();
    }

    let roomId = currentRoomId();

    function noteKey(id) {
        return `zeta-usernote-${id}`;
    }

    function getNote() {
        return localStorage.getItem(noteKey(roomId)) || "";
    }

    function saveNote(text) {
        localStorage.setItem(noteKey(roomId), text || "");
    }

    function plotIdKey(id) {
        return `zeta-usernote-plotid-${id}`;
    }

    function getCachedPlotId(id) {
        return localStorage.getItem(plotIdKey(id));
    }

    function setCachedPlotId(id, plotId) {
        localStorage.setItem(plotIdKey(id), plotId);
    }

    function personaKey(id) {
        return `zeta-usernote-persona-${id}`;
    }

    function getCachedPersona(id) {
        try {
            return JSON.parse(localStorage.getItem(personaKey(id)));
        } catch {
            return null;
        }
    }

    function setCachedPersona(id, persona) {
        localStorage.setItem(personaKey(id), JSON.stringify(persona));
    }

    // "기존 프로필(base)"은 노트랑 완전히 별개로 저장한다.
    function baseDescKey(id) {
        return `zeta-usernote-basedesc-${id}`;
    }

    function getCachedBaseDesc(id) {
        const v = localStorage.getItem(baseDescKey(id));
        return v === null ? null : v; // null = "아직 한 번도 base를 못 잡음"
    }

    function setCachedBaseDesc(id, text) {
        localStorage.setItem(baseDescKey(id), text || "");
    }

    //------------------------------------------
    // 실시간 훔쳐보기 상태: 인증 토큰 / plotId / 현재 페르소나
    //------------------------------------------

    let capturedAuth = null;
    let lastPlotId = getCachedPlotId(roomId);
    let capturedPersona = getCachedPersona(roomId); // { id, name, description }

    function sniffOutgoingUrl(url) {
        if (!url) return;
        const m = PLOT_ROOM_RE.exec(url);
        if (m) {
            const plotId = m[1];
            const rId = m[2];
            // ★ v3.5: 현재 활성 roomId와 일치하는지 여부와 무관하게,
            //   URL에서 찾은 실제 방ID 기준으로 항상 캐시해둔다.
            //   (타이밍 어긋나서 못 잡는 문제 방지)
            setCachedPlotId(rId, plotId);
            if (rId === roomId) {
                lastPlotId = plotId;
            }
            if (DEBUG) {
                console.log("📝 UserNote[debug] plot/room 감지:", { url, plotId, rId, activeRoomId: roomId });
            }
        }
    }

    function extractAuthFromHeaders(headers) {
        if (!headers) return null;
        try {
            if (typeof headers.get === "function") {
                return headers.get("authorization") || headers.get("Authorization");
            }
            if (Array.isArray(headers)) {
                for (const pair of headers) {
                    if (pair && pair[0] && pair[0].toLowerCase() === "authorization") return pair[1];
                }
                return null;
            }
            for (const k in headers) {
                if (k.toLowerCase() === "authorization") return headers[k];
            }
        } catch { /* ignore */ }
        return null;
    }

    function handlePossiblePersonaListResponse(text, atRoomId) {
        try {
            const data = JSON.parse(text);
            const list = data && data.userChatProfiles;
            if (!Array.isArray(list)) return;
            const sel = list.find(p => p && p.selected);
            if (sel && sel.id) {
                const persona = { id: sel.id, name: sel.name, description: sel.description || "" };
                setCachedPersona(atRoomId, persona);

                if (getCachedBaseDesc(atRoomId) === null) {
                    setCachedBaseDesc(atRoomId, persona.description);
                }

                if (atRoomId === roomId) {
                    capturedPersona = persona;
                    updatePersonaStatus();
                    maybeAutoSync(); // ★ v3.5: 페르소나 감지될 때 자동으로 노트 반영 시도
                }
                console.log("📝 UserNote: 페르소나 감지됨 (목록):", atRoomId, persona.id, persona.name);
            }
        } catch { /* ignore */ }
    }

    //------------------------------------------
    // UI - Shadow DOM으로 완전히 격리
    //------------------------------------------

    const host = document.createElement("div");
    host.id = "zeta-usernote-host";
    document.documentElement.appendChild(host);
    const root = host.attachShadow({ mode: "open" });

    root.innerHTML = `
<style>
  :host {
    all: initial;
    position: fixed !important;
    top: 0; left: 0;
    z-index: 2147483647 !important;
  }
  * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }

  #btn {
    position: fixed;
    width: 32px; height: 32px; border-radius: 50%;
    background: #ff5d8f; color: #fff;
    display: flex; align-items: center; justify-content: center;
    cursor: pointer;
    box-shadow: 0 3px 12px rgba(0,0,0,.5);
    border: 2px solid #fff;
    touch-action: none;
    user-select: none;
    -webkit-user-select: none;
    -webkit-touch-callout: none;
  }
  #btn svg { width: 15px; height: 15px; pointer-events: none; }
  #btn.dragging { opacity: 0.7; }
  #btn .dot {
    position: absolute; top: -2px; right: -2px;
    width: 8px; height: 8px; border-radius: 50%;
    border: 1.5px solid #17171c;
    display: none;
  }
  #btn.ready .dot { display: block; background: #7CFC9C; }
  #btn.no-auth .dot { display: block; background: #ffb347; }

  #panel {
    position: fixed;
    width: 280px; max-height: 70vh; overflow-y: auto;
    background: #17171c; color: #fff;
    border: 1px solid #ff5d8f; border-radius: 12px;
    padding: 12px; font-size: 12px; line-height: 1.5;
    box-shadow: 0 6px 24px rgba(0,0,0,.6);
    display: none;
  }
  #panel.open { display: block; }

  textarea {
    width: 100%; height: 26vh; background: #0d0d10; color: #fff;
    border: 1px solid #444; border-radius: 8px; padding: 8px;
    font-size: 12px; resize: vertical;
  }
  .row { display: flex; gap: 6px; margin-top: 8px; align-items: center; }
  button {
    background: #333; color: #fff; border: none; border-radius: 8px;
    padding: 7px 6px; font-size: 11px; cursor: pointer; flex: 1;
  }
  button.primary { background: #ff5d8f; }
  .title { font-weight: bold; font-size: 13px; margin-bottom: 4px; display: flex; justify-content: space-between; align-items: center; }
  .room { color: #999; font-size: 10px; margin-bottom: 8px; word-break: break-all; }
  .count { color: #999; font-size: 10px; text-align: right; margin-top: 4px; }
  .saved-badge { color: #7CFC9C; font-size: 10px; opacity: 0; transition: opacity .3s; white-space:nowrap; }
  .saved-badge.show { opacity: 1; }

  .persona-status {
    font-size: 10px; color: #ccc; background: #0d0d10;
    border: 1px solid #333; border-radius: 8px; padding: 6px 8px;
    margin-bottom: 8px; word-break: break-all;
  }
  .persona-status.ok { border-color: #2f6b3f; color: #7CFC9C; }
  .persona-status.bad { border-color: #6b4a2f; color: #ffb347; }

  .auto-note {
    font-size: 9px; color: #888; margin-top: 4px;
  }

  #debug-toast {
    position: fixed;
    left: 8px; right: 8px; bottom: 8px;
    background: #000; color: #7CFC9C;
    font-family: monospace;
    font-size: 10px; line-height: 1.4;
    padding: 8px 10px; border-radius: 8px;
    border: 1px solid #ff5d8f;
    opacity: 0; pointer-events: none;
    transition: opacity .3s;
    white-space: pre-wrap; word-break: break-all;
    z-index: 2147483647;
  }
  #debug-toast.show { opacity: 0.95; }

  hr { border: none; border-top: 1px solid #333; margin: 10px 0; }
</style>

<div id="btn"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg><span class="dot"></span></div>
<div id="debug-toast"></div>
<div id="panel">
  <div class="title">
    <span>User Note (Persona)</span>
    <span style="font-weight:normal;font-size:10px;color:#999;">v${VERSION}</span>
  </div>
  <div class="room" id="room"></div>

  <div class="persona-status" id="persona-status">감지 중...</div>

  <textarea id="note" placeholder="여기 쓴 내용만 '노트'로 저장됩니다.
기존 페르소나 프로필 내용(이름/나이/설정 등)은 그대로 따로 유지되고,
입력하면 자동으로 동기화됩니다 (버튼 안 눌러도 됨)."></textarea>
  <div class="count" id="count">0자</div>
  <div class="auto-note">✎ 입력 후 잠시 뒤 자동 동기화됩니다. 버튼은 즉시 반영하고 싶을 때만 누르세요.</div>

  <div class="row">
    <button class="primary" id="sync">지금 바로 동기화</button>
    <span class="saved-badge" id="saved">저장됨</span>
  </div>
  <div class="row">
    <button id="refresh-persona">기존 프로필 새로고침 (base 재설정)</button>
  </div>
  <div class="row">
    <button id="clear">노트 비우기</button>
  </div>

  <hr>

  <div class="row">
    <button id="export">⬇ 내보내기</button>
    <button id="import">⬆ 불러오기</button>
  </div>
  <div class="count" id="export-hint">이 방의 노트 텍스트만 백업/복원</div>

  <hr>

  <div class="row">
    <button id="reset-pos">버튼 위치 초기화</button>
  </div>
</div>
`;

    const el = (id) => root.getElementById(id);

    const btnEl = el("btn");
    const panelEl = el("panel");
    const noteEl = el("note");
    const roomEl = el("room");
    const countEl = el("count");
    const savedEl = el("saved");
    const personaStatusEl = el("persona-status");

    const BTN_SIZE = 32;
    const BTN_MARGIN = 4;

    function applyPos(pos) {
        btnEl.style.left = pos.left + "px";
        btnEl.style.bottom = pos.bottom + "px";
        panelEl.style.left = pos.left + "px";
        panelEl.style.bottom = (pos.bottom + BTN_SIZE + 10) + "px";
    }

    applyPos(getPos());

    function updateCount() {
        countEl.textContent = `${noteEl.value.length.toLocaleString()}자`;
    }

    function flashSaved(text) {
        savedEl.textContent = text || "저장됨";
        savedEl.classList.add("show");
        clearTimeout(flashSaved._t);
        flashSaved._t = setTimeout(() => savedEl.classList.remove("show"), 1600);
    }

    const debugToastEl = el("debug-toast");
    function showDebugToast(text) {
        debugToastEl.textContent = text;
        debugToastEl.classList.add("show");
        clearTimeout(showDebugToast._t);
        showDebugToast._t = setTimeout(() => debugToastEl.classList.remove("show"), 6000);
    }

    function updatePersonaStatus() {
        if (capturedPersona && capturedPersona.id) {
            const base = getCachedBaseDesc(roomId);
            const baseLen = base === null ? null : base.length;
            const noteLen = noteEl.value.length;

            personaStatusEl.className = "persona-status ok";
            personaStatusEl.textContent =
                `✅ 연결됨: ${capturedPersona.name || "(이름없음)"} (${capturedPersona.id.slice(0, 8)}...)\n` +
                (baseLen === null
                    ? "⚠ 기존 프로필(base) 아직 못 잡음 → '프로필 새로고침' 눌러주세요"
                    : `기존 프로필(고정) ${baseLen}자 + 노트 ${noteLen}자 = 합계 ${baseLen + noteLen + (noteLen ? 2 : 0)}자`);
        } else {
            personaStatusEl.className = "persona-status bad";
            personaStatusEl.textContent =
                "⚠ 아직 페르소나 정보를 못 잡았어요.\n채팅방을 한번 새로고침하거나, 페르소나 화면을 한번 열어봐 주세요.";
        }
        btnEl.classList.toggle("no-auth", !capturedAuth);
        btnEl.classList.toggle("ready", !!(capturedAuth && capturedPersona));
    }

    function refreshRoomUI() {
        roomEl.textContent = `Room: ${roomId.slice(0, 24)}`;
        noteEl.value = getNote();
        updateCount();
        updatePersonaStatus();
        maybeAutoSync(); // ★ v3.5: 패널 열거나 방 전환 시에도 자동 반영 체크
    }

    refreshRoomUI();

    //------------------------------------------
    // 패널 토글 (드래그와 클릭 구분)
    //------------------------------------------

    let dragging = false;
    let moved = false;
    let startX = 0, startY = 0;
    let startPos = null;

    function pointFromEvent(e) {
        if (e.touches && e.touches[0]) return { x: e.touches[0].clientX, y: e.touches[0].clientY };
        return { x: e.clientX, y: e.clientY };
    }

    function onDragStart(e) {
        dragging = true;
        moved = false;
        const p = pointFromEvent(e);
        startX = p.x;
        startY = p.y;
        startPos = getPos();
        btnEl.classList.add("dragging");
    }

    function onDragMove(e) {
        if (!dragging) return;
        const p = pointFromEvent(e);
        const dx = p.x - startX;
        const dy = p.y - startY;

        if (Math.abs(dx) > 6 || Math.abs(dy) > 6) moved = true;
        if (!moved) return;

        const newLeft = Math.min(Math.max(startPos.left + dx, 4), window.innerWidth - (BTN_SIZE + BTN_MARGIN));
        const newBottom = Math.min(Math.max(startPos.bottom - dy, 4), window.innerHeight - (BTN_SIZE + BTN_MARGIN));

        applyPos({ left: newLeft, bottom: newBottom });
    }

    function onDragEnd(e) {
        if (!dragging) return;
        dragging = false;
        btnEl.classList.remove("dragging");

        if (e && e.type === "touchend") e.preventDefault();

        if (moved) {
            savePos({
                left: parseFloat(btnEl.style.left) || 16,
                bottom: parseFloat(btnEl.style.bottom) || 80
            });
        } else {
            setPanelOpen(!panelEl.classList.contains("open"));
        }
    }

    const supportsTouch = ("ontouchstart" in window) || navigator.maxTouchPoints > 0;

    if (supportsTouch) {
        btnEl.addEventListener("touchstart", onDragStart, { passive: true });
        window.addEventListener("touchmove", onDragMove, { passive: true });
        window.addEventListener("touchend", onDragEnd, { passive: false });
        window.addEventListener("touchcancel", () => { dragging = false; btnEl.classList.remove("dragging"); });
    } else {
        btnEl.addEventListener("mousedown", onDragStart);
        window.addEventListener("mousemove", onDragMove);
        window.addEventListener("mouseup", onDragEnd);
    }

    function setPanelOpen(open) {
        panelEl.classList.toggle("open", open);
        if (open) refreshRoomUI();
    }

    document.addEventListener("click", (e) => {
        if (!panelEl.classList.contains("open")) return;
        if (host.contains(e.target) || (e.composedPath && e.composedPath().includes(host))) return;
        setPanelOpen(false);
    }, true);

    document.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && panelEl.classList.contains("open")) setPanelOpen(false);
    });

    //------------------------------------------
    // 동기화 (핵심)
    //------------------------------------------

    async function syncNow() {
        const note = noteEl.value;
        saveNote(note);

        if (!capturedAuth) {
            flashSaved("인증 정보 없음 ❌");
            showDebugToast("⚠ 아직 인증 토큰을 못 잡았어요.\n사이트에서 아무 동작이나(스크롤, 메뉴 클릭 등) 한 번 해보고 다시 시도해주세요.");
            return;
        }
        if (!capturedPersona || !capturedPersona.id) {
            flashSaved("프로필 정보 없음 ❌");
            showDebugToast("⚠ 아직 페르소나 정보를 못 잡았어요.\n'프로필 새로고침' 버튼을 눌러보거나, 채팅방을 새로고침해주세요.");
            return;
        }

        let base = getCachedBaseDesc(roomId);
        if (base === null) {
            flashSaved("기존 프로필 정보 없음 ❌");
            showDebugToast("⚠ 기존 프로필(base)을 아직 못 잡았어요.\n'프로필 새로고침' 버튼을 먼저 눌러서 기존 내용을 확보해주세요.");
            return;
        }

        const trimmedNote = note.trim();
        const newDesc = trimmedNote ? (base.replace(/\s+$/, "") + "\n\n" + trimmedNote) : base;

        try {
            const res = await originalFetch(PROFILE_PATCH_URL(capturedPersona.id), {
                method: "PATCH",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": capturedAuth
                },
                body: JSON.stringify({ name: capturedPersona.name, description: newDesc })
            });

            if (res.ok) {
                capturedPersona.description = newDesc;
                setCachedPersona(roomId, capturedPersona);
                flashSaved("동기화 완료 ✅");
                showDebugToast(`✅ 프로필에 동기화됨 (총 ${newDesc.length}자, 마지막 200자)\n` + newDesc.slice(-200));
                updatePersonaStatus();
            } else {
                const t = await res.text().catch(() => "");
                flashSaved("동기화 실패 ❌");
                showDebugToast(`❌ 실패 (HTTP ${res.status}, 시도한 총 글자수: ${newDesc.length}자)\n서버 글자수 제한일 수 있어요. 콘솔에서 ZetaUserNote.testMaxLength() 실행해보세요.\n` + t.slice(0, 200));
            }
        } catch (err) {
            flashSaved("동기화 실패 ❌");
            showDebugToast("❌ 네트워크 오류: " + (err && err.message));
        }
    }

    // ★ v3.5: 자동 동기화. 서버에 저장된 description이 이미 base+note와 같으면 아무 것도 안 함(불필요한 PATCH 방지).
    let autoSyncTimer = null;
    function maybeAutoSync() {
        clearTimeout(autoSyncTimer);
        autoSyncTimer = setTimeout(() => {
            const note = getNote().trim();
            if (!capturedAuth || !capturedPersona || !capturedPersona.id) return;
            const base = getCachedBaseDesc(roomId);
            if (base === null) return; // base 아직 없음 → refresh-persona 필요, 억지로 시도 안 함
            const expected = note ? (base.replace(/\s+$/, "") + "\n\n" + note) : base;
            if ((capturedPersona.description || "") === expected) return; // 이미 동기화된 상태
            syncNow();
        }, 500);
    }

    async function manualRefreshPersona() {
        if (!capturedAuth) {
            showDebugToast("⚠ 아직 인증 토큰을 못 잡았어요. 사이트를 조작해본 뒤 다시 시도해주세요.");
            flashSaved("실패 ❌");
            return;
        }
        // ★ v3.5: lastPlotId가 비어있으면 localStorage 캐시로 폴백
        const plotId = lastPlotId || getCachedPlotId(roomId);
        if (!plotId) {
            showDebugToast("⚠ plotId를 아직 못 찾았어요. 콘솔(F12)에 'UserNote[debug] plot/room 감지' 로그가 뜨는지 확인해주세요.\n방 안에서 스크롤하거나 메시지를 하나 보내본 뒤 다시 시도해주세요.");
            flashSaved("실패 ❌ (plotId 없음)");
            return;
        }
        lastPlotId = plotId;
        const url = `https://api.zeta-ai.io/v1/user-chat-profiles?plotId=${plotId}`;
        try {
            const res = await originalFetch(url, { headers: { "Authorization": capturedAuth } });
            const bodyText = await res.text();

            if (res.ok) {
                let data = null;
                try { data = JSON.parse(bodyText); } catch { /* ignore */ }

                const list = data && data.userChatProfiles;
                const sel = Array.isArray(list) ? list.find(p => p && p.selected) : null;

                if (sel && sel.id) {
                    capturedPersona = { id: sel.id, name: sel.name, description: sel.description || "" };
                    setCachedPersona(roomId, capturedPersona);
                    setCachedBaseDesc(roomId, sel.description || "");
                    updatePersonaStatus();
                    flashSaved("프로필 새로고침됨 ✅");
                    showDebugToast(
                        "✅ 서버의 현재 description을 새 base로 저장했어요.\n" +
                        "⚠ 참고: Zeta 화면에서 직접 프로필을 수정한 게 아니라면, 이 값엔 이전에 동기화했던 노트가 이미 섞여 있을 수 있어요.\n" +
                        `사용된 plotId: ${plotId}`
                    );
                    maybeAutoSync();
                    return;
                }

                flashSaved("새로고침 실패 ❌ (선택된 페르소나 없음)");
                showDebugToast(
                    "❌ 요청은 성공(200)했지만 selected:true인 페르소나가 없어요.\n" +
                    "URL: " + url + "\n" +
                    "응답: " + bodyText.slice(0, 200)
                );
                return;
            }

            flashSaved("새로고침 실패 ❌");
            showDebugToast(`❌ 새로고침 실패 (HTTP ${res.status})\nURL: ${url}\n응답: ${bodyText.slice(0, 200)}`);
        } catch (err) {
            flashSaved("새로고침 실패 ❌");
            showDebugToast("❌ 네트워크 오류: " + (err && err.message) + "\nURL: " + url);
        }
    }

    // ★ 서버가 실제로 허용하는 최대 글자수를 이진탐색으로 찾는 콘솔 유틸.
    //   콘솔에서: await ZetaUserNote.testMaxLength()
    //   주의: 테스트 중 프로필 description이 임시로 더미문자(x)로 여러 번 덮어써집니다.
    //         테스트가 끝나면 반드시 패널에서 '지금 바로 동기화'를 눌러 실제 노트로 되돌리세요.
    async function testMaxLength() {
        if (!capturedAuth || !capturedPersona || !capturedPersona.id) {
            console.log("❌ auth/persona 없음. 패널을 한번 열고 다시 시도해주세요.");
            return null;
        }
        const base = getCachedBaseDesc(roomId) || "";
        let lo = 0, hi = 4000, lastOk = 0;
        console.log("🔍 서버 실제 글자수 제한 탐색 시작... (프로필이 임시로 여러 번 덮어써집니다)");
        while (lo <= hi) {
            const mid = Math.floor((lo + hi) / 2);
            const testDesc = base.replace(/\s+$/, "") + "\n\n" + "x".repeat(mid);
            try {
                const res = await originalFetch(PROFILE_PATCH_URL(capturedPersona.id), {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json", "Authorization": capturedAuth },
                    body: JSON.stringify({ name: capturedPersona.name, description: testDesc })
                });
                if (res.ok) { lastOk = mid; lo = mid + 1; }
                else { hi = mid - 1; }
            } catch (err) {
                console.log("❌ 테스트 중 네트워크 오류:", err && err.message);
                break;
            }
        }
        const totalMax = lastOk + base.length + 2;
        console.log(`✅ 대략적인 노트 최대 글자수: ${lastOk}자 (base ${base.length}자 포함 총 약 ${totalMax}자)`);
        console.log("⚠ 지금 프로필엔 테스트용 'x' 문자열이 남아있어요. 패널 열고 '지금 바로 동기화'를 눌러 실제 노트로 덮어써주세요.");
        return { noteMax: lastOk, base: base.length, total: totalMax };
    }

    let saveDebounce = null;
    noteEl.addEventListener("input", () => {
        updateCount();
        updatePersonaStatus();
        clearTimeout(saveDebounce);
        saveDebounce = setTimeout(() => {
            saveNote(noteEl.value);
            maybeAutoSync(); // ★ v3.5: 입력만 해도 자동 반영, 버튼 안 눌러도 됨
        }, 800);
    });

    el("sync").addEventListener("click", syncNow);
    el("refresh-persona").addEventListener("click", manualRefreshPersona);

    el("clear").addEventListener("click", () => {
        if (!confirm("노트를 비울까요? (기존 페르소나 프로필 내용은 영향 없어요)")) return;
        noteEl.value = "";
        saveNote("");
        updateCount();
        flashSaved("비움 (자동 반영됨)");
        maybeAutoSync();
    });

    el("reset-pos").addEventListener("click", () => {
        const defaultPos = { left: 16, bottom: 80 };
        savePos(defaultPos);
        applyPos(defaultPos);
        flashSaved("위치 초기화됨");
    });

    //------------------------------------------
    // 방 이동 감지 (SPA 라우팅 대응)
    //------------------------------------------

    setInterval(() => {
        const id = currentRoomId();
        if (id !== roomId) {
            roomId = id;
            lastPlotId = getCachedPlotId(roomId);
            capturedPersona = getCachedPersona(roomId);
            refreshRoomUI();
        }
    }, 1000);

    //------------------------------------------
    // fetch 훔쳐보기: 인증 헤더 + 페르소나 응답 + plotId 캐치
    //------------------------------------------

    const originalFetch = window.fetch;

    window.fetch = async function (input, init) {
        let url = "";
        const sendRoomId = roomId;
        try {
            url = typeof input === "string" ? input : (input && input.url) || "";
            const headers = (init && init.headers) || (typeof input !== "string" && input && input.headers);
            const authVal = extractAuthFromHeaders(headers);
            if (authVal) {
                if (!capturedAuth) console.log("📝 UserNote: 인증 토큰 감지됨 (fetch)");
                capturedAuth = authVal;
            }
            sniffOutgoingUrl(url);
        } catch (err) {
            console.error("❌ User Note 처리 실패 (fetch 요청단계)", err);
        }

        const res = await originalFetch.call(this, input, init);

        try {
            if (PROFILES_LIST_RE.test(url)) {
                res.clone().text().then(text => handlePossiblePersonaListResponse(text, sendRoomId)).catch(() => {});
            }
        } catch (err) {
            console.error("❌ User Note 처리 실패 (fetch 응답단계)", err);
        }

        return res;
    };

    //------------------------------------------
    // XMLHttpRequest 훔쳐보기 (제타 자체 API는 XHR을 씀)
    //------------------------------------------

    const OrigXHR = window.XMLHttpRequest;
    const origOpen = OrigXHR.prototype.open;
    const origSend = OrigXHR.prototype.send;
    const origSetHeader = OrigXHR.prototype.setRequestHeader;

    OrigXHR.prototype.open = function (method, url, ...rest) {
        this.__zetaMethod = (method || "GET").toUpperCase();
        this.__zetaURL = url;
        return origOpen.call(this, method, url, ...rest);
    };

    OrigXHR.prototype.setRequestHeader = function (name, value) {
        try {
            if (name && name.toLowerCase() === "authorization") {
                if (!capturedAuth) console.log("📝 UserNote: 인증 토큰 감지됨 (XHR)");
                capturedAuth = value;
            }
        } catch { /* ignore */ }
        return origSetHeader.call(this, name, value);
    };

    OrigXHR.prototype.send = function (body) {
        try {
            sniffOutgoingUrl(this.__zetaURL);

            if (this.__zetaMethod === "GET" && PROFILES_LIST_RE.test(this.__zetaURL || "")) {
                const sendRoomId = roomId;
                this.addEventListener("load", function () {
                    try { handlePossiblePersonaListResponse(this.responseText, sendRoomId); } catch { /* ignore */ }
                });
            }
        } catch (err) {
            console.error("❌ User Note 처리 실패 (XHR)", err);
        }

        return origSend.call(this, body);
    };

    //------------------------------------------
    // Export / Import (이 방의 노트 텍스트만)
    //------------------------------------------

    function downloadJson(obj, filename) {
        const blob = new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
    }

    function todayStr() {
        return new Date().toISOString().slice(0, 10);
    }

    function exportRoom() {
        const data = {
            kind: "zeta-usernote-room-backup",
            version: VERSION,
            roomId,
            exportedAt: Date.now(),
            note: getNote()
        };
        downloadJson(data, `zeta-usernote-room-${roomId}-${todayStr()}.json`);
        flashSaved("Export 완료");
    }

    function pickFile(onPicked) {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = "application/json";
        input.style.display = "none";
        input.addEventListener("change", () => {
            if (input.files && input.files[0]) onPicked(input.files[0]);
            input.remove();
        });
        document.body.appendChild(input);
        input.click();
    }

    function importRoomFile(file) {
        file.text().then(text => {
            try {
                const data = JSON.parse(text);
                if (data.kind !== "zeta-usernote-room-backup") {
                    alert("이 파일은 Room 백업 파일이 아닙니다.");
                    return;
                }
                if (!confirm(`현재 방(${roomId})의 노트를 백업 파일 내용으로 덮어씁니다. 계속할까요? (자동으로 동기화됩니다)`)) return;

                if (data.note != null) {
                    noteEl.value = data.note;
                    saveNote(data.note);
                    updateCount();
                    maybeAutoSync();
                }
                flashSaved("Import 완료");
            } catch (err) {
                console.error(err);
                alert("파일을 읽는 중 오류가 발생했습니다.");
            }
        });
    }

    el("export").addEventListener("click", exportRoom);
    el("import").addEventListener("click", () => {
        pickFile((file) => importRoomFile(file));
    });

    //------------------------------------------
    // Public API
    //------------------------------------------

    window.ZetaUserNote = {
        version: VERSION,
        getNote,
        saveNote,
        syncNow,
        manualRefreshPersona,
        testMaxLength,
        get roomId() { return roomId; },
        get capturedPersona() { return capturedPersona; },
        get hasAuth() { return !!capturedAuth; }
    };

    console.log(`📝 Zeta UserNote v${VERSION} (Persona Sync, Auto-Sync) Ready`);

})();
