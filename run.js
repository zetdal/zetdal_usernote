(() => {

    "use strict";

    // ==========================
    // Zeta User Note v2.0.0
    //
    // 원리:
    // - 유저가 직접 쓴 노트를 저장해둔다 (AI 요약 없음, API 호출도 없음).
    // - 대화가 일정 글자 수(기본 5000자) 이상 진행될 때마다,
    //   다음으로 보내는 메시지 요청 body에만 노트를 몰래 끼워 넣는다.
    // - 입력창에는 절대 보이지 않음 (fetch 요청 가로채기 방식).
    // - 방(room)마다 노트/진행도가 완전히 분리되어 저장된다.
    // ==========================

    if (window.__ZETA_USERNOTE_RUNNING__) {
        console.log("📝 Zeta UserNote already running.");
        return;
    }
    window.__ZETA_USERNOTE_RUNNING__ = true;

    const VERSION = "2.0.0";
    const NOTE_TAG = "[유저 노트]";
    const STREAM_URL_RE = /\/v1\/rooms\/[^/]+\/messages\/stream(?:\?|$)/;

    const SETTINGS_KEY = "zeta-usernote-settings"; // 전역: { deltaChars, enabled }
    const POS_KEY = "zeta-usernote-pos";           // 전역: 버튼/패널 위치(드래그 결과)

    const DEFAULT_SETTINGS = { deltaChars: 5000, enabled: true };

    //------------------------------------------
    // 설정 (전역)
    //------------------------------------------

    function getSettings() {
        let raw = null;
        try { raw = JSON.parse(localStorage.getItem(SETTINGS_KEY)); } catch { /* ignore */ }
        return Object.assign({}, DEFAULT_SETTINGS, raw || {});
    }

    function saveSettings(patch) {
        const merged = Object.assign({}, getSettings(), patch);
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(merged));
        return merged;
    }

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
    let K = keysFor(roomId);

    function keysFor(id) {
        const base = `zeta-usernote-${id}`;
        return {
            note: base,                     // 노트 본문
            checkpoint: `${base}-checkpoint` // 진행도 측정 기준점
        };
    }

    function getNote() {
        return localStorage.getItem(K.note) || "";
    }

    function saveNote(text) {
        localStorage.setItem(K.note, text || "");
    }

    //------------------------------------------
    // 메시지 읽기 (화면상 실제 위치 기준으로 정렬)
    //
    // DOM에 붙는 순서를 신뢰하지 않는다: 스크롤로 과거 메시지를 불러올 때
    // DOM 뒤쪽에 끼워 넣는 구조라면 DOM 순서 ≠ 시간순이 되어버린다.
    // 그래서 항상 화면상 세로 위치(top) 기준으로 정렬해 시간순을 보장한다.
    //------------------------------------------

    function getMessages() {
        const result = [];

        document
            .querySelectorAll(".bg-bubble-user, .bg-gray-sub1")
            .forEach(bubble => {
                const role = bubble.classList.contains("bg-bubble-user") ? "user" : "assistant";
                const chat = bubble.querySelector(".chat");
                if (!chat) return;

                const text = chat.innerText.trim();
                if (!text) return;

                const top = bubble.getBoundingClientRect().top;
                result.push({ role, text, top });
            });

        result.sort((a, b) => a.top - b.top);
        return result.map(({ role, text }) => ({ role, text }));
    }

    // 메시지 하나를 식별하기 위한 간단한 해시 (role + text 기반)
    function hashMsg(m) {
        const s = m.role + "|" + m.text;
        let h = 5381;
        for (let i = 0; i < s.length; i++) {
            h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
        }
        return h.toString(36) + "_" + s.length;
    }

    //------------------------------------------
    // 진행도(체크포인트) 계산
    //
    // "체크포인트 이후에 실제로 새로 쌓인 글자 수"만 카운트한다.
    // 체크포인트 = 마지막으로 노트를 저장했거나 삽입했던 시점의 "마지막 메시지".
    // 스크롤로 예전 메시지를 더 불러와도, 그 메시지들은 체크포인트보다
    // "이전"에 정렬되므로 진행도에 영향을 주지 않는다.
    //------------------------------------------

    function getCheckpoint() {
        try { return JSON.parse(localStorage.getItem(K.checkpoint)); } catch { return null; }
    }

    function setCheckpoint(messages) {
        if (!messages || messages.length === 0) {
            localStorage.removeItem(K.checkpoint);
            return;
        }
        const last = messages[messages.length - 1];
        localStorage.setItem(K.checkpoint, JSON.stringify({ hash: hashMsg(last) }));
    }

    function computeDelta(messages) {
        const cp = getCheckpoint();

        if (!cp) return 0; // 체크포인트가 아직 없으면(최초 상태) 0부터 시작

        let idx = -1;
        for (let i = messages.length - 1; i >= 0; i--) {
            if (hashMsg(messages[i]) === cp.hash) { idx = i; break; }
        }

        // 체크포인트 메시지를 못 찾은 경우(스크롤로 화면에서 사라졌을 수 있음)
        // 잘못 카운트해서 엉뚱하게 터지는 것보다, 안전하게 0으로 처리한다.
        if (idx === -1) return 0;

        let sum = 0;
        for (let i = idx + 1; i < messages.length; i++) sum += messages[i].text.length;
        return sum;
    }

    function getProgress() {
        const messages = getMessages();
        const settings = getSettings();
        const delta = computeDelta(messages);
        return { delta, threshold: settings.deltaChars, messages };
    }

    //------------------------------------------
    // UI - Shadow DOM으로 완전히 격리
    // (피드백 1: 웹제타 테마가 씌워져도 UI가 묻히지 않도록)
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
    width: 42px; height: 42px; border-radius: 50%;
    background: #ff5d8f; color: #fff;
    display: flex; align-items: center; justify-content: center;
    font-size: 19px; cursor: pointer;
    box-shadow: 0 4px 16px rgba(0,0,0,.5);
    border: 2px solid #fff;
    touch-action: none;
    user-select: none;
  }
  #btn.dragging { opacity: 0.7; }

  #panel {
    position: fixed;
    width: 270px; max-height: 66vh; overflow-y: auto;
    background: #17171c; color: #fff;
    border: 1px solid #ff5d8f; border-radius: 12px;
    padding: 12px; font-size: 12px; line-height: 1.5;
    box-shadow: 0 6px 24px rgba(0,0,0,.6);
    display: none;
  }
  #panel.open { display: block; }

  textarea {
    width: 100%; height: 24vh; background: #0d0d10; color: #fff;
    border: 1px solid #444; border-radius: 8px; padding: 8px;
    font-size: 12px; resize: vertical;
  }
  .row { display: flex; gap: 6px; margin-top: 8px; align-items: center; }
  button {
    background: #333; color: #fff; border: none; border-radius: 8px;
    padding: 7px 6px; font-size: 11px; cursor: pointer; flex: 1;
  }
  button.primary { background: #ff5d8f; }
  label { display: flex; align-items: center; gap: 6px; font-size: 11px; color: #ccc; }
  .title { font-weight: bold; font-size: 13px; margin-bottom: 4px; display: flex; justify-content: space-between; align-items: center; }
  .room { color: #999; font-size: 10px; margin-bottom: 8px; word-break: break-all; }
  .count { color: #999; font-size: 10px; text-align: right; margin-top: 4px; }
  .saved-badge { color: #7CFC9C; font-size: 10px; opacity: 0; transition: opacity .3s; white-space:nowrap; }
  .saved-badge.show { opacity: 1; }

  .progress-label { display:flex; justify-content:space-between; font-size:10px; color:#999; margin-top:10px; }
  .progress-track { width:100%; height:6px; background:#333; border-radius:4px; overflow:hidden; margin-top:4px; }
  .progress-fill { height:100%; background:#ff5d8f; width:0%; transition: width .3s; }

  .delta-input { width:70px; padding:5px; background:#111; color:#fff; border:1px solid #444; border-radius:6px; font-size:11px; }
  hr { border: none; border-top: 1px solid #333; margin: 10px 0; }
</style>

<div id="btn">📝</div>
<div id="panel">
  <div class="title">
    <span>📝 User Note</span>
    <span style="font-weight:normal;font-size:10px;color:#999;">v${VERSION}</span>
  </div>
  <div class="room" id="room"></div>

  <textarea id="note" placeholder="예)
현재상황요약: 남과 여가 아침에 OO 때문에 다투고 각자 출근함
중요설정: ..."></textarea>
  <div class="count" id="count">0자</div>

  <div class="progress-label">
    <span>다음 자동 삽입까지</span>
    <span id="progress-text">0 / 5000자</span>
  </div>
  <div class="progress-track"><div class="progress-fill" id="progress-fill"></div></div>

  <div class="row">
    <label style="flex:1;"><input type="checkbox" id="enabled"> 자동 삽입 켜짐</label>
    <span class="saved-badge" id="saved">저장됨</span>
  </div>
  <div class="row">
    <span style="flex:1;color:#ccc;">삽입 주기</span>
    <input type="number" id="delta-chars" class="delta-input" />
    <span style="color:#999;">자</span>
  </div>

  <div class="row">
    <button class="primary" id="save">저장</button>
    <button id="force">지금 바로 삽입</button>
  </div>
  <div class="row">
    <button id="clear">노트 비우기</button>
  </div>

  <hr>

  <div class="row">
    <button id="export">⬇ 내보내기</button>
    <button id="import">⬆ 불러오기</button>
  </div>
  <div class="count" id="export-hint">짧게 탭: 이 방만 / 길게 누르기: 전체 백업</div>
</div>
`;

    const el = (id) => root.getElementById(id);

    const btnEl = el("btn");
    const panelEl = el("panel");
    const noteEl = el("note");
    const roomEl = el("room");
    const countEl = el("count");
    const savedEl = el("saved");
    const enabledEl = el("enabled");
    const deltaCharsEl = el("delta-chars");
    const progressTextEl = el("progress-text");
    const progressFillEl = el("progress-fill");

    function applyPos(pos) {
        btnEl.style.left = pos.left + "px";
        btnEl.style.bottom = pos.bottom + "px";
        panelEl.style.left = pos.left + "px";
        panelEl.style.bottom = (pos.bottom + 50) + "px";
    }

    applyPos(getPos());

    function updateCount() {
        countEl.textContent = `${noteEl.value.length.toLocaleString()}자`;
    }

    function flashSaved(text) {
        savedEl.textContent = text || "저장됨";
        savedEl.classList.add("show");
        clearTimeout(flashSaved._t);
        flashSaved._t = setTimeout(() => savedEl.classList.remove("show"), 1400);
    }

    function refreshProgress() {
        const { delta, threshold } = getProgress();
        progressTextEl.textContent = `${Math.min(delta, threshold).toLocaleString()} / ${threshold.toLocaleString()}자`;
        const pct = threshold > 0 ? Math.min(100, (delta / threshold) * 100) : 0;
        progressFillEl.style.width = pct + "%";
    }

    function refreshRoomUI() {
        roomEl.textContent = `Room: ${roomId.slice(0, 24)}`;
        noteEl.value = getNote();
        updateCount();

        const settings = getSettings();
        enabledEl.checked = settings.enabled;
        deltaCharsEl.value = settings.deltaChars;

        // 이 방에서 처음 실행된 거라면(체크포인트 없음) 지금 시점을 기준점으로 삼는다.
        if (!getCheckpoint()) setCheckpoint(getMessages());

        refreshProgress();
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

        const newLeft = Math.min(Math.max(startPos.left + dx, 4), window.innerWidth - 46);
        const newBottom = Math.min(Math.max(startPos.bottom - dy, 4), window.innerHeight - 46);

        applyPos({ left: newLeft, bottom: newBottom });
    }

    function onDragEnd() {
        if (!dragging) return;
        dragging = false;
        btnEl.classList.remove("dragging");

        if (moved) {
            savePos({
                left: parseFloat(btnEl.style.left) || 16,
                bottom: parseFloat(btnEl.style.bottom) || 80
            });
        } else {
            setPanelOpen(!panelEl.classList.contains("open"));
        }
    }

    btnEl.addEventListener("mousedown", onDragStart);
    window.addEventListener("mousemove", onDragMove);
    window.addEventListener("mouseup", onDragEnd);

    btnEl.addEventListener("touchstart", onDragStart, { passive: true });
    window.addEventListener("touchmove", onDragMove, { passive: true });
    window.addEventListener("touchend", onDragEnd);

    function setPanelOpen(open) {
        panelEl.classList.toggle("open", open);
        if (open) refreshRoomUI();
    }

    //------------------------------------------
    // 노트 저장 / 비우기 / 강제 삽입
    //
    // 노트를 저장하면 "지금 이 순간"을 새 기준점으로 삼는다.
    // (새로 적은 사건은 지금부터 다시 threshold자 진행 후 삽입됨)
    //------------------------------------------

    let saveDebounce = null;

    noteEl.addEventListener("input", () => {
        updateCount();
        clearTimeout(saveDebounce);
        saveDebounce = setTimeout(doSave, 600);
    });

    function doSave() {
        saveNote(noteEl.value);
        setCheckpoint(getMessages());
        refreshProgress();
        flashSaved("저장됨 (진행도 초기화)");
    }

    el("save").addEventListener("click", doSave);

    el("clear").addEventListener("click", () => {
        if (!confirm("이 방의 노트를 비울까요?")) return;
        noteEl.value = "";
        saveNote("");
        updateCount();
        flashSaved("비움");
    });

    // "지금 바로 삽입": 다음 메시지 전송 시 강제로 노트를 끼워 넣는다.
    let forceNext = false;

    el("force").addEventListener("click", () => {
        if (!getNote().trim()) {
            alert("노트가 비어있습니다. 먼저 노트를 작성해주세요.");
            return;
        }
        forceNext = true;
        flashSaved("다음 전송 시 강제 삽입됨");
    });

    enabledEl.addEventListener("change", () => {
        saveSettings({ enabled: enabledEl.checked });
    });

    deltaCharsEl.addEventListener("change", () => {
        const v = Number(deltaCharsEl.value) || DEFAULT_SETTINGS.deltaChars;
        saveSettings({ deltaChars: v });
        refreshProgress();
    });

    //------------------------------------------
    // 방 이동 감지 (SPA 라우팅 대응)
    //------------------------------------------

    setInterval(() => {
        const id = currentRoomId();
        if (id !== roomId) {
            roomId = id;
            K = keysFor(roomId);
            forceNext = false;
            refreshRoomUI();
        }
    }, 1000);

    // 대화가 진행되는 동안 진행률 바를 갱신 (패널이 열려있을 때만, 가볍게)
    const progressObserver = new MutationObserver(() => {
        clearTimeout(window.__zetaUserNoteTimer__);
        window.__zetaUserNoteTimer__ = setTimeout(() => {
            if (panelEl.classList.contains("open")) refreshProgress();
        }, 500);
    });
    progressObserver.observe(document.body, { childList: true, subtree: true, characterData: true });

    //------------------------------------------
    // fetch 가로채기: 입력창에는 안 보이고, 전송되는 요청에만 삽입
    //------------------------------------------

    const originalFetch = window.fetch;

    window.fetch = async function (input, init) {

        try {
            const url = typeof input === "string" ? input : (input && input.url) || "";
            const method = (
                (init && init.method) ||
                (typeof input !== "string" && input && input.method) ||
                "GET"
            ).toUpperCase();

            if (method === "POST" && STREAM_URL_RE.test(url) && init && init.body) {

                const bodyObj = JSON.parse(init.body);

                if (bodyObj && bodyObj.type === "TEXT" && typeof bodyObj.text === "string") {

                    const settings = getSettings();
                    const note = getNote().trim();
                    const alreadyTagged = bodyObj.text.startsWith(NOTE_TAG);
                    const { delta, threshold, messages } = getProgress();

                    const shouldInject = note && !alreadyTagged && (forceNext || (settings.enabled && delta >= threshold));

                    if (shouldInject) {
                        bodyObj.text = `${NOTE_TAG}\n${note}\n\n[사용자 입력]\n${bodyObj.text}`;
                        init = Object.assign({}, init, { body: JSON.stringify(bodyObj) });

                        // 삽입한 시점을 새 기준점으로 다시 잡는다 (진행도 리셋)
                        setCheckpoint(messages);
                        forceNext = false;

                        console.log("📝 User Note 삽입됨 (진행도 리셋):", bodyObj.text.slice(0, 80) + "...");
                        if (panelEl.classList.contains("open")) {
                            flashSaved("노트 삽입됨");
                            refreshProgress();
                        }
                    }
                }
            }
        } catch (err) {
            console.error("❌ User Note 처리 실패, 원본 요청 그대로 전송", err);
        }

        return originalFetch.call(this, input, init);
    };

    //------------------------------------------
    // Export / Import
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
            note: localStorage.getItem(K.note),
            checkpoint: localStorage.getItem(K.checkpoint)
        };
        downloadJson(data, `zeta-usernote-room-${roomId}-${todayStr()}.json`);
        flashSaved("Export 완료 (Room)");
    }

    function exportAll() {
        const dump = {};
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key && key.startsWith("zeta-usernote")) dump[key] = localStorage.getItem(key);
        }
        downloadJson(
            { kind: "zeta-usernote-full-backup", version: VERSION, exportedAt: Date.now(), data: dump },
            `zeta-usernote-full-backup-${todayStr()}.json`
        );
        flashSaved("Export 완료 (전체)");
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
                if (!confirm(`현재 방(${roomId})의 노트를 백업 파일 내용으로 덮어씁니다. 계속할까요?`)) return;

                if (data.note != null) localStorage.setItem(K.note, data.note);
                if (data.checkpoint) localStorage.setItem(K.checkpoint, data.checkpoint);

                refreshRoomUI();
                flashSaved("Import 완료 (Room)");
            } catch (err) {
                console.error(err);
                alert("파일을 읽는 중 오류가 발생했습니다.");
            }
        });
    }

    function importAllFile(file) {
        file.text().then(text => {
            try {
                const parsed = JSON.parse(text);
                if (parsed.kind !== "zeta-usernote-full-backup" || !parsed.data) {
                    alert("이 파일은 전체 백업 파일이 아닙니다.");
                    return;
                }
                if (!confirm("브라우저에 저장된 모든 Zeta UserNote 데이터(모든 방)를 덮어씁니다. 계속할까요?")) return;

                Object.keys(parsed.data).forEach(key => localStorage.setItem(key, parsed.data[key]));

                alert("전체 복원 완료. 페이지를 새로고침합니다.");
                location.reload();
            } catch (err) {
                console.error(err);
                alert("파일을 읽는 중 오류가 발생했습니다.");
            }
        });
    }

    (function wireExportButton() {
        const btn = el("export");
        let pressTimer = null;
        let longPressed = false;

        const startPress = () => {
            longPressed = false;
            pressTimer = setTimeout(() => {
                longPressed = true;
                if (confirm("전체 백업(모든 방)을 내보낼까요?")) exportAll();
            }, 600);
        };
        const cancelPress = () => clearTimeout(pressTimer);

        btn.addEventListener("touchstart", startPress, { passive: true });
        btn.addEventListener("touchend", cancelPress);
        btn.addEventListener("touchmove", cancelPress);
        btn.addEventListener("mousedown", startPress);
        btn.addEventListener("mouseup", cancelPress);
        btn.addEventListener("mouseleave", cancelPress);
        btn.addEventListener("contextmenu", (e) => e.preventDefault());

        btn.addEventListener("click", () => {
            if (longPressed) return;
            exportRoom();
        });
    })();

    el("import").addEventListener("click", () => {
        pickFile((file) => {
            file.text().then(text => {
                try {
                    const parsed = JSON.parse(text);
                    if (parsed.kind === "zeta-usernote-full-backup") importAllFile(file);
                    else importRoomFile(file);
                } catch {
                    alert("올바른 JSON 파일이 아닙니다.");
                }
            });
        });
    });

    //------------------------------------------
    // Public API
    //------------------------------------------

    window.ZetaUserNote = {
        version: VERSION,
        getNote,
        saveNote,
        getSettings,
        saveSettings,
        getProgress,
        exportRoom,
        exportAll,
        get roomId() { return roomId; }
    };

    console.log(`📝 Zeta UserNote v${VERSION} Ready`);

})();
