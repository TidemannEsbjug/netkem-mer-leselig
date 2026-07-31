import {
  completeUpload,
  readJson,
  sendError,
  sendJson,
  setCors
} from '../lib/document-intake.js';

export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method_not_allowed' });

  try {
    const body = await readJson(req);
    const result = await completeUpload(body);
    return sendJson(res, 200, {
      ok: true,
      uploadId: result.upload.uploadId,
      notificationSent: result.notificationSent
    });
  } catch (error) {
    return sendError(res, error);
  }
}
