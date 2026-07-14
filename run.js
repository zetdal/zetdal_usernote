// ==UserScript==
// @name         Zeta User Note Corrector
// @namespace    zeta-usernote-corrector
// @version      2.0.1
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

  const VERSION = "2.0.1";

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
    const fence = raw.match(/
http://googleusercontent.com/immersive_entry_chip/0
