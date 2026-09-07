'use strict';
// ============================================================
// core/paths.js —— 数据目录与关键路径（全后端唯一来源）
// ZB_DATA_DIR 环境变量可覆盖数据目录（隔离测试/多实例用）。
// ============================================================
const path = require('path');

const ROOT = __dirname;
const DATA = process.env.ZB_DATA_DIR ? path.resolve(process.env.ZB_DATA_DIR) : path.join(ROOT, '..', 'data');
const CONFIG_PATH = path.join(DATA, 'config.json');
const STATE_PATH = path.join(DATA, 'state.json'); // 旧版单档案（仅迁移用）
const PROJ_DIR = path.join(DATA, 'projects');      // 多调研档案目录
const CURRENT_PATH = path.join(DATA, 'current.json'); // 当前档案指针

module.exports = { ROOT, DATA, CONFIG_PATH, STATE_PATH, PROJ_DIR, CURRENT_PATH };
