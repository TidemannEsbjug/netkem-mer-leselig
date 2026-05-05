/**
 * Vercel serverless function — handles contact form submissions.
 * Sends email via Resend.
 *
 * ENV VARS (set in Vercel dashboard → Project Settings → Environment Variables):
 *   RESEND_API_KEY   — your Resend API key (re_xxxxx)
 *   CONTACT_TO       — recipient (default: post@netkem.no)
 *   CONTACT_FROM     — sender (must be on a verified Resend domain, e.g. noreply@netkem.no)
 */

export default async function handler(req, res) {
  // CORS for safety (same-origin only)
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  // Vercel auto-parses JSON bodies when Content-Type is application/json
  const body = req.body || {};
  const { navn, firma, telefon, epost, emne, melding, _gotcha, _lang } = body;

  // Honeypot — spam bots fill hidden fields; real users don't
  if (_gotcha) {
    // Pretend success so bots don't retry
    return res.status(200).json({ ok: true });
  }

  // Validation
  if (!navn || !telefon || !epost) {
    return res.status(400).json({ error: 'missing_fields' });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(epost)) {
    return res.status(400).json({ error: 'invalid_email' });
  }
  if (String(navn).length > 200 || String(melding || '').length > 5000) {
    return res.status(400).json({ error: 'too_long' });
  }

  const apiKey = process.env.RESEND_API_KEY;
  const to     = process.env.CONTACT_TO   || 'post@netkem.no';
  const from   = process.env.CONTACT_FROM || 'noreply@netkem.no';

  if (!apiKey) {
    console.error('Missing RESEND_API_KEY env var');
    return res.status(500).json({ error: 'server_misconfigured' });
  }

  const langTag = _lang === 'en' ? 'EN' : _lang === 'es' ? 'ES' : 'NO';
  const subject = emne
    ? `[Netkem.no · ${langTag}] ${emne}`
    : `[Netkem.no · ${langTag}] Henvendelse fra ${navn}`;

  const html = `
    <div style="font-family: 'IBM Plex Sans', Helvetica, Arial, sans-serif; max-width: 600px; padding: 24px; background: #f5f7fa; border-radius: 4px;">
      <h2 style="color: #0a2540; margin: 0 0 24px;">Ny henvendelse fra netkem.no (${langTag})</h2>
      <table style="border-collapse: collapse; width: 100%;">
        <tr><td style="padding: 8px 12px; border-bottom: 1px solid #cfd8e1; color: #51606e; width: 120px;"><strong>Navn</strong></td><td style="padding: 8px 12px; border-bottom: 1px solid #cfd8e1; color: #0e1822;">${esc(navn)}</td></tr>
        ${firma   ? `<tr><td style="padding: 8px 12px; border-bottom: 1px solid #cfd8e1; color: #51606e;"><strong>Firma</strong></td><td style="padding: 8px 12px; border-bottom: 1px solid #cfd8e1; color: #0e1822;">${esc(firma)}</td></tr>` : ''}
        <tr><td style="padding: 8px 12px; border-bottom: 1px solid #cfd8e1; color: #51606e;"><strong>Telefon</strong></td><td style="padding: 8px 12px; border-bottom: 1px solid #cfd8e1; color: #0e1822;"><a href="tel:${esc(telefon)}" style="color: #1c7037;">${esc(telefon)}</a></td></tr>
        <tr><td style="padding: 8px 12px; border-bottom: 1px solid #cfd8e1; color: #51606e;"><strong>E-post</strong></td><td style="padding: 8px 12px; border-bottom: 1px solid #cfd8e1; color: #0e1822;"><a href="mailto:${esc(epost)}" style="color: #1c7037;">${esc(epost)}</a></td></tr>
        ${emne    ? `<tr><td style="padding: 8px 12px; border-bottom: 1px solid #cfd8e1; color: #51606e;"><strong>Emne</strong></td><td style="padding: 8px 12px; border-bottom: 1px solid #cfd8e1; color: #0e1822;">${esc(emne)}</td></tr>` : ''}
      </table>
      ${melding ? `<div style="margin-top: 24px; padding: 16px; background: #fff; border-left: 4px solid #1c7037; border-radius: 0 4px 4px 0;"><p style="margin: 0 0 8px; color: #51606e; font-size: 12px; text-transform: uppercase; letter-spacing: 0.1em;"><strong>Melding</strong></p><p style="margin: 0; color: #0e1822; white-space: pre-wrap;">${esc(melding)}</p></div>` : ''}
      <p style="margin: 32px 0 0; color: #7b8896; font-size: 12px;">Sendt fra netkem.no kontaktskjema · Bruk «Svar»-knappen for å svare direkte til avsender.</p>
    </div>
  `;

  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: `Netkem.no <${from}>`,
        to: [to],
        reply_to: epost,
        subject,
        html,
      }),
    });

    if (!r.ok) {
      const errText = await r.text();
      console.error('Resend error:', r.status, errText);
      return res.status(502).json({ error: 'send_failed' });
    }

    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error('Contact handler exception:', e);
    return res.status(500).json({ error: 'internal_error' });
  }
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
