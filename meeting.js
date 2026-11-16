// 线上面试邀约集成点：腾讯会议 / 钉钉 / 飞书 / 企业微信
// 当前为可插拔桩实现：生成本地模拟链接。
// 接入真实能力时，在 createMeeting 中按 provider 调用对应开放平台 API，
// 并配置 API 密钥（通过环境变量传入，勿写入代码库）。

const crypto = require('crypto');

const PROVIDERS = ['tencent', 'dingtalk', 'feishu', 'wecom'];

function providerName(p) {
  return { tencent: '腾讯会议', dingtalk: '钉钉', feishu: '飞书', wecom: '企业微信' }[p] || p;
}

function createMeeting({ provider = 'tencent', topic = '面试邀约', userId }) {
  if (!PROVIDERS.includes(provider)) {
    const err = new Error('不支持的会议平台：' + provider);
    err.status = 400;
    throw err;
  }
  const roomId = crypto.randomBytes(4).toString('hex').toUpperCase();
  const joinCode = crypto.randomBytes(3).toString('hex').toUpperCase();
  return {
    provider,
    providerName: providerName(provider),
    topic,
    userId,
    meetingId: 'M' + Date.now().toString(36) + roomId,
    roomId,
    joinCode,
    url: `https://meeting.example/${provider}/${roomId}?code=${joinCode}`,
    // 真实接入时替换为对应平台返回的入会地址，例如：
    // tencent:  https://meeting.tencent.com/...
    // dingtalk: https://meeting.dingtalk.com/...
    // feishu:   https://meetings.feishu.cn/...
    // wecom:    https://meeting.wecom.com/...
  };
}

module.exports = { createMeeting, PROVIDERS };
