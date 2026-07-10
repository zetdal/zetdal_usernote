(() => {

    "use strict";

    // ==========================
    // Zeta Memory v0.3.0
    // ==========================

    if (window.__ZETA_MEMORY_RUNNING__) {
        console.log("🧠 Zeta Memory already running.");
        return;
    }

    window.__ZETA_MEMORY_RUNNING__ = true;

    const VERSION = "0.3.0";

    // ---- 전역(브라우저 공용) 키 ----
    const LEGACY_PROFILE_KEY = "zeta-memory-profile"; // 구버전 단일 프로필
    const PROFILES_KEY = "zeta-memory-profiles";
    const ACTIVE_PROFILE_KEY = "zeta-memory-active-profile";
    const SETTINGS_KEY = "zeta-memory-settings";
    const USAGE_KEY = "zeta-memory-usage";

    // ---- 방(room) 단위 키 ----
    const roomId = location.pathname.split("/").pop();
    const STORAGE_KEY = `zeta-memory-${roomId}`;
    const MEMORY_KEY = `${STORAGE_KEY}-memory`;
    const MEMORY_INDEX_KEY = `${STORAGE_KEY}-memory-index`;
    const MEMORY_LENGTH_KEY = `${STORAGE_KEY}-memory-length`;
    const MEMORY_UPDATED_AT_KEY = `${STORAGE_KEY}-memory-updated-at`;
    const LOCKS_KEY = `${STORAGE_KEY}-locks`;
    const LOG_KEY = `${STORAGE_KEY}-log`;
    const CONTEXT_KEY = `${STORAGE_KEY}-context`; // 로어북/기본설정 등 고정 컨텍스트
    const MEMORY_HISTORY_KEY = `${STORAGE_KEY}-memory-history`; // 되돌리기용 이전 Memory 스냅샷

    const MEMORY_TAG = "[장기 기억]";
    const STREAM_URL_RE = /\/v1\/rooms\/[^/]+\/messages\/stream(?:\?|$)/;

    const DEFAULT_PROMPT = `현재까지의 대화를 장기 기억으로 요약하세요.

규칙
- 추측하지 마세요.
- 장소가 명시되지 않았다면 이전 장소를 유지하세요.
- 앞으로 일어날 일을 예측하지 마세요.
- 확정된 사실만 기록하세요.
- 반복되는 사건은 제거하세요.
- 1200자 이내.

[인물 혼동 방지 - 매우 중요]
- 외형, 신체적 특징(흉터, 상처, 나이, 옷차림 등), 소지품은 반드시 그 특징을 가진
  인물의 이름과 함께 정확히 묶어서 기록하세요.
- 어떤 인물의 특징인지 대화에서 명확하지 않다면, 절대로 다른 인물에게 임의로
  배정하지 말고 생략하세요.
- 이전 Memory에 이미 특정 인물에게 귀속된 특징이 있다면, 새 대화에서 그 인물이
  다시 언급되지 않는 한 그대로 유지하세요. 다른 인물에게 옮기지 마세요.

[분위기와 관계 상태를 혼동하지 마세요 - 매우 중요]
- "무거운 분위기", "진지한 대화", "침묵", "긴장감"은 그 자체로 관계 상태가
  아닙니다. 톤/분위기와 관계 상태(우호적/적대적/썸/연인 등)는 서로 다른
  항목입니다.
- 관계 상태는 오직 대사나 행동에서 명확히 드러난 경우에만 갱신하세요.
  예: 고백, 다툼, 화해, 명시적 거절, 스킨십 등.
- 예를 들어 고백하는 장면이 어색하거나 무겁게 흘러갔다고 해서 "적대적 관계"로
  바꾸지 마세요. 고백이 받아들여졌는지/거절당했는지/아직 답을 안 했는지
  대화에 드러난 그대로만 기록하세요.

아래 형식을 반드시 그대로 지켜서 작성하세요 (라벨과 콜론(:) 포함):

현재 장소: ...
현재 관계: ...
현재 상황: ...
등장인물:
- (이름): 외형/신체적 특징, 현재 상태 (해당 인물에 대해 확인된 것만)
- (이름): ...
중요 설정: ...`;

    const DEFAULT_SETTINGS = {
        deltaChars: 5000,
        debounceMs: 5000,
        autoMemory: true,
        autoInject: true,
        prompt: DEFAULT_PROMPT
    };

    let updatingMemory = false;
    let memoryDebounceTimer = null;

    console.log(`🧠 Zeta Memory v${VERSION}`);

    //------------------------------------------
    // Settings
    //------------------------------------------

    function getSettings() {
        let raw = null;
        try {
            raw = JSON.parse(localStorage.getItem(SETTINGS_KEY));
        } catch { /* ignore */ }
        return Object.assign({}, DEFAULT_SETTINGS, raw || {});
    }

    function saveSettings(patch) {
        const merged = Object.assign({}, getSettings(), patch);
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(merged));
        return merged;
    }

    function resetPrompt() {
        return saveSettings({ prompt: DEFAULT_PROMPT });
    }

    //------------------------------------------
    // Profiles (여러 개 저장/선택/수정/삭제)
    //------------------------------------------

    function migrateLegacyProfile() {

        const raw = localStorage.getItem(LEGACY_PROFILE_KEY);
        if (!raw) return;

        try {
            const legacy = JSON.parse(raw);
            const profiles = getProfilesRaw();

            if (profiles.length === 0 && legacy && legacy.apiKey) {
                const id = "legacy-" + Date.now();
                profiles.push({
                    id,
                    name: legacy.profileName || "기본",
                    provider: legacy.provider || "cerebras",
                    model: legacy.model || "gpt-oss-120b",
                    apiKey: legacy.apiKey
                });
                localStorage.setItem(PROFILES_KEY, JSON.stringify(profiles));
                localStorage.setItem(ACTIVE_PROFILE_KEY, id);
            }
        } catch { /* ignore malformed legacy data */ }

        localStorage.removeItem(LEGACY_PROFILE_KEY);
    }

    function getProfilesRaw() {
        try {
            const arr = JSON.parse(localStorage.getItem(PROFILES_KEY));
            return Array.isArray(arr) ? arr : [];
        } catch {
            return [];
        }
    }

    function getProfiles() {
        return getProfilesRaw();
    }

    function saveProfiles(list) {
        localStorage.setItem(PROFILES_KEY, JSON.stringify(list));
    }

    function getActiveProfileId() {
        return localStorage.getItem(ACTIVE_PROFILE_KEY) || "";
    }

    function setActiveProfileId(id) {
        localStorage.setItem(ACTIVE_PROFILE_KEY, id);
    }

    function getActiveProfile() {
        const profiles = getProfiles();
        if (profiles.length === 0) return null;
        const activeId = getActiveProfileId();
        return profiles.find(p => p.id === activeId) || profiles[0];
    }

    function addProfile({ name, provider, model, apiKey }) {
        const profiles = getProfiles();
        const id = "profile-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6);
        profiles.push({ id, name, provider, model, apiKey });
        saveProfiles(profiles);
        if (profiles.length === 1) setActiveProfileId(id);
        return id;
    }

    function updateProfile(id, patch) {
        const profiles = getProfiles();
        const idx = profiles.findIndex(p => p.id === id);
        if (idx === -1) return;
        profiles[idx] = Object.assign({}, profiles[idx], patch);
        saveProfiles(profiles);
    }

    function deleteProfile(id) {
        let profiles = getProfiles();
        profiles = profiles.filter(p => p.id !== id);
        saveProfiles(profiles);
        if (getActiveProfileId() === id) {
            setActiveProfileId(profiles.length > 0 ? profiles[0].id : "");
        }
    }

    //------------------------------------------
    // Usage tracking (대략치, provider가 usage를 안 주면 집계 안 됨)
    //------------------------------------------

    function todayStr() {
        return new Date().toISOString().slice(0, 10);
    }

    function getUsage() {
        let raw = null;
        try {
            raw = JSON.parse(localStorage.getItem(USAGE_KEY));
        } catch { /* ignore */ }

        if (!raw || raw.date !== todayStr()) {
            return { date: todayStr(), promptTokens: 0, completionTokens: 0, calls: 0 };
        }
        return raw;
    }

    function recordUsage(usage) {
        const current = getUsage();
        current.calls += 1;
        if (usage) {
            current.promptTokens += usage.prompt_tokens || 0;
            current.completionTokens += usage.completion_tokens || 0;
        }
        localStorage.setItem(USAGE_KEY, JSON.stringify(current));
        return current;
    }

    //------------------------------------------
    // Log (방 단위 최근 작업 로그)
    //------------------------------------------

    function getLog() {
        try {
            const arr = JSON.parse(localStorage.getItem(LOG_KEY));
            return Array.isArray(arr) ? arr : [];
        } catch {
            return [];
        }
    }

    function pushLog(text) {
        const log = getLog();
        const time = new Date().toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" });
        log.unshift({ time, text });
        localStorage.setItem(LOG_KEY, JSON.stringify(log.slice(0, 20)));
        renderLogPreview();
    }

    //------------------------------------------
    // Locks (장소/관계/설정 잠금 - 방 단위)
    //------------------------------------------

    function getLocks() {
        try {
            const raw = JSON.parse(localStorage.getItem(LOCKS_KEY));
            return Object.assign({ location: false, relationship: false, setting: false }, raw || {});
        } catch {
            return { location: false, relationship: false, setting: false };
        }
    }

    function saveLocks(locks) {
        localStorage.setItem(LOCKS_KEY, JSON.stringify(locks));
    }

    //------------------------------------------
    // 고정 컨텍스트 (로어북 / 기본설정) - 방 단위
    //------------------------------------------
    // 제타 페이지 DOM만으로는 로어북/기본설정 원문을 알 수 없어서,
    // 사용자가 직접 붙여넣거나 아래 자동 시도 버튼으로 가져온 내용을
    // 이 키에 저장해두고, 매 Memory 생성 시 프롬프트 맨 앞에 항상 포함시킨다.
    // (대화 단편만 보고 요약해서 상황이 어긋나는 문제를 줄이기 위함)

    function getRoomContext() {
        return localStorage.getItem(CONTEXT_KEY) || "";
    }

    function saveRoomContext(text) {
        localStorage.setItem(CONTEXT_KEY, text || "");
    }

    // 흔히 쓰이는 REST 패턴 몇 가지로 방/캐릭터 정보 원본 JSON을 시도해서 가져온다.
    // 성공 여부와 무관하게 콘솔에도 응답을 남겨서, 실패 시 사용자가 Network 탭에서
    // 실제 엔드포인트를 찾아 이 목록에 추가할 수 있게 한다.
    async function tryAutoFetchRoomContext() {

        const candidates = [
            `/api/v1/rooms/${roomId}`,
            `/api/v2/rooms/${roomId}`,
            `/v1/rooms/${roomId}`,
            `/api/rooms/${roomId}`,
            `/api/v1/rooms/${roomId}/detail`,
            `/api/v1/rooms/${roomId}/settings`
        ];

        for (const path of candidates) {
            try {
                const res = await fetch(path, { credentials: "include", headers: { Accept: "application/json" } });
                if (!res.ok) continue;

                const ct = res.headers.get("content-type") || "";
                if (!ct.includes("application/json")) continue;

                const data = await res.json();
                console.log(`🧠 [Zeta Memory] ${path} 응답:`, data);

                // 흔히 쓰일 법한 키 이름을 재귀적으로 탐색해서 후보만 추려 보여준다.
                const found = {};
                const KEY_HINTS = ["lore", "lorebook", "world", "setting", "persona", "description", "memo", "prompt"];

                (function walk(obj, path2) {
                    if (!obj || typeof obj !== "object") return;
                    for (const k of Object.keys(obj)) {
                        const v = obj[k];
                        const lowerK = k.toLowerCase();
                        if (KEY_HINTS.some(h => lowerK.includes(h)) && (typeof v === "string" || Array.isArray(v))) {
                            found[`${path2}${k}`] = v;
                        }
                        if (v && typeof v === "object") walk(v, `${path2}${k}.`);
                    }
                })(data, "");

                if (Object.keys(found).length > 0) {
                    return { path, raw: data, found };
                }
                return { path, raw: data, found: null };

            } catch { /* 다음 후보 시도 */ }
        }

        return null;
    }

    //------------------------------------------
    // Memory 스냅샷 (되돌리기용)
    //------------------------------------------

    function getMemoryHistory() {
        try {
            const arr = JSON.parse(localStorage.getItem(MEMORY_HISTORY_KEY));
            return Array.isArray(arr) ? arr : [];
        } catch {
            return [];
        }
    }

    function pushMemorySnapshot(prevMemory) {
        if (!prevMemory) return;
        const hist = getMemoryHistory();
        hist.unshift({ time: Date.now(), memory: prevMemory });
        localStorage.setItem(MEMORY_HISTORY_KEY, JSON.stringify(hist.slice(0, 5)));
    }

    function undoLastMemory() {
        const hist = getMemoryHistory();
        if (hist.length === 0) {
            alert("되돌릴 이전 Memory가 없습니다.");
            return false;
        }
        const [last, ...rest] = hist;
        localStorage.setItem(MEMORY_KEY, last.memory);
        localStorage.setItem(MEMORY_UPDATED_AT_KEY, Date.now());
        localStorage.setItem(MEMORY_HISTORY_KEY, JSON.stringify(rest));
        pushLog("Memory 되돌리기");
        return true;
    }

    //------------------------------------------
    // UI - toggle button + main panel
    //------------------------------------------

    const PANEL_OPEN_KEY = "zeta-memory-panel-open";

    const toggleBtn = document.createElement("div");
    toggleBtn.id = "zeta-memory-toggle";
    toggleBtn.textContent = "🧠";

    Object.assign(toggleBtn.style, {
        position: "fixed",
        left: "16px",
        bottom: "80px",
        width: "36px",
        height: "36px",
        lineHeight: "36px",
        textAlign: "center",
        background: "#1f1f1f",
        color: "#fff",
        borderRadius: "50%",
        fontSize: "18px",
        cursor: "pointer",
        zIndex: 999999,
        boxShadow: "0 4px 15px rgba(0,0,0,.4)",
        userSelect: "none"
    });

    const panel = document.createElement("div");
    panel.id = "zeta-memory-panel";

    Object.assign(panel.style, {
        position: "fixed",
        left: "16px",
        bottom: "124px",
        width: "240px",
        maxHeight: "70vh",
        overflowY: "auto",
        background: "#1f1f1f",
        color: "#fff",
        padding: "12px",
        borderRadius: "12px",
        fontSize: "12px",
        lineHeight: "1.5",
        fontFamily: "sans-serif",
        zIndex: 999999,
        boxShadow: "0 4px 15px rgba(0,0,0,.4)",
        display: "none"
    });

    const BTN_STYLE = `
        background:#333;color:#fff;border:none;border-radius:8px;
        padding:6px 4px;font-size:11px;cursor:pointer;flex:1 1 auto;
        min-width:70px;
    `;

    panel.innerHTML = `
<div style="font-weight:bold;font-size:14px;">🧠 Zeta Memory <span style="font-weight:normal;font-size:10px;color:#999;">v${VERSION}</span></div>
<hr style="margin:8px 0;border-color:#333;">

<div style="display:grid;grid-template-columns:auto auto;gap:2px 6px;">
  <div style="color:#999;">Room</div><div id="zm-room" style="text-align:right;">${roomId.slice(0, 10)}</div>
  <div style="color:#999;">Profile</div><div id="zm-profile" style="text-align:right;">-</div>
  <div style="color:#999;">Messages</div><div id="zm-count" style="text-align:right;">0</div>
  <div style="color:#999;">History 글자수</div><div id="zm-history-chars" style="text-align:right;">0</div>
  <div style="color:#999;">Memory 글자수</div><div id="zm-memory-chars" style="text-align:right;">0</div>
  <div style="color:#999;">Memory 갱신</div><div id="zm-memory-time" style="text-align:right;">-</div>
  <div style="color:#999;">오늘 호출</div><div id="zm-usage" style="text-align:right;">0회</div>
  <div style="color:#999;">Status</div><div id="zm-status" style="text-align:right;">Idle</div>
</div>

<div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:10px;">
  <button id="zm-btn-force" style="${BTN_STYLE}">🔄 강제갱신</button>
  <button id="zm-btn-view" style="${BTN_STYLE}">📖 보기</button>
  <button id="zm-btn-edit" style="${BTN_STYLE}">✏ 수정</button>
  <button id="zm-btn-reset" style="${BTN_STYLE}">🗑 초기화</button>
  <button id="zm-btn-undo" style="${BTN_STYLE}">↩ 되돌리기</button>
  <button id="zm-btn-settings" style="${BTN_STYLE}">⚙ 설정</button>
  <button id="zm-btn-log" style="${BTN_STYLE}">📋 로그</button>
  <button id="zm-btn-export" style="${BTN_STYLE}">⬇ Export</button>
  <button id="zm-btn-import" style="${BTN_STYLE}">⬆ Import</button>
</div>

<div id="zm-log-preview" style="margin-top:8px;font-size:10px;color:#aaa;"></div>
`;

    document.body.appendChild(toggleBtn);
    document.body.appendChild(panel);

    function setPanelOpen(open) {
        panel.style.display = open ? "block" : "none";
        toggleBtn.style.opacity = open ? "1" : "0.6";
        sessionStorage.setItem(PANEL_OPEN_KEY, open ? "1" : "0");
        if (open) refreshPanel();
    }

    toggleBtn.addEventListener("click", () => {
        const isOpen = panel.style.display !== "none";
        setPanelOpen(!isOpen);
    });

    setPanelOpen(sessionStorage.getItem(PANEL_OPEN_KEY) === "1");

    function setStatus(text) {
        const el = document.getElementById("zm-status");
        if (el) el.textContent = text;
    }

    function setCount(n) {
        const el = document.getElementById("zm-count");
        if (el) el.textContent = n;
    }

    function refreshPanel() {

        const el = (id) => document.getElementById(id);

        const profile = getActiveProfile();
        if (el("zm-profile")) el("zm-profile").textContent = profile ? profile.name : "(없음)";

        const history = getMessages();
        const historyChars = buildConversation(history).length;
        if (el("zm-history-chars")) el("zm-history-chars").textContent = historyChars.toLocaleString();

        const memory = getMemory();
        if (el("zm-memory-chars")) el("zm-memory-chars").textContent = memory.length.toLocaleString();

        const updatedAt = Number(localStorage.getItem(MEMORY_UPDATED_AT_KEY) || 0);
        if (el("zm-memory-time")) {
            el("zm-memory-time").textContent = updatedAt
                ? new Date(updatedAt).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" })
                : "-";
        }

        const usage = getUsage();
        if (el("zm-usage")) el("zm-usage").textContent = `${usage.calls}회`;

        renderLogPreview();
    }

    function renderLogPreview() {
        const el = document.getElementById("zm-log-preview");
        if (!el) return;
        const log = getLog().slice(0, 3);
        el.innerHTML = log.map(l => `${l.time} ${escapeHtml(l.text)}`).join("<br>");
    }

    function escapeHtml(str) {
        return String(str)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;");
    }

    //------------------------------------------
    // Modal helper (보기/수정/설정/로그/프로필관리 공용)
    //------------------------------------------

    function openModal(title, bodyNode, { onSave, saveLabel } = {}) {

        const overlay = document.createElement("div");
        Object.assign(overlay.style, {
            position: "fixed", inset: "0", background: "rgba(0,0,0,.6)",
            zIndex: 1000000, display: "flex", alignItems: "flex-end", justifyContent: "center"
        });

        const sheet = document.createElement("div");
        Object.assign(sheet.style, {
            background: "#1f1f1f", color: "#fff", width: "100%", maxWidth: "480px",
            maxHeight: "85vh", overflowY: "auto", borderRadius: "16px 16px 0 0",
            padding: "16px", fontFamily: "sans-serif", fontSize: "13px"
        });

        const header = document.createElement("div");
        header.style.display = "flex";
        header.style.justifyContent = "space-between";
        header.style.alignItems = "center";
        header.style.marginBottom = "10px";
        header.innerHTML = `<div style="font-weight:bold;font-size:15px;">${title}</div>`;

        const closeBtn = document.createElement("button");
        closeBtn.textContent = "✕";
        Object.assign(closeBtn.style, { background: "none", border: "none", color: "#fff", fontSize: "18px", cursor: "pointer" });
        closeBtn.addEventListener("click", () => overlay.remove());
        header.appendChild(closeBtn);

        sheet.appendChild(header);
        sheet.appendChild(bodyNode);

        if (onSave) {
            const saveBtn = document.createElement("button");
            saveBtn.textContent = saveLabel || "저장";
            Object.assign(saveBtn.style, {
                marginTop: "12px", width: "100%", padding: "10px", background: "#4a7dff",
                color: "#fff", border: "none", borderRadius: "8px", fontSize: "13px", cursor: "pointer"
            });
            saveBtn.addEventListener("click", () => {
                onSave();
                overlay.remove();
            });
            sheet.appendChild(saveBtn);
        }

        overlay.appendChild(sheet);
        overlay.addEventListener("click", (e) => {
            if (e.target === overlay) overlay.remove();
        });

        document.body.appendChild(overlay);
        return overlay;
    }

    //------------------------------------------
    // Read Messages
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

                // DOM에 붙는 순서(삽입 순서)는 신뢰하지 않는다.
                // 스크롤로 과거 메시지를 불러올 때 DOM 뒤쪽(배열 끝)에 끼워 넣는
                // 구조라면, DOM 순서 = 시간순이 아니게 되어 "과거 메시지 로드"를
                // "새 메시지 도착"으로 오인하는 문제가 생긴다.
                // 그래서 실제 화면상 세로 위치를 기준으로 정렬해서, 스크롤/DOM
                // 삽입 방식과 무관하게 항상 위(과거)->아래(최신) 순서를 보장한다.
                const top = bubble.getBoundingClientRect().top;

                result.push({ role, text, top });
            });

        result.sort((a, b) => a.top - b.top);

        const messages = result.map(({ role, text }) => ({ role, text }));

        setCount(messages.length);

        return messages;
    }

    //------------------------------------------
    // Save
    //------------------------------------------

    function saveHistory(messages) {

        const list = messages || getMessages();

        localStorage.setItem(STORAGE_KEY, JSON.stringify({
            roomId,
            updatedAt: Date.now(),
            messages: list
        }));

        console.log("✅ Saved", list.length);
        pushLog(`Saved (${list.length})`);

        return list;
    }

    //------------------------------------------
    // LLM Call (재시도 + 429 대기 포함)
    //------------------------------------------

    async function callOpenAI(prompt, { retries = 3 } = {}) {

        const profile = getActiveProfile();

        if (!profile) {
            alert("사용할 프로필이 없습니다. 설정에서 프로필을 추가해주세요.");
            throw new Error("NO_PROFILE");
        }

        const url =
            profile.provider === "cerebras"
                ? "https://api.cerebras.ai/v1/chat/completions"
                : profile.provider === "openrouter"
                    ? "https://openrouter.ai/api/v1/chat/completions"
                    : "https://api.openai.com/v1/chat/completions";

        let lastError = null;

        for (let attempt = 0; attempt <= retries; attempt++) {

            try {

                const res = await fetch(url, {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        "Authorization": `Bearer ${profile.apiKey}`
                    },
                    body: JSON.stringify({
                        model: profile.model,
                        temperature: 0,
                        messages: [{ role: "user", content: prompt }]
                    })
                });

                if (res.status === 429) {
                    const waitMs = Math.min(30000, 2000 * Math.pow(2, attempt));
                    pushLog(`429 재시도 대기 ${Math.round(waitMs / 1000)}s`);
                    await new Promise(r => setTimeout(r, waitMs));
                    continue;
                }

                if (!res.ok) {
                    const errText = await res.text().catch(() => "");
                    throw new Error(`API 오류 ${res.status}: ${errText}`);
                }

                const data = await res.json();
                console.log(data);

                if (data.usage) recordUsage(data.usage);

                return data.choices[0].message.content;

            } catch (err) {
                lastError = err;
                if (attempt < retries) {
                    await new Promise(r => setTimeout(r, 1500 * (attempt + 1)));
                }
            }
        }

        pushLog("API Error");
        throw lastError || new Error("API 호출 실패");
    }

    //------------------------------------------
    // Memory helpers
    //------------------------------------------

    function getMemory() {
        return localStorage.getItem(MEMORY_KEY) || "";
    }

    function buildConversation(messages) {
        return messages.map(m => `${m.role.toUpperCase()}\n${m.text}`).join("\n\n");
    }

    function getMemoryIndex() {
        return Number(localStorage.getItem(MEMORY_INDEX_KEY) || 0);
    }

    const FIELD_LABELS = ["현재 장소", "현재 관계", "현재 상황", "등장인물", "중요 설정"];

    function parseMemoryFields(text) {

        const fields = { location: "", relationship: "", situation: "", characters: "", setting: "" };
        const keys = ["location", "relationship", "situation", "characters", "setting"];

        if (!text) return fields;

        for (let i = 0; i < FIELD_LABELS.length; i++) {
            const label = FIELD_LABELS[i];
            const rest = FIELD_LABELS.slice(i + 1).map(l => l.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
            const lookahead = rest.length ? `(?:${rest.join("|")})\\s*[:：]|$` : "$";
            const pattern = new RegExp(label + "\\s*[:：]\\s*([\\s\\S]*?)(?=" + lookahead + ")");
            const m = text.match(pattern);
            fields[keys[i]] = m ? m[1].trim() : "";
        }

        return fields;
    }

    function buildMemoryText(fields) {
        return `현재 장소: ${fields.location}\n현재 관계: ${fields.relationship}\n현재 상황: ${fields.situation}\n등장인물: ${fields.characters}\n중요 설정: ${fields.setting}`;
    }

    function applyLocks(newText, previousText, locks) {

        if (!locks.location && !locks.relationship && !locks.setting) return newText;

        const newFields = parseMemoryFields(newText);
        const prevFields = parseMemoryFields(previousText);

        if (locks.location && prevFields.location) newFields.location = prevFields.location;
        if (locks.relationship && prevFields.relationship) newFields.relationship = prevFields.relationship;
        if (locks.setting && prevFields.setting) newFields.setting = prevFields.setting;

        return buildMemoryText(newFields);
    }

    // 증분(incremental) 업데이트: 이전 Memory + 그 이후 새 대화만 LLM에 전달
    async function updateMemory() {

        if (updatingMemory) return getMemory();

        updatingMemory = true;
        setStatus("Memory 생성 중...");

        try {

            const history = getMessages();
            const lastIndex = getMemoryIndex();
            const deltaMessages = history.slice(lastIndex);

            if (deltaMessages.length === 0) {
                setStatus("갱신할 새 대화 없음");
                return getMemory();
            }

            const previousMemory = getMemory();
            const deltaConversation = buildConversation(deltaMessages);
            const settings = getSettings();
            const roomContext = getRoomContext();

            const prompt = `${settings.prompt}
${roomContext ? `\n[로어북 / 기본설정 (항상 참고, 대화 내용보다 우선하는 세계관 설정)]\n${roomContext}\n` : ""}
[이전 Memory]
${previousMemory || "(없음, 최초 생성)"}

[새로 추가된 대화]
${deltaConversation}
`;

            let memory = await callOpenAI(prompt);

            const locks = getLocks();
            memory = applyLocks(memory, previousMemory, locks);

            pushMemorySnapshot(previousMemory);

            localStorage.setItem(MEMORY_KEY, memory);
            localStorage.setItem(MEMORY_INDEX_KEY, history.length);
            localStorage.setItem(MEMORY_LENGTH_KEY, buildConversation(history).length);
            localStorage.setItem(MEMORY_UPDATED_AT_KEY, Date.now());

            setStatus("Memory 갱신 완료");
            pushLog("Memory Updated");
            refreshPanel();

            return memory;

        } catch (err) {
            console.error("❌ Memory 갱신 실패", err);
            setStatus("Memory 갱신 실패 (콘솔 확인)");
        } finally {
            updatingMemory = false;
        }
    }

    function maybeUpdateMemory() {

        const settings = getSettings();
        if (!settings.autoMemory) return;

        const history = getMessages();
        const lastIndex = getMemoryIndex();
        const deltaMessages = history.slice(lastIndex);
        const deltaChars = buildConversation(deltaMessages).length;

        if (deltaChars >= settings.deltaChars) {
            updateMemory();
        } else {
            setStatus("대기 중 (변화량 부족)");
        }
    }

    //------------------------------------------
    // Change detection (스크롤 로딩 vs 실제 새 메시지 구분)
    //------------------------------------------

    let lastSignature = null;

    function getSignature(messages) {
        if (messages.length === 0) return { count: 0, role: "", len: 0, head: "" };
        const last = messages[messages.length - 1];
        return { count: messages.length, role: last.role, len: last.text.length, head: last.text.slice(0, 50) };
    }

    function sameSignature(a, b) {
        return a.count === b.count && a.role === b.role && a.len === b.len && a.head === b.head;
    }

    function isRealNewMessage(current, previous) {
        if (!previous) return current.count > 0;
        if (current.count === previous.count) return false;
        const sameTail = current.role === previous.role && current.len === previous.len && current.head === previous.head;
        return !sameTail;
    }

    //------------------------------------------
    // Auto Save
    //------------------------------------------

    function autoSave() {

        const messages = getMessages();
        const signature = getSignature(messages);

        if (lastSignature && sameSignature(signature, lastSignature)) return;

        const isNew = isRealNewMessage(signature, lastSignature);
        lastSignature = signature;

        saveHistory(messages);
        refreshPanel();

        if (!isNew) {
            setStatus("과거 메시지 로드 감지 (Memory 대기 유지)");
            return;
        }

        setStatus("새 메시지 감지, 대기 중...");

        const settings = getSettings();
        clearTimeout(memoryDebounceTimer);
        memoryDebounceTimer = setTimeout(() => {
            maybeUpdateMemory();
        }, settings.debounceMs);
    }

    //------------------------------------------
    // Observe
    //------------------------------------------

    const observer = new MutationObserver(() => {
        clearTimeout(window.__zetaMemoryTimer__);
        window.__zetaMemoryTimer__ = setTimeout(() => {
            autoSave();
        }, 300);
    });

    observer.observe(document.body, {
        childList: true,
        subtree: true,
        characterData: true
    });

    //------------------------------------------
    // Context prefix + fetch 가로채기 (자동 삽입)
    //------------------------------------------

    function buildContextPrefix(userInput) {

        const memory = getMemory();
        if (!memory) return userInput;
        if (userInput.startsWith(MEMORY_TAG)) return userInput;

        return `${MEMORY_TAG}\n${memory}\n\n[사용자 입력]\n${userInput}`;
    }

    const originalFetch = window.fetch;

    window.fetch = async function (input, init) {

        try {

            const settings = getSettings();

            if (settings.autoInject) {

                const url = typeof input === "string" ? input : (input && input.url) || "";
                const method = (
                    (init && init.method) ||
                    (typeof input !== "string" && input && input.method) ||
                    "GET"
                ).toUpperCase();

                if (method === "POST" && STREAM_URL_RE.test(url) && init && init.body) {

                    const bodyObj = JSON.parse(init.body);

                    if (bodyObj && bodyObj.type === "TEXT" && typeof bodyObj.text === "string") {
                        bodyObj.text = buildContextPrefix(bodyObj.text);
                        init = Object.assign({}, init, { body: JSON.stringify(bodyObj) });
                        console.log("🧠 Memory 주입됨:", bodyObj.text.slice(0, 80) + "...");
                        pushLog("Memory Injected");
                    }
                }
            }

        } catch (err) {
            console.error("❌ Memory 주입 실패, 원본 요청 그대로 전송", err);
        }

        return originalFetch.call(this, input, init);
    };

    //------------------------------------------
    // Export / Import - 방 단위
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

    function exportRoom() {

        const data = {
            kind: "zeta-memory-room-backup",
            version: VERSION,
            roomId,
            exportedAt: Date.now(),
            history: localStorage.getItem(STORAGE_KEY),
            memory: localStorage.getItem(MEMORY_KEY),
            memoryIndex: localStorage.getItem(MEMORY_INDEX_KEY),
            memoryLength: localStorage.getItem(MEMORY_LENGTH_KEY),
            memoryUpdatedAt: localStorage.getItem(MEMORY_UPDATED_AT_KEY),
            memoryHistory: localStorage.getItem(MEMORY_HISTORY_KEY),
            context: localStorage.getItem(CONTEXT_KEY),
            locks: localStorage.getItem(LOCKS_KEY),
            log: localStorage.getItem(LOG_KEY),
            settings: localStorage.getItem(SETTINGS_KEY)
        };

        downloadJson(data, `zeta-memory-room-${roomId}-${todayStr()}.json`);
        pushLog("Export 완료 (Room)");
    }

    function importRoomFile(file) {

        const reader = new FileReader();

        reader.onload = () => {

            try {

                const data = JSON.parse(reader.result);

                if (data.kind !== "zeta-memory-room-backup") {
                    alert("이 파일은 Room 백업 파일이 아닙니다.");
                    return;
                }

                if (!confirm(`현재 방(${roomId})의 데이터를 백업 파일 내용으로 덮어씁니다. 계속할까요?`)) return;

                if (data.history) localStorage.setItem(STORAGE_KEY, data.history);
                if (data.memory) localStorage.setItem(MEMORY_KEY, data.memory);
                if (data.memoryIndex) localStorage.setItem(MEMORY_INDEX_KEY, data.memoryIndex);
                if (data.memoryLength) localStorage.setItem(MEMORY_LENGTH_KEY, data.memoryLength);
                if (data.memoryUpdatedAt) localStorage.setItem(MEMORY_UPDATED_AT_KEY, data.memoryUpdatedAt);
                if (data.memoryHistory) localStorage.setItem(MEMORY_HISTORY_KEY, data.memoryHistory);
                if (data.context) localStorage.setItem(CONTEXT_KEY, data.context);
                if (data.locks) localStorage.setItem(LOCKS_KEY, data.locks);
                if (data.log) localStorage.setItem(LOG_KEY, data.log);
                if (data.settings) localStorage.setItem(SETTINGS_KEY, data.settings);

                pushLog("Import 완료 (Room)");
                refreshPanel();
                alert("복원 완료. 새로고침을 권장합니다.");

            } catch (err) {
                console.error(err);
                alert("파일을 읽는 중 오류가 발생했습니다.");
            }
        };

        reader.readAsText(file);
    }

    //------------------------------------------
    // Export / Import - 전체 백업 (모든 Room + Profile + 설정)
    //------------------------------------------

    function exportAll() {

        const dump = {};

        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key && key.startsWith("zeta-memory")) {
                dump[key] = localStorage.getItem(key);
            }
        }

        downloadJson(
            { kind: "zeta-memory-full-backup", version: VERSION, exportedAt: Date.now(), data: dump },
            `zeta-memory-full-backup-${todayStr()}.json`
        );

        pushLog("Export 완료 (전체)");
    }

    function importAllFile(file) {

        const reader = new FileReader();

        reader.onload = () => {

            try {

                const parsed = JSON.parse(reader.result);

                if (parsed.kind !== "zeta-memory-full-backup" || !parsed.data) {
                    alert("이 파일은 전체 백업 파일이 아닙니다.");
                    return;
                }

                if (!confirm("브라우저에 저장된 모든 Zeta Memory 데이터(모든 방, 프로필 포함)를 덮어씁니다. 계속할까요?")) return;

                Object.keys(parsed.data).forEach(key => {
                    localStorage.setItem(key, parsed.data[key]);
                });

                alert("전체 복원 완료. 페이지를 새로고침합니다.");
                location.reload();

            } catch (err) {
                console.error(err);
                alert("파일을 읽는 중 오류가 발생했습니다.");
            }
        };

        reader.readAsText(file);
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

    //------------------------------------------
    // Modal: Memory 보기
    //------------------------------------------

    function showMemoryViewModal() {
        const body = document.createElement("div");
        const pre = document.createElement("pre");
        pre.style.whiteSpace = "pre-wrap";
        pre.style.wordBreak = "break-word";
        pre.style.background = "#111";
        pre.style.padding = "10px";
        pre.style.borderRadius = "8px";
        pre.style.maxHeight = "50vh";
        pre.style.overflowY = "auto";
        pre.textContent = getMemory() || "(저장된 Memory가 없습니다)";
        body.appendChild(pre);
        openModal("📖 Memory 보기", body);
    }

    //------------------------------------------
    // Modal: Memory 수정
    //------------------------------------------

    function showMemoryEditModal() {
        const body = document.createElement("div");
        const textarea = document.createElement("textarea");
        Object.assign(textarea.style, {
            width: "100%", height: "40vh", background: "#111", color: "#fff",
            border: "1px solid #444", borderRadius: "8px", padding: "8px", fontSize: "13px",
            boxSizing: "border-box"
        });
        textarea.value = getMemory();
        body.appendChild(textarea);

        openModal("✏ Memory 수정", body, {
            saveLabel: "저장",
            onSave: () => {
                localStorage.setItem(MEMORY_KEY, textarea.value);
                localStorage.setItem(MEMORY_UPDATED_AT_KEY, Date.now());
                pushLog("Memory 수동 수정");
                refreshPanel();
            }
        });
    }

    //------------------------------------------
    // Modal: 로그
    //------------------------------------------

    function showLogModal() {
        const body = document.createElement("div");
        const log = getLog();
        body.innerHTML = log.length
            ? log.map(l => `<div style="padding:4px 0;border-bottom:1px solid #333;">${l.time} &nbsp; ${escapeHtml(l.text)}</div>`).join("")
            : "<div>로그가 없습니다.</div>";
        openModal("📋 최근 로그", body);
    }

    //------------------------------------------
    // Modal: 설정 (Settings)
    //------------------------------------------

    function showSettingsModal() {

        const settings = getSettings();
        const locks = getLocks();
        const profiles = getProfiles();
        const activeId = getActiveProfileId();

        const body = document.createElement("div");
        body.innerHTML = `
<div style="font-weight:bold;margin-bottom:6px;">프로필</div>
<select id="zm-profile-select" style="width:100%;padding:6px;background:#111;color:#fff;border:1px solid #444;border-radius:6px;">
  ${profiles.map(p => `<option value="${p.id}" ${p.id === activeId ? "selected" : ""}>${escapeHtml(p.name)} (${escapeHtml(p.provider)})</option>`).join("")}
</select>
<div style="display:flex;gap:6px;margin-top:6px;">
  <button id="zm-profile-add" style="${BTN_STYLE}">+ 새 프로필</button>
  <button id="zm-profile-edit" style="${BTN_STYLE}">✏ 수정</button>
  <button id="zm-profile-del" style="${BTN_STYLE}">🗑 삭제</button>
</div>

<hr style="margin:12px 0;border-color:#333;">

<div style="font-weight:bold;margin-bottom:6px;">자동 동작</div>
<label style="display:flex;align-items:center;gap:6px;margin:4px 0;">
  <input type="checkbox" id="zm-auto-memory" ${settings.autoMemory ? "checked" : ""}> 자동 Memory 생성
</label>
<label style="display:flex;align-items:center;gap:6px;margin:4px 0;">
  <input type="checkbox" id="zm-auto-inject" ${settings.autoInject ? "checked" : ""}> 자동 Memory 삽입
</label>

<div style="margin-top:8px;">Memory 생성 기준 글자수</div>
<input id="zm-delta-chars" type="number" value="${settings.deltaChars}" style="width:100%;padding:6px;background:#111;color:#fff;border:1px solid #444;border-radius:6px;">

<div style="margin-top:8px;">Debounce 시간 (ms)</div>
<input id="zm-debounce" type="number" value="${settings.debounceMs}" style="width:100%;padding:6px;background:#111;color:#fff;border:1px solid #444;border-radius:6px;">

<hr style="margin:12px 0;border-color:#333;">

<div style="font-weight:bold;margin-bottom:6px;">Memory Lock (이 방)</div>
<label style="display:flex;align-items:center;gap:6px;margin:4px 0;">
  <input type="checkbox" id="zm-lock-location" ${locks.location ? "checked" : ""}> 장소 잠금
</label>
<label style="display:flex;align-items:center;gap:6px;margin:4px 0;">
  <input type="checkbox" id="zm-lock-relationship" ${locks.relationship ? "checked" : ""}> 관계 잠금
</label>
<label style="display:flex;align-items:center;gap:6px;margin:4px 0;">
  <input type="checkbox" id="zm-lock-setting" ${locks.setting ? "checked" : ""}> 세계관/설정 잠금
</label>

<hr style="margin:12px 0;border-color:#333;">

<div style="font-weight:bold;margin-bottom:6px;">🌍 고정 컨텍스트 (로어북 / 기본설정)</div>
<div style="color:#999;font-size:11px;margin-bottom:6px;">
  여기에 적어둔 내용은 Memory 생성 시 항상 함께 전달됩니다. 대화 단편만 보고
  요약해서 상황이 어긋나는 문제를 줄여줍니다. 아래 버튼은 몇 가지 흔한 API
  패턴으로 방 정보를 자동으로 가져와보는 시도이며, 제타 쪽 구조상 실패할 수
  있습니다 (그 경우 콘솔 로그를 참고해 직접 붙여넣어 주세요).
</div>
<textarea id="zm-context" style="width:100%;height:18vh;background:#111;color:#fff;border:1px solid #444;border-radius:6px;padding:8px;font-size:12px;box-sizing:border-box;">${escapeHtml(getRoomContext())}</textarea>
<button id="zm-context-fetch" style="${BTN_STYLE};margin-top:6px;width:100%;">🔍 방 정보 자동 가져오기 시도</button>

<hr style="margin:12px 0;border-color:#333;">

<div style="font-weight:bold;margin-bottom:6px;">Memory 생성 Prompt</div>
<textarea id="zm-prompt" style="width:100%;height:30vh;background:#111;color:#fff;border:1px solid #444;border-radius:6px;padding:8px;font-size:12px;box-sizing:border-box;">${escapeHtml(settings.prompt)}</textarea>
<button id="zm-prompt-reset" style="${BTN_STYLE};margin-top:6px;width:100%;">Prompt 초기화</button>
`;

        body.querySelector("#zm-profile-add").addEventListener("click", () => {
            const name = prompt("프로필 이름", "새 프로필");
            if (name === null) return;
            const provider = prompt("Provider (cerebras / openai / openrouter)", "cerebras");
            if (provider === null) return;
            const model = prompt("모델", "gpt-oss-120b");
            if (model === null) return;
            const apiKey = prompt("API Key");
            if (apiKey === null) return;
            const id = addProfile({ name, provider, model, apiKey });
            setActiveProfileId(id);
            overlay.remove();
            showSettingsModal();
        });

        body.querySelector("#zm-profile-edit").addEventListener("click", () => {
            const select = body.querySelector("#zm-profile-select");
            const id = select.value;
            const p = profiles.find(pr => pr.id === id);
            if (!p) return;
            const name = prompt("프로필 이름", p.name);
            if (name === null) return;
            const provider = prompt("Provider", p.provider);
            if (provider === null) return;
            const model = prompt("모델", p.model);
            if (model === null) return;
            const apiKey = prompt("API Key (비워두면 기존 값 유지)", "");
            updateProfile(id, { name, provider, model, apiKey: apiKey || p.apiKey });
            overlay.remove();
            showSettingsModal();
        });

        body.querySelector("#zm-profile-del").addEventListener("click", () => {
            const select = body.querySelector("#zm-profile-select");
            const id = select.value;
            if (!confirm("이 프로필을 삭제할까요?")) return;
            deleteProfile(id);
            overlay.remove();
            showSettingsModal();
        });

        body.querySelector("#zm-prompt-reset").addEventListener("click", () => {
            body.querySelector("#zm-prompt").value = DEFAULT_PROMPT;
        });

        body.querySelector("#zm-context-fetch").addEventListener("click", async () => {
            const btn = body.querySelector("#zm-context-fetch");
            btn.textContent = "가져오는 중...";
            btn.disabled = true;
            try {
                const result = await tryAutoFetchRoomContext();
                if (!result) {
                    alert("자동으로 가져오는 데 실패했습니다. 브라우저 개발자도구 Network 탭에서 방 정보를 불러오는 요청(GET) URL을 확인해서, 스크립트의 tryAutoFetchRoomContext() 후보 목록에 추가해 주세요.");
                    return;
                }
                if (result.found) {
                    const text = Object.entries(result.found)
                        .map(([k, v]) => `# ${k}\n${Array.isArray(v) ? v.join("\n") : v}`)
                        .join("\n\n");
                    body.querySelector("#zm-context").value = text;
                    alert(`"${result.path}" 에서 로어북/설정으로 추정되는 항목을 찾았습니다. 내용을 확인 후 필요 없는 부분은 지워주세요.`);
                } else {
                    console.log("🧠 [Zeta Memory] 응답은 받았지만 로어북/설정으로 보이는 필드를 자동으로 못 찾았습니다:", result.raw);
                    alert(`"${result.path}" 응답은 받았지만 자동으로 필드를 특정하지 못했습니다. 콘솔(F12)에 원본 JSON을 출력해뒀으니 확인 후 직접 붙여넣어 주세요.`);
                }
            } catch (err) {
                console.error(err);
                alert("가져오는 중 오류가 발생했습니다. 콘솔을 확인해주세요.");
            } finally {
                btn.textContent = "🔍 방 정보 자동 가져오기 시도";
                btn.disabled = false;
            }
        });

        var overlay = openModal("⚙ 설정", body, {
            saveLabel: "설정 저장",
            onSave: () => {

                setActiveProfileId(body.querySelector("#zm-profile-select").value);

                saveSettings({
                    autoMemory: body.querySelector("#zm-auto-memory").checked,
                    autoInject: body.querySelector("#zm-auto-inject").checked,
                    deltaChars: Number(body.querySelector("#zm-delta-chars").value) || DEFAULT_SETTINGS.deltaChars,
                    debounceMs: Number(body.querySelector("#zm-debounce").value) || DEFAULT_SETTINGS.debounceMs,
                    prompt: body.querySelector("#zm-prompt").value || DEFAULT_PROMPT
                });

                saveLocks({
                    location: body.querySelector("#zm-lock-location").checked,
                    relationship: body.querySelector("#zm-lock-relationship").checked,
                    setting: body.querySelector("#zm-lock-setting").checked
                });

                saveRoomContext(body.querySelector("#zm-context").value);

                pushLog("설정 저장");
                refreshPanel();
            }
        });
    }

    //------------------------------------------
    // Button wiring
    //------------------------------------------

    document.getElementById("zm-btn-force").addEventListener("click", async () => {
        setStatus("강제 갱신 중...");
        await updateMemory();
        refreshPanel();
    });

    document.getElementById("zm-btn-view").addEventListener("click", showMemoryViewModal);
    document.getElementById("zm-btn-edit").addEventListener("click", showMemoryEditModal);

    document.getElementById("zm-btn-reset").addEventListener("click", () => {
        if (!confirm("이 방의 Memory를 초기화할까요? (History는 유지됩니다)")) return;
        localStorage.removeItem(MEMORY_KEY);
        localStorage.removeItem(MEMORY_INDEX_KEY);
        localStorage.removeItem(MEMORY_LENGTH_KEY);
        localStorage.removeItem(MEMORY_UPDATED_AT_KEY);
        pushLog("Memory 초기화");
        refreshPanel();
    });

    document.getElementById("zm-btn-settings").addEventListener("click", showSettingsModal);
    document.getElementById("zm-btn-log").addEventListener("click", showLogModal);

    document.getElementById("zm-btn-undo").addEventListener("click", () => {
        const hist = getMemoryHistory();
        if (hist.length === 0) {
            alert("되돌릴 이전 Memory가 없습니다.");
            return;
        }
        if (!confirm(`현재 Memory를 ${new Date(hist[0].time).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" })} 시점으로 되돌릴까요?`)) return;
        if (undoLastMemory()) refreshPanel();
    });

    // 짧게 탭: 방 단위 백업 / 0.6초 이상 길게 누르기(모바일) or 우클릭(PC): 전체 백업
    (function wireExportButton() {

        const btn = document.getElementById("zm-btn-export");
        let pressTimer = null;
        let longPressed = false;

        const startPress = () => {
            longPressed = false;
            pressTimer = setTimeout(() => {
                longPressed = true;
                if (confirm("전체 백업(모든 방 + 프로필)을 내보낼까요?")) exportAll();
            }, 600);
        };

        const cancelPress = () => {
            clearTimeout(pressTimer);
        };

        btn.addEventListener("touchstart", startPress, { passive: true });
        btn.addEventListener("touchend", cancelPress);
        btn.addEventListener("touchmove", cancelPress);
        btn.addEventListener("mousedown", startPress);
        btn.addEventListener("mouseup", cancelPress);
        btn.addEventListener("mouseleave", cancelPress);

        btn.addEventListener("contextmenu", (e) => e.preventDefault());

        btn.addEventListener("click", () => {
            if (longPressed) return; // 롱프레스로 이미 처리됨
            exportRoom();
        });
    })();

    document.getElementById("zm-btn-import").addEventListener("click", () => {
        pickFile((file) => {
            file.text().then(text => {
                try {
                    const parsed = JSON.parse(text);
                    if (parsed.kind === "zeta-memory-full-backup") {
                        importAllFile(file);
                    } else {
                        importRoomFile(file);
                    }
                } catch {
                    alert("올바른 JSON 파일이 아닙니다.");
                }
            });
        });
    });

    //------------------------------------------
    // First Save / Profile setup
    //------------------------------------------

    migrateLegacyProfile();

    if (getProfiles().length === 0) {
        setupProfile();
    }

    autoSave();
    refreshPanel();

    function setupProfile() {

        const profileName = prompt("프로필 이름", "기본");
        if (profileName === null) return;

        const provider = prompt("Provider\n(cerebras / openai / openrouter)", "cerebras");
        if (provider === null) return;

        const model = prompt("모델", "gpt-oss-120b");
        if (model === null) return;

        const apiKey = prompt("API Key");
        if (apiKey === null) return;

        const id = addProfile({ name: profileName, provider, model, apiKey });
        setActiveProfileId(id);

        console.log("✅ Profile Saved");
        pushLog("프로필 생성");
    }

    //------------------------------------------
    // Public API
    //------------------------------------------

    window.ZetaMemory = {
        version: VERSION,
        roomId,
        getMessages,
        saveHistory,
        autoSave,
        getProfiles,
        addProfile,
        updateProfile,
        deleteProfile,
        getActiveProfile,
        setActiveProfileId,
        getSettings,
        saveSettings,
        callOpenAI,
        updateMemory,
        maybeUpdateMemory,
        getMemory,
        getLocks,
        saveLocks,
        buildContextPrefix,
        exportRoom,
        exportAll,
        getLog,
        getRoomContext,
        saveRoomContext,
        tryAutoFetchRoomContext,
        getMemoryHistory,
        undoLastMemory,
        observer
    };

    console.log("🧠 Zeta Memory Ready");

})();
