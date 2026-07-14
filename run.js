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

  // TEXT 콘텐츠에 들어있는 speakerName들을 뽑아낸다 (지금 답변에서 실제로 말하고 있는 캐릭터 이름).
  function extractSpeakerNames(contents) {
    if (!Array.isArray(contents)) return [];
    const names = [];
    contents.forEach((c) => {
      if (c && c.type === "TEXT" && typeof c.speakerName === "string" && c.speakerName.trim()) {
        if (!names.includes(c.speakerName.trim())) names.push(c.speakerName.trim());
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
    let rawContents = null;

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
          rawContents = reply.contents;
        }
      }

      // 리롤("다시 받기") 응답은 CHAT_COMPLETE가 아니라 CANDIDATE_COMPLETE로 온다.
      if (evType === "CANDIDATE_COMPLETE" && event.candidate) {
        const cand = event.candidate;
        if (cand.id) ids.candidateId = String(cand.id);
        if (Array.isArray(cand.contents)) {
          completeText = serializeContents(cand.contents);
          speakers = extractSpeakerNames(cand.contents);
          rawContents = cand.contents;
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

    return { text, requestId: ids.requestId, messageId: ids.messageId, candidateId: ids.candidateId, speakers, contents: rawContents };
  }

  // ==========================================================
  // 0.7 전체 재작성 모드용 포맷 변환
  // (구조화된 JSON contents ↔ "@캐릭터명: *지문* 대사" + ```InfoBox``` 텍스트)
  // ==========================================================

  function contentsToRewriteFormat(contents) {
    const parts = [];
    (contents || []).forEach((c) => {
      if (!c) return;
      if (c.type === "TEXT" && typeof c.text === "string") {
        parts.push(`@${c.speakerName || "?"}: ${c.text}`);
      } else if (c.type === "INFO_BOX") {
        const lines = [];
        (c.scenes || []).forEach((s) => { if (s && typeof s.value === "string") lines.push(`${s.label || ""}: ${s.value}`); });
        (c.characters || []).forEach((ch) => {
          if (!ch) return;
          lines.push(`[${ch.name || "?"}]`);
          (ch.items || []).forEach((it) => { if (it && typeof it.value === "string") lines.push(`${it.label || ""}: ${it.value}`); });
        });
        if (lines.length) parts.push("```InfoBox\n" + lines.join("\n") + "\n```");
      }
    });
    return parts.join("\n");
  }

  // AI가 재작성한 텍스트를, 원본 contents와 최대한 같은 구조(라벨/이모지 등)로 되돌려 파싱한다.
  function rewriteFormatToContents(text, originalContents) {
    let body = String(text || "");
    let infoBoxBlock = null;
    const ibMatch = body.match(/```InfoBox\s*([\s\S]*?)```/i);
    if (ibMatch) {
      infoBoxBlock = ibMatch[1].trim();
      body = (body.slice(0, ibMatch.index) + body.slice(ibMatch.index + ibMatch[0].length)).trim();
    }

    // "@이름: 내용" 구간들을 순서대로 잘라낸다.
    const marks = [];
    const re = /^@([^:\n]{1,30}):[ \t]*/gm;
    let m;
    while ((m = re.exec(body)) !== null) {
      marks.push({ name: m[1].trim(), index: m.index, contentStart: m.index + m[0].length });
    }
    const segments = [];
    for (let i = 0; i < marks.length; i++) {
      const end = i + 1 < marks.length ? marks[i + 1].index : body.length;
      const raw = body.slice(marks[i].contentStart, end).trim();
      if (raw) segments.push({ name: marks[i].name, text: raw });
    }

    const origTextList = (originalContents || []).filter((c) => c && c.type === "TEXT");
    const newContents = segments.map((seg, idx) => {
      const orig = origTextList.find((c) => c.speakerName === seg.name) || origTextList[idx] || origTextList[0];
      return {
        type: "TEXT",
        speakerName: seg.name,
        position: orig ? orig.position : "LEFT",
        text: seg.text
      };
    });

    const origInfoBox = (originalContents || []).find((c) => c && c.type === "INFO_BOX");
    if (infoBoxBlock) {
      const parsed = parseInfoBoxBlock(infoBoxBlock, origInfoBox);
      if (parsed) newContents.push(parsed);
    } else if (origInfoBox) {
      // AI가 상태창을 안 돌려줬으면(누락) 원본 상태창을 그대로 보존한다 — 새로 지어내거나 없애지 않는다.
      newContents.push(origInfoBox);
    }

    return newContents.length ? newContents : null;
  }

  // "라벨: 값" 줄들과 "[캐릭터명]" 헤더로 이루어진 InfoBox 텍스트를 원본과 같은 구조로 되돌린다.
  // 라벨은 최대한 원본의 정확한 문자열(이모지 포함)을 재사용해서, AI가 이모지를 다르게 써도 안전하게 만든다.
  function parseInfoBoxBlock(text, origInfoBox) {
    const origSceneLabels = (origInfoBox && origInfoBox.scenes || []).map((s) => s.label);
    const origCharLabelsByName = {};
    (origInfoBox && origInfoBox.characters || []).forEach((ch) => {
      origCharLabelsByName[ch.name] = (ch.items || []).map((it) => it.label);
    });

    function matchLabel(rawLabel, candidates) {
      const norm = String(rawLabel || "").replace(/[^\p{L}\p{N}]/gu, "");
      const found = (candidates || []).find((c) => String(c || "").replace(/[^\p{L}\p{N}]/gu, "") === norm);
      return found || rawLabel;
    }

    const lines = String(text || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const scenes = [];
    const charMap = {};
    let currentChar = null;
    lines.forEach((line) => {
      const headerMatch = line.match(/^\[(.+)\]$/);
      if (headerMatch) {
        currentChar = headerMatch[1].trim();
        if (!charMap[currentChar]) charMap[currentChar] = [];
        return;
      }
      const kv = line.match(/^(.+?):[ \t]*(.+)$/);
      if (!kv) return;
      const label = kv[1].trim();
      const value = kv[2].trim();
      if (currentChar) {
        const candidates = origCharLabelsByName[currentChar] || [];
        charMap[currentChar].push({ label: matchLabel(label, candidates), value });
      } else {
        scenes.push({ label: matchLabel(label, origSceneLabels), value });
      }
    });

    if (!scenes.length && !Object.keys(charMap).length) return null;
    return {
      type: "INFO_BOX",
      scenes,
      characters: Object.keys(charMap).map((name) => ({ name, items: charMap[name] }))
    };
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
  // 0.5 인증 토큰 캡처 + 로어북/캐릭상세/유저상세 조회
  // (전체 재작성 모드에서 컨텍스트를 직접 가져오기 위해 필요 — 이 스크립트는
  // 원래 응답만 가로챘지, 제타 API에 직접 요청을 보낸 적이 없어서 새로 추가함)
  // ==========================================================

  let capturedAuth = null;
  const plotIdCache = {}; // roomId -> plotId

  function extractAuthFromHeaders(headers) {
    if (!headers) return null;
    try {
      if (typeof headers.get === "function") {
        return headers.get("authorization") || headers.get("Authorization");
      }
      if (Array.isArray(headers)) {
        for (const pair of headers) {
          if (pair && pair[0] && String(pair[0]).toLowerCase() === "authorization") return pair[1];
        }
        return null;
      }
      for (const k in headers) {
        if (k.toLowerCase() === "authorization") return headers[k];
      }
    } catch { /* ignore */ }
    return null;
  }

  const ROOM_URL = (id) => `https://api.zeta-ai.io/v1/rooms/${id}`;
  const PLOT_CREATOR_URL = (id) => `https://api.zeta-ai.io/v1/plots/${id}/creator`;
  const LOREBOOK_URL = (id) => `https://api.zeta-ai.io/v1/lorebooks/${id}`;
  const PROFILES_LIST_URL = (plotId) => `https://api.zeta-ai.io/v1/user-chat-profiles?plotId=${plotId}`;
  const REC_ME_URL = (roomId) => `https://api.zeta-ai.io/v1/rooms/${roomId}/user-plot-chat-profiles/me`;

  async function apiGet(url) {
    if (!capturedAuth) return null;
    try {
      const res = await originalFetch(url, { headers: { "Authorization": capturedAuth } });
      if (!res.ok) return null;
      return await res.json();
    } catch { return null; }
  }

  async function resolvePlotId(roomId) {
    if (plotIdCache[roomId]) return plotIdCache[roomId];
    const data = await apiGet(ROOM_URL(roomId));
    if (data && data.plot && data.plot.id) {
      plotIdCache[roomId] = data.plot.id;
      return data.plot.id;
    }
    return null;
  }

  // {{char}} 상세를 사람이 읽을 수 있는 텍스트로 요약한다.
  async function fetchCharDetailText(plotId) {
    const data = await apiGet(PLOT_CREATOR_URL(plotId));
    const draft = data && data.draft;
    if (!draft) return "";
    const parts = [];
    if (draft.longDescription) parts.push("[기본설정]\n" + draft.longDescription);
    if (draft.narrator) parts.push("[내레이터 설정]\n" + draft.narrator);
    (draft.characters || []).forEach((c) => {
      if (c && c.description) parts.push(`[캐릭터: ${c.name || "?"}]\n` + c.description);
    });
    return { text: parts.join("\n\n"), draft };
  }

  // 이 방에 연결된 로어북들의 항목을 전부 모아 텍스트로 합친다.
  async function fetchLorebookText(lorebookIds) {
    if (!Array.isArray(lorebookIds) || !lorebookIds.length) return { text: "", titles: [] };
    const results = await Promise.all(lorebookIds.map((id) => apiGet(LOREBOOK_URL(id))));
    const parts = [];
    const titles = [];
    results.forEach((lb) => {
      if (!lb) return;
      titles.push(lb.title || "(제목없음)");
      (lb.items || []).forEach((it) => {
        if (it && it.content) parts.push(`[${it.name || "?"}]\n` + it.content);
      });
    });
    return { text: parts.join("\n\n"), titles };
  }

  // 지금 이 방에서 실제로 쓰이고 있는 {{user}} 페르소나 설명을 가져온다
  // (추천 프로필이 선택돼 있으면 그쪽, 아니면 내 페르소나 목록에서 selected:true인 것).
  async function fetchPersonaText(roomId, plotId) {
    const [recMe, list] = await Promise.all([
      apiGet(REC_ME_URL(roomId)),
      apiGet(PROFILES_LIST_URL(plotId))
    ]);
    if (recMe && typeof recMe.description === "string" && recMe.description.trim()) {
      return recMe.description;
    }
    const profiles = list && list.userChatProfiles;
    if (Array.isArray(profiles)) {
      const sel = profiles.find((p) => p && p.selected);
      if (sel && sel.description) return sel.description;
    }
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

  // 이 방에서 지금까지 적용된 교정 내역을 최신순으로 돌려준다 (테스트 중 "뭐가 바뀌었나" 확인용).
  function getCorrectionHistory(roomId) {
    if (!roomId) return [];
    const list = safeJsonParse(localStorage.getItem(LS_CORR_PREFIX + roomId), []) || [];
    return list.slice().sort((a, b) => (b.ts || 0) - (a.ts || 0));
  }
  // 이력에서 항목 하나만 삭제 (실제 "적용된 교정 기억"에서도 같이 지운다 — 다시 덮어써도 되는 항목이라는 뜻).
  function deleteCorrectionEntry(roomId, find) {
    if (!roomId) return;
    const key = LS_CORR_PREFIX + roomId;
    const list = safeJsonParse(localStorage.getItem(key), []) || [];
    const next = list.filter((x) => x.find !== find);
    try { localStorage.setItem(key, JSON.stringify(next)); } catch {}
  }
  function clearCorrectionHistory(roomId) {
    if (!roomId) return;
    localStorage.removeItem(LS_CORR_PREFIX + roomId);
  }

  // ---- 전체 재작성 모드의 원본/재작성 이력 (디버그 모드일 때만 쌓임 — 평소엔 저장 안 함) ----
  const LS_REWRITE_PREFIX = "zeta-unc-rewrites-";

  function recordRewriteHistory(roomId, entry) {
    if (!roomId || !entry || !entry.original || !entry.rewritten) return;
    const key = LS_REWRITE_PREFIX + roomId;
    const list = safeJsonParse(localStorage.getItem(key), []) || [];
    list.push({ original: entry.original, rewritten: entry.rewritten, ts: Date.now() });
    while (list.length > 30) list.shift(); // 전체 텍스트라 용량이 크므로 최근 30건만 유지
    try { localStorage.setItem(key, JSON.stringify(list)); } catch {}
  }
  function getRewriteHistory(roomId) {
    if (!roomId) return [];
    const list = safeJsonParse(localStorage.getItem(LS_REWRITE_PREFIX + roomId), []) || [];
    return list.slice().sort((a, b) => (b.ts || 0) - (a.ts || 0));
  }
  function deleteRewriteEntry(roomId, ts) {
    if (!roomId) return;
    const key = LS_REWRITE_PREFIX + roomId;
    const list = safeJsonParse(localStorage.getItem(key), []) || [];
    const next = list.filter((x) => x.ts !== ts);
    try { localStorage.setItem(key, JSON.stringify(next)); } catch {}
  }
  function clearRewriteHistory(roomId) {
    if (!roomId) return;
    localStorage.removeItem(LS_REWRITE_PREFIX + roomId);
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

  function buildCorrectionPrompt(note, userText, originalReply, speakerNames, ctx) {
    const speakerLine = (Array.isArray(speakerNames) && speakerNames.length)
      ? speakerNames.join(", ")
      : "(알 수 없음)";
    ctx = ctx || {};

    const system = [
      "당신은 대화 로그 검수자다. 아래 [유저노트]에 적힌 확정 사실·현재 상태와, [제타 원본 답변]을 대조한다.",
      "[로어북], [캐릭터 상세], [{{user}} 상세]가 같이 주어지면, 그건 모순 판단을 돕는 참고 자료일 뿐이다.",
      "이 참고 자료에만 있고 [유저노트]에는 없는 내용을 근거로 새로 문구를 만들어내지 않는다 — 여전히 [유저노트]와의",
      "명백한 모순만 고친다. 참고 자료는 그 모순이 실제로 캐릭터/설정과 앞뒤가 맞는지 확인하는 용도로만 쓴다.",
      "[지금 답변하는 캐릭터]는 이번 답변에서 실제로 말하고 있는 인물이다.",
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
      "6. replace는 모순만 해소하도록 최소한으로 고친 문장/값이며, 원본의 문체와 어울려야 한다. [로어북]/[캐릭터 상세]에",
      "   적힌 말투·성격과도 어긋나지 않게 쓴다.",
      "7. 유저노트 문장에 '어제/오늘/방금/지금' 같은 시간 표현이 있으면, 그 문장이 뜻하는 현재 상태까지 추론해서 대조한다.",
      "   (예: 노트에 '어제 부산에 놀러갔다가 오늘 집에 옴'이라고 적혀있는데, 원본 답변이 화자가 여전히 부산에 있는 것처럼",
      "   서술하면 -- '지금은 집에 있어야 한다'는 함의와 모순되는 것으로 본다.) 단, 노트에 안 적힌 화제까지 추측해서",
      "   새로 만들어내지는 않는다 -- 오직 노트 문장이 실제로 뜻하는 현재 상태와의 모순만 본다.",
      "8. [유저노트]의 각 문장이 누구에 관한/누구 사이의 사건인지 먼저 판단한다. 그 사건의 당사자가 아니거나,",
      "   그 사건을 알고 있다는 근거가 원본 답변 안에 없는 [지금 답변하는 캐릭터]의 대사에, 표현이 우연히 비슷하다는",
      "   이유만으로 그 노트 내용을 끼워넣지 않는다. (예: '재하가 승아에게 고백했다가 거절당했다'는 재하·승아 둘만의",
      "   사건인데, 완전히 다른 화제로 말하던 선우의 대사에 이 내용을 갖다 붙이지 않는다.) 노트가 명시한 당사자 본인의",
      "   발언이거나, 원본 답변 자체에 그 인물이 그 사건을 알고 있다는 명확한 근거가 있을 때만 적용한다.",
      "9. 수정을 반영했을 때, 그 수정 내용이 [제타 원본 답변]의 다른 부분과 새로 모순을 만들면 안 된다.",
      "   만약 원본 안에 이미 있는 다른 문구가 지금 고치려는 내용과 서로 충돌한다면(예: 한쪽은 '아직 고백 안 함',",
      "   다른 한쪽은 '이미 고백함'), 그 충돌하는 다른 부분도 conflicts에 같이 추가해서 답변 전체가 앞뒤가",
      "   맞도록 만든다. 한 군데만 고치고 바로 근처의 모순을 그대로 방치하지 않는다.",
      "10. replace를 만들 때 [유저노트]의 문장을 그대로 베껴쓰지 않는다. 유저노트는 사실을 정리해둔 메모일 뿐,",
      "    실제 대사가 아니다. [지금 답변하는 캐릭터]가 [이번 유저 메시지]를 보낸 상대에게 지금 이 순간 직접",
      "    말하는 것처럼, 시제(과거형으로 쓰여있어도 '지금도 그렇다'는 뜻이면 현재형으로)와 인칭(노트에 3인칭으로",
      "    적혀있어도 화자 본인 얘기면 '나는', 상대방 얘기면 '너는'으로)을 자연스럽게 바꿔서 쓴다.",
      "    (예: 노트에 '재하는 승아를 3년동안 좋아했다'라고 적혀있어도, 재하 본인이 승아에게 직접 말하는",
      "    상황이면 '나 너 3년 동안 좋아했어' 처럼 화자-청자 관계에 맞게 바꿔서 자연스러운 대사로 만든다.)",
      "11. 유저노트 원문에 '~도', '역시', '마찬가지로'처럼 다른 인물과 비교하거나 같은 처지임을 나타내는",
      "    표현이 있으면, replace에도 그 뉘앙스를 그대로 살린다. 이런 표현을 빼고 밋밋한 단정문으로 바꾸지 않는다.",
      "    (예: 노트에 '선우도(재하처럼) 3년 동안 좋아했다'라고 적혀있으면, replace도 '나는 3년 동안'이 아니라",
      "    '나도 3년 동안'처럼 비교/공유의 의미를 유지해서 쓴다.)",
      "12. 노트에 적힌 사건을 [이번 유저 메시지]를 보낸 상대방(청자) 본인이 이미 직접 겪은 당사자라면,",
      "    그 사건을 상대방이 몰랐던 새로운 정보인 것처럼 처음부터 다시 설명/나열하는 문장을 만들지 않는다.",
      "    (예: 승아 본인이 재하에게 고백받고 거절한 당사자인데, 승아에게 '재하가 너한테 고백했었고, 너도",
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
      "[로어북]",
      ctx.lorebookText || "(없음)",
      "",
      "[캐릭터 상세]",
      ctx.charDetailText || "(없음)",
      "",
      "[{{user}} 상세]",
      ctx.personaText || "(없음)",
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
  // 2.7 전체 재작성 모드 — find/replace가 아니라 답변 전체를 다시 씀.
  // 로어북/{{char}} 상세/{{user}} 상세/유저노트를 전부 컨텍스트로 같이 준다.
  // ==========================================================

  const FULL_REWRITE_SYSTEM_PROMPT = [
    "[최우선 지시] 아래에 문체/분량/형식을 다듬는 규칙들이 이어지는데, 그보다 먼저 확인할 것이 있다.",
    "이번 입력에는 [유저노트]라는 확정된 사실/현재 상태 메모가 같이 주어진다. [검토 대상 답변]에 그 노트와",
    "명백히 모순되는 문장(예: 노트엔 이미 아는 사실인데 처음 알려주듯 말함, 노트가 말한 사실과 반대로 말함,",
    "노트에 없는 사람의 사적인 일을 엉뚱한 화자가 아는 것처럼 말함 등)이 있으면, 그 부분의 사실관계를 노트에",
    "맞게 반드시 바로잡은 채로 재작성한다. 이건 아래 '사건 진행/의미를 원문과 동일하게 유지하라'는 규칙보다",
    "우선한다 — 그 규칙은 '문체를 다듬으면서 원래 의도를 왜곡하지 마라'는 뜻이지, '사실 오류까지 그대로",
    "베끼라'는 뜻이 아니다. 노트가 다루지 않는 화제는 그대로 두고 새로 추가하지 않는다.",
    "",
    "수정 답변은 제타 수정창에 그대로 넣을 수 있는 본문만 작성한다.",
    "검토 설명, 수정 이유, 제목, 항목 구분, 해설은 출력하지 않는다.",
    "",
    "출력은 가능하면 하나의 대화 말풍선에 통합한다.",
    "형식은 기본적으로 `@캐릭터명: 내용`을 유지한다.",
    "나래이터 단독 출력은 최소화하고, 필요한 지문은 해당 캐릭터 말풍선 안에 함께 넣는다.",
    "",
    "지문은 반드시 `*...*` 안에 작성한다.",
    "지문 문장 끝맺음은 서술형 `~다` 체를 기본으로 한다.",
    "예: `@캐릭터명: *잠시 시선을 내리깐다.* 그래서, 네 말은 그게 전부인가.`",
    "",
    "긴 지문은 압축한다.",
    "불필요한 심리 설명, 배경 설명, 반복 행동은 줄이고, 행동 중심으로 정리한다.",
    "예: `그는 당황한 듯 숨을 들이마시고, 손끝을 떨며 시선을 피했다.` → `*숨을 삼키며 시선을 피한다.*`",
    "",
    "중복 감정 표현은 하나로 합친다.",
    "`불안했다, 초조했다, 마음이 흔들렸다`처럼 겹치는 감정은 반복 설명하지 말고, 행동 하나로 보여준다.",
    "",
    "대사는 함부로 줄이지 않는다.",
    "캐릭터의 말투, 위압감, 플러팅, 거친 느낌, 비꼬는 뉘앙스는 유지한다.",
    "짧게 정리할 때도 대사를 단답으로 만들지 말고, 주로 지문을 덜어내는 방식으로 압축한다.",
    "",
    "말풍선 수를 과하게 늘리지 않는다.",
    "가능하면 1개 말풍선 안에 정리하고, 길어질 경우에만 감정 변화나 행동 전환 기준으로 2~3개 정도로 나눈다.",
    "짧은 나래이터 말풍선 `@:`는 가급적 캐릭터 말풍선 안의 지문으로 흡수한다.",
    "",
    "사건 진행은 바꾸지 않는다 (단, 위 [최우선 지시]에 따른 사실관계 교정은 예외).",
    "행동 순서, 관계성, 감정 방향, 대사 의미는 원문과 동일하게 유지한다.",
    "새 사건을 만들거나 분위기를 순하게 바꾸지 않는다.",
    "",
    "최종 출력은 아래 형식에 가깝게 작성한다.",
    "",
    "`@캐릭터명: *지문을 짧게 정리한다.* 대사를 이어서 작성한다. *필요한 행동이나 분위기만 덧붙인다.* 이어지는 대사를 작성한다.`",
    "",
    "로어북의 캐릭터 성격과 관계성을 최우선으로 유지한다.",
    "",
    "캐릭터가 원래 하지 않을 법한 말투나 행동으로 순화하지 않는다.",
    "차갑게 말하는 캐릭터는 차가운 결을 유지하고, 능글맞은 캐릭터는 능글맞은 여유를 유지하며, 다정한 캐릭터는 다정함을 유지한다.",
    "단, 과장해서 다른 성격처럼 보이게 만들지는 않는다.",
    "",
    "{{char}}와 {{user}}의 현재 관계 단계를 유지한다.",
    "아직 어색한 관계라면 갑자기 과하게 친밀하게 만들지 않고, 이미 가까운 관계라면 불필요하게 거리감을 되돌리지 않는다.",
    "호감, 긴장감, 신뢰, 오해, 경계심, 미련 등 현재 감정선을 원문보다 약하게 만들지 않는다.",
    "",
    "대사의 의미와 감정 방향은 유지한다.",
    "수정 과정에서 캐릭터의 의도, 주도권, 반응 강도, 플러팅 수위, 갈등의 날카로움, 장면의 긴장감을 임의로 바꾸지 않는다.",
    "필요한 경우 지문만 줄이고, 캐릭터의 핵심 대사는 최대한 보존한다.",
    "",
    "로어북과 충돌하는 부분은 자연스럽게 고치되, 설명문처럼 티 나게 수정하지 않는다.",
    "설정 보정은 캐릭터가 실제로 그 상황에서 할 법한 말과 행동 안에 녹인다.",
    "",
    "최종 답변은 \u201c설정에 맞는 설명\u201d이 아니라 \u201c캐릭터가 실제로 이어서 말하고 행동하는 장면\u201d처럼 작성한다.",
    "",
    "인접한 지문 블록은 분리하지 말고 연결한다.",
    "`*지문* *지문* 대사 *지문*`처럼 지문이 연속으로 두 번 이상 나오는 출력은 피한다.",
    "같은 말풍선 안에서 지문이 이어질 경우 하나의 `*...*` 안에 합치거나, 중간에 자연스러운 대사를 배치해 `*지문* 대사 *지문*` 흐름으로 정리한다.",
    "예: `*고개를 숙인다.* *손끝이 떨린다.* 괜찮아.` → `*고개를 숙인 채 떨리는 손끝을 감춘다.* 괜찮아.`",
    "",
    "여성향 로맨스 톤을 우선한다.",
    "{{user}}를 성적 대상, 소유물, 감정 배출구처럼 다루지 않는다.",
    "{{user}}의 감정, 망설임, 거절, 선택권, 거리감을 존중한다.",
    "로맨스는 신체 소비보다 감정선, 말투, 시선, 거리감, 배려, 긴장감, 관계 변화로 표현한다.",
    "",
    "여성비하적 욕설, 성적 모욕, 성별 고정관념에 기반한 비난은 사용하지 않는다.",
    "여성비하 욕설, 성적 경험을 비난하는 표현, 순결이나 몸가짐을 평가하는 표현, 여성을 낮춰 부르는 표현은 캐릭터 말투가 거칠더라도 출력하지 않는다.",
    "거친 말투가 필요할 경우 성별 비하가 아닌 일반적인 감정 표현, 냉소, 비꼼, 짧은 압박감으로 대체한다.",
    "",
    "남성향식 신체 대상화 묘사를 피한다.",
    "{{user}}를 몸매 평가, 성적 훑어보기, 순결성 평가, 소유물처럼 보는 시선으로 묘사하지 않는다.",
    "{{user}}를 묘사할 때는 신체보다 표정, 시선, 목소리, 태도, 망설임, 감정 변화, 거리감 중심으로 작성한다.",
    "",
    "캐릭터 신체 묘사는 여성향 로맨스 톤에 맞게 사용한다.",
    "{{char}}가 성인 캐릭터일 경우, {{char}}의 신체와 매력은 비교적 노골적으로 묘사할 수 있다.",
    "단, {{char}}의 신체 묘사는 단순한 부위 나열이나 감상문처럼 쓰지 않고, 장면의 감정선, 긴장감, 욕망, 거리감, 안정감, 위험한 매력을 살리는 방향으로 작성한다.",
    "{{char}}의 신체 조건이 캐릭터성에 중요한 경우에는 체격, 움직임, 힘의 균형, 존재감, 분위기를 더 선명하게 묘사할 수 있다.",
    "묘사는 대사와 감정 흐름을 방해하지 않도록 장면 안에 자연스럽게 배치한다.",
    "",
    "{{char}}의 노골적인 신체 묘사는 허용하되, {{user}}를 성적 대상이나 소유물처럼 소비하는 방향으로 이어지지 않게 한다.",
    "{{char}}가 {{user}}를 바라보는 장면에서도 몸매 평가, 성적 훑어보기, 순결성 평가, 여성비하적 표현, 소유물화 표현은 피한다.",
    "로맨스의 욕망은 {{user}}를 깎아내리거나 소비하는 방식이 아니라, {{char}}의 절제, 흔들림, 시선, 말투, 거리 조절, 감정선으로 표현한다.",
    "",
    "스킨십과 플러팅은 관계 단계와 장면의 동의 분위기에 맞게 작성한다.",
    "갑작스러운 강압적 접촉, 원치 않는 밀착, 위협을 로맨틱하게 포장하지 않는다.",
    "집착, 질투, 소유욕이 필요한 캐릭터라도 폭력, 협박, 모욕, 통제욕을 매력처럼 미화하지 않는다.",
    "불안정한 감정은 말투, 침묵, 시선, 거리감, 행동의 절제로 표현한다.",
    "",
    "{{user}}를 지나치게 수동적이거나 무조건 부끄러워하는 인물로 고정하지 않는다.",
    "{{user}}는 받아치거나, 거리를 두거나, 솔직하게 흔들리거나, 장난스럽게 넘기거나, 단호하게 거절할 수 있다.",
    "캐릭터의 매력은 {{user}}의 주체성을 꺾는 방식이 아니라, 관계 안에서 긴장과 감정선을 만드는 방식으로 드러낸다.",
    "",
    "말풍선 수를 과하게 늘리지 않는다.",
    "",
    "[상태창 처리 규칙]",
    "",
    "상태창 출력 형식",
    "```InfoBox",
    "내용",
    "```",
    "",
    "최근 대화 또는 검토 대상 답변에 상태창이 포함되어 있다면, 수정 답변에서도 상태창을 유지한다.",
    "",
    "상태창은 삭제하지 말고, 기존 상태창의 형식과 항목 구조를 최대한 그대로 따른다.",
    "단, 답변 본문을 수정하면서 감정, 관계, 위치, 분위기, 상태 수치, 약속, 진행 상황 등이 달라졌다면 그 변경 내용을 반영해 상태창 내용도 자연스럽게 갱신한다.",
    "",
    "상태창은 단순 복붙이 아니라, 수정된 답변 본문과 충돌하지 않도록 함께 검토한다.",
    "본문에서는 감정이 누그러졌는데 상태창에는 극단적인 감정이 남아 있거나, 본문에서는 거리가 가까워졌는데 상태창에는 거리감이 유지되는 식의 불일치가 없도록 한다.",
    "",
    "다만 상태창에 확정되지 않은 정보, 유저의 속마음 단정, 유저 행동 대리 서술을 새로 추가하지 않는다.",
    "수정된 답변과 직접 관련 없는 상태창 항목은 기존 내용을 유지하거나 최소한으로만 정리한다.",
    "",
    "상태창이 원문에 없었다면 새로 만들지 않는다.",
    "상태창이 원문에 있었다면 최종 출력에도 상태창을 포함한다.",
    "",
    "위 규칙에 더해: 아래 [유저노트]에 적힌 사실과 명백히 모순되는 부분이 있으면 자연스럽게 같이 바로잡는다.",
    "노트에 없는 화제는 새로 추가하지 않는다. [로어북]과 [캐릭터 상세]도 참고해서 캐릭터 성격/설정과 어긋나지 않게 한다.",
    "노트에 적힌 사건이 [{{user}} 상세]로 표시된 그 사람 본인이 이미 직접 겪은 일이면, 새삼스럽게 그 사람에게 다시 설명하듯 나열하지 않는다."
  ].join("\n");

  function buildFullRewritePrompt(ctx, userText, originalReplyFormatted) {
    const speakerLine = (Array.isArray(ctx.speakerNames) && ctx.speakerNames.length) ? ctx.speakerNames.join(", ") : "(알 수 없음)";
    const user = [
      "[지금 답변하는 캐릭터]",
      speakerLine,
      "",
      "[로어북]",
      ctx.lorebookText || "(없음)",
      "",
      "[캐릭터 상세]",
      ctx.charDetailText || "(없음)",
      "",
      "[{{user}} 상세]",
      ctx.personaText || "(없음)",
      "",
      "[유저노트]",
      ctx.note || "(없음)",
      "",
      "[이번 유저 메시지]",
      userText || "(없음)",
      "",
      "[검토 대상 답변]",
      originalReplyFormatted
    ].join("\n");
    return { system: FULL_REWRITE_SYSTEM_PROMPT, user };
  }

  // 방(roomId)별로 로어북/{{char}} 상세를 캐싱한다 (매 메시지마다 새로 긁어오면 느리고 API 호출도 낭비).
  // {{user}} 상세(페르소나)는 자주 바뀔 수 있어서 완전히 캐싱하진 않지만, 매 메시지마다 다시 긁어오면 그것도
  // 느려지므로 PERSONA_TTL_MS 동안만 짧게 캐싱한다 (그 안에 프로필을 바꿨으면 새로고침 버튼으로 강제 갱신).
  const roomContextCache = {};
  const personaCache = {}; // roomId -> { text, ts }
  const PERSONA_TTL_MS = 60000;

  async function getRoomContext(roomId, forceRefresh) {
    if (!forceRefresh && roomContextCache[roomId]) return roomContextCache[roomId];
    const plotId = await resolvePlotId(roomId);
    if (!plotId) return null;
    const charResult = await fetchCharDetailText(plotId);
    const lorebookIds = charResult && charResult.draft && charResult.draft.lorebookIds;
    const lb = await fetchLorebookText(lorebookIds);
    const ctx = {
      plotId,
      charName: (charResult && charResult.draft && charResult.draft.name) || "",
      charDetailText: (charResult && charResult.text) || "",
      lorebookText: lb.text || "",
      lorebookTitles: lb.titles || []
    };
    roomContextCache[roomId] = ctx;
    return ctx;
  }

  async function getPersonaTextCached(roomId, plotId, forceRefresh) {
    const cached = personaCache[roomId];
    if (!forceRefresh && cached && (Date.now() - cached.ts) < PERSONA_TTL_MS) return cached.text;
    const text = await fetchPersonaText(roomId, plotId);
    personaCache[roomId] = { text, ts: Date.now() };
    return text;
  }

  // 구조화된 contents(TEXT+INFO_BOX)를 통째로 교체하는 패치 — find/replace가 아니라
  // 최종 완성 블록(CHAT_COMPLETE/CANDIDATE_COMPLETE)의 contents 자체를 새 것으로 바꿔치기한다.
  function patchStructuredContents(rawText, envelope, newContents) {
    const parts = String(rawText || "").split(/(\r?\n\r?\n)/);
    let changed = false;

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

      const evType = String(parsed.event || "").toUpperCase();
      let touched = false;
      if (evType === "CHAT_COMPLETE" && parsed.replyMessage && envelope.messageId && String(parsed.replyMessage.id) === envelope.messageId) {
        parsed.replyMessage.contents = newContents;
        touched = true;
      }
      if (evType === "CANDIDATE_COMPLETE" && parsed.candidate && envelope.candidateId && String(parsed.candidate.id) === envelope.candidateId) {
        parsed.candidate.contents = newContents;
        touched = true;
      }
      if (!touched) return part;

      changed = true;
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

    return { text: rebuilt.join(""), changed };
  }

  // 전체 재작성 모드의 메인 파이프라인. 성공하면 { skip:false, newContents }를 돌려준다.
  async function computeFullRewrite(roomId, userText, envelope) {
    const debug = getDebug(roomId);
    const note = normalizeSpace(getNote(roomId));
    if (!note) { if (debug) toast("📝 유저노트가 비어있어 건너뜀", false); return { skip: true }; }

    const preset = getActivePreset(roomId);
    if (!preset) { toast("❌ 사용할 API 프리셋이 없습니다.", true); return { skip: true }; }

    if (!capturedAuth) { if (debug) toast("⚠ 아직 인증 토큰을 못 잡아서 로어북/캐릭상세를 못 가져옴", true); return { skip: true }; }

    const t0 = performance.now();
    const roomCtx = await getRoomContext(roomId);
    if (!roomCtx) { if (debug) toast("⚠ plotId/캐릭터 상세를 못 가져옴", true); return { skip: true }; }

    const personaText = await getPersonaTextCached(roomId, roomCtx.plotId);
    const tCtx = performance.now();

    const originalFormatted = contentsToRewriteFormat(envelope.contents);
    if (!originalFormatted) { if (debug) toast("⚠ 원본 답변을 재작성용 포맷으로 변환 못 함", true); return { skip: true }; }

    if (debug) toast(`⏳ 전체 재작성 모드: 컨텍스트(로어북 ${roomCtx.lorebookText.length}자 + 캐릭상세 ${roomCtx.charDetailText.length}자) 포함해서 AI 호출 중... (컨텍스트 준비 ${Math.round(tCtx - t0)}ms)`, false);

    try {
      const { system, user } = buildFullRewritePrompt(
        { lorebookText: roomCtx.lorebookText, charDetailText: roomCtx.charDetailText, personaText, note, speakerNames: envelope.speakers },
        userText,
        originalFormatted
      );
      const aiRes = await callAI(preset, system, user);
      const tAi = performance.now();
      const rewritten = aiRes && aiRes.text;
      const usage = aiRes && aiRes.usage;

      if (usage) {
        const stats = recordTokenUsage(roomId, usage);
        if (debug) {
          toast(`🔢 이번 호출 토큰: 입력 ${usage.input} + 출력 ${usage.output} = ${usage.total} (이 방 누적 ${stats.room ? stats.room.total : "?"}) / AI 호출 ${Math.round(tAi - tCtx)}ms, 총 ${Math.round(tAi - t0)}ms`, false);
        }
        refreshTokenUI();
      }

      if (!rewritten || !rewritten.trim()) {
        if (debug) toast("⚠ AI가 빈 응답을 줌", true);
        return { skip: true };
      }

      const newContents = rewriteFormatToContents(rewritten, envelope.contents);
      if (!newContents || !newContents.length) {
        if (debug) toast("⚠ AI 응답을 구조화된 답변으로 못 되돌림. 원문 앞부분: " + rewritten.slice(0, 150), true);
        return { skip: true };
      }

      if (debug) {
        console.log("📝 UserNoteCorrector 전체 재작성 결과:", { original: originalFormatted, rewritten, newContents });
        toast("🔧 전체 재작성됨\n\n[원본]\n" + originalFormatted.slice(0, 300) + "\n\n[재작성]\n" + rewritten.slice(0, 300), false);
        recordRewriteHistory(roomId, { original: originalFormatted, rewritten });
      }

      return { skip: false, newContents };
    } catch (err) {
      toast("❌ 전체 재작성 실패: " + (err && err.message || err), true);
      return { skip: true };
    }
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

  function getFullRewriteMode(roomId) {
    return localStorage.getItem("zeta-unc-fullrewrite-" + roomId) === "1";
  }
  function setFullRewriteMode(roomId, on) {
    localStorage.setItem("zeta-unc-fullrewrite-" + roomId, on ? "1" : "0");
  }

  async function computeCorrection(roomId, userText, envelopeText, speakerNames) {
    const debug = getDebug(roomId);

    const note = normalizeSpace(getNote(roomId));
    if (!note) { if (debug) toast("📝 유저노트가 비어있어 건너뜀", false); return { skip: true }; }

    const preset = getActivePreset(roomId);
    if (!preset) { toast("❌ 사용할 API 프리셋이 없습니다.", true); return { skip: true }; }

    // 부분 수정(find/replace) 모드도 전체 재작성 모드와 동일하게 로어북/캐릭터 상세/{{user}} 상세를 참고 자료로 같이 준다.
    // 이 컨텍스트를 못 가져와도(토큰 미확보, 네트워크 실패 등) 기능이 죽지 않고 노트만으로 대조를 계속한다.
    const t0 = performance.now();
    let ctx = {};
    if (capturedAuth) {
      try {
        const roomCtx = await getRoomContext(roomId);
        if (roomCtx) {
          const personaText = await getPersonaTextCached(roomId, roomCtx.plotId);
          ctx = { lorebookText: roomCtx.lorebookText, charDetailText: roomCtx.charDetailText, personaText };
          if (debug) toast(`🔗 컨텍스트 포함: 로어북 ${roomCtx.lorebookText.length}자 + 캐릭상세 ${roomCtx.charDetailText.length}자 + 유저상세 ${(personaText || "").length}자 (준비 ${Math.round(performance.now() - t0)}ms)`, false);
        } else if (debug) {
          toast("⚠ plotId/캐릭터 상세를 못 가져와서 노트만으로 대조함", false);
        }
      } catch (err) {
        if (debug) toast("⚠ 로어북/캐릭상세 로딩 실패, 노트만으로 대조함: " + (err && err.message || err), false);
      }
    } else if (debug) {
      toast("⚠ 아직 인증 토큰을 못 잡아서 노트만으로 대조함", false);
    }
    const tCtx = performance.now();

    if (debug) toast("⏳ 답변 캡처됨 (" + envelopeText.length + "자) → AI에 대조 요청 중... (표시가 잠시 지연됩니다)", false);

    try {
      const { system, user } = buildCorrectionPrompt(note, userText, envelopeText, speakerNames, ctx);
      const aiRes = await callAI(preset, system, user);
      const tAi = performance.now();
      const raw = aiRes && aiRes.text;
      const usage = aiRes && aiRes.usage;

      if (usage) {
        const stats = recordTokenUsage(roomId, usage);
        if (debug) {
          toast(
            `🔢 이번 호출 토큰: 입력 ${usage.input} + 출력 ${usage.output} = ${usage.total} ` +
            `(이 방 누적 ${stats.room ? stats.room.total : "?"}, 전체 누적 ${stats.global.total}, ${stats.global.calls}회 호출) ` +
            `/ 컨텍스트 준비 ${Math.round(tCtx - t0)}ms, AI 호출 ${Math.round(tAi - tCtx)}ms, 총 ${Math.round(tAi - t0)}ms`,
            false
          );
        }
        console.log("📝 UserNoteCorrector 토큰 사용:", usage, "누적:", stats);
        refreshTokenUI();
      } else if (debug) {
        toast("ℹ 이 API는 응답에 토큰 사용량을 안 줘서 집계 불가 (컨텍스트 준비 " + Math.round(tCtx - t0) + "ms, AI 호출 " + Math.round(tAi - tCtx) + "ms)", false);
      }

      const parsed = parseModelJson(raw);
      if (!parsed || !Array.isArray(parsed.conflicts)) {
        if (debug) toast("⚠ AI 응답을 JSON으로 못 읽음. 원문 앞부분: " + String(raw || "").slice(0, 150), true);
        return { skip: true };
      }
      if (!parsed.conflicts.length) { if (debug) toast("✅ 대조 완료 — 노트와 모순되는 부분 없음", false); return { skip: true }; }

      const { result, applied, skipped } = applyConflicts(envelopeText, parsed.conflicts);
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

    try {
      const headers = (init && init.headers) || (typeof input !== "string" && input && input.headers);
      const authVal = extractAuthFromHeaders(headers);
      if (authVal) capturedAuth = authVal;
    } catch { /* ignore */ }

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

      const outcome = getFullRewriteMode(roomId)
        ? await computeFullRewrite(roomId, userText, envelope)
        : await computeCorrection(roomId, userText, envelope.text, envelope.speakers);
      if (outcome.skip) return passthroughResponse(response, rawText);

      if (outcome.newContents) {
        const structResult = patchStructuredContents(rawText, envelope, outcome.newContents);
        if (structResult.changed) {
          if (debug) toast("✅ 전체 재작성 반영됨 (네트워크 응답에 반영)", false);
          return passthroughResponse(response, structResult.text);
        }
        if (debug) toast("⚠ 재작성은 계산됐지만 응답 본문 안에서 해당 메시지를 못 찾아 패치 실패", true);
        return passthroughResponse(response, rawText);
      }

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
    if (name && name.toLowerCase() === "authorization") capturedAuth = value;
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
            const outcome = getFullRewriteMode(roomId)
              ? await computeFullRewrite(roomId, userText, envelope)
              : await computeCorrection(roomId, userText, envelope.text, envelope.speakers);
            if (!outcome.skip) {
              if (outcome.newContents) {
                const structResult = patchStructuredContents(rawText, envelope, outcome.newContents);
                if (structResult.changed) {
                  finalText = structResult.text;
                  if (debug) toast("✅ 전체 재작성 반영됨 (XHR 응답에 반영)", false);
                } else if (debug) {
                  toast("⚠ 재작성은 계산됐지만 응답 본문 안에서 해당 메시지를 못 찾아 패치 실패", true);
                }
              } else {
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

  #histWrap.hidden { display: none; }
  .hist-toolbar { display: flex; justify-content: space-between; align-items: center; margin-top: 8px; }
  .hist-toolbar span { font-size: 10px; color: #999; }
  .hist-list { max-height: 32vh; overflow-y: auto; margin-top: 6px; display: flex; flex-direction: column; gap: 6px; }
  .hist-item { background: #0d0d10; border: 1px solid #333; border-radius: 8px; padding: 6px 8px; }
  .hist-item .hist-time { font-size: 9px; color: #999; margin-bottom: 4px; }
  .hist-item .hist-find { font-size: 11px; color: #ffb347; word-break: break-word; }
  .hist-item .hist-find::before { content: "▲ "; }
  .hist-item .hist-replace { font-size: 11px; color: #7CFC9C; word-break: break-word; margin-top: 2px; }
  .hist-item .hist-replace::before { content: "▼ "; }
  .hist-item .row { margin-top: 6px; }
  .hist-item button { padding: 4px 6px; font-size: 10px; }
  .hist-empty { font-size: 11px; color: #999; text-align: center; padding: 10px 0; }
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
    <div class="row" id="histToggleRow" style="display:none;">
      <button id="histToggle">뭐가 바뀌었는지 보기</button>
    </div>
    <div id="histWrap" class="hidden">
      <div class="tabs" style="margin-bottom:0;">
        <div class="tab active" id="histTabPartial">부분 수정</div>
        <div class="tab" id="histTabRewrite">전체 재작성</div>
      </div>
      <div class="hist-toolbar">
        <span id="histLabel">이 방에서 적용된 부분 수정 (최신순)</span>
        <button class="danger" id="histClear" style="flex:none;padding:4px 8px;">전체 삭제</button>
      </div>
      <div class="hist-list" id="histList"></div>
      <div class="hist-list" id="histListRewrite" style="display:none;"></div>
    </div>
    <div class="row check">
      <input type="checkbox" id="fullRewriteMode" style="width:auto;margin:0;">
      <label style="margin:0;">전체 재작성 모드 (실험적, 로어북/캐릭상세 포함)</label>
    </div>
    <div class="status" id="rewriteContextStatus" style="display:none;">아직 안 불러옴</div>
    <div class="row" id="rewriteContextRefreshRow" style="display:none;">
      <button id="rewriteContextRefresh">로어북/캐릭상세/유저상세 새로고침</button>
    </div>
    <textarea id="note" placeholder="유저노트 글자수가 늘어나면 API 설정란의 토큰 사용량도 같이 늘어납니다.&#10;글자수/비용은 API 설정 탭에서 확인하며 조절하세요.&#10;&#10;출력 방식/규칙(예: 짧게 출력, 내레이션 금지 등)은 이 기능으로는 반영되지 않습니다."></textarea>
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
  const roomEl = el("room");
  const countEl = el("count");
  const savedEl = el("saved");
  const enabledEl = el("enabled");
  const debugModeEl = el("debugMode");
  const histToggleRowEl = el("histToggleRow");
  const histToggleEl = el("histToggle");
  const histWrapEl = el("histWrap");
  const histTabPartialEl = el("histTabPartial");
  const histTabRewriteEl = el("histTabRewrite");
  const histLabelEl = el("histLabel");
  const histListEl = el("histList");
  const histListRewriteEl = el("histListRewrite");
  const histClearEl = el("histClear");
  const fullRewriteModeEl = el("fullRewriteMode");
  const rewriteContextStatusEl = el("rewriteContextStatus");
  const rewriteContextRefreshRowEl = el("rewriteContextRefreshRow");
  const rewriteContextRefreshBtn = el("rewriteContextRefresh");
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

  function renderRewriteContextStatus(ctx) {
    if (!ctx) {
      rewriteContextStatusEl.className = "status bad";
      rewriteContextStatusEl.textContent = "⚠ 아직 못 불러옴 (인증 토큰 없거나 plotId 못 잡음 — 사이트 한번 조작해보고 새로고침 눌러보세요)";
      return;
    }
    rewriteContextStatusEl.className = "status ok";
    const lbLine = ctx.lorebookTitles.length
      ? `🔗 로어북 ${ctx.lorebookTitles.length}개: ${ctx.lorebookTitles.join(", ")} (${ctx.lorebookText.length}자)`
      : "🔗 로어북 연결 없음";
    rewriteContextStatusEl.textContent =
      `✅ 캐릭터: ${ctx.charName || "?"} (상세 ${ctx.charDetailText.length}자)\n${lbLine}`;
  }

  async function refreshRewriteContextUI(forceRefresh) {
    const show = fullRewriteModeEl.checked;
    rewriteContextStatusEl.style.display = show ? "" : "none";
    rewriteContextRefreshRowEl.style.display = show ? "" : "none";
    if (!show) return;
    if (!forceRefresh && roomContextCache[roomId]) {
      renderRewriteContextStatus(roomContextCache[roomId]);
      return;
    }
    rewriteContextStatusEl.className = "status";
    rewriteContextStatusEl.textContent = "불러오는 중...";
    const ctx = await getRoomContext(roomId, forceRefresh);
    renderRewriteContextStatus(ctx);
  }

  rewriteContextRefreshBtn.addEventListener("click", () => {
    delete roomContextCache[roomId];
    delete personaCache[roomId];
    refreshRewriteContextUI(true);
  });

  function formatHistTime(ts) {
    try {
      return new Date(ts).toLocaleString("ko-KR", { hour: "2-digit", minute: "2-digit", hour12: true, month: "numeric", day: "numeric" });
    } catch { return ""; }
  }

  let histMode = "partial"; // "partial" | "rewrite"

  function renderHistory() {
    const list = getCorrectionHistory(roomId);
    if (!list.length) {
      histListEl.innerHTML = '<div class="hist-empty">아직 이 방에서 적용된 부분 수정이 없습니다.</div>';
      return;
    }
    histListEl.innerHTML = "";
    list.forEach((c) => {
      const item = document.createElement("div");
      item.className = "hist-item";
      const time = document.createElement("div");
      time.className = "hist-time";
      time.textContent = formatHistTime(c.ts);
      const find = document.createElement("div");
      find.className = "hist-find";
      find.textContent = c.find;
      const replace = document.createElement("div");
      replace.className = "hist-replace";
      replace.textContent = c.replace;
      const row = document.createElement("div");
      row.className = "row";
      const copyBtn = document.createElement("button");
      copyBtn.textContent = "복사";
      copyBtn.addEventListener("click", () => copyHistText("[원본] " + c.find + "\n[교정] " + c.replace));
      const delBtn = document.createElement("button");
      delBtn.className = "danger";
      delBtn.textContent = "삭제";
      delBtn.addEventListener("click", () => { deleteCorrectionEntry(roomId, c.find); renderHistory(); });
      row.appendChild(copyBtn);
      row.appendChild(delBtn);
      item.appendChild(time);
      item.appendChild(find);
      item.appendChild(replace);
      item.appendChild(row);
      histListEl.appendChild(item);
    });
  }

  function renderRewriteHistory() {
    const list = getRewriteHistory(roomId);
    if (!list.length) {
      histListRewriteEl.innerHTML = '<div class="hist-empty">아직 이 방에서 적용된 전체 재작성이 없습니다.<br>(재작성 이력은 디버그 모드가 켜져있을 때만 쌓입니다.)</div>';
      return;
    }
    histListRewriteEl.innerHTML = "";
    list.forEach((c) => {
      const item = document.createElement("div");
      item.className = "hist-item";
      const time = document.createElement("div");
      time.className = "hist-time";
      time.textContent = formatHistTime(c.ts);
      const find = document.createElement("div");
      find.className = "hist-find";
      find.textContent = "[원본]\n" + c.original;
      const replace = document.createElement("div");
      replace.className = "hist-replace";
      replace.textContent = "[재작성]\n" + c.rewritten;
      const row = document.createElement("div");
      row.className = "row";
      const copyBtn = document.createElement("button");
      copyBtn.textContent = "복사";
      copyBtn.addEventListener("click", () => copyHistText("[원본]\n" + c.original + "\n\n[재작성]\n" + c.rewritten));
      const delBtn = document.createElement("button");
      delBtn.className = "danger";
      delBtn.textContent = "삭제";
      delBtn.addEventListener("click", () => { deleteRewriteEntry(roomId, c.ts); renderRewriteHistory(); });
      row.appendChild(copyBtn);
      row.appendChild(delBtn);
      item.appendChild(time);
      item.appendChild(find);
      item.appendChild(replace);
      item.appendChild(row);
      histListRewriteEl.appendChild(item);
    });
  }

  function copyHistText(text) {
    (navigator.clipboard && navigator.clipboard.writeText
      ? navigator.clipboard.writeText(text)
      : Promise.reject()
    ).then(() => flashSaved("복사됨")).catch(() => toast("클립보드 복사 실패", true));
  }

  function setHistMode(mode) {
    histMode = mode;
    const isPartial = mode === "partial";
    histTabPartialEl.classList.toggle("active", isPartial);
    histTabRewriteEl.classList.toggle("active", !isPartial);
    histListEl.style.display = isPartial ? "flex" : "none";
    histListRewriteEl.style.display = isPartial ? "none" : "flex";
    histLabelEl.textContent = isPartial ? "이 방에서 적용된 부분 수정 (최신순)" : "이 방에서 적용된 전체 재작성 (최신순)";
    if (isPartial) renderHistory(); else renderRewriteHistory();
  }

  histTabPartialEl.addEventListener("click", () => setHistMode("partial"));
  histTabRewriteEl.addEventListener("click", () => setHistMode("rewrite"));

  // 디버그(테스트) 모드일 때만 "이력 보기" 버튼을 노출한다. 평소엔 안 보이고, 꺼지면 패널도 같이 접는다.
  function refreshHistoryUI() {
    const debugOn = debugModeEl.checked;
    histToggleRowEl.style.display = debugOn ? "flex" : "none";
    if (!debugOn) histWrapEl.classList.add("hidden");
    if (!histWrapEl.classList.contains("hidden")) setHistMode(histMode);
  }

  histToggleEl.addEventListener("click", () => {
    histWrapEl.classList.toggle("hidden");
    if (!histWrapEl.classList.contains("hidden")) setHistMode(histMode);
  });

  histClearEl.addEventListener("click", () => {
    const label = histMode === "partial" ? "부분 수정" : "전체 재작성";
    if (!confirm("이 방의 " + label + " 이력을 전부 삭제할까요?")) return;
    if (histMode === "partial") { clearCorrectionHistory(roomId); renderHistory(); }
    else { clearRewriteHistory(roomId); renderRewriteHistory(); }
    flashSaved("이력 삭제됨");
  });

  function refreshRoomUI() {
    roomEl.textContent = "Room: " + (roomId ? roomId.slice(0, 24) : "(감지 안 됨)");
    noteEl.value = getNote(roomId);
    enabledEl.checked = getEnabled(roomId);
    debugModeEl.checked = getDebug(roomId);
    fullRewriteModeEl.checked = getFullRewriteMode(roomId);
    updateCount();
    refreshPresetUI();
    refreshTokenUI();
    refreshRewriteContextUI(false);
    refreshHistoryUI();
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
    flashSaved("저장됨");
  });
  enabledEl.addEventListener("change", () => setEnabled(roomId, enabledEl.checked));
  debugModeEl.addEventListener("change", () => {
    setDebug(roomId, debugModeEl.checked);
    refreshHistoryUI();
  });
  fullRewriteModeEl.addEventListener("change", () => {
    setFullRewriteMode(roomId, fullRewriteModeEl.checked);
    refreshRewriteContextUI(false);
  });

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
