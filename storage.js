// storage.js：上传文件的存储层，统一收口头像与简历附件的读写
// 本地开发默认写磁盘（uploads 目录）；在 Render 这类磁盘是临时的平台上，用 FILE_STORAGE=db 把文件存进 MySQL
const fs = require('fs'); // Node 内置文件系统模块，用于磁盘模式的读写
const path = require('path'); // 路径拼接工具，生成 uploads 目录的绝对路径
const { pool } = require('./db'); // 复用数据库连接池，用于数据库模式的文件读写

// uploadsDir：磁盘模式下文件的落盘目录，放在项目根目录的 uploads 下
const uploadsDir = path.join(__dirname, 'uploads');

// MODE：存储模式，disk=写本地磁盘（默认），db=写数据库表的 BLOB 字段
const MODE = (process.env.FILE_STORAGE || 'disk').toLowerCase();

// 磁盘模式下提前建好目录，避免首次上传时 ENOENT 报错
if (MODE === 'disk' && !fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

// putFile：写入一个文件，返回可对外访问的文件名（供 /uploads/:file 路由使用）
async function putFile(file, buffer) {
  // 数据库模式：把文件内容整体存进 files 表的 data 字段，实例重启也不会丢
  if (MODE === 'db') {
    await pool.query(
      'INSERT INTO files (name, mime, size, data) VALUES (?,?,?,?)', // 插入文件名、类型、大小与二进制内容
      [file, 'application/octet-stream', buffer.length, buffer] // 参数按占位符顺序绑定，避免拼接注入
    );
    return file; // 返回文件名作为主键
  }
  // 磁盘模式：直接写到 uploads 目录
  fs.writeFileSync(path.join(uploadsDir, file), buffer); // 同步写盘，保证返回时文件已经可用
  return file; // 返回文件名作为相对路径
}

// getFile：按文件名读取文件内容，返回 Buffer；不存在则返回 null
async function getFile(file) {
  // 数据库模式：从 files 表取出二进制内容
  if (MODE === 'db') {
    const [rows] = await pool.query('SELECT data FROM files WHERE name = ?', [file]); // 按文件名精确查询
    return rows[0] ? rows[0].data : null; // 命中则返回 Buffer，未命中返回 null
  }
  // 磁盘模式：文件存在就读出来返回
  const filePath = path.join(uploadsDir, file); // 拼出文件在磁盘上的绝对路径
  return fs.existsSync(filePath) ? fs.readFileSync(filePath) : null; // 存在则读盘，否则返回 null
}

// hasFile：判断文件是否存在，用于上传去重等场景
async function hasFile(file) {
  const buffer = await getFile(file); // 复用 getFile 的读取逻辑
  return !!buffer; // 转成布尔值返回
}

// 导出存储能力与当前模式，供 server.js 与启动日志使用
module.exports = { putFile, getFile, hasFile, uploadsDir, MODE };
