// ==UserScript==
// @name         Zeta User Note Corrector
// @namespace    zeta-usernote-corrector
// @version      2.1.0
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

  const VERSION = "2.1.0";

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

  // 답변의 contents 배열(TEXT + INFO_BOX)을 사람이 읽고 AI가 대조할 수 있는 텍스트로 직렬화한다.
  // TEXT는 원문 그대로, INFO_BOX는 라벨:값 형태로 풀어서 붙인다.
  // 여기서 값(value)들은 원본 JSON 문자열 그대로 유지되므로, 나중에 find/replace로
  // 원본 스트림 텍스트 안에서 그대로 찾아낼 수 있다.
  function serializeContents(contents) {
    if (!Array.isArray(contents)) return "";
    const parts = [];
    contents.forEach((c) => {
      if (!c) return;
      if (c.type === "TEXT" && typeof c.text === "string") {
        parts.push(c.text);
      } else if (c.type === "INFO_BOX") {
        const sceneLines = (c.scenes || [])
          .map((s) => (s && typeof s.value === "string") ? `${s.label || ""}: ${s.value}`.trim() : "")
          .filter(Boolean);
        if (sceneLines.length) parts.push("[상태창]\n" + sceneLines.join("\n"));
        (c.characters || []).forEach((ch) => {
          const itemLines = (ch && ch.items || [])
            .map((it) => (it && typeof it.value === "string") ? `${it.label || ""}: ${it.value}`.trim() : "")
            .filter(Boolean);
          if (itemLines.length) parts.push(`[${(ch && ch.name) || "캐릭터"}]\n` + itemLines.join("\n"));
        });
      }
    });
    return parts.filter(Boolean).join("\n\n").trim();
  }

  // TEXT 콘텐츠에 있는 speakerName들을 모은다 (지금 답변에서 실제로 "말하고 있는" 캐릭터가 누구인지).
  function extractSpeakerNames(contents) {
    if (!Array.isArray(contents)) return [];
    const names = [];
    contents.forEach((c) => {
      if (c && c.type === "TEXT" && typeof c.speakerName === "string" && c.speakerName.trim()) {
        const name = c.speakerName.trim();
        if (!names.includes(name)) names.push(name);
      }
    });
    return names;
  }

  // 제타 스트리밍 응답 전체(SSE)에서: 완성된 답변 텍스트(TEXT+INFO_BOX 포함) + messageId + candidateId + 화자를 뽑아낸다.
  // 새 메시지 전송(CHAT_COMPLETE)과 리롤/다시받기(CANDIDATE_COMPLETE) 둘 다 명시적으로 처리한다.
  function extractReplyEnvelope(responseText) {
    const events = parseSse(responseText);
    const trueDeltas = [];
    const cumulative = [];
    const finals = [];
    const ids = { requestId: "", messageId: "", candidateId: "" };
    const uuidish = [];
    let completeText = "";
    let speakers = [];

    events.forEach((event) => {
      if (!event || typeof event !== "object") return;
      const evType = String(event.event || "").toUpperCase();

      if (evType === "CHAT_COMPLETE" && event.replyMessage) {
        const reply = event.replyMessage;
        if (reply.id) ids.messageId = String(reply.id);
        if (reply.candidateId) ids.candidateId = String(reply.candidateId);
        if (event.requestId) ids.requestId = String(event.requestId);
        if (Array.isArray(reply.contents)) {
          completeText = serializeContents(reply.contents);
          speakers = extractSpeakerNames(reply.contents);
        }
      }

      // 리롤("다시 받기") 응답은 CHAT_COMPLETE가 아니라 CANDIDATE_COMPLETE로 온다.
      if (evType === "CANDIDATE_COMPLETE" && event.candidate) {
        const cand = event.candidate;
        if (cand.id) ids.candidateId = String(cand.id);
        if (Array.isArray(cand.contents)) {
          completeText = serializeContents(cand.contents);
          speakers = extractSpeakerNames(cand.contents);
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

    return { text, requestId: ids.requestId, messageId: ids.messageId, candidateId: ids.candidateId, speakers };
  }

  function isStreamEndpoint(url, method) {
    try {
      const target = new URL(String(url || ""), location.href);
      return target.hostname === "api.zeta-ai.io" &&
        String(method || "").toUpperCase() === "POST" &&
        /^\/v1\/rooms\/[^/]+\/messages\/(?:stream|[^/]+\/candidates\/stream)\/?$/i.test(target.pathname);
    } catch { return false; }
  }

  function roomIdFromUrl(url) {
    const m = String(url || "").match(/\/v1\/rooms\/([^/]+)\/messages\//i);
    if (m) return decodeURIComponent(m[1]);
    return currentRoomId();
  }

  function currentRoomId() {
    const m = String(location.pathname || "").match(/\/rooms\/([^/?#]+)/i);
    return m ? decodeURIComponent(m[1]) : "";
  }

  // api.zeta-ai.io로 나가는 요청인지 (스트림 엔드포인트가 아닌 다른 API들도 포함해서 넓게 판별)
  function isZetaApiHost(url) {
    try {
      const target = new URL(String(url || ""), location.href);
      return target.hostname === "api.zeta-ai.io";
    } catch { return false; }
  }

  // /v1/rooms/:roomId/... 형태의 어떤 API 경로에서든 roomId를 뽑아낸다 (스트림 엔드포인트에 한정하지 않음).
  function broaderRoomIdFromUrl(url) {
    const m = String(url || "").match(/\/v1\/rooms\/([^/]+)/i);
    if (m) return decodeURIComponent(m[1]);
    return currentRoomId();
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
  const LS_ROSTER_PREFIX = "zeta-unc-roster-"; // 방별 등장인물 목록 (쉼표 구분) - 노트 자동 필터링용
  const LS_PRESETS_KEY = "zeta-unc-api-presets";
  const LS_ACTIVE_PRESET_PREFIX = "zeta-unc-active-preset-";
  const LS_ENABLED_PREFIX = "zeta-unc-enabled-"; // 방별 on/off

  function getNote(roomId) {
    return localStorage.getItem(LS_NOTE_PREFIX + roomId) || "";
  }
  function saveNote(roomId, text) {
    localStorage.setItem(LS_NOTE_PREFIX + roomId, text || "");
  }

  function getRoster(roomId) {
    return localStorage.getItem(LS_ROSTER_PREFIX + roomId) || "";
  }
  function saveRoster(roomId, text) {
    localStorage.setItem(LS_ROSTER_PREFIX + roomId, text || "");
  }
  // "김젯시, 이젯시, 박젯시" 같은 쉼표 구분 문자열을 이름 배열로 변환 (공백 제거, 빈 항목 제거, 중복 제거)
  function parseRoster(text) {
    const seen = new Set();
    const out = [];
    String(text || "").split(",").forEach((raw) => {
      const name = raw.trim();
      if (!name || seen.has(name)) return;
      seen.add(name);
      out.push(name);
    });
    return out;
  }

  function getEnabled(roomId) {
    const v = localStorage.getItem(LS_ENABLED_PREFIX + roomId);
    return v === null ? true : v === "1";
  }
  function setEnabled(roomId, on) {
    localStorage.setItem(LS_ENABLED_PREFIX + roomId, on ? "1" : "0");
  }

  // ---- 교정 모드 : "conflict"(기존 find/replace) 또는 "full"(완성 답변 통째 재작성 후 자동 diff) ----
  const LS_MODE_PREFIX = "zeta-unc-mode-";
  function getMode(roomId) {
    const v = localStorage.getItem(LS_MODE_PREFIX + roomId);
    return v === "full" ? "full" : "conflict"; // 기본값은 항상 기존 방식
  }
  function setMode(roomId, mode) {
    localStorage.setItem(LS_MODE_PREFIX + roomId, mode === "full" ? "full" : "conflict");
  }

  // ---- 이미 적용했던 교정 내용 기억 (스트림 이후 다른 API가 원본으로 덮어쓰는 것을 방지) ----
  const LS_CORR_PREFIX = "zeta-unc-corrections-";

  function recordCorrections(roomId, applied) {
    if (!roomId || !Array.isArray(applied) || !applied.length) return;
    const key = LS_CORR_PREFIX + roomId;
    const list = safeJsonParse(localStorage.getItem(key), []) || [];
    applied.forEach((c) => {
      if (!c || typeof c.find !== "string" || typeof c.replace !== "string" || !c.find) return;
      const idx = list.findIndex((x) => x.find === c.find);
      if (idx !== -1) list[idx] = { find: c.find, replace: c.replace, ts: Date.now() };
      else list.push({ find: c.find, replace: c.replace, ts: Date.now() });
    });
    while (list.length > 300) list.shift();
    try { localStorage.setItem(key, JSON.stringify(list)); } catch {}
  }

  // 모든 방에서 지금까지 적용됐던 교정 내용을 전부 모아온다 (find 기준 중복 제거, 최신이 우선).
  function getAllCorrections() {
    const map = new Map();
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (!k || k.indexOf(LS_CORR_PREFIX) !== 0) continue;
        const list = safeJsonParse(localStorage.getItem(k), []) || [];
        list.forEach((c) => { if (c && c.find && typeof c.replace === "string") map.set(c.find, c.replace); });
      }
    } catch {}
    return Array.from(map, ([find, replace]) => ({ find, replace }));
  }

  // ---- 유저노트 대조용 AI 호출이 실제로 소비한 토큰(제타 토큰 아님, 연결한 API 쪽) 누적 집계 ----
  const LS_TOKEN_PREFIX = "zeta-unc-tokens-";
  const LS_TOKEN_GLOBAL_KEY = "zeta-unc-tokens-global";

  function getTokenStats(key) {
    return safeJsonParse(localStorage.getItem(key), null) || { input: 0, output: 0, total: 0, calls: 0 };
  }
  function addTokenUsage(key, usage) {
    const cur = getTokenStats(key);
    cur.input += usage.input || 0;
    cur.output += usage.output || 0;
    cur.total += usage.total || ((usage.input || 0) + (usage.output || 0));
    cur.calls += 1;
    try { localStorage.setItem(key, JSON.stringify(cur)); } catch {}
    return cur;
  }
  function recordTokenUsage(roomId, usage) {
    if (!usage) return { global: getTokenStats(LS_TOKEN_GLOBAL_KEY), room: roomId ? getTokenStats(LS_TOKEN_PREFIX + roomId) : null };
    const global = addTokenUsage(LS_TOKEN_GLOBAL_KEY, usage);
    const room = roomId ? addTokenUsage(LS_TOKEN_PREFIX + roomId, usage) : null;
    return { global, room };
  }
  function resetTokenStats(roomId) {
    localStorage.removeItem(LS_TOKEN_GLOBAL_KEY);
    if (roomId) localStorage.removeItem(LS_TOKEN_PREFIX + roomId);
    else {
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const k = localStorage.key(i);
        if (k && k.indexOf(LS_TOKEN_PREFIX) === 0) localStorage.removeItem(k);
      }
    }
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
  // 1.5 노트 화자 필터링 (코드 레벨, AI 호출 없이 처리)
  // ==========================================================
  // 목적: AI에게 "이 노트 내용이 지금 화자와 관련 있는지"를 추론시키는 대신,
  // 등장인물 이름 목록(roster)을 기준으로 코드가 미리 걸러낸다.
  // - roster가 비어있으면 필터링을 하지 않고 노트 전체를 그대로 넘긴다 (기존 동작과 동일, 하위호환).
  // - 노트는 빈 줄(빈 줄 하나 이상) 기준으로 "항목"으로 나눈다.
  // - 각 항목 텍스트 안에 roster 이름이 몇 개가 등장하는지 본다.
  //   - roster 이름이 하나도 안 나오면(일반적인 설정/전역 사실) -> 항상 포함
  //   - 지금 화자 이름이 등장하면 -> 포함 (화자 본인 관련 사건이거나, 화자가 그 사건을 알고 있다는 근거로 봄)
  //   - roster 이름은 나오는데 그 중에 지금 화자 이름이 전혀 없으면 -> 이번 화자와는 무관한 사건으로 보고 제외

  function splitNoteEntries(note) {
    return String(note || "")
      .split(/\r?\n\s*\r?\n+/)
      .map((s) => s.trim())
      .filter(Boolean);
  }

  function filterNoteForSpeakers(note, speakerNames, rosterNames) {
    const entries = splitNoteEntries(note);
    if (!entries.length) return { text: "", keptCount: 0, totalCount: 0, filtered: false };

    if (!Array.isArray(rosterNames) || !rosterNames.length) {
      // roster 미설정 -> 필터링 안 함 (기존 동작 유지)
      return { text: entries.join("\n\n"), keptCount: entries.length, totalCount: entries.length, filtered: false };
    }

    const speakers = (Array.isArray(speakerNames) ? speakerNames : []).filter(Boolean);

    const kept = entries.filter((entry) => {
      const mentionedRosterNames = rosterNames.filter((name) => entry.includes(name));
      if (!mentionedRosterNames.length) return true; // 특정 인물 얘기가 아닌 일반 항목 -> 항상 포함
      if (!speakers.length) return true; // 화자를 특정 못 하면 안전하게 포함 (걸러내지 않음)
      const speakerMentioned = speakers.some((sp) => mentionedRosterNames.includes(sp) || entry.includes(sp));
      return speakerMentioned;
    });

    return { text: kept.join("\n\n"), keptCount: kept.length, totalCount: entries.length, filtered: true };
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
      const um = data && data.usageMetadata;
      const usage = um ? {
        input: um.promptTokenCount || 0,
        output: um.candidatesTokenCount || 0,
        total: um.totalTokenCount || ((um.promptTokenCount || 0) + (um.candidatesTokenCount || 0))
      } : null;
      return { text, usage };
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
          max_tokens: 4096,
          messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userPrompt }]
        })
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error("API 오류 (" + res.status + "): " + (data && data.error && data.error.message || res.statusText));
      const msg = data && data.choices && data.choices[0] && data.choices[0].message;
      let text = msg && msg.content;
      // 일부 추론형 모델(GLM, DeepSeek 계열 등)은 최종 답을 content가 아니라
      // reasoning_content 같은 별도 필드에 담아서 준다 — 그것도 확인해본다.
      if (!text && msg && typeof msg.reasoning_content === "string" && msg.reasoning_content.trim()) {
        text = msg.reasoning_content;
      }
      if (!text) {
        const finishReason = data && data.choices && data.choices[0] && data.choices[0].finish_reason;
        const keys = msg ? Object.keys(msg).join(",") : "(message 자체 없음)";
        throw new Error(`응답에서 텍스트를 찾지 못했습니다. (finish_reason: ${finishReason || "?"}, message 필드: ${keys})`);
      }
      const u2 = data && data.usage;
      const usage = u2 ? {
        input: u2.prompt_tokens || 0,
        output: u2.completion_tokens || 0,
        total: u2.total_tokens || ((u2.prompt_tokens || 0) + (u2.completion_tokens || 0))
      } : null;
      return { text, usage };
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
      const u3 = data && data.usage;
      const usage = u3 ? {
        input: u3.input_tokens || 0,
        output: u3.output_tokens || 0,
        total: (u3.input_tokens || 0) + (u3.output_tokens || 0)
      } : null;
      return { text, usage };
    }

    throw new Error("지원하지 않는 AI 제공사입니다: " + provider);
  }

  async function testPreset(preset) {
    const res = await callAI(preset, "짧게 한 단어로만 답하라.", "테스트: '정상'이라고만 답해줘.");
    return normalizeSpace(res.text).slice(0, 30);
  }

  // ==========================================================
  // 3. 프롬프트 구성 (find/replace conflict 방식)
  // ==========================================================

  function buildCorrectionPrompt(note, userText, originalReply, speakerNames) {
    const speakerLine = (Array.isArray(speakerNames) && speakerNames.length)
      ? speakerNames.join(", ")
      : "(알 수 없음)";

    const system = [
      "당신은 대화 로그 검수자다. 아래 [유저노트]에 적힌 확정 사실·현재 상태와, [제타 원본 답변]을 대조한다.",
      "[지금 답변하는 캐릭터]는 이번 답변에서 실제로 말하고 있는 인물이다.",
      "[유저노트]는 이미 지금 화자와 관련 있는 항목만 걸러져서 전달된 것이다 (관련 없는 다른 인물 단독 사건은 이미 제외됨).",
      "[제타 원본 답변]에는 대사/지문(TEXT) 외에 [상태창], [캐릭터명] 같은 대괄호 섹션이 있을 수 있는데,",
      "이건 그 답변에 같이 딸려온 상태창(날짜/장소/속마음 등) 정보를 라벨: 값 형태로 풀어놓은 것이다. 이 값들도 검수 대상이다.",
      "임무는 명백히 모순되는 부분만 찾아서 고치는 것이지, 전체를 다시 쓰는 것이 아니다.",
      "",
      "규칙:",
      "1. 원본 답변에 유저노트와 실제로 모순되는 문장/구절/상태값이 있을 때만 손댄다.",
      "2. 유저노트가 다루지 않거나, 원본이 그 화제를 그냥 언급하지 않고 넘어가는 경우는 모순이 아니다. 아무것도 추가하지 않는다.",
      "3. 원본 답변에서 고치지 않는 나머지 부분의 문체, 어투, 문단 구성, 대사와 지문 배치, 상태창 라벨/형식은",
      "   절대 건드리지 않는다. (replace 자체의 시제/인칭 조정은 10번 규칙을 따른다.)",
      "4. find는 [제타 원본 답변]에 있는 문자열을 한 글자도 틀리지 않고 그대로 옮겨 적어야 한다 (요약·의역 금지).",
      "   상태창 값을 고칠 때도 'label: ' 부분은 빼고 값(value) 부분만 find로 잡는다.",
      "5. find가 원본 안에 여러 번 나올 수 있다. 그 경우 모든 위치에 같은 replace를 적용해도 뜻이 통하는 문구로 find를 잡는다.",
      "   (문맥에 따라 다르게 고쳐야 하는 상황이면, 그 문맥까지 포함해서 find를 더 길고 구체적으로 잡아 그 자리만 특정한다.)",
      "6. replace는 모순만 해소하도록 최소한으로 고친 문장/값이며, 원본의 문체와 어울려야 한다.",
      "7. 유저노트 문장에 '어제/오늘/방금/지금' 같은 과거→현재로 이어지는 시간 표현이 있으면,",
      "   그 문장이 뜻하는 현재 상태까지 추론해서 대조한다.",
      "   (예: 노트에 '어제 부산에 놀러갔다가 오늘 집에 옴'이라고 적혀있는데, 원본 답변이 화자가 여전히 부산에 있는 것처럼",
      "   서술하면 -- '지금은 집에 있어야 한다'는 함의와 모순되는 것으로 본다.) 단, 노트에 안 적힌 화제까지 추측해서",
      "   새로 만들어내지는 않는다 -- 오직 노트 문장이 실제로 뜻하는 현재 상태와의 모순만 본다.",
      "8. 반대로 유저노트 문장에 '내일/다음 주/이따가/오늘 저녁/~할 예정' 같이 아직 오지 않은 시점을 가리키는",
      "   표현이 있으면, 그 사건은 어디까지나 '예정된 미래 계획'일 뿐, 지금 이 순간 실제로 일어나고 있거나",
      "   이미 일어난 일이 아니다. 이런 노트 항목은 대조 대상에서 완전히 배제한다 -- 원본 답변 속 장면의",
      "   날짜/장소/상황이 노트가 가리키는 그 미래 시점과 명백히 일치하는 경우(예: 노트가 '내일 폐병원 정찰'이라",
      "   적혀있고, 원본 답변의 [상태창] 날짜가 실제로 그 다음날이고 장소도 폐병원인 경우)에만 예외적으로",
      "   대조 대상으로 삼는다. 그 외에는 원본 답변에 그 예정된 사건의 키워드(장소명, 행동명 등)가 우연히",
      "   비슷하게 등장하더라도 -- 지금이 아직 그 시점이 아니라면 -- 그것을 이유로 원본을 그 미래 사건이",
      "   진행 중인 것처럼 고치지 않는다. 애매하면 손대지 않는다.",
      "9. 수정을 반영했을 때, 그 수정 내용이 [제타 원본 답변]의 다른 부분과 새로 모순을 만들면 안 된다.",
      "   만약 원본 안에 이미 있는 다른 문구가 지금 고치려는 내용과 서로 충돌한다면(예: 한쪽은 '아직 고백 안 함',",
      "   다른 한쪽은 '이미 고백함'), 그 충돌하는 다른 부분도 conflicts에 같이 추가해서 답변 전체가 앞뒤가",
      "   맞도록 만든다. 한 군데만 고치고 바로 근처의 모순을 그대로 방치하지 않는다.",
      "   이런 연쇄 충돌은 특히 [상태창] 값에서 잘 발생한다. 대사/지문을 고쳤는데 상태창의 감정/장소/관계",
      "   항목이 그대로 남아 어긋나는 경우가 흔하다.",
      "   (예: 노트 때문에 대사를 '이제 괜찮아졌어'로 고쳤는데, 같은 답변의 상태창에 '감정: 극도의 불안'이",
      "   그대로 남아있으면, 이것도 함께 conflicts에 넣어 상태창 쪽 감정값도 누그러뜨린다.)",
      "   (예: 노트 때문에 화자의 위치를 '집'으로 고쳤는데, 상태창의 '장소'가 여전히 '폐병원'으로 남아있으면",
      "   상태창 장소 값도 함께 고친다.)",
      "10. replace를 만들 때 [유저노트]의 문장을 그대로 베껴쓰지 않는다. 유저노트는 사실을 정리해둔 메모일 뿐,",
      "    실제 대사가 아니다. [지금 답변하는 캐릭터]가 [이번 유저 메시지]를 보낸 상대에게 지금 이 순간 직접",
      "    말하는 것처럼, 시제(과거형으로 쓰여있어도 '지금도 그렇다'는 뜻이면 현재형으로)와 인칭(노트에 3인칭으로",
      "    적혀있어도 화자 본인 얘기면 '나는', 상대방 얘기면 '너는'으로)을 자연스럽게 바꿔서 쓴다.",
      "    (예: 노트에 '재하는 젯시를 3년동안 좋아했다'라고 적혀있어도, 재하 본인이 젯시에게 직접 말하는",
      "    상황이면 '나 너 3년 동안 좋아했어' 처럼 화자-청자 관계에 맞게 바꿔서 자연스러운 대사로 만든다.)",
      "    (예: 노트에 '승아는 그 사실을 이미 알고 있었다'라고 적혀있고, 화자가 승아 본인이 아니라 승아에게",
      "    말을 거는 상대방이면 -- '너 이미 알고 있었잖아'처럼 2인칭으로 바꾼다.)",
      "    (예: 노트에 '재하는 3년째 그 카페에서 일했다'처럼 과거형이지만 지금도 유효한 사실이면,",
      "    화자 본인 얘기일 때 '나 3년째 여기서 일해'처럼 현재형 1인칭으로 바꾼다.)",
      "11. 유저노트 원문에 '~도', '역시', '마찬가지로'처럼 다른 인물과 비교하거나 같은 처지임을 나타내는",
      "    표현이 있으면, replace에도 그 뉘앙스를 그대로 살린다. 이런 표현을 빼고 밋밋한 단정문으로 바꾸지 않는다.",
      "    (예: 노트에 '선우도(재하처럼) 3년 동안 좋아했다'라고 적혀있으면, replace도 '나는 3년 동안'이 아니라",
      "    '나도 3년 동안'처럼 비교/공유의 의미를 유지해서 쓴다.)",
      "12. 노트에 적힌 사건을 [이번 유저 메시지]를 보낸 상대방(청자) 본인이 이미 직접 겪은 당사자라면,",
      "    그 사건을 상대방이 몰랐던 새로운 정보인 것처럼 처음부터 다시 설명/나열하는 문장을 만들지 않는다.",
      "    (예: 젯시 본인이 재하에게 고백받고 거절한 당사자인데, 젯시에게 '재하가 너한테 고백했었고, 너도",
      "    거절했었지'처럼 그 사건 자체를 새삼스럽게 되짚어 알려주지 않는다. 그 사실을 이미 전제로 깔고,",
      "    거기서 이어지는 감정/반응/화제만 자연스럽게 언급한다.)",
      "13. 모순이 없으면 conflicts를 빈 배열로 반환한다.",
      "14. 반드시 아래 JSON 형식 하나만 반환한다. 다른 설명이나 사과를 덧붙이지 않는다.",
      "",
      '{"conflicts":[{"find":"원본 그대로의 문자열","replace":"고친 문자열","reason":"어떤 노트 내용과 왜 모순인지"}]}'
    ].join("\n");

    const user = [
      "[지금 답변하는 캐릭터]",
      speakerLine,
      "",
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

  // ==========================================================
  // 3.1 "전체 교체" 모드 : 완성된 답변을 통째로 다시 쓰게 한 뒤,
  //      원본과 블록 단위로 자동 diff해서 conflicts 배열로 변환한다.
  //      (find/replace 모드와 똑같은 안전장치를 그대로 재사용하기 위함)
  // ==========================================================

  function buildFullReplacePrompt(note, userText, originalReply, speakerNames) {
    const speakerLine = (Array.isArray(speakerNames) && speakerNames.length)
      ? speakerNames.join(", ")
      : "(알 수 없음)";

    const system = [
      "당신은 대화 로그 검수자다. 아래 [유저노트]에 적힌 확정 사실·현재 상태와, [제타 원본 답변]을 대조해서,",
      "노트와 명백히 모순되는 부분만 고친 최종 답변 전체를 다시 작성한다.",
      "[지금 답변하는 캐릭터]는 이번 답변에서 실제로 말하고 있는 인물이다.",
      "[유저노트]는 이미 지금 화자와 관련 있는 항목만 걸러져서 전달된 것이다.",
      "",
      "[제타 원본 답변]은 빈 줄로 구분된 여러 블록으로 이루어져 있다.",
      "각 블록은 순수 대사/지문 블록이거나, '[상태창]' 또는 '[캐릭터명]'으로 시작해서",
      "'라벨: 값' 형태의 줄들이 이어지는 상태창 블록이다.",
      "",
      "출력 형식 (반드시 지킬 것):",
      "1. 원본과 정확히 같은 개수의 블록을, 정확히 같은 순서로 출력한다. 블록을 추가하거나 삭제하지 않는다.",
      "2. 상태창 블록은 원본과 정확히 같은 줄 수를 유지하고, 각 줄의 '라벨:' 부분은 절대 바꾸지 않는다.",
      "   값(라벨 뒤의 내용)만 필요할 때 고친다.",
      "3. 수정할 필요가 없는 블록/줄은 원본 글자 하나 안 틀리고 그대로 옮겨 적는다 (다듬거나 요약하지 않는다).",
      "4. 노트와 실제로 모순되는 부분만 최소한으로 고친다. 전체를 새로 쓰거나 문체를 바꾸지 않는다.",
      "5. JSON이나 설명, 이유, 마크다운 코드펜스 없이, 블록 텍스트만 그대로 출력한다.",
      "",
      "모순 판단 규칙:",
      "a. 유저노트 문장에 '어제/오늘/방금/지금' 같은 과거→현재 시간 표현이 있으면, 그 문장이 뜻하는",
      "   현재 상태까지 추론해서 대조한다. 노트에 안 적힌 화제까지 추측해서 새로 만들어내지 않는다.",
      "b. 유저노트 문장에 '내일/다음 주/이따가/~할 예정' 같은 아직 오지 않은 시점 표현이 있으면,",
      "   그 사건은 예정된 미래 계획일 뿐이다. 원본 답변 속 장면이 실제로 그 미래 시점에 도달한 것이",
      "   명백한 경우(날짜/장소가 노트가 가리키는 시점과 일치)가 아니라면, 이런 노트 항목은 절대",
      "   지금 진행 중인 일처럼 반영하지 않는다. 애매하면 손대지 않는다.",
      "c. replace할 때 [유저노트] 문장을 그대로 베끼지 않는다. [지금 답변하는 캐릭터]가 [이번 유저 메시지]를",
      "   보낸 상대에게 지금 이 순간 직접 말하듯, 시제(현재도 유효하면 현재형)와 인칭(화자 본인 얘기면 '나는',",
      "   상대방 얘기면 '너는')을 자연스럽게 바꿔서 쓴다.",
      "   (예: 노트 '재하는 젯시를 3년동안 좋아했다' + 재하 본인이 젯시에게 말하는 상황 → '나 너 3년 동안 좋아했어')",
      "   (예: 노트 '승아는 그 사실을 이미 알고 있었다' + 화자가 승아 상대방 → '너 이미 알고 있었잖아')",
      "d. 노트 원문에 '~도/역시/마찬가지로'처럼 비교·공유 뉘앙스가 있으면 그 뉘앙스를 살린다.",
      "   (예: '선우도 3년 동안 좋아했다' → '나도 3년 동안'처럼, '나는'으로 밋밋하게 바꾸지 않는다.)",
      "e. 노트에 적힌 사건을 [이번 유저 메시지]를 보낸 상대방 본인이 이미 겪은 당사자라면, 그 사건을",
      "   상대방이 몰랐던 새 정보처럼 처음부터 다시 설명하지 않는다. 이미 아는 전제로 두고 이어지는",
      "   감정/반응만 자연스럽게 언급한다.",
      "f. 한 곳을 고치면서 답변의 다른 부분(특히 상태창의 감정/장소/관계 값)과 새로 모순이 생기면 안 된다.",
      "   본문을 고쳤으면 관련된 상태창 값도 함께 자연스럽게 맞춘다.",
      "   (예: 대사를 '이제 괜찮아졌어'로 고쳤는데 상태창에 '감정: 극도의 불안'이 남아있으면 그 값도 고친다.)",
      "g. 모순이 없으면 원본을 단 한 글자도 바꾸지 말고 그대로 출력한다."
    ].join("\n");

    const user = [
      "[지금 답변하는 캐릭터]",
      speakerLine,
      "",
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

  // originalReply / revisedReply를 "\n\n" 기준 블록으로 나눈다.
  // serializeContents가 부분들을 "\n\n"으로 join하는 방식과 대응된다.
  function splitEnvelopeBlocks(text) {
    return String(text || "").split(/\n\n+/).map((b) => b.trim()).filter(Boolean);
  }

  // 상태창류 블록("[라벨]"로 시작)의 각 줄을 "라벨: 값" 기준으로 분리한다.
  function splitLabelValue(line) {
    const idx = line.indexOf(": ");
    if (idx === -1) return null;
    return { label: line.slice(0, idx), value: line.slice(idx + 2) };
  }

  // 전체 교체 모드의 핵심 안전장치: AI가 다시 쓴 전체 답변을 원본과 블록 단위로 비교해서,
  // 실제로 바뀐 부분만 찾아 find/replace 쌍으로 변환한다.
  // - 블록 개수가 다르면 전체를 신뢰할 수 없다고 보고 통째로 폐기(unsafe)한다.
  // - 상태창 블록은 줄 단위로, 라벨이 같은 줄만 값(value)을 비교해서 find/replace로 만든다.
  //   (라벨 자체가 달라졌거나 줄 수가 안 맞으면 그 블록/줄은 건드리지 않고 건너뛴다.)
  // - 일반 대사/지문 블록은 블록 전체를 find/replace 단위로 삼되, 원본 대비 길이가 너무 크게
  //   달라지면(30% 미만 또는 300% 초과) AI가 과하게 축약/왜곡했을 위험으로 보고 그 블록은 버린다.
  function diffBlocksToConflicts(originalText, revisedText) {
    const origBlocks = splitEnvelopeBlocks(originalText);
    const newBlocks = splitEnvelopeBlocks(revisedText);

    if (!origBlocks.length || !newBlocks.length) {
      return { safe: false, reason: "빈 응답", conflicts: [] };
    }
    if (origBlocks.length !== newBlocks.length) {
      return { safe: false, reason: `블록 개수 불일치 (원본 ${origBlocks.length} / 응답 ${newBlocks.length})`, conflicts: [] };
    }

    const conflicts = [];
    const notes = [];

    for (let i = 0; i < origBlocks.length; i++) {
      const ob = origBlocks[i];
      const nb = newBlocks[i];
      if (ob === nb) continue;

      const isInfoBlock = /^\[[^\]]+\]/.test(ob);

      if (isInfoBlock) {
        const oLines = ob.split("\n");
        const nLines = nb.split("\n");
        if (oLines.length !== nLines.length) {
          notes.push(`블록 ${i}: 상태창 줄 수 불일치라 통째로 건너뜀`);
          continue;
        }
        for (let j = 1; j < oLines.length; j++) { // 0번 줄은 "[라벨]" 헤더라 건드리지 않음
          const oLine = oLines[j];
          const nLine = nLines[j];
          if (oLine === nLine) continue;
          const oLV = splitLabelValue(oLine);
          const nLV = splitLabelValue(nLine);
          if (!oLV || !nLV || oLV.label !== nLV.label) {
            notes.push(`블록 ${i} 줄 ${j}: 라벨 불일치라 건너뜀`);
            continue;
          }
          if (!oLV.value || oLV.value === nLV.value) continue;
          conflicts.push({ find: oLV.value, replace: nLV.value, reason: `[전체교체] ${oLV.label} 값 변경` });
        }
      } else {
        const ratio = ob.length ? (nb.length / ob.length) : 0;
        if (ratio < 0.3 || ratio > 3) {
          notes.push(`블록 ${i}: 길이 변화가 너무 커서(${Math.round(ratio * 100)}%) 안전상 건너뜀`);
          continue;
        }
        conflicts.push({ find: ob, replace: nb, reason: "[전체교체] 대사/지문 블록 변경" });
      }
    }

    return { safe: true, conflicts, notes };
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
      if (occurrences === 0) { skipped.push({ ...c, why: "원본에서 못 찾음" }); return; }
      // 같은 문구가 여러 번 나와도, replace 값은 항상 동일하게 적용되므로 전부 바꿔도 안전하다.
      result = result.split(find).join(replace);
      applied.push(c);
    });
    return { result, applied, skipped };
  }

  // ==========================================================
  // 3.5 네트워크 응답(SSE 원본 텍스트) 단계에서 직접 패치
  // ==========================================================

  function walkMutableStrings(value, visit) {
    if (value == null || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        const item = value[i];
        if (typeof item === "string") {
          const res = visit(item);
          if (res !== undefined) value[i] = res;
        } else {
          walkMutableStrings(item, visit);
        }
      }
    } else {
      Object.keys(value).forEach((k) => {
        const item = value[k];
        if (typeof item === "string") {
          const res = visit(item);
          if (res !== undefined) value[k] = res;
        } else {
          walkMutableStrings(item, visit);
        }
      });
    }
  }

  function replaceWithinString(str, original, revised) {
    if (str === original) return revised;
    if (str.includes(original)) return str.split(original).join(revised);
    const strNorm = normalizeSpace(str);
    const targetNorm = normalizeSpace(original);
    if (!targetNorm) return undefined;
    if (strNorm === targetNorm) return revised;
    if (strNorm.includes(targetNorm) && str.length >= original.length * 0.5) {
      const escaped = original.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
      let re = null;
      try { re = new RegExp(escaped, "g"); } catch { re = null; }
      if (re && re.test(str)) return str.replace(re, revised);
    }
    return undefined;
  }

  // rawText(제타 서버가 보낸 SSE 응답 전체)에서 original 텍스트가 들어있는
  // JSON 블록을 찾아 revised로 바꾼 새 rawText를 반환한다.
  function patchRawSseText(rawText, original, revised) {
    if (!original || !revised || original === revised) return { text: rawText, changed: false };
    const parts = String(rawText || "").split(/(\r?\n\r?\n)/);
    let changedAny = false;

    const rebuilt = parts.map((part) => {
      if (/^\r?\n\r?\n$/.test(part) || !part) return part;

      const lines = part.split(/\r?\n/);
      const dataLineIdx = [];
      const dataLines = [];
      lines.forEach((line, i) => {
        if (/^data:/i.test(line)) { dataLineIdx.push(i); dataLines.push(line.replace(/^data:\s?/i, "")); }
        else if (line.trim().charAt(0) === "{" || line.trim().charAt(0) === "[") { dataLineIdx.push(i); dataLines.push(line.trim()); }
      });
      if (!dataLines.length) return part;

      const joined = dataLines.join("\n").trim();
      if (!joined || joined === "[DONE]") return part;

      const parsed = safeJsonParse(joined, null);
      if (parsed == null || typeof parsed !== "object") return part;

      let changed = false;
      walkMutableStrings(parsed, (str) => {
        const res = replaceWithinString(str, original, revised);
        if (res !== undefined) { changed = true; return res; }
        return undefined;
      });
      if (!changed) return part;

      changedAny = true;
      const newJoined = JSON.stringify(parsed);
      const newLines = [];
      let inserted = false;
      lines.forEach((line, i) => {
        if (dataLineIdx.includes(i)) {
          if (!inserted) { newLines.push("data: " + newJoined); inserted = true; }
        } else {
          newLines.push(line);
        }
      });
      if (!inserted) newLines.push("data: " + newJoined);
      return newLines.join("\n");
    });

    return { text: rebuilt.join(""), changed: changedAny };
  }

  // envelope.text는 TEXT+INFO_BOX를 합친 "합성 텍스트"라서, 원본 응답 어디에도
  // 통째로는 존재하지 않는다 (실제 JSON은 대사/상태창이 서로 다른 필드에 나뉘어 있음).
  // 그래서 AI가 제안한 find/replace 쌍을 하나씩 개별적으로 raw 텍스트에 적용해야 한다.
  function applyCorrectionsToRawText(rawText, appliedList) {
    let text = rawText;
    let changedAny = false;
    (Array.isArray(appliedList) ? appliedList : []).forEach((c) => {
      if (!c || typeof c.find !== "string" || typeof c.replace !== "string") return;
      const r = patchRawSseText(text, c.find, c.replace);
      if (r.changed) { text = r.text; changedAny = true; }
    });
    return { text, changed: changedAny };
  }

  // 스트림 응답이 아닌 "일반 JSON" 응답(예: 대화 이력 재조회 등)에 대해,
  // 이미 예전에 적용했던 교정들을 AI 호출 없이 그대로 재적용한다.
  // - 몸통 전체가 JSON으로 파싱되면 그 구조를 그대로 걸어다니며 문자열 치환.
  // - 아니라면 SSE 스타일 응답일 수 있으니 patchRawSseText 로직을 각 교정마다 순서대로 적용.
  function patchGenericJsonText(rawText, corrections) {
    if (!Array.isArray(corrections) || !corrections.length) return { text: rawText, changed: false };

    const whole = safeJsonParse(rawText, null);
    if (whole !== null && typeof whole === "object") {
      let changed = false;
      walkMutableStrings(whole, (str) => {
        let cur = str;
        let localChanged = false;
        corrections.forEach((c) => {
          const res = replaceWithinString(cur, c.find, c.replace);
          if (res !== undefined) { cur = res; localChanged = true; }
        });
        if (localChanged) { changed = true; return cur; }
        return undefined;
      });
      if (!changed) return { text: rawText, changed: false };
      try { return { text: JSON.stringify(whole), changed: true }; }
      catch { return { text: rawText, changed: false }; }
    }

    let text = rawText;
    let changedAny = false;
    corrections.forEach((c) => {
      const res = patchRawSseText(text, c.find, c.replace);
      if (res.changed) { text = res.text; changedAny = true; }
    });
    return { text, changed: changedAny };
  }

  // ==========================================================
  // 4. 화면에 보이는 답변 교체 (텍스트만 치환, DOM 구조는 안 건드림) — 최후의 폴백
  // ==========================================================
  // v1.2.0부터는 XHR 스트림 경로도 fetch처럼 네트워크 응답 자체를 패치하므로
  // 이 함수는 "노트/프리셋이 꺼져있던 방을 나중에 켠 경우" 등 아주 드문 예외
  // 상황에서만 호출되는 보조 수단이다.

  function patchVisibleReply(original, revised, messageId, candidateId) {
    const targetNorm = normalizeSpace(original);
    const revisedNorm = normalizeSpace(revised);
    if (!targetNorm || !revisedNorm || targetNorm === revisedNorm) return false;

    function escapeAttr(value) {
      if (window.CSS && typeof window.CSS.escape === "function") return window.CSS.escape(String(value || ""));
      return String(value || "").replace(/["\\]/g, "\\$&");
    }

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
      let matches = pool.filter((el) => normalizeSpace(el.textContent || "") === targetNorm);
      if (!matches.length) {
        matches = pool.filter((el) => normalizeSpace(el.textContent || "").includes(targetNorm));
        if (!matches.length) return null;
        matches.sort((a, b) => normalizeSpace(a.textContent || "").length - normalizeSpace(b.textContent || "").length);
        return matches[0];
      }
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

    function applyToElement(elm) {
      const full = elm.textContent || "";
      if (full.includes(original)) {
        elm.textContent = full.replace(original, revised);
        return true;
      }
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
    return v === null ? false : v === "1"; // 기본 OFF: 평소엔 조용히, 테스트할 때만 켜서 확인
  }
  function setDebug(roomId, on) {
    localStorage.setItem("zeta-unc-debug-" + roomId, on ? "1" : "0");
  }

  async function computeCorrection(roomId, userText, envelopeText, speakerNames) {
    const debug = getDebug(roomId);

    const rawNote = normalizeSpace(getNote(roomId)) ? getNote(roomId) : "";
    if (!normalizeSpace(rawNote)) { if (debug) toast("📝 유저노트가 비어있어 건너뜀", false); return { skip: true }; }

    const rosterNames = parseRoster(getRoster(roomId));
    const filterResult = filterNoteForSpeakers(rawNote, speakerNames, rosterNames);
    const note = filterResult.text;

    if (!normalizeSpace(note)) {
      if (debug) toast("✅ 등장인물 필터링 결과 이 화자(" + (speakerNames && speakerNames.join(",") || "?") + ")와 관련된 노트 항목 없음 — 건너뜀", false);
      return { skip: true };
    }

    if (debug && filterResult.filtered) {
      toast("🧹 노트 필터링: 전체 " + filterResult.totalCount + "개 항목 중 " + filterResult.keptCount + "개만 대조에 사용 (화자: " + (speakerNames && speakerNames.join(",") || "?") + ")", false);
    }

    const preset = getActivePreset(roomId);
    if (!preset) { toast("❌ 사용할 API 프리셋이 없습니다.", true); return { skip: true }; }

    const mode = getMode(roomId);
    if (debug) toast("⏳ 답변 캡처됨 (" + envelopeText.length + "자, 모드: " + (mode === "full" ? "전체교체" : "find/replace") + ") → AI에 대조 요청 중... (표시가 잠시 지연됩니다)", false);

    try {
      let usage;
      let conflictsFromAi;

      if (mode === "full") {
        const { system, user } = buildFullReplacePrompt(note, userText, envelopeText, speakerNames);
        const aiRes = await callAI(preset, system, user);
        usage = aiRes && aiRes.usage;
        const revisedText = String((aiRes && aiRes.text) || "").trim();

        if (!revisedText) {
          if (debug) toast("⚠ 전체교체 모드: AI 응답이 비어있음", true);
          if (usage) { recordTokenUsage(roomId, usage); refreshTokenUI(); }
          return { skip: true };
        }

        const diff = diffBlocksToConflicts(envelopeText, revisedText);
        if (!diff.safe) {
          if (debug) toast("⚠ 전체교체 모드: " + diff.reason + " — 안전상 전체 폐기", true);
          if (usage) { recordTokenUsage(roomId, usage); refreshTokenUI(); }
          return { skip: true };
        }
        if (debug && diff.notes && diff.notes.length) {
          toast("ℹ 전체교체 diff 참고사항:\n" + diff.notes.join("\n"), false);
        }
        conflictsFromAi = diff.conflicts;
      } else {
        const { system, user } = buildCorrectionPrompt(note, userText, envelopeText, speakerNames);
        const aiRes = await callAI(preset, system, user);
        usage = aiRes && aiRes.usage;
        const raw = aiRes && aiRes.text;
        const parsed = parseModelJson(raw);
        if (!parsed || !Array.isArray(parsed.conflicts)) {
          if (debug) toast("⚠ AI 응답을 JSON으로 못 읽음. 원문 앞부분: " + String(raw || "").slice(0, 150), true);
          if (usage) { recordTokenUsage(roomId, usage); refreshTokenUI(); }
          return { skip: true };
        }
        conflictsFromAi = parsed.conflicts;
      }

      if (usage) {
        const stats = recordTokenUsage(roomId, usage);
        if (debug) {
          toast(
            `🔢 이번 호출 토큰: 입력 ${usage.input} + 출력 ${usage.output} = ${usage.total} ` +
            `(이 방 누적 ${stats.room ? stats.room.total : "?"}, 전체 누적 ${stats.global.total}, ${stats.global.calls}회 호출)`,
            false
          );
        }
        console.log("📝 UserNoteCorrector 토큰 사용:", usage, "누적:", stats);
        refreshTokenUI();
      } else if (debug) {
        toast("ℹ 이 API는 응답에 토큰 사용량을 안 줘서 집계 불가", false);
      }

      if (!conflictsFromAi.length) { if (debug) toast("✅ 대조 완료 — 노트와 모순되는 부분 없음", false); return { skip: true }; }

      const { result, applied, skipped } = applyConflicts(envelopeText, conflictsFromAi);
      if (!applied.length) {
        const reasons = skipped.map((s) => (s.find || "").slice(0, 20) + "→" + s.why).join(" / ");
        if (debug) toast("⚠ AI가 " + skipped.length + "건 제안했지만 전부 안전상 폐기됨: " + reasons, true);
        return { skip: true };
      }
      if (debug) {
        const detail = applied.map((c) =>
          `find: "${(c.find || "").slice(0, 60)}"\n→ replace: "${(c.replace || "").slice(0, 60)}"\n이유: ${c.reason || "(이유 없음)"}`
        ).join("\n\n");
        console.log("📝 UserNoteCorrector 수정 상세:", applied);
        toast("🔧 " + applied.length + "곳 수정됨 (화자: " + (speakerNames && speakerNames.length ? speakerNames.join(",") : "?") + ")\n\n" + detail, false);
      }
      return { skip: false, result, applied, skipped };
    } catch (err) {
      toast("❌ 유저노트 교정 실패: " + (err && err.message || err), true);
      return { skip: true };
    }
  }

  // ---- 최후의 폴백 : 이미 화면에 그려진 뒤 DOM을 찾아 고친다 (Shadow DOM이면 실패할 수 있음) ----
  async function handleCompletedReplyLegacyDom(url, userText, responseText) {
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

    await new Promise((r) => setTimeout(r, 250));
    const outcome = await computeCorrection(roomId, userText, envelope.text, envelope.speakers);
    if (outcome.skip) return;

    let patchedAny = false;
    (outcome.applied || []).forEach((c) => {
      const ok = patchVisibleReply(c.find, c.replace, envelope.messageId, envelope.candidateId);
      if (ok) patchedAny = true;
    });
    if (patchedAny) {
      if (debug) toast("✅ 유저노트 기준으로 " + outcome.applied.length + "곳 수정함", false);
    } else if (debug) {
      const dbg = window.__ZETA_UNC_LAST_DEBUG__ || {};
      toast("⚠ 수정은 계산됐지만 화면 요소를 못 찾음 (shadowRoots:" + (dbg.shadowRoots != null ? dbg.shadowRoots : "?") + ")", true);
    }
  }

  // ---- fetch 후킹 : 응답 전체를 버퍼링해서 AI 대조 → 네트워크 응답 자체를 고쳐서 반환 ----

  const originalFetch = window.fetch.bind(window);

  function passthroughResponse(response, bodyText) {
    return new Response(bodyText, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers
    });
  }

  window.fetch = async function (input, init) {
    const url = typeof input === "string" ? input : (input instanceof URL ? input.href : (input && input.url) || "");
    const method = String((init && init.method) || (input && input.method) || "GET").toUpperCase();
    const isStream = isStreamEndpoint(url, method);

    if (!isStream) {
      // 스트림 엔드포인트가 아닌 다른 zeta API 응답(예: 대화 이력 재조회)도,
      // 예전에 적용했던 교정이 있다면 AI 호출 없이 그대로 재적용한다.
      // 이렇게 해야 스트리밍이 끝난 뒤 다른 API가 원본 텍스트로 화면을 덮어쓰는 것을 막을 수 있다.
      if (!isZetaApiHost(url)) return originalFetch(input, init);
      const corrections = getAllCorrections();
      if (!corrections.length) return originalFetch(input, init);

      const response = await originalFetch(input, init);
      if (!response.ok) return response;
      let rawText;
      try { rawText = await response.text(); } catch { return response; }
      try {
        const patched = patchGenericJsonText(rawText, corrections);
        if (patched.changed) return passthroughResponse(response, patched.text);
        return passthroughResponse(response, rawText);
      } catch {
        return passthroughResponse(response, rawText);
      }
    }

    let userText = "";
    try {
      let bodyStr = "";
      if (init && typeof init.body === "string") bodyStr = init.body;
      else if (typeof Request !== "undefined" && input instanceof Request) bodyStr = await input.clone().text().catch(() => "");
      userText = userTextFromRequestBody(bodyStr);
    } catch {}

    const response = await originalFetch(input, init);
    if (!response.ok) return response;

    const roomId = roomIdFromUrl(url);
    const debug = roomId ? getDebug(roomId) : false;
    if (!roomId || !getEnabled(roomId) || !normalizeSpace(getNote(roomId)) || !getActivePreset(roomId)) {
      return response;
    }

    let rawText;
    try { rawText = await response.text(); } catch { return response; }

    try {
      const envelope = extractReplyEnvelope(rawText);
      if (!envelope.text) {
        if (debug) toast("⚠ 응답에서 답변 텍스트를 못 뽑음", true);
        return passthroughResponse(response, rawText);
      }

      const key = [roomId, envelope.messageId, envelope.candidateId, envelope.text.slice(0, 60)].join("|");
      if (processedKeys.has(key)) { return passthroughResponse(response, rawText); }
      processedKeys.add(key);
      if (processedKeys.size > 300) {
        const it = processedKeys.values();
        for (let i = 0; i < 100; i++) processedKeys.delete(it.next().value);
      }

      const outcome = await computeCorrection(roomId, userText, envelope.text, envelope.speakers);
      if (outcome.skip) return passthroughResponse(response, rawText);

      const patchResult = applyCorrectionsToRawText(rawText, outcome.applied);
      if (patchResult.changed) {
        recordCorrections(roomId, outcome.applied);
        if (debug) toast("✅ 유저노트 기준 " + outcome.applied.length + "곳 수정함 (네트워크 응답에 반영)", false);
        return passthroughResponse(response, patchResult.text);
      }
      if (debug) toast("⚠ 수정은 계산됐지만 응답 본문 안에서 원문을 못 찾아 패치 실패", true);
      return passthroughResponse(response, rawText);
    } catch (err) {
      if (debug) toast("❌ 네트워크 패치 중 오류: " + (err && err.message || err), true);
      return passthroughResponse(response, rawText);
    }
  };

  // ---- XHR 후킹 : 노트+프리셋이 켜진 방이면, 실제 XHR 대신 fetch로 요청을 대신 보내고
  //      완성/교정된 응답을 XHR인 척 흉내내어(readyState/status/responseText 등) 돌려준다.
  //      노트가 꺼진 방은 원래 XHR을 그대로 써서 실시간 스트리밍을 그대로 유지한다.

  function dispatchXhrLifecycle(xhr, opts) {
    function fire(type, init) {
      let ev;
      try { ev = new ProgressEvent(type, init || {}); }
      catch { ev = new Event(type); }
      try { xhr.dispatchEvent(ev); } catch {}
      const handlerName = "on" + type;
      if (typeof xhr[handlerName] === "function") {
        try { xhr[handlerName](ev); } catch {}
      }
    }

    function defineProp(name, value) {
      try { Object.defineProperty(xhr, name, { value, configurable: true }); } catch {}
    }

    if (opts.networkError) {
      defineProp("readyState", 4);
      defineProp("status", 0);
      defineProp("statusText", "");
      fire("readystatechange");
      fire("error");
      fire("loadend");
      return;
    }

    const bodyText = opts.bodyText || "";
    let headerText = "";
    try {
      if (opts.headers && typeof opts.headers.forEach === "function") {
        opts.headers.forEach((v, k) => { headerText += k + ": " + v + "\r\n"; });
      }
    } catch {}

    defineProp("readyState", 4);
    defineProp("status", opts.status || 200);
    defineProp("statusText", opts.statusText || "");
    defineProp("responseURL", opts.responseURL || "");
    defineProp("responseText", bodyText);
    defineProp("response", bodyText);
    xhr.getAllResponseHeaders = () => headerText;
    xhr.getResponseHeader = (name) => {
      try { return opts.headers ? opts.headers.get(name) : null; } catch { return null; }
    };

    fire("readystatechange");
    fire("progress", { lengthComputable: true, loaded: bodyText.length, total: bodyText.length });
    fire("load", { lengthComputable: true, loaded: bodyText.length, total: bodyText.length });
    fire("loadend", { lengthComputable: true, loaded: bodyText.length, total: bodyText.length });
  }

  const OrigXHR = window.XMLHttpRequest;
  const origOpen = OrigXHR.prototype.open;
  const origSend = OrigXHR.prototype.send;
  const origSetRequestHeader = OrigXHR.prototype.setRequestHeader;

  OrigXHR.prototype.open = function (method, url, ...rest) {
    this.__uncMethod = String(method || "GET").toUpperCase();
    this.__uncUrl = url;
    this.__uncHeaders = {};
    return origOpen.call(this, method, url, ...rest);
  };

  OrigXHR.prototype.setRequestHeader = function (name, value) {
    if (this.__uncHeaders) this.__uncHeaders[name] = value;
    return origSetRequestHeader.call(this, name, value);
  };

  OrigXHR.prototype.send = function (body) {
    const isStream = isStreamEndpoint(this.__uncUrl, this.__uncMethod);

    if (!isStream) {
      // 스트림이 아닌 다른 zeta API 요청(예: 대화 이력 재조회)도, 예전에 적용했던
      // 교정이 있으면 AI 호출 없이 그대로 재적용한다. 기록된 교정이 전혀 없으면
      // 평범하게 원래 XHR 그대로 보내서(빠르고 안전) 아무것도 건드리지 않는다.
      if (!isZetaApiHost(this.__uncUrl)) return origSend.call(this, body);
      const corrections = getAllCorrections();
      if (!corrections.length) return origSend.call(this, body);

      const xhrInstance = this;
      const gUrl = xhrInstance.__uncUrl;
      const gHeaders = xhrInstance.__uncHeaders || {};
      const gWithCreds = !!xhrInstance.withCredentials;
      (async () => {
        let response;
        try {
          response = await originalFetch(gUrl, {
            method: xhrInstance.__uncMethod || "GET",
            headers: gHeaders,
            body,
            credentials: gWithCreds ? "include" : "same-origin"
          });
        } catch (err) {
          dispatchXhrLifecycle(xhrInstance, { networkError: true });
          return;
        }
        let rawText = "";
        try { rawText = await response.text(); } catch {}
        let finalText = rawText;
        try {
          const patched = patchGenericJsonText(rawText, corrections);
          if (patched.changed) finalText = patched.text;
        } catch {}
        dispatchXhrLifecycle(xhrInstance, {
          status: response.status,
          statusText: response.statusText,
          responseURL: response.url || gUrl,
          headers: response.headers,
          bodyText: finalText
        });
      })();
      return;
    }

    const url = this.__uncUrl;
    const roomId = roomIdFromUrl(url);
    const active = !!(roomId && getEnabled(roomId) && normalizeSpace(getNote(roomId)) && getActivePreset(roomId));

    if (!active) {
      // 노트/프리셋 없음 → 원래 XHR 그대로 보내서 실시간 스트리밍 유지.
      // 완료 후에는 (혹시 몰라) 레거시 DOM 패치를 한 번 시도해본다.
      const userText = userTextFromRequestBody(requestBodyText(body));
      const boundUrl = url;
      this.addEventListener("loadend", (event) => {
        const req = event.currentTarget;
        if (!req || req.status < 200 || req.status >= 300) return;
        let text = "";
        try { text = String(req.responseText || ""); } catch {}
        handleCompletedReplyLegacyDom(boundUrl, userText, text);
      });
      return origSend.call(this, body);
    }

    // 노트+프리셋 활성 → 진짜 XHR을 보내지 않고, 대신 fetch로 같은 요청을 보내서
    // 완성된 응답을 받은 뒤 교정하고, 그 결과를 XHR 응답인 것처럼 흉내내어 돌려준다.
    const xhrInstance = this;
    const debug = getDebug(roomId);
    const userText = userTextFromRequestBody(requestBodyText(body));
    const headers = xhrInstance.__uncHeaders || {};
    const withCreds = !!xhrInstance.withCredentials;

    (async () => {
      let response;
      try {
        response = await originalFetch(url, {
          method: xhrInstance.__uncMethod || "POST",
          headers,
          body,
          credentials: withCreds ? "include" : "same-origin"
        });
      } catch (err) {
        if (debug) toast("❌ XHR 대체 요청 실패: " + (err && err.message || err), true);
        dispatchXhrLifecycle(xhrInstance, { networkError: true });
        return;
      }

      let rawText = "";
      try { rawText = await response.text(); } catch {}

      let finalText = rawText;
      try {
        const envelope = extractReplyEnvelope(rawText);
        if (envelope.text) {
          const key = [roomId, envelope.messageId, envelope.candidateId, envelope.text.slice(0, 60)].join("|");
          if (!processedKeys.has(key)) {
            processedKeys.add(key);
            if (processedKeys.size > 300) {
              const it = processedKeys.values();
              for (let i = 0; i < 100; i++) processedKeys.delete(it.next().value);
            }
            const outcome = await computeCorrection(roomId, userText, envelope.text, envelope.speakers);
            if (!outcome.skip) {
              const patched = applyCorrectionsToRawText(rawText, outcome.applied);
              if (patched.changed) {
                finalText = patched.text;
                recordCorrections(roomId, outcome.applied);
                if (debug) toast("✅ 유저노트 기준 " + outcome.applied.length + "곳 수정함 (XHR 응답에 반영)", false);
              } else if (debug) {
                toast("⚠ 수정은 계산됐지만 응답 본문 안에서 원문을 못 찾아 패치 실패", true);
              }
            }
          }
        } else if (debug) {
          toast("⚠ 응답에서 답변 텍스트를 못 뽑음", true);
        }
      } catch (err) {
        if (debug) toast("❌ XHR 교정 중 오류: " + (err && err.message || err), true);
      }

      dispatchXhrLifecycle(xhrInstance, {
        status: response.status,
        statusText: response.statusText,
        responseURL: response.url || url,
        headers: response.headers,
        bodyText: finalText
      });
    })();
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
  textarea.roster { height: auto; min-height: 44px; resize: vertical; }
  label { display: block; font-size: 11px; color: #ccc; margin-top: 8px; }
  .hint { font-size: 10px; color: #888; margin-top: 3px; line-height: 1.4; }
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
    <div class="row check">
      <input type="checkbox" id="debugMode" style="width:auto;margin:0;">
      <label style="margin:0;">디버그 로그 보기 (평소엔 꺼두세요)</label>
    </div>

    <label>교정 방식
      <select id="modeSelect">
        <option value="conflict">find/replace (기존 방식, 국소 수정)</option>
        <option value="full">전체 교체 (답변 통째로 다시 쓰게 한 뒤 자동 diff)</option>
      </select>
    </label>
    <div class="hint">전체 교체는 AI가 답변 전체를 다시 쓰지만, 실제 반영 전에 원본과 자동으로 비교해서 바뀐 부분만 안전하게 적용합니다. 블록 개수가 안 맞으면 통째로 폐기됩니다. 토큰 사용량은 find/replace보다 더 많이 듭니다.</div>

    <label>등장인물 목록 (쉼표로 구분, 예: 김젯시,이젯시,박젯시)
      <textarea id="roster" class="roster" placeholder="예: 김젯시,이젯시,박젯시"></textarea>
    </label>
    <div class="hint">여기 적은 이름을 기준으로, 노트 항목마다 "지금 화자와 관련 있는 항목인지"를 자동으로 걸러서 AI에게 넘깁니다. 비워두면 필터링 없이 노트 전체를 매번 넘깁니다.</div>

    <textarea id="note" placeholder="유저노트 글자수가 늘어나면 API 설정란의 토큰 사용량도 같이 늘어납니다.&#10;글자수/비용은 API 설정 탭에서 확인하며 조절하세요.&#10;&#10;노트는 빈 줄로 항목을 구분해서 적어주세요 (등장인물 필터링이 항목 단위로 작동합니다).&#10;&#10;출력 방식/규칙(예: 짧게 출력, 내레이션 금지 등)은 이 기능으로는 반영되지 않습니다."></textarea>
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

    <hr>
    <label style="margin-top:0;">토큰 사용량</label>
    <div class="status" id="tokenStatus">집계 없음</div>
    <div class="row">
      <button id="resetTokens">이 방 토큰 집계 초기화</button>
    </div>
  </div>

  <hr>
  <div class="row"><button id="resetPos">버튼 위치 초기화</button></div>
</div>
`;

  const el = (id) => root.getElementById(id);
  const btnEl = el("btn");
  const panelEl = el("panel");
  const noteEl = el("note");
  const modeSelectEl = el("modeSelect");
  const rosterEl = el("roster");
  const roomEl = el("room");
  const countEl = el("count");
  const savedEl = el("saved");
  const enabledEl = el("enabled");
  const debugModeEl = el("debugMode");
  const presetSelectEl = el("presetSelect");
  const presetNameEl = el("presetName");
  const providerEl = el("provider");
  const apiKeyEl = el("apiKey");
  const modelEl = el("model");
  const baseUrlWrapEl = el("baseUrlWrap");
  const baseUrlEl = el("baseUrl");
  const apiStatusEl = el("apiStatus");
  const tokenStatusEl = el("tokenStatus");

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

  function refreshTokenUI() {
    const room = roomId ? getTokenStats(LS_TOKEN_PREFIX + roomId) : null;
    const global = getTokenStats(LS_TOKEN_GLOBAL_KEY);
    if (!room && !global.calls) {
      tokenStatusEl.className = "status";
      tokenStatusEl.textContent = "집계 없음 (아직 호출 안 됨)";
      return;
    }
    tokenStatusEl.className = "status ok";
    tokenStatusEl.textContent =
      `이 방: 입력 ${room ? room.input : 0} + 출력 ${room ? room.output : 0} = ${room ? room.total : 0} (${room ? room.calls : 0}회)\n` +
      `전체: 입력 ${global.input} + 출력 ${global.output} = ${global.total} (${global.calls}회)`;
  }

  function refreshRoomUI() {
    roomEl.textContent = "Room: " + (roomId ? roomId.slice(0, 24) : "(감지 안 됨)");
    noteEl.value = getNote(roomId);
    modeSelectEl.value = getMode(roomId);
    rosterEl.value = getRoster(roomId);
    enabledEl.checked = getEnabled(roomId);
    debugModeEl.checked = getDebug(roomId);
    updateCount();
    refreshPresetUI();
    refreshTokenUI();
  }

  el("resetTokens").addEventListener("click", () => {
    if (!confirm("이 방의 토큰 집계만 초기화할까요? (전체 누적은 유지됩니다)")) return;
    localStorage.removeItem(LS_TOKEN_PREFIX + roomId);
    refreshTokenUI();
    flashSaved("이 방 토큰 집계 초기화됨");
  });

  noteEl.addEventListener("input", () => { updateCount(); });
  el("saveNote").addEventListener("click", () => {
    saveNote(roomId, noteEl.value);
    saveRoster(roomId, rosterEl.value);
    flashSaved("저장됨");
  });
  enabledEl.addEventListener("change", () => setEnabled(roomId, enabledEl.checked));
  debugModeEl.addEventListener("change", () => setDebug(roomId, debugModeEl.checked));
  modeSelectEl.addEventListener("change", () => setMode(roomId, modeSelectEl.value));

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

  const PRESET_DEFAULTS = {
    provider: "compatible",
    model: "gemma-4-31b",
    baseUrl: "https://api.cerebras.ai/v1/chat/completions"
  };

  function loadPresetIntoForm(preset) {
    presetNameEl.value = preset ? preset.name || "" : "";
    providerEl.value = preset ? preset.provider || PRESET_DEFAULTS.provider : PRESET_DEFAULTS.provider;
    apiKeyEl.value = preset ? preset.apiKey || "" : "";
    modelEl.value = preset ? preset.model || PRESET_DEFAULTS.model : PRESET_DEFAULTS.model;
    baseUrlEl.value = preset ? preset.baseUrl || PRESET_DEFAULTS.baseUrl : PRESET_DEFAULTS.baseUrl;
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
    const preset = {
      id: uuid(), name: "새 프리셋",
      provider: PRESET_DEFAULTS.provider, apiKey: "",
      model: PRESET_DEFAULTS.model, baseUrl: PRESET_DEFAULTS.baseUrl
    };
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
