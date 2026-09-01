/* BNB 批量转账 APP 前端逻辑 */
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtNum = (n) => { const v = Math.round(Number(n) * 1e8) / 1e8; return v.toLocaleString("zh-CN", { maximumFractionDigits: 8 }); };

let items = [];       // 当前名单
let transferSymbol = "";  // 转账参数代币合约的币名
let previewData = null;
let sendJobId = null;
let pollTimer = null;

/* ---------------- 配置读取 ---------------- */
function readConfig() {
  const walletType = $("walletType").value;
  const cfg = {
    rpc: $("cfgRpc").value.trim() || undefined,
    chainId: Number($("cfgChainId").value) || 56,
    senders: 1,
    startIndex: 0,
    maxGasPrice: Number($("cfgMaxGas").value) || 10,
    confirmations: Math.max(0, Number($("cfgConfirmations").value) || 0),
    feeMode: $("cfgFeeMode").value,
    gasSpeed: $("cfgGasSpeed").value,
    skipBalanceCheck: $("cfgSkipBalance").checked,
    token: $("cfgToken").value.trim() || undefined,
    items,
  };
  if (!cfg.token) cfg.token = undefined;
  if (walletType === "mnemonic") cfg.mnemonic = $("walletInput").value.trim();
  else if (walletType === "privateKeys") cfg.privateKeys = $("walletInput").value.trim();
  else if (walletType === "managed") {
    if (!managedWallets.length) throw new Error("管理列表为空, 请先到「钱包管理」导入钱包");
    const checked = [...document.querySelectorAll(".transfer-managed-check:checked")].map((c) => Number(c.dataset.i));
    if (!checked.length) throw new Error("请勾选要作为发送方的钱包(管理列表)");
    const keys = checked.map((i) => managedWallets[i].privateKey).filter(Boolean);
    if (!keys.length) throw new Error("勾选的钱包没有本会话私钥, 请先到「钱包管理」导入私钥");
    cfg.privateKeys = keys.join(",");
    cfg.senders = keys.length; // 勾选几个就用几个发送钱包(轮询)
  }
  return cfg;
}

/* ---------------- 名单 ---------------- */
function renderItems() {
  if (!items.length) items.push({ row: 1, to: "", amount: "", remark: "", walletIndex: -1 });
  const tb = $("itemsBody");
  tb.innerHTML = "";
  let total = 0;
  items.forEach((it, i) => {
    total += Number(it.amount) || 0;
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="cell-to">
        <input data-i="${i}" data-k="to" value="${esc(it.to)}" placeholder="0x…">
        ${managedWallets.length ? `<select class="pick-managed" data-pick="${i}" title="从管理列表选择地址">
          <option value="">📖 从列表选…</option>
          ${managedWallets.map((w, j) => `<option value="${esc(w.address)}">#${j + 1} ${esc(w.label || w.address.slice(0, 10) + "…")}</option>`).join("")}
        </select>` : ""}
      </td>
      <td><input data-i="${i}" data-k="amount" value="${esc(it.amount)}"></td>
      <td><input data-i="${i}" data-k="remark" value="${esc(it.remark)}"></td>
      <td><input data-i="${i}" data-k="walletIndex" value="${it.walletIndex >= 0 ? it.walletIndex : ""}" placeholder="轮询"></td>
      <td class="mono">${it.balance != null ? esc(it.balance) : "—"}</td>
      <td><button class="btn ghost" data-del="${i}">删除</button></td>`;
    tb.appendChild(tr);
  });
  const real = items.filter((it) => it.to && it.amount);
  $("itemsTable").hidden = false;
  $("btnAddRow").hidden = false;
  $("btnCheckBalances").hidden = real.length === 0;
  if (window.renderTransferRecv) renderTransferRecv();
  $("listSummary").innerHTML = real.length
    ? `共 <b>${real.length}</b> 笔, 合计 <b>${fmtNum(real.reduce((s, it) => s + Number(it.amount || 0), 0))}</b> ${transferSymbol || "代币"}` : "";
}

$("itemsBody").addEventListener("input", (e) => {
  const el = e.target, i = Number(el.dataset.i), k = el.dataset.k;
  if (!items[i]) return;
  if (k === "walletIndex") items[i].walletIndex = el.value === "" ? -1 : Number(el.value);
  else if (k === "amount") items[i].amount = el.value;
  else items[i][k] = el.value;
});
$("itemsBody").addEventListener("change", (e) => {
  const pick = e.target.dataset.pick;
  if (pick == null) return;
  const i = Number(pick);
  const val = e.target.value;
  if (val && items[i]) {
    items[i].to = val;
    const input = e.target.closest("tr").querySelector('input[data-k="to"]');
    if (input) input.value = val;
  }
  e.target.value = "";
});
$("itemsBody").addEventListener("click", (e) => {
  const i = e.target.dataset.del;
  if (i != null) { items.splice(Number(i), 1); items.forEach((it, idx) => (it.row = idx + 1)); renderItems(); }
});
$("btnAddRow").addEventListener("click", () => {
  items.push({ row: items.length + 1, to: "", amount: "", remark: "", walletIndex: -1 });
  renderItems();
});

$("btnCheckBalances").addEventListener("click", async () => {
  const addrs = [...new Set(items.map((it) => it.to).filter(Boolean))];
  if (!addrs.length) { setErr("listErr", "接收名单里还没有地址"); return; }
  setErr("listErr", "");
  try {
    $("btnCheckBalances").disabled = true;
    $("btnCheckBalances").textContent = "查询中…";
    const data = await api("/api/wallets/balances", {
      rpc: $("cfgRpc").value.trim() || undefined,
      chainId: Number($("cfgChainId").value) || 56,
      addresses: addrs,
      token: $("cfgToken").value.trim() || undefined,
    });
    const map = {};
    for (const b of data.balances) map[b.address.toLowerCase()] = b.balance;
    for (const it of items) it.balance = it.to ? (map[it.to.toLowerCase()] ?? null) : null;
    renderItems();
    const total = items.reduce((s, it) => s + (Number(it.balance) || 0), 0);
    flashMsg("listErr", `✅ 已查询 ${addrs.length} 个地址余额, 合计 ${fmtNum(total)} ${transferSymbol || "代币"}`, true);
  } catch (e) { setErr("listErr", e.message); }
  finally { $("btnCheckBalances").disabled = false; $("btnCheckBalances").textContent = "🔍 查询接收人余额"; }
});

$("transferPctBox").addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-pct]");
  if (!btn) return;
  const pct = Number(btn.dataset.pct) / 100;
  try {
    const cfg = readConfig();
    if (!cfg.mnemonic && !cfg.privateKeys && !cfg.secretsJson) { setErr("listErr", "请先填写发送钱包(助记词/私钥)"); return; }
    const engine = new window.EngineLib.TransferEngine({ rpc: cfg.rpc, chainId: cfg.chainId, maxGasPrice: 10, feeMode: "legacy" });
    const secrets = { mnemonic: cfg.mnemonic, privateKeys: cfg.privateKeys };
    const senders = window.EngineLib.buildSenders(secrets, { senders: 1, startIndex: 0 });
    const addr = senders[0].address;
    let amt;
    if (cfg.token) {
      const info = await window.EngineLib.getTokenInfo(engine, cfg.token);
      const tokenIface = new ethers.Interface(window.EngineLib.TOKEN_ABI);
      const balData = tokenIface.encodeFunctionData("balanceOf", [addr]);
      const bal = BigInt(tokenIface.decodeFunctionResult("balanceOf", (await engine.call((p) => p.call({ to: cfg.token, data: balData }), "查询代币余额")))[0]);
      amt = Number(ethers.formatUnits(bal, info.decimals)) * pct;
    } else {
      const bal = await engine.call((p) => p.getBalance(addr), "查询 BNB 余额");
      amt = Number(ethers.formatEther(bal)) * pct;
    }
    const v = trimNum(amt);
    if (v === "") { setErr("listErr", "钱包余额为 0, 无法按比例填写"); return; }
    $("batchAmount").value = v;
    flashMsg("listErr", "✅ 已按 " + btn.dataset.pct + "% 填入每笔数量 " + v + (cfg.token ? " (代币)" : " (BNB)"), true);
  } catch (e2) { setErr("listErr", "查询余额失败: " + (e2?.message || e2)); }
});
$("btnBatchAmount").addEventListener("click", () => {
  const v = $("batchAmount").value.trim();
  if (v === "" || isNaN(Number(v)) || Number(v) <= 0) { setErr("listErr", "请先填写每笔金额（大于 0）"); return; }
  const targets = items.filter((it) => it.to);
  if (!targets.length) { setErr("listErr", "接收名单里还没有地址，先填地址再批量填金额"); return; }
  setErr("listErr", "");
  for (const it of items) if (it.to) it.amount = v;
  renderItems();
  flashMsg("listErr", `✅ 已把 ${targets.length} 行的金额批量填为 ${v} ${transferSymbol || "代币"}`, true);
});


/* 接收名单: 从管理列表勾选添加接收人 */
function renderTransferRecv() {
  const box = $("transferRecvBox");
  if (!box) return;
  box.hidden = managedWallets.length === 0;
  const tb = $("transferRecvTable");
  if (!managedWallets.length) { if (tb) tb.innerHTML = ""; return; }
  $("transferRecvHint").textContent = `共 ${managedWallets.length} 个管理钱包, 勾选后加入接收名单`;
  tb.innerHTML = `
    <thead><tr>
      <th style="width:34px"><input type="checkbox" id="transferRecvAll" checked title="全选"></th>
      <th>#</th>
      <th>地址</th><th>标签</th>
    </tr></thead>
    <tbody>${managedWallets.map((w, i) => `
      <tr>
        <td><input type="checkbox" class="recv-check" data-i="${i}" checked></td>
        <td class="row-num">${i + 1}</td>
        <td class="mono">${esc(w.address)}</td>
        <td>${esc(w.label || "")}</td>
      </tr>`).join("")}</tbody>`;
}
$("transferRecvTable")?.addEventListener("change", (e) => {
  if (e.target.id === "transferRecvAll") {
    document.querySelectorAll(".recv-check").forEach((c) => (c.checked = e.target.checked));
  }
});
$("btnAddRecvManaged")?.addEventListener("click", () => {
  const selected = [...document.querySelectorAll(".recv-check:checked")].map((c) => Number(c.dataset.i));
  if (!selected.length) { setErr("listErr", "请勾选要加入接收名单的管理钱包"); return; }
  setErr("listErr", "");
  items = items.filter((it) => it.to || it.amount);
  const chosen = selected.map((i) => managedWallets[i]);
  for (const w of chosen) {
    items.push({ row: items.length + 1, to: w.address, amount: "", remark: w.label || "", walletIndex: -1 });
  }
  renderItems();
  flashMsg("listErr", `✅ 已把 ${chosen.length} 个管理钱包加入接收名单, 请在金额列填写数量`, true);
});

function applyParsed(parsed) {
  items = parsed.map((it, i) => ({ row: i + 1, to: it.to, amount: it.amount, remark: it.remark ?? "", walletIndex: it.walletIndex ?? -1 }));
  renderItems();
  setErr("listErr", "");
}

async function api(path, body) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({ ok: false, error: "响应解析失败" }));
  if (!res.ok || data.ok === false) {
    if (data && data.license) { showLicenseGate(data.error || "需要有效的会员密钥"); throw new Error(data.error || "需要有效的会员密钥"); }
    throw new Error(data.error || `请求失败 (${res.status})`);
  }
  return data;
}

$("fileInput").addEventListener("change", async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  $("fileName").textContent = f.name;
  setErr("listErr", "");
  try {
    const buf = await f.arrayBuffer();
    const dataBase64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
    const data = await api("/api/parse", { filename: f.name, dataBase64 });
    applyParsed(data.items);
  } catch (err) {
    setErr("listErr", err.message);
  }
  e.target.value = "";
});


$("walletType").addEventListener("change", () => {
  const t = $("walletType").value;
  $("walletInput").hidden = t === "secretsFile" || t === "managed";
  $("btnSecretsFile").hidden = t !== "secretsFile";
  $("walletErr").textContent = "";
  $("walletErr").hidden = true;
  $("transferManagedBox").hidden = t !== "managed";
  if (t === "managed") renderTransferManaged();
});

/* 转账页: 管理列表勾选作为发送方 */
function renderTransferManaged() {
  const tb = $("transferManagedTable");
  $("transferManagedBox").hidden = false;
  if (!managedWallets.length) {
    tb.innerHTML = `<tbody><tr><td class="hint">管理列表为空, 请先到「钱包管理」导入钱包</td></tr></tbody>`;
    $("transferManagedHint").textContent = "";
    return;
  }
  const withKeys = managedWallets.filter((w) => w.privateKey).length;
  $("transferManagedHint").textContent = `共 ${managedWallets.length} 个, 其中 ${withKeys} 个有本会话私钥可作发送方; 勾选后作为可用发送钱包(轮询)`;
  tb.innerHTML = `
    <thead><tr>
      <th style="width:34px"><input type="checkbox" id="transferManagedAll" checked title="全选"></th>
      <th>#</th>
      <th>地址</th><th>标签</th><th>发送方</th>
    </tr></thead>
    <tbody>${managedWallets.map((w, i) => `
      <tr>
        <td><input type="checkbox" class="transfer-managed-check" data-i="${i}" checked></td>
        <td class="row-num">${i + 1}</td>
        <td class="mono">${esc(w.address)}</td>
        <td>${esc(w.label || "")}</td>
        <td>${w.privateKey ? "✅ 有私钥" : "🔒 无私钥"}</td>
      </tr>`).join("")}</tbody>`;
}
$("transferManagedTable").addEventListener("change", (e) => {
  if (e.target.id === "transferManagedAll") {
    document.querySelectorAll(".transfer-managed-check").forEach((c) => (c.checked = e.target.checked));
  }
});
$("btnSecretsFile").addEventListener("click", () => $("secretsFile").click());
$("secretsFile").addEventListener("change", async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  try {
    const text = await f.text();
    const obj = JSON.parse(text);
    if (!obj.mnemonic && !obj.privateKeys && !obj.private_keys && !obj.keys) throw new Error("secrets.json 中需要 mnemonic 或 privateKeys 字段");
    window._secretsJson = obj;
    setErr("walletErr", "");
    $("walletInput").placeholder = `已加载 ${f.name} (${obj.mnemonic ? "助记词" : "私钥"})`;
    $("walletInput").value = "";
    $("walletInput").hidden = true;
    $("btnSecretsFile").textContent = `已选择 ${f.name} (点击更换)`;
  } catch (err) { setErr("walletErr", err.message); }
});

/* ---------------- 代币币名识别 ---------------- */
let cfgTokenSymTimer = null;
$("cfgToken").addEventListener("input", () => {
  clearTimeout(cfgTokenSymTimer);
  cfgTokenSymTimer = setTimeout(async () => {
    const addr = $("cfgToken").value.trim();
    const sp = $("cfgTokenSym");
    const hintEl = $("recvTokenHint");
    if (!ethers.isAddress(addr)) { sp.textContent = ""; transferSymbol = ""; if (hintEl) hintEl.textContent = "请先在「转账参数」填写代币合约地址"; renderItems(); return; }
    sp.textContent = "查询中…";
    if (hintEl) hintEl.textContent = "接收币种: 查询中…";
    try {
      const engine = new window.EngineLib.TransferEngine({ rpc: $("cfgRpc").value.trim() || undefined, chainId: Number($("cfgChainId").value) || 56, maxGasPrice: 10, feeMode: "legacy" });
      const info = await window.EngineLib.getTokenInfo(engine, addr);
      transferSymbol = info.symbol || "";
      sp.textContent = info.symbol ? "币种: " + info.symbol : "";
      if (hintEl) hintEl.textContent = info.symbol ? "接收币种: " + info.symbol + "（来自转账参数代币合约）" : "接收币种: 已填代币合约地址";
      renderItems();
    } catch (e2) { sp.textContent = ""; transferSymbol = ""; if (hintEl) hintEl.textContent = "接收币种: 已填代币合约地址(查询币名失败)"; renderItems(); }
  }, 700);
});

/* ---------------- 干跑检查 ---------------- */
async function doPreview() {
  setErr("actionErr", "");
  if (!items.some((it) => it.to && it.amount)) { setErr("actionErr", "请先填写接收名单（地址 + 金额）"); return; }
  const cfg = readConfig();
  cfg.secretsJson = window._secretsJson;
  if (!cfg.mnemonic && !cfg.privateKeys && !cfg.secretsJson) {
    setErr("actionErr", "请先填写助记词或私钥");
    return;
  }
  try {
    $("btnPreview").disabled = true;
    $("btnPreview").textContent = "检查中…";
    const data = await api("/api/preview", cfg);
    previewData = data;
    renderPreview(data);
    if (!data.balanceOk) setErr("actionErr", "⚠️ 存在余额不足或查询失败, 请充值后再发送。" + (data.balanceError ? "\n" + data.balanceError : ""));
  } catch (err) {
    setErr("actionErr", err.message);
  } finally {
    $("btnPreview").disabled = false;
    $("btnPreview").textContent = "🔍 干跑检查";
  }
}

function renderPreview(data) {
  $("previewBox").hidden = false;
  $("walletCards").innerHTML = data.wallets.map((w) => `
    <div class="wallet-card"><div class="addr">#${w.index} ${w.address}</div></div>`).join("");
  $("previewTable").innerHTML = `
    <thead><tr><th>发送钱包</th><th>收款地址</th><th>金额 (代币)</th><th>备注</th></tr></thead>
    <tbody>${data.plan.map((p) => `
      <tr><td>${esc(p.from)}</td><td>${esc(p.to)}</td><td>${p.amount}</td><td>${esc(p.remark)}</td></tr>`).join("")}</tbody>`;
}

/* ---------------- 发送 ---------------- */
async function doSend() {
  setErr("actionErr", "");
  if (!items.some((it) => it.to && it.amount)) { setErr("actionErr", "请先填写接收名单（地址 + 金额）"); return; }
  const cfg = readConfig();
  cfg.secretsJson = window._secretsJson;
  if (!cfg.mnemonic && !cfg.privateKeys && !cfg.secretsJson) {
    setErr("actionErr", "请先填写助记词或私钥");
    return;
  }
  const total = items.reduce((s, i) => s + Number(i.amount || 0), 0);
  const ok = confirm(`即将广播 ${items.length} 笔转账, 合计 ${fmtNum(total)} ${transferSymbol || "代币"}。\n\n请确认: 名单、收款地址、金额、发送钱包、链(chainId=${cfg.chainId})都已核对无误。\n继续吗?`);
  if (!ok) return;

  try {
    $("btnSend").disabled = true;
    $("sendHint").textContent = "";
    const data = await api("/api/send", cfg);
    sendJobId = data.jobId;
    $("sendBox").hidden = false;
    $("logBox").textContent = "任务已创建, 等待执行…";
    $("progressText").textContent = "0%";
    $("progressBar").style.width = "0%";
    $("resultTable").innerHTML = "";
    $("btnDownload").hidden = true;
    pollTimer = setInterval(pollJob, 1000);
  } catch (err) {
    setErr("actionErr", err.message);
    $("btnSend").disabled = false;
  }
}

async function pollJob() {
  if (!sendJobId) return;
  try {
    const res = await fetch("/api/job/" + sendJobId);
    const data = await res.json();
    if (data.logs && data.logs.length) $("logBox").textContent = data.logs.join("\n");
    const pct = data.total ? Math.round((data.done / data.total) * 100) : 0;
    $("progressText").textContent = `${data.done}/${data.total} (${pct}%)`;
    $("progressBar").style.width = pct + "%";
    if (data.results && data.results.length) renderResults(data.results);
    if (data.status === "done" || data.status === "failed") {
      clearInterval(pollTimer);
      $("btnSend").disabled = false;
      if (data.status === "failed") setErr("actionErr", "发送失败: " + data.error);
      else {
        const okCount = data.results.filter((r) => r.status === "ok").length;
        setErr("actionErr", okCount === data.total ? `✅ 全部完成: ${okCount}/${data.total} 笔成功` : `⚠️ 完成: ${okCount}/${data.total} 笔成功, 请查看结果表核对失败项`);
        $("btnDownload").hidden = data.results.length === 0;
      }
    }
  } catch (e) {
    // 暂时忽略轮询错误
  }
}

function renderResults(results) {
  window._lastResults = results; // 供下载 CSV 使用
  $("resultTable").innerHTML = `
    <thead><tr><th>发送钱包</th><th>收款地址</th><th>金额</th><th>状态</th><th>Tx Hash</th><th>区块</th><th>错误</th></tr></thead>
    <tbody>${results.map((r) => `
      <tr>
        <td>${esc(r.from)}</td><td>${esc(r.to)}</td><td>${r.amount}</td>
        <td class="${r.status === "ok" ? "status-ok" : "status-failed"}">${r.status === "ok" ? "成功" : "失败"}</td>
        <td>${r.txHash ? esc(r.txHash) : ""}</td><td>${esc(r.blockNumber)}</td><td>${esc(r.error)}</td>
      </tr>`).join("")}</tbody>`;
}

$("btnDownload").addEventListener("click", () => {
  const rows = window._lastResults || [];
  const head = ["row", "from", "to", "amount", "remark", "status", "tx_hash", "block_number", "error"];
  const lines = [head.join(",")];
  for (const r of rows) {
    lines.push([r.row, r.from, r.to, r.amount, r.remark, r.status, r.txHash, r.blockNumber, r.error].map(csv).join(","));
  }
  const blob = new Blob(["\uFEFF" + lines.join("\n")], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "results.csv";
  a.click();
  URL.revokeObjectURL(a.href);
});
const csv = (v) => { const s = String(v ?? ""); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

function setErr(id, msg) {
  const el = $(id);
  el.textContent = msg;
  el.hidden = !msg;
}

$("btnPreview").addEventListener("click", doPreview);
$("btnSend").addEventListener("click", doSend);

/* ============ 通用小工具 ============ */
function flashMsg(id, msg, ok) {
  const el = $(id);
  el.textContent = msg;
  el.style.color = ok ? "#22c55e" : "";
  el.hidden = false;
}
async function copyText(text, what) {
  try { await navigator.clipboard.writeText(text); alert(`${what}已复制到剪贴板`); }
  catch { prompt(`请手动复制${what}:`, text); }
}
function downloadCsv(text, filename) {
  const blob = new Blob(["\uFEFF" + text], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

/* ============ ⑤ 批量创建冷钱包 ============ */
// genState: 累积本次会话生成的钱包; 再次点击「生成钱包」会接在末尾继续追加, 不清空之前的
let genState = { wallets: [], mnemonics: [], currentMnemonic: null, nextIndex: 0, mode: null, lastMnemonic: null };
const maskKey = (k) => k ? k.slice(0, 10) + "…" + k.slice(-6) + " (点击显示)" : "";

$("genMode").addEventListener("change", () => {
  $("genMnemonicRow").hidden = $("genMode").value !== "existing_mnemonic";
});

$("btnGen").addEventListener("click", async () => {
  setErr("genErr", "");
  const mode = $("genMode").value;
  const count = Math.min(1000, Math.max(1, Number($("genCount").value) || 1));
  const userStart = Math.max(0, Number($("genStartIndex").value) || 0);
  const mnemonic = $("genMnemonic").value.trim();

  if (mode === "existing_mnemonic" && !mnemonic) { setErr("genErr", "请粘贴已有助记词"); return; }

  // 是否延续上一批: 同一种方式, 且助记词模式要求助记词相同 -> 从上次末尾继续
  const sameMode = genState.mode === mode;
  const continuing = sameMode && (mode === "new_mnemonic" || mode === "random_keys" || genState.lastMnemonic === mnemonic);

  let startIndex = userStart;
  let useMnemonic = mnemonic || undefined;
  if (mode === "new_mnemonic") {
    if (continuing && genState.currentMnemonic) {
      useMnemonic = genState.currentMnemonic;
      startIndex = genState.nextIndex;
    } else if (genState.wallets.length) {
      setErr("genErr", "⚠️ 将生成新的助记词, 表格会混合多个助记词的钱包(导出 CSV 会包含全部助记词)");
    }
  } else if (mode === "existing_mnemonic") {
    if (continuing && genState.currentMnemonic === mnemonic) {
      startIndex = genState.nextIndex;
    } else if (genState.mnemonics.length) {
      setErr("genErr", "⚠️ 助记词已更换, 表格会混合多个助记词的钱包(导出 CSV 会包含全部助记词)");
    }
  } else {
    // random_keys: 接在末尾继续编号
    startIndex = genState.wallets.length ? genState.nextIndex : userStart;
  }

  try {
    $("btnGen").disabled = true;
    const data = await api("/api/wallets/generate", { mode, count, startIndex, mnemonic: useMnemonic });
    // 记录助记词(供导出注释)
    if (data.mnemonic) {
      genState.currentMnemonic = data.mnemonic;
      genState.lastMnemonic = data.mnemonic;
      if (!genState.mnemonics.includes(data.mnemonic)) genState.mnemonics.push(data.mnemonic);
    } else if (mode === "existing_mnemonic" && mnemonic) {
      genState.lastMnemonic = mnemonic;
      if (!genState.mnemonics.includes(mnemonic)) genState.mnemonics.push(mnemonic);
    }
    genState.mode = mode;
    genState.wallets = genState.wallets.concat(data.wallets);
    genState.nextIndex = Math.max(...data.wallets.map((w) => w.index)) + 1;

    $("genMnemonicOut").hidden = !genState.currentMnemonic;
    if (genState.currentMnemonic) $("genMnemonicText").textContent = genState.currentMnemonic;
    $("genTableBox").hidden = false;
    renderGenTable();
    $("genSummary").textContent = `本次会话共 ${genState.wallets.length} 个 (本次新增 ${data.wallets.length} 个)`;
    $("btnGenToManager").hidden = false;
    $("btnGenExport").hidden = false;
  } catch (e) { setErr("genErr", e.message); }
  finally { $("btnGen").disabled = false; }
});

function renderGenTable() {
  $("genTable").innerHTML = `
    <thead><tr>
      <th style="width:34px"><input type="checkbox" id="genSelectAll" title="全选"></th>
      <th>#</th>
      <th>地址</th><th>私钥</th><th>操作</th>
    </tr></thead>
    <tbody>${genState.wallets.map((w, i) => `
      <tr>
        <td><input type="checkbox" class="gen-check" data-i="${i}"></td>
        <td class="row-num">${w.index}</td>
        <td class="mono">${esc(w.address)}</td>
        <td class="mono" id="genkey-${i}">${esc(maskKey(w.privateKey))}</td>
        <td>
          <button class="btn ghost" data-genshow="${i}">显示</button>
          <button class="btn ghost" data-gencopy="${i}">复制私钥</button>
        </td>
      </tr>`).join("")}</tbody>`;
  $("genTableBox").hidden = genState.wallets.length === 0;
  $("genSummary").textContent = genState.wallets.length ? `本次会话共 ${genState.wallets.length} 个` : "";
  updateGenDeleteBtn();
}

function updateGenDeleteBtn() {
  const btn = $("btnGenDelete");
  if (!btn) return;
  const n = document.querySelectorAll(".gen-check:checked").length;
  btn.hidden = genState.wallets.length === 0;
  btn.textContent = n ? `🗑️ 删除选中 (${n})` : "🗑️ 删除选中";
  btn.disabled = n === 0;
}

$("genTable").addEventListener("change", (e) => {
  if (e.target.id === "genSelectAll") {
    document.querySelectorAll(".gen-check").forEach((c) => (c.checked = e.target.checked));
    updateGenDeleteBtn();
  } else if (e.target.classList.contains("gen-check")) {
    if (!e.target.checked) { const sa = $("genSelectAll"); if (sa) sa.checked = false; }
    updateGenDeleteBtn();
  }
});

$("btnGenDelete").addEventListener("click", () => {
  const checked = [...document.querySelectorAll(".gen-check:checked")].map((c) => Number(c.dataset.i));
  if (!checked.length) return;
  if (!confirm(`确定删除选中的 ${checked.length} 个钱包?

仅从本页移除, 链上资产不受影响; 未备份的话建议先「导出 CSV」。`)) return;
  checked.sort((x, y) => y - x).forEach((i) => genState.wallets.splice(i, 1));
  if (!genState.wallets.length) {
    // 全部删除 -> 重置会话, 下次生成全新助记词
    genState = { wallets: [], mnemonics: [], currentMnemonic: null, nextIndex: 0, mode: null, lastMnemonic: null };
    $("genMnemonicOut").hidden = true;
    $("btnGenToManager").hidden = true;
    $("btnGenExport").hidden = true;
  } else {
    genState.nextIndex = Math.max(...genState.wallets.map((w) => w.index)) + 1;
  }
  renderGenTable();
  flashMsg("genErr", `✅ 已删除 ${checked.length} 个钱包`, true);
});

$("genTable").addEventListener("click", async (e) => {
  const i = e.target.dataset.genshow;
  if (i != null) {
    const cell = $("genkey-" + i);
    const w = genState.wallets[Number(i)];
    cell.textContent = cell.textContent.includes("点击显示") ? w.privateKey : maskKey(w.privateKey);
    return;
  }
  const c = e.target.dataset.gencopy;
  if (c != null) await copyText(genState.wallets[Number(c)].privateKey, "私钥");
});

$("btnCopyMnemonic").addEventListener("click", async () => copyText(genState.currentMnemonic, "助记词"));

$("btnGenToManager").addEventListener("click", async () => {
  if (!genState.wallets.length) return;
  for (const w of genState.wallets) {
    managedWallets.push({ address: w.address, label: "", hasKey: true, privateKey: w.privateKey, balance: null });
  }
  await saveManaged();
  renderMgrTable();
  flashMsg("genErr", `✅ 已把 ${genState.wallets.length} 个钱包加入管理列表, 请到「钱包管理」查看`, true);
});

$("btnGenExport").addEventListener("click", () => {
  if (!genState.wallets.length) return;
  if (!confirm("即将导出【含私钥】的 CSV 文件。\n请保存在安全/离线位置, 切勿上传或发给他人!\n\n确定导出吗?")) return;
  const lines = [];
  genState.mnemonics.forEach((m, i) => lines.push(`# 助记词${genState.mnemonics.length > 1 ? i + 1 : ""}: ${m}`));
  lines.push("index,address,private_key");
  for (const w of genState.wallets) lines.push(`${w.index},${w.address},${w.privateKey}`);
  downloadCsv(lines.join("\n"), "cold-wallets.csv");
});

/* ============ ⑥ 批量管理钱包 ============ */
let managedWallets = []; // {address,label,hasKey,privateKey?,balance?}

const MGR_PLACEHOLDER = {
  mnemonic: "粘贴助记词(12/24 个单词)…",
  privateKeys: "粘贴私钥, 逗号分隔, 如: 0x…,0x…",
  csv: "粘贴 CSV, 每行: address[,privateKey][,label]",
  csvfile: "选择 CSV / Excel 文件导入",
};
$("mgrMode").addEventListener("change", () => {
  const m = $("mgrMode").value;
  $("mgrInput").placeholder = MGR_PLACEHOLDER[m];
  $("mgrInput").hidden = m === "csvfile";
  $("btnMgrFile").hidden = m !== "csvfile";
  if (m !== "csvfile") $("mgrFileName").textContent = "";
});
$("btnMgrFile").addEventListener("click", () => $("mgrFile").click());
$("mgrFile").addEventListener("change", (e) => {
  const f = e.target.files[0];
  if (f) { $("mgrFileName").textContent = "已选择: " + f.name; setErr("mgrErr", ""); }
});

async function loadManaged() {
  try {
    const data = await (await fetch("/api/wallets/list")).json();
    managedWallets = (data.wallets || []).map((w) => ({ address: w.address, label: w.label ?? "", hasKey: !!w.hasKey, privateKey: null, balance: null }));
    renderMgrTable();
  } catch { /* 首次运行无文件属正常 */ }
}

async function saveManaged() {
  await api("/api/wallets/save", { wallets: managedWallets.map((w) => ({ address: w.address, label: w.label, hasKey: w.hasKey })) });
}

function renderMgrTable() {
  const tb = $("mgrTable");
  if (window.renderTransferRecv) renderTransferRecv();
  $("listManagedHint").textContent = managedWallets.length ? `管理列表共 ${managedWallets.length} 个钱包, 可在转账页勾选加入接收名单` : "";
  if (!managedWallets.length) { tb.innerHTML = ""; return; }
  const hasTokenCol = managedWallets.some((w) => w.tokenBalance != null);
  tb.innerHTML = `
    <thead><tr><th style="width:34px"><input type="checkbox" id="mgrSelectAll" title="全选"></th><th>#</th><th>地址</th><th>标签</th>${hasTokenCol ? `<th>代币余额 (${esc(managedWallets.find(w=>w.tokenSym)?.tokenSym || "TOKEN")})</th>` : ""}<th>余额 (BNB)</th><th>操作</th></tr></thead>
    <tbody>${managedWallets.map((w, i) => `
      <tr>
        <td><input type="checkbox" class="mgr-check" data-i="${i}"></td>
        <td class="row-num">${i + 1}</td>
        <td class="mono">${esc(w.address)}</td>
        <td><input data-mlabel="${i}" value="${esc(w.label)}"></td>
        ${hasTokenCol ? `<td class="mono">${w.tokenBalance != null ? esc(w.tokenBalance) : "—"}</td>` : ""}
        <td class="mono">${w.balance != null ? esc(w.balance) : "—"}</td>
        <td>
          <button class="btn ghost" data-mcopyaddr="${i}">复制地址</button>
          ${w.privateKey ? `<button class="btn ghost" data-mcopykey="${i}">复制私钥</button>` : w.hasKey ? `<span class="hint">🔑 有私钥(需重新导入)</span>` : ""}
          <button class="btn ghost" data-mdel="${i}">移除</button>
        </td>
      </tr>`).join("")}</tbody>`;
}

$("btnMgrImport").addEventListener("click", async () => {
  setErr("mgrErr", "");
  const mode = $("mgrMode").value;
  const input = $("mgrInput").value.trim();
  const body = { mode };
  if (mode === "csvfile") {
    const f = $("mgrFile").files[0];
    if (!f) { setErr("mgrErr", "请先选择 CSV / Excel 文件"); return; }
    body.mode = "csv";
    body.filename = f.name;
    const buf = await f.arrayBuffer();
    body.dataBase64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
  } else {
    if (!input) { setErr("mgrErr", "请先填写导入内容"); return; }
    if (mode === "mnemonic") {
      body.mnemonic = input;
      body.count = Math.min(1000, Math.max(1, Number($("mgrCount").value) || 1));
      body.startIndex = 0;
    } else if (mode === "privateKeys") body.privateKeys = input;
    else body.text = input;
  }
  try {
    const data = await api("/api/wallets/import", body);
    managedWallets = data.wallets.map((w) => ({ address: w.address, label: w.label ?? "", hasKey: !!w.privateKey, privateKey: w.privateKey || null, balance: null }));
    await saveManaged();
    renderMgrTable();
    flashMsg("mgrErr", `✅ 已导入 ${managedWallets.length} 个钱包`, true);
  } catch (e) { setErr("mgrErr", e.message); }
});

$("btnMgrBalances").addEventListener("click", async () => {
  if (!managedWallets.length) { setErr("mgrErr", "管理列表为空, 请先导入"); return; }
  setErr("mgrErr", "");
  try {
    $("btnMgrBalances").disabled = true;
    const data = await api("/api/wallets/balances", {
      rpc: $("cfgRpc").value.trim() || undefined,
      chainId: Number($("cfgChainId").value) || 56,
      addresses: managedWallets.map((w) => w.address),
      token: $("mgrTokenAddr").value.trim() || undefined,
    });
    const map = {};
    const tokenSym = data.symbol || null;
    for (const b of data.balances) {
      map[b.address.toLowerCase()] = b.balance;
      if (b.tokenBalance != null) {
        const w = managedWallets.find((x) => x.address.toLowerCase() === b.address.toLowerCase());
        if (w) { w.tokenBalance = b.tokenBalance; w.tokenSym = tokenSym; }
      }
    }
    for (const w of managedWallets) {
      w.balance = map[w.address.toLowerCase()] ?? null;
      if (!data.isToken) { w.tokenBalance = null; w.tokenSym = null; }
    }
    renderMgrTable();
  } catch (e) { setErr("mgrErr", e.message); }
  finally { $("btnMgrBalances").disabled = false; }
});
  $("btnMgrExport").addEventListener("click", () => {
  if (!managedWallets.length) return;
  const withKeys = $("mgrExportKeys").checked;
  if (withKeys && !confirm("导出【含私钥】: 请确保保存在安全位置!\n(仅本次会话导入的钱包才有私钥)\n\n确定?")) return;
  const lines = ["address,label,private_key"];
  for (const w of managedWallets) lines.push(`${w.address},${csv(w.label)},${withKeys ? (w.privateKey || "") : ""}`);
  downloadCsv(lines.join("\n"), "managed-wallets.csv");
});

$("btnMgrClear").addEventListener("click", async () => {
  if (!managedWallets.length) return;
  if (!confirm("清空管理列表?(仅删除本地列表记录, 不影响链上资产)")) return;
  managedWallets = [];
  await saveManaged();
  renderMgrTable();
});

$("mgrTable").addEventListener("click", async (e) => {
  const i = e.target.dataset.mcopyaddr;
  if (i != null) { await copyText(managedWallets[Number(i)].address, "地址"); return; }
  const k = e.target.dataset.mcopykey;
  if (k != null) { await copyText(managedWallets[Number(k)].privateKey, "私钥"); return; }
  const d = e.target.dataset.mdel;
  if (d != null) { managedWallets.splice(Number(d), 1); await saveManaged(); renderMgrTable(); }
});
$("mgrTable").addEventListener("change", async (e) => {
  const i = e.target.dataset.mlabel;
  if (i != null) { managedWallets[Number(i)].label = e.target.value; await saveManaged(); }
});
$("mgrTable").addEventListener("change", (e) => {
  if (e.target.id === "mgrSelectAll") {
    document.querySelectorAll(".mgr-check").forEach((c) => (c.checked = e.target.checked));
  }
});
$("btnMgrRemove").addEventListener("click", async () => {
  const checked = [...document.querySelectorAll(".mgr-check:checked")].map((c) => Number(c.dataset.i));
  if (!checked.length) { setErr("mgrErr", "请先勾选要移除的钱包"); return; }
  if (!confirm("确定移除选中的 " + checked.length + " 个钱包?")) return;
  checked.sort((x, y) => y - x).forEach((i) => managedWallets.splice(i, 1));
  await saveManaged();
  renderMgrTable();
  flashMsg("mgrErr", "✅ 已移除 " + checked.length + " 个钱包", true);
});

/* 启动时加载已保存的管理列表 */
loadManaged();

/* ============ 导航路由 ============ */
const PAGES = ["create", "manage", "transfer", "consolidate", "airdrop", "swap"];
function route() {
  const h = (location.hash || "#/transfer").replace(/^#\/?/, "");
  const page = PAGES.includes(h) ? h : "transfer";
  for (const p of PAGES) {
    const el = $("page-" + p);
    if (el) el.hidden = p !== page;
  }
  document.querySelectorAll("nav a").forEach((a) => a.classList.toggle("active", a.getAttribute("href") === "#/" + page));
  if (page === "consolidate" && $("conSource").value === "managed") renderConManaged();
  if (page === "swap" && $("swapWalletType").value === "managed") renderSwapManaged();
  if (page === "transfer" && $("walletType").value === "managed") renderTransferManaged();
  window.scrollTo(0, 0);
}
window.addEventListener("hashchange", route);
route();

/* ============ 批量资产归集 ============ */
let conPlan = null;
let conJobId = null;
let conPollTimer = null;

const CON_PLACEHOLDER = {
  mnemonic: "粘贴助记词(12/24 个单词)…",
  privateKeys: "粘贴私钥, 逗号分隔, 如: 0x…,0x…",
  managed: "从「钱包管理」列表读取(需该会话已导入私钥)",
};
$("conSource").addEventListener("change", () => {
  $("conInput").placeholder = CON_PLACEHOLDER[$("conSource").value];
  $("conInput").hidden = $("conSource").value === "managed";
  $("conCount").disabled = $("conSource").value !== "mnemonic";
  $("conManagedBox").hidden = $("conSource").value !== "managed";
  if ($("conSource").value === "managed") renderConManaged();
});

/* 管理列表勾选表格: 勾选哪些钱包就归集哪些 */
function renderConManaged() {
  const tb = $("conManagedTable");
  $("conManagedBox").hidden = false;
  if (!managedWallets.length) {
    tb.innerHTML = `<tbody><tr><td class="hint">管理列表为空, 请先到「钱包管理」导入钱包</td></tr></tbody>`;
    $("conManagedHint").textContent = "";
    return;
  }
  const withKeys = managedWallets.filter((w) => w.privateKey).length;
  $("conManagedHint").textContent = `共 ${managedWallets.length} 个, 其中 ${withKeys} 个有本会话私钥可归集; 无私钥的只能查余额`;
  const tokenSym = managedWallets.find((w) => w.conTokenSym)?.conTokenSym || null;
  tb.innerHTML = `
    <thead><tr>
      <th style="width:34px"><input type="checkbox" id="conManagedAll" checked title="全选"></th>
      <th>#</th>
      <th>地址</th><th>标签</th><th>${tokenSym ? `代币数量 (${esc(tokenSym)})` : "代币数量"}</th><th>可归集</th>
    </tr></thead>
    <tbody>${managedWallets.map((w, i) => `
      <tr>
        <td><input type="checkbox" class="con-managed-check" data-i="${i}" checked></td>
        <td class="row-num">${i + 1}</td>
        <td class="mono">${esc(w.address)}</td>
        <td>${esc(w.label || "")}</td>
        <td class="mono">${w.conTokenBalance != null ? esc(w.conTokenBalance) : "—"}</td>
        <td>${w.privateKey ? "✅ 有私钥" : "🔒 无私钥"}</td>
      </tr>`).join("")}</tbody>`;
}

$("conManagedTable").addEventListener("change", (e) => {
  if (e.target.id === "conManagedAll") {
    document.querySelectorAll(".con-managed-check").forEach((c) => (c.checked = e.target.checked));
  }
});

$("conPctBox").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-pct]");
  if (!btn) return;
  $("conPct").value = btn.dataset.pct;
  [...$("conPctBox").querySelectorAll("button")].forEach((b) => b.style.outline = b === btn ? "2px solid #22c55e" : "");
});

function conConfig() {
  const cfg = {
    source: $("conSource").value,
    target: $("conTarget").value.trim(),
    rpc: $("cfgRpc").value.trim() || undefined,
    chainId: Number($("cfgChainId").value) || 56,
    count: Math.min(1000, Math.max(1, Number($("conCount").value) || 1)),
    startIndex: Math.max(0, Number($("conStartIndex").value) || 0),
    token: $("conToken").value.trim() || undefined,
    pct: Number($("conPct").value) || 100,
  };
  if (cfg.source === "mnemonic") cfg.mnemonic = $("conInput").value.trim();
  else if (cfg.source === "privateKeys") cfg.privateKeys = $("conInput").value.trim();
  else {
    if (!managedWallets.length) throw new Error("管理列表为空, 请先到「钱包管理」导入钱包");
    const selected = [...document.querySelectorAll(".con-managed-check:checked")].map((c) => Number(c.dataset.i));
    if (!selected.length) throw new Error("请勾选要归集的源钱包(管理列表)");
    cfg.addresses = selected.map((i) => managedWallets[i].address);
    cfg.keys = selected.map((i) => managedWallets[i].privateKey || null);
  }
  return cfg;
}

let conSymTimer = null;
$("conToken").addEventListener("input", () => {
  clearTimeout(conSymTimer);
  conSymTimer = setTimeout(async () => {
    const addr = $("conToken").value.trim();
    const sp = $("conTokenSym");
    if (!ethers.isAddress(addr)) {
      sp.textContent = "";
      for (const w of managedWallets) { w.conTokenBalance = null; w.conTokenSym = null; }
      renderConManaged();
      return;
    }
    sp.textContent = "查询中…";
    try {
      const engine = new window.EngineLib.TransferEngine({ rpc: $("cfgRpc").value.trim() || undefined, chainId: Number($("cfgChainId").value) || 56, maxGasPrice: 10, feeMode: "legacy" });
      const info = await window.EngineLib.getTokenInfo(engine, addr);
      sp.textContent = info.symbol ? "币种: " + info.symbol : "";
      if (managedWallets.length) {
        try {
          const data = await api("/api/wallets/balances", {
            rpc: $("cfgRpc").value.trim() || undefined,
            chainId: Number($("cfgChainId").value) || 56,
            addresses: managedWallets.map((w) => w.address),
            token: addr,
          });
          for (const b of data.balances) {
            const w = managedWallets.find((x) => x.address.toLowerCase() === b.address.toLowerCase());
            if (w && b.tokenBalance != null) { w.conTokenBalance = b.tokenBalance; w.conTokenSym = data.symbol || info.symbol || "TOKEN"; }
          }
          renderConManaged();
        } catch (e3) {}
      }
    } catch (e2) { sp.textContent = ""; }
  }, 700);
});

  $("btnConPreview").addEventListener("click", async () => {
  setErr("conErr", "");
  const cfg = conConfig();
  if (!cfg.target || !/^0x[a-fA-F0-9]{40}$/.test(cfg.target)) { setErr("conErr", "目标地址无效(需 0x 开头 40 位十六进制)"); return; }
  try {
    $("btnConPreview").disabled = true;
    const data = await api("/api/consolidate/preview", cfg);
    conPlan = data;
    $("conPreviewBox").hidden = false;
    const unit = data.isToken ? (data.symbol || "代币") : "BNB";
    $("conSummary").textContent = `共 ${data.plan.length} 个源钱包, 可归集 ${data.okCount} 个, 合计 ${data.total} ${unit} (目标: ${data.target})`;
    $("conTable").innerHTML = `
      <thead><tr><th>源地址</th><th>余额 ${unit}</th><th>手续费</th><th>归集金额 ${unit}</th><th>状态</th></tr></thead>
      <tbody>${data.plan.map((p) => `
        <tr>
          <td class="mono">${esc(p.address)}</td>
          <td class="mono">${esc(p.balance)}</td><td class="mono">${esc(p.fee)}</td>
          <td class="mono">${p.ok ? esc(p.amount) : "—"}</td>
          <td class="${p.ok ? "status-ok" : "status-failed"}">${p.ok ? "✅ 可归集" : esc(p.reason)}</td>
        </tr>`).join("")}</tbody>`;
    if (!data.okCount) setErr("conErr", "没有可归集的钱包, 请检查余额/私钥/目标地址");
  } catch (e) { setErr("conErr", e.message); }
  finally { $("btnConPreview").disabled = false; }
});

$("btnConSend").addEventListener("click", async () => {
  setErr("conErr", "");
  const cfg = conConfig();
  if (!cfg.target || !/^0x[a-fA-F0-9]{40}$/.test(cfg.target)) { setErr("conErr", "目标地址无效"); return; }
  const conUnit = cfg.token ? ($("conTokenSym").textContent.replace("币种: ", "").trim() || "代币") : "BNB";
  if (!confirm(`即将把源钱包的 ${conUnit} 归集到:\n${cfg.target}\n\n请确认: 目标地址正确、源钱包私钥已导入、链(chainId=${cfg.chainId})正确。\n\n继续吗?`)) return;
  try {
    $("btnConSend").disabled = true;
    const data = await api("/api/consolidate/send", cfg);
    conJobId = data.jobId;
    $("conSendBox").hidden = false;
    $("conLogBox").textContent = "任务已创建, 等待执行…";
    $("conProgressText").textContent = "0%";
    $("conProgressBar").style.width = "0%";
    $("conResultTable").innerHTML = "";
    $("btnConDownload").hidden = true;
    conPollTimer = setInterval(pollConJob, 1000);
  } catch (e) { setErr("conErr", e.message); $("btnConSend").disabled = false; }
});

async function pollConJob() {
  if (!conJobId) return;
  try {
    const data = await (await fetch("/api/job/" + conJobId)).json();
    if (data.logs && data.logs.length) $("conLogBox").textContent = data.logs.join("\n");
    const pct = data.total ? Math.round((data.done / data.total) * 100) : 0;
    $("conProgressText").textContent = `${data.done}/${data.total} (${pct}%)`;
    $("conProgressBar").style.width = pct + "%";
    if (data.results && data.results.length) {
      $("conResultTable").innerHTML = `
        <thead><tr><th>源地址</th><th>目标</th><th>金额</th><th>状态</th><th>Tx Hash</th><th>错误</th></tr></thead>
        <tbody>${data.results.map((r) => `
          <tr><td class="mono">${esc(r.from)}</td><td class="mono">${esc(r.to)}</td><td>${r.amount}${r.symbol ? " " + esc(r.symbol) : ""}</td>
          <td class="${r.status === "ok" ? "status-ok" : "status-failed"}">${r.status === "ok" ? "成功" : "失败"}</td>
          <td class="mono">${r.txHash ? esc(r.txHash) : ""}</td><td>${esc(r.error)}</td></tr>`).join("")}</tbody>`;
      window._lastConResults = data.results;
    }
    if (data.status === "done" || data.status === "failed") {
      clearInterval(conPollTimer);
      $("btnConSend").disabled = false;
      if (data.status === "failed") setErr("conErr", "归集失败: " + data.error);
      else {
        const okCount = data.results.filter((r) => r.status === "ok").length;
        setErr("conErr", okCount === data.results.length ? `✅ 归集完成: ${okCount} 笔成功` : `⚠️ 归集完成: ${okCount}/${data.results.length} 成功, 请核对失败项`);
        $("btnConDownload").hidden = data.results.length === 0;
      }
    }
  } catch { /* 轮询错误忽略 */ }
}

$("btnConDownload").addEventListener("click", () => {
  const rows = window._lastConResults || [];
  const lines = ["row,from,to,amount,status,tx_hash,error"];
  for (const r of rows) lines.push(`${r.row},${r.from},${r.to},${r.amount},${r.status},${r.txHash || ""},${csv(r.error)}`);
  downloadCsv(lines.join("\n"), "consolidate-results.csv");
});

/* 初始渲染(放在所有声明之后, 避免 TDZ) */
if ($("recvTokenHint")) $("recvTokenHint").textContent = $("cfgToken").value.trim() ? "接收币种: 已填代币合约地址" : "请先在「转账参数」填写代币合约地址";
renderItems();
// 默认「管理列表」置顶, 触发一次切换让界面正确显示
$("walletType").dispatchEvent(new Event("change"));
$("swapWalletType").dispatchEvent(new Event("change"));
$("conSource").dispatchEvent(new Event("change"));

/* ============ 薄饼交易 (PancakeSwap 批量买卖) ============ */
let swapJobId = null;
let swapPollTimer = null;

/* 发送钱包 */
$("swapWalletType").addEventListener("change", () => {
  const t = $("swapWalletType").value;
  $("swapWalletInput").hidden = t === "secretsFile" || t === "managed";
  $("swapBtnSecretsFile").hidden = t !== "secretsFile";
  $("swapWalletErr").textContent = "";
  $("swapWalletErr").hidden = true;
  $("swapManagedBox").hidden = t !== "managed";
  if (t === "managed") renderSwapManaged();
});

/* 管理列表勾选: 勾选哪些钱包作为薄饼交易的发送方 */
function renderSwapManaged() {
  const tb = $("swapManagedTable");
  $("swapManagedBox").hidden = false;
  if (!managedWallets.length) {
    tb.innerHTML = `<tbody><tr><td class="hint">管理列表为空, 请先到「钱包管理」导入钱包</td></tr></tbody>`;
    $("swapManagedHint").textContent = "";
    return;
  }
  const withKeys = managedWallets.filter((w) => w.privateKey).length;
  $("swapManagedHint").textContent = `共 ${managedWallets.length} 个, 其中 ${withKeys} 个有本会话私钥可作发送方; 每个钱包可单独设置比例%, 交易数量=该钱包余额×比例 (买按BNB余额, 卖按代币余额)`;
  const tokenSym = managedWallets.find((w) => w.swapTokenSym)?.swapTokenSym || null;
  tb.innerHTML = `
    <thead><tr>
      <th style="width:34px"><input type="checkbox" id="swapManagedAll" checked title="全选"></th>
      <th>#</th>
      <th>地址</th><th>标签</th><th>比例 %</th><th>${tokenSym ? `代币余额 (${esc(tokenSym)})` : "代币余额"}</th><th>BNB 余额</th><th>发送方</th>
    </tr></thead>
    <tbody>${managedWallets.map((w, i) => `
      <tr>
        <td><input type="checkbox" class="swap-managed-check" data-i="${i}" checked></td>
        <td class="row-num">${i + 1}</td>
        <td class="mono">${esc(w.address)}</td>
        <td>${esc(w.label || "")}</td>
        <td><input type="number" class="swap-managed-pct" data-swapPct="${i}" value="${w.swapPct ?? 100}" min="0" max="100" step="1" style="width:70px"></td>
        <td class="mono">${w.swapTokenBal != null ? esc(w.swapTokenBal) : "—"}</td>
        <td class="mono">${w.swapBnbBal != null ? esc(w.swapBnbBal) : "—"}</td>
        <td>${w.privateKey ? "✅ 有私钥" : "🔒 无私钥"}</td>
      </tr>`).join("")}</tbody>`;
}

$("swapManagedTable").addEventListener("change", (e) => {
  if (e.target.id === "swapManagedAll") {
    document.querySelectorAll(".swap-managed-check").forEach((c) => (c.checked = e.target.checked));
  }
});
$("swapBtnSecretsFile").addEventListener("click", () => $("swapSecretsFile").click());
$("swapSecretsFile").addEventListener("change", async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  try {
    const obj = JSON.parse(await f.text());
    if (!obj.mnemonic && !obj.privateKeys && !obj.private_keys && !obj.keys) throw new Error("secrets.json 需 mnemonic 或 privateKeys 字段");
    window._swapSecretsJson = obj;
    $("swapWalletInput").value = "";
    $("swapWalletInput").hidden = true;
    $("swapBtnSecretsFile").textContent = `已选择 ${f.name} (点击更换)`;
  } catch (err) { setErr("swapWalletErr", err.message); }
});

async function readSwapConfig() {
  const t = $("swapWalletType").value;
  const token = $("swapTokenAddr").value.trim();
  if (!token) throw new Error("请填写合约地址(代币)");
  if (!ethers.isAddress(token)) throw new Error("合约地址无效: " + token);
  const direction = $("swapDirection").value;
  const qty = Number($("swapTokenQty").value);
  if (t !== "managed" && !(qty > 0)) throw new Error("请填写交易数量(代币)");
  const cfg = {
    rpc: $("cfgRpc").value.trim() || undefined,
    chainId: Number($("cfgChainId").value) || 56,
    senders: 1,
    startIndex: 0,
    slippage: Number($("swapSlippage").value) || 1,
  };
  let senderCount = 1;
  let swapCheckedIdx = [];
  if (t === "mnemonic") { cfg.mnemonic = $("swapWalletInput").value.trim(); }
  else if (t === "privateKeys") { cfg.privateKeys = $("swapWalletInput").value.trim(); senderCount = cfg.privateKeys.split(",").map((s) => s.trim()).filter(Boolean).length; cfg.senders = senderCount; }
  else if (t === "secretsFile") { cfg.secretsJson = window._swapSecretsJson; if (cfg.secretsJson) { const pk = cfg.secretsJson.privateKeys || cfg.secretsJson.private_keys || cfg.secretsJson.keys; if (Array.isArray(pk)) { senderCount = pk.length; cfg.senders = senderCount; } } }
  else {
    if (!managedWallets.length) throw new Error("管理列表为空, 请先到「钱包管理」导入钱包");
    const checked = [...document.querySelectorAll(".swap-managed-check:checked")].map((c) => Number(c.dataset.i));
    if (!checked.length) throw new Error("请勾选要作为交易钱包的钱包(管理列表)");
    swapCheckedIdx = checked;
    const keys = checked.map((i) => managedWallets[i].privateKey).filter(Boolean);
    if (!keys.length) throw new Error("勾选的钱包没有本会话私钥, 请先到「钱包管理」导入私钥");
    cfg.privateKeys = keys.join(",");
    cfg.senders = keys.length;
    senderCount = keys.length;
  }
  if (!cfg.mnemonic && !cfg.privateKeys && !cfg.secretsJson) throw new Error("请先填写交易钱包(助记词/私钥/管理列表)");
  if (t === "managed") {
    // 每个钱包按各自比例计算数量: 买=该钱包BNB余额*pct, 卖=该钱包代币余额*pct
    const engine = new window.EngineLib.TransferEngine({ rpc: cfg.rpc, chainId: cfg.chainId, maxGasPrice: 10, feeMode: "legacy" });
    const info = await window.EngineLib.getTokenInfo(engine, token);
    const tokenIface = new ethers.Interface(window.EngineLib.TOKEN_ABI);
    const out = [];
    let ki = 0;
    for (const mi of swapCheckedIdx) {
      const w = managedWallets[mi];
      if (!w.privateKey) continue;
      const pct = Number(document.querySelector(`[data-swapPct="${mi}"]`)?.value || 100);
      if (!(pct > 0)) continue;
      const pctN = pct / 100;
      let amount;
      if (direction === "buy") {
        const bal = await engine.call((p) => p.getBalance(w.address), "查询 BNB 余额");
        amount = Number(ethers.formatEther(bal)) * pctN;
      } else {
        const balData = tokenIface.encodeFunctionData("balanceOf", [w.address]);
        const bal = BigInt(tokenIface.decodeFunctionResult("balanceOf", (await engine.call((p) => p.call({ to: token, data: balData }), "查询代币余额")))[0]);
        amount = Number(ethers.formatUnits(bal, info.decimals)) * pctN;
      }
      if (!(amount > 0)) continue;
      out.push({ row: ki + 1, token: token, amount: amount, direction: direction, slippage: null, remark: "", walletIndex: ki });
      ki++;
    }
    if (!out.length) throw new Error("没有可执行的交易钱包, 请勾选并设置比例 > 0");
    cfg.items = out;
    return cfg;
  }
  let amount;
  if (direction === "buy") {
    const q = await swapQuote(token, qty, cfg, true);
    amount = Number(ethers.formatEther(q.bnbWei));
    if (!(amount > 0)) throw new Error("无法计算交易金额(BNB), 请检查合约地址与网络");
  } else {
    amount = qty;
  }
  cfg.items = Array.from({ length: senderCount }, (_, i) => ({ row: i + 1, token: token, amount: amount, direction: direction, slippage: null, remark: "", walletIndex: i }));
  return cfg;
}

/** 用 Router 报价: isBuy=买(需多少 BNB 得到 qty 代币), sell=卖 qty 代币得多少 BNB */
async function swapQuote(token, qty, cfg, isBuy) {
  const engine = new window.EngineLib.TransferEngine({ rpc: cfg.rpc, chainId: cfg.chainId, maxGasPrice: 10, feeMode: "legacy" });
  const info = await window.EngineLib.getTokenInfo(engine, token);
  const router = window.EngineLib.getRouterAddress({ chainId: cfg.chainId });
  const routerIface = new ethers.Interface(window.EngineLib.ROUTER_ABI);
  const qtyWei = ethers.parseUnits(String(qty), info.decimals);
  const path = isBuy ? [window.EngineLib.getWBNB(cfg.chainId), token] : [token, window.EngineLib.getWBNB(cfg.chainId)];
  const method = isBuy ? "getAmountsIn" : "getAmountsOut";
  const data = routerIface.encodeFunctionData(method, [qtyWei, path]);
  const ret = await engine.call((p) => p.call({ to: router, data }), "查询价格");
  const amounts = routerIface.decodeFunctionResult(method, ret)[0];
  const bnbWei = isBuy ? amounts[0] : amounts[amounts.length - 1];
  return { bnbWei: bnbWei, symbol: info.symbol, decimals: info.decimals };
}

let swapQtyTimer = null;
async function updateSwapQuote() {
  const sp = $("swapQuote");
  if (!sp) return;
  const qty = Number($("swapTokenQty").value);
  const token = $("swapTokenAddr").value.trim();
  if (!(qty > 0) || !ethers.isAddress(token)) { sp.textContent = ""; return; }
  sp.textContent = "计算中…";
  try {
    const cfg = swapWalletOnlyCfg();
    const isBuy = $("swapDirection").value === "buy";
    const q = await swapQuote(token, qty, cfg, isBuy);
    sp.textContent = (isBuy ? "交易金额 ≈ " : "可获得 ≈ ") + trimNum(Number(ethers.formatEther(q.bnbWei))) + " BNB";
  } catch (e2) { sp.textContent = ""; }
}
$("swapTokenQty").addEventListener("input", () => {
  clearTimeout(swapQtyTimer);
  swapQtyTimer = setTimeout(updateSwapQuote, 700);
});
$("swapTokenAddr").addEventListener("input", () => {
  clearTimeout(swapTopSymTimer);
  swapTopSymTimer = setTimeout(async () => {
    const addr = $("swapTokenAddr").value.trim();
    const sp = $("swapTokenName");
    if (!ethers.isAddress(addr)) {
      sp.textContent = "";
      for (const w of managedWallets) { w.swapTokenBal = null; w.swapTokenSym = null; w.swapBnbBal = null; }
      if ($("swapWalletType").value === "managed") renderSwapManaged();
      return;
    }
    sp.textContent = "查询中…";
    try {
      const engine = new window.EngineLib.TransferEngine({ rpc: $("cfgRpc").value.trim() || undefined, chainId: Number($("cfgChainId").value) || 56, maxGasPrice: 10, feeMode: "legacy" });
      const info = await window.EngineLib.getTokenInfo(engine, addr);
      sp.textContent = info.symbol ? "币种: " + info.symbol : "";
      if (managedWallets.length) {
        try {
          const data = await api("/api/wallets/balances", {
            rpc: $("cfgRpc").value.trim() || undefined,
            chainId: Number($("cfgChainId").value) || 56,
            addresses: managedWallets.map((w) => w.address),
            token: addr,
          });
          for (const b of data.balances) {
            const w = managedWallets.find((x) => x.address.toLowerCase() === b.address.toLowerCase());
            if (!w) continue;
            w.swapBnbBal = b.balance;
            if (b.tokenBalance != null) { w.swapTokenBal = b.tokenBalance; w.swapTokenSym = data.symbol || info.symbol || "TOKEN"; }
          }
          if ($("swapWalletType").value === "managed") renderSwapManaged();
        } catch (e3) {}
      }
    } catch (e2) { sp.textContent = ""; }
  }, 700);
});

  /* 交易百分比: 按余额比例自动填金额/数量 */
function swapWalletOnlyCfg() {
  const t = $("swapWalletType").value;
  const cfg = { rpc: $("cfgRpc").value.trim() || undefined, chainId: Number($("cfgChainId").value) || 56, senders: 1, startIndex: 0 };
  if (t === "mnemonic") cfg.mnemonic = $("swapWalletInput").value.trim();
  else if (t === "privateKeys") cfg.privateKeys = $("swapWalletInput").value.trim();
  else if (t === "secretsFile") cfg.secretsJson = window._swapSecretsJson;
  else {
    if (!managedWallets.length) throw new Error("管理列表为空, 请先到「钱包管理」导入钱包");
    const checked = [...document.querySelectorAll(".swap-managed-check:checked")].map((c) => Number(c.dataset.i));
    if (!checked.length) throw new Error("请勾选要作为交易钱包的钱包(管理列表)");
    const keys = checked.map((i) => managedWallets[i].privateKey).filter(Boolean);
    if (!keys.length) throw new Error("勾选的钱包没有本会话私钥");
    cfg.privateKeys = keys.join(",");
    cfg.senders = keys.length;
  }
  if (!cfg.mnemonic && !cfg.privateKeys && !cfg.secretsJson) throw new Error("请先填写交易钱包(助记词/私钥/管理列表)");
  return cfg;
}
function trimNum(n) {
  if (!isFinite(n) || n <= 0) return "";
  let s = n.toFixed(8);
  s = s.replace(/0+$/, "").replace(/\.$/, "");
  return s;
}
async function swapFillBalance(pct, target, isToken) {
  let cfg;
  try { cfg = swapWalletOnlyCfg(); } catch (err) { setErr("swapErr", err.message); return; }
  const token = $("swapTokenAddr").value.trim();
  if (isToken && !ethers.isAddress(token)) { setErr("swapErr", "请先填写合约地址(代币)"); return; }
  try {
    const engine = new window.EngineLib.TransferEngine({ rpc: cfg.rpc, chainId: cfg.chainId, maxGasPrice: 10, feeMode: "legacy" });
    const secrets = { mnemonic: cfg.mnemonic, privateKeys: cfg.privateKeys };
    const senders = window.EngineLib.buildSenders(secrets, { senders: 1, startIndex: cfg.startIndex || 0 });
    const addr = senders[0].address;
    let amt;
    if (isToken) {
      const info = await window.EngineLib.getTokenInfo(engine, token);
      if ($("swapDirection").value === "buy") {
        // 买方向: 用 pct 比例的 BNB 能买到多少代币, 填入交易数量
        const balBnb = await engine.call((p) => p.getBalance(addr), "查询 BNB 余额");
        const spend = Number(ethers.formatEther(balBnb)) * pct;
        const router = window.EngineLib.getRouterAddress({ chainId: cfg.chainId });
        const routerIface = new ethers.Interface(window.EngineLib.ROUTER_ABI);
        const path = [window.EngineLib.getWBNB(cfg.chainId), token];
        const data = routerIface.encodeFunctionData("getAmountsOut", [ethers.parseEther(String(spend)), path]);
        const ret = await engine.call((p) => p.call({ to: router, data }), "getAmountsOut");
        const out = routerIface.decodeFunctionResult("getAmountsOut", ret)[0].slice(-1)[0];
        amt = Number(ethers.formatUnits(out, info.decimals));
      } else {
        const tokenIface = new ethers.Interface(window.EngineLib.TOKEN_ABI);
        const balData = tokenIface.encodeFunctionData("balanceOf", [addr]);
        const bal = BigInt(tokenIface.decodeFunctionResult("balanceOf", (await engine.call((p) => p.call({ to: token, data: balData }), "查询代币余额")))[0]);
        amt = Number(ethers.formatUnits(bal, info.decimals)) * pct;
      }
    } else {
      const bal = await engine.call((p) => p.getBalance(addr), "查询 BNB 余额");
      amt = Number(ethers.formatEther(bal)) * pct;
    }
    const v = trimNum(amt);
    if (v === "") { setErr("swapErr", "钱包余额为 0, 无法按比例填写"); return; }
    $(target).value = v;
    flashMsg("swapErr", "✅ 已按 " + Math.round(pct * 100) + "% 填入", true);
  } catch (e2) { setErr("swapErr", "查询余额失败: " + (e2?.message || e2)); }
}
$("swapQtyPct").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-pct]");
  if (!btn) return;
  const pct = Number(btn.dataset.pct);
  if ($("swapWalletType").value === "managed") {
    // 管理列表模式: 把比例批量填入每个钱包
    document.querySelectorAll(".swap-managed-pct").forEach((inp) => { inp.value = pct; });
    $("swapTokenQty").value = "";
    updateSwapQuote();
    return;
  }
  swapFillBalance(pct / 100, "swapTokenQty", true);
});$("swapDirection").addEventListener("change", () => {
  $("swapTokenQty").value = "";
  updateSwapQuote();
});

/* 检查与执行 */
$("swapBtnPreview").addEventListener("click", async () => {
  setErr("swapErr", "");
  try {
    const cfg = await readSwapConfig();
    if (!cfg.mnemonic && !cfg.privateKeys && !cfg.secretsJson) throw new Error("请先填写发送钱包(助记词/私钥/管理列表)");
    $("swapBtnPreview").disabled = true;
    const data = await api("/api/swap/preview", cfg);
    $("swapRouterShown").textContent = data.router;
    $("swapPreviewBox").hidden = false;
    $("swapPreviewTable").innerHTML = `
      <thead><tr><th>代币</th><th>方向</th><th>数量</th><th>预计输出</th><th>最少输出(滑点)</th><th>状态</th></tr></thead>
      <tbody>${data.plan.map((p) => `
        <tr>
          
          <td class="mono">${esc(p.token.slice(0, 10))}… ${esc(p.symbol)}</td>
          <td>${p.direction === "buy" ? "买" : "卖"}</td>
          <td class="mono">${esc(p.amountIn)}</td>
          <td class="mono">${p.out0 != null ? esc(p.out0) + (p.direction === "buy" ? " " + esc(p.symbol) : " BNB") : "—"}</td>
          <td class="mono">${p.outMin != null ? esc(p.outMin) : "—"}</td>
          <td class="${p.ok ? "status-ok" : "status-failed"}">${p.ok ? "✅ " + (p.reason || "可执行") : esc(p.reason)}</td>
        </tr>`).join("")}</tbody>`;
    if (!data.okCount) setErr("swapErr", "没有可执行的交易, 请检查余额/授权/代币地址");
  } catch (e) { setErr("swapErr", e.message); }
  finally { $("swapBtnPreview").disabled = false; }
});

$("swapBtnSend").addEventListener("click", async () => {
  setErr("swapErr", "");
  let cfg;
  try { cfg = await readSwapConfig(); }
  catch (e) { setErr("swapErr", e.message); return; }
  if (!cfg.mnemonic && !cfg.privateKeys && !cfg.secretsJson) { setErr("swapErr", "请先填写发送钱包(助记词/私钥/管理列表)"); return; }
  const ok = confirm(`即将在 PancakeSwap 用 ${cfg.items.length} 个钱包批量执行 ${cfg.items.length} 笔交易(卖单会自动先授权 Router)。\n\n请确认: 代币地址/方向/数量/滑点正确, 链(chainId=${cfg.chainId})正确。\n\n继续吗?`);
  if (!ok) return;
  try {
    $("swapBtnSend").disabled = true;
    const data = await api("/api/swap/send", cfg);
    swapJobId = data.jobId;
    $("swapSendBox").hidden = false;
    $("swapLogBox").textContent = "任务已创建, 等待执行…";
    $("swapProgressText").textContent = "0%";
    $("swapProgressBar").style.width = "0%";
    $("swapResultTable").innerHTML = "";
    $("swapBtnDownload").hidden = true;
    swapPollTimer = setInterval(pollSwapJob, 1000);
  } catch (e) { setErr("swapErr", e.message); $("swapBtnSend").disabled = false; }
});

async function pollSwapJob() {
  if (!swapJobId) return;
  try {
    const data = await (await fetch("/api/job/" + swapJobId)).json();
    if (data.logs && data.logs.length) $("swapLogBox").textContent = data.logs.join("\n");
    const pct = data.total ? Math.round((data.done / data.total) * 100) : 0;
    $("swapProgressText").textContent = `${data.done}/${data.total} (${pct}%)`;
    $("swapProgressBar").style.width = pct + "%";
    if (data.results && data.results.length) {
      $("swapResultTable").innerHTML = `
        <thead><tr><th>代币</th><th>方向</th><th>数量</th><th>状态</th><th>Approve</th><th>Swap Tx</th><th>错误</th></tr></thead>
        <tbody>${data.results.map((r) => `
          <tr>
            
            <td class="mono">${esc(r.token.slice(0, 10))}… ${esc(r.symbol)}</td>
            <td>${r.direction === "buy" ? "买" : "卖"}</td>
            <td>${esc(r.amount)}</td>
            <td class="${r.status === "ok" ? "status-ok" : "status-failed"}">${r.status === "ok" ? "成功" : "失败"}</td>
            <td class="mono">${r.approveHash ? esc(r.approveHash.slice(0, 14)) + "…" : "—"}</td>
            <td class="mono">${r.txHash ? esc(r.txHash.slice(0, 14)) + "…" : "—"}</td>
            <td>${esc(r.error)}</td>
          </tr>`).join("")}</tbody>`;
      window._lastSwapResults = data.results;
    }
    if (data.status === "done" || data.status === "failed") {
      clearInterval(swapPollTimer);
      $("swapBtnSend").disabled = false;
      if (data.status === "failed") setErr("swapErr", "交易失败: " + data.error);
      else {
        const okCount = data.results.filter((r) => r.status === "ok").length;
        setErr("swapErr", okCount === data.results.length ? `✅ 完成: ${okCount} 笔成功` : `⚠️ 完成: ${okCount}/${data.results.length} 成功, 请核对失败项`);
        $("swapBtnDownload").hidden = data.results.length === 0;
      }
    }
  } catch { /* 轮询错误忽略 */ }
}

$("swapBtnDownload").addEventListener("click", () => {
  const rows = window._lastSwapResults || [];
  const lines = ["row,from,token,symbol,direction,amount,status,approve_hash,swap_hash,block_number,error"];
  for (const r of rows) lines.push(`${r.row},${r.from},${r.token},${r.symbol},${r.direction},${r.amount},${r.status},${r.approveHash || ""},${r.txHash || ""},${r.blockNumber || ""},${csv(r.error)}`);
  downloadCsv(lines.join("\n"), "swap-results.csv");
});



/* 初始渲染(放在所有声明之后, 避免 TDZ) */
renderItems();
// 默认「管理列表」置顶, 触发一次切换让界面正确显示
$("walletType").dispatchEvent(new Event("change"));
$("swapWalletType").dispatchEvent(new Event("change"));

/* ============ 🎁 批量空投 ============ */
let airdropJobId = null;
let airdropPollTimer = null;
let airTokenSymTimer = null;

$("airdropWalletType").addEventListener("change", () => {
  $("airdropWalletInput").placeholder = $("airdropWalletType").value === "mnemonic" ? "粘贴 12/24 个助记词单词…" : "粘贴私钥, 逗号分隔, 如: 0x…,0x…";
});
$("airdropToken").addEventListener("input", () => {
  clearTimeout(airTokenSymTimer);
  airTokenSymTimer = setTimeout(async () => {
    const addr = $("airdropToken").value.trim();
    const sp = $("airdropTokenSym");
    if (!ethers.isAddress(addr)) { sp.textContent = ""; return; }
    sp.textContent = "查询中…";
    try {
      const engine = new window.EngineLib.TransferEngine({ rpc: $("cfgRpc").value.trim() || undefined, chainId: Number($("cfgChainId").value) || 56, maxGasPrice: 10, feeMode: "legacy" });
      const info = await window.EngineLib.getTokenInfo(engine, addr);
      sp.textContent = info.symbol ? "币种: " + info.symbol : "";
    } catch (e2) { sp.textContent = ""; }
  }, 700);
});

function airReadAddrs() {
  const lines = $("airdropAddrs").value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  if (!lines.length) throw new Error("请先粘贴接收地址(每行一个)");
  const seen = new Set();
  const addrs = [];
  for (const l of lines) {
    if (!ethers.isAddress(l)) throw new Error("地址无效: " + l);
    const a = ethers.getAddress(l);
    if (!seen.has(a)) { seen.add(a); addrs.push(a); }
  }
  return addrs;
}

function airConfig() {
  const t = $("airdropWalletType").value;
  const cfg = {
    rpc: $("cfgRpc").value.trim() || undefined,
    chainId: Number($("cfgChainId").value) || 56,
    senders: 1,
    startIndex: 0,
    token: $("airdropToken").value.trim() || undefined,
    items: [],
  };
  if (t === "mnemonic") cfg.mnemonic = $("airdropWalletInput").value.trim();
  else cfg.privateKeys = $("airdropWalletInput").value.trim();
  if (!cfg.mnemonic && !cfg.privateKeys) throw new Error("请填写空投钱包(助记词/私钥)");
  const amount = Number($("airdropAmount").value);
  if (!(amount > 0)) throw new Error("每笔金额必须大于 0");
  const addrs = airReadAddrs();
  cfg.items = addrs.map((a, i) => ({ row: i + 1, to: a, amount: amount, remark: "", walletIndex: -1 }));
  return cfg;
}

$("airdropPreview").addEventListener("click", async () => {
  setErr("airdropErr", "");
  try {
    const cfg = airConfig();
    $("airdropPreview").disabled = true;
    $("airdropPreview").textContent = "检查中…";
    const data = await api("/api/preview", cfg);
    $("airdropPreviewBox").hidden = false;
    $("airdropCount").textContent = cfg.items.length;
    $("airdropWalletCards").innerHTML = data.wallets.map((w) => '<div class="wallet-card"><div class="addr">#' + w.index + " " + w.address + "</div></div>").join("");
    $("airdropBalanceErr").textContent = data.balanceOk ? "" : "⚠️ 存在余额不足或查询失败, 请充值后再空投。" + (data.balanceError ? "\n" + data.balanceError : "");
  } catch (e) { setErr("airdropErr", e.message); }
  finally { $("airdropPreview").disabled = false; $("airdropPreview").textContent = "🔍 干跑检查"; }
});

$("airdropSend").addEventListener("click", async () => {
  setErr("airdropErr", "");
  let cfg;
  try { cfg = airConfig(); } catch (e) { setErr("airdropErr", e.message); return; }
  const unit = cfg.token ? ($("airdropTokenSym").textContent.replace("币种: ", "").trim() || "代币") : "BNB";
  if (!confirm("即将向 " + cfg.items.length + " 个地址空投 " + cfg.items[0].amount + " " + unit + "\n\n请确认: 地址列表、金额、代币(如有)、发送钱包、链(chainId=" + cfg.chainId + ")正确。\n\n继续吗?")) return;
  try {
    $("airdropSend").disabled = true;
    const data = await api("/api/send", cfg);
    airdropJobId = data.jobId;
    $("airdropSendBox").hidden = false;
    $("airdropLogBox").textContent = "任务已创建, 等待执行…";
    $("airdropProgressText").textContent = "0%";
    $("airdropProgressBar").style.width = "0%";
    $("airdropResultTable").innerHTML = "";
    $("airdropDownload").hidden = true;
    airdropPollTimer = setInterval(pollAirdropJob, 1000);
  } catch (e) { setErr("airdropErr", e.message); $("airdropSend").disabled = false; }
});

async function pollAirdropJob() {
  if (!airdropJobId) return;
  try {
    const data = await (await fetch("/api/job/" + airdropJobId)).json();
    if (data.logs && data.logs.length) $("airdropLogBox").textContent = data.logs.join("\n");
    const pct = data.total ? Math.round((data.done / data.total) * 100) : 0;
    $("airdropProgressText").textContent = data.done + "/" + data.total + " (" + pct + "%)";
    $("airdropProgressBar").style.width = pct + "%";
    if (data.results && data.results.length) {
      $("airdropResultTable").innerHTML = "<thead><tr><th>接收地址</th><th>金额</th><th>状态</th><th>Tx Hash</th><th>错误</th></tr></thead><tbody>" + data.results.map((r) => "<tr><td class=\"mono\">" + esc(r.to) + "</td><td>" + esc(r.amount) + (r.symbol ? " " + esc(r.symbol) : "") + "</td><td class=\"" + (r.status === "ok" ? "status-ok\">成功" : "status-failed\">失败") + "</td><td class=\"mono\">" + (r.txHash ? esc(r.txHash.slice(0, 18)) + "…" : "") + "</td><td>" + esc(r.error) + "</td></tr>").join("") + "</tbody>";
      window._lastAirdropResults = data.results;
    }
    if (data.status === "done" || data.status === "failed") {
      clearInterval(airdropPollTimer);
      $("airdropSend").disabled = false;
      if (data.status === "failed") setErr("airdropErr", "空投失败: " + data.error);
      else {
        const okCount = data.results.filter((r) => r.status === "ok").length;
        setErr("airdropErr", okCount === data.results.length ? "✅ 空投完成: " + okCount + " 笔成功" : "⚠️ 空投完成: " + okCount + "/" + data.results.length + " 成功, 请核对失败项");
        $("airdropDownload").hidden = data.results.length === 0;
      }
    }
  } catch (e) {}
}

$("airdropDownload").addEventListener("click", () => {
  const rows = window._lastAirdropResults || [];
  const lines = ["to,amount,status,tx_hash,error"];
  for (const r of rows) lines.push(r.to + "," + r.amount + "," + r.status + "," + (r.txHash || "") + "," + csv(r.error));
  downloadCsv(lines.join("\n"), "airdrop-results.csv");
});

/* ============ 会员登录 ============ */
let licenseInfo = null;

function showLicenseGate(msg) {
  $("licenseGate").hidden = false;
  $("licenseBadge").hidden = true;
  if (msg) setErr("licenseErr", msg);
}

function fmtRemain(ms) {
  if (ms == null) return "永久";
  const days = Math.floor(ms / 86400000);
  const hours = Math.floor((ms % 86400000) / 3600000);
  return days > 0 ? `${days} 天 ${hours} 小时` : `${Math.max(1, Math.floor(ms / 3600000))} 小时`;
}

async function refreshLicense() {
  try {
    const data = await (await fetch("/api/license/status")).json();
    licenseInfo = data;
    if (data.valid && data.activated) {
      $("licenseGate").hidden = true;
      $("licenseBadge").hidden = false;
      const remain = fmtRemain(data.remainingMs);
      $("licenseBadge").innerHTML = `👑 ${esc(data.tierLabel)}${data.tier !== "life" ? " · 剩余 " + remain : " · 永久"} <span class="out">退出</span>`;
    } else {
      showLicenseGate(data.reason === "expired" ? "会员已过期, 请输入新的会员密钥" : "");
    }
  } catch { showLicenseGate("无法连接服务, 请确认已启动 APP"); }
}

$("btnLicenseActivate").addEventListener("click", async () => {
  setErr("licenseErr", "");
  const key = $("licenseKey").value.trim();
  if (!key) { setErr("licenseErr", "请填写会员密钥"); return; }
  try {
    await api("/api/license/activate", { key });
    $("licenseKey").value = "";
    await refreshLicense();
  } catch (e) { setErr("licenseErr", e.message); }
});
$("licenseKey").addEventListener("keydown", (e) => { if (e.key === "Enter") $("btnLicenseActivate").click(); });
$("licenseBadge").addEventListener("click", async (e) => {
  if (!e.target.classList.contains("out")) return;
  if (!confirm("退出登录? 之后需要会员密钥才能再次使用。")) return;
  try {
    await fetch("/api/license/deactivate", { method: "POST" });
    showLicenseGate("");
  } catch {}
});

// 启动时检查会员状态(未激活/过期 -> 显示登录遮罩)
refreshLicense();