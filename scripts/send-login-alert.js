// scripts/send-login-alert.js — 通过 Resend 发送异地登录提醒邮件。
// 用法：RESEND_API_KEY=re_xxx node send-login-alert.js [to] [alertId] [baseUrl] [loginLocation] [loginIp] [loginDevice]

const crypto = require('crypto');

function genAlertId() {
  return 'LA-' + crypto.randomBytes(4).toString('hex').toUpperCase();
}

const API_KEY = process.env.RESEND_API_KEY;
if (!API_KEY) { console.error('ERROR: 请设置 RESEND_API_KEY 环境变量'); process.exit(1); }

const to = process.argv[2] || 'hhonins@gmail.com';
const alertId = process.argv[3] || genAlertId();
const baseUrl = process.argv[4] || 'https://complaintceseflow.org';
const loginLocation = process.argv[5] || '广东省广州市';
const loginIp = process.argv[6] || '123.456.789.012';
const loginDevice = process.argv[7] || 'Windows 10 / Chrome 120';
const loginTime = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });

const link = `${baseUrl}/alert?id=${encodeURIComponent(alertId)}`;

const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="UTF-8"></head>
<body style="margin:0; padding:0; background:#f5f6f8;">
<div style="font-family: system-ui, -apple-system, 'PingFang SC', 'Microsoft YaHei', sans-serif; max-width:600px; margin:0 auto; padding:32px 24px; color:#1f2330;">
  <div style="background:#fff; border-radius:12px; padding:32px; box-shadow:0 4px 16px rgba(0,0,0,.06);">
    <div style="display:flex; align-items:center; gap:12px; margin-bottom:20px;">
      <div style="width:48px; height:48px; background:#fff3e0; border-radius:50%; display:flex; align-items:center; justify-content:center;">
        <span style="font-size:24px;">&#9888;</span>
      </div>
      <h2 style="margin:0; color:#e65100; font-size:20px;">异地登录安全提醒</h2>
    </div>
    <p style="margin:0 0 12px;">尊敬的用户：</p>
    <p style="margin:0 0 16px; line-height:1.7;">我们检测到您的账户在以下非常用地点登录：</p>
    <div style="background:#fff3e0; border:1px solid #ffe0b2; border-radius:8px; padding:14px 18px; margin:16px 0;">
      <p style="margin:4px 0;"><strong>登录时间：</strong>${loginTime}</p>
      <p style="margin:4px 0;"><strong>登录地点：</strong>${loginLocation}</p>
      <p style="margin:4px 0;"><strong>IP 地址：</strong>${loginIp}</p>
      <p style="margin:4px 0;"><strong>登录设备：</strong>${loginDevice}</p>
    </div>
    <p style="margin:16px 0; line-height:1.7;">如果这是您本人的操作，请点击下方按钮确认。如果不是，请立即点击按钮报告以保护您的账户安全：</p>
    <p style="text-align:center; margin:24px 0;">
      <a href="${link}&action=self" style="display:inline-block; padding:12px 28px; background:#2a7df0; color:#fff; text-decoration:none; border-radius:8px; font-weight:600; margin-right:12px;">是我本人操作</a>
      <a href="${link}&action=report" style="display:inline-block; padding:12px 28px; background:#e0413e; color:#fff; text-decoration:none; border-radius:8px; font-weight:600;">非本人，立即处理</a>
    </p>
    <p style="color:#e65100; font-weight:600; margin:16px 0 8px;">如果非本人操作，我们建议您：</p>
    <ul style="margin:8px 0; padding-left:20px; line-height:1.7;">
      <li>立即修改密码</li>
      <li>启用两步验证</li>
      <li>检查账户活动记录</li>
    </ul>
  </div>
  <p style="color:#a0a6b2; font-size:12px; margin:16px auto 0; text-align:center;">本邮件由系统自动发送，请勿直接回复。预警编号：${alertId}</p>
</div>
</body>
</html>`;

(async () => {
  console.log(`→ Sending login alert to ${to} (alert ${alertId}) via Resend...`);
  console.log(`  Login info: ${loginLocation} | ${loginIp} | ${loginDevice}`);
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: 'noreply@complaintceseflow.org',
      to,
      subject: `安全提醒 — 检测到异地登录 — 预警编号 ${alertId}`,
      html,
    }),
  });
  const text = await res.text();
  console.log('Status:', res.status, res.statusText);
  console.log('Body:', text);
  // Force exit to avoid Windows libuv cleanup crash
  process.exitCode = res.ok ? 0 : 1;
  setTimeout(() => process.exit(process.exitCode), 100).unref();
})();
