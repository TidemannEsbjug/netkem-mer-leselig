import {
  cleanLinkKey,
  createUpload,
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
    const linkKey = cleanLinkKey(body.linkKey);
    const upload = await createUpload({
      linkKey,
      fileName: body.fileName,
      fileSize: body.fileSize,
      fileType: body.fileType
    });

    return sendJson(res, 200, {
      ok: true,
      uploadId: upload.uploadId,
      objectKey: upload.objectKey,
      uploadUrl: upload.uploadUrl,
      fields: upload.fields,
      maxFileSize: upload.maxFileSize
    });
  } catch (error) {
    return sendError(res, error);
  }
}
