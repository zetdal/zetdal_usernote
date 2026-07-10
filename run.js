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
    const roomId = location.pathname.split("/").pop();
    const STORAGE_KEY = `zeta-memory-${roomId}`;

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

    }    //------------------------------------------
    // Auto Save
    //------------------------------------------

    let lastSnapshot = "";

    function autoSave() {

        const current = JSON.stringify(getMessages());

        if (current === lastSnapshot) return;

        lastSnapshot = current;

        saveHistory();

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

    //------------------------------------------
    // Public API
    //------------------------------------------

    window.ZetaMemory = {

        version: VERSION,

        roomId,

        getMessages,

        saveHistory,

        autoSave,

        observer

    };

    console.log("🧠 Zeta Memory Ready");

})();
