import crypto from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';

export const DEFAULT_LINK_KEY = 'offisielle-dokumenter';
export const DEFAULT_LABEL = 'Offisielle dokumenter';

const DEFAULT_MAX_FILE_SIZE = 50 * 1024 * 1024;
const DEFAULT_ALLOWED_EXTENSIONS = ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'csv', 'png', 'jpg', 'jpeg', 'heic', 'zip'];
const LINK_KEY_RE = /^[a-zA-Z0-9_-]{1,80}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

let s3Client;
let dynamoDoc;

export function setCors(req, res) {
  const origin = process.env.DOCUMENT_INTAKE_ALLOWED_ORIGIN || req.headers.origin || '*';
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-admin-secret');
  res.setHeader('Access-Control-Max-Age', '86400');
  res.setHeader('Vary', 'Origin');
}

export function sendJson(res, status, body) {
  res.status(status).json(body);
}

export function sendError(res, error) {
  const status = error.status || 500;
  const code = error.code || 'internal_error';
  if (status >= 500) console.error(error);
  sendJson(res, status, { ok: false, error: code });
}

export function apiError(code, status = 400) {
  const error = new Error(code);
  error.code = code;
  error.status = status;
  return error;
}

export async function readJson(req) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === 'string') return req.body ? JSON.parse(req.body) : {};
  if (Buffer.isBuffer(req.body)) return JSON.parse(req.body.toString('utf8') || '{}');

  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

export function cleanLinkKey(value) {
  const linkKey = String(value || DEFAULT_LINK_KEY).trim();
  if (!LINK_KEY_RE.test(linkKey)) throw apiError('invalid_link', 400);
  return linkKey;
}

export function getPublicConfig() {
  return {
    maxFileSize: getMaxFileSize(),
    allowedExtensions: getAllowedExtensions()
  };
}

export async function getLinkState(linkKey) {
  const fallback = {
    linkKey,
    label: cleanText(process.env.DOCUMENT_INTAKE_LABEL, 120) || DEFAULT_LABEL,
    enabled: boolFrom(process.env.DOCUMENT_INTAKE_ENABLED || process.env.DOCUMENT_INTAKE_DEFAULT_ENABLED),
    notifyTo: cleanText(process.env.DOCUMENT_UPLOAD_NOTIFY_TO || process.env.CONTACT_TO, 220)
  };

  if (!hasDynamo()) return fallback;

  const result = await getDynamo().send(new GetCommand({
    TableName: process.env.DOCUMENT_INTAKE_TABLE,
    Key: linkKeyToKey(linkKey)
  }));

  if (!result.Item) return fallback;

  return {
    linkKey,
    label: cleanText(result.Item.label, 120) || fallback.label,
    enabled: boolFrom(result.Item.enabled),
    notifyTo: cleanText(result.Item.notifyTo, 220) || fallback.notifyTo,
    updatedAt: result.Item.updatedAt || null
  };
}

export async function upsertLinkState({ linkKey, enabled, label, notifyTo }) {
  if (!hasDynamo()) throw apiError('state_store_not_configured', 501);

  const previous = await getLinkState(linkKey);
  const now = new Date().toISOString();
  const item = {
    ...linkKeyToKey(linkKey),
    linkKey,
    enabled: boolFrom(enabled),
    label: cleanText(label, 120) || previous.label || DEFAULT_LABEL,
    notifyTo: cleanText(notifyTo, 220) || previous.notifyTo || null,
    updatedAt: now
  };

  await getDynamo().send(new PutCommand({
    TableName: process.env.DOCUMENT_INTAKE_TABLE,
    Item: item
  }));

  return item;
}

export function verifyAdmin(req) {
  const secret = process.env.DOCUMENT_INTAKE_ADMIN_SECRET;
  if (!secret) return false;

  const auth = req.headers.authorization || '';
  const bearer = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7) : '';
  const supplied = req.headers['x-admin-secret'] || bearer;
  if (!supplied) return false;

  const a = Buffer.from(String(secret));
  const b = Buffer.from(String(supplied));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export async function createUpload({ linkKey, fileName, fileSize, fileType }) {
  const linkState = await getLinkState(linkKey);
  if (!linkState.enabled) throw apiError('intake_closed', 403);

  const file = validateFileInput({ fileName, fileSize, fileType });
  const bucket = getBucket();
  const uploadId = crypto.randomUUID();
  const objectKey = buildObjectKey(linkKey, uploadId, file.fileName);
  const contentType = cleanContentType(file.fileType);

  const fields = {
    'Content-Type': contentType,
    'x-amz-server-side-encryption': 'AES256',
    'x-amz-meta-upload-id': uploadId,
    'x-amz-meta-link-key': linkKey
  };

  const post = await createPresignedPost(getS3(), {
    Bucket: bucket,
    Key: objectKey,
    Expires: getPostExpiresSeconds(),
    Fields: fields,
    Conditions: [
      ['content-length-range', 1, getMaxFileSize()],
      ['starts-with', '$key', linkPrefix(linkKey)],
      ['eq', '$Content-Type', contentType],
      ['eq', '$x-amz-server-side-encryption', 'AES256'],
      ['eq', '$x-amz-meta-upload-id', uploadId],
      ['eq', '$x-amz-meta-link-key', linkKey]
    ]
  });

  return {
    linkState,
    uploadId,
    objectKey,
    uploadUrl: post.url,
    fields: post.fields,
    maxFileSize: getMaxFileSize()
  };
}

export async function completeUpload(body) {
  const linkKey = cleanLinkKey(body.linkKey);
  const uploadId = cleanUploadId(body.uploadId);
  const objectKey = cleanObjectKey(linkKey, body.objectKey);
  const file = validateFileInput(body);
  const sender = cleanSender(body.sender || {});

  await ensureObjectExists(objectKey);

  const linkState = await getLinkState(linkKey);
  const upload = {
    uploadId,
    linkKey,
    objectKey,
    s3Uri: `s3://${getBucket()}/${objectKey}`,
    fileName: file.fileName,
    fileSize: file.fileSize,
    fileType: cleanContentType(file.fileType),
    sender,
    uploadedAt: new Date().toISOString()
  };

  await recordUpload(upload);
  const notification = await notifyUpload(linkState, upload);

  return {
    upload,
    notificationSent: notification.sent,
    notification
  };
}

export function getMaxFileSize() {
  const mb = Number(process.env.DOCUMENT_INTAKE_MAX_FILE_MB || 50);
  if (!Number.isFinite(mb) || mb < 1) return DEFAULT_MAX_FILE_SIZE;
  return Math.min(mb, 250) * 1024 * 1024;
}

export function getAllowedExtensions() {
  const fromEnv = String(process.env.DOCUMENT_INTAKE_ALLOWED_EXTENSIONS || '')
    .split(',')
    .map((ext) => ext.trim().toLowerCase().replace(/^\./, ''))
    .filter(Boolean);
  return fromEnv.length ? fromEnv : DEFAULT_ALLOWED_EXTENSIONS;
}

function validateFileInput({ fileName, fileSize, fileType }) {
  const name = cleanText(fileName, 180);
  const size = Number(fileSize);
  if (!name) throw apiError('missing_file_name', 400);
  if (!Number.isFinite(size) || size < 1) throw apiError('invalid_file_size', 400);
  if (size > getMaxFileSize()) throw apiError('file_too_large', 413);

  const extension = name.includes('.') ? name.split('.').pop().toLowerCase() : '';
  if (!getAllowedExtensions().includes(extension)) throw apiError('file_type_not_allowed', 400);

  return {
    fileName: name,
    fileSize: size,
    fileType: cleanContentType(fileType)
  };
}

function cleanSender(sender) {
  return {
    company: cleanText(sender.company, 160),
    name: cleanText(sender.name, 160),
    email: cleanText(sender.email, 220),
    reference: cleanText(sender.reference, 160)
  };
}

function cleanUploadId(value) {
  const uploadId = String(value || '').trim();
  if (!UUID_RE.test(uploadId)) throw apiError('invalid_upload_id', 400);
  return uploadId;
}

function cleanObjectKey(linkKey, value) {
  const objectKey = String(value || '').trim();
  if (!objectKey || objectKey.includes('..') || objectKey.startsWith('/')) throw apiError('invalid_object_key', 400);
  if (!objectKey.startsWith(linkPrefix(linkKey))) throw apiError('object_key_mismatch', 400);
  return objectKey;
}

function buildObjectKey(linkKey, uploadId, fileName) {
  const day = new Date().toISOString().slice(0, 10);
  return `${linkPrefix(linkKey)}${day}/${uploadId}-${safeFileName(fileName)}`;
}

function linkPrefix(linkKey) {
  const base = String(process.env.DOCUMENT_INTAKE_S3_PREFIX || 'document-intake')
    .replace(/^\/+|\/+$/g, '');
  return `${base ? `${base}/` : ''}${linkKey}/`;
}

function safeFileName(fileName) {
  return String(fileName)
    .trim()
    .replace(/æ/g, 'ae')
    .replace(/ø/g, 'o')
    .replace(/å/g, 'a')
    .replace(/Æ/g, 'Ae')
    .replace(/Ø/g, 'O')
    .replace(/Å/g, 'A')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120) || 'dokument';
}

function cleanContentType(value) {
  const contentType = cleanText(value, 120) || 'application/octet-stream';
  return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(contentType)
    ? contentType
    : 'application/octet-stream';
}

function cleanText(value, max = 500) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function boolFrom(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value === 1;
  return ['1', 'true', 'yes', 'on', 'open', 'enabled'].includes(String(value || '').trim().toLowerCase());
}

function hasDynamo() {
  return Boolean(process.env.DOCUMENT_INTAKE_TABLE);
}

function linkKeyToKey(linkKey) {
  return { pk: `LINK#${linkKey}`, sk: 'STATE' };
}

function uploadToKey(upload) {
  return {
    pk: `LINK#${upload.linkKey}`,
    sk: `UPLOAD#${upload.uploadedAt}#${upload.uploadId}`
  };
}

async function recordUpload(upload) {
  if (!hasDynamo()) return false;
  await getDynamo().send(new PutCommand({
    TableName: process.env.DOCUMENT_INTAKE_TABLE,
    Item: {
      ...uploadToKey(upload),
      ...upload
    }
  }));
  return true;
}

async function ensureObjectExists(objectKey) {
  await getS3().send(new HeadObjectCommand({
    Bucket: getBucket(),
    Key: objectKey
  })).catch(() => {
    throw apiError('upload_not_found', 404);
  });
}

async function notifyUpload(linkState, upload) {
  const results = {
    webhookSent: false,
    emailSent: false,
    sent: false
  };

  const webhookUrl = process.env.DOCUMENT_UPLOAD_WEBHOOK_URL;
  if (webhookUrl) {
    try {
      const response = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event: 'document_uploaded', link: linkState, upload })
      });
      results.webhookSent = response.ok;
    } catch (error) {
      console.error('Document upload webhook failed:', error);
    }
  }

  if (process.env.RESEND_API_KEY) {
    try {
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          from: `Netkem dokumentmottak <${process.env.CONTACT_FROM || 'noreply@netkem.no'}>`,
          to: [linkState.notifyTo || process.env.DOCUMENT_UPLOAD_NOTIFY_TO || process.env.CONTACT_TO || 'post@netkem.no'],
          reply_to: upload.sender.email || undefined,
          subject: `[Netkem dokumentmottak] ${upload.sender.company || upload.sender.name || 'Ny opplasting'} - ${upload.fileName}`,
          html: uploadEmailHtml(linkState, upload)
        })
      });
      results.emailSent = response.ok;
      if (!response.ok) console.error('Resend upload notification failed:', await response.text());
    } catch (error) {
      console.error('Resend upload notification exception:', error);
    }
  }

  results.sent = results.webhookSent || results.emailSent;
  return results;
}

function uploadEmailHtml(linkState, upload) {
  return `
    <div style="font-family: IBM Plex Sans, Helvetica, Arial, sans-serif; max-width: 640px; padding: 24px; background: #f5f7fa; color: #0e1822;">
      <h2 style="margin: 0 0 18px; color: #0a2540;">Ny dokumentopplasting</h2>
      <p style="margin: 0 0 18px;">En fil er lastet opp via dokumentmottaket <strong>${esc(linkState.label)}</strong>.</p>
      <table style="width: 100%; border-collapse: collapse; background: #fff;">
        ${row('Firma', upload.sender.company)}
        ${row('Kontaktperson', upload.sender.name)}
        ${row('E-post', upload.sender.email)}
        ${row('Referanse', upload.sender.reference)}
        ${row('Filnavn', upload.fileName)}
        ${row('Størrelse', formatBytes(upload.fileSize))}
        ${row('S3', upload.s3Uri)}
        ${row('Tidspunkt', upload.uploadedAt)}
      </table>
    </div>
  `;
}

function row(label, value) {
  if (!value) return '';
  return `<tr><td style="width: 150px; padding: 10px 12px; border-bottom: 1px solid #cfd8e1; color: #51606e;"><strong>${esc(label)}</strong></td><td style="padding: 10px 12px; border-bottom: 1px solid #cfd8e1;">${esc(value)}</td></tr>`;
}

function esc(value) {
  return String(value || '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[char]));
}

function formatBytes(bytes) {
  const units = ['B', 'KB', 'MB', 'GB'];
  let size = Number(bytes || 0);
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? size : size.toFixed(size >= 10 ? 0 : 1)} ${units[unit]}`;
}

function getS3() {
  if (!s3Client) s3Client = new S3Client({ region: getRegion() });
  return s3Client;
}

function getDynamo() {
  if (!dynamoDoc) {
    dynamoDoc = DynamoDBDocumentClient.from(new DynamoDBClient({ region: getRegion() }));
  }
  return dynamoDoc;
}

function getRegion() {
  return process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'eu-north-1';
}

function getBucket() {
  const bucket = process.env.DOCUMENT_INTAKE_BUCKET;
  if (!bucket) throw apiError('server_misconfigured', 500);
  return bucket;
}

function getPostExpiresSeconds() {
  const seconds = Number(process.env.DOCUMENT_INTAKE_POST_EXPIRES_SECONDS || 600);
  return Number.isFinite(seconds) && seconds > 30 ? Math.min(seconds, 3600) : 600;
}
