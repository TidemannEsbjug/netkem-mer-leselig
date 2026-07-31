import {
  cleanLinkKey,
  getLinkState,
  getPublicConfig,
  sendError,
  sendJson,
  setCors
} from '../lib/document-intake.js';

export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method_not_allowed' });

  try {
    const linkKey = cleanLinkKey(req.query.link);
    const link = await getLinkState(linkKey);
    return sendJson(res, 200, {
      ok: true,
      linkKey,
      enabled: link.enabled,
      label: link.label,
      ...getPublicConfig()
    });
  } catch (error) {
    return sendError(res, error);
  }
}
