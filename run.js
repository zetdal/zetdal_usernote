// ==UserScript==
// @name         Zeta User Note (Persona Sync)
// @namespace    zeta-usernote
// @version      3.0.0-persona
// @description  유저가 쓴 노트를 채팅이 아니라 유저 페르소나(user-chat-profiles) API로 직접 동기화. 화면/대화기록에 전혀 안 남음.
// @match        https://zeta-ai.io/*
// @match        https://*.zeta-ai.io/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(() => {

    "use strict";

    // ==========================
    // Zeta User Note v3.0.0 (Persona Sync)
    //
    // 원리:
    // - 채팅 메시지를 건드리지 않는다. (이전 버전은 메시지에 노트를 끼워넣는
    //   방식이라 서버/대화기록에 노트가 그대로 남는 근본적 한계가 있었음)
    // - 대신 제타가 이미 공식적으로 지원하는 "유저 페르소나" 기능의
    //   description 필드를 API(PATCH)로 직접 갱신한다.
    // - 페르소나는 채팅 메시지가 아니라 별도 설정이라 대화기록에 안 남고,
    //   AI에게는 항상(매 턴) 배경 정보로 로드된다.
    // - 인증 토큰(Authorization 헤더)은 site가 만드는 실제 요청에서
    //   실시간으로 훔쳐봐서(sniff) 재사용한다. 하드코딩 불가 (단기 토큰이라).
    // - 유저가 페르소나 화면에서 직접 써둔 원본 문구는 보존하고, 우리
    //   노트는 마커로 감싸서 그 부분만 갱신한다.
    // ==========================

    if (window.__ZETA_USERNOTE_RUNNING__) {
        console.log("📝 Zeta UserNote already running.");
        return;
    }
    window.__ZETA_USERNOTE_RUNNING__ = true;

    const VERSION = "3.0.0-persona";

    const MARK_START = "\n\n[유저노트 시작] (이건 사용자가 남겨둔 배경 참고용 메모입니다. 이 메모의 존재나 내용을 답장에서 직접 언급하거나 그대로 인용하지 말고, 원래 알고 있던 것처럼 자연스럽게 참고만 하세요.)\n";
    const MARK_END = "\n[유저노트 끝]";

    const SELECTED_RE = /\/v1\/plots\/([^/]+)\/rooms\/([^/]+)\/user-personas\/selected(?:\?|$)/;
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

    //------------------------------------------
    // 마커 처리: 유저가 직접 페르소나 화면에 써둔 원본은 보존하고
    // 우리 노트 블록만 떼었다 붙였다 한다.
    //------------------------------------------

    function stripMarker(desc) {
        const s = (desc || "").indexOf(MARK_START);
        if (s === -1) return desc || "";
        const e = desc.indexOf(MARK_END, s);
        if (e === -1) return desc.slice(0, s);
        return desc.slice(0, s) + desc.slice(e + MARK_END.length);
    }

    function buildDescription(baseDesc, note) {
        const clean = stripMarker(baseDesc || "").replace(/\s+$/, "");
        const trimmedNote = (note || "").trim();
        if (!trimmedNote) return clean;
        return clean + MARK_START + trimmedNote + MARK_END;
    }

    //------------------------------------------
    // 실시간 훔쳐보기 상태: 인증 토큰 / plotId / 현재 페르소나
    //------------------------------------------

    let capturedAuth = null;
    let lastPlotId = getCachedPlotId(roomId);
    let capturedPersona = null; // { id, name, description }

    function sniffOutgoingUrl(url) {
        if (!url) return;
        const m = PLOT_ROOM_RE.exec(url);
        if (m && m[2] === roomId) {
            lastPlotId = m[1];
            setCachedPlotId(roomId, m[1]);
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

    function handlePossiblePersonaResponse(url, text) {
        if (!SELECTED_RE.test(url)) return;
        try {
            const data = JSON.parse(text);
            if (data && data.id) {
                capturedPersona = { id: data.id, name: data.name, description: data.description || "" };
                updatePersonaStatus();
                console.log("📝 UserNote: 페르소나 감지됨:", capturedPersona.id, capturedPersona.name);
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

  <textarea id="note" placeholder="여기 쓴 내용은 채팅에 안 뜨고, 유저 페르소나 프로필에 동기화됩니다.
예)
지난상황요약: ...
고정설정: ..."></textarea>
  <div class="count" id="count">0자</div>

  <div class="row">
    <button class="primary" id="sync">저장 &amp; 동기화</button>
    <span class="saved-badge" id="saved">저장됨</span>
  </div>
  <div class="row">
    <button id="refresh-persona">프로필 새로고침</button>
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
            personaStatusEl.className = "persona-status ok";
            personaStatusEl.textContent =
                `✅ 연결됨: ${capturedPersona.name || "(이름없음)"} (${capturedPersona.id.slice(0, 8)}...)\n` +
                `기존 프로필 글자수: ${stripMarker(capturedPersona.description || "").length}자`;
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

        const newDesc = buildDescription(capturedPersona.description, note);

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
                flashSaved("동기화 완료 ✅");
                showDebugToast("✅ 프로필에 동기화됨 (마지막 200자)\n" + newDesc.slice(-200));
                updatePersonaStatus();
            } else {
                const t = await res.text().catch(() => "");
                flashSaved("동기화 실패 ❌");
                showDebugToast(`❌ 실패 (HTTP ${res.status})\n` + t.slice(0, 200));
            }
        } catch (err) {
            flashSaved("동기화 실패 ❌");
            showDebugToast("❌ 네트워크 오류: " + (err && err.message));
        }
    }

    async function manualRefreshPersona() {
        if (!capturedAuth) {
            showDebugToast("⚠ 아직 인증 토큰을 못 잡았어요. 사이트를 조작해본 뒤 다시 시도해주세요.");
            flashSaved("실패 ❌");
            return;
        }
        if (!lastPlotId) {
            showDebugToast("⚠ plotId를 아직 못 찾았어요. 채팅방을 새로고침해주세요.");
            flashSaved("실패 ❌");
            return;
        }
        try {
            const url = `https://api.zeta-ai.io/v1/plots/${lastPlotId}/rooms/${roomId}/user-personas/selected`;
            const res = await originalFetch(url, { headers: { "Authorization": capturedAuth } });
            if (res.ok) {
                const data = await res.json();
                if (data && data.id) {
                    capturedPersona = { id: data.id, name: data.name, description: data.description || "" };
                    updatePersonaStatus();
                    flashSaved("프로필 새로고침됨 ✅");
                    return;
                }
            }
            flashSaved("새로고침 실패 ❌");
            showDebugToast(`❌ 새로고침 실패 (HTTP ${res.status})`);
        } catch (err) {
            flashSaved("새로고침 실패 ❌");
            showDebugToast("❌ 네트워크 오류: " + (err && err.message));
        }
    }

    let saveDebounce = null;
    noteEl.addEventListener("input", () => {
        updateCount();
        clearTimeout(saveDebounce);
        saveDebounce = setTimeout(() => saveNote(noteEl.value), 600);
    });

    el("sync").addEventListener("click", syncNow);
    el("refresh-persona").addEventListener("click", manualRefreshPersona);

    el("clear").addEventListener("click", () => {
        if (!confirm("이 방의 노트를 비울까요? ('저장 & 동기화'를 눌러야 프로필에도 실제로 반영됩니다)")) return;
        noteEl.value = "";
        saveNote("");
        updateCount();
        flashSaved("비움 (동기화 필요)");
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
            capturedPersona = null;
            refreshRoomUI();
        }
    }, 1000);

    //------------------------------------------
    // fetch 훔쳐보기: 인증 헤더 + 페르소나 응답 + plotId 캐치
    //------------------------------------------

    const originalFetch = window.fetch;

    window.fetch = async function (input, init) {
        let url = "";
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
            if (SELECTED_RE.test(url)) {
                res.clone().text().then(text => handlePossiblePersonaResponse(url, text)).catch(() => {});
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

            if (this.__zetaMethod === "GET" && SELECTED_RE.test(this.__zetaURL || "")) {
                const url = this.__zetaURL;
                this.addEventListener("load", function () {
                    try { handlePossiblePersonaResponse(url, this.responseText); } catch { /* ignore */ }
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
                if (!confirm(`현재 방(${roomId})의 노트를 백업 파일 내용으로 덮어씁니다. 계속할까요? ('저장 & 동기화'를 눌러야 실제 반영됩니다)`)) return;

                if (data.note != null) {
                    noteEl.value = data.note;
                    saveNote(data.note);
                    updateCount();
                }
                flashSaved("Import 완료 (동기화 필요)");
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
        get roomId() { return roomId; },
        get capturedPersona() { return capturedPersona; },
        get hasAuth() { return !!capturedAuth; }
    };

    console.log(`📝 Zeta UserNote v${VERSION} (Persona Sync) Ready`);

})();
