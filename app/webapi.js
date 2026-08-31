/* webapi.js — 浏览器端 API 实现 (替代原 Node 服务器 /api/*) */
(function () {
  "use strict";
  const E = window.EngineLib;
  const L = window.LicenseLib;

  const LS_LICENSE = "bnb_license_v1";
  const LS_WALLETS = "bnb_wallets_v1";
  const jobs = new Map();
  let activeSendJob = null;

  function readLicense() { try { return JSON.parse(localStorage.getItem(LS_LICENSE)); } catch (e) { return null; } }
  function writeLicense(rec) { try { localStorage.setItem(LS_LICENSE, JSON.stringify(rec)); } catch (e) {} }
  function removeLicense() { try { localStorage.removeItem(LS_LICENSE); } catch (e) {} }
  function readWallets() { try { return JSON.parse(localStorage.getItem(LS_WALLETS)) || []; } catch (e) { return []; } }
  function writeWallets(list) { try { localStorage.setItem(LS_WALLETS, JSON.stringify(list)); } catch (e) {} }

  async function licenseStatus(rec) {
    if (!rec || !rec.key) return { activated: false, valid: false };
    const v = await L.verifyLicenseKey(rec.key);
    if (!v.valid) return { activated: true, valid: false, reason: v.reason, key: rec.key };
    const remain = L.remainingMs(v.payload);
    return {
      activated: true, valid: true,
      key: rec.key, id: v.payload.id,
      tier: v.payload.tier, tierLabel: L.tierLabel(v.payload.tier),
      issuedAt: v.payload.iat, expiresAt: v.payload.exp, remainingMs: remain,
    };
  }

  function makeOpts(cfg, hooks) {
    return {
      rpc: cfg.rpc || undefined,
      chainId: cfg.chainId ? Number(cfg.chainId) : 56,
      startIndex: cfg.startIndex ?? 0,
      senders: cfg.senders ?? 1,
      gasLimit: cfg.gasLimit ?? 21000,
      maxGasPrice: cfg.maxGasPrice ?? 10,
      confirmations: cfg.confirmations ?? 1,
      maxRetries: cfg.maxRetries ?? 3,
      feeBumpPercent: cfg.feeBumpPercent ?? 10,
      retryDelayMs: cfg.retryDelayMs ?? 3000,
      waitTimeoutMs: cfg.waitTimeoutMs ?? 60000,
      skipBalanceCheck: !!cfg.skipBalanceCheck,
      feeMode: cfg.feeMode === "eip1559" ? "eip1559" : "legacy",
      gasSpeedMult: cfg.gasSpeed === "slow" ? 0.9 : cfg.gasSpeed === "fast" ? 1.5 : 1,
      hooks,
    };
  }

  function getSecrets(cfg) {
    if (cfg.secretsJson) {
      return { mnemonic: cfg.secretsJson.mnemonic, privateKeys: cfg.secretsJson.privateKeys ?? cfg.secretsJson.private_keys ?? cfg.secretsJson.keys };
    }
    const privateKeys = Array.isArray(cfg.privateKeys)
      ? cfg.privateKeys
      : (cfg.privateKeys ? String(cfg.privateKeys).split(",").map((s) => s.trim()).filter(Boolean) : []);
    return { mnemonic: cfg.mnemonic || undefined, privateKeys };
  }

  async function makeEngine(cfg, hooks) {
    const opts = makeOpts(cfg, hooks);
    const secrets = getSecrets(cfg);
    const senders = E.buildSenders(secrets, opts);
    const engine = new E.TransferEngine(opts);
    return { engine, senders, opts };
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const b64toBytes = (b64) => {
    const bin = atob(b64);
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return u8;
  };

  /* ============ 名单解析 ============ */
  async function apiParse(body) {
    const rows = await E.parseList(body);
    const { items } = E.parseRows(rows);
    E.validateItems(items);
    return { ok: true, items };
  }

  /* ============ 转账 ============ */
  async function apiPreview(body) {
    const tokenRaw = (body.token || "").trim();
    const isToken = !!tokenRaw;
    if (isToken && !ethers.isAddress(tokenRaw)) throw new Error("代币地址无效: " + tokenRaw);
    const tokenAddr = isToken ? ethers.getAddress(tokenRaw) : null;
    const logs = [];
    window.__engineSink = (t) => logs.push(t);
    try {
      const { engine, senders } = await makeEngine(body, {});
      const items = (body.items || []).map((it) => ({ row: it.row ?? 0, to: it.to, amount: Number(it.amount), remark: it.remark ?? "", walletIndex: it.walletIndex ?? -1 }));
      if (!items.length) throw new Error("名单为空, 请先解析或填写转账名单");
      E.validateItems(items);
      await engine.init();
      engine.assignSenders(senders, items);
      let balanceOk = true, balanceError = "";
      try {
        if (isToken) balanceOk = await checkTokenBalances(engine, tokenAddr, items);
        else balanceOk = body.skipBalanceCheck || await engine.checkBalances(items);
      } catch (e) { balanceOk = false; balanceError = e?.shortMessage || e?.message || String(e); }
      const plan = items.map((it) => ({ row: it.row, from: it.sender.address, to: it.to, amount: it.amount, remark: it.remark, walletIndex: it.walletIndex }));
      return { ok: true, wallets: senders.map((s) => ({ index: s.index, address: s.address })), plan, total: Math.round(items.reduce((s, i) => s + i.amount, 0) * 1e8) / 1e8, balanceOk, balanceError, isToken, token: tokenAddr };
    } finally { window.__engineSink = null; }
  }

  /** 代币模式余额检查: 每个发送钱包的代币余额 >= 分配转出总量 */
  async function checkTokenBalances(engine, tokenAddr, items) {
    let decimals = 18;
    try { decimals = (await E.getTokenInfo(engine, tokenAddr)).decimals; } catch (e) {}
    const tokenIface = new ethers.Interface(E.TOKEN_ABI);
    const assigned = new Map();
    for (const it of items) {
      const addr = it.sender.address;
      if (!assigned.has(addr)) assigned.set(addr, 0n);
      assigned.set(addr, assigned.get(addr) + ethers.parseUnits(String(it.amount), decimals));
    }
    let ok = true;
    for (const [addr, total] of assigned) {
      const balData = tokenIface.encodeFunctionData("balanceOf", [addr]);
      const bal = BigInt(tokenIface.decodeFunctionResult("balanceOf", (await engine.call((p) => p.call({ to: tokenAddr, data: balData }), "查询代币余额 (" + addr.slice(0, 10) + "...)")))[0]);
      if (bal < total) { ok = false; engine.hooks.onLog?.("[余额不足] " + addr + " 代币余额 " + ethers.formatUnits(bal, 18) + " < 需转出 " + ethers.formatUnits(total, 18)); }
    }
    return ok;
  }
  function newJob(total) {
    return { id: "job-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8), status: "running", logs: [], results: [], done: 0, total, startedAt: Date.now(), finishedAt: null, error: "" };
  }

  function jobLog(job) { return (text) => job.logs.push("[" + new Date().toLocaleTimeString() + "] " + text); }

  async function apiSend(body) {
    if (activeSendJob) { const e = new Error("已有任务在进行中, 请等待完成"); e.status = 409; throw e; }
    const items = (body.items || []).map((it) => ({ row: it.row ?? 0, to: it.to, amount: Number(it.amount), remark: it.remark ?? "", walletIndex: it.walletIndex ?? -1 }));
    if (!items.length) throw new Error("名单为空");
    const job = newJob(items.length);
    jobs.set(job.id, job);
    activeSendJob = job.id;
    window.__engineSink = jobLog(job);
    (async () => {
      try {
        const { engine, senders } = await makeEngine(body, { onLog: jobLog(job) });
        E.validateItems(items);
        await engine.init();
        engine.assignSenders(senders, items);
        let results;
        const tokenRaw2 = (body.token || "").trim();
        if (tokenRaw2) {
          if (!ethers.isAddress(tokenRaw2)) throw new Error("代币地址无效: " + tokenRaw2);
          const tokenAddr2 = ethers.getAddress(tokenRaw2);
          let info = { decimals: 18, symbol: "TOKEN" };
          try { info = await E.getTokenInfo(engine, tokenAddr2); } catch (e) {}
          const balanceOk2 = await checkTokenBalances(engine, tokenAddr2, items);
          if (!balanceOk2) throw new Error("存在代币余额不足的发送钱包, 已中止");
          const tokenIface2 = new ethers.Interface(E.TOKEN_ABI);
          results = [];
          for (const it of items) {
            const sender = it.sender;
            const amount = ethers.parseUnits(String(it.amount), info.decimals);
            const txData = tokenIface2.encodeFunctionData("transfer", [it.to, amount]);
            try {
              const r = await E.broadcastTx(engine, sender, { to: tokenAddr2, data: txData, gasLimit: 80000n }, "转账 第" + it.row + "行");
              const row = { row: it.row, from: sender.address, to: it.to, amount: it.amount, remark: it.remark, status: "ok", txHash: r.txHash, error: "", symbol: info.symbol };
              results.push(row); job.results.push(row);
              engine.hooks.onLog?.("[成功] 第" + it.row + "行 " + info.symbol + " -> " + it.to + " hash=" + r.txHash);
            } catch (e) {
              const msg = e?.shortMessage || e?.message || String(e);
              const row = { row: it.row, from: sender.address, to: it.to, amount: it.amount, remark: it.remark, status: "failed", txHash: "", error: msg, symbol: info.symbol };
              results.push(row); job.results.push(row);
              engine.hooks.onLog?.("[失败] 第" + it.row + "行 " + msg.slice(0, 200));
            }
            job.done++;
            job.total = items.length;
          }
        } else {
          const balanceOk = body.skipBalanceCheck || await engine.checkBalances(items);
          if (!balanceOk) throw new Error("存在余额不足的发送钱包, 已中止");
          results = await engine.runSends(items, (result, done, total) => { job.results.push(result); job.done = done; job.total = total; });
        }
        job.status = "done";
        job.finishedAt = Date.now();
        job.results = results;
      } catch (e) {
        job.status = "failed";
        job.error = e?.shortMessage || e?.message || String(e);
        job.finishedAt = Date.now();
      } finally { if (activeSendJob === job.id) activeSendJob = null; }
    })();
    return { ok: true, jobId: job.id };
  }

  function apiJob(jobId) {
    const job = jobs.get(jobId);
    if (!job) { const e = new Error("任务不存在"); e.status = 404; throw e; }
    return { ok: true, status: job.status, logs: job.logs.slice(-200), results: job.results, done: job.done, total: job.total, error: job.error, finishedAt: job.finishedAt };
  }

  /* ============ 钱包工具 ============ */
  function apiWalletsGenerate(body) {
    const mode = body.mode || "new_mnemonic";
    const count = Math.min(1000, Math.max(1, Number(body.count) || 1));
    const startIndex = Math.max(0, Number(body.startIndex) || 0);
    let mnemonic = null, wallets;
    if (mode === "new_mnemonic") {
      mnemonic = (body.mnemonic || "").trim() || ethers.Wallet.createRandom().mnemonic.phrase;
      if (body.mnemonic) ethers.Mnemonic.fromPhrase(mnemonic);
      wallets = E.deriveWallets(mnemonic, startIndex, count);
    } else if (mode === "existing_mnemonic") {
      if (!body.mnemonic) throw new Error("请提供助记词");
      ethers.Mnemonic.fromPhrase(body.mnemonic.trim());
      wallets = E.deriveWallets(body.mnemonic, startIndex, count);
    } else if (mode === "random_keys") {
      wallets = [];
      for (let i = 0; i < count; i++) {
        const w = ethers.Wallet.createRandom();
        wallets.push({ index: startIndex + i, address: w.address, privateKey: w.privateKey });
      }
    } else { throw new Error("未知模式: " + mode); }
    return { ok: true, mode, mnemonic, wallets };
  }

  async function apiWalletsImport(body) {
    const mode = body.mode;
    let wallets = [];
    if (mode === "mnemonic") {
      const count = Math.min(1000, Math.max(1, Number(body.count) || 1));
      const startIndex = Math.max(0, Number(body.startIndex) || 0);
      if (!body.mnemonic) throw new Error("请提供助记词");
      ethers.Mnemonic.fromPhrase(body.mnemonic.trim());
      wallets = E.deriveWallets(body.mnemonic, startIndex, count);
    } else if (mode === "privateKeys") {
      const keys = Array.isArray(body.privateKeys) ? body.privateKeys : String(body.privateKeys || "").split(",").map((s) => s.trim()).filter(Boolean);
      if (!keys.length) throw new Error("请提供私钥");
      wallets = keys.map((k, i) => { const w = new ethers.Wallet(k.trim()); return { index: i, address: w.address, privateKey: w.privateKey }; });
    } else if (mode === "csv") {
      let rows;
      if (body.dataBase64) {
        rows = await E.parseList({ dataBase64: body.dataBase64, filename: body.filename });
      } else {
        if (!body.text) throw new Error("请粘贴 CSV 内容");
        rows = E.parseCsv(String(body.text));
      }
      if (!rows.length) throw new Error("CSV 为空");
      let start = 0;
      if (!ethers.isAddress(rows[0][0]?.trim() || "")) start = 1;
      for (let i = start; i < rows.length; i++) {
        const r = rows[i];
        const address = (r[0] || "").trim();
        const privateKey = (r[1] || "").trim();
        const label = (r[2] || "").trim();
        if (!address) continue;
        if (!ethers.isAddress(address)) throw new Error("CSV 第 " + (i + 1) + " 行地址无效: " + address);
        let pk = null;
        if (privateKey) { const w = new ethers.Wallet(privateKey); pk = w.privateKey; }
        wallets.push({ index: i, address: ethers.getAddress(address), privateKey: pk, label });
      }
      if (!wallets.length) throw new Error("CSV 中没有有效行");
    } else { throw new Error("未知导入方式: " + mode); }
    return { ok: true, wallets };
  }

  async function apiWalletsBalances(body) {
    const addresses = (body.addresses || []).filter(Boolean);
    if (!addresses.length) throw new Error("没有地址可查询");
    const opts = { rpc: body.rpc || undefined, chainId: body.chainId ? Number(body.chainId) : 56, maxGasPrice: 10, feeMode: "legacy" };
    const engine = new E.TransferEngine(opts);
    const tokenRaw = (body.token || "").trim();
    const isToken = !!tokenRaw && ethers.isAddress(tokenRaw);
    const tokenAddr = isToken ? ethers.getAddress(tokenRaw) : null;
    const tokenIface = isToken ? new ethers.Interface(E.TOKEN_ABI) : null;
    let decimals = 18, symbol = null;
    if (isToken) { try { const info = await E.getTokenInfo(engine, tokenAddr); decimals = info.decimals; symbol = info.symbol; } catch (e) {} }
    const out = [];
    for (const addr of addresses) {
      const bnb = await engine.call((p) => p.getBalance(addr), "查询 BNB 余额 (" + addr.slice(0, 10) + "...)");
      const rec = { address: addr, balance: ethers.formatEther(bnb) };
      if (isToken) {
        const balData = tokenIface.encodeFunctionData("balanceOf", [addr]);
        const tb = BigInt(tokenIface.decodeFunctionResult("balanceOf", (await engine.call((p) => p.call({ to: tokenAddr, data: balData }), "查询代币余额 (" + addr.slice(0, 10) + "...)")))[0]);
        rec.tokenBalance = ethers.formatUnits(tb, decimals);
        rec.symbol = symbol;
      }
      out.push(rec);
    }
    return { ok: true, balances: out, isToken, symbol };
  }

  function apiWalletsSave(body) {
    const list = (body.wallets || []).map((w) => ({ address: w.address, label: String(w.label ?? ""), hasKey: !!w.hasKey })).filter((w) => ethers.isAddress(w.address));
    writeWallets(list);
    return { ok: true, count: list.length };
  }

  function apiWalletsList() {
    return { ok: true, wallets: readWallets() };
  }

  /* ============ 批量归集 ============ */
  function buildSourceWallets(body) {
    const source = body.source || "mnemonic";
    if (source === "mnemonic") {
      const mnemonic = (body.mnemonic || "").trim();
      if (!mnemonic) throw new Error("请提供助记词");
      ethers.Mnemonic.fromPhrase(mnemonic);
      const count = Math.min(1000, Math.max(1, Number(body.count) || 1));
      const startIndex = Math.max(0, Number(body.startIndex) || 0);
      return E.deriveWallets(mnemonic, startIndex, count);
    }
    if (source === "privateKeys") {
      const keys = Array.isArray(body.privateKeys) ? body.privateKeys : String(body.privateKeys || "").split(",").map((s) => s.trim()).filter(Boolean);
      if (!keys.length) throw new Error("请提供私钥");
      return keys.map((k, i) => { const w = new ethers.Wallet(k.trim()); return { index: i, address: w.address, privateKey: w.privateKey }; });
    }
    if (source === "managed") {
      const addresses = body.addresses || [];
      const keys = body.keys || [];
      if (!addresses.length) throw new Error("管理列表为空");
      return addresses.map((a, i) => ({ index: i, address: String(a).trim(), privateKey: keys[i] || null }));
    }
    throw new Error("未知来源: " + source);
  }

  function conOpts(body) {
    return {
      rpc: body.rpc || undefined, chainId: body.chainId ? Number(body.chainId) : 56,
      gasLimit: body.gasLimit ?? 21000, maxGasPrice: body.maxGasPrice ?? 10, feeMode: "legacy",
      feeBumpPercent: body.feeBumpPercent ?? 10, maxRetries: body.maxRetries ?? 3,
      retryDelayMs: body.retryDelayMs ?? 3000, waitTimeoutMs: body.waitTimeoutMs ?? 60000,
      confirmations: body.confirmations ?? 1,
    };
  }

  async function apiConsolidatePreview(body) {
    const target = ethers.getAddress(String(body.target || "").trim());
    const sources = buildSourceWallets(body);
    if (!sources.length) throw new Error("没有源钱包");
    const tokenRaw = (body.token || "").trim();
    const isToken = !!tokenRaw;
    if (isToken && !ethers.isAddress(tokenRaw)) throw new Error("代币地址无效: " + tokenRaw);
    const tokenAddr = isToken ? ethers.getAddress(tokenRaw) : null;
    const engine = new E.TransferEngine(conOpts(body));
    let info = null;
    if (isToken) {
      try { info = await E.getTokenInfo(engine, tokenAddr); } catch (e) { info = { decimals: 18, symbol: "TOKEN" }; }
    }
    const feePerTx = await engine.getFeePerTx();
    const reserve = (feePerTx * 110n) / 100n;
    const pctN = Math.min(100, Math.max(1, Number(body.pct) || 100)) / 100;
    const pctBig = BigInt(Math.round(pctN * 100));
    const tokenIface = isToken ? new ethers.Interface(E.TOKEN_ABI) : null;
    const plan = [];
    for (const s of sources) {
      let balance, amount = 0n, ok = false, reason = "", feeStr = ethers.formatEther(feePerTx);
      if (isToken) {
        const balData = tokenIface.encodeFunctionData("balanceOf", [s.address]);
        balance = BigInt(tokenIface.decodeFunctionResult("balanceOf", (await engine.call((p) => p.call({ to: tokenAddr, data: balData }), "查询代币余额 (" + s.address.slice(0, 10) + "...)")))[0]);
        feeStr = "BNB 付 gas";
        if (balance <= 0n) reason = "代币余额为 0";
        else if (s.address.toLowerCase() === target.toLowerCase()) reason = "源地址=目标地址, 跳过";
        else if (!s.privateKey) reason = "无私钥, 仅查询余额";
        else { amount = (balance * pctBig) / 100n; ok = true; }
        plan.push({ index: s.index, address: s.address, hasKey: !!s.privateKey, balance: ethers.formatUnits(balance, info.decimals), fee: feeStr, amount: ethers.formatUnits(amount, info.decimals), ok, reason });
      } else {
        balance = BigInt(await engine.call((p) => p.getBalance(s.address), "查询余额 (" + s.address.slice(0, 10) + "...)"));
        if (balance <= reserve) reason = "余额不足以支付手续费";
        else if (s.address.toLowerCase() === target.toLowerCase()) reason = "源地址=目标地址, 跳过";
        else if (!s.privateKey) reason = "无私钥, 仅查询余额";
        else { amount = ((balance - reserve) * pctBig) / 100n; ok = true; }
        plan.push({ index: s.index, address: s.address, hasKey: !!s.privateKey, balance: ethers.formatEther(balance), fee: feeStr, amount: ethers.formatEther(amount), ok, reason });
      }
    }
    const okCount = plan.filter((p) => p.ok).length;
    const total = plan.filter((p) => p.ok).reduce((s, p) => s + Number(p.amount), 0);
    return { ok: true, target, isToken, token: tokenAddr, symbol: isToken ? info.symbol : null, plan, okCount, total: Math.round(total * 1e8) / 1e8, feePerTx: isToken ? null : ethers.formatEther(feePerTx) };
  }
  async function apiConsolidateSend(body) {
    if (activeSendJob) { const e = new Error("已有任务在进行中, 请等待完成"); e.status = 409; throw e; }
    const target = ethers.getAddress(String(body.target || "").trim());
    const sources = buildSourceWallets(body);
    if (!sources.length) throw new Error("没有源钱包");
    const job = newJob(sources.length);
    jobs.set(job.id, job);
    activeSendJob = job.id;
    window.__engineSink = jobLog(job);
    (async () => {
      try {
        const hooks = { onLog: jobLog(job) };
        const engine = new E.TransferEngine(Object.assign({}, conOpts(body), { hooks }));
        await engine.init();
        const senders = sources.filter((s) => s.privateKey).map((s) => ({ index: s.index, wallet: new ethers.Wallet(s.privateKey), address: s.address }));
        if (!senders.length) throw new Error("没有可发送的源钱包(缺失私钥)");
        const tokenRaw = (body.token || "").trim();
        const isToken = !!tokenRaw;
        if (isToken) {
          if (!ethers.isAddress(tokenRaw)) throw new Error("代币地址无效: " + tokenRaw);
          const tokenAddr = ethers.getAddress(tokenRaw);
          let info = { decimals: 18, symbol: "TOKEN" };
          try { info = await E.getTokenInfo(engine, tokenAddr); } catch (e) {}
          const tokenIface = new ethers.Interface(E.TOKEN_ABI);
          let doneAny = false;
          for (const s of sources) {
            if (!s.privateKey || s.address.toLowerCase() === target.toLowerCase()) continue;
            const balData = tokenIface.encodeFunctionData("balanceOf", [s.address]);
            const balance = BigInt(tokenIface.decodeFunctionResult("balanceOf", (await engine.call((p) => p.call({ to: tokenAddr, data: balData }), "查询代币余额")))[0]);
            if (balance <= 0n) continue;
            const pctN2 = Math.min(100, Math.max(1, Number(body.pct) || 100)) / 100;
            const sendAmt = (balance * BigInt(Math.round(pctN2 * 100))) / 100n;
            if (sendAmt <= 0n) continue;
            const txData = tokenIface.encodeFunctionData("transfer", [target, sendAmt]);
            try {
              const r = await E.broadcastTx(engine, { index: s.index, wallet: new ethers.Wallet(s.privateKey), address: s.address }, { to: tokenAddr, data: txData, gasLimit: 80000n }, "归集 " + info.symbol);
              job.results.push({ row: s.index + 1, from: s.address, to: target, amount: ethers.formatUnits(sendAmt, info.decimals), symbol: info.symbol, status: "ok", txHash: r.txHash, error: "" });
              engine.hooks.onLog?.("[成功] 第" + (s.index + 1) + "行 " + info.symbol + " -> " + target + " hash=" + r.txHash);
            } catch (e) {
              const msg = e?.shortMessage || e?.message || String(e);
              job.results.push({ row: s.index + 1, from: s.address, to: target, amount: ethers.formatUnits(sendAmt, info.decimals), symbol: info.symbol, status: "failed", txHash: "", error: msg });
              engine.hooks.onLog?.("[失败] 第" + (s.index + 1) + "行 " + msg.slice(0, 200));
            }
            job.done++;
            doneAny = true;
          }
          if (!doneAny) throw new Error("没有可归集的代币(余额为 0 或均已跳过)");
          job.status = "done";
          job.finishedAt = Date.now();
          return;
        }
        const feePerTx = await engine.getFeePerTx();
        const reserve = (feePerTx * 110n) / 100n;
        const pctN = Math.min(100, Math.max(1, Number(body.pct) || 100)) / 100;
        const pctBig = BigInt(Math.round(pctN * 100));
        const items = [];
        for (const s of sources) {
          if (!s.privateKey || s.address.toLowerCase() === target.toLowerCase()) continue;
          const balance = BigInt(await engine.call((p) => p.getBalance(s.address), "查询余额 (" + s.address.slice(0, 10) + "...)"));
          if (balance <= reserve) continue;
          const amount = ((balance - reserve) * pctBig) / 100n;
          if (amount <= 0n) continue;
          items.push({ row: s.index + 1, to: target, amount: Number(ethers.formatEther(amount)), remark: "归集", walletIndex: s.index });
        }
        if (!items.length) throw new Error("没有可归集的钱包(余额不足或均已跳过)");
        engine.assignSenders(senders, items);
        const results = await engine.runSends(items, (result, done, total) => { job.results.push(result); job.done = done; job.total = total; });
        job.status = "done";
        job.finishedAt = Date.now();
        job.results = results;
      } catch (e) {
        job.status = "failed";
        job.error = e?.shortMessage || e?.message || String(e);
        job.finishedAt = Date.now();
      } finally { if (activeSendJob === job.id) activeSendJob = null; }
    })();
    return { ok: true, jobId: job.id };
  }

  /* ============ 薄饼交易 ============ */
  function parseSwapItems(body) {
    return (body.items || []).map((it, i) => ({ row: it.row ?? i + 1, token: String(it.token || "").trim(), amount: Number(it.amount), direction: it.direction === "sell" ? "sell" : "buy", slippage: it.slippage == null || it.slippage === "" ? null : Number(it.slippage), remark: it.remark ?? "", walletIndex: it.walletIndex ?? -1 }));
  }

  async function apiSwapPreview(body) {
    const items = parseSwapItems(body);
    if (!items.length) throw new Error("交易名单为空");
    const router = E.getRouterAddress(body);
    const { engine, senders } = await makeEngine(body, {});
    if (!senders.length) throw new Error("未提供发送钱包");
    engine.assignSenders(senders, items);
    const routerIface = new ethers.Interface(E.ROUTER_ABI);
    const tokenIface = new ethers.Interface(E.TOKEN_ABI);
    const defaultSlippage = body.slippage == null || body.slippage === "" ? 1 : Number(body.slippage);
    const fee0 = await engine.computeFeeFields(0);
    const feePerGas = fee0.maxFeePerGas ?? fee0.gasPrice;
    const gasEstimate = 300000n;
    const plan = [];
    for (const it of items) {
      if (!ethers.isAddress(it.token)) throw new Error("第 " + it.row + " 行代币地址无效: " + it.token);
      const token = ethers.getAddress(it.token);
      const slippage = it.slippage == null ? defaultSlippage : it.slippage;
      if (!(slippage >= 0 && slippage <= 50)) throw new Error("第 " + it.row + " 行滑点无效: " + slippage + "%");
      const info = await E.getTokenInfo(engine, token);
      const senderAddr = it.sender.address;
      const path = it.direction === "buy" ? [E.getWBNB(body.chainId || 56), token] : [token, E.getWBNB(body.chainId || 56)];
      const amountIn = ethers.parseUnits(String(it.amount), it.direction === "buy" ? 18 : info.decimals);
      let balance = null, allowance = null, reason = "", ok = true;
      if (it.direction === "buy") {
        balance = await engine.call((p) => p.getBalance(senderAddr), "查询 BNB 余额 (" + senderAddr.slice(0, 10) + "...)");
        const need = amountIn + gasEstimate * feePerGas;
        if (balance < need) { ok = false; reason = "BNB 余额不足: 需 " + ethers.formatEther(need); }
      } else {
        const balData = tokenIface.encodeFunctionData("balanceOf", [senderAddr]);
        balance = tokenIface.decodeFunctionResult("balanceOf", (await engine.call((p) => p.call({ to: token, data: balData }), "查询代币余额 (" + token.slice(0, 8) + "...)")))[0];
        if (balance < amountIn) { ok = false; reason = "代币余额不足: 需 " + ethers.formatUnits(amountIn, info.decimals) + " " + info.symbol; }
        else {
          const alData = tokenIface.encodeFunctionData("allowance", [senderAddr, router]);
          allowance = tokenIface.decodeFunctionResult("allowance", (await engine.call((p) => p.call({ to: token, data: alData }), "查询授权 (" + token.slice(0, 8) + "...)")))[0];
          if (allowance < amountIn) reason = "需先授权 Router (allowance 不足)";
        }
      }
      let out0 = null, outMin = null, estimateError = "";
      try {
        const data = routerIface.encodeFunctionData("getAmountsOut", [amountIn, path]);
        const ret = await engine.call((p) => p.call({ to: router, data }), "getAmountsOut");
        const amounts = routerIface.decodeFunctionResult("getAmountsOut", ret)[0];
        out0 = amounts[amounts.length - 1];
        outMin = out0 - (out0 * BigInt(Math.round(slippage * 100)) / 10000n);
      } catch (e) { estimateError = e?.shortMessage || e?.message || String(e); }
      plan.push({ row: it.row, token, symbol: info.symbol, decimals: info.decimals, direction: it.direction, slippage, amountIn: ethers.formatUnits(amountIn, it.direction === "buy" ? 18 : info.decimals), balance: ethers.formatEther(balance), allowance: allowance == null ? null : ethers.formatUnits(allowance, info.decimals), out0: out0 == null ? null : ethers.formatUnits(out0, info.decimals), outMin: outMin == null ? null : ethers.formatUnits(outMin, info.decimals), ok, reason, estimateError });
    }
    const okCount = plan.filter((p) => p.ok).length;
    return { ok: true, router, plan, okCount };
  }

  async function apiSwapSend(body) {
    if (activeSendJob) { const e = new Error("已有任务在进行中, 请等待完成"); e.status = 409; throw e; }
    const items = parseSwapItems(body);
    if (!items.length) throw new Error("交易名单为空");
    const router = E.getRouterAddress(body);
    const recipient = (body.recipient || "").trim();
    const job = newJob(items.length);
    jobs.set(job.id, job);
    activeSendJob = job.id;
    window.__engineSink = jobLog(job);
    (async () => {
      try {
        const hooks = { onLog: jobLog(job) };
        const { engine, senders } = await makeEngine(Object.assign({}, body, { hooks }), hooks);
        if (!senders.length) throw new Error("未提供发送钱包");
        await engine.init();
        engine.assignSenders(senders, items);
        const routerIface = new ethers.Interface(E.ROUTER_ABI);
        const tokenIface = new ethers.Interface(E.TOKEN_ABI);
        const defaultSlippage = body.slippage == null || body.slippage === "" ? 1 : Number(body.slippage);
        const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
        for (const it of items) {
          const sender = it.sender;
          const toAddr = recipient && ethers.isAddress(recipient) ? ethers.getAddress(recipient) : sender.address;
          const slippage = it.slippage == null ? defaultSlippage : it.slippage;
          const token = ethers.getAddress(it.token);
          const info = await E.getTokenInfo(engine, token);
          const path = it.direction === "buy" ? [E.getWBNB(body.chainId || 56), token] : [token, E.getWBNB(body.chainId || 56)];
          const amountIn = ethers.parseUnits(String(it.amount), it.direction === "buy" ? 18 : info.decimals);
          let ok = false, errMsg = "", approveHash = "", swapHash = "", blockNumber = "";
          try {
            if (it.direction === "sell") {
              const alData = tokenIface.encodeFunctionData("allowance", [sender.address, router]);
              const allowance = tokenIface.decodeFunctionResult("allowance", (await engine.call((p) => p.call({ to: token, data: alData }), "查询授权")))[0];
              if (allowance < amountIn) {
                const appData = tokenIface.encodeFunctionData("approve", [router, E.MAX_UINT]);
                const r = await E.broadcastTx(engine, sender, { to: token, data: appData, gasLimit: 60000n }, "授权 " + token.slice(0, 8));
                approveHash = r.txHash;
                engine.hooks.onLog?.("[已授权] 第" + it.row + "行 approve=" + approveHash);
              }
            }
            const slippageBp = BigInt(Math.round(slippage * 100));
            const out0 = await (async () => {
              const data = routerIface.encodeFunctionData("getAmountsOut", [amountIn, path]);
              const ret = await engine.call((p) => p.call({ to: router, data }), "getAmountsOut");
              return routerIface.decodeFunctionResult("getAmountsOut", ret)[0].slice(-1)[0];
            })();
            const outMin = out0 - (out0 * slippageBp / 10000n);
            let txReq;
            if (it.direction === "buy") {
              txReq = { to: router, value: amountIn, data: routerIface.encodeFunctionData("swapExactETHForTokens", [outMin, path, toAddr, deadline]) };
            } else {
              txReq = { to: router, data: routerIface.encodeFunctionData("swapExactTokensForETH", [amountIn, outMin, path, toAddr, deadline]) };
            }
            let gasLimit = 500000n;
            try { gasLimit = await engine.call((p) => p.estimateGas(Object.assign({}, txReq, { from: sender.address })), "预估 gas"); } catch (e) {}
            txReq.gasLimit = gasLimit;
            const r = await E.broadcastTx(engine, sender, txReq, "swap 第" + it.row + "行");
            swapHash = r.txHash;
            blockNumber = r.receipt ? String(r.receipt.blockNumber ?? "") : "";
            ok = true;
            engine.hooks.onLog?.("[成功] 第" + it.row + "行 " + (it.direction === "buy" ? "买" : "卖") + " " + it.amount + " -> swap=" + swapHash);
          } catch (e) {
            errMsg = e?.shortMessage || e?.message || String(e);
            engine.hooks.onLog?.("[失败] 第" + it.row + "行 " + errMsg.slice(0, 200));
          }
          job.results.push({ row: it.row, from: sender.address, to: token, token, symbol: info.symbol, direction: it.direction, amount: it.amount, status: ok ? "ok" : "failed", approveHash, txHash: swapHash, blockNumber, error: ok ? "" : errMsg });
          job.done++;
          job.total = items.length;
        }
        job.status = "done";
        job.finishedAt = Date.now();
      } catch (e) {
        job.status = "failed";
        job.error = e?.shortMessage || e?.message || String(e);
        job.finishedAt = Date.now();
      } finally { if (activeSendJob === job.id) activeSendJob = null; }
    })();
    return { ok: true, jobId: job.id };
  }

  /* ============ 会员 ============ */
  async function apiLicenseStatus() { return Object.assign({ ok: true }, await licenseStatus(readLicense())); }

  async function apiLicenseActivate(body) {
    const key = String(body.key || "").trim();
    const v = await L.verifyLicenseKey(key);
    if (!v.valid) {
      const reasonText = { empty: "请填写会员码", format: "会员码格式不正确", invalid: "会员码内容无效", signature: "会员码校验失败(不是本工具签发的)", expired: "会员码已过期" }[v.reason] || "会员码无效";
      const e = new Error(reasonText); e.status = 400; throw e;
    }
    writeLicense({ key, activatedAt: Date.now() });
    return Object.assign({ ok: true }, await licenseStatus({ key }));
  }

  async function apiLicenseDeactivate() {
    removeLicense();
    return { ok: true, activated: false, valid: false };
  }

  /* ============ 路由分发 ============ */
  async function handle(path, method, body) {
    // 会员拦截: 除会员接口外都需要有效会员
    if (path.startsWith("api/") && !path.startsWith("api/license/")) {
      const st = await licenseStatus(readLicense());
      if (!st.valid) {
        const e = new Error(st.activated ? "会员已过期, 请重新激活" : "需要有效的会员密钥才能使用本工具");
        e.license = true;
        throw e;
      }
    }
    if (path === "api/parse" && method === "POST") return await apiParse(body);
    if (path === "api/preview" && method === "POST") return await apiPreview(body);
    if (path === "api/send" && method === "POST") return await apiSend(body);
    if (path.startsWith("api/job/") && method === "GET") return apiJob(decodeURIComponent(path.slice("api/job/".length)));
    if (path === "api/wallets/generate" && method === "POST") return apiWalletsGenerate(body);
    if (path === "api/wallets/import" && method === "POST") return await apiWalletsImport(body);
    if (path === "api/wallets/balances" && method === "POST") return await apiWalletsBalances(body);
    if (path === "api/wallets/list" && method === "GET") return apiWalletsList();
    if (path === "api/wallets/save" && method === "POST") return apiWalletsSave(body);
    if (path === "api/consolidate/preview" && method === "POST") return await apiConsolidatePreview(body);
    if (path === "api/consolidate/send" && method === "POST") return await apiConsolidateSend(body);
    if (path === "api/swap/preview" && method === "POST") return await apiSwapPreview(body);
    if (path === "api/swap/send" && method === "POST") return await apiSwapSend(body);
    if (path === "api/license/status" && method === "GET") return await apiLicenseStatus();
    if (path === "api/license/activate" && method === "POST") return await apiLicenseActivate(body);
    if (path === "api/license/deactivate" && method === "POST") return await apiLicenseDeactivate();
    const e = new Error("Not Found: " + path); e.status = 404; throw e;
  }

  window.WebApi = { handle };
})();

/* ============ fetch 拦截: /api/* 走本地实现 ============ */
(function () {
  const realFetch = window.fetch ? window.fetch.bind(window) : null;
  window.fetch = async function (input, init) {
    const url = typeof input === "string" ? input : (input && input.url) || "";
    if (/^\/?api\//.test(url)) {
      try {
        const method = (init && init.method) || "GET";
        let body;
        if (init && init.body) { try { body = JSON.parse(init.body); } catch (e) {} }
        const path = url.replace(/^\/+/, "");
        const data = await window.WebApi.handle(path, method, body);
        return { ok: true, status: 200, json: async () => data };
      } catch (e) {
        const errData = { ok: false, error: e?.message || String(e) };
        if (e && e.license) errData.license = true;
        return { ok: false, status: e && e.status ? e.status : 500, json: async () => errData };
      }
    }
    if (realFetch) return realFetch(input, init);
    throw new Error("fetch not available");
  };
})();