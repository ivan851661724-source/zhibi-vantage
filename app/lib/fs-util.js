'use strict';
// ============================================================
// 文件系统工具（评审 P0-8：原子写 + 备份 + 启动完整性校验）
// ------------------------------------------------------------
// 目标：进程在 writeFileSync 中途被中断（崩溃 / 断电 / SIGKILL）会留下半截
// JSON，导致下次启动 JSON.parse 失败、服务起不来或数据看似丢失。
// 本模块用 tmp+rename 原子写消除「半截文件」，用单代 .bak 提供「上一份好数据」
// 恢复点，并在启动时对关键 JSON 做一次完整性校验（损坏则尝试从 .bak 恢复）。
// 该模块不依赖 server.js / metrics.js，避免循环依赖。
// ============================================================
const fs = require('fs');
const path = require('path');

// 同步短暂让出 CPU：Windows 上 rename 目标被其它进程瞬时占用时，等占用方释放。
function sleepSync(ms) {
  try {
    const sab = new SharedArrayBuffer(4);
    const view = new Int32Array(sab);
    Atomics.wait(view, 0, 0, ms);
  } catch (e) {
    // 极少数环境禁用 SharedArrayBuffer 时降级为忙等（极短，写操作不频繁，可接受）
    const end = Date.now() + ms;
    while (Date.now() < end) { /* busy wait */ }
  }
}

// 原子写：先写同目录唯一名 .tmp，再 rename 覆盖目标。同一文件系统内 rename 是原子操作，
// 要么旧文件完整、要么新文件完整，不会出现半截。
//
// Windows 特例（根因）：目标文件可能被 IDE / 文件监视器 / 杀软实时扫描 / 云同步或备份代理
// 以「拒绝写共享 + 拒绝删共享」的方式瞬时或持续打开。此时 MoveFileEx(REPLACE_EXISTING)
// 会抛 EPERM/EACCES，且 copyFile 同样会失败（二者都要替换/删除文件对象）。
// 应对三层：
//   ① 唯一名 tmp（含 pid+时间戳）：避免与并发写或上次崩溃残留的 .tmp 撞名互相阻挡；
//   ② 直接截断写入退路：当占用方只禁「删/替」但允许「写」时，rename/copy 会失败、而
//      直接 writeFileSync(目标, 内容) 打开的是同一个文件对象去写，往往能成功；
//   ③ 指数退避重试（总窗口 ~2.5s）：等占用方（杀软扫描/同步）释放；仍失败则清理 .tmp
//      并抛出带可操作指引的错误，不在 data 目录留下半截 .tmp。
function atomicWrite(filePath, data) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = filePath + '.' + process.pid + '.' + Date.now() + '.tmp';
  const payload = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  fs.writeFileSync(tmp, payload);

  // 尝试把 tmp 落地为目标：rename 优先；失败时退化为直接截断写入现有文件对象。
  function tryReplace() {
    try {
      fs.renameSync(tmp, filePath);
      return true;
    } catch (e) {
      if (e && (e.code === 'EPERM' || e.code === 'EACCES')) {
        try {
          fs.writeFileSync(filePath, payload); // 仅需写共享，不需删/替共享
          try { fs.unlinkSync(tmp); } catch (_) {}
          return true;
        } catch (e2) { /* 仍被锁，交给外层退避重试 */ }
      }
      return false;
    }
  }

  if (tryReplace()) return filePath;

  // 持续锁（杀软/同步/编辑器）：极短同步退避（~0.3s）。长锁交给 bestEffortWrite 的
  // 后台异步重试兜底——同步久等会冻结事件循环（所有请求卡死），得不偿失。
  const backoff = [30, 90, 180];
  for (const ms of backoff) {
    sleepSync(ms);
    if (tryReplace()) return filePath;
  }

  // 仍失败：清理 .tmp，抛出带指引的错误（不静默丢数据）。
  try { fs.unlinkSync(tmp); } catch (_) {}
  const err = new Error(
    '文件写入被外部进程锁定（EPERM）：' + filePath +
    '\n可能原因：杀毒软件实时扫描 / 云同步或备份代理 / 编辑器正在打开该文件。' +
    '\n建议：① 直接重试（多数扫描为瞬时锁，退避后已可写）；② 将 data 目录加入杀软/同步的排除列表；' +
    '③ 关闭正在编辑此文件的程序后重试。'
  );
  err.code = 'EPERM';
  throw err;
}

// 单代备份：把当前文件复制为 .bak（覆盖上一份）。无源文件则跳过。
function backupFile(filePath) {
  try { if (fs.existsSync(filePath)) fs.copyFileSync(filePath, filePath + '.bak'); } catch (e) {}
  return filePath;
}

// 进程内写串行化：同一文件的多次写入按提交顺序串行执行，避免并发任务交错
// 写同一文件导致不可预期的顺序/覆盖（last-writer-wins 丢更新）。
// 注：这仅序列化「写」本身；read-modify-write 的竞态（两任务各读旧值再各写）
// 需在上层用临界区包裹，属于更深的多租户数据隔离改造（见整改路线图），此处先止血。
const writeLocks = new Map(); // filePath -> Promise（当前排队的写任务）
function withFileLock(filePath, task) {
  const prev = writeLocks.get(filePath) || Promise.resolve();
  let release;
  const next = new Promise(r => { release = r; });
  writeLocks.set(filePath, prev.then(() => task()).finally(() => {
    if (writeLocks.get(filePath) === next) writeLocks.delete(filePath);
    release();
  }));
  return next;
}

// 安全写：可选先备一份，再原子写。用于关键档案（current / projects / reports / config）。
// 经 withFileLock 串行化，保证同文件写入有序。返回 Promise（调用方无需 await）。
function safeWrite(filePath, data, backup) {
  return withFileLock(filePath, () => {
    if (backup) backupFile(filePath);
    return atomicWrite(filePath, data);
  });
}

// 读-改-写（RMW）临界区（P1-1.2）：在 withFileLock 串行化内执行 read -> mergeFn(cur) -> atomicWrite，
// 避免并发 RMW 交错（last-writer-wins 丢更新）。mergeFn(cur) 收到磁盘当前内容（无则 null），
// 返回新内容。与 safeWrite 共用同一 writeLocks 队列，故同文件的不同写操作严格有序。
function mutateFile(filePath, mergeFn, backup) {
  return withFileLock(filePath, () => {
    let cur = null;
    try { cur = JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { cur = null; }
    const next = mergeFn(cur);
    if (next === cur) return filePath; // 无需变更
    if (backup) backupFile(filePath);
    return atomicWrite(filePath, next);
  });
}

// 启动完整性校验：对每个存在的 JSON 文件尝试 parse；损坏则尝试从 .bak 恢复，
// 否则仅记录 ERROR（读方均对损坏做了防御：readArr→[]、loadState→null、getCurrentId→null，
// 损坏文件会在下一次合法写入时被原子写覆盖自愈，故不在此强制重置以免用错默认值销毁数据）。
// 返回 { checked, restored:[], corrupt:[文件名] } 供启动日志打印。
function verifyStartupIntegrity(files) {
  const out = { checked: 0, restored: [], corrupt: [] };
  for (const f of files) {
    if (!fs.existsSync(f)) continue;
    let txt = null;
    try { txt = fs.readFileSync(f, 'utf8'); } catch (e) { continue; }
    if (txt.trim() === '') { out.corrupt.push(f); continue; }
    let ok = false;
    try { JSON.parse(txt); ok = true; } catch (e) {}
    if (ok) { out.checked++; continue; }
    // 损坏：尝试 .bak 恢复
    out.corrupt.push(f);
    const bak = f + '.bak';
    if (fs.existsSync(bak)) {
      try {
        const bt = fs.readFileSync(bak, 'utf8');
        JSON.parse(bt); // 校验 bak 本身合法
        fs.copyFileSync(bak, f);
        out.restored.push(f);
        console.error('[integrity] 已从 .bak 恢复损坏文件: ' + f);
        continue;
      } catch (e) { /* bak 也坏，落到下方记录 */ }
    }
    console.error('[integrity] 文件损坏且无可用备份（下次合法写入将自愈）: ' + f);
  }
  return out;
}

// 尽力写（非致命）：同步快速尝试一次（含 ~0.3s 退避），失败不抛，转后台指数重试。
// 用于「当前指针 / 项目档案」等高频写——外部环境（宿主文件监视器 / 杀软实时扫描 /
// 云同步代理）偶尔瞬时占锁时，用户请求不应 500，数据应在锁释放后自动落盘。
// 非阻塞 fire-and-forget：本函数立即返回 false，返回值不代表写入成功（持久化由后台重试兜底）。
// 调用方不应依返回值判成败——要确认落盘看文件本身，而非返回值。
// opts.writeFn 仅测试注入；opts.delays 控制后台重试节奏（默认 ~67s 总兜底）；opts.logger 注入日志。
function bestEffortWrite(filePath, data, backup, opts) {
  const writeFn = (opts && opts.writeFn) || safeWrite; // 已是串行写
  const logger = (opts && opts.logger) || console.warn;
  const delays = (opts && opts.delays) || [400, 1200, 3000, 7000, 15000, 30000];
  const attempt = async () => { try { await writeFn(filePath, data, backup); return null; } catch (e) { return e; } };
  attempt().then(first => {
    if (!first) return; // 同步即成功
    logger('[bestEffortWrite] 同步写被外部锁（' + (first && first.code) + '），转后台重试: ' + filePath);
    let i = 0;
    const tick = () => {
      attempt().then(e => {
        if (!e) return; // 锁已释放，落盘成功
        if (i < delays.length) { setTimeout(tick, delays[i]); i++; }
        else logger('[bestEffortWrite] 后台重试耗尽，暂未持久化（下次写操作会再试）: ' + filePath);
      });
    };
    setTimeout(tick, delays[0]); i = 1;
  });
  return false;
}

module.exports = { atomicWrite, backupFile, safeWrite, mutateFile, withFileLock, verifyStartupIntegrity, bestEffortWrite };
