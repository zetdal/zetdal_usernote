(() => {
   
    "use strict";

    // ==========================
    // Zeta Memory v0.1.0
    // ==========================

    if (window.__ZETA_MEMORY_RUNNING__) {
        console.log("🧠 Zeta Memory already running.");
        return;
    }

    window.__ZETA_MEMORY_RUNNING__ = true;

    const VERSION = "0.1.0";
   const PROFILE_KEY = "zeta-memory-profile";
    const roomId = location.pathname.split("/").pop();
    const STORAGE_KEY = `zeta-memory-${roomId}`;
   const MEMORY_LENGTH_KEY =
    `${STORAGE_KEY}-memory-length`;

   let updatingMemory = false;

    console.log(`🧠 Zeta Memory v${VERSION}`);

    //------------------------------------------
    // UI
    //------------------------------------------

    const panel = document.createElement("div");
    panel.id = "zeta-memory-panel";

    Object.assign(panel.style, {
        position: "fixed",
        right: "16px",
        bottom: "80px",
        background: "#1f1f1f",
        color: "#fff",
        padding: "12px",
        borderRadius: "12px",
        fontSize: "13px",
        lineHeight: "1.5",
        fontFamily: "sans-serif",
        zIndex: 999999,
        boxShadow: "0 4px 15px rgba(0,0,0,.4)"
    });

    panel.innerHTML = `
<div style="font-weight:bold;font-size:15px;">🧠 Zeta Memory</div>
<div>v${VERSION}</div>
<hr style="margin:8px 0;border-color:#333;">
<div>Room</div>
<div id="zm-room">${roomId}</div>

<div style="margin-top:8px;">Messages</div>
<div id="zm-count">0</div>

<div style="margin-top:8px;">Saved</div>
<div id="zm-saved">0</div>

<div style="margin-top:8px;">Status</div>
<div id="zm-status">Idle</div>
`;

    document.body.appendChild(panel);

    //------------------------------------------
    // Utils
    //------------------------------------------

    function setStatus(text) {
        const el = document.getElementById("zm-status");
        if (el) el.textContent = text;
    }

    function setCount(n) {
        const el = document.getElementById("zm-count");
        if (el) el.textContent = n;
    }

    function setSaved(n) {
        const el = document.getElementById("zm-saved");
        if (el) el.textContent = n;
    }

    //------------------------------------------
    // Read Messages
    //------------------------------------------

    function getMessages() {

        const result = [];

        document
            .querySelectorAll(".bg-bubble-user, .bg-gray-sub1")
            .forEach(bubble => {

                const role = bubble.classList.contains("bg-bubble-user")
                    ? "user"
                    : "assistant";

                const chat = bubble.querySelector(".chat");

                if (!chat) return;

                const text = chat.innerText.trim();

                if (!text) return;

                result.push({
                    role,
                    text
                });

            });

        setCount(result.length);

        return result;
    }

    //------------------------------------------
    // Save
    //------------------------------------------

    function saveHistory() {
       
        const messages = getMessages();

        const data = {
            roomId,
            updatedAt: Date.now(),
            messages
        };

        localStorage.setItem(
            STORAGE_KEY,
            JSON.stringify(data)
        );

        setSaved(messages.length);
        setStatus("Saved");

        console.log("✅ Saved", messages.length);

    }   

   function getProfile() {

    const raw = localStorage.getItem(PROFILE_KEY);

    if (!raw) return null;

    try {

        return JSON.parse(raw);

    } catch {

        return null;

    }

}

function saveProfile(profile) {

    localStorage.setItem(
        PROFILE_KEY,
        JSON.stringify(profile)
    );

}

async function callOpenAI(prompt) {

    const profile = getProfile();

    if (!profile) {
        alert("프로필이 없습니다.");
        return;
    }

    const url =
        profile.provider === "cerebras"
            ? "https://api.cerebras.ai/v1/chat/completions"
            : "https://api.openai.com/v1/chat/completions";

    const res = await fetch(url, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${profile.apiKey}`
        },
        body: JSON.stringify({
            model: profile.model,
            messages: [
                {
                    role: "user",
                    content: prompt
                }
            ]
        })
    });

    const data = await res.json();

   console.log(data);

return data.choices[0].message.content;
}

   async function updateMemory() {

      if (updatingMemory) return;

updatingMemory = true;

    const history = getMessages();

    const conversation = history.map(m =>
        `${m.role.toUpperCase()}\n${m.text}`
    ).join("\n\n");

    const prompt = `
현재까지의 대화를 장기 기억으로 요약하세요.

규칙

- 추측하지 마세요.
- 장소가 명시되지 않았다면 이전 장소를 유지하세요.
- 앞으로 일어날 일을 예측하지 마세요.
- 확정된 사실만 기록하세요.
- 장소는 현재 장소만 유지하세요.
- 관계 변화는 유지하세요.
- 감정 변화는 유지하세요.
- 반복되는 사건은 제거하세요.
- 1200자 이내.
- 항목은
  현재 장소
  현재 관계
  현재 상황
  중요 설정
만 작성하세요.

${conversation}
`;

const memory = await callOpenAI(prompt);

      localStorage.setItem(
    MEMORY_LENGTH_KEY,
    conversation.length
);

localStorage.setItem(
    `${STORAGE_KEY}-memory`,
    memory
);

updatingMemory = false;

setStatus("Memory Updated");

return memory;

}
   
   //------------------------------------------
    // Auto Save
    //------------------------------------------

    let lastSnapshot = "";

    function autoSave() {

        const current = JSON.stringify(getMessages());

        if (current === lastSnapshot) return;

        lastSnapshot = current;

        saveHistory();

       const history = getMessages();

const length = history
    .map(v => v.text)
    .join("")
    .length;

const lastLength = Number(
    localStorage.getItem(MEMORY_LENGTH_KEY) || 0
);

if (length - lastLength >= 5000) {

    updateMemory();

}

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
    // First Save
    //------------------------------------------

    autoSave();
    setupProfile();

    //------------------------------------------
    // Public API
    //------------------------------------------

function setupProfile() {

    if (getProfile()) return;

    const profileName = prompt("프로필 이름", "기본");

    if (profileName === null) return;

    const provider = prompt(
        "Provider\n(cerebras)",
        "cerebras"
    );

    if (provider === null) return;

    const model = prompt(
        "모델",
        "gpt-oss-120b"
    );

    if (model === null) return;

    const apiKey = prompt("API Key");

    if (apiKey === null) return;

    saveProfile({

        profileName,

        provider,

        model,

        apiKey

    });

    console.log("✅ Profile Saved");

}
   
    window.ZetaMemory = {

        version: VERSION,

        roomId,

        getMessages,

        saveHistory,

        autoSave,

         getProfile,

       callOpenAI,

       updateMemory,

        observer

     

    };

    console.log("🧠 Zeta Memory Ready");

})();
