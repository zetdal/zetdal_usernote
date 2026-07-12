// ==UserScript==
// @name         Zeta User Note Corrector
// @namespace    zeta-usernote-corrector
// @version      1.0.1// ==UserScript==
// @name         Zeta User Note Corrector
// @namespace    zeta-usernote-corrector
// @version      1.0.1
// @description  유저노트(글자수 제한 없음)를 별도 저장해두고, 제타가 노트 내용과 명백히 모순되는 답변을 낼 때만 그 부분만 find/replace로 고친다. 로어북/장기기억/페르소나는 건드리지 않고, 원본 문체·나머지 내용은 그대로 유지한다.
// @match        https://zeta-ai.io/*
// @match        https://*.zeta-ai.io/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(() => {
  "use strict";

  if (window.__ZETA_USERNOTE_CORRECTOR_RUNNING__) {
    console.log("📝 Zeta UserNote Corrector already running.");
    return;
  }
  window.__ZETA_USERNOTE_CORRECTOR_RUNNING__ = true;

  const VERSION = "1.0.1";

  // ==========================================================
  // 0. 아주 작은 유틸
  // ==========================================================

  function safeJsonParse(value, fallback) {
    try { return JSON.parse(value); } catch { return fallback; }
  }

  function normalizeSpace(value) {
    return String(value == null ? "" : value).replace(/\s+/g, " ").trim();
  }

  function uuid() {
    if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
    return "un_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 10);
  }

  function parseModelJson(text) {
    const raw = String(text || "").trim();
    const direct = safeJsonParse(raw, null);
    if (direct && typeof direct === "object") return direct;
    const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) {
      const fenced = safeJsonParse(fence[1].trim(), null);
      if (fenced && typeof fenced === "object") return fenced;
    }
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start !== -1 && end !== -1 && end > start) {
      const sliced = safeJsonParse(raw.slice(start, end + 1), null);
      if (sliced && typeof sliced === "object") return sliced;
    }
    return null;
  }

  // ---- 제타 스트리밍 응답(SSE) 파싱 : ZETA Memory Bridge core.js 로직을 축약 이식 ----

  function parseSse(text) {
    const source = String(text || "");
    const events = [];
    if (!source.trim()) return events;
    const blocks = source.split(/\r?\n\r?\n/);
    blocks.forEach((block) => {
      const dataLines = [];
      block.split(/\r?\n/).forEach((line) => {
        if (/^data:/i.test(line)) dataLines.push(line.replace(/^data:\s?/i, ""));
        else if (line.trim().charAt(0) === "{" || line.trim().charAt(0) === "[") dataLines.push(line.trim());
      });
      if (!dataLines.length) return;
      const joined = dataLines.join("\n").trim();
      if (!joined || joined === "[DONE]") return;
      const parsed = safeJsonParse(joined, null);
      if (parsed != null) events.push(parsed);
    });
    if (!events.length) {
      source.split(/\r?\n/).forEach((line) => {
        const trimmed = line.trim().replace(/^data:\s?/i, "");
        if (!trimmed || trimmed === "[DONE]") return;
        const parsed = safeJsonParse(trimmed, null);
        if (parsed != null) events.push(parsed);
      });
    }
    if (!events.length) {
      const whole = safeJsonParse(source, null);
      if (whole != null) events.push(whole);
    }
    return events;
  }

  function walk(value, path, visit) {
    path = path || "";
    if (value == null) return;
    visit(value, path);
    if (Array.isArray(value)) {
      value.forEach((item, i) => walk(item, path + "[" + i + "]", visit));
    } else if (typeof value === "object") {
      Object.keys(value).forEach((key) => walk(value[key], path ? path + "." + key : key, visit));
    }
  }

  function pickLongest(values) {
    return values.filter((v) => typeof v === "string" && v.trim())
      .sort((a, b) => b.length - a.length)[0] || "";
  }

  // 제타 스트리밍 응답 전체(SSE)에서: 완성된 답변 텍스트 + messageId + candidateId를 뽑아낸다.
  function extractReplyEnvelope(responseText) {
    const events = parseSse(responseText);
    const trueDeltas = [];
    const cumulative = [];
    const finals = [];
    const ids = { requestId: "", messageId: "", candidateId: "" };
    const uuidish = [];
    let completeText = "";

    events.forEach((event) => {
      if (event && typeof event === "object" && String(event.event || "").toUpperCase() === "CHAT_COMPLETE" && event.replyMessage) {
        const reply = event.replyMessage;
        if (reply.id) ids.messageId = String(reply.id);
        if (reply.candidateId) ids.candidateId = String(reply.candidateId);
        if (event.requestId) ids.requestId = String(event.requestId);
        if (Array.isArray(reply.contents)) {
          completeText = reply.contents.map((c) => String((c && c.text) || "")).filter(Boolean).join("\n").trim();
        }
      }
      walk(event, "", (value, path) => {
        const lower = path.toLowerCase();
        const key = lower.split(".").pop().replace(/\[\d+\]$/, "");
        if (typeof value === "string") {
          const str = value;
          if (/(^|\.)(requestid|request_id)$/.test(lower)) ids.requestId = ids.requestId || str;
          if (/(^|\.)(messageid|message_id)$/.test(lower)) ids.messageId = ids.messageId || str;
          if (/(^|\.)(candidateid|candidate_id)$/.test(lower)) ids.candidateId = ids.candidateId || str;
          if (/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(str)) uuidish.push({ path: lower, value: str });
          if (/(^|\.)(delta|token)$/.test(lower) && !/(id|type|model|reason|status)/.test(lower)) {
            if (str.length < 200000) trueDeltas.push(str);
          } else if (/chunkmessage.*(?:content|text)/.test(lower)) {
            if (str.length < 200000) cumulative.push(str);
          } else if (/(content|text|answer|response|result|completion)/.test(lower) &&
            !/(id|type|model|reason|status|url|name|request)/.test(lower)) {
            if (str.length < 200000) finals.push(str);
          }
          if (key === "id") {
            if (/replymessage/.test(lower) && !ids.messageId) ids.messageId = str;
            else if (/candidate/.test(lower) && !ids.candidateId) ids.candidateId = str;
            else if (/message/.test(lower) && !ids.messageId) ids.messageId = str;
          }
        }
      });
    });

    if (!ids.requestId) { const rq = uuidish.find((x) => /request/.test(x.path)); if (rq) ids.requestId = rq.value; }
    if (!ids.messageId) { const mi = uuidish.find((x) => /message/.test(x.path) && !/request/.test(x.path)); if (mi) ids.messageId = mi.value; }
    if (!ids.candidateId) { const ci = uuidish.find((x) => /candidate/.test(x.path)); if (ci) ids.candidateId = ci.value; }

    let text = completeText;
    if (!text && trueDeltas.length) { const joined = trueDeltas.join(""); if (joined.trim().length > 2) text = joined.trim(); }
    if (!text && cumulative.length) text = pickLongest(cumulative).trim();
    if (!text) text = pickLongest(finals).trim();

    return { text, requestId: ids.requestId, messageId: ids.messageId, candidateId: ids.candidateId };
  }

  function isStreamEndpoint(url, method) {
    try {
      const target = new URL(String(url || ""), location.href);
      return target.hostname === "api.zeta-ai.io" &&
        String(method || "").toUpperCase() === "POST" &&
        /^\/v1\/rooms\/[^/]+\/messages\/stream\/?$/i.test(target.pathname);
    } catch { return false; }
  }

  function roomIdFromUrl(url) {
    const m = String(url || "").match(/\/v1\/rooms\/([^/]+)\/messages\/stream/i);
    if (m) return decodeURIComponent(m[1]);
    return currentRoomId();
  }

  function currentRoomId() {
    const m = String(location.pathname || "").match(/\/rooms\/([^/?#]+)/i);
    return m ? decodeURIComponent(m[1]) : "";
  }

  function requestBodyText(body) {
    if (typeof body === "string") return body;
    return "";
  }

  function userTextFromRequestBody(bodyStr) {
    const parsed = safeJsonParse(bodyStr, null);
    if (!parsed || typeof parsed !== "object") return "";
    if (typeof parsed.text === "string") return parsed.text;
    if (typeof parsed.content === "string") return parsed.content;
    return "";
  }

  // ==========================================================
  // 1. 저장소 (localStorage) - 노트 / API 프리셋
  // ==========================================================

  const LS_NOTE_PREFIX = "zeta-unc-note-";
  const LS_PRESETS_KEY = "zeta-unc-api-presets";
  const LS_ACTIVE_PRESET_PREFIX = "zeta-unc-active-preset-";
  const LS_ENABLED_PREFIX = "zeta-unc-enabled-"; // 방별 on/off

  function getNote(roomId) {
    return localStorage.getItem(LS_NOTE_PREFIX + roomId) || "";
  }
  function saveNote(roomId, text) {
    localStorage.setItem(LS_NOTE_PREFIX + roomId, text || "");
  }

  function getEnabled(roomId) {
    const v = localStorage.getItem(LS_ENABLED_PREFIX + roomId);
    return v === null ? true : v === "1";
  }
  function setEnabled(roomId, on) {
    localStorage.setItem(LS_ENABLED_PREFIX + roomId, on ? "1" : "0");
  }

  function getPresets() {
    return safeJsonParse(localStorage.getItem(LS_PRESETS_KEY), []) || [];
  }
  function savePresets(list) {
    localStorage.setItem(LS_PRESETS_KEY, JSON.stringify(list || []));
  }
  function getActivePresetId(roomId) {
    return localStorage.getItem(LS_ACTIVE_PRESET_PREFIX + roomId) || "";
  }
  function setActivePresetId(roomId, id) {
    localStorage.setItem(LS_ACTIVE_PRESET_PREFIX + roomId, id || "");
  }
  function getActivePreset(roomId) {
    const list = getPresets();
    const id = getActivePresetId(roomId);
    return list.find((p) => p.id === id) || list[0] || null;
  }

  // ==========================================================
  // 2. AI 호출 (Gemini / OpenAI / Anthropic / OpenAI 호환)
  // ==========================================================

  async function callAI(preset, systemPrompt, userPrompt) {
    if (!preset) throw new Error("사용할 API 프리셋이 없습니다.");
    const provider = String(preset.provider || "").toLowerCase();
    const apiKey = String(preset.apiKey || "").trim();
    const model = String(preset.model || "").trim();
    if (!apiKey) throw new Error("API 키가 없습니다.");
    if (!model) throw new Error("모델 이름이 없습니다.");

    if (provider === "gemini") {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          systemInstruction: { role: "system", parts: [{ text: systemPrompt }] },
          contents: [{ role: "user", parts: [{ text: userPrompt }] }],
          generationConfig: { temperature: 0, maxOutputTokens: 2048 }
        })
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error("Gemini 오류 (" + res.status + "): " + (data && data.error && data.error.message || res.statusText));
      const parts = data && data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts;
      const text = Array.isArray(parts) ? parts.map((p) => p.text || "").join("") : "";
      if (!text) throw new Error("Gemini 응답에서 텍스트를 찾지 못했습니다.");
      return text;
    }

    if (provider === "openai" || provider === "compatible") {
      let endpoint = "https://api.openai.com/v1/chat/completions";
      if (provider === "compatible") {
        const raw = String(preset.baseUrl || "").trim();
        if (!raw) throw new Error("호환 API 기본 주소가 없습니다.");
        let u;
        try { u = new URL(raw); } catch { throw new Error("호환 API 기본 주소 형식이 올바르지 않습니다."); }
        u.hash = ""; u.search = "";
        u.pathname = u.pathname.replace(/\/+$/, "");
        // 사용자가 이미 .../chat/completions까지 포함한 전체 엔드포인트를 붙여넣은 경우 중복으로 붙이지 않는다.
        if (!/\/chat\/completions$/i.test(u.pathname)) u.pathname += "/chat/completions";
        endpoint = u.toString();
      }
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": "Bearer " + apiKey },
        body: JSON.stringify({
          model,
          temperature: 0,
          messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userPrompt }]
        })
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error("API 오류 (" + res.status + "): " + (data && data.error && data.error.message || res.statusText));
      const text = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
      if (!text) throw new Error("응답에서 텍스트를 찾지 못했습니다.");
      return text;
    }

    if (provider === "anthropic") {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "anthropic-dangerous-direct-browser-access": "true"
        },
        body: JSON.stringify({
          model,
          max_tokens: 2048,
          temperature: 0,
          system: systemPrompt,
          messages: [{ role: "user", content: userPrompt }]
        })
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error("Claude 오류 (" + res.status + "): " + (data && data.error && data.error.message || res.statusText));
      const text = data && Array.isArray(data.content) ? data.content.map((c) => c.text || "").join("") : "";
      if (!text) throw new Error("Claude 응답에서 텍스트를 찾지 못했습니다.");
      return text;
    }

    throw new Error("지원하지 않는 AI 제공사입니다: " + provider);
  }

  async function testPreset(preset) {
    const text = await callAI(preset, "짧게 한 단어로만 답하라.", "테스트: '정상'이라고만 답해줘.");
    return normalizeSpace(text).slice(0, 30);
  }

  // ==========================================================
  // 3. 프롬프트 구성 (find/replace conflict 방식)
  // ==========================================================

  function buildCorrectionPrompt(note, userText, originalReply) {
    const system = [
      "당신은 대화 로그 검수자다. 아래 [유저노트]에 적힌 확정 사실·현재 상태와, [제타 원본 답변]을 대조한다.",
      "임무는 명백히 모순되는 부분만 찾아서 고치는 것이지, 전체를 다시 쓰는 것이 아니다.",
      "",
      "규칙:",
      "1. 원본 답변에 유저노트와 실제로 모순되는 문장/구절이 있을 때만 손댄다.",
      "2. 유저노트가 다루지 않거나, 원본이 그 화제를 그냥 언급하지 않고 넘어가는 경우는 모순이 아니다. 아무것도 추가하지 않는다.",
      "3. 문체, 어투, 인칭, 문단 구성, 대사와 지문 배치, 상태창 등 형식은 절대 건드리지 않는다.",
      "4. find는 [제타 원본 답변]에 있는 문자열을 한 글자도 틀리지 않고 그대로 옮겨 적어야 한다 (요약·의역 금지).",
      "5. find는 원본 안에서 유일하게 특정되어야 한다. 같은 문구가 반복되는 곳이면 앞뒤 맥락을 포함해 더 길게 잡는다.",
      "6. replace는 모순만 해소하도록 최소한으로 고친 문장이며, 원본의 문체와 어울려야 한다.",
      "7. 모순이 없으면 conflicts를 빈 배열로 반환한다.",
      "8. 반드시 아래 JSON 형식 하나만 반환한다. 다른 설명이나 사과를 덧붙이지 않는다.",
      "",
      '{"conflicts":[{"find":"원본 그대로의 문자열","replace":"고친 문자열","reason":"어떤 노트 내용과 왜 모순인지"}]}'
    ].join("\n");

    const user = [
      "[유저노트]",
      note,
      "",
      "[이번 유저 메시지]",
      userText || "(없음)",
      "",
      "[제타 원본 답변]",
      originalReply
    ].join("\n");

    return { system, user };
  }

  // 원본에 find가 "정확히 1번만" 존재하는지 검증 후, 통과한 것만 순서대로 적용한다.
  // 이것이 "원본 유지 보장"의 핵심 안전장치다: 애매하면 그 edit은 통째로 버리고 원본을 그대로 둔다.
  function applyConflicts(original, conflicts) {
    let result = original;
    const applied = [];
    const skipped = [];
    (Array.isArray(conflicts) ? conflicts : []).forEach((c) => {
      const find = c && typeof c.find === "string" ? c.find : "";
      const replace = c && typeof c.replace === "string" ? c.replace : "";
      if (!find) { skipped.push({ ...c, why: "find 없음" }); return; }
      const occurrences = result.split(find).length - 1;
      if (occurrences !== 1) { skipped.push({ ...c, why: occurrences === 0 ? "원본에서 못 찾음" : "원본에 " + occurrences + "번 나와서 특정 불가" }); return; }
      result = result.replace(find, replace);
      applied.push(c);
    });
    return { result, applied, skipped };
  }

  // ==========================================================
  // 4. 화면에 보이는 답변 교체 (텍스트만 치환, DOM 구조는 안 건드림)
  // ==========================================================

  function patchVisibleReply(original, revised, messageId, candidateId) {
    const targetNorm = normalizeSpace(original);
    const revisedNorm = normalizeSpace(revised);
    if (!targetNorm || !revisedNorm || targetNorm === revisedNorm) return false;

    function escapeAttr(value) {
      if (window.CSS && typeof window.CSS.escape === "function") return window.CSS.escape(String(value || ""));
      return String(value || "").replace(/["\\]/g, "\\$&");
    }

    // 이전 버전에는 "자식 엘리먼트가 없는 leaf 노드만" 후보로 삼는 조건이 있었는데,
    // 지문(이탤릭)과 대사가 여러 자식 태그로 나뉘어 있는 답변에서는 그 조건 때문에
    // 텍스트 전체를 담은 요소도, 텍스트 일부만 담은 leaf 요소도 둘 다 targetNorm과
    // 정확히 일치하지 않아 아무것도 못 찾는 문제가 있었다. 그래서 "자식이 있어도 되고,
    // 대신 textContent가 정확히 일치하는 요소들 중 가장 좁게 감싸는 요소"를 고르는
    // 방식으로 바꿨다.
    // zeta 앱이 메시지 말풍선을 Shadow DOM(웹 컴포넌트)으로 렌더링하는 경우,
    // 일반 document.querySelectorAll은 그 내부를 못 뚫고 들어간다. 그래서
    // 페이지 전체에서 open shadow root를 재귀적으로 찾아 검색 범위에 포함시킨다.
    // (closed shadow root는 원리상 외부 스크립트가 접근할 수 없다.)
    function collectShadowRoots() {
      const roots = [document];
      const seen = new Set();
      function scan(scopeRoot) {
        let all;
        try { all = scopeRoot.querySelectorAll("*"); } catch { return; }
        for (let i = 0; i < all.length; i++) {
          const elm = all[i];
          if (elm.id === HOST_ID) continue; // 이 스크립트 자신의 UI는 제외
          if (elm.shadowRoot && !seen.has(elm.shadowRoot)) {
            seen.add(elm.shadowRoot);
            roots.push(elm.shadowRoot);
            scan(elm.shadowRoot);
          }
        }
      }
      scan(document);
      return roots;
    }

    function queryAllRoots(selector) {
      const out = [];
      collectShadowRoots().forEach((root) => {
        try { out.push(...Array.from(root.querySelectorAll(selector))); } catch {}
      });
      return out;
    }

    function candidateElements(nodes) {
      const out = [];
      for (let i = 0; i < nodes.length; i++) {
        const el = nodes[i];
        if (!el || !el.isConnected) continue;
        if (el.id === HOST_ID || (el.closest && el.closest("#" + HOST_ID))) continue;
        if (el.isContentEditable || /^(SCRIPT|STYLE|TEXTAREA|INPUT|BUTTON)$/.test(el.tagName)) continue;
        out.push(el);
      }
      return out;
    }

    function pickTightestMatch(pool) {
      // 1순위: textContent가 답변 원문과 "정확히" 같은 요소 (가장 안전, 오탐 위험 없음)
      let matches = pool.filter((el) => normalizeSpace(el.textContent || "") === targetNorm);
      if (!matches.length) {
        // 2순위: 정확히 같은 요소가 없다면, 라벨("zeta" 표시, 타임스탬프 등)이 같은
        // 컨테이너 안에 섞여 들어가 있는 경우가 있다. 이때는 "답변 원문 전체를
        // 포함하고 있는" 요소들 중 가장 짧은(=가장 좁게 감싸는) 요소를 고른다.
        matches = pool.filter((el) => normalizeSpace(el.textContent || "").includes(targetNorm));
        if (!matches.length) return null;
        matches.sort((a, b) => normalizeSpace(a.textContent || "").length - normalizeSpace(b.textContent || "").length);
        return matches[0];
      }
      // 자손 엘리먼트 수가 가장 적은(=텍스트를 가장 좁게 감싸는) 요소를 고른다.
      // 여러 메시지를 통째로 감싼 큰 컨테이너가 잘못 선택되는 것을 막는다.
      matches.sort((a, b) => a.querySelectorAll("*").length - b.querySelectorAll("*").length);
      return matches[0];
    }

    function findTarget() {
      let roots = [];
      if (messageId || candidateId) {
        const selectors = [];
        if (messageId) selectors.push('[data-message-id="' + escapeAttr(messageId) + '"]', '[data-message-uuid="' + escapeAttr(messageId) + '"]');
        if (candidateId) selectors.push('[data-candidate-id="' + escapeAttr(candidateId) + '"]', '[data-candidate-uuid="' + escapeAttr(candidateId) + '"]');
        selectors.forEach((sel) => { try { roots = roots.concat(queryAllRoots(sel)); } catch {} });
      }
      let pool = roots.length ? candidateElements(roots.flatMap((r) => {
        let list = r.querySelectorAll ? Array.from(r.querySelectorAll("*")).concat([r]) : [r];
        if (r.shadowRoot) list = list.concat(Array.from(r.shadowRoot.querySelectorAll("*")));
        return list;
      })) : [];
      let match = pickTightestMatch(pool);
      if (match) return match;

      const semantic = queryAllRoots('article,[role="article"],[role="listitem"],[data-message-id],[class*="message"],[class*="bubble"],p');
      const semanticPool = candidateElements(semantic.slice(-300));
      match = pickTightestMatch(semanticPool);
      if (match) return match;

      const broad = queryAllRoots("div,span,p,section,article,em,i,strong,b");
      return pickTightestMatch(candidateElements(broad.slice(-500)));
    }

    // 찾은 요소의 실제(raw) 텍스트 안에서 가능한 한 "원본 문자열 부분만" 바꾸고
    // 나머지(라벨, 타임스탬프 등)는 그대로 남긴다. 라벨이 섞여 있지 않고 요소
    // 전체가 답변 텍스트뿐이라면 결과적으로 전체 치환과 동일하다.
    function applyToElement(elm) {
      const full = elm.textContent || "";
      if (full.includes(original)) {
        elm.textContent = full.replace(original, revised);
        return true;
      }
      // 공백/줄바꿈 방식이 미묘하게 달라 원본 그대로는 못 찾을 때를 위한
      // 공백-무시 정규식 폴백. 그래도 못 찾으면 안전하게 전체를 덮어쓴다.
      const escaped = original.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
      let re = null;
      try { re = new RegExp(escaped); } catch { re = null; }
      if (re && re.test(full)) {
        elm.textContent = full.replace(re, revised);
        return true;
      }
      if (normalizeSpace(full) === targetNorm) {
        elm.textContent = revised;
        return true;
      }
      return false;
    }

    const el = findTarget();
    if (!el) {
      try {
        window.__ZETA_UNC_LAST_DEBUG__ = { shadowRoots: collectShadowRoots().length - 1, targetPreview: targetNorm.slice(0, 40) };
      } catch {}
      return false;
    }
    const ok = applyToElement(el);
    if (!ok) return false;
    // 일부 프레임워크(React 등)가 다음 렌더에서 원문으로 되돌리는 경우가 있어 한 번 더 확인.
    setTimeout(() => {
      const again = findTarget();
      if (again && (again.textContent || "").includes(original)) applyToElement(again);
    }, 240);
    return true;
  }

  // ==========================================================
  // 5. 교정 파이프라인 (요청 감시 → 완성 답변 캡처 → AI 호출 → 적용)
  // ==========================================================

  const processedKeys = new Set();

  function toast(message, isError) {
    showToast(message, isError);
  }

  function getDebug(roomId) {
    const v = localStorage.getItem("zeta-unc-debug-" + roomId);
    return v === null ? true : v === "1"; // 기본 ON: 처음엔 진단이 우선
  }

  async function handleCompletedReply(url, userText, responseText) {
    const roomId = roomIdFromUrl(url);
    if (!roomId) return;
    const debug = getDebug(roomId);
    if (!getEnabled(roomId)) { if (debug) toast("🔕 이 방은 노트 반영이 꺼져있음", false); return; }

    const envelope = extractReplyEnvelope(responseText);
    if (!envelope.text) { if (debug) toast("⚠ 스트림 응답에서 답변 텍스트를 못 뽑음 (파싱 실패 가능성)", true); return; }

    const key = [roomId, envelope.messageId, envelope.candidateId, envelope.text.slice(0, 60)].join("|");
    if (processedKeys.has(key)) { if (debug) toast("↩ 이미 처리한 답변이라 건너뜀", false); return; }
    processedKeys.add(key);
    if (processedKeys.size > 300) {
      const it = processedKeys.values();
      for (let i = 0; i < 100; i++) processedKeys.delete(it.next().value);
    }

    const note = normalizeSpace(getNote(roomId));
    if (!note) { if (debug) toast("📝 유저노트가 비어있어 건너뜀", false); return; }

    const preset = getActivePreset(roomId);
    if (!preset) { toast("❌ 사용할 API 프리셋이 없습니다.", true); return; }

    if (debug) toast("⏳ 답변 캡처됨 (" + envelope.text.length + "자) → AI에 대조 요청 중...", false);

    // React 등의 렌더링이 안정될 시간을 살짝 준다.
    await new Promise((r) => setTimeout(r, 250));

    try {
      const { system, user } = buildCorrectionPrompt(note, userText, envelope.text);
      const raw = await callAI(preset, system, user);
      const parsed = parseModelJson(raw);
      if (!parsed || !Array.isArray(parsed.conflicts)) {
        if (debug) toast("⚠ AI 응답을 JSON으로 못 읽음. 원문 앞부분: " + String(raw || "").slice(0, 150), true);
        return;
      }
      if (!parsed.conflicts.length) { if (debug) toast("✅ 대조 완료 — 노트와 모순되는 부분 없음", false); return; }

      const { result, applied, skipped } = applyConflicts(envelope.text, parsed.conflicts);
      if (!applied.length) {
        const reasons = skipped.map((s) => (s.find || "").slice(0, 20) + "→" + s.why).join(" / ");
        if (debug) toast("⚠ AI가 " + skipped.length + "건 제안했지만 전부 안전상 폐기됨: " + reasons, true);
        return;
      }
      const patched = patchVisibleReply(envelope.text, result, envelope.messageId, envelope.candidateId);
      if (patched) {
        toast("✅ 유저노트 기준으로 " + applied.length + "곳 수정함", false);
      } else if (debug) {
        const dbg = window.__ZETA_UNC_LAST_DEBUG__ || {};
        toast("⚠ 수정은 계산됐지만 화면 요소를 못 찾음 (shadowRoots:" + (dbg.shadowRoots != null ? dbg.shadowRoots : "?") + ")", true);
      }
    } catch (err) {
      toast("❌ 유저노트 교정 실패: " + (err && err.message || err), true);
    }
  }

  // ---- fetch / XHR 후킹 : 제타의 스트리밍 응답 엔드포인트만 감시한다 ----

  const originalFetch = window.fetch.bind(window);

  window.fetch = async function (input, init) {
    const url = typeof input === "string" ? input : (input instanceof URL ? input.href : (input && input.url) || "");
    const method = String((init && init.method) || (input && input.method) || "GET").toUpperCase();
    const isStream = isStreamEndpoint(url, method);
    let userText = "";
    if (isStream) {
      try {
        let bodyStr = "";
        if (init && typeof init.body === "string") bodyStr = init.body;
        else if (typeof Request !== "undefined" && input instanceof Request) bodyStr = await input.clone().text().catch(() => "");
        userText = userTextFromRequestBody(bodyStr);
      } catch {}
    }
    const response = await originalFetch(input, init);
    if (isStream) {
      response.clone().text().then((text) => handleCompletedReply(url, userText, text)).catch(() => {});
    }
    return response;
  };

  const OrigXHR = window.XMLHttpRequest;
  const origOpen = OrigXHR.prototype.open;
  const origSend = OrigXHR.prototype.send;

  OrigXHR.prototype.open = function (method, url, ...rest) {
    this.__uncMethod = String(method || "GET").toUpperCase();
    this.__uncUrl = url;
    return origOpen.call(this, method, url, ...rest);
  };

  OrigXHR.prototype.send = function (body) {
    if (isStreamEndpoint(this.__uncUrl, this.__uncMethod)) {
      const userText = userTextFromRequestBody(requestBodyText(body));
      this.addEventListener("loadend", function (event) {
        const req = event.currentTarget;
        if (!req || req.status < 200 || req.status >= 300) return;
        let text = "";
        try { text = String(req.responseText || ""); } catch {}
        handleCompletedReply(this.__uncUrl, userText, text);
      });
    }
    return origSend.call(this, body);
  };

  // ==========================================================
  // 6. UI (Shadow DOM으로 완전히 격리된 플로팅 버튼 + 패널)
  // ==========================================================

  const HOST_ID = "zeta-unc-host";
  const POS_KEY = "zeta-unc-pos";

  function getPos() {
    return safeJsonParse(localStorage.getItem(POS_KEY), null) || { left: 16, bottom: 80 };
  }
  function savePos(pos) {
    localStorage.setItem(POS_KEY, JSON.stringify(pos));
  }

  let roomId = currentRoomId();

  const host = document.createElement("div");
  host.id = HOST_ID;
  document.documentElement.appendChild(host);
  const root = host.attachShadow({ mode: "open" });

  root.innerHTML = `
<style>
  :host { all: initial; position: fixed !important; top: 0; left: 0; z-index: 2147483647 !important; }
  * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }

  #btn {
    position: fixed; width: 32px; height: 32px; border-radius: 50%;
    background: #5d8fff; color: #fff;
    display: flex; align-items: center; justify-content: center;
    cursor: pointer; box-shadow: 0 3px 12px rgba(0,0,0,.5); border: 2px solid #fff;
    touch-action: none; user-select: none; -webkit-user-select: none; -webkit-touch-callout: none;
  }
  #btn svg { width: 15px; height: 15px; pointer-events: none; }
  #btn.dragging { opacity: 0.7; }
  #btn .dot { position: absolute; top: -2px; right: -2px; width: 8px; height: 8px; border-radius: 50%; border: 1.5px solid #17171c; display: none; }
  #btn.ready .dot { display: block; background: #7CFC9C; }
  #btn.no-api .dot { display: block; background: #ffb347; }

  #panel {
    position: fixed; width: 300px; max-height: 74vh; overflow-y: auto;
    background: #17171c; color: #fff; border: 1px solid #5d8fff; border-radius: 12px;
    padding: 12px; font-size: 12px; line-height: 1.5; box-shadow: 0 6px 24px rgba(0,0,0,.6);
    display: none;
  }
  #panel.open { display: block; }

  .title { font-weight: bold; font-size: 13px; margin-bottom: 8px; display: flex; justify-content: space-between; align-items: center; }
  .room { color: #999; font-size: 10px; margin-bottom: 8px; word-break: break-all; }

  .tabs { display: flex; gap: 6px; margin-bottom: 10px; }
  .tab { flex: 1; text-align: center; padding: 6px 4px; border-radius: 8px; background: #222; cursor: pointer; font-size: 11px; }
  .tab.active { background: #5d8fff; }
  .tabpanel { display: none; }
  .tabpanel.active { display: block; }

  textarea, input, select {
    width: 100%; background: #0d0d10; color: #fff; border: 1px solid #444; border-radius: 8px;
    padding: 8px; font-size: 12px; margin-top: 4px;
  }
  textarea { height: 30vh; resize: vertical; }
  label { display: block; font-size: 11px; color: #ccc; margin-top: 8px; }
  .row { display: flex; gap: 6px; margin-top: 8px; align-items: center; }
  .row.check { align-items: center; gap: 6px; }
  button { background: #333; color: #fff; border: none; border-radius: 8px; padding: 7px 6px; font-size: 11px; cursor: pointer; flex: 1; }
  button.primary { background: #5d8fff; }
  button.danger { background: #6b2f2f; }
  .count { color: #999; font-size: 10px; text-align: right; margin-top: 4px; }
  .saved-badge { color: #7CFC9C; font-size: 10px; opacity: 0; transition: opacity .3s; white-space: nowrap; }
  .saved-badge.show { opacity: 1; }
  .status { font-size: 10px; color: #ccc; background: #0d0d10; border: 1px solid #333; border-radius: 8px; padding: 6px 8px; margin-top: 8px; word-break: break-all; }
  .status.ok { border-color: #2f6b3f; color: #7CFC9C; }
  .status.bad { border-color: #6b4a2f; color: #ffb347; }
  hr { border: none; border-top: 1px solid #333; margin: 10px 0; }
  #baseUrlWrap.hidden { display: none; }
</style>

<div id="btn"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg><span class="dot"></span></div>

<div id="panel">
  <div class="title"><span>User Note Corrector</span><span style="font-weight:normal;font-size:10px;color:#999;">v${VERSION}</span></div>
  <div class="room" id="room"></div>

  <div class="tabs">
    <div class="tab active" data-tab="note">노트</div>
    <div class="tab" data-tab="api">API 설정</div>
  </div>

  <div class="tabpanel active" data-panel="note">
    <div class="row check">
      <input type="checkbox" id="enabled" style="width:auto;margin:0;">
      <label style="margin:0;">이 방에서 노트 반영 사용</label>
    </div>
    <textarea id="note" placeholder="예) {{user}}의 생일은 5월 5일이다.&#10;어제 저녁 메뉴로 싸운 뒤 아직 화해 안 함, 서먹함.&#10;&#10;- 명백히 모순되는 답변만 고쳐집니다.&#10;- 글자수 제한 없음."></textarea>
    <div class="count" id="count">0자</div>
    <div class="row">
      <button class="primary" id="saveNote">저장</button>
      <span class="saved-badge" id="saved">저장됨</span>
    </div>
  </div>

  <div class="tabpanel" data-panel="api">
    <label>이 방에서 사용할 프리셋
      <select id="presetSelect"></select>
    </label>
    <div class="row">
      <button id="newPreset">새 프리셋</button>
      <button class="danger" id="deletePreset">삭제</button>
    </div>
    <label>프리셋 이름 <input id="presetName" type="text" placeholder="예: 기본 Gemini"></label>
    <label>AI 제공사
      <select id="provider">
        <option value="gemini">Gemini</option>
        <option value="openai">OpenAI</option>
        <option value="anthropic">Claude</option>
        <option value="compatible">OpenAI 호환 API</option>
      </select>
    </label>
    <label>API 키 <input id="apiKey" type="password" autocomplete="off" placeholder="사용자 본인의 API 키"></label>
    <label>모델 <input id="model" type="text" placeholder="예: gemini-2.5-flash"></label>
    <label id="baseUrlWrap" class="hidden">호환 API 기본 주소 <input id="baseUrl" type="url" placeholder="https://example.com/v1"></label>
    <div class="row">
      <button class="primary" id="savePreset">프리셋 저장</button>
    </div>
    <div class="row">
      <button id="testPreset">연결 테스트</button>
    </div>
    <div class="status" id="apiStatus">아직 테스트 안 함</div>
  </div>

  <hr>
  <div class="row"><button id="resetPos">버튼 위치 초기화</button></div>
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
  const presetSelectEl = el("presetSelect");
  const presetNameEl = el("presetName");
  const providerEl = el("provider");
  const apiKeyEl = el("apiKey");
  const modelEl = el("model");
  const baseUrlWrapEl = el("baseUrlWrap");
  const baseUrlEl = el("baseUrl");
  const apiStatusEl = el("apiStatus");

  const BTN_SIZE = 32, BTN_MARGIN = 4;

  function applyPos(pos) {
    btnEl.style.left = pos.left + "px"; btnEl.style.bottom = pos.bottom + "px";
    panelEl.style.left = pos.left + "px"; panelEl.style.bottom = (pos.bottom + BTN_SIZE + 10) + "px";
  }
  applyPos(getPos());

  function flashSaved(text) {
    savedEl.textContent = text || "저장됨";
    savedEl.classList.add("show");
    clearTimeout(flashSaved._t);
    flashSaved._t = setTimeout(() => savedEl.classList.remove("show"), 1600);
  }

  // ---- 토스트 (패널 밖에서도 보이는 간단한 알림) ----
  const toastEl = document.createElement("div");
  toastEl.style.cssText = "position:fixed;left:8px;right:8px;bottom:8px;background:#000;color:#7CFC9C;font-family:monospace;font-size:10px;line-height:1.4;padding:8px 10px;border-radius:8px;border:1px solid #5d8fff;opacity:0;pointer-events:none;transition:opacity .3s;white-space:pre-wrap;word-break:break-all;z-index:2147483647;";
  root.appendChild(toastEl);
  function showToast(message, isError) {
    toastEl.style.color = isError ? "#ffb347" : "#7CFC9C";
    toastEl.textContent = String(message || "");
    toastEl.style.opacity = "0.95";
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => { toastEl.style.opacity = "0"; }, 5000);
  }

  // ---- 탭 전환 ----
  root.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      root.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
      root.querySelectorAll(".tabpanel").forEach((p) => p.classList.remove("active"));
      tab.classList.add("active");
      root.querySelector('.tabpanel[data-panel="' + tab.dataset.tab + '"]').classList.add("active");
    });
  });

  // ---- 노트 탭 ----
  function updateCount() { countEl.textContent = noteEl.value.length.toLocaleString() + "자"; }

  function refreshRoomUI() {
    roomEl.textContent = "Room: " + (roomId ? roomId.slice(0, 24) : "(감지 안 됨)");
    noteEl.value = getNote(roomId);
    enabledEl.checked = getEnabled(roomId);
    updateCount();
    refreshPresetUI();
  }

  noteEl.addEventListener("input", () => { updateCount(); });
  el("saveNote").addEventListener("click", () => {
    saveNote(roomId, noteEl.value);
    flashSaved("저장됨");
  });
  enabledEl.addEventListener("change", () => setEnabled(roomId, enabledEl.checked));

  // ---- API 탭 ----
  function refreshPresetUI() {
    const list = getPresets();
    const activeId = getActivePresetId(roomId) || (list[0] && list[0].id) || "";
    presetSelectEl.innerHTML = "";
    list.forEach((p) => {
      const opt = document.createElement("option");
      opt.value = p.id; opt.textContent = p.name || "(이름 없음)";
      presetSelectEl.appendChild(opt);
    });
    if (!list.length) {
      const opt = document.createElement("option");
      opt.value = ""; opt.textContent = "(프리셋 없음 — 새 프리셋을 만드세요)";
      presetSelectEl.appendChild(opt);
    }
    presetSelectEl.value = activeId;
    loadPresetIntoForm(list.find((p) => p.id === activeId) || null);
    btnEl.classList.toggle("no-api", !getActivePreset(roomId));
    btnEl.classList.toggle("ready", !!getActivePreset(roomId));
  }

  function loadPresetIntoForm(preset) {
    presetNameEl.value = preset ? preset.name || "" : "";
    providerEl.value = preset ? preset.provider || "gemini" : "gemini";
    apiKeyEl.value = preset ? preset.apiKey || "" : "";
    modelEl.value = preset ? preset.model || "" : "";
    baseUrlEl.value = preset ? preset.baseUrl || "" : "";
    baseUrlWrapEl.classList.toggle("hidden", providerEl.value !== "compatible");
    apiStatusEl.className = "status";
    apiStatusEl.textContent = "아직 테스트 안 함";
  }

  providerEl.addEventListener("change", () => {
    baseUrlWrapEl.classList.toggle("hidden", providerEl.value !== "compatible");
  });

  presetSelectEl.addEventListener("change", () => {
    setActivePresetId(roomId, presetSelectEl.value);
    const preset = getPresets().find((p) => p.id === presetSelectEl.value) || null;
    loadPresetIntoForm(preset);
  });

  el("newPreset").addEventListener("click", () => {
    const list = getPresets();
    const preset = { id: uuid(), name: "새 프리셋", provider: "gemini", apiKey: "", model: "", baseUrl: "" };
    list.push(preset);
    savePresets(list);
    setActivePresetId(roomId, preset.id);
    refreshPresetUI();
  });

  el("deletePreset").addEventListener("click", () => {
    const id = presetSelectEl.value;
    if (!id) return;
    if (!confirm("이 프리셋을 삭제할까요? (API 키 포함)")) return;
    const list = getPresets().filter((p) => p.id !== id);
    savePresets(list);
    if (getActivePresetId(roomId) === id) setActivePresetId(roomId, (list[0] && list[0].id) || "");
    refreshPresetUI();
  });

  el("savePreset").addEventListener("click", () => {
    const list = getPresets();
    let id = presetSelectEl.value;
    let preset = list.find((p) => p.id === id);
    if (!preset) {
      preset = { id: uuid() };
      list.push(preset);
      id = preset.id;
    }
    preset.name = presetNameEl.value.trim() || "이름 없음";
    preset.provider = providerEl.value;
    preset.apiKey = apiKeyEl.value.trim();
    preset.model = modelEl.value.trim();
    preset.baseUrl = baseUrlEl.value.trim();
    savePresets(list);
    setActivePresetId(roomId, id);
    refreshPresetUI();
    flashSaved("프리셋 저장됨");
  });

  el("testPreset").addEventListener("click", async () => {
    const preset = {
      provider: providerEl.value,
      apiKey: apiKeyEl.value.trim(),
      model: modelEl.value.trim(),
      baseUrl: baseUrlEl.value.trim()
    };
    apiStatusEl.className = "status";
    apiStatusEl.textContent = "테스트 중...";
    try {
      const reply = await testPreset(preset);
      apiStatusEl.className = "status ok";
      apiStatusEl.textContent = "✅ 연결 성공: " + reply;
    } catch (err) {
      apiStatusEl.className = "status bad";
      apiStatusEl.textContent = "❌ 실패: " + (err && err.message || err);
    }
  });

  el("resetPos").addEventListener("click", () => {
    const defaultPos = { left: 16, bottom: 80 };
    savePos(defaultPos);
    applyPos(defaultPos);
    flashSaved("위치 초기화됨");
  });

  refreshRoomUI();

  // ---- 드래그 vs 클릭 구분, 패널 열기/닫기 ----
  let dragging = false, moved = false, startX = 0, startY = 0, startPos = null;

  function pointFromEvent(e) {
    if (e.touches && e.touches[0]) return { x: e.touches[0].clientX, y: e.touches[0].clientY };
    return { x: e.clientX, y: e.clientY };
  }
  function onDragStart(e) { dragging = true; moved = false; const p = pointFromEvent(e); startX = p.x; startY = p.y; startPos = getPos(); btnEl.classList.add("dragging"); }
  function onDragMove(e) {
    if (!dragging) return;
    const p = pointFromEvent(e);
    const dx = p.x - startX, dy = p.y - startY;
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
    if (moved) savePos({ left: parseFloat(btnEl.style.left) || 16, bottom: parseFloat(btnEl.style.bottom) || 80 });
    else setPanelOpen(!panelEl.classList.contains("open"));
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

  // ---- 방 이동 감지 (SPA 라우팅 대응) ----
  setInterval(() => {
    const id = currentRoomId();
    if (id !== roomId) { roomId = id; if (panelEl.classList.contains("open")) refreshRoomUI(); }
  }, 1000);

  console.log(`📝 Zeta UserNote Corrector v${VERSION} Ready`);
})();

// @description  유저노트(글자수 제한 없음)를 별도 저장해두고, 제타가 노트 내용과 명백히 모순되는 답변을 낼 때만 그 부분만 find/replace로 고친다. 로어북/장기기억/페르소나는 건드리지 않고, 원본 문체·나머지 내용은 그대로 유지한다.
// @match        https://zeta-ai.io/*
// @match        https://*.zeta-ai.io/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(() => {
  "use strict";

  if (window.__ZETA_USERNOTE_CORRECTOR_RUNNING__) {
    console.log("📝 Zeta UserNote Corrector already running.");
    return;
  }
  window.__ZETA_USERNOTE_CORRECTOR_RUNNING__ = true;

  const VERSION = "1.0.1";

  // ==========================================================
  // 0. 아주 작은 유틸
  // ==========================================================

  function safeJsonParse(value, fallback) {
    try { return JSON.parse(value); } catch { return fallback; }
  }

  function normalizeSpace(value) {
    return String(value == null ? "" : value).replace(/\s+/g, " ").trim();
  }

  function uuid() {
    if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
    return "un_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 10);
  }

  function parseModelJson(text) {
    const raw = String(text || "").trim();
    const direct = safeJsonParse(raw, null);
    if (direct && typeof direct === "object") return direct;
    const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) {
      const fenced = safeJsonParse(fence[1].trim(), null);
      if (fenced && typeof fenced === "object") return fenced;
    }
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start !== -1 && end !== -1 && end > start) {
      const sliced = safeJsonParse(raw.slice(start, end + 1), null);
      if (sliced && typeof sliced === "object") return sliced;
    }
    return null;
  }

  // ---- 제타 스트리밍 응답(SSE) 파싱 : ZETA Memory Bridge core.js 로직을 축약 이식 ----

  function parseSse(text) {
    const source = String(text || "");
    const events = [];
    if (!source.trim()) return events;
    const blocks = source.split(/\r?\n\r?\n/);
    blocks.forEach((block) => {
      const dataLines = [];
      block.split(/\r?\n/).forEach((line) => {
        if (/^data:/i.test(line)) dataLines.push(line.replace(/^data:\s?/i, ""));
        else if (line.trim().charAt(0) === "{" || line.trim().charAt(0) === "[") dataLines.push(line.trim());
      });
      if (!dataLines.length) return;
      const joined = dataLines.join("\n").trim();
      if (!joined || joined === "[DONE]") return;
      const parsed = safeJsonParse(joined, null);
      if (parsed != null) events.push(parsed);
    });
    if (!events.length) {
      source.split(/\r?\n/).forEach((line) => {
        const trimmed = line.trim().replace(/^data:\s?/i, "");
        if (!trimmed || trimmed === "[DONE]") return;
        const parsed = safeJsonParse(trimmed, null);
        if (parsed != null) events.push(parsed);
      });
    }
    if (!events.length) {
      const whole = safeJsonParse(source, null);
      if (whole != null) events.push(whole);
    }
    return events;
  }

  function walk(value, path, visit) {
    path = path || "";
    if (value == null) return;
    visit(value, path);
    if (Array.isArray(value)) {
      value.forEach((item, i) => walk(item, path + "[" + i + "]", visit));
    } else if (typeof value === "object") {
      Object.keys(value).forEach((key) => walk(value[key], path ? path + "." + key : key, visit));
    }
  }

  function pickLongest(values) {
    return values.filter((v) => typeof v === "string" && v.trim())
      .sort((a, b) => b.length - a.length)[0] || "";
  }

  // 제타 스트리밍 응답 전체(SSE)에서: 완성된 답변 텍스트 + messageId + candidateId를 뽑아낸다.
  function extractReplyEnvelope(responseText) {
    const events = parseSse(responseText);
    const trueDeltas = [];
    const cumulative = [];
    const finals = [];
    const ids = { requestId: "", messageId: "", candidateId: "" };
    const uuidish = [];
    let completeText = "";

    events.forEach((event) => {
      if (event && typeof event === "object" && String(event.event || "").toUpperCase() === "CHAT_COMPLETE" && event.replyMessage) {
        const reply = event.replyMessage;
        if (reply.id) ids.messageId = String(reply.id);
        if (reply.candidateId) ids.candidateId = String(reply.candidateId);
        if (event.requestId) ids.requestId = String(event.requestId);
        if (Array.isArray(reply.contents)) {
          completeText = reply.contents.map((c) => String((c && c.text) || "")).filter(Boolean).join("\n").trim();
        }
      }
      walk(event, "", (value, path) => {
        const lower = path.toLowerCase();
        const key = lower.split(".").pop().replace(/\[\d+\]$/, "");
        if (typeof value === "string") {
          const str = value;
          if (/(^|\.)(requestid|request_id)$/.test(lower)) ids.requestId = ids.requestId || str;
          if (/(^|\.)(messageid|message_id)$/.test(lower)) ids.messageId = ids.messageId || str;
          if (/(^|\.)(candidateid|candidate_id)$/.test(lower)) ids.candidateId = ids.candidateId || str;
          if (/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(str)) uuidish.push({ path: lower, value: str });
          if (/(^|\.)(delta|token)$/.test(lower) && !/(id|type|model|reason|status)/.test(lower)) {
            if (str.length < 200000) trueDeltas.push(str);
          } else if (/chunkmessage.*(?:content|text)/.test(lower)) {
            if (str.length < 200000) cumulative.push(str);
          } else if (/(content|text|answer|response|result|completion)/.test(lower) &&
            !/(id|type|model|reason|status|url|name|request)/.test(lower)) {
            if (str.length < 200000) finals.push(str);
          }
          if (key === "id") {
            if (/replymessage/.test(lower) && !ids.messageId) ids.messageId = str;
            else if (/candidate/.test(lower) && !ids.candidateId) ids.candidateId = str;
            else if (/message/.test(lower) && !ids.messageId) ids.messageId = str;
          }
        }
      });
    });

    if (!ids.requestId) { const rq = uuidish.find((x) => /request/.test(x.path)); if (rq) ids.requestId = rq.value; }
    if (!ids.messageId) { const mi = uuidish.find((x) => /message/.test(x.path) && !/request/.test(x.path)); if (mi) ids.messageId = mi.value; }
    if (!ids.candidateId) { const ci = uuidish.find((x) => /candidate/.test(x.path)); if (ci) ids.candidateId = ci.value; }

    let text = completeText;
    if (!text && trueDeltas.length) { const joined = trueDeltas.join(""); if (joined.trim().length > 2) text = joined.trim(); }
    if (!text && cumulative.length) text = pickLongest(cumulative).trim();
    if (!text) text = pickLongest(finals).trim();

    return { text, requestId: ids.requestId, messageId: ids.messageId, candidateId: ids.candidateId };
  }

  function isStreamEndpoint(url, method) {
    try {
      const target = new URL(String(url || ""), location.href);
      return target.hostname === "api.zeta-ai.io" &&
        String(method || "").toUpperCase() === "POST" &&
        /^\/v1\/rooms\/[^/]+\/messages\/stream\/?$/i.test(target.pathname);
    } catch { return false; }
  }

  function roomIdFromUrl(url) {
    const m = String(url || "").match(/\/v1\/rooms\/([^/]+)\/messages\/stream/i);
    if (m) return decodeURIComponent(m[1]);
    return currentRoomId();
  }

  function currentRoomId() {
    const m = String(location.pathname || "").match(/\/rooms\/([^/?#]+)/i);
    return m ? decodeURIComponent(m[1]) : "";
  }

  function requestBodyText(body) {
    if (typeof body === "string") return body;
    return "";
  }

  function userTextFromRequestBody(bodyStr) {
    const parsed = safeJsonParse(bodyStr, null);
    if (!parsed || typeof parsed !== "object") return "";
    if (typeof parsed.text === "string") return parsed.text;
    if (typeof parsed.content === "string") return parsed.content;
    return "";
  }

  // ==========================================================
  // 1. 저장소 (localStorage) - 노트 / API 프리셋
  // ==========================================================

  const LS_NOTE_PREFIX = "zeta-unc-note-";
  const LS_PRESETS_KEY = "zeta-unc-api-presets";
  const LS_ACTIVE_PRESET_PREFIX = "zeta-unc-active-preset-";
  const LS_ENABLED_PREFIX = "zeta-unc-enabled-"; // 방별 on/off

  function getNote(roomId) {
    return localStorage.getItem(LS_NOTE_PREFIX + roomId) || "";
  }
  function saveNote(roomId, text) {
    localStorage.setItem(LS_NOTE_PREFIX + roomId, text || "");
  }

  function getEnabled(roomId) {
    const v = localStorage.getItem(LS_ENABLED_PREFIX + roomId);
    return v === null ? true : v === "1";
  }
  function setEnabled(roomId, on) {
    localStorage.setItem(LS_ENABLED_PREFIX + roomId, on ? "1" : "0");
  }

  function getPresets() {
    return safeJsonParse(localStorage.getItem(LS_PRESETS_KEY), []) || [];
  }
  function savePresets(list) {
    localStorage.setItem(LS_PRESETS_KEY, JSON.stringify(list || []));
  }
  function getActivePresetId(roomId) {
    return localStorage.getItem(LS_ACTIVE_PRESET_PREFIX + roomId) || "";
  }
  function setActivePresetId(roomId, id) {
    localStorage.setItem(LS_ACTIVE_PRESET_PREFIX + roomId, id || "");
  }
  function getActivePreset(roomId) {
    const list = getPresets();
    const id = getActivePresetId(roomId);
    return list.find((p) => p.id === id) || list[0] || null;
  }

  // ==========================================================
  // 2. AI 호출 (Gemini / OpenAI / Anthropic / OpenAI 호환)
  // ==========================================================

  async function callAI(preset, systemPrompt, userPrompt) {
    if (!preset) throw new Error("사용할 API 프리셋이 없습니다.");
    const provider = String(preset.provider || "").toLowerCase();
    const apiKey = String(preset.apiKey || "").trim();
    const model = String(preset.model || "").trim();
    if (!apiKey) throw new Error("API 키가 없습니다.");
    if (!model) throw new Error("모델 이름이 없습니다.");

    if (provider === "gemini") {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          systemInstruction: { role: "system", parts: [{ text: systemPrompt }] },
          contents: [{ role: "user", parts: [{ text: userPrompt }] }],
          generationConfig: { temperature: 0, maxOutputTokens: 2048 }
        })
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error("Gemini 오류 (" + res.status + "): " + (data && data.error && data.error.message || res.statusText));
      const parts = data && data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts;
      const text = Array.isArray(parts) ? parts.map((p) => p.text || "").join("") : "";
      if (!text) throw new Error("Gemini 응답에서 텍스트를 찾지 못했습니다.");
      return text;
    }

    if (provider === "openai" || provider === "compatible") {
      let endpoint = "https://api.openai.com/v1/chat/completions";
      if (provider === "compatible") {
        const raw = String(preset.baseUrl || "").trim();
        if (!raw) throw new Error("호환 API 기본 주소가 없습니다.");
        let u;
        try { u = new URL(raw); } catch { throw new Error("호환 API 기본 주소 형식이 올바르지 않습니다."); }
        u.hash = ""; u.search = "";
        u.pathname = u.pathname.replace(/\/+$/, "");
        // 사용자가 이미 .../chat/completions까지 포함한 전체 엔드포인트를 붙여넣은 경우 중복으로 붙이지 않는다.
        if (!/\/chat\/completions$/i.test(u.pathname)) u.pathname += "/chat/completions";
        endpoint = u.toString();
      }
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": "Bearer " + apiKey },
        body: JSON.stringify({
          model,
          temperature: 0,
          messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userPrompt }]
        })
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error("API 오류 (" + res.status + "): " + (data && data.error && data.error.message || res.statusText));
      const text = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
      if (!text) throw new Error("응답에서 텍스트를 찾지 못했습니다.");
      return text;
    }

    if (provider === "anthropic") {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "anthropic-dangerous-direct-browser-access": "true"
        },
        body: JSON.stringify({
          model,
          max_tokens: 2048,
          temperature: 0,
          system: systemPrompt,
          messages: [{ role: "user", content: userPrompt }]
        })
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error("Claude 오류 (" + res.status + "): " + (data && data.error && data.error.message || res.statusText));
      const text = data && Array.isArray(data.content) ? data.content.map((c) => c.text || "").join("") : "";
      if (!text) throw new Error("Claude 응답에서 텍스트를 찾지 못했습니다.");
      return text;
    }

    throw new Error("지원하지 않는 AI 제공사입니다: " + provider);
  }

  async function testPreset(preset) {
    const text = await callAI(preset, "짧게 한 단어로만 답하라.", "테스트: '정상'이라고만 답해줘.");
    return normalizeSpace(text).slice(0, 30);
  }

  // ==========================================================
  // 3. 프롬프트 구성 (find/replace conflict 방식)
  // ==========================================================

  function buildCorrectionPrompt(note, userText, originalReply) {
    const system = [
      "당신은 대화 로그 검수자다. 아래 [유저노트]에 적힌 확정 사실·현재 상태와, [제타 원본 답변]을 대조한다.",
      "임무는 명백히 모순되는 부분만 찾아서 고치는 것이지, 전체를 다시 쓰는 것이 아니다.",
      "",
      "규칙:",
      "1. 원본 답변에 유저노트와 실제로 모순되는 문장/구절이 있을 때만 손댄다.",
      "2. 유저노트가 다루지 않거나, 원본이 그 화제를 그냥 언급하지 않고 넘어가는 경우는 모순이 아니다. 아무것도 추가하지 않는다.",
      "3. 문체, 어투, 인칭, 문단 구성, 대사와 지문 배치, 상태창 등 형식은 절대 건드리지 않는다.",
      "4. find는 [제타 원본 답변]에 있는 문자열을 한 글자도 틀리지 않고 그대로 옮겨 적어야 한다 (요약·의역 금지).",
      "5. find는 원본 안에서 유일하게 특정되어야 한다. 같은 문구가 반복되는 곳이면 앞뒤 맥락을 포함해 더 길게 잡는다.",
      "6. replace는 모순만 해소하도록 최소한으로 고친 문장이며, 원본의 문체와 어울려야 한다.",
      "7. 모순이 없으면 conflicts를 빈 배열로 반환한다.",
      "8. 반드시 아래 JSON 형식 하나만 반환한다. 다른 설명이나 사과를 덧붙이지 않는다.",
      "",
      '{"conflicts":[{"find":"원본 그대로의 문자열","replace":"고친 문자열","reason":"어떤 노트 내용과 왜 모순인지"}]}'
    ].join("\n");

    const user = [
      "[유저노트]",
      note,
      "",
      "[이번 유저 메시지]",
      userText || "(없음)",
      "",
      "[제타 원본 답변]",
      originalReply
    ].join("\n");

    return { system, user };
  }

  // 원본에 find가 "정확히 1번만" 존재하는지 검증 후, 통과한 것만 순서대로 적용한다.
  // 이것이 "원본 유지 보장"의 핵심 안전장치다: 애매하면 그 edit은 통째로 버리고 원본을 그대로 둔다.
  function applyConflicts(original, conflicts) {
    let result = original;
    const applied = [];
    const skipped = [];
    (Array.isArray(conflicts) ? conflicts : []).forEach((c) => {
      const find = c && typeof c.find === "string" ? c.find : "";
      const replace = c && typeof c.replace === "string" ? c.replace : "";
      if (!find) { skipped.push({ ...c, why: "find 없음" }); return; }
      const occurrences = result.split(find).length - 1;
      if (occurrences !== 1) { skipped.push({ ...c, why: occurrences === 0 ? "원본에서 못 찾음" : "원본에 " + occurrences + "번 나와서 특정 불가" }); return; }
      result = result.replace(find, replace);
      applied.push(c);
    });
    return { result, applied, skipped };
  }

  // ==========================================================
  // 4. 화면에 보이는 답변 교체 (텍스트만 치환, DOM 구조는 안 건드림)
  // ==========================================================

  function patchVisibleReply(original, revised, messageId, candidateId) {
    const targetNorm = normalizeSpace(original);
    const revisedNorm = normalizeSpace(revised);
    if (!targetNorm || !revisedNorm || targetNorm === revisedNorm) return false;

    function escapeAttr(value) {
      if (window.CSS && typeof window.CSS.escape === "function") return window.CSS.escape(String(value || ""));
      return String(value || "").replace(/["\\]/g, "\\$&");
    }

    // 이전 버전에는 "자식 엘리먼트가 없는 leaf 노드만" 후보로 삼는 조건이 있었는데,
    // 지문(이탤릭)과 대사가 여러 자식 태그로 나뉘어 있는 답변에서는 그 조건 때문에
    // 텍스트 전체를 담은 요소도, 텍스트 일부만 담은 leaf 요소도 둘 다 targetNorm과
    // 정확히 일치하지 않아 아무것도 못 찾는 문제가 있었다. 그래서 "자식이 있어도 되고,
    // 대신 textContent가 정확히 일치하는 요소들 중 가장 좁게 감싸는 요소"를 고르는
    // 방식으로 바꿨다.
    function candidateElements(nodes) {
      const out = [];
      for (let i = 0; i < nodes.length; i++) {
        const el = nodes[i];
        if (!el || !el.isConnected) continue;
        if (el.id === HOST_ID || (el.closest && el.closest("#" + HOST_ID))) continue;
        if (el.isContentEditable || /^(SCRIPT|STYLE|TEXTAREA|INPUT|BUTTON)$/.test(el.tagName)) continue;
        out.push(el);
      }
      return out;
    }

    function pickTightestMatch(pool) {
      // 1순위: textContent가 답변 원문과 "정확히" 같은 요소 (가장 안전, 오탐 위험 없음)
      let matches = pool.filter((el) => normalizeSpace(el.textContent || "") === targetNorm);
      if (!matches.length) {
        // 2순위: 정확히 같은 요소가 없다면, 라벨("zeta" 표시, 타임스탬프 등)이 같은
        // 컨테이너 안에 섞여 들어가 있는 경우가 있다. 이때는 "답변 원문 전체를
        // 포함하고 있는" 요소들 중 가장 짧은(=가장 좁게 감싸는) 요소를 고른다.
        matches = pool.filter((el) => normalizeSpace(el.textContent || "").includes(targetNorm));
        if (!matches.length) return null;
        matches.sort((a, b) => normalizeSpace(a.textContent || "").length - normalizeSpace(b.textContent || "").length);
        return matches[0];
      }
      // 자손 엘리먼트 수가 가장 적은(=텍스트를 가장 좁게 감싸는) 요소를 고른다.
      // 여러 메시지를 통째로 감싼 큰 컨테이너가 잘못 선택되는 것을 막는다.
      matches.sort((a, b) => a.querySelectorAll("*").length - b.querySelectorAll("*").length);
      return matches[0];
    }

    function findTarget() {
      let roots = [];
      if (messageId || candidateId) {
        const selectors = [];
        if (messageId) selectors.push('[data-message-id="' + escapeAttr(messageId) + '"]', '[data-message-uuid="' + escapeAttr(messageId) + '"]');
        if (candidateId) selectors.push('[data-candidate-id="' + escapeAttr(candidateId) + '"]', '[data-candidate-uuid="' + escapeAttr(candidateId) + '"]');
        selectors.forEach((sel) => { try { roots = roots.concat(Array.from(document.querySelectorAll(sel))); } catch {} });
      }
      let pool = roots.length ? candidateElements(roots.flatMap((r) => (r.querySelectorAll ? Array.from(r.querySelectorAll("*")).concat([r]) : [r])))
        : [];
      let match = pickTightestMatch(pool);
      if (match) return match;

      const semantic = document.querySelectorAll('article,[role="article"],[role="listitem"],[data-message-id],[class*="message"],[class*="bubble"],p');
      const semanticPool = candidateElements(Array.from(semantic).slice(-200));
      match = pickTightestMatch(semanticPool);
      if (match) return match;

      const broad = candidateElements(Array.from(document.querySelectorAll("div,span,p,section,article,em,i,strong,b")).slice(-400));
      return pickTightestMatch(broad);
    }

    // 찾은 요소의 실제(raw) 텍스트 안에서 가능한 한 "원본 문자열 부분만" 바꾸고
    // 나머지(라벨, 타임스탬프 등)는 그대로 남긴다. 라벨이 섞여 있지 않고 요소
    // 전체가 답변 텍스트뿐이라면 결과적으로 전체 치환과 동일하다.
    function applyToElement(elm) {
      const full = elm.textContent || "";
      if (full.includes(original)) {
        elm.textContent = full.replace(original, revised);
        return true;
      }
      // 공백/줄바꿈 방식이 미묘하게 달라 원본 그대로는 못 찾을 때를 위한
      // 공백-무시 정규식 폴백. 그래도 못 찾으면 안전하게 전체를 덮어쓴다.
      const escaped = original.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
      let re = null;
      try { re = new RegExp(escaped); } catch { re = null; }
      if (re && re.test(full)) {
        elm.textContent = full.replace(re, revised);
        return true;
      }
      if (normalizeSpace(full) === targetNorm) {
        elm.textContent = revised;
        return true;
      }
      return false;
    }

    const el = findTarget();
    if (!el) return false;
    const ok = applyToElement(el);
    if (!ok) return false;
    // 일부 프레임워크(React 등)가 다음 렌더에서 원문으로 되돌리는 경우가 있어 한 번 더 확인.
    setTimeout(() => {
      const again = findTarget();
      if (again && (again.textContent || "").includes(original)) applyToElement(again);
    }, 240);
    return true;
  }

  // ==========================================================
  // 5. 교정 파이프라인 (요청 감시 → 완성 답변 캡처 → AI 호출 → 적용)
  // ==========================================================

  const processedKeys = new Set();

  function toast(message, isError) {
    showToast(message, isError);
  }

  function getDebug(roomId) {
    const v = localStorage.getItem("zeta-unc-debug-" + roomId);
    return v === null ? true : v === "1"; // 기본 ON: 처음엔 진단이 우선
  }

  async function handleCompletedReply(url, userText, responseText) {
    const roomId = roomIdFromUrl(url);
    if (!roomId) return;
    const debug = getDebug(roomId);
    if (!getEnabled(roomId)) { if (debug) toast("🔕 이 방은 노트 반영이 꺼져있음", false); return; }

    const envelope = extractReplyEnvelope(responseText);
    if (!envelope.text) { if (debug) toast("⚠ 스트림 응답에서 답변 텍스트를 못 뽑음 (파싱 실패 가능성)", true); return; }

    const key = [roomId, envelope.messageId, envelope.candidateId, envelope.text.slice(0, 60)].join("|");
    if (processedKeys.has(key)) { if (debug) toast("↩ 이미 처리한 답변이라 건너뜀", false); return; }
    processedKeys.add(key);
    if (processedKeys.size > 300) {
      const it = processedKeys.values();
      for (let i = 0; i < 100; i++) processedKeys.delete(it.next().value);
    }

    const note = normalizeSpace(getNote(roomId));
    if (!note) { if (debug) toast("📝 유저노트가 비어있어 건너뜀", false); return; }

    const preset = getActivePreset(roomId);
    if (!preset) { toast("❌ 사용할 API 프리셋이 없습니다.", true); return; }

    if (debug) toast("⏳ 답변 캡처됨 (" + envelope.text.length + "자) → AI에 대조 요청 중...", false);

    // React 등의 렌더링이 안정될 시간을 살짝 준다.
    await new Promise((r) => setTimeout(r, 250));

    try {
      const { system, user } = buildCorrectionPrompt(note, userText, envelope.text);
      const raw = await callAI(preset, system, user);
      const parsed = parseModelJson(raw);
      if (!parsed || !Array.isArray(parsed.conflicts)) {
        if (debug) toast("⚠ AI 응답을 JSON으로 못 읽음. 원문 앞부분: " + String(raw || "").slice(0, 150), true);
        return;
      }
      if (!parsed.conflicts.length) { if (debug) toast("✅ 대조 완료 — 노트와 모순되는 부분 없음", false); return; }

      const { result, applied, skipped } = applyConflicts(envelope.text, parsed.conflicts);
      if (!applied.length) {
        const reasons = skipped.map((s) => (s.find || "").slice(0, 20) + "→" + s.why).join(" / ");
        if (debug) toast("⚠ AI가 " + skipped.length + "건 제안했지만 전부 안전상 폐기됨: " + reasons, true);
        return;
      }
      const patched = patchVisibleReply(envelope.text, result, envelope.messageId, envelope.candidateId);
      if (patched) {
        toast("✅ 유저노트 기준으로 " + applied.length + "곳 수정함", false);
      } else if (debug) {
        toast("⚠ 수정은 계산됐지만 화면에서 해당 답변 요소를 못 찾아 표시 못 함", true);
      }
    } catch (err) {
      toast("❌ 유저노트 교정 실패: " + (err && err.message || err), true);
    }
  }

  // ---- fetch / XHR 후킹 : 제타의 스트리밍 응답 엔드포인트만 감시한다 ----

  const originalFetch = window.fetch.bind(window);

  window.fetch = async function (input, init) {
    const url = typeof input === "string" ? input : (input instanceof URL ? input.href : (input && input.url) || "");
    const method = String((init && init.method) || (input && input.method) || "GET").toUpperCase();
    const isStream = isStreamEndpoint(url, method);
    let userText = "";
    if (isStream) {
      try {
        let bodyStr = "";
        if (init && typeof init.body === "string") bodyStr = init.body;
        else if (typeof Request !== "undefined" && input instanceof Request) bodyStr = await input.clone().text().catch(() => "");
        userText = userTextFromRequestBody(bodyStr);
      } catch {}
    }
    const response = await originalFetch(input, init);
    if (isStream) {
      response.clone().text().then((text) => handleCompletedReply(url, userText, text)).catch(() => {});
    }
    return response;
  };

  const OrigXHR = window.XMLHttpRequest;
  const origOpen = OrigXHR.prototype.open;
  const origSend = OrigXHR.prototype.send;

  OrigXHR.prototype.open = function (method, url, ...rest) {
    this.__uncMethod = String(method || "GET").toUpperCase();
    this.__uncUrl = url;
    return origOpen.call(this, method, url, ...rest);
  };

  OrigXHR.prototype.send = function (body) {
    if (isStreamEndpoint(this.__uncUrl, this.__uncMethod)) {
      const userText = userTextFromRequestBody(requestBodyText(body));
      this.addEventListener("loadend", function (event) {
        const req = event.currentTarget;
        if (!req || req.status < 200 || req.status >= 300) return;
        let text = "";
        try { text = String(req.responseText || ""); } catch {}
        handleCompletedReply(this.__uncUrl, userText, text);
      });
    }
    return origSend.call(this, body);
  };

  // ==========================================================
  // 6. UI (Shadow DOM으로 완전히 격리된 플로팅 버튼 + 패널)
  // ==========================================================

  const HOST_ID = "zeta-unc-host";
  const POS_KEY = "zeta-unc-pos";

  function getPos() {
    return safeJsonParse(localStorage.getItem(POS_KEY), null) || { left: 16, bottom: 80 };
  }
  function savePos(pos) {
    localStorage.setItem(POS_KEY, JSON.stringify(pos));
  }

  let roomId = currentRoomId();

  const host = document.createElement("div");
  host.id = HOST_ID;
  document.documentElement.appendChild(host);
  const root = host.attachShadow({ mode: "open" });

  root.innerHTML = `
<style>
  :host { all: initial; position: fixed !important; top: 0; left: 0; z-index: 2147483647 !important; }
  * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }

  #btn {
    position: fixed; width: 32px; height: 32px; border-radius: 50%;
    background: #5d8fff; color: #fff;
    display: flex; align-items: center; justify-content: center;
    cursor: pointer; box-shadow: 0 3px 12px rgba(0,0,0,.5); border: 2px solid #fff;
    touch-action: none; user-select: none; -webkit-user-select: none; -webkit-touch-callout: none;
  }
  #btn svg { width: 15px; height: 15px; pointer-events: none; }
  #btn.dragging { opacity: 0.7; }
  #btn .dot { position: absolute; top: -2px; right: -2px; width: 8px; height: 8px; border-radius: 50%; border: 1.5px solid #17171c; display: none; }
  #btn.ready .dot { display: block; background: #7CFC9C; }
  #btn.no-api .dot { display: block; background: #ffb347; }

  #panel {
    position: fixed; width: 300px; max-height: 74vh; overflow-y: auto;
    background: #17171c; color: #fff; border: 1px solid #5d8fff; border-radius: 12px;
    padding: 12px; font-size: 12px; line-height: 1.5; box-shadow: 0 6px 24px rgba(0,0,0,.6);
    display: none;
  }
  #panel.open { display: block; }

  .title { font-weight: bold; font-size: 13px; margin-bottom: 8px; display: flex; justify-content: space-between; align-items: center; }
  .room { color: #999; font-size: 10px; margin-bottom: 8px; word-break: break-all; }

  .tabs { display: flex; gap: 6px; margin-bottom: 10px; }
  .tab { flex: 1; text-align: center; padding: 6px 4px; border-radius: 8px; background: #222; cursor: pointer; font-size: 11px; }
  .tab.active { background: #5d8fff; }
  .tabpanel { display: none; }
  .tabpanel.active { display: block; }

  textarea, input, select {
    width: 100%; background: #0d0d10; color: #fff; border: 1px solid #444; border-radius: 8px;
    padding: 8px; font-size: 12px; margin-top: 4px;
  }
  textarea { height: 30vh; resize: vertical; }
  label { display: block; font-size: 11px; color: #ccc; margin-top: 8px; }
  .row { display: flex; gap: 6px; margin-top: 8px; align-items: center; }
  .row.check { align-items: center; gap: 6px; }
  button { background: #333; color: #fff; border: none; border-radius: 8px; padding: 7px 6px; font-size: 11px; cursor: pointer; flex: 1; }
  button.primary { background: #5d8fff; }
  button.danger { background: #6b2f2f; }
  .count { color: #999; font-size: 10px; text-align: right; margin-top: 4px; }
  .saved-badge { color: #7CFC9C; font-size: 10px; opacity: 0; transition: opacity .3s; white-space: nowrap; }
  .saved-badge.show { opacity: 1; }
  .status { font-size: 10px; color: #ccc; background: #0d0d10; border: 1px solid #333; border-radius: 8px; padding: 6px 8px; margin-top: 8px; word-break: break-all; }
  .status.ok { border-color: #2f6b3f; color: #7CFC9C; }
  .status.bad { border-color: #6b4a2f; color: #ffb347; }
  hr { border: none; border-top: 1px solid #333; margin: 10px 0; }
  #baseUrlWrap.hidden { display: none; }
</style>

<div id="btn"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg><span class="dot"></span></div>

<div id="panel">
  <div class="title"><span>User Note Corrector</span><span style="font-weight:normal;font-size:10px;color:#999;">v${VERSION}</span></div>
  <div class="room" id="room"></div>

  <div class="tabs">
    <div class="tab active" data-tab="note">노트</div>
    <div class="tab" data-tab="api">API 설정</div>
  </div>

  <div class="tabpanel active" data-panel="note">
    <div class="row check">
      <input type="checkbox" id="enabled" style="width:auto;margin:0;">
      <label style="margin:0;">이 방에서 노트 반영 사용</label>
    </div>
    <textarea id="note" placeholder="예) {{user}}의 생일은 5월 5일이다.&#10;어제 저녁 메뉴로 싸운 뒤 아직 화해 안 함, 서먹함.&#10;&#10;- 명백히 모순되는 답변만 고쳐집니다.&#10;- 글자수 제한 없음."></textarea>
    <div class="count" id="count">0자</div>
    <div class="row">
      <button class="primary" id="saveNote">저장</button>
      <span class="saved-badge" id="saved">저장됨</span>
    </div>
  </div>

  <div class="tabpanel" data-panel="api">
    <label>이 방에서 사용할 프리셋
      <select id="presetSelect"></select>
    </label>
    <div class="row">
      <button id="newPreset">새 프리셋</button>
      <button class="danger" id="deletePreset">삭제</button>
    </div>
    <label>프리셋 이름 <input id="presetName" type="text" placeholder="예: 기본 Gemini"></label>
    <label>AI 제공사
      <select id="provider">
        <option value="gemini">Gemini</option>
        <option value="openai">OpenAI</option>
        <option value="anthropic">Claude</option>
        <option value="compatible">OpenAI 호환 API</option>
      </select>
    </label>
    <label>API 키 <input id="apiKey" type="password" autocomplete="off" placeholder="사용자 본인의 API 키"></label>
    <label>모델 <input id="model" type="text" placeholder="예: gemini-2.5-flash"></label>
    <label id="baseUrlWrap" class="hidden">호환 API 기본 주소 <input id="baseUrl" type="url" placeholder="https://example.com/v1"></label>
    <div class="row">
      <button class="primary" id="savePreset">프리셋 저장</button>
    </div>
    <div class="row">
      <button id="testPreset">연결 테스트</button>
    </div>
    <div class="status" id="apiStatus">아직 테스트 안 함</div>
  </div>

  <hr>
  <div class="row"><button id="resetPos">버튼 위치 초기화</button></div>
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
  const presetSelectEl = el("presetSelect");
  const presetNameEl = el("presetName");
  const providerEl = el("provider");
  const apiKeyEl = el("apiKey");
  const modelEl = el("model");
  const baseUrlWrapEl = el("baseUrlWrap");
  const baseUrlEl = el("baseUrl");
  const apiStatusEl = el("apiStatus");

  const BTN_SIZE = 32, BTN_MARGIN = 4;

  function applyPos(pos) {
    btnEl.style.left = pos.left + "px"; btnEl.style.bottom = pos.bottom + "px";
    panelEl.style.left = pos.left + "px"; panelEl.style.bottom = (pos.bottom + BTN_SIZE + 10) + "px";
  }
  applyPos(getPos());

  function flashSaved(text) {
    savedEl.textContent = text || "저장됨";
    savedEl.classList.add("show");
    clearTimeout(flashSaved._t);
    flashSaved._t = setTimeout(() => savedEl.classList.remove("show"), 1600);
  }

  // ---- 토스트 (패널 밖에서도 보이는 간단한 알림) ----
  const toastEl = document.createElement("div");
  toastEl.style.cssText = "position:fixed;left:8px;right:8px;bottom:8px;background:#000;color:#7CFC9C;font-family:monospace;font-size:10px;line-height:1.4;padding:8px 10px;border-radius:8px;border:1px solid #5d8fff;opacity:0;pointer-events:none;transition:opacity .3s;white-space:pre-wrap;word-break:break-all;z-index:2147483647;";
  root.appendChild(toastEl);
  function showToast(message, isError) {
    toastEl.style.color = isError ? "#ffb347" : "#7CFC9C";
    toastEl.textContent = String(message || "");
    toastEl.style.opacity = "0.95";
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => { toastEl.style.opacity = "0"; }, 5000);
  }

  // ---- 탭 전환 ----
  root.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      root.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
      root.querySelectorAll(".tabpanel").forEach((p) => p.classList.remove("active"));
      tab.classList.add("active");
      root.querySelector('.tabpanel[data-panel="' + tab.dataset.tab + '"]').classList.add("active");
    });
  });

  // ---- 노트 탭 ----
  function updateCount() { countEl.textContent = noteEl.value.length.toLocaleString() + "자"; }

  function refreshRoomUI() {
    roomEl.textContent = "Room: " + (roomId ? roomId.slice(0, 24) : "(감지 안 됨)");
    noteEl.value = getNote(roomId);
    enabledEl.checked = getEnabled(roomId);
    updateCount();
    refreshPresetUI();
  }

  noteEl.addEventListener("input", () => { updateCount(); });
  el("saveNote").addEventListener("click", () => {
    saveNote(roomId, noteEl.value);
    flashSaved("저장됨");
  });
  enabledEl.addEventListener("change", () => setEnabled(roomId, enabledEl.checked));

  // ---- API 탭 ----
  function refreshPresetUI() {
    const list = getPresets();
    const activeId = getActivePresetId(roomId) || (list[0] && list[0].id) || "";
    presetSelectEl.innerHTML = "";
    list.forEach((p) => {
      const opt = document.createElement("option");
      opt.value = p.id; opt.textContent = p.name || "(이름 없음)";
      presetSelectEl.appendChild(opt);
    });
    if (!list.length) {
      const opt = document.createElement("option");
      opt.value = ""; opt.textContent = "(프리셋 없음 — 새 프리셋을 만드세요)";
      presetSelectEl.appendChild(opt);
    }
    presetSelectEl.value = activeId;
    loadPresetIntoForm(list.find((p) => p.id === activeId) || null);
    btnEl.classList.toggle("no-api", !getActivePreset(roomId));
    btnEl.classList.toggle("ready", !!getActivePreset(roomId));
  }

  function loadPresetIntoForm(preset) {
    presetNameEl.value = preset ? preset.name || "" : "";
    providerEl.value = preset ? preset.provider || "gemini" : "gemini";
    apiKeyEl.value = preset ? preset.apiKey || "" : "";
    modelEl.value = preset ? preset.model || "" : "";
    baseUrlEl.value = preset ? preset.baseUrl || "" : "";
    baseUrlWrapEl.classList.toggle("hidden", providerEl.value !== "compatible");
    apiStatusEl.className = "status";
    apiStatusEl.textContent = "아직 테스트 안 함";
  }

  providerEl.addEventListener("change", () => {
    baseUrlWrapEl.classList.toggle("hidden", providerEl.value !== "compatible");
  });

  presetSelectEl.addEventListener("change", () => {
    setActivePresetId(roomId, presetSelectEl.value);
    const preset = getPresets().find((p) => p.id === presetSelectEl.value) || null;
    loadPresetIntoForm(preset);
  });

  el("newPreset").addEventListener("click", () => {
    const list = getPresets();
    const preset = { id: uuid(), name: "새 프리셋", provider: "gemini", apiKey: "", model: "", baseUrl: "" };
    list.push(preset);
    savePresets(list);
    setActivePresetId(roomId, preset.id);
    refreshPresetUI();
  });

  el("deletePreset").addEventListener("click", () => {
    const id = presetSelectEl.value;
    if (!id) return;
    if (!confirm("이 프리셋을 삭제할까요? (API 키 포함)")) return;
    const list = getPresets().filter((p) => p.id !== id);
    savePresets(list);
    if (getActivePresetId(roomId) === id) setActivePresetId(roomId, (list[0] && list[0].id) || "");
    refreshPresetUI();
  });

  el("savePreset").addEventListener("click", () => {
    const list = getPresets();
    let id = presetSelectEl.value;
    let preset = list.find((p) => p.id === id);
    if (!preset) {
      preset = { id: uuid() };
      list.push(preset);
      id = preset.id;
    }
    preset.name = presetNameEl.value.trim() || "이름 없음";
    preset.provider = providerEl.value;
    preset.apiKey = apiKeyEl.value.trim();
    preset.model = modelEl.value.trim();
    preset.baseUrl = baseUrlEl.value.trim();
    savePresets(list);
    setActivePresetId(roomId, id);
    refreshPresetUI();
    flashSaved("프리셋 저장됨");
  });

  el("testPreset").addEventListener("click", async () => {
    const preset = {
      provider: providerEl.value,
      apiKey: apiKeyEl.value.trim(),
      model: modelEl.value.trim(),
      baseUrl: baseUrlEl.value.trim()
    };
    apiStatusEl.className = "status";
    apiStatusEl.textContent = "테스트 중...";
    try {
      const reply = await testPreset(preset);
      apiStatusEl.className = "status ok";
      apiStatusEl.textContent = "✅ 연결 성공: " + reply;
    } catch (err) {
      apiStatusEl.className = "status bad";
      apiStatusEl.textContent = "❌ 실패: " + (err && err.message || err);
    }
  });

  el("resetPos").addEventListener("click", () => {
    const defaultPos = { left: 16, bottom: 80 };
    savePos(defaultPos);
    applyPos(defaultPos);
    flashSaved("위치 초기화됨");
  });

  refreshRoomUI();

  // ---- 드래그 vs 클릭 구분, 패널 열기/닫기 ----
  let dragging = false, moved = false, startX = 0, startY = 0, startPos = null;

  function pointFromEvent(e) {
    if (e.touches && e.touches[0]) return { x: e.touches[0].clientX, y: e.touches[0].clientY };
    return { x: e.clientX, y: e.clientY };
  }
  function onDragStart(e) { dragging = true; moved = false; const p = pointFromEvent(e); startX = p.x; startY = p.y; startPos = getPos(); btnEl.classList.add("dragging"); }
  function onDragMove(e) {
    if (!dragging) return;
    const p = pointFromEvent(e);
    const dx = p.x - startX, dy = p.y - startY;
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
    if (moved) savePos({ left: parseFloat(btnEl.style.left) || 16, bottom: parseFloat(btnEl.style.bottom) || 80 });
    else setPanelOpen(!panelEl.classList.contains("open"));
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

  // ---- 방 이동 감지 (SPA 라우팅 대응) ----
  setInterval(() => {
    const id = currentRoomId();
    if (id !== roomId) { roomId = id; if (panelEl.classList.contains("open")) refreshRoomUI(); }
  }, 1000);

  console.log(`📝 Zeta UserNote Corrector v${VERSION} Ready`);
})();
