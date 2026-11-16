// meeting.js：线上面试邀约集成点，支持腾讯会议 / 钉钉 / 飞书 / 企业微信
// 当前为可插拔桩实现：生成本地模拟链接。
// 接入真实能力时，在 createMeeting 中按 provider 调用对应开放平台 API，
// 并配置 API 密钥（通过环境变量传入，勿写入代码库）。

const crypto = require('crypto'); // 加密工具，用于生成会议编号

// 支持的会议平台标识
const PROVIDERS = ['tencent', 'dingtalk', 'feishu', 'wecom'];

// providerName：把平台标识转换为中文名称
function providerName(p) {
  return { tencent: '腾讯会议', dingtalk: '钉钉', feishu: '飞书', wecom: '企业微信' }[p] || p;
}

// createMeeting：创建一场面试会议，返回会议信息与入会链接
function createMeeting({ provider = 'tencent', topic = '面试邀约', userId }) {
  if (!PROVIDERS.includes(provider)) { // 校验平台标识合法性
    const err = new Error('不支持的会议平台：' + provider);
    err.status = 400;
    throw err; // 抛出参数错误
  }
  const roomId = crypto.randomBytes(4).toString('hex').toUpperCase(); // 生成会议房间号
  const joinCode = crypto.randomBytes(3).toString('hex').toUpperCase(); // 生成入会码
  return {
    provider, // 平台标识
    providerName: providerName(provider), // 平台中文名
    topic, // 会议主题
    userId, // 目标用户 ID
    meetingId: 'M' + Date.now().toString(36) + roomId, // 会议 ID
    roomId, // 房间号
    joinCode, // 入会码
    url: `https://meeting.example/${provider}/${roomId}?code=${joinCode}`, // 模拟入会链接
    // 真实接入时替换为对应平台返回的入会地址，例如：
    // tencent:  https://meeting.tencent.com/...
    // dingtalk: https://meeting.dingtalk.com/...
    // feishu:   https://meetings.feishu.cn/...
    // wecom:    https://meeting.wecom.com/...
  };
}

// 导出创建会议函数与支持的平台列表
module.exports = { createMeeting, PROVIDERS };
