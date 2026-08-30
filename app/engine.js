/* engine.js — BNB 批量工具浏览器版核心
 * 依赖全局: ethers (vendor/ethers.umd.min.js), ExcelJS (vendor/exceljs.min.js)
 * 日志通过 window.__engineSink(text) 输出(webapi 注入)。
 */
(function () {
  "use strict";
  const __log = (msg) => { if (window.__engineSink) window.__engineSink(String(msg)); };

/* ============================ 工具 ============================ */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const GRAY = (s) => `\x1b[90m${s}\x1b[0m`;
const GREEN = (s) => `\x1b[32m${s}\x1b[0m`;
const RED = (s) => `\x1b[31m${s}\x1b[0m`;
const YELLOW = (s) => `\x1b[33m${s}\x1b[0m`;
const CYAN = (s) => `\x1b[36m${s}\x1b[0m`;

function log(info, msg) { __log(info + " " + msg); }

/** 简易 CSV 解析器: 支持引号包裹、转义引号、CRLF/BOM */
function parseCsv(text) {
  text = text.replace(/^\uFEFF/, "");
  const rows = [];
  let row = [], field = "", inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field); field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some((c) => c.trim() !== "")) rows.push(row);
      row = [];
    } else {
      field += ch;
    }
  }
  if (field !== "" || row.length) {
    row.push(field);
    if (row.some((c) => c.trim() !== "")) rows.push(row);
  }
  return rows;
}

/** 读取名单: 根据扩展名走 CSV 或 XLSX, 返回二维数组(字符串) */
async function parseList({ text, dataBase64, filename } = {}) {
  if (text != null) return parseCsv(String(text).replace(/^\uFEFF/, ""));
  if (dataBase64) {
    const bin = atob(dataBase64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const name = filename || "upload.csv";
    const ext = (name.split(".").pop() || "csv").toLowerCase();
    if (ext === "xlsx" || ext === "xls") {
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(bytes.buffer);
      const ws = wb.worksheets[0];
      if (!ws) throw new Error("XLSX 文件中没有工作表");
      const rows = [];
      ws.eachRow((row) => {
        const vals = (row.values || []).slice(1).map((v) => (v == null ? "" : String(v).trim()));
        if (vals.some((v) => v !== "")) rows.push(vals);
      });
      return rows;
    }
    return parseCsv(new TextDecoder("utf-8").decode(bytes));
  }
  throw new Error("缺少文件内容: 请提供 dataBase64 或 text");
}

const normalize = (s) => String(s ?? "").trim().toLowerCase().replace(/[\s_\-]+/g, "");

const ALIASES = {
  to: ["to", "address", "recipient", "receiver", "addr", "目标地址", "收款地址", "接收地址", "地址"],
  amount: ["amount", "value", "bnb", "数量", "金额", "转账金额", "转账数量"],
  remark: ["remark", "memo", "note", "备注", "留言"],
  walletIndex: ["walletindex", "senderindex", "fromindex", "sender", "wallet", "index", "钱包序号", "发送序号", "序号"],
};

function findHeaderCols(row) {
  const cols = {};
  for (let i = 0; i < row.length; i++) {
    const n = normalize(row[i]);
    for (const [key, aliases] of Object.entries(ALIASES)) {
      if (aliases.includes(n) && cols[key] === undefined) cols[key] = i;
    }
  }
  return cols;
}

/** 解析名单为结构化记录 */
function parseRows(rows) {
  if (!rows.length) throw new Error("名单为空");
  const header = findHeaderCols(rows[0]);
  const hasHeader = header.to !== undefined && header.amount !== undefined;
  const dataStart = hasHeader ? 1 : 0;
  const col = hasHeader
    ? header
    : { to: 0, amount: 1, remark: 2, walletIndex: -1 };

  const items = [];
  for (let r = dataStart; r < rows.length; r++) {
    const raw = rows[r];
    const get = (idx) => (idx >= 0 && idx < raw.length ? String(raw[idx]).trim() : "");
    const to = get(col.to);
    const amountStr = get(col.amount);
    const remark = col.remark !== undefined ? get(col.remark) : "";
    const wIdxStr = col.walletIndex !== undefined ? get(col.walletIndex) : "";

    if (!to && !amountStr) continue; // 空行
    if (!to) throw new Error(`第 ${r + 1} 行缺少收款地址`);
    if (!amountStr || isNaN(Number(amountStr.replace(/,/g, "")))) {
      throw new Error(`第 ${r + 1} 行金额无效: "${amountStr}"`);
    }
    const amount = Number(amountStr.replace(/,/g, "")); // 允许千分位
    if (!(amount > 0)) throw new Error(`第 ${r + 1} 行金额必须大于 0: "${amountStr}"`);
    const walletIndex = wIdxStr === "" ? -1 : Number(wIdxStr);
    if (wIdxStr !== "" && (!Number.isInteger(walletIndex) || walletIndex < 0)) {
      throw new Error(`第 ${r + 1} 行 wallet_index 无效: "${wIdxStr}"`);
    }
    items.push({ row: r + 1, to, amount, remark, walletIndex });
  }
  if (!items.length) throw new Error("名单中没有有效数据行");
  return { items, hasHeader };
}

/** 校验地址, 汇总重复收款人 */
function validateItems(items) {
  const seen = new Map();
  const dupes = [];
  for (const it of items) {
    if (!ethers.isAddress(it.to)) throw new Error(`第 ${it.row} 行地址无效: ${it.to}`);
    it.to = ethers.getAddress(it.to); // 统一 checksum 格式
    if (seen.has(it.to)) dupes.push(`${it.to} (第 ${seen.get(it.to)} 行和第 ${it.row} 行)`);
    seen.set(it.to, it.row);
  }
  if (dupes.length) __log(`${YELLOW("[警告]")} 存在重复收款地址: ${dupes.join("; ")} (确认是否故意)`);
  return items;
}

/* ============================ 钱包 ============================ */

async function loadSecrets(opts) {
  const mnemonic = opts.mnemonic || (opts.secretsJson ? opts.secretsJson.mnemonic : undefined);
  const privateKeys = opts.privateKeys
    ? String(opts.privateKeys).split(",").map((s) => s.trim()).filter(Boolean)
    : (opts.secretsJson ? (opts.secretsJson.privateKeys ?? opts.secretsJson.private_keys ?? opts.secretsJson.keys) : undefined);
  return { mnemonic, privateKeys };
}

function buildSenders(secrets, opts) {
  const count = Math.max(1, opts.senders);
  if (secrets.mnemonic && secrets.privateKeys?.length) {
    throw new Error("助记词和私钥不能同时提供, 请二选一");
  }
  let wallets = [];
  if (secrets.mnemonic) {
    ethers.Mnemonic.fromPhrase(secrets.mnemonic.trim()); // 校验助记词
    for (let i = 0; i < count; i++) {
      const idx = opts.startIndex + i;
      wallets.push(ethers.HDNodeWallet.fromPhrase(secrets.mnemonic.trim(), undefined, `${BIP44_PATH}${idx}`));
    }
  } else if (secrets.privateKeys?.length) {
    if (count > secrets.privateKeys.length) {
      throw new Error(`--senders=${count} 超过了私钥数量 ${secrets.privateKeys.length}`);
    }
    wallets = secrets.privateKeys.slice(0, count).map((k) => new ethers.Wallet(k.trim()));
  } else {
    throw new Error("未提供钱包来源: 请用 --mnemonic / --private-keys / --secrets, 或环境变量 MNEMONIC / PRIVATE_KEYS");
  }
  return wallets.map((w, i) => ({ index: opts.startIndex + i, wallet: w, address: w.address }));
}

/* ============================ 转账引擎 ============================ */

class TransferEngine {
  constructor(opts) {
    this.opts = opts;
    this.rpcList = String(opts.rpc || "").split(",").map((s) => s.trim()).filter(Boolean);
    if (!this.rpcList.length) this.rpcList = DEFAULT_RPC.split(",");
    this.providers = this.rpcList.map((url) => new ethers.JsonRpcProvider(url, opts.chainId, { staticNetwork: true }));
    this.rpcCursor = 0;
    this.nonces = new Map(); // key: `${rpcIdx}:${address}`
    this.hooks = opts.hooks || {}; // { onLog(text) } 供 APP 收集进度
  }

  pickProvider() {
    const idx = this.rpcCursor % this.providers.length;
    this.rpcCursor++;
    return { idx, provider: this.providers[idx] };
  }

  isRetriable(e) {
    return /timeout|rate\s*limit|too many|busy|unavailable|ETIMEDOUT|ECONNRESET|socket|server error|response would exceed|Unauthorized/i.test(
      e?.shortMessage || e?.message || String(e)
    );
  }

  /** 带多 RPC 故障转移的调用: fn 接收 provider, 失败自动换节点重试 */
  async call(fn, label) {
    let lastErr;
    for (let round = 0; round < 2; round++) {
      for (const provider of this.providers) {
        try {
          return await fn(provider);
        } catch (e) {
          lastErr = e;
          if (!this.isRetriable(e)) throw e;
          log(YELLOW("[重试]"), `${label} 失败: ${(e?.shortMessage || e?.message || String(e)).slice(0, 100)} (切换 RPC 节点)`);
        }
      }
    }
    throw lastErr;
  }

  async init() {
    const net = await this.call((p) => p.getNetwork(), "获取网络信息");
    log(CYAN("[网络]"), `${net.name} (chainId=${net.chainId}) @ ${this.rpcList.join(", ")}`);
    if (net.chainId !== BigInt(this.opts.chainId)) {
      throw new Error(`RPC 返回的 chainId (${net.chainId}) 与配置 (${this.opts.chainId}) 不一致`);
    }
  }

  /** 计算 gas 费用字段, attempt 为第几次重试 (0 起), 受 max-gas-price 上限保护 */
  async computeFeeFields(attempt = 0) {
    const { maxGasPrice, feeBumpPercent, feeMode } = this.opts;
    const cap = ethers.parseUnits(String(maxGasPrice), "gwei");
    const bumpBig = BigInt(Math.round((feeBumpPercent * attempt) / 100 * 100));
    const bump = (v) => v + (v * bumpBig) / 100n;

    // BSC 公共节点对 eth_feeHistory 支持差, 默认走 legacy gasPrice(单次调用, 稳定)
    const base = ethers.toBigInt(await this.call((p) => p.send("eth_gasPrice", []), "获取 gas 价"));
    if (feeMode === "eip1559") {
      let maxFee = bump(base * 2n);
      let prio = bump(ethers.toBigInt(await this.call((p) => p.send("eth_maxPriorityFeePerGas", []), "获取优先费")));
      if (maxFee > cap) maxFee = cap;
      if (prio > maxFee) prio = maxFee;
      if (prio === 0n) prio = 1n;
      return { maxFeePerGas: maxFee, maxPriorityFeePerGas: prio };
    }
    let gp = bump(base);
    if (gp > cap) gp = cap;
    return { gasPrice: gp };
  }

  async getFeePerTx() {
    const f = await this.computeFeeFields(0);
    return BigInt(this.opts.gasLimit) * (f.maxFeePerGas ?? f.gasPrice);
  }

  async nextNonce(provIdx, senderAddress, provider) {
    const key = `${provIdx}:${senderAddress}`;
    if (!this.nonces.has(key)) {
      this.nonces.set(key, await provider.getTransactionCount(senderAddress, "pending"));
    }
    const n = this.nonces.get(key);
    this.nonces.set(key, n + 1);
    return n;
  }

  async resetNonce(provIdx, senderAddress, provider) {
    this.nonces.set(`${provIdx}:${senderAddress}`, await provider.getTransactionCount(senderAddress, "pending"));
  }

  /** 发送前余额检查: 每个发送钱包的转出总额 + 手续费 <= 余额 */
  async checkBalances(items) {
    const assigned = new Map();
    for (const it of items) {
      const addr = it.sender.address; // run() 中已按 wallet_index / 轮询分配
      if (!assigned.has(addr)) assigned.set(addr, { count: 0, total: 0n });
      assigned.get(addr).count++;
      assigned.get(addr).total += ethers.parseEther(String(it.amount));
    }
    const feePerTx = await this.getFeePerTx();
    let ok = true;
    for (const [addr, a] of assigned) {
      const balance = await this.call((p) => p.getBalance(addr), `查询余额 (${addr.slice(0, 10)}...)`);
      const feeTotal = feePerTx * BigInt(a.count);
      const needed = a.total + feeTotal;
      __log(`  ${CYAN(addr)}`);
      __log(`    余额: ${ethers.formatEther(balance)} BNB   需转出: ${ethers.formatEther(a.total)} BNB + 手续费 ~${ethers.formatEther(feeTotal)} BNB`);
      if (balance < needed) {
        ok = false;
        __log(`    ${RED("[余额不足]")} 需要 ${ethers.formatEther(needed)} BNB, 实际 ${ethers.formatEther(balance)} BNB`);
      } else {
        __log(`    预计剩余: ${ethers.formatEther(balance - needed)} BNB`);
      }
    }
    return ok;
  }

  /** 单笔转账, 含重试 */
  async sendOne(sender, it, attempt, isDryRun) {
    const { gasLimit, confirmations, waitTimeoutMs } = this.opts;
    const { idx, provider } = this.pickProvider();
    const wallet = sender.wallet.connect(provider);
    const nonce = isDryRun ? 0 : await this.nextNonce(idx, sender.address, provider);
    const feeFields = await this.computeFeeFields(attempt);
    const value = ethers.parseEther(String(it.amount));

    if (isDryRun) {
      return { dryRun: true, nonce, feeFields, value };
    }

    try {
      const tx = await wallet.sendTransaction({
        to: it.to,
        value,
        nonce,
        gasLimit,
        ...feeFields,
      });
      let receipt = null;
      if (confirmations > 0) {
        try {
          receipt = await tx.wait(confirmations, waitTimeoutMs);
        } catch (e) {
          const err = new Error(`等待确认超时 (${waitTimeoutMs}ms), hash=${tx.hash}`);
          err.pendingHash = tx.hash;
          throw err;
        }
      }
      return { txHash: tx.hash, receipt, nonce, feeFields, value };
    } catch (e) {
      const msg = e?.shortMessage || e?.message || String(e);
      if (/nonce too low|NONCE_EXPIRED|already known/i.test(msg)) {
        log(YELLOW("[nonce]"), `${sender.address} nonce 冲突, 重新同步 nonce 后重试`);
        await this.resetNonce(idx, sender.address, provider);
      }
      throw e;
    }
  }

  /** 为每笔分配发送钱包 (wallet_index 指定或轮询) */
  assignSenders(senders, items) {
    let rr = 0;
    for (const it of items) {
      let sender;
      if (it.walletIndex >= 0) {
        sender = senders.find((s) => s.index === it.walletIndex);
        if (!sender) throw new Error(`第 ${it.row} 行 wallet_index=${it.walletIndex} 超出可用钱包范围 (${senders[0].index}~${senders[senders.length - 1].index})`);
      } else {
        sender = senders[rr % senders.length]; // 轮询
        rr++;
      }
      it.sender = sender;
    }
  }

  /** 逐笔发送主循环; onResult(result, done, total) 每笔完成后回调 (APP 进度用) */
  async runSends(items, onResult = null) {
    const opts = this.opts;
    const results = [];
    __log(`\n${CYAN("========== 开始发送 ==========")}`);
    this.hooks.onLog?.(`========== 开始发送 ==========`);
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      let ok = false, errMsg = "", txHash = "", blockNumber = "";
      for (let attempt = 0; attempt <= opts.maxRetries && !ok; attempt++) {
        try {
          const r = await this.sendOne(it.sender, it, attempt, false);
          txHash = r.txHash;
          if (r.receipt) {
            blockNumber = String(r.receipt.blockNumber ?? "");
            ok = true;
            log(GREEN("[成功]"), `#${String(it.row).padStart(4)} ${it.sender.address} -> ${it.to}  ${it.amount} BNB  hash=${txHash}`);
            this.hooks.onLog?.(`[成功] 第${it.row}行 从 ${it.sender.address} -> ${it.to}  ${it.amount} BNB  hash=${txHash}`);
          } else {
            ok = true; // confirmations=0
            log(GREEN("[已广播]"), `#${String(it.row).padStart(4)} hash=${txHash} (未等待确认)`);
            this.hooks.onLog?.(`[已广播] 第${it.row}行 hash=${txHash} (未等待确认)`);
          }
        } catch (e) {
          errMsg = e?.shortMessage || e?.message || String(e);
          if (/nonce too low|NONCE_EXPIRED|already known/i.test(errMsg)) {
            attempt--; // nonce 冲突不算失败次数
            await sleep(opts.retryDelayMs);
            continue;
          }
          if (attempt < opts.maxRetries) {
            log(YELLOW("[重试]"), `#${String(it.row).padStart(4)} 失败: ${errMsg.slice(0, 200)} (重试 ${attempt + 1}/${opts.maxRetries}, gas 上浮 ${opts.feeBumpPercent}%)`);
            this.hooks.onLog?.(`[重试] 第${it.row}行 失败: ${errMsg.slice(0, 200)} (重试 ${attempt + 1}/${opts.maxRetries})`);
            await sleep(opts.retryDelayMs);
          }
        }
      }
      if (!ok) {
        log(RED("[失败]"), `#${String(it.row).padStart(4)} ${it.to}  ${it.amount} BNB  ${errMsg.slice(0, 300)}`);
        this.hooks.onLog?.(`[失败] 第${it.row}行 ${it.to}  ${it.amount} BNB  ${errMsg.slice(0, 300)}`);
      }
      const result = {
        row: it.row, from: it.sender.address, to: it.to, amount: it.amount,
        remark: it.remark, status: ok ? "ok" : "failed", txHash, blockNumber,
        error: ok ? "" : errMsg,
      };
      results.push(result);
      onResult?.(result, i + 1, items.length);
    }
    const okCount = results.filter((r) => r.status === "ok").length;
    __log(`\n${CYAN("========== 完成 ==========")}`);
    __log(`成功 ${okCount}/${results.length} 笔`);
    this.hooks.onLog?.(`========== 完成 ========== 成功 ${okCount}/${results.length} 笔`);
    return results;
  }

  async run(senders, items) {
    const opts = this.opts;
    this.assignSenders(senders, items);

    // 发送前展示计划
    __log(`\n${CYAN("========== 转账计划 ==========")}`);
    const total = items.reduce((s, i) => s + i.amount, 0);
    __log(`共 ${items.length} 笔, 合计 ${total} BNB, 使用 ${senders.length} 个发送钱包`);
    const preview = items.slice(0, 20);
    for (const it of preview) {
      const from = it.sender.address.slice(0, 10) + "..." + it.sender.address.slice(-6);
      const to = it.to.slice(0, 10) + "..." + it.to.slice(-6);
      __log(`  #${String(it.row).padStart(4)}  ${GRAY(from)} -> ${to}  ${it.amount} BNB${it.walletIndex >= 0 ? ` (钱包#${it.walletIndex})` : ""}`);
    }
    if (items.length > preview.length) __log(`  ... 共 ${items.length} 笔`);

    // 余额检查
    __log(`\n${CYAN("---------- 余额检查 ----------")}`);
    const balanceOk = opts.skipBalanceCheck || await this.checkBalances(items);
    if (!balanceOk) {
      throw new Error("存在余额不足的发送钱包, 已中止。请充值或减少转账金额(仅查看计划可用 --skip-balance-check)。");
    }

    if (opts.dryRun) {
      __log(`\n${GREEN("[dry-run]")} 以上为模拟检查, 未广播任何交易。确认无误后加 ${CYAN("--send")} 执行。`);
      return [];
    }

    // 确认提示
    if (!opts.yes) {
      if (!ioStdin.isTTY) {
        throw new Error("非交互式环境(无终端输入)请显式加 --yes 确认发送, 避免误操作。");
      }
      const rl = readline.createInterface({ input: ioStdin, output: ioStdout });
      const ans = await rl.question(`\n确认广播 ${items.length} 笔转账? 输入 yes 继续: `);
      rl.close();
      if (ans.trim().toLowerCase() !== "yes") {
        __log("已取消, 未广播任何交易。");
        process.exit(0);
      }
    }

    return this.runSends(items);
  }
}


/* ============ 浏览器版附加: 合约配置 / 钱包 / 薄饼辅助 ============ */

const BIP44_PATH = "m/44'/60'/0'/0/";
const DEFAULT_RPC = "https://bsc-rpc.publicnode.com,https://bsc.meowrpc.com,https://bsc-dataseed.binance.org";
const DEFAULT_CHAIN_ID = 56;
const MAX_UINT = ethers.MaxUint256;

const WBNB = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c"; // BSC WBNB
const ROUTER_V2 = "0x10ED43C718714eb63d5aA57B78B54704E256024E"; // PancakeSwap V2 Router (主网)
const ROUTER_V2_TESTNET = "0xD99D1c33F9fC3444f8101754aBC46c52416550D1"; // 测试网

const ROUTER_ABI = [
  "function getAmountsOut(uint amountIn, address[] path) external view returns (uint[] memory amounts)",
  "function getAmountsIn(uint amountOut, address[] path) external view returns (uint[] memory amounts)",
  "function swapExactTokensForTokens(uint amountIn, uint amountOutMin, address[] path, address to, uint deadline) external returns (uint[] memory amounts)",
  "function swapExactETHForTokens(uint amountOutMin, address[] path, address to, uint deadline) external payable returns (uint[] memory amounts)",
  "function swapExactTokensForETH(uint amountIn, uint amountOutMin, address[] path, address to, uint deadline) external returns (uint[] memory amounts)",
  "function swapExactTokensForTokensSupportingFeeOnTransferTokens(uint amountIn, uint amountOutMin, address[] path, address to, uint deadline) external",
  "function swapExactETHForTokensSupportingFeeOnTransferTokens(uint amountOutMin, address[] path, address to, uint deadline) external payable",
  "function swapExactTokensForETHSupportingFeeOnTransferTokens(uint amountIn, uint amountOutMin, address[] path, address to, uint deadline) external",
];

const TOKEN_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
];

/** 派生 EVM 钱包 (BIP44 m/44'/60'/0'/0/{index}) */
function deriveWallets(mnemonic, startIndex, count) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const idx = startIndex + i;
    const w = ethers.HDNodeWallet.fromPhrase(mnemonic.trim(), undefined, BIP44_PATH + idx);
    out.push({ index: idx, address: w.address, privateKey: w.privateKey });
  }
  return out;
}

function getRouterAddress(body) {
  const custom = (body.router || "").trim();
  if (custom) {
    if (!ethers.isAddress(custom)) throw new Error("Router 合约地址无效: " + custom);
    return ethers.getAddress(custom);
  }
  const chainId = body.chainId ? Number(body.chainId) : 56;
  return chainId === 97 ? ROUTER_V2_TESTNET : ROUTER_V2;
}

/** 读取代币信息(decimals/symbol), 失败用默认值 */
async function getTokenInfo(engine, tokenAddr) {
  const iface = new ethers.Interface(TOKEN_ABI);
  const call = async (method, args) => {
    const data = iface.encodeFunctionData(method, args);
    const ret = await engine.call((p) => p.call({ to: tokenAddr, data }), method + "(" + tokenAddr.slice(0, 8) + "...)");
    return iface.decodeFunctionResult(method, ret)[0];
  };
  let decimals = 18, symbol = "TOKEN";
  try { decimals = Number(await call("decimals", [])); } catch (e) { }
  try { symbol = String(await call("symbol", [])).slice(0, 12); } catch (e) { }
  return { decimals, symbol };
}

/** 广播一笔合约交易(自动 nonce / gas 上限 / 重试), 返回 { txHash, receipt } */
async function broadcastTx(engine, sender, txReq, label) {
  const { idx, provider } = engine.pickProvider();
  const wallet = sender.wallet.connect(provider);
  const nonce = await engine.nextNonce(idx, sender.address, provider);
  let lastErr;
  for (let attempt = 0; attempt <= engine.opts.maxRetries; attempt++) {
    try {
      const feeFields = await engine.computeFeeFields(attempt);
      const tx = await wallet.sendTransaction(Object.assign({}, txReq, { nonce }, feeFields));
      let receipt = null;
      if (engine.opts.confirmations > 0) {
        try { receipt = await tx.wait(engine.opts.confirmations, engine.opts.waitTimeoutMs); }
        catch (e) { const err = new Error("等待确认超时, hash=" + tx.hash); err.pendingHash = tx.hash; throw err; }
      }
      return { txHash: tx.hash, receipt };
    } catch (e) {
      lastErr = e;
      const msg = e?.shortMessage || e?.message || String(e);
      if (/nonce too low|NONCE_EXPIRED|already known/i.test(msg)) {
        await engine.resetNonce(idx, sender.address, provider);
        attempt--;
        await sleep(engine.opts.retryDelayMs);
        continue;
      }
      if (attempt < engine.opts.maxRetries) {
        engine.hooks.onLog?.("[重试] " + label + " 失败: " + msg.slice(0, 150));
        await sleep(engine.opts.retryDelayMs);
      }
    }
  }
  throw lastErr;
}

window.EngineLib = {
  parseCsv, parseRows, validateItems, buildSenders, TransferEngine, parseList, loadSecrets,
  deriveWallets, getRouterAddress, getTokenInfo, broadcastTx,
  WBNB, ROUTER_V2, ROUTER_V2_TESTNET, ROUTER_ABI, TOKEN_ABI,
  MAX_UINT, BIP44_PATH, DEFAULT_RPC, DEFAULT_CHAIN_ID,
};
})();
