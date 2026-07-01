// scripts/send-login-alert.js — 通过 Resend 发送异地登录提醒邮件。
// 用法：RESEND_API_KEY=re_xxx node send-login-alert.js [to] [alertId] [baseUrl]

const crypto = require('crypto');

function genAlertId() {
  return 'LA-' + crypto.randomBytes(4).toString('hex').toUpperCase();
}

const API_KEY = process.env.RESEND_API_KEY;
if (!API_KEY) { console.error('ERROR: 请设置 RESEND_API_KEY 环境变量'); process.exit(1); }

const to = process.argv[2] || 'hhonins@gmail.com';
const alertId = process.argv[3] || genAlertId();
const baseUrl = process.argv[4] || 'https://complaintceseflow.org';

const link = `${baseUrl}/alert?id=${encodeURIComponent(alertId)}`;

const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="UTF-8"></head>
<body style="margin:0; padding:0; background:#f5f6f8;">
<div style="font-family: system-ui, -apple-system, 'PingFang SC', 'Microsoft YaHei', sans-serif; max-width:600px; margin:0 auto; padding:32px 24px; color:#1f2330;">
  <div style="background:#fff; border-radius:12px; padding:32px; box-shadow:0 4px 16px rgba(0,0,0,.06);">
    <h2 style="margin:0 0 16px; color:#e65100; font-size:20px;">异地登录安全提醒</h2>
    <p style="margin:0 0 12px;">尊敬的用户：</p>
    <p style="margin:0 0 16px; line-height:1.7;">我们检测到您的账户存在异地登录行为。如果这是您本人的操作，请点击下方按钮确认；如果不是，请立即点击非本人按钮以保护您的账户安全：</p>
    <table cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:20px 0;">
      <tr>
        <td align="center" style="padding:0 6px 0 0;">
          <a href="${link}&action=self" style="display:inline-block; padding:11px 28px; background:#2a7df0; color:#fff; text-decoration:none; border-radius:6px; font-weight:600; font-size:14px; white-space:nowrap;">是我本人操作</a>
        </td>
        <td align="center" style="padding:0 0 0 6px;">
          <a href="${link}&action=report" style="display:inline-block; padding:11px 28px; background:#e0413e; color:#fff; text-decoration:none; border-radius:6px; font-weight:600; font-size:14px; white-space:nowrap;">非本人，立即处理</a>
        </td>
      </tr>
    </table>
  </div>
  <p style="color:#a0a6b2; font-size:12px; margin:16px auto 0; text-align:center;">本邮件由系统自动发送，请勿直接回复。预警编号：${alertId}</p>
</div>
</body>
</html>`;

(async () => {
  console.log(`→ Sending login alert to ${to} (alert ${alertId}) via Resend...`);
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
