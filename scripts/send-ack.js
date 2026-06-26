// scripts/send-ack.js — 通过 Resend 发送投诉受理确认邮件。
// 用法：RESEND_API_KEY=re_xxx node send-ack.js [to] [caseId] [baseUrl]

const crypto = require('crypto');

function genCaseId() {
  return 'TS-' + crypto.randomBytes(4).toString('hex').toUpperCase();
}

const API_KEY = process.env.RESEND_API_KEY;
if (!API_KEY) { console.error('ERROR: 请设置 RESEND_API_KEY 环境变量'); process.exit(1); }

const to = process.argv[2] || 'hhonins@gmail.com';
const caseId = process.argv[3] || genCaseId();
const baseUrl = process.argv[4] || 'https://complaintceseflow.org';
const t = Date.now();
const link = `${baseUrl}/submit?id=${encodeURIComponent(caseId)}&t=${t}`;

const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="UTF-8"></head>
<body style="margin:0; padding:0; background:#f5f6f8;">
<div style="font-family: system-ui, -apple-system, 'PingFang SC', 'Microsoft YaHei', sans-serif; max-width:600px; margin:0 auto; padding:32px 24px; color:#1f2330;">
  <div style="background:#fff; border-radius:12px; padding:32px; box-shadow:0 4px 16px rgba(0,0,0,.06);">
    <h2 style="margin:0 0 16px; color:#2a7df0; font-size:20px;">您的投诉已受理</h2>
    <p style="margin:0 0 12px;">尊敬的用户：</p>
    <p style="margin:0 0 16px; line-height:1.7;">您好！我们已收到您提交的投诉，现确认受理。</p>
    <div style="background:#f7f8fa; border:1px solid #eceef2; border-radius:8px; padding:14px 18px; margin:16px 0;">
      <p style="margin:4px 0;"><strong>案件编号：</strong>${caseId}</p>
    </div>
    <p style="margin:16px 0; line-height:1.7;">为加快处理进度，请点击下方按钮补充信息及投诉详情：</p>
    <p style="text-align:center; margin:24px 0;">
      <a href="${link}" style="display:inline-block; padding:12px 28px; background:#2a7df0; color:#fff; text-decoration:none; border-radius:8px; font-weight:600;">补充投诉信息</a>
    </p>
    <p style="margin:16px 0; line-height:1.7;">我们将在收到补充信息后 1–3 个工作日内通过邮件反馈处理结果。</p>
  </div>
  <p style="color:#a0a6b2; font-size:12px; margin:16px auto 0; text-align:center;">本邮件由系统自动发送，请勿直接回复。</p>
</div>
</body>
</html>`;

(async () => {
  console.log(`→ Sending to ${to} (case ${caseId}) via Resend...`);
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: 'noreply@complaintceseflow.org',
      to,
      subject: `您的投诉已受理 — 案件编号 ${caseId} — 请补充信息`,
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
