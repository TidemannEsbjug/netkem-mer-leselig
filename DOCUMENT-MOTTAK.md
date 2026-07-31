# Netkem dokumentmottak

Skjult kundelenke:

```text
https://netkem.no/dokumentmottak.html?link=offisielle-dokumenter
```

Modellen er en fast lenke som styres av en 1/0-bryter. Kunden logger ikke inn. Når mottaket er åpent, ber nettleseren API-et om en kort S3-opplastingspolicy for hver fil. Etter at filen faktisk finnes i S3, lagres metadata og Netkem varsles.

## Miljøvariabler

Sett disse i Vercel-prosjektet der `modernized/` er deploy-root:

```bash
AWS_REGION=eu-north-1
DOCUMENT_INTAKE_BUCKET=netkem-dokumentmottak
DOCUMENT_INTAKE_TABLE=NetkemDocumentIntake
DOCUMENT_INTAKE_ADMIN_SECRET=<lang tilfeldig hemmelighet>
DOCUMENT_UPLOAD_NOTIFY_TO=post@netkem.no
CONTACT_FROM=noreply@netkem.no
RESEND_API_KEY=re_...
```

Valgfrie:

```bash
DOCUMENT_INTAKE_LABEL=Offisielle dokumenter
DOCUMENT_INTAKE_DEFAULT_ENABLED=0
DOCUMENT_INTAKE_MAX_FILE_MB=50
DOCUMENT_INTAKE_S3_PREFIX=document-intake
DOCUMENT_UPLOAD_WEBHOOK_URL=https://...
DOCUMENT_INTAKE_ALLOWED_ORIGIN=https://netkem.no
```

Hvis DynamoDB ikke er satt opp, kan `DOCUMENT_INTAKE_ENABLED=1` brukes som enkel fallback, men den kan ikke endres via admin-endepunktet uten redeploy. For rask 1/0-styring bør DynamoDB brukes.

## DynamoDB

Lag én tabell:

- Table name: `NetkemDocumentIntake`
- Partition key: `pk` (String)
- Sort key: `sk` (String)

Lenkestatus lagres som `pk=LINK#offisielle-dokumenter`, `sk=STATE`. Opplastinger lagres under samme `pk` med `sk=UPLOAD#...`.

## S3 CORS

Legg dette på S3-bucketen, juster origin ved behov:

```json
[
  {
    "AllowedOrigins": ["https://netkem.no"],
    "AllowedMethods": ["POST"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3000
  }
]
```

## Slå lenken av og på

Åpne:

```bash
curl -X POST https://netkem.no/api/document-intake-admin \
  -H 'Content-Type: application/json' \
  -H 'x-admin-secret: <DOCUMENT_INTAKE_ADMIN_SECRET>' \
  -d '{"linkKey":"offisielle-dokumenter","enabled":1,"label":"Offisielle dokumenter"}'
```

Steng:

```bash
curl -X POST https://netkem.no/api/document-intake-admin \
  -H 'Content-Type: application/json' \
  -H 'x-admin-secret: <DOCUMENT_INTAKE_ADMIN_SECRET>' \
  -d '{"linkKey":"offisielle-dokumenter","enabled":0}'
```

Sjekk status:

```bash
curl https://netkem.no/api/document-intake-admin?link=offisielle-dokumenter \
  -H 'x-admin-secret: <DOCUMENT_INTAKE_ADMIN_SECRET>'
```

## AWS-tilgang

Kjør helst Vercel med en begrenset AWS-bruker eller rolle som bare kan:

- `s3:PutObject` og `s3:HeadObject` på `arn:aws:s3:::netkem-dokumentmottak/document-intake/*`
- `dynamodb:GetItem` og `dynamodb:PutItem` på `NetkemDocumentIntake`

Bucketen bør ha public access blokkert og server-side encryption aktivert.
