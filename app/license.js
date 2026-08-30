/* license.js — 会员密钥校验(浏览器版, WebCrypto Ed25519, 本地离线校验) */
(function () {
  "use strict";

  const PUBLIC_KEY_SPKI = "MCowBQYDK2VwAyEA5KF/FP5RJeoCa0T/oz70vRDQ1OpjTctbLLUnA1sEYC0=";

  const TIERS = {
    week:  { label: "1周会员",  days: 7 },
    month: { label: "1月会员",  days: 30 },
    year:  { label: "1年会员",  days: 365 },
    life:  { label: "终生会员", days: null },
  };

  function tierLabel(tier) {
    return (TIERS[tier] || {}).label || tier;
  }

  function b64urlToBytes(s) {
    s = String(s).replace(/-/g, "+").replace(/_/g, "/");
    while (s.length % 4) s += "=";
    const bin = atob(s);
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return u8;
  }

  function bytesToUtf8(u8) {
    return new TextDecoder("utf-8").decode(u8);
  }

  let _keyPromise = null;
  function getVerifyKey() {
    if (!_keyPromise) {
      const spkiB64 = PUBLIC_KEY_SPKI.replace(/-/g, "+").replace(/_/g, "/");
      const bin = atob(spkiB64);
      const der = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) der[i] = bin.charCodeAt(i);
      const raw = der.subarray(der.length - 32); // DER SPKI 末尾 32 字节 = raw Ed25519 公钥
      _keyPromise = crypto.subtle.importKey("raw", raw, { name: "Ed25519" }, false, ["verify"]);
    }
    return _keyPromise;
  }

  /** 校验会员码: 返回 { valid, payload?, reason? } (async) */
  async function verifyLicenseKey(keyStr) {
    const s = String(keyStr || "").trim();
    if (!s) return { valid: false, reason: "empty" };
    const idx = s.indexOf(".");
    if (idx <= 0) return { valid: false, reason: "format" };
    const p = s.slice(0, idx);
    const sigB64 = s.slice(idx + 1);
    if (!p || !sigB64) return { valid: false, reason: "format" };
    let payload;
    try { payload = JSON.parse(bytesToUtf8(b64urlToBytes(p))); }
    catch (e) { return { valid: false, reason: "format" }; }
    if (!payload || payload.v !== 1 || !TIERS[payload.tier]) return { valid: false, reason: "invalid" };
    try {
      const key = await getVerifyKey();
      const msg = new TextEncoder().encode(p);
      const sig = b64urlToBytes(sigB64);
      const ok = await crypto.subtle.verify("Ed25519", key, sig, msg);
      if (!ok) return { valid: false, reason: "signature" };
    } catch (e) {
      return { valid: false, reason: "signature" };
    }
    if (payload.tier !== "life" && payload.exp && Date.now() > payload.exp * 1000) {
      return { valid: false, reason: "expired", payload };
    }
    return { valid: true, payload };
  }

  /** 剩余毫秒数(life 返回 null) */
  function remainingMs(payload) {
    if (payload.tier === "life" || !payload.exp) return null;
    return payload.exp * 1000 - Date.now();
  }

  window.LicenseLib = { PUBLIC_KEY_SPKI, TIERS, tierLabel, verifyLicenseKey, remainingMs };
})();
