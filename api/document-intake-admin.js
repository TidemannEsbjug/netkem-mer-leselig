import {
  cleanLinkKey,
  getLinkState,
  readJson,
  sendError,
  sendJson,
  setCors,
  upsertLinkState,
  verifyAdmin
} from '../lib/document-intake.js';

export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === 'OPTIONS') return res.status(204).end();

  if (!verifyAdmin(req)) {
    return sendJson(res, 401, { ok: false, error: 'unauthorized' });
  }

  try {
    if (req.method === 'GET') {
      const linkKey = cleanLinkKey(req.query.link);
      const link = await getLinkState(linkKey);
      return sendJson(res, 200, { ok: true, link });
    }

    if (req.method !== 'POST') {
      return sendJson(res, 405, { ok: false, error: 'method_not_allowed' });
    }

    const body = await readJson(req);
    const linkKey = cleanLinkKey(body.linkKey);
    const link = await upsertLinkState({
      linkKey,
      enabled: body.enabled,
      label: body.label,
      notifyTo: body.notifyTo
    });

    return sendJson(res, 200, { ok: true, link });
  } catch (error) {
    return sendError(res, error);
  }
}
